/**
 * Negative tests: what the model does when the key source, the gateway or the
 * caller is wrong. Every case asserts that it fails loudly or records exactly
 * what happened, and that no secret reaches the error, a record or a log.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { GlobalArgsSchema, model } from "./gateway.ts";
import { parseAccounts, parseBuckets, parseVersioning } from "./parse.ts";
import { __setFetch, parseXml, readRootKey, S3Error } from "./transport.ts";
import {
  type Fixture,
  fixture,
  globalArgs,
  installFetch,
  keyFile,
  makeContext,
  ROOT_ACCESS,
  ROOT_SECRET,
  SECRET_MARK,
  type Written,
} from "./test_support.ts";

const XML = "application/xml";

function answer(
  path: string,
  status: number,
  body: string,
  method = "PATCH",
): Fixture {
  return { method, path, status, contentType: XML, body };
}

/** Run `fn` against the recorded gateway, with `override` answering first. */
async function withGateway(
  override: ((line: string) => Fixture | undefined) | undefined,
  fn: (g: ReturnType<typeof globalArgs>) => Promise<void>,
): Promise<void> {
  const file = keyFile();
  const fake = installFetch(override);
  try {
    await fn(globalArgs({ rootKeyFile: file.path }));
  } finally {
    fake.restore();
    file.cleanup();
  }
}

function assertClean(text: string): void {
  for (const value of [SECRET_MARK, ROOT_SECRET]) {
    assertEquals(text.includes(value), false, `${value} in: ${text}`);
  }
}

function assertNothingWritten(written: Written[]): void {
  assertEquals(written.map((w) => w.spec), [], "a failed run wrote records");
}

// ---------------------------------------------------------------------------
// The root key source
// ---------------------------------------------------------------------------

function withFile(content: string, fn: (path: string) => void): void {
  const path = Deno.makeTempFileSync();
  Deno.writeTextFileSync(path, content);
  try {
    fn(path);
  } finally {
    Deno.removeSync(path);
  }
}

Deno.test("an empty key file is refused by name, not by value", () => {
  withFile("", (path) => {
    assertThrows(
      () => readRootKey(globalArgs({ rootKeyFile: path })),
      Error,
      "ROOT_ACCESS_KEY is not set",
    );
  });
});

Deno.test("a key set to the empty string counts as not set", () => {
  withFile(`ROOT_ACCESS_KEY=${ROOT_ACCESS}\nROOT_SECRET_KEY=\n`, (path) => {
    assertThrows(
      () => readRootKey(globalArgs({ rootKeyFile: path })),
      Error,
      "ROOT_SECRET_KEY is not set",
    );
  });
});

Deno.test("a key file with CRLF line ends yields no carriage return in the key", () => {
  withFile(
    `ROOT_ACCESS_KEY=${ROOT_ACCESS}\r\nROOT_SECRET_KEY=${ROOT_SECRET}\r\n`,
    (path) => {
      const key = readRootKey(globalArgs({ rootKeyFile: path }));
      assertEquals(key, { access: ROOT_ACCESS, secret: ROOT_SECRET });
    },
  );
});

Deno.test("a directory named as the key file is an error that names the path", () => {
  const dir = Deno.makeTempDirSync();
  try {
    const error = assertThrows(() =>
      readRootKey(globalArgs({ rootKeyFile: dir }))
    );
    assertStringIncludes((error as Error).message, dir);
  } finally {
    Deno.removeSync(dir);
  }
});

Deno.test("keys in the environment are not read unless rootKeyEnv says so", () => {
  Deno.env.set("ROOT_ACCESS_KEY", ROOT_ACCESS);
  Deno.env.set("ROOT_SECRET_KEY", ROOT_SECRET);
  try {
    assertThrows(() => readRootKey(globalArgs()), Error, "no root key source");
  } finally {
    Deno.env.delete("ROOT_ACCESS_KEY");
    Deno.env.delete("ROOT_SECRET_KEY");
  }
});

