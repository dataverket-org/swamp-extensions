import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./org.ts";
import { assertNoPlanted, fail, harness } from "./test_support.ts";

const ORG = { id: "100", name: "dataverket", state: "ORG_STATE_ACTIVE" };

Deno.test("get stores the service user's organization", async () => {
  using h = harness({ "GET /management/v1/orgs/me": { org: ORG } });
  await model.methods.get.execute({}, h.context);
  const [w] = h.written();
  assertEquals([w.spec, w.name, w.data.id], ["org", "org-dataverket", "100"]);
  assertNoPlanted(h);
});

Deno.test("get fails when the instance refuses, and writes nothing", async () => {
  using h = harness({ "GET /management/v1/orgs/me": fail(401, "no") });
  await assertRejects(
    () => model.methods.get.execute({}, h.context),
    Error,
    "HTTP 401",
  );
  assertEquals(h.written(), []);
  assertNoPlanted(h);
});

Deno.test("list stores every organization the search returns", async () => {
  using h = harness({
    "POST /v2/organizations/_search": {
      result: [ORG, { id: "101", name: "kunde" }],
    },
  });
  await model.methods.list.execute({}, h.context);
  assertEquals(h.written().map((w) => w.name), ["org-dataverket", "org-kunde"]);
  assertEquals(h.calls[0].body, {
    query: { offset: "0", limit: 100, asc: true },
  });
});

Deno.test("list fails on an API error and writes nothing", async () => {
  using h = harness({ "POST /v2/organizations/_search": fail(403) });
  await assertRejects(
    () => model.methods.list.execute({}, h.context),
    Error,
    "HTTP 403",
  );
  assertEquals(h.written(), []);
});

Deno.test("managerList stores each manager under its organization", async () => {
  using h = harness({
    "GET /management/v1/orgs/me": { org: ORG },
    "POST /management/v1/orgs/me/members/_search": {
      result: [{
        userId: "200",
        preferredLoginName: "ola@dataverket",
        roles: ["ORG_OWNER"],
      }],
    },
  });
  await model.methods.managerList.execute({}, h.context);
  const [w] = h.written();
  assertEquals([w.spec, w.name], ["manager", "manager-ola-dataverket"]);
  assertEquals([w.data.orgId, w.data.roles], ["100", ["ORG_OWNER"]]);
});

Deno.test("managerList fails when the member search is refused", async () => {
  using h = harness({
    "GET /management/v1/orgs/me": { org: ORG },
    "POST /management/v1/orgs/me/members/_search": fail(403),
  });
  await assertRejects(
    () => model.methods.managerList.execute({}, h.context),
    Error,
    "HTTP 403",
  );
  assertEquals(h.written(), []);
});
