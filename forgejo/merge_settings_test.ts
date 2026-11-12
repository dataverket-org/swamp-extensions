import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { extension } from "./merge_settings.ts";
import { harness, writes } from "./stub_test.ts";

const method = extension.methods[0].repo_merge_settings_ensure;
Deno.test("a merge style the forge does not know is refused by the schema", () => {
  const r = method.arguments.safeParse({
    owner: "acme",
    name: "tool",
    defaultMergeStyle: "octopus",
  });
  assertEquals(r.success, false);
  const u = method.arguments.safeParse({
    owner: "acme",
    name: "tool",
    defaultUpdateStyle: "squash",
  });
  assertEquals(u.success, false);
  for (const style of ["manually-merged", "rebase-update-only"]) {
    const m = method.arguments.safeParse({
      owner: "acme",
      name: "tool",
      defaultMergeStyle: style,
    });
    assertEquals(m.success, false, style);
  }
});
Deno.test("a setting given as a string is refused by the schema", () => {
  const r = method.arguments.safeParse({
    owner: "acme",
    name: "tool",
    allowRebase: "false",
  });
  assertEquals(r.success, false);
});

// ───── the methods, through createModelTestContext with a stub client ─────

const REPO = "/api/v1/repos/acme/tool";
const repo = {
  has_pull_requests: true,
  allow_merge_commits: true,
  allow_rebase: true,
  allow_rebase_explicit: true,
  allow_squash_merge: true,
  allow_fast_forward_only_merge: false,
  allow_rebase_update: true,
  default_merge_style: "merge",
  default_update_style: "merge",
  default_delete_branch_after_merge: false,
  default_allow_maintainer_edit: false,
  ignore_whitespace_conflicts: false,
};

Deno.test("repo_merge_settings_ensure sends only what differs, inside has_pull_requests, and records all eleven", async () => {
  const h = harness({
    [`GET ${REPO}`]: { status: 200, body: repo },
    [`PATCH ${REPO}`]: {
      status: 200,
      body: { ...repo, allow_squash_merge: false },
    },
  });
  await method.execute({
    owner: "acme",
    name: "tool",
    allowSquashMerge: false,
    allowMergeCommits: true,
  }, h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{
    allow_squash_merge: false,
    has_pull_requests: true,
  }]);
  const w = h.written()[0];
  assertEquals([
    w.spec,
    w.name,
    w.data.action,
    w.data.changed,
    w.data.allowSquashMerge,
  ], [
    "repoMergeSettings",
    "repo-merge-settings-acme-tool",
    "updated",
    ["allowSquashMerge"],
    false,
  ]);
});

Deno.test("repo_merge_settings_ensure refuses any setting while pull requests are off, sending nothing", async () => {
  const h = harness({
    [`GET ${REPO}`]: {
      status: 200,
      body: { ...repo, has_pull_requests: false },
    },
  });
  await assertRejects(
    () =>
      method.execute(
        { owner: "acme", name: "tool", allowMergeCommits: true },
        h.context,
      ),
    Error,
    "pull requests are off",
  );
  assertEquals([writes(h.calls), h.written()], [[], []]);
});
