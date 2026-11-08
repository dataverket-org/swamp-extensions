import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { durationSeconds, model } from "./settings.ts";
import {
  type FakeResponse,
  installFake,
  line,
  makeContext,
} from "./test_support.ts";

const KINDS = [
  "GET /v2/settings/login",
  "GET /v2/settings/lockout",
  "GET /v2/settings/password/complexity",
  "GET /v2/settings/password/expiry",
  "GET /v2/settings/branding",
  "GET /v2/settings/domain",
  "GET /v2/settings/legal_support",
  "GET /v2/settings/security",
  "GET /v2/settings",
  "GET /v2/settings/login/idps",
  "GET /admin/v1/settings/oidc",
  "POST /admin/v1/secretgenerators/_search",
];

const OIDC_TOKENS = {
  settings: {
    accessTokenLifetime: "43200s",
    idTokenLifetime: "43200s",
    refreshTokenIdleExpiration: "2592000s",
    refreshTokenExpiration: "7776000s",
  },
};

const PASSKEY_CODE = {
  generatorType: "SECRET_GENERATOR_TYPE_PASSWORDLESS_INIT_CODE",
  length: 12,
  expiry: "3600s",
  includeLowerLetters: true,
  includeUpperLetters: true,
  includeDigits: true,
};

/**
 * Answer every settings read with something shaped right. The v1 Admin reads
 * share one key, so a refusal given for the token lifetimes is given for the
 * secret generators too.
 */
/** An SMTP provider as /admin/v1/email/_search lists it; no password. */
const SMTP_PROVIDER = {
  id: "310000000000000001",
  state: "EMAIL_PROVIDER_STATE_ACTIVE",
  description: "Nordhost",
  smtp: {
    senderAddress: "noreply@example.org",
    senderName: "Example",
    tls: true,
    host: "mail.example.org:587",
    user: "noreply@example.org",
  },
};

function settingsFake(query: string, tokens: FakeResponse = OIDC_TOKENS) {
  return installFake((call) => {
    const path = line(call);
    if (path === "GET /admin/v1/settings/oidc") return tokens;
    if (path === "POST /admin/v1/secretgenerators/_search") {
      return tokens === OIDC_TOKENS ? { result: [PASSKEY_CODE] } : tokens;
    }
    if (path === "POST /admin/v1/email/_search") {
      return tokens === OIDC_TOKENS ? { result: [SMTP_PROVIDER] } : tokens;
    }
    if (path === "GET /admin/v1/policies/notification") {
      return tokens === OIDC_TOKENS
        ? { policy: { isDefault: true, passwordChange: true } }
        : tokens;
    }
    if (!path.startsWith("GET /v2/settings")) return undefined;
    if (!path.endsWith(query) && query !== "") return undefined;
    const bare = path.replace(query, "");
    if (bare === "GET /v2/settings/login") {
      return {
        settings: {
          allowUsernamePassword: true,
          forceMfa: false,
          resourceOwnerType: "RESOURCE_OWNER_TYPE_ORG",
          secondFactors: ["SECOND_FACTOR_TYPE_OTP"],
        },
      };
    }
    if (bare === "GET /v2/settings/security") {
      return {
        settings: {
          embeddedIframe: { enabled: false, allowedOrigins: [] },
          enableImpersonation: false,
        },
      };
    }
    if (bare === "GET /v2/settings/login/idps") {
      return {
        identityProviders: [{ id: "idp1", name: "Forgejo", type: "OIDC" }],
      };
    }
    if (bare === "GET /v2/settings") {
      return { defaultLanguage: "nb", supportedLanguages: ["nb", "en"] };
    }
    return { settings: { resourceOwnerType: "RESOURCE_OWNER_TYPE_INSTANCE" } };
  });
}

Deno.test("read fetches every settings kind in one run", async () => {
  const fake = settingsFake("");
  const { context, written } = makeContext();
  try {
    await model.methods.read.execute(
      { orgId: undefined, instance: false },
      context,
    );
    for (const kind of KINDS) {
      assert(
        fake.calls.some((call) => line(call) === kind),
        `${kind} was never read`,
      );
    }
    const login = written.find((w) => w.spec === "login");
    assertEquals(login?.data.scope, "org");
    assertEquals(login?.data.forceMfa, false);
    const provider = written.find((w) => w.spec === "identity-provider");
    assertEquals(provider?.data.name, "Forgejo");
  } finally {
    fake.restore();
  }
});

