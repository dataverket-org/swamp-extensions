import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import type { Spawn } from "../lib/cli.ts";
import {
  type Answer,
  fakeCli,
  type FakeTime,
  HOSTILE,
  knownFlags,
  type SpawnedCall,
  withCli,
  withFake,
} from "../lib/cli_fake.ts";
import {
  fakeKubectl,
  type KubectlCall,
  type TextCommand,
} from "../lib/kubectl_fake.ts";
import {
  APPLY_TIMEOUT_SECONDS,
  type Context,
  CREATE_MARGIN_MS,
  DELETE_TIMEOUT_MS,
  durationMs,
  GlobalArgsSchema,
  isKindProgress,
  MAX_WAIT_MS,
  model,
  nodeProviderCommand,
  shellQuote,
} from "./cluster.ts";

const SERVER = "https://127.0.0.1:51271";
const JSONPATH = "jsonpath={.clusters[0].cluster.server}";
const REFUSED =
  "The connection to the server 127.0.0.1:51271 was refused - did you specify the right host or port?";

/** What the fake machine holds and how its tools answer. */
type World = {
  /** What `kind get clusters` lists. */
  clusters: string[];
  /**
   * Answers by the start of a command line, tried before the defaults: for
   * kubectl the command without cluster flags (`get --raw /readyz`), for
   * every other binary the whole line (`kind create cluster`).
   */
  answers?: Record<string, Answer>;
  /** `-v` output of the container tools that are installed. */
  runtimes?: Record<string, string>;
  /** The kubectl binary is not there. */
  noKubectl?: boolean;
  /** Answers of the readiness read, one per call, before the default. */
  readyz?: Answer[];
  /** Binaries whose spawn throws this, as an unrunnable file does. */
  spawnThrows?: Record<string, Error>;
};

/** The kubectl commands this type runs through `runKubectlText`. */
const TEXT_COMMANDS: TextCommand[] = [
  { words: ["apply"], valueFlags: ["-f"], required: ["-f"] },
  { words: ["config", "view"], flags: ["--minify"], valueFlags: ["-o"] },
  { words: ["get"], valueFlags: ["--raw"], required: ["--raw"] },
];

/** The flags kind 0.33.0 knows, of those this type may use. */
const KIND_FLAGS = knownFlags(["--name", "--config", "--wait", "--kubeconfig"]);

function scripted(
  answers: Record<string, Answer> | undefined,
  line: string,
): Answer | undefined {
  for (const [start, a] of Object.entries(answers ?? {})) {
    if (line.startsWith(start)) return a;
  }
  return undefined;
}

/** A fake kind and fake container tools; anything else is refused. */
function tools(world: World, kindBin: string) {
  return (call: SpawnedCall): Answer | undefined => {
    const line = `${call.bin} ${call.args.join(" ")}`;
    const said = scripted(world.answers, line);
    if (said !== undefined) return said;
    if (["docker", "nerdctl", "podman"].includes(call.bin)) {
      if (line !== `${call.bin} -v`) return undefined;
      const out = world.runtimes?.[call.bin];
      return out === undefined ? { notInstalled: true } : { out };
    }
    if (call.bin !== kindBin) return undefined;
    const words = call.args.join(" ");
    if (words === "version") return { out: "kind v0.33.0 go1.26.0\n" };
    if (words === "get clusters") {
      return { out: world.clusters.map((c) => `${c}\n`).join("") };
    }
    if (words.startsWith("create cluster --name ")) {
      world.clusters.push(call.args[3]);
      return {};
    }
    if (words.startsWith("export kubeconfig --name ")) return {};
    if (words.startsWith("delete cluster --name ")) {
      world.clusters = world.clusters.filter((c) => c !== call.args[3]);
      return {};
    }
    return undefined;
  };
}

/** The fake cluster behind kubectl. */
function cluster(world: World) {
  return (call: KubectlCall): Answer | undefined => {
    if (world.noKubectl) return { notInstalled: true };
    const line = call.command.join(" ");
    const said = scripted(world.answers, line);
    if (said !== undefined) return said;
    if (line === "get --raw /readyz" && world.readyz?.length) {
      return world.readyz.shift();
    }
    if (line === "get --raw /readyz") return { out: "ok" };
    if (line === `config view --minify -o ${JSONPATH}`) return { out: SERVER };
    if (call.verb === "apply") return { out: "created\n" };
    return undefined;
  };
}

function context(over: Record<string, unknown> = {}, signal?: AbortSignal) {
  const written: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const ctx: Context = {
    globalArgs: {
      ...GlobalArgsSchema.parse({
        clusterName: "t",
        configPath: "kind.yaml",
        manifests: ["a.yaml"],
      }),
      ...over,
    } as Context["globalArgs"],
    repoDir: "/repo",
    signal,
    logger: {
      info: (msg, props) => logs.push(`${msg} ${JSON.stringify(props ?? {})}`),
    },
    writeResource: (_spec, name, data) => {
      written.push(data);
      return Promise.resolve({ name });
    },
  };
  return { ctx, written, logs };
}

/** What a test of a world holds on to. */
type Machine = {
  spawn: Spawn;
  done: () => void;
  /** Every call that was answered, as spawned. */
  calls: SpawnedCall[];
  /**
   * Every call in order: kind and the container tools as spawned, kubectl
   * as its command. The kubectl fake has checked the cluster flags, the
   * request timeout and the time limit of each.
   */
  lines: string[];
};

/**
 * The machine of `ctx`: lib's kubectl fake for its kubectl binary, bound to
 * its kubeconfig and the context `kind-t`, and lib's process fake for kind
 * and the container tools.
 */
function inWorld<T>(
  world: World,
  ctx: Context,
  body: (k: Machine & FakeTime) => Promise<T>,
): Promise<T> {
  const g = ctx.globalArgs;
  const kubectl = fakeKubectl({
    bin: g.kubectlBinary,
    kubeconfig: g.kubeconfig,
    context: "kind-t",
    textCommands: TEXT_COMMANDS,
    // The handler may answer a call with the limit of an apply; the fake
    // still checks the flag against the time the process is stopped at.
    requestTimeouts: [APPLY_TIMEOUT_SECONDS],
    handler: cluster(world),
  });
  const other = fakeCli({
    grammar: { [g.kindBinary]: KIND_FLAGS },
    handler: tools(world, g.kindBinary),
  });
  const calls: SpawnedCall[] = [];
  const lines: string[] = [];
  const spawn: Spawn = (bin, args, opts) => {
    if (world.spawnThrows?.[bin]) {
      lines.push(`${bin} ${args.join(" ")}`);
      return Promise.reject(world.spawnThrows[bin]);
    }
    const own = bin === g.kubectlBinary;
    const parsed = kubectl.kubectl.length;
    const answer = (own ? kubectl : other).spawn(bin, args, opts);
    calls.push({ bin, args, ...opts });
    // A version check is not a cluster call and is kept as spawned.
    lines.push(
      kubectl.kubectl.length > parsed
        ? `kubectl ${kubectl.kubectl.at(-1)!.command.join(" ")}`
        : `${bin} ${args.join(" ")}`,
    );
    return answer;
  };
  return withFake({ spawn, done: () => {}, calls, lines }, body);
}

function lines(k: Machine): string[] {
  return k.lines;
}