Deno.test("the root-key-named check fails on no source and on two", async () => {
  const check = model.checks["root-key-named"];
  assertEquals((await check.execute({ globalArgs: globalArgs() })).pass, false);
  assertEquals(
    (await check.execute({
      globalArgs: globalArgs({ rootKeyFile: "/x", rootKeyEnv: true }),
    })).pass,
    false,
  );
});

Deno.test("admin-reachable applies the schema's defaults to a minimal definition", async () => {
  const fake = installFetch();
  Deno.env.set("ROOT_ACCESS_KEY", ROOT_ACCESS);
  Deno.env.set("ROOT_SECRET_KEY", ROOT_SECRET);
  try {
    // As a check receives it: only what the definition wrote, no defaults.
    const written = {
      adminUrl: "http://127.0.0.1:17071",
      s3Url: "http://127.0.0.1:17070",
      rootKeyEnv: true,
    };
    const result = await model.checks["admin-reachable"].execute({
      globalArgs: written,
    });
    assertEquals(result, { pass: true });
    assertEquals(fake.seen, [{ line: "PATCH /list-buckets", signed: true }]);
  } finally {
    Deno.env.delete("ROOT_ACCESS_KEY");
    Deno.env.delete("ROOT_SECRET_KEY");
    fake.restore();
  }
});

Deno.test("admin-reachable without the key names the variable, not undefined", async () => {
  const result = await model.checks["admin-reachable"].execute({
    globalArgs: {
      adminUrl: "http://127.0.0.1:17071",
      s3Url: "http://127.0.0.1:17070",
      rootKeyEnv: true,
    },
  });
  assertEquals(result.pass, false);
  assertStringIncludes(result.errors![0], "ROOT_ACCESS_KEY is not set");
});

Deno.test("a method without a key source fails before any request", async () => {
  const fake = installFetch();
  try {
    const { context, written } = makeContext(globalArgs());
    await assertRejects(
      () => model.methods.inventory.execute({}, context),
      Error,
      "no root key source",
    );
    assertEquals(fake.seen, []);
    assertNothingWritten(written);
  } finally {
    fake.restore();
  }
});

Deno.test("a caFile that does not exist is an error that says caFile", async () => {
  await withGateway(undefined, async (g) => {
    const { context } = makeContext({ ...g, caFile: "/nonexistent/ca.crt" });
    await assertRejects(
      () => model.methods.accounts.execute({}, context),
      Error,
      "caFile",
    );
  });
});

// ---------------------------------------------------------------------------
// The gateway refuses
// ---------------------------------------------------------------------------

for (
  const [name, code] of [
    ["admin-wrong-region", "IncorrectRegion"],
    ["admin-wrong-secret", "SignatureDoesNotMatch"],
    ["admin-unknown-key", "InvalidAccessKeyId"],
    ["admin-not-admin", "XAdminAccessDenied"],
  ]
) {
  Deno.test(`inventory fails whole on ${code}, writing nothing`, async () => {
    const refusal = fixture(name);
    await withGateway(
      (line) => line === "PATCH /list-users" ? refusal : undefined,
      async (g) => {
        const { context, written, logs } = makeContext(
          name === "admin-wrong-region" ? { ...g, region: "eu-north-1" } : g,
        );
        const error = await assertRejects(
          () => model.methods.inventory.execute({}, context),
          S3Error,
        );
        assertEquals((error as S3Error).code, code);
        assertClean((error as Error).message + logs.join("\n"));
        assertNothingWritten(written);
      },
    );
  });
}

Deno.test("a 500 on one bucket's setting fails the inventory, writing nothing", async () => {
  await withGateway(
    (line) =>
      line === "GET /ops?acl"
        ? answer(
          "/ops?acl",
          500,
          "<Error><Code>InternalError</Code><Message>boom</Message></Error>",
          "GET",
        )
        : undefined,
    async (g) => {
      const { context, written } = makeContext(g);
      const error = await assertRejects(
        () => model.methods.inventory.execute({}, context),
        S3Error,
      );
      assertEquals((error as S3Error).code, "InternalError");
      assertStringIncludes((error as Error).message, "/ops?acl");
      assertNothingWritten(written);
    },
  );
});

