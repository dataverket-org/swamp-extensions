import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  type ApiCall,
  type Caller,
  extension,
  repoMergeSettingsEnsure,
  type RepoMergeSettingsEnsureArgsT,
} from "./merge_settings.ts";

const PATH = "/api/v1/repos/acme/tool";

const MERGE_FIELDS = [
  "allow_merge_commits",
  "allow_rebase",
  "allow_rebase_explicit",
  "allow_squash_merge",
  "allow_fast_forward_only_merge",
  "allow_rebase_update",
  "default_merge_style",
  "default_update_style",
  "default_delete_branch_after_merge",
  "default_allow_maintainer_edit",
  "ignore_whitespace_conflicts",
];

type Repo = Record<string, unknown>;

/** A repository as a fresh Forgejo repository has it. */
const fresh = (): Repo => ({
  has_pull_requests: true,
  allow_merge_commits: true,
  allow_rebase: true,
  allow_rebase_explicit: true,
  allow_squash_merge: true,
  allow_fast_forward_only_merge: true,
  allow_rebase_update: true,
  default_merge_style: "merge",
  default_update_style: "merge",
  default_delete_branch_after_merge: false,
  default_allow_maintainer_edit: false,
  ignore_whitespace_conflicts: false,
});

/**
 * A forge as strict as the strictest API this method meets: GET answers
 * with the repository; PATCH applies the merge fields only when the same
 * body says `has_pull_requests: true`, as Gitea does, and drops them
 * silently otherwise (Forgejo 17.0.1 applies them either way); any field it does not know is a 422. `applies` false models a
 * forge that accepts and ignores; `sideEffect` one that changes a field it
 * was not asked to.
 */
function fakeApi(
  repo: Repo | undefined,
  opts: {
    applies?: boolean;
    patchStatus?: number;
    sideEffect?: Repo;
    getStatus?: number;
  } = {},
): { api: Caller; calls: ApiCall[]; state: Repo | undefined } {
  const calls: ApiCall[] = [];
  const state = repo ? { ...repo } : undefined;
  const api: Caller = (c) => {
    calls.push(c);
    if (c.path !== PATH || !state) {
      return Promise.resolve({ status: 404, body: { message: "not found" } });
    }
    if (c.method === "GET") {
      if (opts.getStatus) {
        return Promise.resolve({
          status: opts.getStatus,
          body: { message: "token expired" },
        });
      }
      return Promise.resolve({ status: 200, body: { ...state } });
    }
    if (c.method === "PATCH") {
      if (opts.patchStatus) {
        return Promise.resolve({
          status: opts.patchStatus,
          body: { message: "user does not have write access" },
        });
      }
      const b = c.body as Repo;
      for (const k of Object.keys(b)) {
        if (k !== "has_pull_requests" && !MERGE_FIELDS.includes(k)) {
          return Promise.resolve({
            status: 422,
            body: { message: `unknown field ${k}` },
          });
        }
      }
      if (b.has_pull_requests !== undefined) {
        state.has_pull_requests = b.has_pull_requests;
      }
      if (opts.applies !== false && b.has_pull_requests === true) {
        for (const k of MERGE_FIELDS) if (k in b) state[k] = b[k];
      }
      if (opts.sideEffect) Object.assign(state, opts.sideEffect);
      return Promise.resolve({ status: 200, body: { ...state } });
    }
    return Promise.resolve({ status: 405, body: { message: "method" } });
  };
  return { api, calls, state };
}

const args = (
  s: Partial<Omit<RepoMergeSettingsEnsureArgsT, "owner" | "name">> = {},
): RepoMergeSettingsEnsureArgsT => ({ owner: "acme", name: "tool", ...s });

/** Merge commits only: what a repository whose commits must stay as they are wants. */
const mergeOnly = {
  allowMergeCommits: true,
  defaultMergeStyle: "merge" as const,
  allowRebase: false,
  allowRebaseExplicit: false,
  allowSquashMerge: false,
  allowRebaseUpdate: false,
};

Deno.test("only the differing settings are sent, inside has_pull_requests: true", async () => {
  const { api, calls } = fakeApi(fresh());
  const info = await repoMergeSettingsEnsure(api, args(mergeOnly));
  assertEquals(info.action, "updated");
  assertEquals(info.changed, [
    "allowRebase",
    "allowRebaseExplicit",
    "allowSquashMerge",
    "allowRebaseUpdate",
  ]);
  assertEquals(calls.map((c) => c.method), ["GET", "PATCH"]);
  assertEquals(calls[1].body, {
    allow_rebase: false,
    allow_rebase_explicit: false,
    allow_squash_merge: false,
    allow_rebase_update: false,
    has_pull_requests: true,
  });
  assertEquals(info.allowMergeCommits, true);
  assertEquals(info.allowRebase, false);
  assertEquals(info.allowFastForwardOnlyMerge, true);
  assertEquals(info.defaultMergeStyle, "merge");
});

