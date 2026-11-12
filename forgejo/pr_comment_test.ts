import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { extension } from "./pr_comment.ts";
import { harness, writes } from "./stub_test.ts";

const { pr_feedback, pr_comment } = extension.methods[0];
const R = "/api/v1/repos/acme/tool";
const pr = { owner: "acme", name: "tool", index: 4 };

Deno.test("pr_feedback records comments, reviews with their state, and inline comments", async () => {
  const h = harness({
    [`GET ${R}/issues/4/comments`]: {
      status: 200,
      body: [{ user: { login: "a" }, body: "hi", created_at: "t1" }],
    },
    [`GET ${R}/pulls/4/reviews`]: {
      status: 200,
      body: [{
        id: 9,
        user: { login: "b" },
        body: "ok",
        state: "APPROVED",
        submitted_at: "t2",
      }],
    },
    [`GET ${R}/pulls/4/reviews/9/comments`]: {
      status: 200,
      body: [{
        user: { login: "b" },
        body: "nit",
        path: "x.ts",
        position: 3,
        created_at: "t3",
      }],
    },
  });
  await pr_feedback.execute(pr, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [[
    "prFeedback",
    "pr-feedback-acme-tool-4",
  ]]);
  const notes = w[0].data.notes as Record<string, unknown>[];
  assertEquals(notes.map((n) => [n.kind, n.author, n.state, n.path, n.line]), [
    ["comment", "a", undefined, undefined, undefined],
    ["review", "b", "APPROVED", undefined, undefined],
    ["inline", "b", undefined, "x.ts", 3],
  ]);
});

Deno.test("pr_feedback passes on the forge's refusal and records nothing", async () => {
  const h = harness({
    [`GET ${R}/issues/4/comments`]: {
      status: 404,
      body: { message: "issue does not exist" },
    },
  });
  await assertRejects(
    () => pr_feedback.execute(pr, h.context),
    Error,
    "HTTP 404: issue does not exist",
  );
  assertEquals(h.written(), []);
});

Deno.test("pr_comment posts one comment and records its id and page", async () => {
  const h = harness({
    [`POST ${R}/issues/4/comments`]: {
      status: 201,
      body: {
        id: 31,
        html_url: "https://forge.example.com/acme/tool/pulls/4#c31",
      },
    },
  });
  await pr_comment.execute({ ...pr, body: "looks fine" }, h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{ body: "looks fine" }]);
  assertEquals(
    h.written().map((w) => [w.name, w.data.commentId, w.data.action]),
    [
      ["pr-comment-acme-tool-4-31", 31, "created"],
    ],
  );
});

Deno.test("pr_comment passes on the forge's refusal and records nothing", async () => {
  const h = harness({
    [`POST ${R}/issues/4/comments`]: {
      status: 403,
      body: { message: "issue is locked" },
    },
  });
  await assertRejects(
    () => pr_comment.execute({ ...pr, body: "x" }, h.context),
    Error,
    "HTTP 403: issue is locked",
  );
  assertEquals(h.written(), []);
});