Deno.test("a bucket deleted between list and read fails with NoSuchBucket", async () => {
  await withGateway(
    (line) =>
      line.startsWith("GET /ops?")
        ? { ...fixture("bucket-missing-versioning"), path: line.slice(4) }
        : undefined,
    async (g) => {
      const { context, written } = makeContext(g);
      const error = await assertRejects(
        () => model.methods.inventory.execute({}, context),
        S3Error,
      );
      assertEquals((error as S3Error).code, "NoSuchBucket");
      assertNothingWritten(written);
    },
  );
});

Deno.test("an error body that is not an S3 error does not reach the message", async () => {
  // A misrouted proxy answering 502 with the account list must not leak it.
  const leaked = fixture("admin-list-users").body;
  await withGateway(
    (line) =>
      line === "PATCH /list-users"
        ? answer("/list-users", 502, leaked)
        : undefined,
    async (g) => {
      const { context } = makeContext(g);
      const error = await assertRejects(() =>
        model.methods.accounts.execute({}, context)
      );
      assertClean((error as Error).message);
      assertStringIncludes((error as Error).message, "502");
    },
  );
});

// ---------------------------------------------------------------------------
// The gateway answers 200 with something wrong
// ---------------------------------------------------------------------------

for (
  const [label, body] of [
    ["an empty body", ""],
    ["plain text", "OK"],
    ["another document", fixture("admin-list-buckets").body],
    ["truncated XML", fixture("admin-list-users").body.slice(0, 300)],
    ["an S3 error with status 200", "<Error><Code>AccessDenied</Code></Error>"],
  ]
) {
  Deno.test(`list-users answering 200 with ${label} fails, recording nothing`, async () => {
    await withGateway(
      (line) =>
        line === "PATCH /list-users"
          ? answer("/list-users", 200, body)
          : undefined,
      async (g) => {
        const { context, written, logs } = makeContext(g);
        const error = await assertRejects(() =>
          model.methods.accounts.execute({}, context)
        );
        assertClean((error as Error).message + logs.join("\n"));
        assertNothingWritten(written);
      },
    );
  });
}

Deno.test("an account without an access key is an error, not an empty name", () => {
  assertThrows(() =>
    parseAccounts(
      "<ListUserAccountsResult><Accounts><Role>user</Role><Secret>FIXTURE-SECRET-x</Secret></Accounts></ListUserAccountsResult>",
    )
  );
});

Deno.test("a non-numeric user id is an error, not a zero", () => {
  assertThrows(() =>
    parseAccounts(
      "<ListUserAccountsResult><Accounts><Access>a</Access><Role>user</Role><UserID>x</UserID></Accounts></ListUserAccountsResult>",
    )
  );
});

Deno.test("a bucket without a name is an error", () => {
  assertThrows(() =>
    parseBuckets(
      "<ListBucketsResult><Buckets><Owner>a</Owner></Buckets></ListBucketsResult>",
      ROOT_ACCESS,
    )
  );
});

Deno.test("an unknown versioning status is an error, not Off", () => {
  assertThrows(() =>
    parseVersioning(
      "<VersioningConfiguration><Status>Sometimes</Status></VersioningConfiguration>",
    )
  );
});

Deno.test("a single account parses as a list of one", () => {
  const accounts = parseAccounts(
    "<ListUserAccountsResult><Accounts><Access>a</Access><Role>user</Role></Accounts></ListUserAccountsResult>",
  );
  assertEquals(accounts.map((a) => a.access), ["a"]);
});

Deno.test("an unexpected element holding a secret does not reach the record", () => {
  const accounts = parseAccounts(
    `<ListUserAccountsResult><Accounts><Access>a</Access><Role>user</Role><SecretV2>${SECRET_MARK}-new</SecretV2><SessionToken>${SECRET_MARK}-tok</SessionToken></Accounts></ListUserAccountsResult>`,
  );
  assertClean(JSON.stringify(accounts));
});