Deno.test("a second run with the same settings writes nothing", async () => {
  const { api, calls } = fakeApi(fresh());
  await repoMergeSettingsEnsure(api, args(mergeOnly));
  const again = await repoMergeSettingsEnsure(api, args(mergeOnly));
  assertEquals(again.action, "unchanged");
  assertEquals(again.changed, []);
  assertEquals(calls.map((c) => c.method), ["GET", "PATCH", "GET"]);
});

Deno.test("with no setting given it only reads, and reports every setting", async () => {
  const { api, calls } = fakeApi(fresh());
  const info = await repoMergeSettingsEnsure(api, args());
  assertEquals(info.action, "unchanged");
  assertEquals(calls.map((c) => c.method), ["GET"]);
  assertEquals(info.hasPullRequests, true);
  assertEquals(info.allowRebaseUpdate, true);
  assertEquals(info.defaultUpdateStyle, "merge");
  assertEquals(info.ignoreWhitespaceConflicts, false);
});

Deno.test("a string setting is compared and sent like the others", async () => {
  const { api, calls } = fakeApi(fresh());
  const info = await repoMergeSettingsEnsure(
    api,
    args({ defaultMergeStyle: "squash", defaultUpdateStyle: "rebase" }),
  );
  assertEquals(info.defaultMergeStyle, "squash");
  assertEquals(info.defaultUpdateStyle, "rebase");
  assertEquals(calls[1].body, {
    default_merge_style: "squash",
    default_update_style: "rebase",
    has_pull_requests: true,
  });
});

Deno.test("a repository with pull requests off is refused, and nothing is sent", async () => {
  const { api, calls, state } = fakeApi({
    ...fresh(),
    has_pull_requests: false,
  });
  await assertRejects(
    () => repoMergeSettingsEnsure(api, args({ allowRebase: false })),
    Error,
    "pull requests are off",
  );
  assertEquals(calls.map((c) => c.method), ["GET"]);
  assertEquals(state?.has_pull_requests, false);
});

/** What the forge reports for a repository without the pull requests unit: zero values. */
const prOff = (): Repo => ({
  has_pull_requests: false,
  allow_merge_commits: false,
  allow_rebase: false,
  allow_rebase_explicit: false,
  allow_squash_merge: false,
  allow_fast_forward_only_merge: false,
  allow_rebase_update: false,
  default_merge_style: "merge",
  default_update_style: "merge",
  default_delete_branch_after_merge: false,
  default_allow_maintainer_edit: false,
  ignore_whitespace_conflicts: false,
});

Deno.test("pull requests off are refused even when every wish matches the zero values", async () => {
  const { api, calls } = fakeApi(prOff());
  await assertRejects(
    () =>
      repoMergeSettingsEnsure(
        api,
        args({
          allowRebase: false,
          allowSquashMerge: false,
          allowRebaseUpdate: false,
          defaultMergeStyle: "merge",
        }),
      ),
    Error,
    "pull requests are off",
  );
  assertEquals(calls.map((c) => c.method), ["GET"]);
});

Deno.test("a repository with pull requests off can still be read", async () => {
  const { api } = fakeApi({ ...fresh(), has_pull_requests: false });
  const info = await repoMergeSettingsEnsure(api, args());
  assertEquals(info.hasPullRequests, false);
  assertEquals(info.action, "unchanged");
});

Deno.test("a missing repository is named, and nothing is written", async () => {
  const { api, calls } = fakeApi(undefined);
  await assertRejects(
    () => repoMergeSettingsEnsure(api, args({ allowRebase: false })),
    Error,
    "acme/tool does not exist",
  );
  assertEquals(calls.map((c) => c.method), ["GET"]);
});

Deno.test("a refused read carries the forge's message, and nothing is written", async () => {
  const { api, calls } = fakeApi(fresh(), { getStatus: 401 });
  await assertRejects(
    () => repoMergeSettingsEnsure(api, args({ allowRebase: false })),
    Error,
    "HTTP 401: token expired",
  );
  assertEquals(calls.map((c) => c.method), ["GET"]);
});

