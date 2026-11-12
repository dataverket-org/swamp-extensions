import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./app.ts";
import { API_APP, OIDC_APP } from "./fixtures.ts";
import { AppCredential, AppKey, shapeApp } from "./schema.ts";
import type { ModelContext } from "./common.ts";
import { assertNoPlanted, fail, harness, type Reply } from "./test_support.ts";

Deno.test("an auth method Zitadel omitted reads as basic, for OIDC and API", () => {
  const oidc = shapeApp(
    "1",
    {
      id: "2",
      name: "web",
      oidcConfig: { clientId: "c" },
    },
    "observed",
    "t",
  );
  const api = shapeApp(
    "1",
    {
      id: "3",
      name: "api",
      apiConfig: { clientId: "c" },
    },
    "observed",
    "t",
  );
  assertEquals(oidc.authMethod, "basic");
  assertEquals(api.authMethod, "basic");
});

Deno.test("an auth method Zitadel did send is not replaced by the default", () => {
  const none = shapeApp(
    "1",
    {
      id: "2",
      name: "cli",
      oidcConfig: { authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE" },
    },
    "observed",
    "t",
  );
  const jwt = shapeApp(
    "1",
    {
      id: "3",
      name: "api",
      apiConfig: { authMethodType: "API_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT" },
    },
    "observed",
    "t",
  );
  assertEquals(none.authMethod, "none");
  assertEquals(jwt.authMethod, "jwt");
});

Deno.test("an application that is neither OIDC nor API gets no auth method", () => {
  const saml = shapeApp(
    "1",
    {
      id: "2",
      name: "saml",
      samlConfig: {},
    },
    "observed",
    "t",
  );
  const bare = shapeApp("1", { id: "3", name: "bare" }, "observed", "t");
  assertEquals(saml.authMethod, undefined);
  assertEquals(bare.authMethod, undefined);
});

Deno.test("the app record reads the assertions and the login UI, absent as off and instance", () => {
  const plain = shapeApp("p", OIDC_APP, "observed", "t");
  assertEquals(plain.idTokenRoleAssertion, false);
  assertEquals(plain.accessTokenRoleAssertion, false);
  assertEquals(plain.loginVersion, "instance");
  assertEquals(plain.loginBaseUri, undefined);
  const v2 = shapeApp(
    "p",
    {
      ...OIDC_APP,
      oidcConfig: {
        ...(OIDC_APP.oidcConfig as Record<string, unknown>),
        idTokenRoleAssertion: true,
        loginVersion: { loginV2: {} },
      },
    },
    "observed",
    "t",
  );
  assertEquals(v2.idTokenRoleAssertion, true);
  assertEquals(v2.loginVersion, "v2");
  assertEquals(v2.loginBaseUri, undefined);
  const v1 = shapeApp(
    "p",
    {
      ...OIDC_APP,
      oidcConfig: { loginVersion: { loginV1: {} } },
    },
    "observed",
    "t",
  );
  assertEquals(v1.loginVersion, "v1");
  const api = shapeApp("p", API_APP, "observed", "t");
  assertEquals(api.loginVersion, undefined);
  assertEquals(api.idTokenRoleAssertion, undefined);
});

// ---------------------------------------------------------------------------
// Methods, with a stub caller answering only the calls each test names.
// ---------------------------------------------------------------------------

type H = ReturnType<typeof harness>;
interface Method {
  arguments: { parse(value: unknown): unknown };
  // deno-lint-ignore no-explicit-any
  execute(args: any, context: ModelContext): Promise<unknown>;
}

/** Run a method with its arguments parsed as the CLI parses them. */
function run(method: Method, args: Record<string, unknown>, h: H) {
  return method.execute(method.arguments.parse(args), h.context);
}

const P = "/management/v1/projects/300";
const OIDC_ID = str(OIDC_APP.id);
const API_ID = str(API_APP.id);
const OIDC_PATH = `${P}/apps/${OIDC_ID}`;
const API_PATH = `${P}/apps/${API_ID}`;
const SECRET = "CLIENT-SECRET-only-in-the-credential";

function str(value: unknown): string {
  return String(value);
}

/** The project every test resolves by id. */
function routes(extra: Record<string, Reply | Reply[]>) {
  return {
    [`GET ${P}`]: { project: { id: "300", name: "fabrikk" } },
    ...extra,
  };
}

const m = model.methods;

Deno.test("app list stores each application under the project's name", async () => {
  using h = harness(routes({
    [`POST ${P}/apps/_search`]: { result: [OIDC_APP, API_APP] },
  }));
  await run(m.list, { project: "300" }, h);
  assertEquals(h.written().map((w) => w.name), [
    "app-fabrikk-kubelogin",
    "app-fabrikk-fabrikk-api",
  ]);
  assertEquals(h.written()[1].data.kind, "api");
  assertNoPlanted(h);
});

Deno.test("app list fails on a project that does not exist", async () => {
  using h = harness({ [`GET ${P}`]: fail(404, "Project not found") });
  await assertRejects(
    () => run(m.list, { project: "300" }, h),
    Error,
    "no project",
  );
  assertEquals(h.written(), []);
});

Deno.test("app get resolves the application by name and stores it", async () => {
  using h = harness(routes({
    [`POST ${P}/apps/_search`]: { result: [OIDC_APP] },
  }));
  await run(m.get, { project: "300", app: "kubelogin" }, h);
  const [w] = h.written();
  assertEquals([w.spec, w.data.appId, w.data.kind], ["app", OIDC_ID, "oidc"]);
});

Deno.test("app get fails on an application the project does not have", async () => {
  using h = harness(routes({ [`POST ${P}/apps/_search`]: { result: [] } }));
  await assertRejects(
    () => run(m.get, { project: "300", app: "nope" }, h),
    Error,
    "no application",
  );
  assertEquals(h.written(), []);
});

Deno.test("ensureOidc creates a client and keeps the secret in the credential only", async () => {
  using h = harness(routes({
    [`POST ${P}/apps/_search`]: { result: [] },
    [`POST ${P}/apps/oidc`]: {
      appId: OIDC_ID,
      clientId: "c1",
      clientSecret: SECRET,
    },
    [`GET ${OIDC_PATH}`]: { app: OIDC_APP },
  }));
  await run(m.ensureOidc, {
    project: "300",
    name: "kubelogin",
    redirectUris: ["http://localhost:8000"],
    authMethod: "none",
    loginVersion: "v2",
  }, h);
  const create = h.calls.find((c) => c.path === `${P}/apps/oidc`);
  const body = create?.body as Record<string, unknown>;
  assertEquals(body.authMethodType, "OIDC_AUTH_METHOD_TYPE_NONE");
  assertEquals(body.loginVersion, { loginV2: {} });
  const [app, cred] = h.written();
  assertEquals([app.spec, app.data.action], ["app", "created"]);
  assertEquals([cred.spec, cred.data.clientSecret], ["app-credential", SECRET]);
  assertEquals(AppCredential.shape.clientSecret.meta()?.sensitive, true);
  assert(!JSON.stringify(app.data).includes(SECRET));
  assert(!h.logs().join("\n").includes(SECRET));
  assertNoPlanted(h);
});

Deno.test("ensureOidc reads a 'No changes' answer as unchanged", async () => {
  using h = harness(routes({
    [`POST ${P}/apps/_search`]: { result: [OIDC_APP] },
    [`PUT ${OIDC_PATH}/oidc_config`]: fail(400, "No changes"),
    [`GET ${OIDC_PATH}`]: { app: OIDC_APP },
  }));
  await run(m.ensureOidc, { project: "300", name: "kubelogin" }, h);
  assertEquals(h.written().map((w) => w.data.action), [
    "unchanged",
    "unchanged",
  ]);
  assertEquals(h.written()[1].data.clientSecret, undefined);
});

Deno.test("ensureOidc refuses loginBaseUri without v2 before any call", async () => {
  using h = harness({});
  await assertRejects(
    () =>
      run(m.ensureOidc, {
        project: "300",
        name: "x",
        loginBaseUri: "https://login.example.org",
      }, h),
    Error,
    "needs loginVersion v2",
  );
  assertEquals(h.calls, []);
});

Deno.test("ensureOidc fails when the update is refused for another reason", async () => {
  using h = harness(routes({
    [`POST ${P}/apps/_search`]: { result: [OIDC_APP] },
    [`PUT ${OIDC_PATH}/oidc_config`]: fail(403, "permission denied"),
  }));
  await assertRejects(
    () => run(m.ensureOidc, { project: "300", name: "kubelogin" }, h),
    Error,
    "HTTP 403",
  );
  assertEquals(h.written(), []);
});

Deno.test("ensureApi creates an API application with the jwt method", async () => {
  using h = harness(routes({
    [`POST ${P}/apps/_search`]: { result: [] },
    [`POST ${P}/apps/api`]: { appId: API_ID, clientId: "c2" },
    [`GET ${API_PATH}`]: { app: API_APP },
  }));
  await run(m.ensureApi, { project: "300", name: "fabrikk-api" }, h);
  const create = h.calls.find((c) => c.path === `${P}/apps/api`);
  assertEquals(
    (create?.body as Record<string, unknown>).authMethodType,
    "API_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT",
  );
  assertEquals(h.written().map((w) => [w.spec, w.data.action]), [
    ["app", "created"],
    ["app-credential", "created"],
  ]);
});

Deno.test("ensureApi fails when the create is refused, and writes nothing", async () => {
  using h = harness(routes({
    [`POST ${P}/apps/_search`]: { result: [] },
    [`POST ${P}/apps/api`]: fail(409, "already exists"),
  }));
  await assertRejects(
    () => run(m.ensureApi, { project: "300", name: "fabrikk-api" }, h),
    Error,
    "HTTP 409",
  );
  assertEquals(h.written(), []);
});

Deno.test("redirectSet changes only the allowlist and carries the rest over", async () => {
  const after = {
    ...OIDC_APP,
    oidcConfig: {
      ...(OIDC_APP.oidcConfig as Record<string, unknown>),
      redirectUris: ["https://new.example.org/cb"],
    },
  };
  using h = harness(routes({
    [`GET ${OIDC_PATH}`]: [{ app: OIDC_APP }, { app: after }],
    [`PUT ${OIDC_PATH}/oidc_config`]: {},
  }));
  await run(m.redirectSet, {
    project: "300",
    app: OIDC_ID,
    add: ["https://new.example.org/cb"],
    remove: ["http://localhost:8000"],
  }, h);
  const put = h.calls.find((c) => c.method === "PUT");
  const body = put?.body as Record<string, unknown>;
  assertEquals(body.redirectUris, ["https://new.example.org/cb"]);
  assertEquals(body.authMethodType, "OIDC_AUTH_METHOD_TYPE_NONE");
  assertEquals(body.clientId, undefined);
  const [w] = h.written();
  assertEquals(w.data.added, ["https://new.example.org/cb"]);
  assertEquals(w.data.removed, ["http://localhost:8000"]);
  assertEquals(w.data.action, "updated");
});

Deno.test("redirectSet refuses an application that is not OIDC", async () => {
  using h = harness(routes({ [`GET ${API_PATH}`]: { app: API_APP } }));
  await assertRejects(
    () => run(m.redirectSet, { project: "300", app: API_ID, add: ["x"] }, h),
    Error,
    "not an OIDC application",
  );
  assertEquals(h.calls.filter((c) => c.method === "PUT"), []);
});

Deno.test("app update renames and stores the new name", async () => {
  using h = harness(routes({
    [`GET ${OIDC_PATH}`]: [{ app: OIDC_APP }, {
      app: { ...OIDC_APP, name: "kubectl" },
    }],
    [`PUT ${OIDC_PATH}`]: {},
  }));
  await run(m.update, { project: "300", app: OIDC_ID, name: "kubectl" }, h);
  assertEquals(h.calls.find((c) => c.method === "PUT")?.body, {
    name: "kubectl",
  });
  const [w] = h.written();
  assertEquals([w.name, w.data.action], ["app-fabrikk-kubectl", "updated"]);
});

Deno.test("app update fails when the rename is refused", async () => {
  using h = harness(routes({
    [`GET ${OIDC_PATH}`]: { app: OIDC_APP },
    [`PUT ${OIDC_PATH}`]: fail(400, "invalid name"),
  }));
  await assertRejects(
    () => run(m.update, { project: "300", app: OIDC_ID, name: "kubectl" }, h),
    Error,
    "HTTP 400",
  );
  assertEquals(h.written(), []);
});

Deno.test("app setState deactivates an active application", async () => {
  using h = harness(routes({
    [`GET ${OIDC_PATH}`]: { app: OIDC_APP },
    [`POST ${OIDC_PATH}/_deactivate`]: {},
  }));
  await run(m.setState, { project: "300", app: OIDC_ID, state: "inactive" }, h);
  const [w] = h.written();
  assertEquals(
    [w.spec, w.data.previousState, w.data.state, w.data.action],
    ["state", "active", "inactive", "deactivated"],
  );
});

Deno.test("app setState fails when the deactivation is refused", async () => {
  using h = harness(routes({
    [`GET ${OIDC_PATH}`]: { app: OIDC_APP },
    [`POST ${OIDC_PATH}/_deactivate`]: fail(403, "denied"),
  }));
  await assertRejects(
    () =>
      run(m.setState, { project: "300", app: OIDC_ID, state: "inactive" }, h),
    Error,
    "HTTP 403",
  );
  assertEquals(h.written(), []);
});

Deno.test("secretRotate keeps the new secret in the sensitive credential, out of the logs", async () => {
  using h = harness(routes({
    [`GET ${API_PATH}`]: { app: API_APP },
    [`POST ${API_PATH}/api_config/_generate_client_secret`]: {
      clientSecret: SECRET,
    },
  }));
  await run(m.secretRotate, { project: "300", app: API_ID }, h);
  const [w] = h.written();
  assertEquals([w.spec, w.data.action], ["app-credential", "rotated"]);
  assertEquals(w.data.clientSecret, SECRET);
  assertEquals(w.data.clientId, "400000000000000002@fabrikk");
  assertEquals(AppCredential.shape.clientSecret.meta()?.sensitive, true);
  assert(!h.logs().join("\n").includes(SECRET));
  assertNoPlanted(h);
});

Deno.test("secretRotate refuses an application that is neither OIDC nor API", async () => {
  using h = harness(routes({
    [`GET ${P}/apps/5`]: { app: { id: "5", name: "saml", samlConfig: {} } },
  }));
  await assertRejects(
    () => run(m.secretRotate, { project: "300", app: "5" }, h),
    Error,
    "neither an OIDC nor an API",
  );
  assertEquals(h.written(), []);
});

Deno.test("app delete removes the application and tombstones its record", async () => {
  using h = harness(routes({
    [`GET ${OIDC_PATH}`]: { app: OIDC_APP },
    [`DELETE ${OIDC_PATH}`]: {},
  }));
  await run(
    m.delete,
    { project: "300", app: OIDC_ID, confirm: "kubelogin" },
    h,
  );
  assertEquals(h.forgotten, ["app-fabrikk-kubelogin"]);
  const [w] = h.written();
  assertEquals([w.data.deleted, w.data.action], [true, "removed"]);
});

Deno.test("app delete refuses a confirm that is not the live name", async () => {
  using h = harness(routes({ [`GET ${OIDC_PATH}`]: { app: OIDC_APP } }));
  await assertRejects(
    () =>
      run(m.delete, { project: "300", app: OIDC_ID, confirm: "kubectl" }, h),
    Error,
    "refusing to delete",
  );
  assertEquals(h.calls.filter((c) => c.method === "DELETE"), []);
  assertEquals(h.written(), []);
});

Deno.test("app delete with dryRun plans and changes nothing", async () => {
  using h = harness(routes({ [`GET ${OIDC_PATH}`]: { app: OIDC_APP } }));
  await run(m.delete, {
    project: "300",
    app: OIDC_ID,
    confirm: "kubelogin",
    dryRun: true,
  }, h);
  assertEquals(h.calls.filter((c) => c.method === "DELETE"), []);
  assertEquals(h.written()[0].data.action, "planned");
  assertEquals(h.forgotten, []);
});

Deno.test("keyCreate keeps the key JSON in the sensitive key record, out of the logs", async () => {
  const keyJson = '{"type":"application","keyId":"k1","key":"PRIVATE"}';
  using h = harness(routes({
    [`GET ${API_PATH}`]: { app: API_APP },
    [`POST ${API_PATH}/keys`]: { id: "k1", keyDetails: btoa(keyJson) },
  }));
  await run(m.keyCreate, { project: "300", app: API_ID }, h);
  assertEquals(h.calls.at(-1)?.body, { type: "KEY_TYPE_JSON" });
  const [w] = h.written();
  assertEquals([w.spec, w.data.keyId, w.data.keyJson], [
    "app-key",
    "k1",
    keyJson,
  ]);
  assertEquals(AppKey.shape.keyJson.meta()?.sensitive, true);
  assert(!h.logs().join("\n").includes("PRIVATE"));
  assertNoPlanted(h);
});

Deno.test("keyCreate fails when the instance refuses the key", async () => {
  using h = harness(routes({
    [`GET ${API_PATH}`]: { app: API_APP },
    [`POST ${API_PATH}/keys`]: fail(400, "expiration in the past"),
  }));
  await assertRejects(
    () => run(m.keyCreate, { project: "300", app: API_ID }, h),
    Error,
    "HTTP 400",
  );
  assertEquals(h.written(), []);
});

Deno.test("keyList stores each key by id and expiry, with no material", async () => {
  using h = harness(routes({
    [`GET ${API_PATH}`]: { app: API_APP },
    [`POST ${API_PATH}/keys/_search`]: {
      result: [{ id: "k1", type: "KEY_TYPE_JSON", expirationDate: "2027" }],
    },
  }));
  await run(m.keyList, { project: "300", app: API_ID }, h);
  const [w] = h.written();
  assertEquals([w.name, w.data.type, w.data.keyJson], [
    "app-key-fabrikk-fabrikk-api-k1",
    "json",
    undefined,
  ]);
});

Deno.test("keyList fails when the key search is refused", async () => {
  using h = harness(routes({
    [`GET ${API_PATH}`]: { app: API_APP },
    [`POST ${API_PATH}/keys/_search`]: fail(403, "denied"),
  }));
  await assertRejects(
    () => run(m.keyList, { project: "300", app: API_ID }, h),
    Error,
    "HTTP 403",
  );
  assertEquals(h.written(), []);
});

Deno.test("keyDelete deletes a key that belongs to the application", async () => {
  using h = harness(routes({
    [`GET ${API_PATH}`]: { app: API_APP },
    [`POST ${API_PATH}/keys/_search`]: { result: [{ id: "k1" }] },
    [`DELETE ${API_PATH}/keys/k1`]: {},
  }));
  await run(m.keyDelete, { project: "300", app: API_ID, keyId: "k1" }, h);
  assertEquals(h.forgotten, ["app-key-fabrikk-fabrikk-api-k1"]);
  assertEquals(h.written()[0].data.action, "removed");
});

Deno.test("keyDelete never deletes a key the application does not hold", async () => {
  using h = harness(routes({
    [`GET ${API_PATH}`]: { app: API_APP },
    [`POST ${API_PATH}/keys/_search`]: { result: [{ id: "k1" }] },
  }));
  await run(m.keyDelete, { project: "300", app: API_ID, keyId: "k9" }, h);
  assertEquals(h.calls.filter((c) => c.method === "DELETE"), []);
  const [w] = h.written();
  assertEquals([w.data.deleted, w.data.action], [false, "unchanged"]);
  assert(h.logs().some((l) => l.startsWith("warning: no key")));
});