/** Run `body` with KIND_EXPERIMENTAL_PROVIDER set to `value`, or unset. */
async function withProvider<T>(
  value: string | undefined,
  body: () => Promise<T>,
): Promise<T> {
  const key = "KIND_EXPERIMENTAL_PROVIDER";
  const before = Deno.env.get(key);
  if (value === undefined) Deno.env.delete(key);
  else Deno.env.set(key, value);
  try {
    return await body();
  } finally {
    if (before === undefined) Deno.env.delete(key);
    else Deno.env.set(key, before);
  }
}

const K = "kubectl";

// ---------------------------------------------------------------------------
// The published cases
// ---------------------------------------------------------------------------

Deno.test("ensure creates a missing cluster and applies the manifests", async () => {
  const { ctx, written } = context();
  await inWorld({ clusters: [] }, ctx, async (k) => {
    await model.methods.ensure.execute({}, ctx);
    assertEquals(lines(k), [
      "kind get clusters",
      "kind create cluster --name t --config kind.yaml --wait 120s",
      `${K} get --raw /readyz`,
      `${K} apply -f a.yaml`,
      `${K} config view --minify -o ${JSONPATH}`,
    ]);
    assertEquals(k.calls[1].timeoutMs, 120_000 + CREATE_MARGIN_MS);
    // Only the apply gets the long limit; the reads keep the default.
    assertEquals(APPLY_TIMEOUT_SECONDS, 300);
    assertEquals(
      k.calls.slice(2).map((c) => [
        c.args.find((a) => a.startsWith("--request-timeout")),
        c.timeoutMs,
      ]),
      [
        ["--request-timeout=30s", 35_000],
        ["--request-timeout=300s", 305_000],
        ["--request-timeout=30s", 35_000],
      ],
    );
    for (const c of k.calls) {
      // Run in the repository root, and with the environment as it is: the
      // provider choice in KIND_EXPERIMENTAL_PROVIDER reaches kind untouched.
      assertEquals(c.cwd, "/repo");
      assertEquals(c.env, undefined);
      assertEquals(c.clearEnv, undefined);
      assertEquals(c.stdin, undefined);
    }
  });
  assertEquals(written.length, 1);
  assertEquals(written[0].name, "t");
  assertEquals(written[0].exists, true);
  assertEquals(written[0].created, true);
  assertEquals(written[0].context, "kind-t");
  assertEquals(written[0].apiServer, SERVER);
  assertEquals(written[0].manifestsApplied, ["a.yaml"]);
  assertEquals("kubeconfig" in written[0], false);
});

Deno.test("ensure leaves an existing cluster and still applies the manifests", async () => {
  const { ctx, written } = context();
  await inWorld({ clusters: ["other", "t"] }, ctx, async (k) => {
    await model.methods.ensure.execute({}, ctx);
    assertEquals(lines(k), [
      "kind get clusters",
      `${K} get --raw /readyz`,
      `${K} apply -f a.yaml`,
      `${K} config view --minify -o ${JSONPATH}`,
    ]);
  });
  assertEquals(written[0].created, false);
  assertEquals(written[0].exists, true);
});

Deno.test("ensure fails before writing when the API server is unreachable", async () => {
  const { ctx, written } = context();
  await withProvider(undefined, () =>
    inWorld(
      {
        clusters: ["t"],
        answers: { "get --raw /readyz": { fail: REFUSED } },
        runtimes: { docker: "Docker version 28.5.1, build e180ab8\n" },
      },
      ctx,
      async (k) => {
        const err = await assertRejects(() =>
          model.methods.ensure.execute({}, ctx)
        );
        assertStringIncludes(String(err), "docker start t-control-plane");
        assertStringIncludes(String(err), "was refused");
        assertEquals(lines(k).some((l) => l.includes("apply")), false);
      },
    ));
  assertEquals(written.length, 0);
});

Deno.test("get records a missing cluster without creating it", async () => {
  const { ctx, written } = context();
  await inWorld({ clusters: [] }, ctx, async (k) => {
    await model.methods.get.execute({}, ctx);
    assertEquals(lines(k), ["kind get clusters"]);
  });
  assertEquals(written[0].exists, false);
  assertEquals(written[0].apiServer, "");
});

Deno.test("delete succeeds when the cluster is already gone", async () => {
  const { ctx, written } = context();
  const world: World = { clusters: ["other"] };
  await inWorld(world, ctx, async (k) => {
    await model.methods.delete.execute({}, ctx);
    // Without the kubeconfig argument nothing more is run: kind delete
    // would take the entry of a cluster this provider does not list out of
    // the default kubeconfig, which is not this type's file.
    assertEquals(lines(k), ["kind get clusters"]);
  });
  assertEquals(world.clusters, ["other"]);
  assertEquals(written[0].exists, false);
});

Deno.test("with the kubeconfig argument, delete of a cluster that is gone still runs kind delete, to clean its own file", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/kc`;
    const { ctx, written } = context({ kubeconfig: file });
    await inWorld({ clusters: ["other"] }, ctx, async (k) => {
      await model.methods.delete.execute({}, ctx);
      assertEquals(lines(k), [
        "kind get clusters",
        `kind delete cluster --name t --kubeconfig ${file}`,
      ]);
    });
    assertEquals(written[0].exists, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("delete with a kubeconfig in a directory that does not exist is refused before any kind call", async () => {
  const dir = await Deno.makeTempDir();
  try {
    for (const clusters of [[], ["t"]]) {
      const { ctx, written } = context({
        kubeconfig: `${dir}/missing/kubeconfig`,
      });
      await inWorld({ clusters: [...clusters] }, ctx, async (k) => {
        const err = await assertRejects(() =>
          model.methods.delete.execute({}, ctx)
        );
        assertStringIncludes(
          String(err),
          `its directory ${dir}/missing does not exist`,
        );
        assertEquals(lines(k), []);
      });
      assertEquals(written.length, 0);
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a failing command reports its argv and stderr", async () => {
  const { ctx, written } = context();
  await inWorld(
    {
      clusters: [],
      answers: { "kind get clusters": { fail: "docker is not running" } },
    },
    ctx,
    async () => {
      const err = await assertRejects(() => model.methods.get.execute({}, ctx));
      assertStringIncludes(
        String(err),
        "kind get clusters failed (exit 1): docker is not running",
      );
    },
  );
  assertEquals(written.length, 0);
});

// ---------------------------------------------------------------------------
// More of the happy path
// ---------------------------------------------------------------------------

Deno.test("get records an existing cluster and changes nothing", async () => {
  const { ctx, written } = context();
  await inWorld({ clusters: ["t"] }, ctx, async (k) => {
    await model.methods.get.execute({}, ctx);
    assertEquals(lines(k), [
      "kind get clusters",
      `${K} config view --minify -o ${JSONPATH}`,
    ]);
  });
  assertEquals(written[0].exists, true);
  assertEquals(written[0].created, false);
  assertEquals(written[0].apiServer, SERVER);
  assertEquals(written[0].manifestsApplied, []);
});

Deno.test("delete removes an existing cluster, with its own time limit", async () => {
  const { ctx, written } = context();
  await inWorld({ clusters: ["other", "t"] }, ctx, async (k) => {
    await model.methods.delete.execute({}, ctx);
    assertEquals(lines(k), [
      "kind get clusters",
      "kind delete cluster --name t",
    ]);
    assertEquals(k.calls[1].timeoutMs, DELETE_TIMEOUT_MS);
  });
  assertEquals(written[0].exists, false);
  assertEquals(written[0].apiServer, "");
});

Deno.test("kubeconfig reaches kind create, every kubectl call and kind delete", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/kubeconfig`;
    const KC = "kubectl";
    const { ctx, written } = context({ kubeconfig: file, waitTimeout: "30s" });
    await inWorld({ clusters: [] }, ctx, async (k) => {
      await model.methods.ensure.execute({}, ctx);
      await model.methods.get.execute({}, ctx);
      await model.methods.delete.execute({}, ctx);
      assertEquals(lines(k), [
        "kind get clusters",
        `kind create cluster --name t --config kind.yaml --wait 30s --kubeconfig ${file}`,
        `${KC} get --raw /readyz`,
        `${KC} apply -f a.yaml`,
        `${KC} config view --minify -o ${JSONPATH}`,
        "kind get clusters",
        `${KC} config view --minify -o ${JSONPATH}`,
        "kind get clusters",
        `kind delete cluster --name t --kubeconfig ${file}`,
      ]);
      // The time limit follows waitTimeout.
      assertEquals(k.calls[1].timeoutMs, 30_000 + CREATE_MARGIN_MS);
    });
    assertEquals(written.map((w) => w.kubeconfig), [file, file, file]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a relative kubeconfig is recorded under the repository root", async () => {
  const { ctx, written } = context({ kubeconfig: "tmp/kubeconfig" });
  await inWorld({ clusters: ["t"] }, ctx, async (k) => {
    await model.methods.get.execute({}, ctx);
    // The fake is bound to --kubeconfig tmp/kubeconfig, as given.
    assertEquals(lines(k)[1], `kubectl config view --minify -o ${JSONPATH}`);
  });
  assertEquals(written[0].kubeconfig, "/repo/tmp/kubeconfig");
});

