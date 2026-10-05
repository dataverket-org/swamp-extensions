import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./app.ts";
import { API_APP, OIDC_APP, PROJECT } from "./fixtures.ts";
import { installFake, line, makeContext, page } from "./test_support.ts";
import { toBase64 } from "./api.ts";
import { shapeApp } from "./schema.ts";

const PROJECT_SEARCH = "POST /management/v1/projects/_search";
const APP_SEARCH = `POST /management/v1/projects/${PROJECT.id}/apps/_search`;
const APP_GET = `GET /management/v1/projects/${PROJECT.id}/apps/${OIDC_APP.id}`;
const OIDC_CONFIG =
  `PUT /management/v1/projects/${PROJECT.id}/apps/${OIDC_APP.id}/oidc_config`;

Deno.test("list stores one resource per application, with the config filled in", async () => {
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) return page([OIDC_APP, API_APP]);
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({ project: "fabrikk" }, context);
    // Keyed by the project's name, not its id, so a workflow can name it
    assertEquals(written.map((w) => w.name), [
      "app-fabrikk-kubelogin",
      "app-fabrikk-fabrikk-api",
    ]);
    assertEquals(written[0].data.kind, "oidc");
    assertEquals(written[0].data.appType, "native");
    assertEquals(written[0].data.accessTokenType, "bearer");
    assertEquals(written[1].data.kind, "api");
  } finally {
    fake.restore();
  }
});

Deno.test("ensureOidc treats Zitadel's 'No changes' as idempotent", async () => {
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) return page([OIDC_APP]);
    if (line(call) === OIDC_CONFIG) {
      return { status: 400, body: { message: "No changes" } };
    }
    if (line(call) === APP_GET) return { app: OIDC_APP };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.ensureOidc.execute({
      project: "fabrikk",
      name: "kubelogin",
      redirectUris: ["http://localhost:8000"],
      postLogoutUris: [],
      appType: "native",
      authMethod: "none",
      grantTypes: ["authorization_code"],
      responseTypes: ["code"],
      accessTokenType: "bearer",
      devMode: false,
      idTokenRoleAssertion: false,
      accessTokenRoleAssertion: false,
      idTokenUserinfoAssertion: false,
      loginVersion: "instance",
      loginBaseUri: undefined,
    }, context);
    assertEquals(written.map((w) => w.spec), ["app", "app-credential"]);
    assertEquals(written[0].data.action, "unchanged");
    assertEquals(written[1].data.clientSecret, undefined);
  } finally {
    fake.restore();
  }
});

Deno.test("ensureOidc stores the client secret once, on create", async () => {
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) return page([]);
    if (line(call) === `POST /management/v1/projects/${PROJECT.id}/apps/oidc`) {
      return {
        appId: OIDC_APP.id,
        clientId: "client",
        clientSecret: "once-only",
      };
    }
    if (line(call) === APP_GET) return { app: OIDC_APP };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.ensureOidc.execute({
      project: "fabrikk",
      name: "kubelogin",
      redirectUris: ["http://localhost:8000"],
      postLogoutUris: [],
      appType: "web",
      authMethod: "basic",
      grantTypes: ["authorization_code", "refresh_token"],
      responseTypes: ["code"],
      accessTokenType: "bearer",
      devMode: false,
      idTokenRoleAssertion: false,
      accessTokenRoleAssertion: false,
      idTokenUserinfoAssertion: false,
      loginVersion: "instance",
      loginBaseUri: undefined,
    }, context);
    const credential = written.find((w) => w.spec === "app-credential");
    assertEquals(credential?.data.clientSecret, "once-only");
    assertEquals(credential?.data.action, "created");
  } finally {
    fake.restore();
  }
});

Deno.test("redirectSet changes the allowlist and carries the rest over", async () => {
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) return page([OIDC_APP]);
    if (line(call) === OIDC_CONFIG) return {};
    if (line(call) === APP_GET) {
      return {
        app: {
          ...OIDC_APP,
          oidcConfig: {
            ...(OIDC_APP.oidcConfig as Record<string, unknown>),
            redirectUris: ["http://localhost:18000"],
          },
        },
      };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.redirectSet.execute({
      project: "fabrikk",
      app: "kubelogin",
      add: ["http://localhost:18000"],
      remove: ["http://localhost:8000"],
    }, context);
    const put = fake.calls.find((call) => line(call) === OIDC_CONFIG);
    const body = put?.body as Record<string, unknown>;
    assertEquals(body.redirectUris, ["http://localhost:18000"]);
    assertEquals(body.authMethodType, "OIDC_AUTH_METHOD_TYPE_NONE");
    assertEquals(body.appType, "OIDC_APP_TYPE_NATIVE");
    assertEquals(written[0].data.added, ["http://localhost:18000"]);
    assertEquals(written[0].data.removed, ["http://localhost:8000"]);
  } finally {
    fake.restore();
  }
});

Deno.test("redirectSet does nothing when the allowlist already reads that way", async () => {
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) return page([OIDC_APP]);
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.redirectSet.execute({
      project: "fabrikk",
      app: "kubelogin",
      add: ["http://localhost:8000"],
      remove: [],
    }, context);
    assertEquals(written[0].data.action, "unchanged");
    assert(fake.calls.every((call) => call.method !== "PUT"));
  } finally {
    fake.restore();
  }
});

Deno.test("delete refuses a confirm that is not the live name", async () => {
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) return page([OIDC_APP]);
    return undefined;
  });
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.delete.execute({
          project: "fabrikk",
          app: "kubelogin",
          confirm: "kubelogon",
          dryRun: false,
        }, context),
      Error,
      "refusing to delete",
    );
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

