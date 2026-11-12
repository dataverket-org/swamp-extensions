import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./system.ts";
import { assertNoPlanted, fail, harness } from "./test_support.ts";

const SYS = {
  systemUser: "swamp",
  systemKeyFile: "/nonexistent/system.pem",
  keyJson: undefined,
};
const ONE = {
  instanceId: "300",
};
const SEARCH = "POST /system/v1/instances/_search";
const DOMAINS = "POST /system/v1/instances/300/domains/_search";
const LIVE_DOMAINS = {
  result: [
    { domain: "gen.zitadel.cloud", primary: false, generated: true },
    { domain: "id.example.org", primary: true, generated: false },
    { domain: "old.example.org", primary: false, generated: false },
  ],
};
const m = model.methods;

Deno.test("instanceList stores each instance with its friendly state", async () => {
  using h = harness({
    [SEARCH]: {
      result: [
        { id: "300", name: "prod", state: "INSTANCE_STATE_RUNNING" },
        { id: "301", name: "dev", version: "v4.2.0" },
      ],
    },
  }, SYS);
  await m.instanceList.execute({}, h.context);
  const w = h.written();
  assertEquals(w.map((r) => r.name), ["instance-300", "instance-301"]);
  assertEquals(w[0].data.state, "running");
  assertEquals(w[1].data.version, "v4.2.0");
  assertNoPlanted(h);
});

Deno.test("instanceList fails on a refused key and writes nothing", async () => {
  using h = harness({ [SEARCH]: fail(401, "invalid signature") }, SYS);
  await assertRejects(
    () => m.instanceList.execute({}, h.context),
    Error,
    "HTTP 401",
  );
  assertEquals(h.written(), []);
});

Deno.test("instanceCreate emits the owner's token once, into the owner spec only", async () => {
  const pat = "PAT-SECRET-OWNER-0042";
  using h = harness({
    [SEARCH]: { result: [] },
    "POST /system/v1/instances/_create": { instanceId: "302", pat },
  }, SYS);
  const args = m.instanceCreate.arguments.parse({
    name: "staging",
    customDomain: "id.staging.example.org",
    expirationDate: "2027-01-01T00:00:00Z",
  });
  await m.instanceCreate.execute(args, h.context);
  const create = h.calls.find((c) => c.path.endsWith("/_create"));
  assertEquals(create?.body, {
    instanceName: "staging",
    customDomain: "id.staging.example.org",
    machine: {
      userName: "admin",
      name: "admin",
      personalAccessToken: { expirationDate: "2027-01-01T00:00:00Z" },
    },
  });
  const [owner, instance] = h.written();
  assertEquals([owner.spec, owner.data.secret], ["instance-owner", pat]);
  assertEquals([instance.spec, instance.data.action], ["instance", "created"]);
  assert(!JSON.stringify(instance.data).includes(pat));
  assert(!h.logs().join("\n").includes(pat));
});

Deno.test("instanceCreate leaves an instance already named so, and mints nothing", async () => {
  using h = harness({
    [SEARCH]: { result: [{ id: "302", name: "staging" }] },
  }, SYS);
  await m.instanceCreate.execute(
    m.instanceCreate.arguments.parse({
      name: "staging",
      expirationDate: "2027-01-01T00:00:00Z",
    }),
    h.context,
  );
  assertEquals(h.calls.length, 1);
  assertEquals(h.written().map((w) => [w.spec, w.data.action]), [[
    "instance",
    "unchanged",
  ]]);
});

Deno.test("instanceCreate fails when Zitadel returns no credential, storing nothing", async () => {
  using h = harness({
    [SEARCH]: { result: [] },
    "POST /system/v1/instances/_create": { instanceId: "302" },
  }, SYS);
  await assertRejects(
    () =>
      m.instanceCreate.execute(
        m.instanceCreate.arguments.parse({
          name: "staging",
          ownerCredential: "key",
          expirationDate: "2027-01-01T00:00:00Z",
        }),
        h.context,
      ),
    Error,
    "returned no key",
  );
  assertEquals(h.written(), []);
});

