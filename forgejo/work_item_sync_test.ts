import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import type { ApiCall, Caller } from "./api.ts";
import {
  blocking,
  END,
  type Link,
  mergeSection,
  START,
  syncIssue,
  type WorkItemRecords,
} from "./work_item_sync.ts";

const ISSUES = "/api/v1/repos/example-org/example-repo/issues";
const args = {
  owner: "example-org",
  name: "example-repo",
  factory: "f",
  workItem: "wi",
  issue: 0,
};

function fakeApi(current: Record<string, unknown> = {}) {
  const calls: ApiCall[] = [];
  const api: Caller = (c) => {
    calls.push(c);
    if (c.method === "POST" && c.path === ISSUES) {
      return Promise.resolve({
        status: 201,
        body: { number: 5, html_url: "https://forge.example.com/i/5" },
      });
    }
    if (c.method === "GET") {
      return Promise.resolve({ status: 200, body: current });
    }
    return Promise.resolve({
      status: 201,
      body: { html_url: "https://forge.example.com/i/5" },
    });
  };
  return { api, calls };
}

function recs(
  stage: string,
  status = "active",
  payloads: Record<string, Record<string, unknown>> = {},
): WorkItemRecords {
  return { state: { stageId: stage, status }, payload: (n) => payloads[n] };
}

const plan = {
  outcome: "Ship the thing. More words.",
  decisions: [{ id: "D1", question: "Q?", choice: "A" }],
  totalEstimatedLoc: 10,
};

Deno.test("blocking keeps unresolved critical and high findings only", () => {
  assertEquals(
    blocking(
      {
        findings: [
          { id: "A-1", severity: "high", description: "x" },
          { id: "A-2", severity: "HIGH", description: "y", resolved: true },
          { id: "A-3", severity: "medium", description: "z" },
        ],
      },
      undefined,
      { findings: [{ id: "B-1", severity: "critical", summary: "w" }] },
    ),
    ["A-1: x", "B-1: w"],
  );
});

Deno.test("the section is replaced in place and text around it is kept", () => {
  const old = `intro\n\n${START}\nold\n${END}\noutro`;
  assertEquals(mergeSection(old, "NEW"), "intro\n\nNEW\noutro");
  assertEquals(
    mergeSection("a person's text", "NEW"),
    "a person's text\n\n---\n\nNEW",
  );
  assertEquals(mergeSection("", "NEW"), "NEW");
});

Deno.test("the first sync creates the issue titled from the outcome", async () => {
  const { api, calls } = fakeApi();
  const link = await syncIssue(
    api,
    args,
    recs("planning", "active", { plan }),
    undefined,
  );
  assertEquals(calls.map((c) => c.method), ["POST"]);
  const body = calls[0].body as { title: string; body: string };
  assertEquals(body.title, "wi: Ship the thing.");
  assertStringIncludes(body.body, "- **D1** Q? → A");
  assertEquals([link.issue, link.stage, link.url], [
    5,
    "planning",
    "https://forge.example.com/i/5",
  ]);
});

Deno.test("a later sync updates the body, comments on the stage change and new blockers", async () => {
  const { api, calls } = fakeApi({
    title: "wi: Ship the thing.",
    body: `mine\n\n${START}\nold\n${END}`,
  });
  const last: Link = {
    workItem: "wi",
    repo: "example-org/example-repo",
    issue: 5,
    url: "",
    stage: "planning",
    status: "active",
    blocking: [],
    syncedAt: "",
  };
  const review = {
    findings: [{ id: "S-1", severity: "high", description: "bad" }],
  };
  const link = await syncIssue(
    api,
    args,
    recs("plan-review", "active", { plan, "plan-review": review }),
    last,
  );
  const patch = calls.find((c) => c.method === "PATCH")!;
  const body = patch.body as { body: string; state: string; title?: string };
  assert(body.body.startsWith("mine\n\n" + START));
  assertEquals(body.state, "open");
  assertEquals(body.title, undefined);
  const comment = calls.find((c) => c.path.endsWith("/comments"))!;
  assertEquals(
    (comment.body as { body: string }).body,
    "Stage: `planning` → `plan-review`\nNew blocking findings:\n- S-1: bad",
  );
  assertEquals(link.blocking, ["S-1: bad"]);
});

Deno.test("nothing changed means no comment, and a finished work item closes the issue", async () => {
  const { api, calls } = fakeApi({ title: "x", body: "" });
  const last: Link = {
    workItem: "wi",
    repo: "example-org/example-repo",
    issue: 5,
    url: "",
    stage: "done",
    status: "terminal",
    blocking: [],
    syncedAt: "",
  };
  await syncIssue(api, args, recs("done", "terminal"), last);
  assertEquals(calls.some((c) => c.path.endsWith("/comments")), false);
  assertEquals(
    (calls.find((c) => c.method === "PATCH")!.body as { state: string }).state,
    "closed",
  );
});

Deno.test("a work item the factory does not have is an error", async () => {
  const { api, calls } = fakeApi();
  await assertRejects(
    () =>
      syncIssue(
        api,
        args,
        { state: undefined, payload: () => undefined },
        undefined,
      ),
    Error,
    "f has no work item wi",
  );
  assertEquals(calls.length, 0);
});
