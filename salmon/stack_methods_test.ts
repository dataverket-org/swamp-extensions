import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { CliError, MAX_TIMEOUT_MS } from "../lib/cli.ts";
import { type Expected, HOSTILE } from "../lib/cli_fake.ts";
import { DOCKER_QUERY_TIMEOUT_MS } from "./common.ts";
import {
  composeProject,
  DOWN_TIMEOUT_MS,
  type GlobalArgs,
  GlobalArgsSchema,
  ids,
  isComposeProgress,
  keyEncryptionKey,
  model,
  seedFile,
} from "./stack.ts";
import {
  context,
  ends,
  json,
  jwt,
  NEVER,
  withDocker,
  withFetch,
  withFetchLimits,
} from "./test_support.ts";

const fixture = {
  project: "t",
  port: 18090,
  name: "orders",
  apps: [{ key: "db", name: "orders database" }],
  trust: { issuer: "https://kind:6443", subject: "system:serviceaccount:a:b" },
  grants: [{ app: "db" }],
};
const args = (over: Record<string, unknown> = {}): GlobalArgs =>
  GlobalArgsSchema.parse({ ...fixture, ...over });

const DISCOVERY =
  "http://127.0.0.1:18090/issuer/.well-known/openid-configuration";
const UP = ["compose", "-f", "-", "up", "-d", "--wait", "--remove-orphans"];
const LOGS = ["compose", "-p", "t", "logs", "--tail", "20", "salmon"];
const DOWN = ["compose", "-p", "t", "down", "--volumes", "--remove-orphans"];
const PS = [
  "ps",
  "-q",
  "--filter",
  "label=com.docker.compose.project=t",
  "--filter",
  "label=com.docker.compose.service=salmon",
];

async function up(
  g: GlobalArgs,
  revoked: string[] = [],
  answer: Partial<Expected> = {},
): Promise<Expected> {
  return {
    bin: "docker",
    args: UP,
    stdin: JSON.parse(
      await composeProject(g, seedFile(g, await ids(g), revoked)),
    ),
    timeoutMs: g.upTimeoutSeconds * 1000,
    ...answer,
  };
}
const ps = (out: string, answer: Partial<Expected> = {}): Expected => ({
  bin: "docker",
  args: PS,
  timeoutMs: DOCKER_QUERY_TIMEOUT_MS,
  out,
  ...answer,
});
const logs = (out: string, answer: Partial<Expected> = {}): Expected => ({
  bin: "docker",
  args: LOGS,
  timeoutMs: DOCKER_QUERY_TIMEOUT_MS,
  out,
  ...answer,
});

const answers = () => json({ issuer: "x" });
const down = () => {
  throw new TypeError("connection refused");
};

// A token as Salmon could log it, and one as compose could print it back.
const LOGGED = jwt({ sub: "trust/x", roles: ["users/Registry-Push"] });

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

Deno.test("ensure: one compose up with the project on input and its own time limit, then the record", async () => {
  const g = args();
  const ctx = context(g);
  await withDocker({ calls: [await up(g)] }, async (k) => {
    await withFetch(answers, async (seen) => {
      const res = await model.methods.ensure.execute({}, ctx);
      assertEquals(res.dataHandles, [{ name: "stack" }]);
      assertEquals(seen.map((r) => r.url), [DISCOVERY]);
    });
    assertEquals(k.calls[0].timeoutMs, 300_000);
    assertEquals(k.slept, []);
  });
  const id = await ids(g);
  assertEquals(ctx.writes.length, 1);
  const { checkedAt, ...data } = ctx.writes[0].data;
  assert(typeof checkedAt === "string");
  assertEquals([ctx.writes[0].spec, ctx.writes[0].name], ["stack", "stack"]);
  assertEquals(data, {
    project: "t",
    image: "registry.dataverket.org/tools/salmon:latest",
    issuerUrl: "http://localhost:8080/issuer/",
    port: 18090,
    localIssuerUrl: "http://127.0.0.1:18090/issuer/",
    running: true,
    apps: id.apps,
    trustId: id.trustId,
    grants: [{
      app: "db",
      appId: id.apps.db,
      role: "users/Registry-Push",
      revoked: false,
    }],
    error: "",
  });
});

