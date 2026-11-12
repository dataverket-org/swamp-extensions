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
import { parseXml, readRootKey } from "./transport.ts";
import {
  globalArgs,
  makeContext,
  ROOT_ACCESS,
  ROOT_SECRET,
  SECRET_MARK,
  type Written,
} from "./test_support.ts";

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

Deno.test("both values are marked sensitive in the schema", () => {
  const shape = GlobalArgsSchema.shape;
  for (const field of [shape.rootAccessKey, shape.rootSecretKey]) {
    assertEquals(field.meta()?.sensitive, true);
  }
});