Deno.test("the root account is never recorded, even if list-users lists it", async () => {
  const withRoot = fixture("admin-list-users").body.replace(
    "<ListUserAccountsResult>",
    `<ListUserAccountsResult><Accounts><Access>${ROOT_ACCESS}</Access><Secret>${ROOT_SECRET}</Secret><Role>admin</Role></Accounts>`,
  );
  await withGateway(
    (line) =>
      line === "PATCH /list-users"
        ? answer("/list-users", 200, withRoot)
        : undefined,
    async (g) => {
      const { context, written, logs } = makeContext(g);
      await model.methods.accounts.execute({}, context);
      const all = JSON.stringify(written) + logs.join("\n");
      assertEquals(all.includes(ROOT_ACCESS), false);
      assertClean(all);
    },
  );
});

Deno.test("a policy naming root records the placeholder, not the key", async () => {
  const policy = JSON.stringify({
    Statement: [{
      Effect: "Allow",
      Principal: { AWS: [ROOT_ACCESS] },
      Action: "s3:*",
    }],
  });
  await withGateway(
    (line) =>
      line === "GET /ops?policy"
        ? {
          method: "GET",
          path: "/ops?policy",
          status: 200,
          contentType: "text/plain",
          body: policy,
        }
        : undefined,
    async (g) => {
      const { context, written } = makeContext(g);
      await model.methods.bucketSettings.execute({ buckets: ["ops"] }, context);
      const recorded = String(written[0].data.policy);
      assertEquals(recorded.includes(ROOT_ACCESS), false);
      assertStringIncludes(recorded, "<root>");
    },
  );
});

Deno.test("accounts whose names slug alike still get distinct data names", async () => {
  const body =
    "<ListUserAccountsResult><Accounts><Access>A.b</Access><Role>user</Role></Accounts><Accounts><Access>a-b</Access><Role>user</Role></Accounts><Accounts><Access>a_b</Access><Role>user</Role></Accounts></ListUserAccountsResult>";
  await withGateway(
    (line) =>
      line === "PATCH /list-users"
        ? answer("/list-users", 200, body)
        : undefined,
    async (g) => {
      const { context, written } = makeContext(g);
      await model.methods.accounts.execute({}, context);
      const names = written.map((w) => w.name);
      assertEquals(new Set(names).size, 3, names.join(" "));
    },
  );
});

Deno.test("a DOCTYPE with entities is not expanded", () => {
  const bomb = `<?xml version="1.0"?>
<!DOCTYPE r [<!ENTITY a "aaaaaaaaaa"><!ENTITY b "&a;&a;&a;&a;&a;&a;&a;&a;&a;&a;"><!ENTITY c "&b;&b;&b;&b;&b;&b;&b;&b;&b;&b;"><!ENTITY d "&c;&c;&c;&c;&c;&c;&c;&c;&c;&c;"><!ENTITY e "&d;&d;&d;&d;&d;&d;&d;&d;&d;&d;"><!ENTITY f "&e;&e;&e;&e;&e;&e;&e;&e;&e;&e;">]>
<ListUserAccountsResult><Accounts><Access>&f;</Access><Role>user</Role></Accounts></ListUserAccountsResult>`;
  let parsed = "";
  try {
    parsed = JSON.stringify(parseXml(bomb));
  } catch {
    return; // refusing the document is as good as not expanding it
  }
  assert(parsed.length < 10_000, `expanded to ${parsed.length} characters`);
});

// ---------------------------------------------------------------------------
// The network
// ---------------------------------------------------------------------------

