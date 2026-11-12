import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { toBase64 } from "./api.ts";
import { model } from "./user.ts";
import {
  assertNoPlanted,
  assertNotLogged,
  fail,
  harness,
  type Reply,
} from "./test_support.ts";

const M = model.methods;
const ORG_ME = { "GET /management/v1/orgs/me": { org: { id: "100" } } };
const MACHINE = {
  userId: "300",
  username: "ci-bot",
  state: "USER_STATE_ACTIVE",
  machine: { name: "CI bot", accessTokenType: "ACCESS_TOKEN_TYPE_BEARER" },
};
const HUMAN = {
  userId: "301",
  username: "kari",
  state: "USER_STATE_ACTIVE",
  human: {
    profile: { givenName: "Kari", familyName: "Nordmann" },
    email: { email: "kari@example.org" },
  },
};
const GET_MACHINE = { "GET /v2/users/300": { user: MACHINE } };
const GET_HUMAN = { "GET /v2/users/301": { user: HUMAN } };
const GONE = { "GET /v2/users/300": fail(500, "boom") };

/** Run one method with parsed arguments against the listed answers. */
async function run(
  method: keyof typeof M,
  args: Record<string, unknown>,
  routes: Record<string, Reply | Reply[]>,
) {
  using h = harness(routes);
  const m = M[method] as unknown as {
    arguments: { parse(v: unknown): unknown };
    execute(a: unknown, c: unknown): Promise<unknown>;
  };
  await m.execute(m.arguments.parse(args), h.context);
  return h;
}

/** Run one method and expect it to throw `text`, writing nothing. */
async function refuses(
  method: keyof typeof M,
  args: Record<string, unknown>,
  routes: Record<string, Reply | Reply[]>,
  text: string,
) {
  using h = harness(routes);
  const m = M[method] as unknown as {
    arguments: { parse(v: unknown): unknown };
    execute(a: unknown, c: unknown): Promise<unknown>;
  };
  await assertRejects(
    () => m.execute(m.arguments.parse(args), h.context),
    Error,
    text,
  );
  assertEquals(h.written(), []);
  assertNoPlanted(h);
  return h;
}

const changes = (h: ReturnType<typeof harness>) =>
  h.calls.filter((c) =>
    c.method !== "GET" && !/search$/.test(c.path) &&
    c.path !== "/v2/users"
  )
    .map((c) => `${c.method} ${c.path}`);

Deno.test("list stores each user of the organization, machines only", async () => {
  const h = await run("list", { type: "machine" }, {
    ...ORG_ME,
    "POST /v2/users": (c) => {
      const queries = (c.body as { queries: unknown[] }).queries;
      assertEquals(queries[1], { typeQuery: { type: "TYPE_MACHINE" } });
      return { result: [MACHINE] };
    },
  });
  const [w] = h.written();
  assertEquals([w.spec, w.name, w.data.type], [
    "user",
    "user-ci-bot",
    "machine",
  ]);
  assertNoPlanted(h);
});

Deno.test("list fails when the search fails", async () => {
  await refuses(
    "list",
    {},
    { ...ORG_ME, "POST /v2/users": fail(403) },
    "HTTP 403",
  );
});

Deno.test("get stores a user read by id", async () => {
  const h = await run("get", { user: "301" }, GET_HUMAN);
  const [w] = h.written();
  assertEquals([w.name, w.data.email, w.data.action], [
    "user-kari",
    "kari@example.org",
    "observed",
  ]);
});

Deno.test("get refuses a user that is not there", async () => {
  await refuses("get", { user: "999" }, {
    "GET /v2/users/999": fail(404, "not found"),
  }, 'no user "999"');
});

Deno.test("ensureMachine creates a missing machine user", async () => {
  const h = await run("ensureMachine", { username: "ci-bot", name: "CI bot" }, {
    ...ORG_ME,
    "POST /v2/users": { result: [] },
    "POST /v2/users/new": { id: "300" },
    ...GET_MACHINE,
  });
  assertEquals(changes(h), ["POST /v2/users/new"]);
  assertEquals(h.calls.find((c) => c.path === "/v2/users/new")?.body, {
    organizationId: "100",
    username: "ci-bot",
    machine: { name: "CI bot", accessTokenType: "ACCESS_TOKEN_TYPE_BEARER" },
  });
  assertEquals(h.written()[0].data.action, "created");
});

