import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  buildEnv,
  CliError,
  describeAuth,
  isConflict,
  isNotFound,
  mapLimit,
  openstack,
  openstackJson,
  openstackVersion,
  redactSecret,
} from "./cli.ts";
import { fail, installFake, line, ok } from "./test_support.ts";

const base = { PATH: "/usr/bin", OS_CLOUD: "ambient", OS_PASSWORD: "hunter2" };

Deno.test("buildEnv passes the ambient environment through untouched when nothing explicit is set", () => {
  const env = buildEnv({ openstackPath: "openstack" }, base);
  assertEquals(env, base);
  assertEquals(describeAuth(env), 'cloud "ambient"');
});

Deno.test("buildEnv drops inherited OS_* variables and exports the named cloud", () => {
  const env = buildEnv({ cloud: "prod", openstackPath: "openstack" }, base);
  assertEquals(env, { PATH: "/usr/bin", OS_CLOUD: "prod" });
});

Deno.test("buildEnv keeps clouds.yaml location hints through the strip and honours cloudsFile", () => {
  const withHints = {
    ...base,
    OS_CLIENT_CONFIG_FILE: "/etc/x/clouds.yaml",
    OS_CLIENT_SECURE_FILE: "/etc/x/secure.yaml",
  };
  const kept = buildEnv(
    { cloud: "prod", openstackPath: "openstack" },
    withHints,
  );
  assertEquals(kept.OS_CLIENT_CONFIG_FILE, "/etc/x/clouds.yaml");
  assertEquals(kept.OS_CLIENT_SECURE_FILE, "/etc/x/secure.yaml");
  assertEquals(kept.OS_PASSWORD, undefined);
  const explicit = buildEnv({
    cloud: "prod",
    cloudsFile: "/repo/clouds.yaml",
    openstackPath: "openstack",
  }, withHints);
  assertEquals(explicit.OS_CLIENT_CONFIG_FILE, "/repo/clouds.yaml");
});

Deno.test("buildEnv exports an application credential as env overrides", () => {
  const env = buildEnv({
    cloud: "prod",
    applicationCredentialId: "abc",
    applicationCredentialSecret: "s3cret",
    region: "Oslo",
    interface: "public",
    openstackPath: "openstack",
  }, base);
  assertEquals(env.OS_CLOUD, "prod");
  assertEquals(env.OS_AUTH_TYPE, "v3applicationcredential");
  assertEquals(env.OS_IDENTITY_API_VERSION, "3");
  assertEquals(env.OS_APPLICATION_CREDENTIAL_ID, "abc");
  assertEquals(env.OS_APPLICATION_CREDENTIAL_SECRET, "s3cret");
  assertEquals(env.OS_REGION_NAME, "Oslo");
  assertEquals(env.OS_INTERFACE, "public");
  assertEquals(env.OS_PASSWORD, undefined);
  assertEquals(
    describeAuth(env),
    'cloud "prod" with v3applicationcredential override',
  );
});

Deno.test("describeAuth rejects an environment with no way to authenticate", () => {
  assertThrows(
    () => describeAuth({ PATH: "/usr/bin" }),
    Error,
    "no OpenStack authentication configured",
  );
});

Deno.test("redactSecret masks every occurrence and tolerates no secret", () => {
  assertEquals(
    redactSecret("a s3cret and s3cret", "s3cret"),
    "a [REDACTED] and [REDACTED]",
  );
  assertEquals(redactSecret("plain", undefined), "plain");
});

Deno.test("openstack appends nothing, openstackJson appends -f json and parses", async () => {
  const fake = installFake((args) => {
    if (line({ args, env: {} }) === "server list") return [{ ID: "x" }];
    if (args[0] === "--version") return ok("openstack 10.3.0\n");
    return undefined;
  });
  try {
    assertEquals(
      await openstackJson({ cloud: "e", openstackPath: "openstack" }, [
        "server",
        "list",
      ]),
      [{ ID: "x" }],
    );
    assertEquals(
      await openstack({ cloud: "e", openstackPath: "openstack" }, [
        "--version",
      ]),
      "openstack 10.3.0\n",
    );
    assertEquals(fake.calls[0].env.OS_CLOUD, "e");
  } finally {
    fake.restore();
  }
});

Deno.test("a non-zero exit becomes a CliError with redacted stderr", async () => {
  const fake = installFake(() =>
    fail("auth failed for secret s3cret (HTTP 401)")
  );
  try {
    const err = await assertRejects(
      () =>
        openstack({
          authUrl: "https://keystone.example.net/v3",
          applicationCredentialId: "id",
          applicationCredentialSecret: "s3cret",
          openstackPath: "openstack",
        }, ["server", "list"]),
      CliError,
      "openstack server list failed (exit 1)",
    );
    assert(!err.message.includes("s3cret"));
    assert(err.message.includes("[REDACTED]"));
  } finally {
    fake.restore();
  }
});

Deno.test("openstackJson rejects empty and malformed output", async () => {
  const fake = installFake((args) =>
    ok(args[0] === "empty" ? "" : "{not json")
  );
  try {
    await assertRejects(
      () =>
        openstackJson({ cloud: "e", openstackPath: "openstack" }, ["empty"]),
      Error,
      "printed no JSON output",
    );
    await assertRejects(
      () => openstackJson({ cloud: "e", openstackPath: "openstack" }, ["bad"]),
      Error,
      "unparseable JSON",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("openstackVersion runs without any authentication configured", async () => {
  const fake = installFake((args) =>
    args[0] === "--version" ? ok("openstack 10.3.0\n") : undefined
  );
  try {
    assertEquals(
      await openstackVersion({ openstackPath: "openstack" }),
      "openstack 10.3.0",
    );
    assertEquals(fake.calls[0].env.OS_CLOUD, undefined);
  } finally {
    fake.restore();
  }
});

Deno.test("isNotFound and isConflict classify CLI stderr", () => {
  const nf = new CliError(
    "x",
    1,
    "No server with a name or ID of 'web' exists.",
  );
  const conflict = new CliError(
    "x",
    1,
    "ConflictException: 409: Security group rule already exists.",
  );
  assert(isNotFound(nf));
  assert(!isConflict(nf));
  assert(isConflict(conflict));
  assert(!isNotFound(conflict));
  assert(!isNotFound(new Error("plain")));
});

Deno.test("mapLimit preserves order and never exceeds the limit", async () => {
  let inFlight = 0;
  let peak = 0;
  const out = await mapLimit([1, 2, 3, 4, 5], 2, async (n) => {
    inFlight++;
    peak = Math.max(peak, inFlight);
    await new Promise((r) => setTimeout(r, 5));
    inFlight--;
    return n * 10;
  });
  assertEquals(out, [10, 20, 30, 40, 50]);
  assertEquals(peak, 2);
  assertEquals(await mapLimit([], 4, () => Promise.resolve(1)), []);
});