Deno.test("ensure: upTimeoutSeconds is the time limit of compose up", async () => {
  const g = args({ upTimeoutSeconds: 45 });
  await withDocker({ calls: [await up(g)] }, async (k) => {
    await withFetch(
      answers,
      () => model.methods.ensure.execute({}, context(g)),
    );
    assertEquals(k.calls[0].timeoutMs, 45_000);
  });
});

Deno.test("ensure: waits a second at a time while the container runs and discovery does not answer", async () => {
  const g = args();
  const ctx = context(g);
  await withDocker(
    { calls: [await up(g), ps("abc123\n"), ps("abc123\n")] },
    async (k) => {
      await withFetch(
        (_req, n) => n < 3 ? json({}, 503) : json({ issuer: "x" }),
        () => model.methods.ensure.execute({}, ctx),
      );
      assertEquals(k.slept, [1000, 1000]);
    },
  );
  assertEquals(ctx.writes[0].data.running, true);
});

Deno.test("revoke: the seed on input has no grant at the app, and the record says revoked", async () => {
  const g = args();
  const ctx = context(g);
  await withDocker({ calls: [await up(g, ["db"])] }, async (k) => {
    await withFetch(
      answers,
      () => model.methods.revoke.execute({ app: "db" }, ctx),
    );
    const project = JSON.parse(k.calls[0].stdin!);
    assertEquals(JSON.parse(project.configs.seed.content).grants, []);
  });
  assertEquals(ctx.writes[0].data.running, true);
  assertEquals(
    (ctx.writes[0].data.grants as { revoked: boolean }[])[0].revoked,
    true,
  );
});

Deno.test("stop: compose down with its own time limit, then a record that says not running", async () => {
  const g = args();
  const ctx = context(g);
  await withDocker({
    calls: [{ bin: "docker", args: DOWN, timeoutMs: DOWN_TIMEOUT_MS }],
  }, () => model.methods.stop.execute({}, ctx));
  assertEquals(ctx.writes.length, 1);
  assertEquals(ctx.writes[0].data.running, false);
});

// ---------------------------------------------------------------------------
// Negative
// ---------------------------------------------------------------------------

/** The one record of a failed run: what docker showed afterwards, and why. */
function recorded(
  ctx: { writes: { data: Record<string, unknown> }[] },
  running: boolean,
  says: string,
) {
  assertEquals(ctx.writes.length, 1);
  const error = String(ctx.writes[0].data.error);
  assertEquals(ctx.writes[0].data.running, running);
  assertStringIncludes(error, says);
  assert(!error.includes("\n") && error.length <= 403, error);
}

Deno.test("ensure: a failed compose up is named with Salmon's log, and recorded as not running", async () => {
  const g = args();
  const ctx = context(g);
  await withDocker({
    calls: [
      await up(g, [], {
        fail:
          "Error response from daemon: unauthorized: authentication required\n",
        code: 1,
      }),
      logs("salmon-1  | seed: grant 0: unknown role\n"),
      ps(""),
    ],
  }, async () => {
    const err = await assertRejects(
      () => model.methods.ensure.execute({}, ctx),
      Error,
    );
    assertEquals(
      err.message,
      "docker compose up failed (exit 1): Error response from daemon: unauthorized: authentication required\n" +
        "salmon-1  | seed: grant 0: unknown role",
    );
  });
  recorded(ctx, false, "docker compose up failed (exit 1): Error response");
  assertStringIncludes(String(ctx.writes[0].data.error), "unknown role");
});