Deno.test("a setting inherited from the instance says so", async () => {
  const fake = settingsFake("");
  const { context, written } = makeContext();
  try {
    await model.methods.read.execute(
      { orgId: undefined, instance: false },
      context,
    );
    const lockout = written.find((w) => w.spec === "lockout");
    assertEquals(lockout?.data.scope, "instance");
  } finally {
    fake.restore();
  }
});

Deno.test("reading one organization scopes every call to it", async () => {
  const fake = settingsFake("?ctx.orgId=42");
  const { context } = makeContext();
  try {
    await model.methods.read.execute({ orgId: "42", instance: false }, context);
    const scoped = fake.calls.filter((call) =>
      !call.path.startsWith("/admin/")
    );
    assert(scoped.every((call) => call.path.includes("ctx.orgId=42")));
  } finally {
    fake.restore();
  }
});

Deno.test("reading the instance asks for the instance, not an organization", async () => {
  const fake = settingsFake("?ctx.instance=true");
  const { context } = makeContext();
  try {
    await model.methods.read.execute({ orgId: "42", instance: true }, context);
    const scoped = fake.calls.filter((call) =>
      !call.path.startsWith("/admin/")
    );
    assert(scoped.every((call) => call.path.includes("ctx.instance=true")));
    assert(fake.calls.every((call) => !call.path.includes("ctx.orgId")));
  } finally {
    fake.restore();
  }
});

Deno.test("read is a list method, so it needs no vault and mutates nothing", () => {
  assertEquals(model.methods.read.kind, "list");
});