Deno.test("ensureMachine refuses a username held by a human", async () => {
  const h = await refuses("ensureMachine", { username: "kari", name: "x" }, {
    ...ORG_ME,
    "POST /v2/users": { result: [HUMAN] },
  }, "is not a machine user");
  assertEquals(changes(h), []);
});

Deno.test("ensureHuman converges a changed email on an existing human", async () => {
  const h = await run("ensureHuman", {
    username: "kari",
    email: "kari@new.example.org",
    givenName: "Kari",
    familyName: "Nordmann",
  }, {
    ...ORG_ME,
    "POST /v2/users": { result: [HUMAN] },
    "PATCH /v2/users/301": {},
    ...GET_HUMAN,
  });
  assertEquals(changes(h), ["PATCH /v2/users/301"]);
  assertEquals(h.written()[0].data.action, "updated");
});

Deno.test("ensureHuman refuses a username held by a machine", async () => {
  await refuses(
    "ensureHuman",
    {
      username: "ci-bot",
      email: "a@b",
      givenName: "A",
      familyName: "B",
    },
    { ...ORG_ME, "POST /v2/users": { result: [MACHINE] } },
    "not a human",
  );
});

Deno.test("update sends only what is given", async () => {
  const h = await run("update", { user: "300", description: "builds" }, {
    "GET /v2/users/300": { user: MACHINE },
    "PATCH /v2/users/300": (c) => {
      assertEquals(c.body, { machine: { description: "builds" } });
      return {};
    },
  });
  assertEquals(changes(h), ["PATCH /v2/users/300"]);
  assertEquals(h.written()[0].data.action, "updated");
});

Deno.test("update fails when the patch is refused", async () => {
  await refuses("update", { user: "300", name: "x" }, {
    ...GET_MACHINE,
    "PATCH /v2/users/300": fail(400, "invalid"),
  }, "HTTP 400");
});

Deno.test("setState locks an active user", async () => {
  const h = await run("setState", { user: "300", state: "locked" }, {
    ...GET_MACHINE,
    "POST /v2/users/300/lock": {},
  });
  assertEquals(changes(h), ["POST /v2/users/300/lock"]);
  const [w] = h.written();
  assertEquals([w.spec, w.name, w.data.previousState, w.data.action], [
    "state",
    "user-state-ci-bot",
    "active",
    "locked",
  ]);
});

Deno.test("setState fails when the state change is refused", async () => {
  await refuses("setState", { user: "300", state: "inactive" }, {
    ...GET_MACHINE,
    "POST /v2/users/300/deactivate": fail(412, "precondition"),
  }, "HTTP 412");
});

Deno.test("delete removes the user and tombstones its record", async () => {
  const h = await run("delete", { user: "300", confirm: "ci-bot" }, {
    ...GET_MACHINE,
    "DELETE /v2/users/300": {},
  });
  assertEquals(changes(h), ["DELETE /v2/users/300"]);
  assertEquals(h.forgotten, ["user-ci-bot"]);
  assertEquals(h.written()[0].data.deleted, true);
});

Deno.test("delete refuses a confirm that is not the live username", async () => {
  const h = await refuses(
    "delete",
    { user: "300", confirm: "other" },
    GET_MACHINE,
    "refusing to delete username",
  );
  assertEquals(changes(h), []);
});

Deno.test("patCreate stores the token once as a user credential", async () => {
  const h = await run("patCreate", {
    user: "300",
    expirationDate: "2027-01-01T00:00:00Z",
  }, {
    ...GET_MACHINE,
    "POST /v2/users/300/pats": { tokenId: "77", token: "minted-pat" },
  });
  const [w] = h.written();
  assertEquals([w.spec, w.name, w.data.secret], [
    "user-credential",
    "user-credential-ci-bot-pat-77",
    "minted-pat",
  ]);
  assertNotLogged(h, "minted-pat");
  assertNoPlanted(h);
});

Deno.test("patCreate fails when Zitadel refuses the token", async () => {
  await refuses("patCreate", { user: "300", expirationDate: "x" }, {
    ...GET_MACHINE,
    "POST /v2/users/300/pats": fail(400, "bad expiry"),
  }, "bad expiry");
});

Deno.test("patList stores each token by id, without a value", async () => {
  const h = await run("patList", { user: "300" }, {
    ...GET_MACHINE,
    "POST /v2/users/pats/search": { result: [{ id: "77" }] },
  });
  const [w] = h.written();
  assertEquals([w.spec, w.name, w.data.id], [
    "credential",
    "pat-ci-bot-77",
    "77",
  ]);
  assert(!("secret" in w.data));
});

