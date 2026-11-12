import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { harness, writes } from "./stub_test.ts";
import { DEFAULT_HTTP_TIMEOUT_MS, model, resolveTimeoutMs } from "./forgejo.ts";
import { extension as actions } from "./actions.ts";
import { extension as checks } from "./checks.ts";
import { extension as issues } from "./issues.ts";
import { extension as labels } from "./labels.ts";
import { extension as mergeSettings } from "./merge_settings.ts";
import { extension as orgDelete } from "./org_delete.ts";
import { extension as prAssign } from "./pr_assign.ts";
import { extension as prComment } from "./pr_comment.ts";
import { extension as prMergeState } from "./pr_merge_state.ts";
import { extension as pullMirror } from "./pull_mirror.ts";
import { extension as pushMirror } from "./push_mirror.ts";
import { extension as repoDelete } from "./repo_delete.ts";
import { extension as tagProtection } from "./tag_protection.ts";
import { extension as topics } from "./topics.ts";
import { extension as units } from "./units.ts";
import { extension as workItemSync } from "./work_item_sync.ts";

/** The upstream base, as forked: every method @thomas/forgejo 2026.09.04.2 had. */
const BASE_METHODS = [
  "health",
  "org_list",
  "repo_list",
  "user_list",
  "mirror_status",
  "webhook_audit",
  "webhook_retarget",
  "org_ensure",
  "repo_ensure",
  "collaborator_ensure",
  "branch_protection_ensure",
  "branch_protection_list",
  "mirror_ensure",
  "mirror_sync_now",
  "pr_list",
  "pr_get",
  "pr_ensure",
  "pr_merge",
  "repo_archive",
  "repo_unarchive",
];

/** The former add-ons, now methods of the same type. */
const ADDED_METHODS = [
  "actions_secret_put",
  "runner_registration_token",
  "runner_list",
  "runner_prune",
  "repo_rename",
  "pull_mirror_ensure",
  "repo_topics_ensure",
  "repo_units_ensure",
  "repo_merge_settings_ensure",
  "push_mirror_ensure",
  "push_mirror_list",
  "push_mirror_delete",
  "push_mirror_sync_now",
  "user_search",
  "pr_assign",
  "repo_delete",
  "org_delete",
  "issue_ensure",
  "issue_labels_ensure",
  "issue_list",
  "issue_state_ensure",
  "issue_body_ensure",
  "tag_protection_ensure",
  "label_ensure",
  "label_list",
  "pr_comment",
  "pr_feedback",
  "pr_merge_state",
  "work_item_sync",
];

const MODULES = [
  actions,
  checks,
  issues,
  labels,
  mergeSettings,
  orgDelete,
  prAssign,
  prComment,
  prMergeState,
  pullMirror,
  pushMirror,
  repoDelete,
  tagProtection,
  topics,
  units,
  workItemSync,
];

Deno.test("the base owns the dataverket type at the published version", () => {
  assertEquals(model.type, "@dataverket/forgejo");
  assertEquals(model.version, "2026.11.12.1");
});
Deno.test("the upgrade chain ends at the model's version and is a no-op", () => {
  const last = model.upgrades.at(-1)!;
  assertEquals(last.toVersion, model.version);
  const args = { apiUrl: "https://forge.example.com", token: "t" };
  assertEquals(last.upgradeAttributes(args), args);
});
Deno.test("every upstream method is still there, and nothing else", () => {
  assertEquals(Object.keys(model.methods).sort(), [...BASE_METHODS].sort());
});
Deno.test("every module targets the dataverket type", () => {
  for (const m of MODULES) assertEquals(m.type, "@dataverket/forgejo");
});
Deno.test("the add-on methods are all present once, and none shadows the base", () => {
  const names = MODULES.flatMap((m) =>
    (m.methods as Record<string, unknown>[]).flatMap((group) =>
      Object.keys(group)
    )
  );
  assertEquals([...names].sort(), [...ADDED_METHODS].sort());
  const clash = names.filter((n) => n in model.methods);
  assertEquals(clash, []);
});
Deno.test("upstream's reachable check is gone; the two of checks.ts remain", () => {
  assertEquals("checks" in model, false);
  const names = checks.checks.flatMap((group) => Object.keys(group));
  assertEquals(names.sort(), [
    "forgejo-api-url-shape",
    "forgejo-token-accepted",
  ]);
});
Deno.test("resolveTimeoutMs keeps a positive number and falls back otherwise", () => {
  assertEquals(resolveTimeoutMs(5000), 5000);
  assertEquals(resolveTimeoutMs("5000"), 5000);
  for (const bad of [undefined, null, 0, -1, NaN, "", "soon", {}]) {
    assertEquals(resolveTimeoutMs(bad), DEFAULT_HTTP_TIMEOUT_MS);
  }
});