Deno.test("a change the forge accepts but does not apply is an error", async () => {
  const { api } = fakeApi(fresh(), { applies: false });
  await assertRejects(
    () => repoMergeSettingsEnsure(api, args({ allowRebase: false })),
    Error,
    "did not apply allowRebase",
  );
});

Deno.test("a given setting that already matched but moved in the write is an error", async () => {
  const { api } = fakeApi(fresh(), {
    sideEffect: { allow_merge_commits: false },
  });
  await assertRejects(
    () =>
      repoMergeSettingsEnsure(
        api,
        args({ allowMergeCommits: true, allowRebase: false }),
      ),
    Error,
    "did not apply allowMergeCommits",
  );
});

Deno.test("a setting not asked for that the write moved is an error", async () => {
  const { api } = fakeApi(fresh(), {
    sideEffect: { default_merge_style: "rebase" },
  });
  await assertRejects(
    () => repoMergeSettingsEnsure(api, args({ allowSquashMerge: false })),
    Error,
    "also changed defaultMergeStyle",
  );
});

Deno.test("a write that turns pull requests off is an error", async () => {
  const { api } = fakeApi(fresh(), {
    sideEffect: { has_pull_requests: false },
  });
  await assertRejects(
    () => repoMergeSettingsEnsure(api, args({ allowSquashMerge: false })),
    Error,
    "turned pull requests off",
  );
});

Deno.test("a refused PATCH carries the forge's message", async () => {
  const { api } = fakeApi(fresh(), { patchStatus: 403 });
  await assertRejects(
    () => repoMergeSettingsEnsure(api, args({ allowRebase: false })),
    Error,
    "HTTP 403: user does not have write access",
  );
});

Deno.test("a setting the forge does not report is recorded as null, and a write to it is an error", async () => {
  const old = fresh();
  delete old.allow_fast_forward_only_merge;
  const { api: readApi } = fakeApi(old);
  const info = await repoMergeSettingsEnsure(readApi, args());
  assertEquals(info.allowFastForwardOnlyMerge, null);
  // an older forge that drops the field it does not know
  const calls: ApiCall[] = [];
  const api: Caller = (c) => {
    calls.push(c);
    return Promise.resolve({ status: 200, body: { ...old } });
  };
  await assertRejects(
    () =>
      repoMergeSettingsEnsure(api, args({ allowFastForwardOnlyMerge: false })),
    Error,
    "did not apply allowFastForwardOnlyMerge",
  );
});

Deno.test("owner and name are URL-encoded in the path", async () => {
  const calls: ApiCall[] = [];
  const api: Caller = (c) => {
    calls.push(c);
    return Promise.resolve({ status: 200, body: fresh() });
  };
  await repoMergeSettingsEnsure(api, { owner: "a b", name: "t/ool" });
  assertEquals(calls[0].path, "/api/v1/repos/a%20b/t%2Fool");
});

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

Deno.test("the record is written under repo-merge-settings-<owner>-<repo>, and the token reaches neither record nor log", async () => {
  const TOKEN = "t0ken-planted-x";
  const written: [string, string, unknown][] = [];
  const logged: unknown[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(new Response(JSON.stringify(fresh()), { status: 200 }));
  try {
    await method.execute({ owner: "acme", name: "tool" }, {
      globalArgs: { apiUrl: "https://forge.example", token: TOKEN },
      logger: { info: (m, p) => logged.push([m, p]) },
      writeResource: (spec, name, data) => {
        written.push([spec, name, data]);
        return Promise.resolve({ name });
      },
    });
  } finally {
    globalThis.fetch = realFetch;
  }
  assertEquals(written.map(([s, n]) => [s, n]), [[
    "repoMergeSettings",
    "repo-merge-settings-acme-tool",
  ]]);
  assertEquals(JSON.stringify([written, logged]).includes(TOKEN), false);
});

Deno.test("a forge error that echoes the token is masked in the error", async () => {
  const TOKEN = "t0ken-planted-x";
  const realFetch = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(`access token does not exist [sha: ${TOKEN}]`, {
        status: 401,
      }),
    );
  try {
    const err = await assertRejects(() =>
      method.execute({ owner: "acme", name: "tool" }, {
        globalArgs: { apiUrl: "https://forge.example", token: TOKEN },
        logger: { info: () => {} },
        writeResource: (_s, name) => Promise.resolve({ name }),
      })
    );
    const msg = String((err as Error).message);
    assertEquals(msg.includes(TOKEN), false);
    assertEquals(msg.includes("access token does not exist"), true);
  } finally {
    globalThis.fetch = realFetch;
  }
});