Deno.test("the binaries named in kindBinary and kubectlBinary are the ones run", async () => {
  const { ctx, written } = context({
    kindBinary: "/opt/kind",
    kubectlBinary: "/opt/kubectl",
    manifests: [],
  });
  await inWorld({ clusters: [] }, ctx, async (k) => {
    await model.methods.ensure.execute({}, ctx);
    assertEquals(k.calls.map((c) => c.bin), [
      "/opt/kind",
      "/opt/kind",
      "/opt/kubectl",
      "/opt/kubectl",
    ]);
  });
  assertEquals(written[0].created, true);
});

Deno.test("each pre-flight check names exactly the methods that run its binary", () => {
  // swamp runs no check before a read, so get is in neither list; delete
  // never runs kubectl and must not be stopped by a machine without it.
  assertEquals(Object.keys(model.checks).sort(), [
    "kind-cli-available",
    "kubectl-cli-available",
  ]);
  assertEquals(model.checks["kind-cli-available"].appliesTo, [
    "ensure",
    "delete",
  ]);
  assertEquals(model.checks["kubectl-cli-available"].appliesTo, ["ensure"]);
  for (const applies of Object.values(model.checks).map((c) => c.appliesTo)) {
    for (const method of applies) assert(method in model.methods, method);
  }
});

Deno.test("the pre-flight checks run the binaries of the definition, from the repository root", async () => {
  const { ctx } = context({
    kindBinary: "./bin/kind",
    kubectlBinary: "tools/kubectl",
  });
  await withCli({
    calls: [
      {
        bin: "./bin/kind",
        args: ["version"],
        cwd: "/repo",
        out: "kind v0.33.0",
      },
      {
        bin: "tools/kubectl",
        args: ["version", "--client"],
        cwd: "/repo",
        out: "Client Version: v1.37.2",
      },
    ],
  }, async () => {
    for (const check of Object.values(model.checks)) {
      assertEquals(await check.execute(ctx), { pass: true });
    }
  });
  // The methods run them from the same directory.
  await inWorld({ clusters: [] }, ctx, async (k) => {
    await model.methods.ensure.execute({}, ctx);
    assertEquals([...new Set(k.calls.map((c) => c.cwd))], ["/repo"]);
    assertEquals([...new Set(k.calls.map((c) => c.bin))], [
      "./bin/kind",
      "tools/kubectl",
    ]);
  });
});

Deno.test("a pre-flight check says which binary is missing and how to name another", async () => {
  const { ctx } = context({ kindBinary: "no-such-kind" });
  await withCli({
    calls: [
      { bin: "no-such-kind", args: ["version"], notInstalled: true },
      { bin: "kubectl", args: ["version", "--client"], notInstalled: true },
    ],
  }, async () => {
    const kind = await model.checks["kind-cli-available"].execute(ctx);
    assertEquals(kind.pass, false);
    assertStringIncludes(kind.errors![0], "no-such-kind was not found");
    assertStringIncludes(kind.errors![0], "kindBinary");
    const kubectl = await model.checks["kubectl-cli-available"].execute(ctx);
    assertEquals(kubectl.pass, false);
    assertStringIncludes(kubectl.errors![0], "kubectl is not on PATH");
  });
});

Deno.test("durationMs reads what kind takes for --wait", () => {
  assertEquals(durationMs("120s"), 120_000);
  assertEquals(durationMs("2m"), 120_000);
  assertEquals(durationMs("1m30s"), 90_000);
  assertEquals(durationMs("1.5m"), 90_000);
  assertEquals(durationMs("500ms"), 500);
  assertEquals(durationMs("1h"), 3_600_000);
  assertEquals(durationMs("0"), 0);
  assertEquals(durationMs("0s"), 0);
});

Deno.test("isKindProgress drops progress and keeps the error", () => {
  for (
    const noise of [
      "using podman due to KIND_EXPERIMENTAL_PROVIDER",
      "enabling experimental podman provider",
      'Creating cluster "t" ...',
      'Deleting cluster "t" ...',
      " • Ensuring node image (kindest/node:v1.37.0) 🖼️  ...",
      " ✓ Preparing nodes 📦 ",
    ]
  ) assert(isKindProgress(noise), noise);
  for (
    const kept of [
      " ✗ Starting control-plane 🕹️",
      "ERROR: failed to create cluster: error reading file",
      "Command Output: I1110 10:00:00.000000",
    ]
  ) assert(!isKindProgress(kept), kept);
});

// ---------------------------------------------------------------------------
// The provider in the hint for a stopped node container
// ---------------------------------------------------------------------------

const stopped = (runtimes: Record<string, string> = {}): World => ({
  clusters: ["t"],
  answers: { "get --raw /readyz": { fail: REFUSED } },
  runtimes,
});

Deno.test("with KIND_EXPERIMENTAL_PROVIDER=podman the hint says podman and nothing is probed", async () => {
  const { ctx, written } = context();
  await withProvider("podman", () =>
    inWorld(stopped(), ctx, async (k) => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      assertStringIncludes(String(err), "try 'podman start t-control-plane'");
      assertEquals(String(err).includes("docker"), false);
      assertEquals(lines(k), ["kind get clusters", `${K} get --raw /readyz`]);
    }));
  assertEquals(written.length, 0);
});

