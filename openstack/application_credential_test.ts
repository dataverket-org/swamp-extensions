import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  model,
  normalizeApplicationCredential,
} from "./application_credential.ts";
import { APPCRED_SHOW } from "./fixtures.ts";
import { fail, type Harness, NOT_FOUND, withStub } from "./test_support.ts";

const ID = APPCRED_SHOW.ID;

Deno.test("normalizeApplicationCredential reads the capitalised identity columns", () => {
  const c = normalizeApplicationCredential(APPCRED_SHOW);
  assertEquals(c.id, ID);
  assertEquals(c.name, "swamp");
  assertEquals(c.roles, ["reader", "member"]);
  assertEquals(c.unrestricted, false);
  assertEquals(c.expiresAt, "");
  assertEquals(c.accessRules, "");
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;
const NAME = "appcred-swamp";
const SECRET = "TEST-SECRET-0123456789abcdef";

/**
 * Everything the method logged, message and properties, as one string:
 * the test context keeps the properties, the harness shows only messages.
 */
function logText(h: Harness): () => string {
  const seen: unknown[] = [];
  const logger = h.context.logger;
  for (const level of ["debug", "info", "warning"] as const) {
    const inner = logger[level].bind(logger);
    logger[level] = (message: string, props?: Record<string, unknown>) => {
      seen.push([message, props]);
      inner(message, props);
    };
  }
  return () => JSON.stringify(seen);
}

Deno.test("list shows each credential and writes one record each", () =>
  withStub([
    ["application credential list -c ID", { json: [{ ID }] }],
    [`application credential show ${ID}`, { json: APPCRED_SHOW }],
  ], async (h) => {
    await M.list.execute({}, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.roles]), [[
      "applicationCredential",
      NAME,
      ["reader", "member"],
    ]]);
    assertEquals(
      h.logs().at(-1)?.message,
      "stored {count} application credentials",
    );
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([
    ["application credential list", fail("Unauthorized (HTTP 401)")],
  ], async (h) => {
    await assertRejects(
      () => M.list.execute({}, h.context),
      Error,
      "application credential list failed (exit 1)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the credential it reads, never a secret", () =>
  withStub([
    ["application credential show swamp", { json: APPCRED_SHOW }],
  ], async (h) => {
    await M.get.execute({ applicationCredential: "swamp" }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.id]), [[
      "applicationCredential",
      NAME,
      ID,
    ]]);
  }));

Deno.test("get fails on output without an ID, and writes nothing", () =>
  withStub([
    ["application credential show swamp", { json: { Name: "swamp" } }],
  ], async (h) => {
    await assertRejects(
      () => M.get.execute({ applicationCredential: "swamp" }, h.context),
      Error,
      "returned no ID",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create stores the credential and its secret, and logs no secret", () =>
  withStub([
    ["application credential show swamp", NOT_FOUND],
    [
      "application credential create --role reader --expiration 2027-01-01T00:00:00 --restricted swamp",
      { json: { ...APPCRED_SHOW, Secret: SECRET } },
    ],
    [`application credential show ${ID}`, { json: APPCRED_SHOW }],
  ], async (h) => {
    const logs = logText(h);
    await M.create.execute({
      name: "swamp",
      roles: ["reader"],
      expiration: "2027-01-01T00:00:00",
      unrestricted: false,
    }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name]), [
      ["applicationCredential", NAME],
      ["secret", "secret-swamp"],
    ]);
    assertEquals(h.written()[1].data, {
      name: "swamp",
      id: ID,
      secret: SECRET,
    });
    assertEquals(JSON.stringify(h.written()[0].data).includes(SECRET), false);
    assertStringIncludes(logs(), "creating application credential {name}");
    assertEquals(logs().includes(SECRET), false);
    assertEquals(
      h.logs().at(-1)?.message,
      "stored the secret of application credential {name}",
    );
  }));

Deno.test("create reuses an existing name with a warning and no secret", () =>
  withStub([
    ["application credential show swamp", { json: APPCRED_SHOW }],
  ], async (h) => {
    await M.create.execute({ name: "swamp", unrestricted: false }, h.context);
    assertEquals(h.written().map((w) => w.spec), ["applicationCredential"]);
    assertEquals(h.logs().filter((l) => l.level === "warning").length, 1);
  }));

Deno.test("create fails when the CLI prints no secret, and writes nothing", () =>
  withStub([
    ["application credential show swamp", NOT_FOUND],
    ["application credential create", { json: APPCRED_SHOW }],
  ], async (h) => {
    await assertRejects(
      () => M.create.execute({ name: "swamp", unrestricted: true }, h.context),
      Error,
      "returned no ID or Secret",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create fails when the re-read fails, and the error carries no secret", () =>
  withStub([
    ["application credential show swamp", NOT_FOUND],
    ["application credential create", {
      json: { ...APPCRED_SHOW, Secret: SECRET },
    }],
    [
      `application credential show ${ID}`,
      fail("Service Unavailable (HTTP 503)"),
    ],
  ], async (h) => {
    const logs = logText(h);
    const err = await assertRejects(
      () => M.create.execute({ name: "swamp", unrestricted: false }, h.context),
      Error,
    );
    assertStringIncludes(err.message, "HTTP 503");
    assertEquals(err.message.includes(SECRET), false);
    assertEquals(logs().includes(SECRET), false);
    assertEquals(h.written(), []);
  }));

Deno.test("delete deletes the credential and drops its record and secret", () =>
  withStub([
    ["application credential show swamp", { json: APPCRED_SHOW }],
    [`application credential delete ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.delete.execute({ applicationCredential: "swamp" }, h.context);
    assertEquals(h.deleted(), [NAME, "secret-swamp"]);
  }));

Deno.test("delete fails when Keystone refuses, and drops nothing", () =>
  withStub([
    ["application credential show swamp", { json: APPCRED_SHOW }],
    [
      "application credential delete",
      fail(
        "Using method 'delete' is not allowed for restricted application credentials (HTTP 403)",
      ),
    ],
  ], async (h) => {
    await assertRejects(
      () => M.delete.execute({ applicationCredential: "swamp" }, h.context),
      Error,
      "not allowed for restricted application credentials",
    );
    assertEquals(h.deleted(), []);
  }));
