import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { harness, writes } from "./stub_test.ts";
import { extension as issueExtension } from "./issues.ts";

// ───── issue_state_ensure: its arguments; its behaviour is tested live ─────
Deno.test("issue_state_ensure's arguments: 1 to 20 issues, open or closed, comment empty by default", () => {
  const args = issueExtension.methods[0].issue_state_ensure.arguments;
  const one = { number: 1, state: "closed" };
  assertEquals(
    args.parse({ owner: "a", name: "b", issues: [one] }).issues[0].comment,
    "",
  );
  for (
    const issues of [
      [],
      Array.from({ length: 21 }, (_, i) => ({ ...one, number: i + 1 })),
      [{ number: 1, state: "merged" }],
      [{ number: 0, state: "open" }],
    ]
  ) {
    assertEquals(
      args.safeParse({ owner: "a", name: "b", issues }).success,
      false,
    );
  }
});

// ───── the methods, through createModelTestContext with a stub client ─────

const M = issueExtension.methods[0];
const I = "/api/v1/repos/acme/tool/issues";
const search = (q: string) =>
  `GET ${I}?state=all&type=issues&limit=50&page=1&q=${encodeURIComponent(q)}`;
const NEWEST = `GET ${I}?state=all&type=issues&sort=newest&limit=50&page=1`;
const issue = (
  n: number,
  title: string,
  extra: Record<string, unknown> = {},
) => ({
  number: n,
  title,
  state: "open",
  html_url: `https://forge.example.com/acme/tool/issues/${n}`,
  labels: [],
  ...extra,
});

Deno.test("issue_ensure files an issue the search and the newest issues do not have", async () => {
  const h = harness({
    [search("Log every call")]: {
      status: 200,
      body: [issue(3, "Log every call and more")],
    },
    [NEWEST]: { status: 200, body: [] },
    [`POST ${I}`]: { status: 201, body: issue(4, "Log every call") },
  });
  await M.issue_ensure.execute(
    {
      owner: "acme",
      name: "tool",
      issues: [{ title: "Log every call", body: "b", labels: [] }],
    },
    h.context,
  );
  assertEquals(writes(h.calls).map((c) => c.body), [{
    title: "Log every call",
    body: "b",
    labels: [],
  }]);
  assertEquals(h.written().map((w) => [w.spec, w.name, w.data.action]), [[
    "issue",
    "issue-acme-tool-4",
    "created",
  ]]);
});

Deno.test("issue_ensure finds an issue filed seconds ago among the newest, the search not yet", async () => {
  const h = harness({
    [search("Race")]: { status: 200, body: [] },
    [NEWEST]: { status: 200, body: [issue(9, "Race", { state: "closed" })] },
  });
  await M.issue_ensure.execute({
    owner: "acme",
    name: "tool",
    issues: [{ title: "Race", body: "", labels: [] }],
  }, h.context);
  assertEquals(writes(h.calls), []);
  assertEquals([h.written()[0].data.action, h.written()[0].data.state], [
    "unchanged",
    "closed",
  ]);
});

Deno.test("issue_ensure refuses a label that is nowhere, before filing anything", async () => {
  const h = harness({
    ["GET /api/v1/repos/acme/tool/labels?limit=50&page=1"]: {
      status: 200,
      body: [],
    },
    ["GET /api/v1/orgs/acme"]: { status: 404 },
  });
  await assertRejects(
    () =>
      M.issue_ensure.execute({
        owner: "acme",
        name: "tool",
        issues: [{ title: "x", body: "", labels: ["nope"] }],
      }, h.context),
    Error,
    'label(s) "nope" exist neither on acme/tool nor on acme',
  );
  assertEquals([writes(h.calls), h.written()], [[], []]);
});

Deno.test("issue_labels_ensure adds a label by name and records the set", async () => {
  const h = harness({
    ["GET /api/v1/repos/acme/tool/labels?limit=50&page=1"]: {
      status: 200,
      body: [{ id: 3, name: "bug" }],
    },
    ["GET /api/v1/orgs/acme"]: { status: 404 },
    [`GET ${I}/5/labels`]: { status: 200, body: [] },
    [`POST ${I}/5/labels`]: { status: 200, body: [{ id: 3, name: "bug" }] },
  });
  await M.issue_labels_ensure.execute({
    owner: "acme",
    name: "tool",
    number: 5,
    labels: ["bug"],
    exact: false,
  }, h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{ labels: [3] }]);
  const w = h.written()[0];
  assertEquals([w.name, w.data.action, w.data.added], [
    "issue-labels-acme-tool-5",
    "updated",
    ["bug"],
  ]);
});