Deno.test("patList fails when the user cannot be read", async () => {
  await refuses("patList", { user: "300" }, GONE, "HTTP 500");
});

Deno.test("patRevoke revokes a token the user holds", async () => {
  const h = await run("patRevoke", { user: "300", tokenId: "77" }, {
    ...GET_MACHINE,
    "POST /v2/users/pats/search": { result: [{ id: "77" }] },
    "DELETE /v2/users/300/pats/77": {},
  });
  assertEquals(changes(h), ["DELETE /v2/users/300/pats/77"]);
  assertEquals(h.forgotten, ["pat-ci-bot-77"]);
  assertEquals(h.written()[0].data.action, "revoked");
});

Deno.test("patRevoke leaves a token the user does not hold", async () => {
  const h = await run("patRevoke", { user: "300", tokenId: "78" }, {
    ...GET_MACHINE,
    "POST /v2/users/pats/search": { result: [{ id: "77" }] },
  });
  assertEquals(changes(h), []);
  assertEquals(h.written()[0].data.action, "unchanged");
  assert(h.logs().some((l) => l.startsWith("warning:")));
});

Deno.test("keyCreate stores the generated key JSON decoded", async () => {
  const h = await run("keyCreate", {
    user: "300",
    expirationDate: "2027-01-01T00:00:00Z",
  }, {
    ...GET_MACHINE,
    "POST /v2/users/300/keys": {
      keyId: "88",
      keyContent: toBase64('{"keyId":"88","key":"KEY-MATERIAL-88"}'),
    },
  });
  const [w] = h.written();
  assertEquals([w.name, w.data.secret], [
    "user-credential-ci-bot-key-88",
    '{"keyId":"88","key":"KEY-MATERIAL-88"}',
  ]);
  assertNotLogged(h, "KEY-MATERIAL-88");
});

Deno.test("keyCreate fails when Zitadel refuses the key", async () => {
  await refuses("keyCreate", { user: "300", expirationDate: "x" }, {
    ...GET_MACHINE,
    "POST /v2/users/300/keys": fail(400, "bad key"),
  }, "bad key");
});

Deno.test("keyList stores each key by id", async () => {
  const h = await run("keyList", { user: "300" }, {
    ...GET_MACHINE,
    "POST /v2/users/keys/search": { result: [{ id: "88" }, { id: "89" }] },
  });
  assertEquals(h.written().map((w) => w.name), [
    "key-ci-bot-88",
    "key-ci-bot-89",
  ]);
});

Deno.test("keyList fails when the search fails", async () => {
  await refuses("keyList", { user: "300" }, {
    ...GET_MACHINE,
    "POST /v2/users/keys/search": fail(403),
  }, "HTTP 403");
});

Deno.test("keyDelete deletes a key the user holds", async () => {
  const h = await run("keyDelete", { user: "300", keyId: "88" }, {
    ...GET_MACHINE,
    "POST /v2/users/keys/search": { result: [{ id: "88" }] },
    "DELETE /v2/users/300/keys/88": {},
  });
  assertEquals(changes(h), ["DELETE /v2/users/300/keys/88"]);
  assertEquals(h.forgotten, ["key-ci-bot-88"]);
});

Deno.test("keyDelete in a dry run plans and deletes nothing", async () => {
  const h = await run("keyDelete", { user: "300", keyId: "88", dryRun: true }, {
    ...GET_MACHINE,
    "POST /v2/users/keys/search": { result: [{ id: "88" }] },
  });
  assertEquals(changes(h), []);
  assertEquals(h.written()[0].data.action, "planned");
});

Deno.test("secretGenerate rotates an existing secret", async () => {
  const h = await run("secretGenerate", { user: "300" }, {
    "GET /v2/users/300": {
      user: { ...MACHINE, machine: { ...MACHINE.machine, hasSecret: true } },
    },
    "POST /v2/users/300/secret": { clientSecret: "new-secret" },
  });
  const [w] = h.written();
  assertEquals([w.name, w.data.secret, w.data.action], [
    "user-credential-ci-bot-secret",
    "new-secret",
    "rotated",
  ]);
  assertNotLogged(h, "new-secret");
});

