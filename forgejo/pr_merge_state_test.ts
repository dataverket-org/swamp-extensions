import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { extension } from "./pr_merge_state.ts";
import { harness } from "./stub_test.ts";

const m = extension.methods[0].pr_merge_state;
const PR = "/api/v1/repos/acme/tool/pulls/7";
const pr = { owner: "acme", name: "tool", index: 7 };
const head = {
  head: { sha: "a".repeat(40) },
  base: { ref: "main" },
  html_url: "https://forge.example.com/acme/tool/pulls/7",
};

Deno.test("pr_merge_state records an open pull request's head and no merge facts", async () => {
  const h = harness({
    [`GET ${PR}`]: { status: 200, body: { ...head, state: "open" } },
  });
  await m.execute(pr, h.context);
  const w = h.written()[0];
  assertEquals([w.spec, w.name], [
    "prMergeState",
    "pr-merge-state-acme-tool-7",
  ]);
  assertEquals([w.data.merged, w.data.mergeSha, w.data.headSha], [
    false,
    undefined,
    "a".repeat(40),
  ]);
});

Deno.test("pr_merge_state records a merged pull request's merge commit, time and merger", async () => {
  const h = harness({
    [`GET ${PR}`]: {
      status: 200,
      body: {
        ...head,
        state: "closed",
        merged: true,
        merge_commit_sha: "b".repeat(40),
        merged_at: "2026-11-12T10:00:00Z",
        merged_by: { login: "bo" },
      },
    },
  });
  await m.execute(pr, h.context);
  const d = h.written()[0].data;
  assertEquals([d.mergeSha, d.mergedAt, d.mergedBy], [
    "b".repeat(40),
    "2026-11-12T10:00:00Z",
    "bo",
  ]);
});

Deno.test("pr_merge_state refuses a merged pull request without a merge commit", async () => {
  const h = harness({
    [`GET ${PR}`]: { status: 200, body: { ...head, merged: true } },
  });
  await assertRejects(
    () => m.execute(pr, h.context),
    Error,
    "is merged but reports no merge commit",
  );
  assertEquals(h.written(), []);
});

Deno.test("pr_merge_state passes on the forge's refusal", async () => {
  const h = harness({
    [`GET ${PR}`]: {
      status: 404,
      body: { message: "pull request does not exist" },
    },
  });
  await assertRejects(
    () => m.execute(pr, h.context),
    Error,
    "HTTP 404: pull request does not exist",
  );
});