Deno.test("ensure: compose's progress lines do not push the reason out of the error", async () => {
  const g = args();
  const progress = [
    " Network t_default  Creating",
    " Network t_default  Created",
    " Container t-salmon-1  Creating",
  ];
  for (const line of progress) assert(isComposeProgress(line), line);
  for (
    const line of [
      "Error response from daemon: no such image: x: image not known",
      "service:salmon:1 Error response from daemon: no such image",
      "Container t-salmon-1 exited (1)",
      "",
    ]
  ) assert(!isComposeProgress(line), line);
  await withDocker({
    calls: [
      await up(g, [], {
        fail: (progress.join("\n") + "\n").repeat(20) +
          "Error response from daemon: no such image: x: image not known\n",
      }),
      logs(""),
      ps(""),
    ],
  }, async () => {
    const err = await assertRejects(
      () => model.methods.ensure.execute({}, context(g)),
      Error,
    );
    assertEquals(
      err.message,
      "docker compose up failed (exit 1): Error response from daemon: no such image: x: image not known\n(no log lines)",
    );
  });
});

Deno.test("ensure: the sealing key and a token never reach the error or the record, from compose or from Salmon's log", async () => {
  const g = args();
  const key = await keyEncryptionKey(g);
  const ctx = context(g);
  await withDocker({
    calls: [
      await up(g, [], {
        fail: `invalid project: SALMON_KEY_ENCRYPTION_KEY: ${key}\n` +
          `services.salmon.environment holds ${key}\n`,
      }),
      logs(
        `salmon-1  | exchange for Authorization: Bearer ${LOGGED}\n` +
          `salmon-1  | kek ${key} loaded, subject_token=${LOGGED}\n`,
      ),
      ps("abc\n"),
    ],
  }, async () => {
    const err = await assertRejects(
      () => model.methods.ensure.execute({}, ctx),
      Error,
    );
    assertStringIncludes(err.message, "docker compose up failed (exit 1)");
    assertStringIncludes(err.message, "salmon-1");
    assert(!err.message.includes(key), err.message);
    assert(!err.message.includes(LOGGED), err.message);
    assert(!err.message.includes(LOGGED.split(".")[2]), err.message);
  });
  assert(!ctx.everything().includes(key));
  assert(!ctx.everything().includes(LOGGED.split(".")[2]));
  recorded(ctx, true, "docker compose up failed (exit 1)");
});

Deno.test("ensure: a compose up that does not end is stopped at its limit and named, without asking for the log", async () => {
  const g = args({ upTimeoutSeconds: 90 });
  const ctx = context(g);
  await withDocker({
    calls: [await up(g, [], { hang: true }), ps("abc\n")],
  }, async (k) => {
    const err = await assertRejects(
      () => model.methods.ensure.execute({}, ctx),
      CliError,
    );
    assertEquals(err.kind, "timeout");
    assertEquals(
      err.message,
      "docker compose up failed: no answer within 90 seconds; the process was stopped (upTimeoutSeconds is 90; raise it when the image pull needs longer)",
    );
    assertEquals(k.calls.length, 2);
  });
  // What compose had started by then may still run, and the record says so.
  recorded(ctx, true, "upTimeoutSeconds is 90");
});

Deno.test("ensure: a cancelled run is said so, and nothing more is spawned", async () => {
  const g = args();
  const stop = new AbortController();
  const ctx = context(g, stop.signal);
  await withDocker(
    { calls: [await up(g, [], { hang: "until-cancelled" })] },
    async () => {
      const run = model.methods.ensure.execute({}, ctx);
      stop.abort();
      const err = await assertRejects(() => run, CliError);
      assertEquals(err.kind, "cancelled");
      assertEquals(err.message, "docker compose up was cancelled");
    },
  );
  assertEquals(ctx.writes, []);
});

Deno.test("ensure: no docker on PATH is said in one sentence", async () => {
  const g = args();
  const ctx = context(g);
  await withDocker(
    {
      calls: [
        await up(g, [], { notInstalled: true }),
        ps("", { notInstalled: true }),
      ],
    },
    async (k) => {
      const err = await assertRejects(
        () => model.methods.ensure.execute({}, ctx),
        CliError,
      );
      assertEquals(err.kind, "not-installed");
      assertStringIncludes(err.message, "docker is not on PATH");
      assertEquals(k.calls.length, 2);
    },
  );
  recorded(ctx, false, "docker is not on PATH");
});