// ───── the base methods, through createModelTestContext with a stub client ─────

const B = model.methods;
const R = "/api/v1/repos/acme/tool";
const repoBody = (extra: Record<string, unknown> = {}) => ({
  id: 1,
  full_name: "acme/tool",
  name: "tool",
  owner: { login: "acme" },
  private: false,
  empty: false,
  ...extra,
});
const pull = (extra: Record<string, unknown> = {}) => ({
  number: 4,
  title: "T",
  state: "open",
  head: { ref: "feat", sha: "a".repeat(40) },
  base: { ref: "main", repo: { full_name: "acme/tool" } },
  user: { login: "bo" },
  ...extra,
});
const names = (h: ReturnType<typeof harness>) => h.written().map((w) => w.name);
const data = (h: ReturnType<typeof harness>, i = 0) => h.written()[i].data;

Deno.test("health records the version and the health check", async () => {
  const h = harness({
    ["GET /api/v1/version"]: { status: 200, body: { version: "15.0.11" } },
    ["GET /api/healthz"]: { status: 503 },
  });
  await B.health.execute({}, h.context);
  assertEquals([names(h), data(h).version, data(h).healthy], [
    ["status"],
    "15.0.11",
    false,
  ]);
});

Deno.test("health passes on a refused version read", async () => {
  const h = harness({
    ["GET /api/v1/version"]: {
      status: 401,
      body: { message: "token is required" },
    },
  });
  await assertRejects(
    () => B.health.execute({}, h.context),
    Error,
    "HTTP 401: token is required",
  );
  assertEquals(h.written(), []);
});

Deno.test("org_list records every organization", async () => {
  const h = harness({
    ["GET /api/v1/orgs?limit=50&page=1"]: {
      status: 200,
      body: [{ id: 2, name: "acme", visibility: "private" }],
    },
  });
  await B.org_list.execute({}, h.context);
  assertEquals([names(h), data(h).visibility], [["acme"], "private"]);
});

Deno.test("org_list passes on the forge's refusal", async () => {
  const h = harness({
    ["GET /api/v1/orgs?limit=50&page=1"]: {
      status: 500,
      body: { message: "db" },
    },
  });
  await assertRejects(
    () => B.org_list.execute({}, h.context),
    Error,
    "HTTP 500: db",
  );
});

Deno.test("repo_list of an organization records its repositories", async () => {
  const h = harness({
    ["GET /api/v1/orgs/acme"]: { status: 200, body: { id: 2 } },
    ["GET /api/v1/orgs/acme/repos?limit=50&page=1"]: {
      status: 200,
      body: [repoBody()],
    },
  });
  await B.repo_list.execute({ owner: "acme" }, h.context);
  assertEquals([names(h), data(h).fullName], [["repo-acme-tool"], "acme/tool"]);
});

Deno.test("repo_list names an owner that is neither an organization nor a user", async () => {
  const h = harness({
    ["GET /api/v1/orgs/nobody"]: { status: 404 },
    ["GET /api/v1/users/nobody/repos?limit=1&page=1"]: { status: 404 },
  });
  await assertRejects(
    () => B.repo_list.execute({ owner: "nobody" }, h.context),
    Error,
    'No user "nobody"',
  );
});

Deno.test("user_list records users and never a credential", async () => {
  const h = harness({
    ["GET /api/v1/admin/users?limit=50&page=1"]: {
      status: 200,
      body: [{
        id: 1,
        login: "bo",
        is_admin: true,
        email: "bo@example.com",
        password: "nope",
      }],
    },
  });
  await B.user_list.execute({}, h.context);
  assertEquals([names(h), data(h).isAdmin, "password" in data(h)], [
    ["bo"],
    true,
    false,
  ]);
});

