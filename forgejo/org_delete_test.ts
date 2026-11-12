import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { extension } from "./org_delete.ts";
import { harness, writes } from "./stub_test.ts";

const m = extension.methods[0].org_delete;
const ORG = "/api/v1/orgs/acme";

Deno.test("org_delete deletes an empty organization and records its id", async () => {
  const h = harness({
    [`GET ${ORG}`]: { status: 200, body: { id: 7, description: "d" } },
    [`GET ${ORG}/repos?limit=10&page=1`]: { status: 200, body: [] },
    [`DELETE ${ORG}`]: { status: 204 },
  });
  await m.execute({ name: "acme" }, h.context);
  assertEquals(
    h.written().map((w) => [w.spec, w.name, w.data.action, w.data.id]),
    [
      ["orgDelete", "org-delete-acme", "deleted", 7],
    ],
  );
});

Deno.test("org_delete records an organization already gone as absent", async () => {
  const h = harness({ [`GET ${ORG}`]: { status: 404 } });
  await m.execute({ name: "acme" }, h.context);
  assertEquals([h.written()[0].data.action, h.written()[0].data.id], [
    "absent",
    0,
  ]);
  assertEquals(writes(h.calls), []);
});

Deno.test("org_delete refuses an organization that holds repositories, naming them", async () => {
  const h = harness({
    [`GET ${ORG}`]: { status: 200, body: { id: 7 } },
    [`GET ${ORG}/repos?limit=10&page=1`]: {
      status: 200,
      body: [{ name: "tool" }, { name: "app" }],
    },
  });
  await assertRejects(
    () => m.execute({ name: "acme" }, h.context),
    Error,
    "organization acme still holds repositories (tool, app)",
  );
  assertEquals([writes(h.calls), h.written()], [[], []]);
});

Deno.test("org_delete passes on the forge's refusal of the read, deleting nothing", async () => {
  const h = harness({
    [`GET ${ORG}`]: {
      status: 403,
      body: { message: "token does not have read:organization" },
    },
  });
  await assertRejects(
    () => m.execute({ name: "acme" }, h.context),
    Error,
    "HTTP 403: token does not have read:organization",
  );
  assertEquals(writes(h.calls), []);
});