Deno.test("translations that are not JSON are refused before the call", async () => {
  const fake = installFake(() => undefined);
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.loginTranslationSet.execute(
          {
            locale: "nb",
            translations: "not json",
            orgId: "42",
            instance: false,
          },
          context,
        ),
      Error,
      "not valid JSON",
    );
    assertEquals(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

Deno.test("translations need a scope to be set for", async () => {
  const fake = installFake(() => undefined);
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.loginTranslationSet.execute(
          {
            locale: "nb",
            translations: "{}",
            orgId: undefined,
            instance: false,
          },
          context,
        ),
      Error,
      "name the organization",
    );
    assertEquals(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

Deno.test("read stores the OIDC token lifetimes as Zitadel reports them and in seconds", async () => {
  const fake = settingsFake("?ctx.instance=true");
  const { context, written } = makeContext();
  try {
    await model.methods.read.execute(
      { orgId: undefined, instance: true },
      context,
    );
    const tokens = written.find((w) => w.spec === "oidc-tokens");
    assertEquals(tokens?.name, "oidc-tokens-instance");
    assertEquals(tokens?.data.scope, "instance");
    assertEquals(tokens?.data.refreshTokenExpiration, "7776000s");
    assertEquals(tokens?.data.refreshTokenSeconds, 7776000);
    assertEquals(tokens?.data.refreshTokenIdleSeconds, 2592000);
    assertEquals(tokens?.data.accessTokenSeconds, 43200);
    const code = written.find((w) => w.spec === "secret-generator");
    assertEquals(code?.name, "secret-generator-passwordlessinitcode");
    assertEquals(code?.data.generator, "passwordlessInitCode");
    assertEquals(code?.data.expirySeconds, 3600);
    assertEquals(code?.data.length, 12);
    assertEquals(code?.data.includeSymbols, false);
    assertEquals(code?.data.action, "observed");
    const mail = written.find((w) => w.spec === "email-provider");
    assertEquals(mail?.name, "email-provider-nordhost");
    assertEquals(mail?.data.kind, "smtp");
    assertEquals(mail?.data.state, "active");
    assertEquals(mail?.data.senderAddress, "noreply@example.org");
    assertEquals(mail?.data.host, "mail.example.org:587");
    assertEquals(mail?.data.tls, true);
    assertEquals(Object.keys(mail?.data ?? {}).includes("password"), false);
    const notify = written.find((w) => w.spec === "notification");
    assertEquals(notify?.name, "notification-instance");
    assertEquals(notify?.data.passwordChange, true);
    assertEquals(notify?.data.isDefault, true);
  } finally {
    fake.restore();
  }
});

Deno.test("a key that may not read the token lifetimes is warned, and the rest is still stored", async () => {
  const fake = settingsFake("", {
    status: 403,
    body: { message: "permission denied" },
  });
  const { context, written, logs } = makeContext();
  try {
    await model.methods.read.execute(
      { orgId: undefined, instance: false },
      context,
    );
    assertEquals(written.find((w) => w.spec === "oidc-tokens"), undefined);
    assertEquals(written.find((w) => w.spec === "secret-generator"), undefined);
    assertEquals(written.find((w) => w.spec === "email-provider"), undefined);
    assertEquals(written.find((w) => w.spec === "notification"), undefined);
    assert(written.some((w) => w.spec === "login"));
    assert(
      logs.some((l) =>
        l.startsWith("warning:") && l.includes("token lifetimes")
      ),
    );
  } finally {
    fake.restore();
  }
});

Deno.test("any other failure reading the token lifetimes fails the run", async () => {
  const fake = settingsFake("", { status: 500, body: { message: "boom" } });
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.read.execute(
          { orgId: undefined, instance: false },
          context,
        ),
      Error,
      "HTTP 500",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("durationSeconds reads a protobuf duration and nothing else", () => {
  assertEquals(durationSeconds("43200s"), 43200);
  assertEquals(durationSeconds("0.5s"), 0.5);
  assertEquals(durationSeconds("12h"), undefined);
  assertEquals(durationSeconds(undefined), undefined);
  assertEquals(durationSeconds(43200), undefined);
});

/** The passkey code generator, answering a read and taking a write. */
function generatorFake(
  onPut: (body: Record<string, unknown>) => FakeResponse,
) {
  const path =
    "/admin/v1/secretgenerators/SECRET_GENERATOR_TYPE_PASSWORDLESS_INIT_CODE";
  return installFake((call) => {
    if (line(call) === `GET ${path}`) return { secretGenerator: PASSKEY_CODE };
    if (line(call) === `PUT ${path}`) {
      return onPut(call.body as Record<string, unknown>);
    }
    return undefined;
  });
}

Deno.test("secretGeneratorSet changes the expiry and keeps the rest of the generator", async () => {
  let put: Record<string, unknown> | undefined;
  const fake = generatorFake((body) => {
    put = body;
    return { details: {} };
  });
  const { context, written } = makeContext();
  try {
    await model.methods.secretGeneratorSet.execute(
      { generator: "passwordlessInitCode", expirySeconds: 172800 },
      context,
    );
    assertEquals(put, {
      length: 12,
      expiry: "172800s",
      includeLowerLetters: true,
      includeUpperLetters: true,
      includeDigits: true,
      includeSymbols: false,
    });
    const record = written.find((w) => w.spec === "secret-generator");
    assertEquals(record?.name, "secret-generator-passwordlessinitcode");
    assertEquals(record?.data.action, "updated");
    assertEquals(record?.data.scope, "instance");
  } finally {
    fake.restore();
  }
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

Deno.test("secretGeneratorSet with nothing to set is refused before any call", async () => {
  const fake = installFake(() => undefined);
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.secretGeneratorSet.execute(
          { generator: "passwordlessInitCode" },
          context,
        ),
      Error,
      "expirySeconds",
    );
    assertEquals(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});

Deno.test("secretGeneratorSet reports a value already in force as unchanged", async () => {
  const fake = generatorFake(() => ({
    status: 400,
    body: { message: "No changes (COMMAND-m0o3f)" },
  }));
  const { context, written } = makeContext();
  try {
    await model.methods.secretGeneratorSet.execute(
      { generator: "passwordlessInitCode", expirySeconds: 3600 },
      context,
    );
    const record = written.find((w) => w.spec === "secret-generator");
    assertEquals(record?.data.action, "unchanged");
    assertEquals(record?.data.expirySeconds, 3600);
  } finally {
    fake.restore();
  }
});

Deno.test("secretGeneratorSet passes any other refusal on", async () => {
  const fake = generatorFake(() => ({
    status: 403,
    body: { message: "permission denied" },
  }));
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.secretGeneratorSet.execute(
          { generator: "passwordlessInitCode", length: 16 },
          context,
        ),
      Error,
      "HTTP 403",
    );
  } finally {
    fake.restore();
  }
});