Deno.test("user_list passes on a token without read:admin", async () => {
  const h = harness({
    ["GET /api/v1/admin/users?limit=50&page=1"]: {
      status: 403,
      body: { message: "required scope read:admin" },
    },
  });
  await assertRejects(
    () => B.user_list.execute({}, h.context),
    Error,
    "HTTP 403: required scope read:admin",
  );
});

Deno.test("mirror_status records each mirror, a never-synced one stale", async () => {
  const h = harness({
    ["GET /api/v1/repos/search?mode=mirror&limit=50&page=1"]: {
      status: 200,
      body: { data: [{ name: "tool", owner: { login: "acme" } }] },
    },
    [`GET ${R}`]: {
      status: 200,
      body: repoBody({
        mirror: true,
        mirror_interval: "",
        mirror_updated: "0001-01-01T00:00:00Z",
      }),
    },
  });
  await B.mirror_status.execute({ staleFactor: 2 }, h.context);
  assertEquals([names(h), data(h).neverSynced, data(h).stale], [
    ["mirror-acme-tool"],
    true,
    true,
  ]);
});

Deno.test("mirror_status passes on a failed search", async () => {
  const h = harness({
    ["GET /api/v1/repos/search?mode=mirror&limit=50&page=1"]: {
      status: 500,
      body: { message: "search" },
    },
  });
  await assertRejects(
    () => B.mirror_status.execute({ staleFactor: 2 }, h.context),
    Error,
    "HTTP 500: search",
  );
});

Deno.test("webhook_audit records each hook with its query redacted and whether it matches", async () => {
  const h = harness({
    [`GET ${R}`]: { status: 200, body: repoBody() },
    [`GET ${R}/hooks`]: {
      status: 200,
      body: [{
        id: 1,
        type: "forgejo",
        active: true,
        events: ["push"],
        config: { url: "https://ci.example.com/hook?access_token=SECRET-Q" },
      }],
    },
  });
  await B.webhook_audit.execute({
    owner: "acme",
    name: "tool",
    expectedUrl: "https://ci.example.com/hook",
  }, h.context);
  assertEquals([names(h), data(h).matchesExpected], [
    ["webhook-acme-tool-1"],
    true,
  ]);
  assertEquals(JSON.stringify(h.written()).includes("SECRET-Q"), false);
});

Deno.test("webhook_audit refuses a name without an owner", async () => {
  const h = harness({});
  await assertRejects(
    () => B.webhook_audit.execute({ name: "tool" }, h.context),
    Error,
    "`name` requires `owner`",
  );
});

Deno.test("webhook_retarget writes config.url alone, carrying the query over", async () => {
  const h = harness({
    [`GET ${R}/hooks`]: {
      status: 200,
      body: [{ id: 1, config: { url: "https://old.example.com/hook?t=Q" } }],
    },
    [`PATCH ${R}/hooks/1`]: {
      status: 200,
      body: { id: 1, config: { url: "https://new.example.com/hook?t=Q" } },
    },
  });
  await B.webhook_retarget.execute({
    owner: "acme",
    name: "tool",
    url: "https://new.example.com/hook",
  }, h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{
    config: { url: "https://new.example.com/hook?t=Q" },
  }]);
  assertEquals(data(h).action, "updated");
});

Deno.test("webhook_retarget refuses a repository without hooks, creating none", async () => {
  const h = harness({ [`GET ${R}/hooks`]: { status: 200, body: [] } });
  await assertRejects(
    () =>
      B.webhook_retarget.execute({
        owner: "acme",
        name: "tool",
        url: "https://x.example.com/",
      }, h.context),
    Error,
    "has no webhooks to retarget",
  );
  assertEquals(writes(h.calls), []);
});

Deno.test("org_ensure creates a missing organization", async () => {
  const h = harness({
    ["GET /api/v1/orgs/acme"]: { status: 404 },
    ["POST /api/v1/orgs"]: {
      status: 201,
      body: { id: 2, name: "acme", visibility: "private" },
    },
  });
  await B.org_ensure.execute(
    { name: "acme", visibility: "private" },
    h.context,
  );
  assertEquals([names(h), data(h).action], [["acme"], "created"]);
});

