import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import type { Caller } from "./api.ts";
import { prMergeState } from "./pr_merge_state.ts";

const PATH = "/api/v1/repos/example-org/example-repo/pulls/7";
const api = (status: number, body: Record<string, unknown>): Caller => (c) =>
  Promise.resolve(
    c.path === PATH ? { status, body } : { status: 404, body: {} },
  );
const pr = { owner: "example-org", name: "example-repo", index: 7 };
const head = {
  head: { sha: "a".repeat(40) },
  base: { ref: "main" },
  html_url: "https://forge.example.com/pr/7",
};

Deno.test("an open PR has a head and no merge facts", async () => {
  const r = await prMergeState(
    api(200, {
      ...head,
      state: "open",
      merged: false,
      merge_commit_sha: "stale",
    }),
    pr,
  );
  assertEquals([r.merged, r.headSha, r.base, r.mergeSha, r.mergedBy], [
    false,
    "a".repeat(40),
    "main",
    undefined,
    undefined,
  ]);
});

Deno.test("a merged PR carries the merge commit, time and merger", async () => {
  const r = await prMergeState(
    api(200, {
      ...head,
      state: "closed",
      merged: true,
      merge_commit_sha: "b".repeat(40),
      merged_at: "2026-10-26T13:41:41Z",
      merged_by: { login: "ann" },
    }),
    pr,
  );
  assertEquals([r.merged, r.mergeSha, r.mergedAt, r.mergedBy], [
    true,
    "b".repeat(40),
    "2026-10-26T13:41:41Z",
    "ann",
  ]);
});

Deno.test("a merged PR without a merge commit is an error", async () => {
  await assertRejects(
    () => prMergeState(api(200, { ...head, merged: true }), pr),
    Error,
    "is merged but reports no merge commit",
  );
});

Deno.test("the forge's error is reported", async () => {
  await assertRejects(
    () => prMergeState(api(404, { message: "not found" }), pr),
    Error,
    `GET ${PATH} -> HTTP 404: not found`,
  );
});