Deno.test("issue_labels_ensure refuses an unknown label before touching the issue", async () => {
  const h = harness({
    ["GET /api/v1/repos/acme/tool/labels?limit=50&page=1"]: {
      status: 200,
      body: [],
    },
    ["GET /api/v1/orgs/acme"]: { status: 404 },
  });
  await assertRejects(
    () =>
      M.issue_labels_ensure.execute({
        owner: "acme",
        name: "tool",
        number: 5,
        labels: ["bug"],
        exact: false,
      }, h.context),
    Error,
    "exist neither",
  );
  assertEquals(h.calls.some((c) => c.path.includes("/issues/")), false);
});

Deno.test("issue_list records the issues of a state", async () => {
  const h = harness({
    [`GET ${I}?state=open&type=issues&limit=50&page=1`]: {
      status: 200,
      body: [issue(1, "a"), issue(2, "b")],
    },
  });
  await M.issue_list.execute(
    { owner: "acme", name: "tool", state: "open" },
    h.context,
  );
  assertEquals(h.written().map((w) => [w.name, w.data.action]), [[
    "issue-acme-tool-1",
    "listed",
  ], ["issue-acme-tool-2", "listed"]]);
});

Deno.test("issue_list passes on the forge's refusal", async () => {
  const h = harness({
    [`GET ${I}?state=open&type=issues&limit=50&page=1`]: {
      status: 404,
      body: { message: "repo not found" },
    },
  });
  await assertRejects(
    () =>
      M.issue_list.execute(
        { owner: "acme", name: "tool", state: "open" },
        h.context,
      ),
    Error,
    "HTTP 404: repo not found",
  );
});

Deno.test("issue_state_ensure comments, then closes; one already closed gets nothing", async () => {
  const h = harness({
    [`GET ${I}/1`]: { status: 200, body: issue(1, "a") },
    [`GET ${I}/2`]: { status: 200, body: issue(2, "b", { state: "closed" }) },
    [`POST ${I}/1/comments`]: { status: 201, body: { id: 7 } },
    [`PATCH ${I}/1`]: { status: 201, body: issue(1, "a", { state: "closed" }) },
  });
  await M.issue_state_ensure.execute(
    {
      owner: "acme",
      name: "tool",
      issues: [{ number: 1, state: "closed", comment: "Done." }, {
        number: 2,
        state: "closed",
        comment: "never",
      }],
    },
    h.context,
  );
  assertEquals(writes(h.calls).map((c) => [c.method, c.body]), [["POST", {
    body: "Done.",
  }], ["PATCH", { state: "closed" }]]);
  assertEquals(h.written().map((w) => [w.name, w.data.action]), [
    ["issue-state-acme-tool-1", "updated"],
    ["issue-state-acme-tool-2", "unchanged"],
  ]);
});

Deno.test("issue_state_ensure refuses a pull request in the list before writing anything", async () => {
  const h = harness({
    [`GET ${I}/1`]: { status: 200, body: issue(1, "a") },
    [`GET ${I}/2`]: { status: 200, body: issue(2, "pr", { pull_request: {} }) },
  });
  await assertRejects(
    () =>
      M.issue_state_ensure.execute(
        {
          owner: "acme",
          name: "tool",
          issues: [{ number: 1, state: "closed", comment: "x" }, {
            number: 2,
            state: "closed",
            comment: "",
          }],
        },
        h.context,
      ),
    Error,
    "#2 of acme/tool is a pull request, not an issue",
  );
  assertEquals([writes(h.calls), h.written()], [[], []]);
});

Deno.test("issue_body_ensure rewrites a differing text and records no text", async () => {
  const h = harness({
    [`GET ${I}/1`]: { status: 200, body: issue(1, "a", { body: "old" }) },
    [`PATCH ${I}/1`]: {
      status: 201,
      body: issue(1, "a", { body: "NEW-TEXT" }),
    },
  });
  await M.issue_body_ensure.execute({
    owner: "acme",
    name: "tool",
    number: 1,
    body: "NEW-TEXT",
  }, h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{ body: "NEW-TEXT" }]);
  assertEquals([h.written()[0].name, h.written()[0].data.action], [
    "issue-body-acme-tool-1",
    "updated",
  ]);
  assertEquals(JSON.stringify(h.written()).includes("NEW-TEXT"), false);
});

Deno.test("issue_body_ensure refuses a pull request, writing nothing", async () => {
  const h = harness({
    [`GET ${I}/2`]: { status: 200, body: issue(2, "pr", { pull_request: {} }) },
  });
  await assertRejects(
    () =>
      M.issue_body_ensure.execute({
        owner: "acme",
        name: "tool",
        number: 2,
        body: "x",
      }, h.context),
    Error,
    "is a pull request",
  );
  assertEquals(writes(h.calls), []);
});