Deno.test("secretGenerate fails when Zitadel refuses", async () => {
  await refuses("secretGenerate", { user: "300" }, {
    ...GET_MACHINE,
    "POST /v2/users/300/secret": fail(409, "conflict"),
  }, "HTTP 409");
});

Deno.test("secretRemove removes the client secret", async () => {
  const h = await run("secretRemove", { user: "300" }, {
    ...GET_MACHINE,
    "DELETE /v2/users/300/secret": {},
  });
  assertEquals(changes(h), ["DELETE /v2/users/300/secret"]);
  assertEquals(h.written()[0].data.deleted, true);
});

Deno.test("secretRemove in a dry run removes nothing", async () => {
  const h = await run(
    "secretRemove",
    { user: "300", dryRun: true },
    GET_MACHINE,
  );
  assertEquals(changes(h), []);
  assertEquals(h.written()[0].data.action, "planned");
});

Deno.test("metadataSet sends the value base64 and stores it plain", async () => {
  const h = await run(
    "metadataSet",
    { user: "300", key: "team", value: "ops" },
    {
      ...GET_MACHINE,
      "POST /v2/users/300/metadata": (c) => {
        assertEquals(c.body, {
          metadata: [{ key: "team", value: toBase64("ops") }],
        });
        return {};
      },
    },
  );
  const [w] = h.written();
  assertEquals([w.name, w.data.value], ["metadata-ci-bot-team", "ops"]);
});

Deno.test("metadataSet fails when Zitadel refuses", async () => {
  await refuses("metadataSet", { user: "300", key: "k", value: "v" }, {
    ...GET_MACHINE,
    "POST /v2/users/300/metadata": fail(400, "too long"),
  }, "too long");
});

Deno.test("metadataList decodes each value", async () => {
  const h = await run("metadataList", { user: "300" }, {
    ...GET_MACHINE,
    "POST /v2/users/300/metadata/search": {
      metadata: [{ key: "team", value: toBase64("ops") }],
    },
  });
  assertEquals(h.written()[0].data.value, "ops");
});

Deno.test("metadataList fails when the user cannot be read", async () => {
  await refuses("metadataList", { user: "300" }, GONE, "HTTP 500");
});

Deno.test("metadataDelete deletes the keys named", async () => {
  const h = await run("metadataDelete", { user: "300", keys: ["a", "b"] }, {
    ...GET_MACHINE,
    "DELETE /v2/users/300/metadata?keys=a&keys=b": {},
  });
  assertEquals(changes(h), ["DELETE /v2/users/300/metadata?keys=a&keys=b"]);
  assertEquals(h.written()[0].name, "metadata-deletion-ci-bot-a-b");
});

Deno.test("metadataDelete refuses an empty key list", async () => {
  await refuses(
    "metadataDelete",
    { user: "300", keys: [] },
    GET_MACHINE,
    "keys must not be empty",
  );
});

Deno.test("passwordResetLinkCreate stores the returned code", async () => {
  const h = await run("passwordResetLinkCreate", { user: "301" }, {
    ...GET_HUMAN,
    "POST /v2/users/301/password_reset": (c) => {
      assertEquals(c.body, { returnCode: {} });
      return { verificationCode: "CODE1" };
    },
  });
  const [w] = h.written();
  assertEquals([w.spec, w.data.verificationCode], ["password-reset", "CODE1"]);
  assertNotLogged(h, "CODE1");
});

Deno.test("passwordResetLinkCreate refuses a machine user", async () => {
  await refuses(
    "passwordResetLinkCreate",
    { user: "300" },
    GET_MACHINE,
    "machine user has no password",
  );
});

Deno.test("passkeyRegistrationLinkCreate mails a link with the template", async () => {
  const h = await run("passkeyRegistrationLinkCreate", {
    user: "301",
    delivery: "email",
    urlTemplate: "https://auth.example.org/x?code={{.Code}}",
  }, {
    ...GET_HUMAN,
    "POST /v2/users/301/passkeys/registration_link": (c) => {
      assertEquals(c.body, {
        sendLink: { urlTemplate: "https://auth.example.org/x?code={{.Code}}" },
      });
      return {};
    },
  });
  const [w] = h.written();
  assertEquals([w.spec, w.data.delivery, w.data.code], [
    "passkey-registration",
    "email",
    undefined,
  ]);
});