Deno.test("org_ensure passes on a refused create", async () => {
  const h = harness({
    ["GET /api/v1/orgs/acme"]: { status: 404 },
    ["POST /api/v1/orgs"]: {
      status: 422,
      body: { message: "user already exists" },
    },
  });
  await assertRejects(
    () => B.org_ensure.execute({ name: "acme" }, h.context),
    Error,
    "HTTP 422: user already exists",
  );
  assertEquals(h.written(), []);
});

Deno.test("repo_ensure creates a repository in an organization, private by default", async () => {
  const h = harness({
    [`GET ${R}`]: { status: 404 },
    ["GET /api/v1/user"]: { status: 200, body: { login: "bo" } },
    ["POST /api/v1/orgs/acme/repos"]: {
      status: 201,
      body: repoBody({ private: true, empty: true }),
    },
  });
  await B.repo_ensure.execute({ owner: "acme", name: "tool" }, h.context);
  assertEquals((writes(h.calls)[0].body as { private: boolean }).private, true);
  assertEquals([names(h), data(h).action], [["repo-acme-tool"], "created"]);
});

Deno.test("repo_ensure refuses a renamed repository's old name", async () => {
  const h = harness({
    [`GET ${R}`]: {
      status: 301,
      body: {
        message:
          "acme/tool was renamed; it now redirects to /api/v1/repos/acme/new",
      },
    },
  });
  await assertRejects(
    () => B.repo_ensure.execute({ owner: "acme", name: "tool" }, h.context),
    Error,
    "HTTP 301: acme/tool was renamed",
  );
  assertEquals(writes(h.calls), []);
});

Deno.test("collaborator_ensure grants a user who is no collaborator, whatever a public repository's probe says", async () => {
  const h = harness({
    [`GET ${R}/collaborators/bo`]: { status: 404 },
    [`GET ${R}/collaborators/bo/permission`]: {
      status: 200,
      body: { permission: "read" },
    },
    [`PUT ${R}/collaborators/bo`]: { status: 204 },
  });
  await B.collaborator_ensure.execute({
    owner: "acme",
    name: "tool",
    user: "bo",
    permission: "read",
  }, h.context);
  assertEquals([names(h), data(h).action], [
    ["collaborator-acme-tool-bo"],
    "created",
  ]);
});

Deno.test("collaborator_ensure refuses the owner", async () => {
  const h = harness({
    [`GET ${R}/collaborators/acme`]: { status: 404 },
    [`GET ${R}/collaborators/acme/permission`]: {
      status: 200,
      body: { permission: "owner" },
    },
  });
  await assertRejects(
    () =>
      B.collaborator_ensure.execute({
        owner: "acme",
        name: "tool",
        user: "acme",
        permission: "write",
      }, h.context),
    Error,
    "acme owns acme/tool",
  );
  assertEquals(writes(h.calls), []);
});

Deno.test("branch_protection_ensure creates a rule", async () => {
  const h = harness({
    [`GET ${R}/branch_protections/main`]: { status: 404 },
    [`POST ${R}/branch_protections`]: {
      status: 201,
      body: { rule_name: "main", enable_push: false, required_approvals: 1 },
    },
  });
  await B.branch_protection_ensure.execute({
    owner: "acme",
    name: "tool",
    rule: "main",
    enablePush: false,
    requiredApprovals: 1,
  }, h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{
    enable_push: false,
    required_approvals: 1,
    rule_name: "main",
  }]);
  assertEquals([names(h), data(h).action], [[
    "branch-protection-acme-tool-main",
  ], "created"]);
});

Deno.test("branch_protection_ensure passes on a refused create", async () => {
  const h = harness({
    [`GET ${R}/branch_protections/main`]: { status: 404 },
    [`POST ${R}/branch_protections`]: { status: 403, body: { message: "no" } },
  });
  await assertRejects(
    () =>
      B.branch_protection_ensure.execute({
        owner: "acme",
        name: "tool",
        rule: "main",
      }, h.context),
    Error,
    "HTTP 403: no",
  );
});

