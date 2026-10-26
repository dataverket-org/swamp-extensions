import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import type { ApiCall, Caller } from "./api.ts";
import { prComment, prFeedback } from "./pr_comment.ts";

function fakeApi(replies: Record<string, { status: number; body?: unknown }>) {
  const calls: ApiCall[] = [];
  const api: Caller = (c) => {
    calls.push(c);
    const r = replies[`${c.method} ${c.path}`];
    return Promise.resolve(
      r
        ? { status: r.status, body: (r.body ?? {}) as Record<string, unknown> }
        : {
          status: 404,
          body: { message: `no reply for ${c.method} ${c.path}` },
        },
    );
  };
  return { api, calls };
}

const BASE = "/api/v1/repos/example-org/example-repo";
const pr = { owner: "example-org", name: "example-repo", index: 7 };

Deno.test("pr_feedback collects comments, reviews and their inline comments", async () => {
  const { api } = fakeApi({
    [`GET ${BASE}/issues/7/comments`]: {
      status: 200,
      body: [{ user: { login: "ann" }, body: "looks good", created_at: "t1" }],
    },
    [`GET ${BASE}/pulls/7/reviews`]: {
      status: 200,
      body: [{
        id: 3,
        user: { login: "bo" },
        body: "fix",
        state: "REQUEST_CHANGES",
        submitted_at: "t2",
      }],
    },
    [`GET ${BASE}/pulls/7/reviews/3/comments`]: {
      status: 200,
      body: [{
        user: { login: "bo" },
        body: "here",
        path: "a.go",
        position: 12,
        created_at: "t3",
      }],
    },
  });
  const r = await prFeedback(api, pr);
  assertEquals(r.repo, "example-org/example-repo");
  assertEquals(
    r.notes.map((n) => [n.kind, n.author, n.state, n.path, n.line]),
    [
      ["comment", "ann", undefined, undefined, undefined],
      ["review", "bo", "REQUEST_CHANGES", undefined, undefined],
      ["inline", "bo", undefined, "a.go", 12],
    ],
  );
});

Deno.test("pr_feedback reports the forge's error", async () => {
  const { api } = fakeApi({
    [`GET ${BASE}/issues/7/comments`]: {
      status: 403,
      body: { message: "token scope" },
    },
  });
  await assertRejects(
    () => prFeedback(api, pr),
    Error,
    `GET ${BASE}/issues/7/comments -> HTTP 403: token scope`,
  );
});

Deno.test("pr_comment posts one issue comment and records its id and url", async () => {
  const { api, calls } = fakeApi({
    [`POST ${BASE}/issues/7/comments`]: {
      status: 201,
      body: { id: 99, html_url: "https://forge.example.com/c/99" },
    },
  });
  const r = await prComment(api, { ...pr, body: "hello" });
  assertEquals(calls[0].body, { body: "hello" });
  assertEquals([r.commentId, r.url, r.action], [
    99,
    "https://forge.example.com/c/99",
    "created",
  ]);
});