Deno.test("domainList takes the one instance listed and stores its domains", async () => {
  using h = harness({
    [SEARCH]: { result: [{ id: "300", name: "prod" }] },
    [DOMAINS]: LIVE_DOMAINS,
  }, SYS);
  await m.domainList.execute({}, h.context);
  const w = h.written();
  assertEquals(w.map((r) => r.spec), [
    "instance-domain",
    "instance-domain",
    "instance-domain",
    "instance",
  ]);
  assertEquals(w[0].data.generated, true);
  assertEquals(w[1].data.primary, true);
});

Deno.test("domainList refuses to guess between two instances", async () => {
  using h = harness({
    [SEARCH]: { result: [{ id: "300" }, { id: "301" }] },
  }, SYS);
  await assertRejects(
    () => m.domainList.execute({}, h.context),
    Error,
    "name one with instanceId",
  );
  assertEquals(h.written(), []);
});

Deno.test("domainAdd adds a missing domain, not as primary", async () => {
  using h = harness({
    [DOMAINS]: LIVE_DOMAINS,
    "POST /system/v1/instances/300/domains": {},
  }, { ...SYS, ...ONE });
  await m.domainAdd.execute({ domain: " new.example.org " }, h.context);
  assertEquals(h.calls[1].body, { domain: "new.example.org" });
  const [w] = h.written();
  assertEquals([w.data.action, w.data.primary], ["created", false]);
});

Deno.test("domainAdd fails when the System API refuses, and writes nothing", async () => {
  using h = harness({
    [DOMAINS]: LIVE_DOMAINS,
    "POST /system/v1/instances/300/domains": fail(403, "no permission"),
  }, { ...SYS, ...ONE });
  await assertRejects(
    () => m.domainAdd.execute({ domain: "new.example.org" }, h.context),
    Error,
    "HTTP 403",
  );
  assertEquals(h.written(), []);
});

Deno.test("domainRemove removes a confirmed custom domain and tombstones it", async () => {
  using h = harness({
    [DOMAINS]: LIVE_DOMAINS,
    "DELETE /system/v1/instances/300/domains/old.example.org": {},
  }, { ...SYS, ...ONE });
  await m.domainRemove.execute(
    { domain: "old.example.org", confirm: "old.example.org", dryRun: false },
    h.context,
  );
  assertEquals(h.forgotten, ["instance-domain-old-example-org"]);
  assertEquals(h.written()[0].data.action, "removed");
});

Deno.test("domainRemove refuses a wrong confirm, a generated and the primary domain", async () => {
  for (
    const [domain, confirm, message] of [
      ["old.example.org", "old.example.com", "refusing to delete"],
      ["gen.zitadel.cloud", "gen.zitadel.cloud", "generated by setup"],
      ["id.example.org", "id.example.org", "is the primary"],
    ]
  ) {
    using h = harness({ [DOMAINS]: LIVE_DOMAINS }, { ...SYS, ...ONE });
    await assertRejects(
      () =>
        m.domainRemove.execute({ domain, confirm, dryRun: false }, h.context),
      Error,
      message,
    );
    assertEquals(h.calls.length, 1);
    assertEquals(h.written(), []);
  }
});

Deno.test("domainRemove with dryRun only plans", async () => {
  using h = harness({ [DOMAINS]: LIVE_DOMAINS }, { ...SYS, ...ONE });
  await m.domainRemove.execute(
    { domain: "old.example.org", confirm: "old.example.org", dryRun: true },
    h.context,
  );
  assertEquals(h.calls.length, 1);
  assertEquals(h.written()[0].data.action, "planned");
});

Deno.test("domainSetPrimary makes a listed domain the primary", async () => {
  using h = harness({
    [DOMAINS]: LIVE_DOMAINS,
    "POST /system/v1/instances/300/domains/_set_primary": {},
  }, { ...SYS, ...ONE });
  await m.domainSetPrimary.execute({ domain: "old.example.org" }, h.context);
  assertEquals(h.calls[1].body, { domain: "old.example.org" });
  const [w] = h.written();
  assertEquals([w.data.action, w.data.primary], ["updated", true]);
});

Deno.test("domainSetPrimary refuses a domain the instance does not have", async () => {
  using h = harness({ [DOMAINS]: LIVE_DOMAINS }, { ...SYS, ...ONE });
  await assertRejects(
    () => m.domainSetPrimary.execute({ domain: "x.example.org" }, h.context),
    Error,
    "add it first",
  );
  assertEquals(h.calls.length, 1);
  assertEquals(h.written(), []);
});