Deno.test("ensure: a Salmon that exits (a refused seed) fails at once with its log, redacted", async () => {
  const g = args();
  const ctx = context(g);
  await withDocker({
    calls: [
      await up(g),
      ps(""),
      logs(`salmon-1  | seed: trust 0: bad issuer; token=${LOGGED}\n`),
      ps(""),
    ],
  }, async (k) => {
    const err = await withFetch(
      down,
      () => assertRejects(() => model.methods.ensure.execute({}, ctx), Error),
    );
    assertStringIncludes(err.message, `Salmon exited at ${DISCOVERY}:`);
    assertStringIncludes(err.message, "seed: trust 0: bad issuer");
    assert(!err.message.includes(LOGGED), err.message);
    assertEquals(k.slept, []);
  });
  recorded(ctx, false, "Salmon exited at");
  assert(!ctx.everything().includes(LOGGED));
});

Deno.test("ensure: a Salmon that never answers fails after startTimeoutSeconds, not later", async () => {
  const g = args({ startTimeoutSeconds: 3 });
  const ctx = context(g);
  await withDocker({
    calls: [
      await up(g),
      ps("abc\n"),
      ps("abc\n"),
      ps("abc\n"),
      ps("abc\n"),
      logs("salmon-1  | starting\n"),
      ps("abc\n"),
    ],
  }, async (k) => {
    const err = await withFetch(
      down,
      () => assertRejects(() => model.methods.ensure.execute({}, ctx), Error),
    );
    assertStringIncludes(
      err.message,
      `Salmon did not answer within 3s at ${DISCOVERY}:`,
    );
    assertEquals(k.slept, [1000, 1000, 1000]);
  });
  // The container is left running for whoever reads its log; stop removes it.
  recorded(ctx, true, "Salmon did not answer within 3s");
});

Deno.test("ensure: slow answers count against startTimeoutSeconds", async () => {
  const g = args({ startTimeoutSeconds: 10 });
  await withDocker({
    calls: [await up(g), ps("abc\n"), ps("abc\n"), logs(""), ps("abc\n")],
  }, async (k) => {
    const err = await withFetch(() => {
      k.advance(6000);
      throw new TypeError("timed out");
    }, () =>
      assertRejects(
        () => model.methods.ensure.execute({}, context(g)),
        Error,
      ));
    assertStringIncludes(err.message, "did not answer within 10s");
    assertStringIncludes(err.message, "(no log lines)");
  });
});

Deno.test("ensure: a log that cannot be read does not hide the failure it would have explained", async () => {
  const g = args();
  for (
    const answer of [{ hang: true }, { notInstalled: true }] as Partial<
      Expected
    >[]
  ) {
    await withDocker(
      {
        calls: [await up(g, [], { fail: "boom" }), logs("", answer), ps("")],
      },
      async () => {
        const err = await assertRejects(
          () => model.methods.ensure.execute({}, context(g)),
          Error,
        );
        assertStringIncludes(err.message, "docker compose up failed (exit 1)");
      },
    );
  }
});

Deno.test("ensure: a docker ps that fails while waiting is a named failure", async () => {
  const g = args();
  const ctx = context(g);
  await withDocker({
    calls: [
      await up(g),
      ps("", { fail: "Cannot connect to the Docker daemon", code: 125 }),
      ps("", { fail: "Cannot connect to the Docker daemon", code: 125 }),
    ],
  }, async () => {
    const err = await withFetch(
      down,
      () =>
        assertRejects(() => model.methods.ensure.execute({}, ctx), CliError),
    );
    assertEquals(
      err.message,
      "docker ps failed (exit 125): Cannot connect to the Docker daemon",
    );
  });
  // docker could not say whether it runs: recorded as not running, with why.
  recorded(ctx, false, "docker ps failed (exit 125)");
});