Deno.test("a gateway that never answers times out at httpTimeoutMs", async () => {
  const file = keyFile();
  __setFetch((_request, init) =>
    new Promise((_resolve, reject) => {
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })
  );
  try {
    const { context, written } = makeContext(
      globalArgs({ rootKeyFile: file.path, httpTimeoutMs: 50 }),
    );
    const started = performance.now();
    const error = await assertRejects(() =>
      model.methods.accounts.execute({}, context)
    );
    assert(performance.now() - started < 2000);
    assertStringIncludes((error as Error).message, "/list-users");
    assertClean((error as Error).message);
    assertNothingWritten(written);
  } finally {
    __setFetch();
    file.cleanup();
  }
});

Deno.test("an aborted run stops, writing nothing", async () => {
  const file = keyFile();
  __setFetch((_request, init) =>
    new Promise((_resolve, reject) => {
      if (init.signal?.aborted) reject(init.signal.reason);
      init.signal?.addEventListener("abort", () => reject(init.signal?.reason));
    })
  );
  try {
    const controller = new AbortController();
    const { context, written } = makeContext(
      globalArgs({ rootKeyFile: file.path }),
    );
    context.signal = controller.signal;
    const run = model.methods.inventory.execute({}, context);
    controller.abort(new Error("cancelled"));
    await assertRejects(() => run);
    assertNothingWritten(written);
  } finally {
    __setFetch();
    file.cleanup();
  }
});

Deno.test("health records a TLS failure instead of throwing", async () => {
  __setFetch(() =>
    Promise.reject(
      new TypeError(
        "error sending request: invalid peer certificate: UnknownIssuer",
      ),
    )
  );
  try {
    const { context, written } = makeContext(
      globalArgs({ s3Url: "https://127.0.0.1:1" }),
    );
    await model.methods.health.execute({}, context);
    assertEquals(written[0].data.reachable, false);
    assertEquals(written[0].data.tls, "failed");
    assertEquals(written[0].data.status, null);
  } finally {
    __setFetch();
  }
});

Deno.test("health finds a TLS failure in the error's cause, as fetch reports it", async () => {
  __setFetch(() =>
    Promise.reject(
      new TypeError("fetch failed", {
        cause: new Error("invalid peer certificate: UnknownIssuer"),
      }),
    )
  );
  try {
    const { context, written } = makeContext(
      globalArgs({ s3Url: "https://127.0.0.1:1" }),
    );
    await model.methods.health.execute({}, context);
    assertEquals(written[0].data.tls, "failed");
    assertStringIncludes(String(written[0].data.error), "UnknownIssuer");
  } finally {
    __setFetch();
  }
});

Deno.test("a secret in an error's cause is masked too", async () => {
  __setFetch(() =>
    Promise.reject(
      new TypeError("fetch failed", {
        cause: new Error(`echo ${ROOT_SECRET}`),
      }),
    )
  );
  const file = keyFile();
  try {
    const { context } = makeContext(globalArgs({ rootKeyFile: file.path }));
    const error = await assertRejects(() =>
      model.methods.accounts.execute({}, context)
    );
    assertClean((error as Error).message);
  } finally {
    __setFetch();
    file.cleanup();
  }
});

