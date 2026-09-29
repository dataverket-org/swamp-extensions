import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./settings.ts";
import { installFake, line, makeContext } from "./test_support.ts";

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
];

/** Answer every settings read with something shaped right. */
function settingsFake(query: string) {
  return installFake((call) => {
    const path = line(call);
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
    assert(fake.calls.every((call) => call.path.includes("ctx.orgId=42")));
  } finally {
    fake.restore();
  }
});

Deno.test("reading the instance asks for the instance, not an organization", async () => {
  const fake = settingsFake("?ctx.instance=true");
  const { context } = makeContext();
  try {
    await model.methods.read.execute({ orgId: "42", instance: true }, context);
    assert(fake.calls.every((call) => call.path.includes("ctx.instance=true")));
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