Deno.test("passkeyRegistrationLinkCreate returns a code, stored and not logged", async () => {
  const h = await run("passkeyRegistrationLinkCreate", { user: "301" }, {
    ...GET_HUMAN,
    "POST /v2/users/301/passkeys/registration_link": (c) => {
      assertEquals(c.body, { returnCode: {} });
      return { code: { id: "55", code: "PASSKEY-CODE-55" } };
    },
  });
  const [w] = h.written();
  assertEquals([w.spec, w.data.delivery, w.data.codeId, w.data.code], [
    "passkey-registration",
    "return",
    "55",
    "PASSKEY-CODE-55",
  ]);
  assertNotLogged(h, "PASSKEY-CODE-55");
});

Deno.test("passkeyRegistrationLinkCreate refuses a machine user", async () => {
  await refuses(
    "passkeyRegistrationLinkCreate",
    { user: "300" },
    GET_MACHINE,
    "machine user has no passkey",
  );
});

Deno.test("authFactorList stores factors and a summary per person", async () => {
  const h = await run("authFactorList", { user: "301" }, {
    ...GET_HUMAN,
    "POST /v2/users/301/authentication_factors/_search": {
      result: [{ otp: {}, state: "AUTH_FACTOR_STATE_READY" }],
    },
    "POST /v2/users/301/passkeys/_search": {
      result: [{ id: "p1", state: "AUTH_FACTOR_STATE_NOT_READY" }],
    },
  });
  const w = h.written();
  assertEquals(w.map((x) => x.name), [
    "auth-factor-kari-totp-one",
    "auth-factor-kari-passkey-p1",
    "auth-summary-kari",
  ]);
  assertEquals(w[1].data.state, "not-ready");
  assertEquals([w[2].data.totp, w[2].data.passkeys, w[2].data.mfa], [
    true,
    0,
    true,
  ]);
});

Deno.test("authFactorList fails when a factor search fails", async () => {
  await refuses("authFactorList", { user: "301" }, {
    ...GET_HUMAN,
    "POST /v2/users/301/authentication_factors/_search": fail(403),
  }, "HTTP 403");
});

Deno.test("authFactorRemove removes a TOTP the person has", async () => {
  const h = await run("authFactorRemove", { user: "301", type: "totp" }, {
    ...GET_HUMAN,
    "POST /v2/users/301/authentication_factors/_search": {
      result: [{ otp: {} }],
    },
    "DELETE /v2/users/301/totp": {},
  });
  assertEquals(changes(h), ["DELETE /v2/users/301/totp"]);
  assertEquals(h.forgotten, ["auth-factor-kari-totp-one"]);
});

Deno.test("authFactorRemove refuses a passkey without its id", async () => {
  await refuses(
    "authFactorRemove",
    { user: "301", type: "passkey" },
    GET_HUMAN,
    "needs its id",
  );
});

Deno.test("idpLinkList stores each link", async () => {
  const h = await run("idpLinkList", { user: "301" }, {
    ...GET_HUMAN,
    "POST /v2/users/301/links/_search": {
      result: [{ idpId: "500", userId: "ext-1", userName: "kari@idp" }],
    },
  });
  const [w] = h.written();
  assertEquals([w.name, w.data.externalUserId], ["idp-link-kari-500", "ext-1"]);
});

Deno.test("idpLinkList fails when the search fails", async () => {
  await refuses("idpLinkList", { user: "301" }, {
    ...GET_HUMAN,
    "POST /v2/users/301/links/_search": fail(403),
  }, "HTTP 403");
});

Deno.test("idpLinkRemove unlinks a verified link", async () => {
  const h = await run("idpLinkRemove", {
    user: "301",
    idpId: "500",
    externalUserId: "ext-1",
  }, {
    ...GET_HUMAN,
    "POST /v2/users/301/links/_search": {
      result: [{ idpId: "500", userId: "ext-1" }],
    },
    "DELETE /v2/users/301/links/500/ext-1": {},
  });
  assertEquals(changes(h), ["DELETE /v2/users/301/links/500/ext-1"]);
  assertEquals(h.forgotten, ["idp-link-kari-500"]);
});

Deno.test("idpLinkRemove leaves a link whose external id does not match", async () => {
  const h = await run("idpLinkRemove", {
    user: "301",
    idpId: "500",
    externalUserId: "someone-else",
  }, {
    ...GET_HUMAN,
    "POST /v2/users/301/links/_search": {
      result: [{ idpId: "500", userId: "ext-1" }],
    },
  });
  assertEquals(changes(h), []);
  assertEquals(h.written()[0].data.action, "unchanged");
});