Deno.test("every provider value kind knows is taken from the environment", async () => {
  const { ctx } = context();
  for (const p of ["docker", "podman", "nerdctl", "finch", "nerdctl.lima"]) {
    await withProvider(p, () =>
      inWorld({ clusters: [] }, ctx, async (k) => {
        assertEquals(await nodeProviderCommand(ctx), p);
        assertEquals(k.calls.length, 0);
      }));
  }
});

Deno.test("without the variable, Podman's docker shim is not taken for Docker", async () => {
  const { ctx } = context();
  await withProvider(undefined, () =>
    inWorld(
      stopped({
        docker: "podman version 4.9.3\n",
        podman: "podman version 4.9.3\n",
      }),
      ctx,
      async (k) => {
        const err = await assertRejects(() =>
          model.methods.ensure.execute({}, ctx)
        );
        assertStringIncludes(String(err), "try 'podman start t-control-plane'");
        assertEquals(lines(k).slice(2), [
          "docker -v",
          "nerdctl -v",
          "podman -v",
        ]);
      },
    ));
});

Deno.test("without the variable, the order is docker, nerdctl, podman", async () => {
  const { ctx } = context();
  await withProvider(undefined, async () => {
    await inWorld(
      {
        clusters: [],
        runtimes: {
          docker: "Docker version 28.5.1\n",
          nerdctl: "nerdctl version 2.1.6\n",
          podman: "podman version 4.9.3\n",
        },
      },
      ctx,
      async () => assertEquals(await nodeProviderCommand(ctx), "docker"),
    );
    await inWorld(
      {
        clusters: [],
        runtimes: {
          nerdctl: "nerdctl version 2.1.6\n",
          podman: "podman version 4.9.3\n",
        },
      },
      ctx,
      async () => assertEquals(await nodeProviderCommand(ctx), "nerdctl"),
    );
  });
});

Deno.test("a provider value kind does not know is ignored, as kind does", async () => {
  const { ctx } = context();
  await withProvider(
    "containerd; rm -rf /",
    () =>
      inWorld(stopped({ podman: "podman version 4.9.3\n" }), ctx, async () => {
        const err = await assertRejects(() =>
          model.methods.ensure.execute({}, ctx)
        );
        assertStringIncludes(String(err), "try 'podman start t-control-plane'");
        assertEquals(String(err).includes("rm -rf"), false);
      }),
  );
});

Deno.test("with no container tool found the hint names none", async () => {
  const { ctx } = context();
  await withProvider(undefined, () =>
    inWorld(stopped(), ctx, async () => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      assertStringIncludes(
        String(err),
        "is the t-control-plane container stopped? start it with the container runtime kind uses",
      );
      assertEquals(String(err).includes(" start t-control-plane'"), false);
    }));
});

Deno.test("a failing probe of a container tool is not an answer", async () => {
  const { ctx } = context();
  await withProvider(undefined, () =>
    inWorld(
      {
        clusters: [],
        answers: { "docker -v": { fail: "Cannot connect", code: 1 } },
        runtimes: { podman: "podman version 4.9.3\n" },
      },
      ctx,
      async () => assertEquals(await nodeProviderCommand(ctx), "podman"),
    ));
});

// ---------------------------------------------------------------------------
// Refused before anything is spawned
// ---------------------------------------------------------------------------

Deno.test("a cluster name that is not a name is refused by every method, with no spawn", async () => {
  for (const name of [...HOSTILE, "--name=x", "t --retain", "kind,other"]) {
    for (const method of ["ensure", "get", "delete"] as const) {
      const { ctx, written } = context({ clusterName: name });
      await withCli({}, async (k) => {
        const err = await assertRejects(() =>
          model.methods[method].execute({}, ctx)
        );
        assertStringIncludes(String(err), "clusterName");
        assertStringIncludes(String(err), "is not a Kubernetes object name");
        assertEquals(k.calls.length, 0);
      });
      assertEquals(written.length, 0);
    }
  }
});

Deno.test("a path that is empty, a flag or holds a line break is refused, with no spawn", async () => {
  const bad = ["", "-x", "--kubeconfig=/etc/passwd", "--retain", "a\nb", "\0"];
  for (const value of bad) {
    for (
      const over of [
        { configPath: value },
        { kubeconfig: value },
        { manifests: ["ok.yaml", value] },
      ]
    ) {
      const { ctx, written } = context(over);
      await withCli({}, async (k) => {
        const err = await assertRejects(() =>
          model.methods.ensure.execute({}, ctx)
        );
        assertStringIncludes(String(err), "is refused");
        assertStringIncludes(String(err), Object.keys(over)[0].slice(0, 8));
        assertEquals(k.calls.length, 0);
      });
      assertEquals(written.length, 0);
    }
  }
});

Deno.test("a waitTimeout that is not a duration is refused, with no spawn", async () => {
  for (
    const value of [
      "",
      "120",
      "2 m",
      "-5s",
      "+5s",
      ".5s",
      "5\u03bcs",
      "1d",
      "90s --retain",
      "s",
      "1e3s",
    ]
  ) {
    const { ctx, written } = context({ waitTimeout: value });
    await withCli({}, async (k) => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      assertStringIncludes(String(err), "is not a duration");
      assertEquals(k.calls.length, 0);
    });
    assertEquals(written.length, 0);
  }
});

Deno.test("a kubeconfig in a directory that does not exist is refused before kind create", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const { ctx, written } = context({
      kubeconfig: `${dir}/missing/kubeconfig`,
    });
    await inWorld({ clusters: [] }, ctx, async (k) => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      assertStringIncludes(
        String(err),
        `its directory ${dir}/missing does not exist`,
      );
      assertStringIncludes(String(err), "Nothing was created or written");
      assertEquals(lines(k), ["kind get clusters"]);
    });
    assertEquals(written.length, 0);
    // A file where the directory should be is no directory either.
    await Deno.writeTextFile(`${dir}/file`, "");
    const second = context({ kubeconfig: `${dir}/file/kubeconfig` });
    await inWorld({ clusters: [] }, second.ctx, async (k) => {
      await assertRejects(() => model.methods.ensure.execute({}, second.ctx));
      assertEquals(lines(k), ["kind get clusters"]);
    });
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("an existing cluster with a kubeconfig in a missing directory: nothing is exported into a directory kind would make", async () => {
  const { ctx, written } = context({ kubeconfig: "/nonexistent-dir/kc" });
  await inWorld(
    {
      clusters: ["t"],
      answers: {
        "get --raw /readyz": {
          fail: "error: stat /nonexistent-dir/kc: no such file or directory",
        },
      },
    },
    ctx,
    async (k) => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      assertStringIncludes(
        String(err),
        "its directory /nonexistent-dir does not exist",
      );
      assertEquals(lines(k), [
        "kind get clusters",
        "kubectl get --raw /readyz",
      ]);
    },
  );
  assertEquals(written.length, 0);
});

// ---------------------------------------------------------------------------
// Failures of kind and kubectl
// ---------------------------------------------------------------------------

