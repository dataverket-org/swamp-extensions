import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { extension } from "./pr_assign.ts";
import { harness, writes } from "./stub_test.ts";

const { pr_assign, user_search } = extension.methods[0];
const PR = "/api/v1/repos/acme/tool/pulls/4";
const args = { owner: "acme", name: "tool", index: 4, assignees: ["bo"] };

Deno.test("pr_assign checks the login, assigns, and records what the forge reports", async () => {
  const h = harness({
    ["GET /api/v1/users/bo"]: { status: 200, body: { login: "bo" } },
    [`GET ${PR}`]: {
      status: 200,
      body: { state: "open", title: "T", assignees: [] },
    },
    [`PATCH ${PR}`]: {
      status: 201,
      body: { state: "open", title: "T", assignees: [{ login: "bo" }] },
    },
  });
  await pr_assign.execute(args, h.context);
  assertEquals(h.written().map((w) => [w.spec, w.name]), [[
    "prAssignment",
    "pr-assignment-acme-tool-4",
  ]]);
  assertEquals(
    [h.written()[0].data.action, h.written()[0].data.assignees],
    ["assigned", ["bo"]],
  );
  assertEquals(writes(h.calls).map((c) => c.body), [{ assignees: ["bo"] }]);
});

Deno.test("pr_assign leaves a pull request whose assignees already match", async () => {
  const h = harness({
    ["GET /api/v1/users/bo"]: { status: 200 },
    [`GET ${PR}`]: {
      status: 200,
      body: { state: "open", assignees: [{ login: "bo" }] },
    },
  });
  await pr_assign.execute(args, h.context);
  assertEquals(h.written()[0].data.action, "unchanged");
  assertEquals(writes(h.calls), []);
});

Deno.test("pr_assign refuses a login the forge does not know, before reading the pull request", async () => {
  const h = harness({ ["GET /api/v1/users/bo"]: { status: 404 } });
  await assertRejects(
    () => pr_assign.execute(args, h.context),
    Error,
    'No user "bo" on the forge',
  );
  assertEquals([h.calls.length, h.written()], [1, []]);
});

Deno.test("pr_assign refuses a pull request that is not open", async () => {
  const h = harness({
    ["GET /api/v1/users/bo"]: { status: 200 },
    [`GET ${PR}`]: { status: 200, body: { state: "closed" } },
  });
  await assertRejects(
    () => pr_assign.execute(args, h.context),
    Error,
    "is closed, not open",
  );
  assertEquals(writes(h.calls), []);
});

Deno.test("user_search records each match by login", async () => {
  const h = harness({
    ["GET /api/v1/users/search?q=bo&limit=50"]: {
      status: 200,
      body: { ok: true, data: [{ login: "bo", full_name: "Bo B" }] },
    },
  });
  await user_search.execute({ q: "bo" }, h.context);
  assertEquals(
    h.written().map((w) => [w.name, w.data.login, w.data.fullName]),
    [
      ["user-match-bo", "bo", "Bo B"],
    ],
  );
});

Deno.test("user_search passes on the forge's refusal", async () => {
  const h = harness({
    ["GET /api/v1/users/search?q=bo&limit=50"]: {
      status: 500,
      body: { message: "search broke" },
    },
  });
  await assertRejects(
    () => user_search.execute({ q: "bo" }, h.context),
    Error,
    "HTTP 500: search broke",
  );
  assertEquals(h.written(), []);
});
