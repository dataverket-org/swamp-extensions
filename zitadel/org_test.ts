import { assertEquals } from "jsr:@std/assert@1.0.13";
import { model } from "./org.ts";
import { ORG } from "./fixtures.ts";
import { installFake, line, makeContext, page } from "./test_support.ts";

Deno.test("get stores the service user's own organization", async () => {
  const fake = installFake((call) =>
    line(call) === "GET /management/v1/orgs/me" ? { org: ORG } : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.get.execute({}, context);
    assertEquals(written[0].name, "org-example");
    assertEquals(written[0].data.primaryDomain, "example.org");
    assertEquals(written[0].data.state, "active");
  } finally {
    fake.restore();
  }
});

Deno.test("list stores one resource per organization", async () => {
  const fake = installFake((call) =>
    line(call) === "POST /v2/organizations/_search"
      ? { result: [ORG, { ...ORG, id: "2", name: "annet" }] }
      : undefined
  );
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({}, context);
    assertEquals(written.map((w) => w.name), ["org-example", "org-annet"]);
  } finally {
    fake.restore();
  }
});

Deno.test("managerList records who can administer the organization", async () => {
  const fake = installFake((call) => {
    if (line(call) === "GET /management/v1/orgs/me") return { org: ORG };
    if (line(call) === "POST /management/v1/orgs/me/members/_search") {
      return page([{
        userId: "500000000000000002",
        displayName: "Kari Nordmann",
        preferredLoginName: "kari@example.org",
        roles: ["ORG_OWNER"],
      }]);
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.managerList.execute({}, context);
    assertEquals(written[0].name, "manager-kari-example-org");
    assertEquals(written[0].data.roles, ["ORG_OWNER"]);
    assertEquals(written[0].data.orgId, ORG.id);
  } finally {
    fake.restore();
  }
});