Deno.test("keyCreate decodes the key JSON and stores it once", async () => {
  const keyJson = '{"type":"application","keyId":"7"}';
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) return page([API_APP]);
    if (
      line(call) ===
        `POST /management/v1/projects/${PROJECT.id}/apps/${API_APP.id}/keys`
    ) return { id: "7", keyDetails: toBase64(keyJson) };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.keyCreate.execute(
      { project: "fabrikk", app: "fabrikk-api", expirationDate: undefined },
      context,
    );
    assertEquals(written[0].spec, "app-key");
    assertEquals(written[0].data.keyJson, keyJson);
    assertEquals(written[0].data.keyId, "7");
  } finally {
    fake.restore();
  }
});

Deno.test("keyDelete does nothing for a key this application does not have", async () => {
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) return page([API_APP]);
    if (
      line(call) ===
        `POST /management/v1/projects/${PROJECT.id}/apps/${API_APP.id}/keys/_search`
    ) return page([{ id: "7" }]);
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.keyDelete.execute({
      project: "fabrikk",
      app: "fabrikk-api",
      keyId: "9",
      dryRun: false,
    }, context);
    assertEquals(written[0].data.action, "unchanged");
    assert(fake.calls.every((call) => call.method !== "DELETE"));
  } finally {
    fake.restore();
  }
});

Deno.test("secretRotate refuses an application that has no secret to rotate", async () => {
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) {
      return page([{ id: "1", name: "saml", samlConfig: {} }]);
    }
    return undefined;
  });
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.secretRotate.execute(
          { project: "fabrikk", app: "saml" },
          context,
        ),
      Error,
      "neither an OIDC nor an API application",
    );
  } finally {
    fake.restore();
  }
});

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

const OIDC_CREATE = `POST /management/v1/projects/${PROJECT.id}/apps/oidc`;

/** The kubelogin client as decision 015 wants it: roles in the ID token, v2 login UI. */
function ensureKubelogin(
  overrides: Record<string, unknown> = {},
) {
  return {
    project: "fabrikk",
    name: "kubelogin",
    redirectUris: ["http://localhost:8000"],
    postLogoutUris: [],
    appType: "native" as const,
    authMethod: "none" as const,
    grantTypes: ["authorization_code" as const],
    responseTypes: ["code" as const],
    accessTokenType: "bearer" as const,
    devMode: false,
    idTokenRoleAssertion: true,
    accessTokenRoleAssertion: false,
    idTokenUserinfoAssertion: false,
    loginVersion: "v2" as const,
    loginBaseUri: undefined,
    ...overrides,
  };
}

Deno.test("ensureOidc sends the role assertion and the login UI it was given", async () => {
  let body: Record<string, unknown> | undefined;
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) return page([]);
    if (line(call) === OIDC_CREATE) {
      body = call.body as Record<string, unknown>;
      return { appId: OIDC_APP.id, clientId: "client" };
    }
    if (line(call) === APP_GET) return { app: OIDC_APP };
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.ensureOidc.execute(
      ensureKubelogin({ loginBaseUri: "https://login.example.org" }),
      context,
    );
    assertEquals(body?.idTokenRoleAssertion, true);
    assertEquals(body?.accessTokenRoleAssertion, false);
    assertEquals(body?.loginVersion, {
      loginV2: { baseUri: "https://login.example.org" },
    });
  } finally {
    fake.restore();
  }
});

Deno.test("ensureOidc with the instance's login UI sends no loginVersion at all", async () => {
  const bodies: Record<string, unknown>[] = [];
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) return page([]);
    if (line(call) === OIDC_CREATE) {
      bodies.push(call.body as Record<string, unknown>);
      return { appId: OIDC_APP.id, clientId: "client" };
    }
    if (line(call) === APP_GET) return { app: OIDC_APP };
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.ensureOidc.execute(
      ensureKubelogin({ loginVersion: "instance" }),
      context,
    );
    await model.methods.ensureOidc.execute(
      ensureKubelogin({ loginVersion: "v1" }),
      context,
    );
    assertEquals(bodies.length, 2);
    assert(!("loginVersion" in bodies[0]));
    assertEquals(bodies[1].loginVersion, { loginV1: {} });
  } finally {
    fake.restore();
  }
});

Deno.test("a login base URI without the v2 login UI is refused before any call", async () => {
  const fake = installFake(() => undefined);
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.ensureOidc.execute(
          ensureKubelogin({
            loginVersion: "instance",
            loginBaseUri: "https://login.example.org",
          }),
          context,
        ),
      Error,
      "loginBaseUri needs loginVersion v2",
    );
    assertEquals(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

Deno.test("redirectSet carries the role assertions and the login UI over", async () => {
  const configured = {
    ...OIDC_APP,
    oidcConfig: {
      ...(OIDC_APP.oidcConfig as Record<string, unknown>),
      idTokenRoleAssertion: true,
      accessTokenRoleAssertion: true,
      loginVersion: { loginV2: { baseUri: "https://login.example.org" } },
    },
  };
  let body: Record<string, unknown> | undefined;
  const fake = installFake((call) => {
    if (line(call) === PROJECT_SEARCH) return page([PROJECT]);
    if (line(call) === APP_SEARCH) return page([configured]);
    if (line(call) === OIDC_CONFIG) {
      body = call.body as Record<string, unknown>;
      return {};
    }
    if (line(call) === APP_GET) return { app: configured };
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.redirectSet.execute({
      project: "fabrikk",
      app: "kubelogin",
      add: ["http://localhost:18000"],
      remove: [],
    }, context);
    assertEquals(body?.idTokenRoleAssertion, true);
    assertEquals(body?.accessTokenRoleAssertion, true);
    assertEquals(body?.loginVersion, {
      loginV2: { baseUri: "https://login.example.org" },
    });
  } finally {
    fake.restore();
  }
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
