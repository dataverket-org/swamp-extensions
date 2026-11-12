import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import type { Json } from "./api.ts";
import { durationSeconds, model } from "./settings.ts";
import { assertNoPlanted, fail, harness } from "./test_support.ts";

Deno.test("read is a list method, so it needs no vault and mutates nothing", () => {
  assertEquals(model.methods.read.kind, "list");
});

Deno.test("durationSeconds reads a protobuf duration and nothing else", () => {
  assertEquals(durationSeconds("43200s"), 43200);
  assertEquals(durationSeconds("0.5s"), 0.5);
  assertEquals(durationSeconds("12h"), undefined);
  assertEquals(durationSeconds(undefined), undefined);
  assertEquals(durationSeconds(43200), undefined);
});

Deno.test("secretGeneratorSet reads the arguments as the CLI gives them", () => {
  const parsed = model.methods.secretGeneratorSet.arguments.parse({
    generator: "passwordlessInitCode",
    expirySeconds: "172800",
  });
  assertEquals(parsed.expirySeconds, 172800);
  assertEquals(parsed.length, undefined);
  assert(
    !model.methods.secretGeneratorSet.arguments.safeParse({
      generator: "passwordlessInitCode",
      expirySeconds: "-1",
    }).success,
  );
  assert(
    !model.methods.secretGeneratorSet.arguments.safeParse({
      generator: "somethingElse",
      expirySeconds: "60",
    }).success,
  );
});

const m = model.methods;
const KIND_PATHS = [
  "/settings/login",
  "/settings/lockout",
  "/settings/password/complexity",
  "/settings/password/expiry",
  "/settings/branding",
  "/settings/domain",
  "/settings/legal_support",
  "/settings/security",
  "/settings",
];

function kindRoutes(query: string): Record<string, Json> {
  const routes: Record<string, Json> = {};
  for (const path of KIND_PATHS) {
    routes[`GET /v2${path}${query}`] = { settings: {} };
  }
  routes[`GET /v2/settings/login/idps${query}`] = {
    identityProviders: [{ id: "i1", name: "google" }],
  };
  return routes;
}

Deno.test("read stores each kind, the instance-wide settings and the IdPs", async () => {
  const h = harness({
    ...kindRoutes("?ctx.instance=true"),
    "POST /admin/v1/secretgenerators/_search": {
      result: [{
        generatorType: "SECRET_GENERATOR_TYPE_INIT_CODE",
        expiry: "60s",
      }],
    },
    "POST /admin/v1/email/_search": {
      result: [{ id: "e1", smtp: { host: "smtp.example.org" } }],
    },
    "GET /admin/v1/policies/notification": { policy: {} },
    "GET /admin/v1/settings/oidc": {
      settings: { refreshTokenExpiration: "7776000s" },
    },
  });
  await m.read.execute(m.read.arguments.parse({ instance: true }), h.context);
  const specs = h.written().map((w) => w.spec);
  assertEquals(specs.length, 14);
  assert(specs.includes("identity-provider"));
  const tokens = h.written().find((w) => w.spec === "oidc-tokens")!;
  assertEquals(tokens.data.refreshTokenSeconds, 7776000);
  const gen = h.written().find((w) => w.spec === "secret-generator")!;
  assertEquals(gen.data.generator, "initCode");
  assertNoPlanted(h);
});

Deno.test("read warns and goes on when the key may not read the instance", async () => {
  const h = harness({
    ...kindRoutes("?ctx.orgId=42"),
    "POST /admin/v1/secretgenerators/_search": fail(403),
  });
  await m.read.execute(m.read.arguments.parse({ orgId: "42" }), h.context);
  const specs = h.written().map((w) => w.spec);
  assert(!specs.includes("oidc-tokens"));
  assert(specs.includes("identity-provider"));
  assert(h.logs().some((l) => l.startsWith("warning: this key may not")));
});

Deno.test("read fails on any other API failure", async () => {
  const h = harness({ "GET /v2/settings/login": fail(500) });
  await assertRejects(
    () => m.read.execute(m.read.arguments.parse({}), h.context),
    Error,
    "HTTP 500",
  );
  assertEquals(h.written(), []);
});

const SECURITY_ARGS = {
  iframeEmbeddingEnabled: false,
  enableImpersonation: true,
};