Deno.test("revoke: an app the fixture grants nothing at is refused before docker runs", async () => {
  const ctx = context(args());
  await withDocker({}, async (k) => {
    for (const app of ["other", "", "--all", "db; id"]) {
      await assertRejects(
        () => model.methods.revoke.execute({ app }, ctx),
        Error,
        "the fixture grants nothing at app",
      );
    }
    assertEquals(k.calls, []);
  });
  assertEquals(ctx.writes, []);
});

Deno.test("stop: a failed or endless compose down is named, and the record says what docker still shows", async () => {
  const ctx = context(args());
  await withDocker({
    calls: [
      { bin: "docker", args: DOWN, fail: "no such project", code: 1 },
      ps(""),
      { bin: "docker", args: DOWN, hang: true },
      ps("abc\n"),
    ],
  }, async () => {
    const failed = await assertRejects(
      () => model.methods.stop.execute({}, ctx),
      CliError,
    );
    assertEquals(
      failed.message,
      "docker compose down failed (exit 1): no such project",
    );
    const hung = await assertRejects(
      () => model.methods.stop.execute({}, ctx),
      CliError,
    );
    assertEquals(hung.kind, "timeout");
    assertStringIncludes(hung.message, "no answer within 120 seconds");
  });
  assertEquals(
    ctx.writes.map((w) => [w.data.running, w.data.error]),
    [
      [false, "docker compose down failed (exit 1): no such project"],
      [
        true,
        "docker compose down failed: no answer within 120 seconds; the process was stopped",
      ],
    ],
  );
});

Deno.test("a project name shaped like a flag, a path or shell text never parses", () => {
  for (const project of [...HOSTILE, "-p", "--project-directory=/", "A"]) {
    if (/^[a-z0-9][a-z0-9_-]*$/.test(project)) continue;
    assert(
      !GlobalArgsSchema.safeParse({ ...fixture, project }).success,
      JSON.stringify(project),
    );
  }
  for (const over of [{ upTimeoutSeconds: 0 }, { startTimeoutSeconds: -1 }]) {
    assert(!GlobalArgsSchema.safeParse({ ...fixture, ...over }).success);
  }
});

Deno.test("the fake docker is strict: an unknown command, a flag or stray input is refused", async () => {
  const { runCli } = await import("../lib/cli.ts");
  await withDocker({}, async () => {
    for (
      const [a, stdin] of [
        [["compose", "-p", "t", "down", "--volumes", "--rmi", "all"]],
        [["compose", "-p", "--all", "down", "--volumes", "--remove-orphans"]],
        [["rm", "-f", "x"]],
        [PS, "{}"],
        [UP],
      ] as [string[], string?][]
    ) {
      await assertRejects(
        () => runCli("docker", a, { stdin }),
        Error,
        "fake docker:",
      );
    }
  });
});

Deno.test("the pre-flight check runs docker compose version, and says what is missing", async () => {
  const check = model.checks["docker-compose-available"];
  const version: Expected = {
    bin: "docker",
    args: ["compose", "version"],
    timeoutMs: 20_000,
  };
  await withDocker({
    calls: [
      { ...version, out: "Docker Compose version v5.5.1\n" },
      { ...version, notInstalled: true },
      { ...version, fail: "docker: 'compose' is not a docker command.\n" },
      { ...version, hang: true },
    ],
  }, async () => {
    assertEquals(await check.execute(), { pass: true });
    const missing = await check.execute();
    assertEquals(missing.pass, false);
    assertStringIncludes(missing.errors![0], "docker was not found; install");
    const noPlugin = await check.execute();
    assertStringIncludes(noPlugin.errors![0], "is not a docker command");
    const hung = await check.execute();
    assertStringIncludes(hung.errors![0], "no answer within 20 seconds");
  });
});

Deno.test("ensure: a Salmon that accepts the connection and never answers cannot hold the wait", async () => {
  const g = args({ startTimeoutSeconds: 2 });
  const ctx = context(g);
  await withDocker({
    calls: [
      await up(g),
      ps("abc\n"),
      ps("abc\n"),
      ps("abc\n"),
      logs(""),
      ps("abc\n"),
    ],
  }, async () => {
    const err = await withFetchLimits(
      20,
      () =>
        withFetch(() => NEVER, (seen) =>
          ends(
            assertRejects(() => model.methods.ensure.execute({}, ctx), Error),
          ).finally(() => assertEquals(seen.length, 3))),
    );
    assertStringIncludes(err.message, "Salmon did not answer within 2s");
  });
  recorded(ctx, true, "did not answer within 2s");
});