Deno.test("a cluster whose name only starts like the one asked for does not count", async () => {
  const { ctx, written } = context();
  const world: World = { clusters: ["t2", "at", "kind-t"] };
  await inWorld(world, ctx, async (k) => {
    await model.methods.get.execute({}, ctx);
    await model.methods.ensure.execute({}, ctx);
    assertEquals(lines(k).slice(0, 3), [
      "kind get clusters",
      "kind get clusters",
      "kind create cluster --name t --config kind.yaml --wait 120s",
    ]);
  });
  assertEquals(written.map((w) => [w.exists, w.created]), [
    [false, false],
    [true, true],
  ]);
});

Deno.test("delete never names another cluster", async () => {
  const world: World = { clusters: ["dvflux", "t", "dvgw"] };
  const { ctx } = context();
  await inWorld(world, ctx, async (k) => {
    await model.methods.delete.execute({}, ctx);
    assertEquals(
      lines(k).filter((l) => l.includes("delete")),
      ["kind delete cluster --name t"],
    );
  });
  assertEquals(world.clusters, ["dvflux", "dvgw"]);
});

Deno.test("kind not installed names the kindBinary argument and writes nothing", async () => {
  for (const method of ["ensure", "get", "delete"] as const) {
    const { ctx, written } = context({ kindBinary: "no-such-kind" });
    await withCli({
      calls: [{
        bin: "no-such-kind",
        args: ["get", "clusters"],
        notInstalled: true,
      }],
    }, async () => {
      const err = await assertRejects(() =>
        model.methods[method].execute({}, ctx)
      );
      assertStringIncludes(String(err), "no-such-kind was not found");
      assertStringIncludes(String(err), "kindBinary");
    });
    assertEquals(written.length, 0);
  }
});