Deno.test("health records a 503 as unreachable, with the status", async () => {
  await withGateway(
    (line) =>
      line === "GET /health"
        ? {
          method: "GET",
          path: "/health",
          status: 503,
          contentType: "text/plain",
          body: "down",
        }
        : undefined,
    async (g) => {
      const { context, written } = makeContext(g);
      await model.methods.health.execute({}, context);
      assertEquals(written[0].data.reachable, false);
      assertEquals(written[0].data.status, 503);
      assertEquals(written[0].data.error, "down");
    },
  );
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

Deno.test("check without any inventory says to run one", async () => {
  const { context, written } = makeContext(globalArgs());
  await assertRejects(
    () => model.methods.check.execute({}, context),
    Error,
    "run inventory first",
  );
  assertNothingWritten(written);
});

for (
  const id of [
    '" || true || "',
    "00000000-0000-0000-0000-00000000000",
    "../../etc",
    "",
  ]
) {
  Deno.test(`check refuses inventoryId ${JSON.stringify(id)} before querying`, async () => {
    const { context, written } = makeContext(globalArgs());
    let queried = false;
    context.queryData = () => {
      queried = true;
      return Promise.resolve([]);
    };
    // An empty id falls back to the latest inventory, of which there is none.
    await assertRejects(() =>
      model.methods.check.execute({ inventoryId: id }, context)
    );
    assertEquals(queried, false);
    assertNothingWritten(written);
  });
}

Deno.test("check on an inventory id nobody wrote fails, writing nothing", async () => {
  const { context, written } = makeContext(globalArgs());
  await assertRejects(
    () =>
      model.methods.check.execute(
        { inventoryId: "00000000-0000-4000-8000-000000000000" },
        context,
      ),
    Error,
    "has no inventory record",
  );
  assertNothingWritten(written);
});

Deno.test("check refuses a rule it does not know", async () => {
  const { context } = makeContext(globalArgs());
  await assertRejects(() =>
    model.methods.check.execute({ rules: ["no-such-rule" as never] }, context)
  );
});

Deno.test("check with failOnFindings records the result, then fails", async () => {
  await withGateway(undefined, async (g) => {
    const { context, written } = makeContext(g);
    await model.methods.inventory.execute({}, context);
    await assertRejects(
      () => model.methods.check.execute({ failOnFindings: true }, context),
      Error,
      "findings in inventory",
    );
    assertEquals(written.at(-1)!.spec, "check");
  });
});

Deno.test("check does not count records another inventory wrote", async () => {
  await withGateway(undefined, async (g) => {
    const shared: Written[] = [];
    const { context } = makeContext(g, shared);
    await model.methods.inventory.execute({}, context);
    // A stray record from elsewhere with no inventory tag, and one from a
    // different inventory: neither may appear in the findings.
    shared.push({
      spec: "account",
      name: "account-stray",
      data: {
        access: "stray",
        role: "admin",
        userId: 0,
        groupId: 0,
        projectId: 0,
      },
      tags: {},
    });
    shared.push({
      spec: "account",
      name: "account-other",
      data: {
        access: "other",
        role: "admin",
        userId: 0,
        groupId: 0,
        projectId: 0,
      },
      tags: { inventory: "00000000-0000-4000-8000-000000000000" },
    });
    await model.methods.check.execute({ rules: ["account-role"] }, context);
    const subjects = (shared.at(-1)!.data.findings as { subject: string }[])
      .map((f) => f.subject);
    assertEquals(subjects, ["idle", "ops"]);
  });
});

Deno.test("the root-key-named check accepts the pair as values and refuses half a pair", async () => {
  const check = model.checks["root-key-named"];
  assertEquals(
    await check.execute({
      globalArgs: globalArgs({
        rootAccessKey: ROOT_ACCESS,
        rootSecretKey: ROOT_SECRET,
      }),
    }),
    { pass: true },
  );
  const half = await check.execute({
    globalArgs: globalArgs({ rootSecretKey: ROOT_SECRET }),
  });
  assertEquals(half.pass, false);
  assertEquals(JSON.stringify(half).includes(ROOT_SECRET), false);
});

Deno.test("an inventory signed with the pair as values records neither value", async () => {
  const fake = installFetch();
  try {
    const { context, written, logs } = makeContext(
      globalArgs({ rootAccessKey: ROOT_ACCESS, rootSecretKey: ROOT_SECRET }),
    );
    await model.methods.inventory.execute({}, context);
    assertEquals(fake.seen.filter((s) => !s.signed).length, 1, "only /health");
    const all = JSON.stringify({ written, logs });
    assertEquals(all.includes(ROOT_SECRET), false);
    assertEquals(all.includes(`"${ROOT_ACCESS}"`), false);
  } finally {
    fake.restore();
  }
});

Deno.test("both values are marked sensitive in the schema", () => {
  const shape = GlobalArgsSchema.shape;
  for (const field of [shape.rootAccessKey, shape.rootSecretKey]) {
    assertEquals(field.meta()?.sensitive, true);
  }
});