Deno.test("branch_protection_list records each rule", async () => {
  const h = harness({
    [`GET ${R}/branch_protections`]: {
      status: 200,
      body: [{ rule_name: "main" }, { rule_name: "release/*" }],
    },
  });
  await B.branch_protection_list.execute(
    { owner: "acme", name: "tool" },
    h.context,
  );
  assertEquals(names(h), [
    "branch-protection-acme-tool-main",
    "branch-protection-acme-tool-release",
  ]);
});

Deno.test("branch_protection_list passes on a missing repository", async () => {
  const h = harness({
    [`GET ${R}/branch_protections`]: {
      status: 404,
      body: { message: "not found" },
    },
  });
  await assertRejects(
    () =>
      B.branch_protection_list.execute(
        { owner: "acme", name: "tool" },
        h.context,
      ),
    Error,
    "HTTP 404",
  );
});

Deno.test("mirror_ensure migrates a new pull mirror", async () => {
  const h = harness({
    [`GET ${R}`]: { status: 404 },
    ["POST /api/v1/repos/migrate"]: {
      status: 201,
      body: repoBody({ mirror: true, mirror_interval: "8h0m0s" }),
    },
  });
  await B.mirror_ensure.execute({
    owner: "acme",
    name: "tool",
    cloneAddr: "https://github.com/x/tool.git",
    service: "github",
    mirrorInterval: "8h0m0s",
    lfs: true,
    private: true,
  }, h.context);
  assertEquals([names(h), data(h).action], [["mirror-acme-tool"], "created"]);
});

Deno.test("mirror_ensure refuses a repository that is not a mirror", async () => {
  const h = harness({ [`GET ${R}`]: { status: 200, body: repoBody() } });
  await assertRejects(
    () =>
      B.mirror_ensure.execute({
        owner: "acme",
        name: "tool",
        cloneAddr: "https://github.com/x/tool.git",
        service: "github",
        mirrorInterval: "8h0m0s",
        lfs: true,
        private: true,
      }, h.context),
    Error,
    "is NOT a mirror",
  );
  assertEquals(writes(h.calls), []);
});

Deno.test("mirror_sync_now queues a sync", async () => {
  const h = harness({
    [`GET ${R}`]: { status: 200, body: repoBody({ mirror: true }) },
    [`POST ${R}/mirror-sync`]: { status: 200 },
  });
  await B.mirror_sync_now.execute({ owner: "acme", name: "tool" }, h.context);
  assertEquals(data(h).action, "triggered");
});

Deno.test("mirror_sync_now refuses a repository that is not a mirror", async () => {
  const h = harness({ [`GET ${R}`]: { status: 200, body: repoBody() } });
  await assertRejects(
    () => B.mirror_sync_now.execute({ owner: "acme", name: "tool" }, h.context),
    Error,
    "is not a mirror",
  );
});

Deno.test("pr_list records each pull request", async () => {
  const h = harness({
    [`GET ${R}/pulls?state=open&limit=50&page=1`]: {
      status: 200,
      body: [pull()],
    },
  });
  await B.pr_list.execute(
    { owner: "acme", name: "tool", state: "open" },
    h.context,
  );
  assertEquals([names(h), data(h).head], [["pull-acme-tool-4"], "feat"]);
});

Deno.test("pr_list passes on the forge's refusal", async () => {
  const h = harness({
    [`GET ${R}/pulls?state=open&limit=50&page=1`]: {
      status: 404,
      body: { message: "not found" },
    },
  });
  await assertRejects(
    () =>
      B.pr_list.execute(
        { owner: "acme", name: "tool", state: "open" },
        h.context,
      ),
    Error,
    "HTTP 404",
  );
});

Deno.test("pr_get records the mergeable verdict and the head's CI state", async () => {
  const h = harness({
    [`GET ${R}/pulls/4`]: { status: 200, body: pull({ mergeable: true }) },
    [`GET ${R}/commits/${"a".repeat(40)}/status`]: {
      status: 200,
      body: { state: "success" },
    },
  });
  await B.pr_get.execute({ owner: "acme", name: "tool", index: 4 }, h.context);
  assertEquals([data(h).mergeable, data(h).ciState], [true, "success"]);
});