Deno.test("kubectl not installed is said as it is, not as a stopped container", async () => {
  const { ctx, written } = context({ kubectlBinary: "no-such-kubectl" });
  await inWorld(
    {
      clusters: ["t"],
      noKubectl: true,
    },
    ctx,
    async (k) => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      assertStringIncludes(String(err), "no-such-kubectl is not on PATH");
      assertEquals(String(err).includes("readiness check"), false);
      assertEquals(String(err).includes("container stopped"), false);
      assertEquals(lines(k).length, 2);
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("a missing kind config fails with kind's own sentence, and no kubectl runs", async () => {
  const { ctx, written } = context({ configPath: "nope.yaml" });
  const stderr = [
    "using podman due to KIND_EXPERIMENTAL_PROVIDER",
    "enabling experimental podman provider",
    "ERROR: failed to create cluster: error reading file: open /repo/nope.yaml: no such file or directory",
  ].join("\n");
  await inWorld(
    {
      clusters: [],
      answers: { "kind create cluster": { fail: stderr } },
    },
    ctx,
    async (k) => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      assertStringIncludes(
        String(err),
        "kind create cluster --name t --config nope.yaml --wait 120s failed (exit 1): ERROR: failed to create cluster: error reading file",
      );
      assertEquals(String(err).includes("experimental"), false);
      assertEquals(lines(k).some((l) => l.startsWith("kubectl")), false);
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("a long run of progress lines does not push kind's error out of the message", async () => {
  const { ctx } = context();
  const progress = Array.from(
    { length: 40 },
    (_, i) => ` ✓ Step number ${i} of the cluster creation 📦 `,
  );
  await inWorld(
    {
      clusters: [],
      answers: {
        "kind create cluster": {
          fail: [
            ...progress,
            " ✗ Starting control-plane 🕹️",
            "ERROR: failed to create cluster: failed to init node with kubeadm",
          ].join("\n"),
        },
      },
    },
    ctx,
    async () => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      assertStringIncludes(String(err), "✗ Starting control-plane");
      assertStringIncludes(String(err), "failed to init node with kubeadm");
      assertEquals(String(err).includes("Step number"), false);
    },
  );
});

Deno.test("kind create that runs past its limit is stopped, and the error says what to do", async () => {
  const { ctx, written } = context({ waitTimeout: "1m" });
  await inWorld(
    {
      clusters: [],
      answers: { "kind create cluster": { hang: true } },
    },
    ctx,
    async (k) => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      assertStringIncludes(String(err), "no answer within 360 seconds");
      assertStringIncludes(String(err), "waitTimeout plus 300 seconds");
      assertStringIncludes(String(err), "run delete before the next ensure");
      assertEquals(k.calls[1].timeoutMs, 360_000);
      assertEquals(lines(k).length, 2);
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("a cancelled run stops kind create and writes nothing", async () => {
  const abort = new AbortController();
  const { ctx, written } = context({}, abort.signal);
  await inWorld(
    {
      clusters: [],
      answers: { "kind create cluster": { hang: "until-cancelled" } },
    },
    ctx,
    async (k) => {
      const run = assertRejects(() => model.methods.ensure.execute({}, ctx));
      await new Promise((r) => setTimeout(r, 0));
      abort.abort();
      const err = await run;
      assertStringIncludes(String(err), "was cancelled");
      assertEquals(lines(k).length, 2);
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("a cancelled readiness check is a cancelled run, not a stopped container", async () => {
  const abort = new AbortController();
  const { ctx, written } = context({}, abort.signal);
  await inWorld(
    {
      clusters: ["t"],
      answers: { "get --raw /readyz": { hang: "until-cancelled" } },
    },
    ctx,
    async () => {
      const run = assertRejects(() => model.methods.ensure.execute({}, ctx));
      await new Promise((r) => setTimeout(r, 0));
      abort.abort();
      const err = await run;
      assertStringIncludes(String(err), "get --raw /readyz was cancelled");
      assertEquals(String(err).includes("readiness check"), false);
      assertEquals(String(err).includes("container stopped"), false);
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("a readiness check with no answer in time gets the stopped container hint", async () => {
  const { ctx, written } = context();
  await withProvider("nerdctl", () =>
    inWorld(
      {
        clusters: ["t"],
        answers: { "get --raw /readyz": { hang: true } },
      },
      ctx,
      async () => {
        const err = await assertRejects(() =>
          model.methods.ensure.execute({}, ctx)
        );
        assertStringIncludes(
          String(err),
          "try 'nerdctl start t-control-plane'",
        );
        assertStringIncludes(String(err), "no answer within 35 seconds");
      },
    ));
  assertEquals(written.length, 0);
});

Deno.test("refused credentials or a missing context are not called a stopped container", async () => {
  for (
    const fail of [
      "error: You must be logged in to the server (Unauthorized)",
      "error: cannot locate context kind-t",
      'Error from server (Forbidden): forbidden: User "x" cannot get path "/readyz"',
      "[+]ping ok\n[-]etcd failed: reason withheld\nreadyz check failed",
    ]
  ) {
    const { ctx, written } = context();
    await inWorld(
      {
        clusters: ["t"],
        answers: { "get --raw /readyz": { fail } },
      },
      ctx,
      async (k) => {
        const err = await assertRejects(() =>
          model.methods.ensure.execute({}, ctx)
        );
        assertStringIncludes(String(err), "did not pass the readiness check");
        assertStringIncludes(
          String(err),
          "the default kubeconfig does not hold a current entry for the context kind-t, write it with: kind export kubeconfig --name t",
        );
        assertEquals(String(err).includes("container stopped"), false);
        // Without the kubeconfig argument the default kubeconfig is not
        // written: no export is run.
        assertEquals(lines(k), [
          "kind get clusters",
          "kubectl get --raw /readyz",
        ]);
      },
    );
    assertEquals(written.length, 0);
  }
});

Deno.test("a certificate the kubeconfig does not trust is a stale entry, not a stopped container", async () => {
  for (
    const fail of [
      "Unable to connect to the server: tls: failed to verify certificate: x509: certificate signed by unknown authority",
      "Unable to connect to the server: x509: certificate has expired or is not yet valid",
    ]
  ) {
    const { ctx, written } = context();
    await withProvider("podman", () =>
      inWorld(
        {
          clusters: ["t"],
          answers: { "get --raw /readyz": { fail } },
        },
        ctx,
        async (k) => {
          const err = await assertRejects(() =>
            model.methods.ensure.execute({}, ctx)
          );
          assertStringIncludes(String(err), "kind export kubeconfig --name t");
          assertEquals(String(err).includes("container stopped"), false);
          assertEquals(String(err).includes("podman start"), false);
          assertEquals(lines(k).length, 2);
        },
      ));
    assertEquals(written.length, 0);
  }
});

Deno.test("with the kubeconfig argument a missing or stale entry is written by kind export, and ensure carries on", async () => {
  for (
    const fail of [
      "error: stat /repo/kc dir/kubeconfig: no such file or directory",
      'error: context "kind-t" does not exist',
      "error: cannot locate context kind-t",
      "Unable to connect to the server: x509: certificate signed by unknown authority",
      "error: You must be logged in to the server (Unauthorized)",
    ]
  ) {
    const dir = await Deno.makeTempDir();
    try {
      const file = `${dir}/kube config`;
      const { ctx, written, logs } = context({ kubeconfig: file });
      await inWorld(
        { clusters: ["t"], readyz: [{ fail }] },
        ctx,
        async (k) => {
          await model.methods.ensure.execute({}, ctx);
          assertEquals(lines(k), [
            "kind get clusters",
            "kubectl get --raw /readyz",
            `kind export kubeconfig --name t --kubeconfig ${file}`,
            "kubectl get --raw /readyz",
            "kubectl apply -f a.yaml",
            `kubectl config view --minify -o ${JSONPATH}`,
          ]);
          // One argument, spaces and all.
          assertEquals(k.calls[2].args.at(-1), file);
        },
      );
      assertEquals(written.length, 1);
      assertEquals(written[0].created, false);
      assertEquals(written[0].error, undefined);
      assert(logs.some((l) => l.includes("kind export kubeconfig")));
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  }
});

Deno.test("an export that does not help, or fails, ends the run with what is wrong", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/kc`;
    const fail = "error: cannot locate context kind-t";
    const still = context({ kubeconfig: file });
    await inWorld(
      { clusters: ["t"], readyz: [{ fail }, { fail }] },
      still.ctx,
      async (k) => {
        const err = await assertRejects(() =>
          model.methods.ensure.execute({}, still.ctx)
        );
        assertStringIncludes(String(err), "did not pass the readiness check");
        // Exported once, never in a loop.
        assertEquals(lines(k).filter((l) => l.includes("export")).length, 1);
        assertEquals(lines(k).length, 4);
      },
    );
    assertEquals(still.written.length, 0);
    const broken = context({ kubeconfig: file });
    await inWorld(
      {
        clusters: ["t"],
        readyz: [{ fail }],
        answers: {
          "kind export kubeconfig": {
            fail: "ERROR: could not locate any control plane nodes",
          },
        },
      },
      broken.ctx,
      async (k) => {
        const err = await assertRejects(() =>
          model.methods.ensure.execute({}, broken.ctx)
        );
        assertStringIncludes(String(err), "kind export kubeconfig --name t");
        assertStringIncludes(String(err), "could not locate any control plane");
        // After the failed export only the provider is asked for, to word
        // the hint; no second export and no second read.
        assertEquals(lines(k).slice(3).map((l) => l.split(" ")[1]), [
          "-v",
          "-v",
          "-v",
        ]);
      },
    );
    assertEquals(broken.written.length, 0);
    // A stopped container is not a stale entry: nothing is exported.
    const down = context({ kubeconfig: file });
    await withProvider("podman", () =>
      inWorld(
        { clusters: ["t"], readyz: [{ fail: REFUSED }] },
        down.ctx,
        async (k) => {
          const err = await assertRejects(() =>
            model.methods.ensure.execute({}, down.ctx)
          );
          assertStringIncludes(String(err), "podman start t-control-plane");
          assertEquals(lines(k).length, 2);
        },
      ));
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a manifest that fails to apply stops the run, and what is true is recorded first", async () => {
  const { ctx, written } = context({ manifests: ["a.yaml", "b.yaml", "c"] });
  await inWorld(
    {
      clusters: [],
      answers: {
        "apply -f b.yaml": {
          fail: 'error: the path "b.yaml" does not exist',
        },
      },
    },
    ctx,
    async (k) => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      assertStringIncludes(
        String(err),
        'kubectl apply -f b.yaml failed: error: the path "b.yaml" does not exist',
      );
      assertEquals(lines(k).slice(3), [
        "kubectl apply -f a.yaml",
        "kubectl apply -f b.yaml",
        `kubectl config view --minify -o ${JSONPATH}`,
      ]);
    },
  );
  // The cluster this run created exists, with the first manifest applied.
  assertEquals(written.length, 1);
  assertEquals(written[0].exists, true);
  assertEquals(written[0].created, true);
  assertEquals(written[0].manifestsApplied, ["a.yaml"]);
  assertEquals(written[0].manifestFailed, "b.yaml");
  assertEquals(written[0].apiServer, SERVER);
  assertStringIncludes(String(written[0].error), "b.yaml");
});

Deno.test("the record of a failed apply is written even when the server address cannot be read", async () => {
  const { ctx, written } = context();
  await inWorld(
    {
      clusters: ["t"],
      answers: {
        "apply -f a.yaml": { fail: "error: validation failed" },
        "config view": { fail: "error: cannot locate context kind-t" },
      },
    },
    ctx,
    async () => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      // The apply failure is the error, not the read that came after it.
      assertStringIncludes(String(err), "validation failed");
    },
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].created, false);
  assertEquals(written[0].manifestsApplied, []);
  assertEquals(written[0].manifestFailed, "a.yaml");
  assertEquals(written[0].apiServer, "");
});

Deno.test("a run cancelled during an apply writes nothing, like every other cancelled run", async () => {
  const abort = new AbortController();
  const { ctx, written } = context({}, abort.signal);
  await inWorld(
    {
      clusters: ["t"],
      answers: { "apply -f a.yaml": { hang: "until-cancelled" } },
    },
    ctx,
    async (k) => {
      const run = assertRejects(() => model.methods.ensure.execute({}, ctx));
      await new Promise((r) => setTimeout(r, 0));
      abort.abort();
      assertStringIncludes(String(await run), "apply -f a.yaml was cancelled");
      // No read of the address either: nothing follows the cancelled apply.
      assertEquals(lines(k).at(-1), "kubectl apply -f a.yaml");
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("kubeconfig gone and node container stopped: the hint stays, the export failure follows", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const file = `${dir}/kc`;
    const said =
      'ERROR: failed to get cluster internal kubeconfig: command "podman exec --privileged t-control-plane cat /etc/kubernetes/admin.conf" failed with error: exit status 255';
    const { ctx, written } = context({ kubeconfig: file });
    await withProvider("podman", () =>
      inWorld(
        {
          clusters: ["t"],
          readyz: [{ fail: `error: stat ${file}: no such file or directory` }],
          answers: { "kind export kubeconfig": { fail: said } },
        },
        ctx,
        async (k) => {
          const err = await assertRejects(() =>
            model.methods.ensure.execute({}, ctx)
          );
          const text = String(err);
          assertStringIncludes(text, "try 'podman start t-control-plane'");
          assertStringIncludes(text, "kind export kubeconfig --name t");
          assertStringIncludes(text, "exit status 255");
          assert(
            text.indexOf("podman start") < text.indexOf("exit status 255"),
            text,
          );
          assertEquals(lines(k).length, 3);
        },
      ));
    assertEquals(written.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a cancelled export is a cancelled run, not a stopped container", async () => {
  const dir = await Deno.makeTempDir();
  try {
    const abort = new AbortController();
    const { ctx, written } = context({ kubeconfig: `${dir}/kc` }, abort.signal);
    await inWorld(
      {
        clusters: ["t"],
        readyz: [{ fail: "error: cannot locate context kind-t" }],
        answers: { "kind export kubeconfig": { hang: "until-cancelled" } },
      },
      ctx,
      async () => {
        const run = assertRejects(() => model.methods.ensure.execute({}, ctx));
        await new Promise((r) => setTimeout(r, 0));
        abort.abort();
        const text = String(await run);
        assertStringIncludes(text, "was cancelled");
        assertEquals(text.includes("container stopped"), false);
      },
    );
    assertEquals(written.length, 0);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a long kubeconfig path does not cut the export command in a get record", async () => {
  const long = `${"very-long-directory-name/".repeat(30)}kube config`;
  assert(long.length > 700);
  const { ctx, written } = context({ kubeconfig: long });
  await inWorld(
    {
      clusters: ["t"],
      answers: {
        "config view": {
          fail: `error: stat /repo/${long}: no such file or directory`,
        },
      },
    },
    ctx,
    async () => {
      await model.methods.get.execute({}, ctx);
    },
  );
  const error = String(written[0].error);
  assertStringIncludes(
    error,
    `kind export kubeconfig --name t --kubeconfig '${long}'`,
  );
  // What kubectl said is still bounded.
  assert(error.length < 2 * long.length + 700, String(error.length));
  assertStringIncludes(error, "kubectl config view");
});

Deno.test("a successful ensure records no failure fields", async () => {
  const { ctx, written } = context();
  await inWorld({ clusters: ["t"] }, ctx, async () => {
    await model.methods.ensure.execute({}, ctx);
  });
  assertEquals("manifestFailed" in written[0], false);
  assertEquals("error" in written[0], false);
});

Deno.test("get of an existing cluster whose context is not in the kubeconfig records that it exists, and why the rest is missing", async () => {
  const { ctx, written } = context({ kubeconfig: "my dir/kc" });
  await inWorld(
    {
      clusters: ["t"],
      answers: {
        "config view": { fail: "error: cannot locate context kind-t" },
      },
    },
    ctx,
    async (k) => {
      await model.methods.get.execute({}, ctx);
      // A read writes no kubeconfig: nothing is exported.
      assertEquals(lines(k).length, 2);
    },
  );
  assertEquals(written.length, 1);
  assertEquals(written[0].exists, true);
  assertEquals(written[0].apiServer, "");
  assertStringIncludes(
    String(written[0].error),
    "cannot locate context kind-t",
  );
  // The path is quoted so the command can be pasted.
  assertStringIncludes(
    String(written[0].error),
    "write it with: kind export kubeconfig --name t --kubeconfig 'my dir/kc'",
  );
});

Deno.test("get records an existing cluster when kubectl is not there, and a missing cluster has no error", async () => {
  const there = context();
  await inWorld({ clusters: ["t"], noKubectl: true }, there.ctx, async () => {
    await model.methods.get.execute({}, there.ctx);
  });
  assertEquals(there.written[0].exists, true);
  assertStringIncludes(
    String(there.written[0].error),
    "kubectl is not on PATH",
  );
  const gone = context();
  await inWorld({ clusters: [], noKubectl: true }, gone.ctx, async () => {
    await model.methods.get.execute({}, gone.ctx);
  });
  assertEquals(gone.written[0].exists, false);
  assertEquals("error" in gone.written[0], false);
});

Deno.test("a cancelled get writes nothing", async () => {
  const abort = new AbortController();
  const { ctx, written } = context({}, abort.signal);
  await inWorld(
    {
      clusters: ["t"],
      answers: { "config view": { hang: "until-cancelled" } },
    },
    ctx,
    async () => {
      const run = assertRejects(() => model.methods.get.execute({}, ctx));
      await new Promise((r) => setTimeout(r, 0));
      abort.abort();
      assertStringIncludes(String(await run), "was cancelled");
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("shellQuote leaves a plain path and quotes the rest", () => {
  assertEquals(
    shellQuote("/tmp/a-b_c.d/kube:config"),
    "/tmp/a-b_c.d/kube:config",
  );
  assertEquals(shellQuote("my dir/kc"), "'my dir/kc'");
  assertEquals(shellQuote("a'b"), "'a'\\''b'");
  assertEquals(shellQuote("$(id)"), "'$(id)'");
  assertEquals(shellQuote("a;b"), "'a;b'");
});

Deno.test("paths with spaces reach kind and kubectl as one argument each", async () => {
  const dir = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${dir}/kube dir`);
    const file = `${dir}/kube dir/kube config`;
    const { ctx, written } = context({
      configPath: "my configs/kind one.yaml",
      kubeconfig: file,
      manifests: ["my manifests/name space.yaml"],
    });
    await inWorld({ clusters: [] }, ctx, async (k) => {
      await model.methods.ensure.execute({}, ctx);
      await model.methods.delete.execute({}, ctx);
      assertEquals(k.calls[1].args, [
        "create",
        "cluster",
        "--name",
        "t",
        "--config",
        "my configs/kind one.yaml",
        "--wait",
        "120s",
        "--kubeconfig",
        file,
      ]);
      assertEquals(k.calls[3].args.slice(0, 2), ["--kubeconfig", file]);
      assertEquals(k.calls[3].args.slice(-3), [
        "apply",
        "-f",
        "my manifests/name space.yaml",
      ]);
      assertEquals(k.calls.at(-1)!.args.slice(-2), ["--kubeconfig", file]);
    });
    assertEquals(written[0].kubeconfig, file);
    assertEquals(written[0].manifestsApplied, ["my manifests/name space.yaml"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("a probe that cannot be run is not the provider, and never replaces the real error", async () => {
  for (
    const thrown of [
      new Deno.errors.PermissionDenied("Permission denied (os error 13)"),
      new Error("Exec format error (os error 8)"),
    ]
  ) {
    const { ctx } = context();
    await withProvider(undefined, () =>
      inWorld(
        {
          ...stopped({ podman: "podman version 4.9.3\n" }),
          spawnThrows: { docker: thrown, nerdctl: thrown },
        },
        ctx,
        async (k) => {
          const err = await assertRejects(() =>
            model.methods.ensure.execute({}, ctx)
          );
          assertStringIncludes(String(err), "API server is not reachable");
          assertStringIncludes(
            String(err),
            "try 'podman start t-control-plane'",
          );
          assertEquals(String(err).includes("os error"), false);
          assertEquals(lines(k).slice(2), [
            "docker -v",
            "nerdctl -v",
            "podman -v",
          ]);
        },
      ));
    const none = context();
    await withProvider(undefined, () =>
      inWorld(
        {
          ...stopped(),
          spawnThrows: { docker: thrown, nerdctl: thrown, podman: thrown },
        },
        none.ctx,
        async () => {
          const err = await assertRejects(() =>
            model.methods.ensure.execute({}, none.ctx)
          );
          assertStringIncludes(String(err), "API server is not reachable");
          assertStringIncludes(String(err), "the container runtime kind uses");
        },
      ));
  }
});

Deno.test("a waitTimeout longer than a time limit can be is refused by name, with no spawn", async () => {
  assertEquals(durationMs("596h"), 596 * 3_600_000);
  assert(durationMs("596h") <= MAX_WAIT_MS);
  for (
    const value of [
      "597h",
      "600h",
      "99999999h",
      "2147483647ms",
      "9".repeat(400) + "h",
    ]
  ) {
    const { ctx, written } = context({ waitTimeout: value });
    await withCli({}, async (k) => {
      const err = await assertRejects(() =>
        model.methods.ensure.execute({}, ctx)
      );
      assertStringIncludes(String(err), "waitTimeout");
      assertStringIncludes(String(err), "is too long: at most 596h");
      assertEquals(k.calls.length, 0);
    });
    assertEquals(written.length, 0);
  }
  // The longest accepted wait still gives kind create a limit it can have.
  const { ctx } = context({ waitTimeout: "596h" });
  await inWorld({ clusters: [] }, ctx, async (k) => {
    await model.methods.ensure.execute({}, ctx);
    assertEquals(k.calls[1].timeoutMs, 596 * 3_600_000 + CREATE_MARGIN_MS);
  });
});

Deno.test("every method says what it is about to do, and how it ended", async () => {
  for (
    const [method, clusters, last] of [
      ["ensure", [], "is up"],
      ["ensure", ["t"], "is up"],
      ["get", ["t"], "kind cluster {name}: {state}"],
      ["get", [], "kind cluster {name}: {state}"],
      ["delete", ["t"], "is gone"],
      ["delete", [], "is gone"],
    ] as const
  ) {
    const { ctx, logs } = context();
    await inWorld({ clusters: [...clusters] }, ctx, async () => {
      await model.methods[method].execute({}, ctx);
    });
    assertStringIncludes(logs[0], "Looking up kind cluster {name}");
    assertStringIncludes(logs.at(-1)!, last);
    assertStringIncludes(logs.at(-1)!, '"name":"t"');
  }
});

Deno.test("the first log line is written before the first command is spawned", async () => {
  for (const method of ["ensure", "get", "delete"] as const) {
    const { ctx, logs } = context();
    const world: World = {
      clusters: [],
      spawnThrows: { kind: new Error("stop here") },
    };
    await inWorld(world, ctx, async () => {
      await assertRejects(() => model.methods[method].execute({}, ctx));
    });
    assertEquals(logs.length, 1, method);
    assertStringIncludes(logs[0], "Looking up kind cluster {name}");
  }
});

Deno.test("the provider probe says that it runs", async () => {
  const { ctx, logs } = context();
  await withProvider(
    undefined,
    () =>
      inWorld(stopped({ podman: "podman version 4.9.3\n" }), ctx, async () => {
        await assertRejects(() => model.methods.ensure.execute({}, ctx));
      }),
  );
  assert(logs.some((l) => l.includes("asking docker, nerdctl and podman")));
  const quiet = context();
  await withProvider("podman", () =>
    inWorld(stopped(), quiet.ctx, async () => {
      await assertRejects(() => model.methods.ensure.execute({}, quiet.ctx));
    }));
  assertEquals(quiet.logs.some((l) => l.includes("asking docker")), false);
});

Deno.test("a failed delete writes no record that says the cluster is gone", async () => {
  const { ctx, written } = context();
  await inWorld(
    {
      clusters: ["t"],
      answers: {
        "kind delete cluster": {
          fail: 'ERROR: failed to delete cluster "t": failed to delete nodes',
        },
      },
    },
    ctx,
    async () => {
      const err = await assertRejects(() =>
        model.methods.delete.execute({}, ctx)
      );
      assertStringIncludes(String(err), "failed to delete nodes");
    },
  );
  assertEquals(written.length, 0);
});

Deno.test("nothing shaped like a credential reaches an error", async () => {
  const jwt = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
  const cases: [Record<string, Answer>, "ensure" | "get" | "delete"][] = [
    [{
      "kind get clusters": {
        fail: `ERROR: registry login failed: password=hunter2hunter2`,
      },
    }, "get"],
    [{
      "get --raw /readyz": {
        fail: `E1110 10:00:00.000000 1 memcache.go:1] token ${jwt}\n` +
          `error: Authorization: Bearer ${jwt} was rejected`,
      },
    }, "ensure"],
    [{
      "apply -f a.yaml": {
        fail: `error: could not read https://user:hunter2hunter2@example.com/a`,
        stdout: `token: ${jwt}`,
      },
    }, "ensure"],
  ];
  for (const [answers, method] of cases) {
    const { ctx, written, logs } = context();
    await inWorld({ clusters: ["t"], answers }, ctx, async () => {
      const err = await assertRejects(() =>
        model.methods[method].execute({}, ctx)
      );
      const text = String(err) + logs.join("\n") + JSON.stringify(written);
      assertEquals(text.includes("hunter2hunter2"), false, text);
      assertEquals(text.includes(jwt), false, text);
    });
    // Only the failed apply leaves a record, and it holds no credential.
    assertEquals(written.length, "apply -f a.yaml" in answers ? 1 : 0);
  }
});

Deno.test("the fakes refuse a flag kind or kubectl does not have, so a wrong flag cannot pass", async () => {
  const { ctx } = context();
  const world = () => ({ clusters: [] });
  const limit = { timeoutMs: 35_000 };
  await assertRejects(
    () =>
      inWorld(
        world(),
        ctx,
        (k) =>
          k.spawn("kind", ["get", "clusters", "--kubeconfig-file", "x"], limit),
      ),
    Error,
    "unknown flag --kubeconfig-file",
  );
  const flags = ["--context", "kind-t", "--request-timeout=30s"];
  await assertRejects(
    () =>
      inWorld(
        world(),
        ctx,
        (k) =>
          k.spawn("kubectl", [...flags, "apply", "-f", "a", "--force"], limit),
      ),
    Error,
    "unknown flag for apply: --force",
  );
  await assertRejects(
    () =>
      inWorld(
        world(),
        ctx,
        (k) =>
          k.spawn("kubectl", [
            "--context",
            "kind-other",
            ...flags.slice(2),
            "get",
            "--raw",
            "/readyz",
          ], limit),
      ),
    Error,
    "the call must start with",
  );
  await assertRejects(
    () =>
      inWorld(
        world(),
        ctx,
        (k) =>
          k.spawn("kubectl", [...flags, "delete", "namespace", "x"], limit),
      ),
    Error,
    "fake kubectl",
  );
});
