import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./instance.ts";
import { assertNoPlanted, fail, harness } from "./test_support.ts";

const ME = "GET /admin/v1/instances/me";
const TRUSTED = "POST /admin/v1/trusted_domains/_search";
const LIVE_TRUSTED = { result: [{ domain: "login.example.org" }] };
const m = model.methods;

Deno.test("read stores the instance, its domains and its trusted domains", async () => {
  const h = harness({
    [ME]: {
      instance: {
        id: "300",
        name: "prod",
        state: "INSTANCE_STATE_RUNNING",
        version: "v4.2.0",
      },
    },
    "POST /admin/v1/domains/_search": {
      result: [{ domain: "id.example.org", primary: true }],
    },
    [TRUSTED]: LIVE_TRUSTED,
  });
  await m.read.execute({}, h.context);
  const w = h.written();
  assertEquals(w.map((r) => r.name), [
    "instance-300",
    "instance-domain-id-example-org",
    "trusted-domain-login-example-org",
  ]);
  assertEquals(w[0].data.state, "running");
  assertEquals(w[1].data.primary, true);
  assertNoPlanted(h);
});

Deno.test("read refuses when the Admin API names no instance", async () => {
  const h = harness({ [ME]: { instance: {} } });
  await assertRejects(
    () => m.read.execute({}, h.context),
    Error,
    "named no instance",
  );
  assertEquals(h.written(), []);
});

Deno.test("memberList stores each member with their roles", async () => {
  const h = harness({
    "POST /admin/v1/members/_search": {
      result: [{
        userId: "9",
        preferredLoginName: "ops@example.org",
        userType: "TYPE_HUMAN",
        roles: ["IAM_OWNER"],
      }],
    },
  });
  await m.memberList.execute({}, h.context);
  const [w] = h.written();
  assertEquals(w.name, "member-ops-example-org");
  assertEquals(w.data.roles, ["IAM_OWNER"]);
  assertNoPlanted(h);
});

Deno.test("memberList fails without iam.member.read and writes nothing", async () => {
  const h = harness({
    "POST /admin/v1/members/_search": fail(403, "no permission"),
  });
  await assertRejects(
    () => m.memberList.execute({}, h.context),
    Error,
    "HTTP 403",
  );
  assertEquals(h.written(), []);
});

Deno.test("trustedDomainAdd trusts a new domain", async () => {
  const h = harness({
    [TRUSTED]: LIVE_TRUSTED,
    "POST /admin/v1/trusted_domains": {},
  });
  await m.trustedDomainAdd.execute({ domain: "app.example.org" }, h.context);
  assertEquals(h.calls[1].body, { domain: "app.example.org" });
  assertEquals(h.written()[0].data.action, "created");
});

Deno.test("trustedDomainAdd fails when the Admin API refuses", async () => {
  const h = harness({
    [TRUSTED]: LIVE_TRUSTED,
    "POST /admin/v1/trusted_domains": fail(400, "invalid domain"),
  });
  await assertRejects(
    () => m.trustedDomainAdd.execute({ domain: "bad" }, h.context),
    Error,
    "HTTP 400",
  );
  assertEquals(h.written(), []);
});

Deno.test("trustedDomainRemove removes a confirmed domain and tombstones it", async () => {
  const h = harness({
    [TRUSTED]: LIVE_TRUSTED,
    "DELETE /admin/v1/trusted_domains/login.example.org": {},
  });
  await m.trustedDomainRemove.execute({
    domain: "login.example.org",
    confirm: "login.example.org",
    dryRun: false,
  }, h.context);
  assertEquals(h.forgotten, ["trusted-domain-login-example-org"]);
  assertEquals(h.written()[0].data.action, "removed");
});

Deno.test("trustedDomainRemove refuses a wrong confirm or an untrusted domain", async () => {
  for (
    const [domain, confirm, message] of [
      ["login.example.org", "login.example.com", "refusing to delete"],
      ["other.example.org", "other.example.org", "is not trusted"],
    ]
  ) {
    const h = harness({ [TRUSTED]: LIVE_TRUSTED });
    await assertRejects(
      () =>
        m.trustedDomainRemove.execute(
          { domain, confirm, dryRun: false },
          h.context,
        ),
      Error,
      message,
    );
    assertEquals(h.calls.length, 1);
    assertEquals(h.written(), []);
  }
});