Deno.test("pr_get names a pull request that is not there", async () => {
  const h = harness({ [`GET ${R}/pulls/4`]: { status: 404 } });
  await assertRejects(
    () =>
      B.pr_get.execute({ owner: "acme", name: "tool", index: 4 }, h.context),
    Error,
    "acme/tool#4 does not exist",
  );
});

Deno.test("pr_ensure opens a pull request for a new head and base", async () => {
  const h = harness({
    [`GET ${R}/pulls?state=open&limit=50&page=1`]: { status: 200, body: [] },
    [`POST ${R}/pulls`]: { status: 201, body: pull() },
  });
  await B.pr_ensure.execute({
    owner: "acme",
    name: "tool",
    head: "feat",
    base: "main",
    title: "T",
  }, h.context);
  assertEquals([names(h), data(h).action], [["pull-acme-tool-4"], "created"]);
});

Deno.test("pr_ensure passes on a refused create", async () => {
  const h = harness({
    [`GET ${R}/pulls?state=open&limit=50&page=1`]: { status: 200, body: [] },
    [`POST ${R}/pulls`]: {
      status: 422,
      body: { message: "no commits between" },
    },
  });
  await assertRejects(
    () =>
      B.pr_ensure.execute({
        owner: "acme",
        name: "tool",
        head: "feat",
        base: "main",
        title: "T",
      }, h.context),
    Error,
    "HTTP 422: no commits between",
  );
});

Deno.test("pr_merge merges a green, mergeable pull request and records it merged", async () => {
  let merged = false;
  const h = harness({
    [`GET ${R}/pulls/4`]: () => ({
      status: 200,
      body: pull({
        mergeable: true,
        merged,
        state: merged ? "closed" : "open",
      }),
    }),
    [`GET ${R}/commits/${"a".repeat(40)}/status`]: {
      status: 200,
      body: { state: "success" },
    },
    [`POST ${R}/pulls/4/merge`]: () => {
      merged = true;
      return { status: 200, body: {} };
    },
  });
  await B.pr_merge.execute({
    owner: "acme",
    name: "tool",
    index: 4,
    strategy: "merge",
    deleteBranch: false,
    force: false,
  }, h.context);
  assertEquals([data(h).action, data(h).merged], ["merged", true]);
});

Deno.test("pr_merge refuses a head with no CI state, writing nothing", async () => {
  const h = harness({
    [`GET ${R}/pulls/4`]: { status: 200, body: pull({ mergeable: true }) },
    [`GET ${R}/commits/${"a".repeat(40)}/status`]: {
      status: 200,
      body: { state: "" },
    },
  });
  await assertRejects(
    () =>
      B.pr_merge.execute({
        owner: "acme",
        name: "tool",
        index: 4,
        strategy: "merge",
        deleteBranch: false,
        force: false,
      }, h.context),
    Error,
    'CI state "none", not success',
  );
  assertEquals(writes(h.calls), []);
});

Deno.test("repo_archive archives, and repo_unarchive undoes it", async () => {
  const a = harness({
    [`GET ${R}`]: { status: 200, body: repoBody() },
    [`PATCH ${R}`]: { status: 200, body: repoBody({ archived: true }) },
  });
  await B.repo_archive.execute({ owner: "acme", name: "tool" }, a.context);
  assertEquals([data(a).action, writes(a.calls)[0].body], ["archived", {
    archived: true,
  }]);
  const u = harness({
    [`GET ${R}`]: { status: 200, body: repoBody({ archived: true }) },
    [`PATCH ${R}`]: { status: 200, body: repoBody() },
  });
  await B.repo_unarchive.execute({ owner: "acme", name: "tool" }, u.context);
  assertEquals(data(u).action, "unarchived");
});

Deno.test("repo_archive and repo_unarchive pass on a missing repository", async () => {
  for (const m of [B.repo_archive, B.repo_unarchive]) {
    const h = harness({
      [`GET ${R}`]: { status: 404, body: { message: "repo not found" } },
    });
    await assertRejects(
      () => m.execute({ owner: "acme", name: "tool" }, h.context),
      Error,
      "HTTP 404: repo not found",
    );
  }
});