Deno.test("securitySet writes and stores what is in force after", async () => {
  const h = harness({
    "PUT /v2/policies/security": {},
    "GET /v2/settings/security": { settings: { enableImpersonation: true } },
  });
  await m.securitySet.execute(
    m.securitySet.arguments.parse(SECURITY_ARGS),
    h.context,
  );
  assertEquals(h.calls[0].body, {
    embeddedIframe: { enabled: false, allowedOrigins: [] },
    enableImpersonation: true,
  });
  assertEquals(h.written()[0].data.action, "updated");
  assertEquals(h.written()[0].data.enableImpersonation, true);
});

Deno.test("securitySet reads 'No changes' as unchanged, and fails on others", async () => {
  const same = harness({
    "PUT /v2/policies/security": fail(400, "No changes"),
    "GET /v2/settings/security": { settings: {} },
  });
  await m.securitySet.execute(
    m.securitySet.arguments.parse(SECURITY_ARGS),
    same.context,
  );
  assertEquals(same.written()[0].data.action, "unchanged");
  const h = harness({ "PUT /v2/policies/security": fail(403) });
  await assertRejects(
    () =>
      m.securitySet.execute(
        m.securitySet.arguments.parse(SECURITY_ARGS),
        h.context,
      ),
    Error,
    "HTTP 403",
  );
  assertEquals(h.written(), []);
});

const GEN =
  "/admin/v1/secretgenerators/SECRET_GENERATOR_TYPE_PASSWORDLESS_INIT_CODE";

Deno.test("secretGeneratorSet changes only the expiry and keeps the character set", async () => {
  const current = {
    generatorType: "SECRET_GENERATOR_TYPE_PASSWORDLESS_INIT_CODE",
    length: 12,
    expiry: "3600s",
    includeDigits: true,
  };
  const h = harness({
    [`GET ${GEN}`]: [
      { secretGenerator: current },
      { secretGenerator: { ...current, expiry: "172800s" } },
    ],
    [`PUT ${GEN}`]: {},
  });
  await m.secretGeneratorSet.execute(
    m.secretGeneratorSet.arguments.parse({
      generator: "passwordlessInitCode",
      expirySeconds: "172800",
    }),
    h.context,
  );
  assertEquals(h.calls[1].body, {
    length: 12,
    expiry: "172800s",
    includeLowerLetters: false,
    includeUpperLetters: false,
    includeDigits: true,
    includeSymbols: false,
  });
  assertEquals(h.written()[0].data.expirySeconds, 172800);
  assertEquals(h.written()[0].data.action, "updated");
});

Deno.test("secretGeneratorSet refuses a call that changes nothing", async () => {
  const h = harness({});
  await assertRejects(
    () =>
      m.secretGeneratorSet.execute(
        m.secretGeneratorSet.arguments.parse({ generator: "initCode" }),
        h.context,
      ),
    Error,
    "give expirySeconds, length or both",
  );
  assertEquals(h.calls, []);
});

Deno.test("loginTranslationSet sets an organization's translations", async () => {
  const h = harness({ "PUT /v2/settings/hosted_login_translation": {} });
  await m.loginTranslationSet.execute(
    m.loginTranslationSet.arguments.parse({
      locale: "nb",
      translations: '{"common":{"back":"Tilbake"}}',
      orgId: "42",
    }),
    h.context,
  );
  assertEquals(h.calls[0].body, {
    locale: "nb",
    translations: { common: { back: "Tilbake" } },
    organizationId: "42",
  });
  assertEquals(h.written()[0].name, "login-translation-42-nb");
});

Deno.test("loginTranslationSet refuses invalid JSON and a missing scope", async () => {
  const h = harness({});
  await assertRejects(
    () =>
      m.loginTranslationSet.execute(
        m.loginTranslationSet.arguments.parse({
          locale: "nb",
          translations: "{",
          orgId: "42",
        }),
        h.context,
      ),
    Error,
    "not valid JSON",
  );
  await assertRejects(
    () =>
      m.loginTranslationSet.execute(
        m.loginTranslationSet.arguments.parse({
          locale: "nb",
          translations: "{}",
        }),
        h.context,
      ),
    Error,
    "name the organization",
  );
  assertEquals(h.calls, []);
});