Deno.test("a failed revoke records what was asked for, and why it is not known to hold", async () => {
  const g = args();
  const ctx = context(g);
  await withDocker({
    calls: [await up(g, ["db"], { fail: "boom" }), logs(""), ps("abc\n")],
  }, () =>
    assertRejects(
      () => model.methods.revoke.execute({ app: "db" }, ctx),
      Error,
    ));
  recorded(ctx, true, "docker compose up failed (exit 1): boom");
});

Deno.test("an issuer URL with a user or password is refused by the schema, and again by every method", async () => {
  const planted = "http://admin:hunter2secret@localhost:8080/issuer/";
  const parsed = GlobalArgsSchema.safeParse({ ...fixture, issuerUrl: planted });
  assert(!parsed.success);
  assertStringIncludes(
    JSON.stringify(parsed.error.issues),
    "must not hold a user or password",
  );
  assert(!JSON.stringify(parsed.error.issues).includes("hunter2secret"));
  assert(
    !GlobalArgsSchema.safeParse({
      ...fixture,
      issuerUrl: "http://admin@localhost:8080/issuer/",
    }).success,
  );
  // A definition that reached a method without the schema: nothing is
  // spawned, logged or written, and the error does not repeat the password.
  const g = { ...args(), issuerUrl: planted };
  const ctx = context(g);
  await withDocker({}, async (k) => {
    await withFetch(answers, async (seen) => {
      for (
        const run of [
          () => model.methods.ensure.execute({}, ctx),
          () => model.methods.revoke.execute({ app: "db" }, ctx),
          () => model.methods.stop.execute({}, ctx),
        ]
      ) {
        const err = await assertRejects(run, Error, "must not hold a user");
        assert(!err.message.includes("hunter2secret"));
      }
      assertEquals(seen, []);
    });
    assertEquals(k.calls, []);
  });
  assert(!ctx.everything().includes("hunter2secret"));
  assertEquals([ctx.writes, ctx.logs], [[], []]);
});

Deno.test("a wait is at most an hour, and every limit handed to the process layer is one it accepts", async () => {
  for (const key of ["upTimeoutSeconds", "startTimeoutSeconds"]) {
    assert(GlobalArgsSchema.safeParse({ ...fixture, [key]: 3600 }).success);
    for (const value of [3601, 2_147_484, 1e12, 1.5]) {
      assert(
        !GlobalArgsSchema.safeParse({ ...fixture, [key]: value }).success,
        `${key}=${value}`,
      );
    }
  }
  const g = args({ upTimeoutSeconds: 3600 });
  await withDocker({ calls: [await up(g)] }, async (k) => {
    await withFetch(
      answers,
      () => model.methods.ensure.execute({}, context(g)),
    );
    assertEquals(k.calls[0].timeoutMs, 3_600_000);
    assert(k.calls[0].timeoutMs < MAX_TIMEOUT_MS);
  });
});

Deno.test("every method that changes something says so", () => {
  for (const method of Object.values(model.methods)) {
    assertEquals(method.kind, "action");
  }
});

Deno.test("the recorded reason of a failure is one line of at most 400 characters", async () => {
  const g = args();
  const ctx = context(g);
  await withDocker({
    calls: [
      await up(g, [], { fail: "boom" }),
      logs("salmon-1  | a long line of Salmon's log\n".repeat(20)),
      ps(""),
    ],
  }, async () => {
    const err = await assertRejects(
      () => model.methods.ensure.execute({}, ctx),
      Error,
    );
    assert(err.message.length > 600 && err.message.includes("\n"));
  });
  const error = String(ctx.writes[0].data.error);
  assertEquals(error.length, 403);
  assert(error.endsWith("...") && !error.includes("\n"));
});
