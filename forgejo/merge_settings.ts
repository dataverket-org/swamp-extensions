/**
 * Adds to `@dataverket/forgejo` a repository's pull-request merge settings,
 * which `repo_ensure` does not reach: which merge styles the merge button
 * offers, the style it defaults to, whether a pull request's branch may be
 * updated by rebase, and the defaults a new pull request starts with.
 *
 * Sends only the settings given, so a repository changes in nothing else, and
 * writes only when a given setting differs from what the forge has. Called
 * with no setting it only reads, and records what it read. Verify-first: the
 * repository is read before anything is sent, and the forge's answer is read
 * after, so a change the forge accepted but did not apply is an error rather
 * than a silent no-op.
 *
 * The forge keeps these settings with the pull requests unit. Turning pull
 * requests off and on again resets every one of them to the forge's defaults
 * (seen on Forgejo 17.0.1), so the method refuses a repository whose pull
 * requests are off rather than turning them on. Every write also says
 * `has_pull_requests: true`, which changes nothing on a repository where they
 * are on: Gitea's API reads the merge fields only inside that flag, and
 * Forgejo 17.0.1, which applies them either way, accepts it.
 *
 * `allow_manual_merge` and `autodetect_manual_merge` are left out: Forgejo
 * accepts them but does not return them when a repository is read, so a write
 * could not be verified.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type ApiCall,
  call,
  type Caller,
  callerOf,
  type GlobalArgs,
  isFailure,
} from "./api.ts";
import { dataName, writeRecord } from "./names.ts";

export type { ApiCall, Caller };

const enc = encodeURIComponent;
const repoPath = (owner: string, repo: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}`;

/**
 * The merge styles the merge button can default to. Forgejo's own list also
 * has `manually-merged` and `rebase-update-only`, which are not merge-button
 * styles.
 */
export const MERGE_STYLES = [
  "merge",
  "rebase",
  "rebase-merge",
  "squash",
  "fast-forward-only",
] as const;
/** The update styles Forgejo knows, for `default_update_style`. */
export const UPDATE_STYLES = ["merge", "rebase"] as const;

/** The settings this method reaches, as the argument name and the forge's field. */
const SETTINGS = [
  ["allowMergeCommits", "allow_merge_commits"],
  ["allowRebase", "allow_rebase"],
  ["allowRebaseExplicit", "allow_rebase_explicit"],
  ["allowSquashMerge", "allow_squash_merge"],
  ["allowFastForwardOnlyMerge", "allow_fast_forward_only_merge"],
  ["allowRebaseUpdate", "allow_rebase_update"],
  ["defaultMergeStyle", "default_merge_style"],
  ["defaultUpdateStyle", "default_update_style"],
  ["defaultDeleteBranchAfterMerge", "default_delete_branch_after_merge"],
  ["defaultAllowMaintainerEdit", "default_allow_maintainer_edit"],
  ["ignoreWhitespaceConflicts", "ignore_whitespace_conflicts"],
] as const;
type SettingArg = (typeof SETTINGS)[number][0];
const STRING_SETTINGS: ReadonlySet<SettingArg> = new Set([
  "defaultMergeStyle",
  "defaultUpdateStyle",
]);

const reported = "null when the forge did not report it";

/** A repository's merge settings after the call, and which ones changed. */
const RepoMergeSettingsInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  hasPullRequests: z.boolean().describe(
    "The pull requests unit; the settings below only apply while it is on",
  ),
  allowMergeCommits: z.boolean().nullable().describe(reported),
  allowRebase: z.boolean().nullable().describe(reported),
  allowRebaseExplicit: z.boolean().nullable().describe(reported),
  allowSquashMerge: z.boolean().nullable().describe(reported),
  allowFastForwardOnlyMerge: z.boolean().nullable().describe(reported),
  allowRebaseUpdate: z.boolean().nullable().describe(reported),
  defaultMergeStyle: z.string().nullable().describe(reported),
  defaultUpdateStyle: z.string().nullable().describe(reported),
  defaultDeleteBranchAfterMerge: z.boolean().nullable().describe(reported),
  defaultAllowMaintainerEdit: z.boolean().nullable().describe(reported),
  ignoreWhitespaceConflicts: z.boolean().nullable().describe(reported),
  changed: z.array(z.string()).describe(
    "The settings this call changed, by argument name",
  ),
  action: z.enum(["updated", "unchanged"]),
  timestamp: z.string(),
});
/** {@link RepoMergeSettingsInfo} */
export type RepoMergeSettings = z.infer<typeof RepoMergeSettingsInfo>;

const RepoMergeSettingsEnsureArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  allowMergeCommits: z.boolean().optional().describe(
    "Offer merging with a merge commit.",
  ),
  allowRebase: z.boolean().optional().describe(
    "Offer rebase-merging, which makes new commits.",
  ),
  allowRebaseExplicit: z.boolean().optional().describe(
    "Offer rebase followed by a merge commit (--no-ff); the rebase makes new commits.",
  ),
  allowSquashMerge: z.boolean().optional().describe(
    "Offer squash-merging, which makes one new commit.",
  ),
  allowFastForwardOnlyMerge: z.boolean().optional().describe(
    "Offer fast-forward-only merging, which keeps the branch's commits.",
  ),
  allowRebaseUpdate: z.boolean().optional().describe(
    "Offer updating a pull request's branch by rebase, which rewrites its head.",
  ),
  defaultMergeStyle: z.enum(MERGE_STYLES).optional().describe(
    "The style the merge button uses when no other is chosen.",
  ),
  defaultUpdateStyle: z.enum(UPDATE_STYLES).optional().describe(
    "The style the update-branch button uses when no other is chosen.",
  ),
  defaultDeleteBranchAfterMerge: z.boolean().optional().describe(
    "Delete a pull request's branch after merge, by default.",
  ),
  defaultAllowMaintainerEdit: z.boolean().optional().describe(
    "Let maintainers edit a new pull request's branch, by default.",
  ),
  ignoreWhitespaceConflicts: z.boolean().optional().describe(
    "Ignore whitespace when checking a pull request for conflicts.",
  ),
});
/** {@link RepoMergeSettingsEnsureArgs} */
export type RepoMergeSettingsEnsureArgsT = z.infer<
  typeof RepoMergeSettingsEnsureArgs
>;

type Settings = Pick<RepoMergeSettings, SettingArg>;

function settingsOf(body: Record<string, unknown>): Settings {
  const out: Record<string, boolean | string | null> = {};
  for (const [arg, field] of SETTINGS) {
    const v = body[field];
    out[arg] = STRING_SETTINGS.has(arg)
      ? (typeof v === "string" ? v : null)
      : (typeof v === "boolean" ? v : null);
  }
  return out as Settings;
}

function forgeError(method: string, path: string, r: {
  status: number;
  body: Record<string, unknown>;
}): Error {
  return new Error(
    `Forgejo API ${method} ${path} -> HTTP ${r.status}: ${
      typeof r.body.message === "string"
        ? r.body.message
        : typeof r.body.raw === "string"
        ? r.body.raw
        : JSON.stringify(r.body)
    }`,
  );
}

/**
 * Converge the given merge settings, and only those; write only on change.
 * With no setting given, read and report.
 */
export async function repoMergeSettingsEnsure(
  api: Caller,
  a: RepoMergeSettingsEnsureArgsT,
): Promise<RepoMergeSettings> {
  const path = repoPath(a.owner, a.name);
  const full = `${a.owner}/${a.name}`;
  const r = await api({ method: "GET", path });
  if (r.status === 404) {
    throw new Error(`repository ${full} does not exist`);
  }
  if (isFailure(r.status)) throw forgeError("GET", path, r);
  const hasPullRequests = r.body.has_pull_requests === true;
  const have = settingsOf(r.body);
  const given = SETTINGS.some(([arg]) => a[arg] !== undefined);
  // With pull requests off the forge reports zero values, which a wish can
  // match by chance; refuse before comparing.
  if (given && !hasPullRequests) {
    throw new Error(
      `${full}: pull requests are off; turning them on resets the merge settings to the forge's defaults, ` +
        `so turn them on first (repo_ensure hasPullRequests=true) and run this again. Nothing was sent.`,
    );
  }
  const body: Record<string, boolean | string> = {};
  const changed: SettingArg[] = [];
  for (const [arg, field] of SETTINGS) {
    const want = a[arg];
    if (want !== undefined && want !== have[arg]) {
      body[field] = want;
      changed.push(arg);
    }
  }
  const base = {
    owner: a.owner,
    repo: a.name,
    changed: [...changed],
    timestamp: new Date().toISOString(),
  };
  if (changed.length === 0) {
    return { ...base, hasPullRequests, ...have, action: "unchanged" };
  }
  // Gitea reads the merge fields only inside has_pull_requests: true.
  body.has_pull_requests = true;
  const w = await call(api, { method: "PATCH", path, body });
  const now = settingsOf(w.body);
  const refused = SETTINGS
    .map(([arg]) => arg)
    .filter((arg) => a[arg] !== undefined && now[arg] !== a[arg]);
  if (refused.length > 0) {
    throw new Error(
      `${full}: the forge accepted the change but did not apply ${
        refused.join(", ")
      }`,
    );
  }
  const moved = SETTINGS
    .map(([arg]) => arg)
    .filter((arg) => a[arg] === undefined && now[arg] !== have[arg]);
  if (moved.length > 0) {
    throw new Error(
      `${full}: the forge also changed ${
        moved.join(", ")
      }, which were not asked for; read the repository and set them back`,
    );
  }
  if (w.body.has_pull_requests !== true) {
    throw new Error(`${full}: the forge turned pull requests off`);
  }
  return { ...base, hasPullRequests: true, ...now, action: "updated" };
}

interface Ctx {
  globalArgs: GlobalArgs;
  forgejoClient?: Caller;
  signal?: AbortSignal;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/** Extension adding a repository's merge settings. */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    repoMergeSettings: {
      description:
        "A repository's pull-request merge settings after repo_merge_settings_ensure, and which changed.",
      schema: RepoMergeSettingsInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    repo_merge_settings_ensure: {
      description:
        "Read or converge a repository's pull-request merge settings: the merge styles offered, the default style, " +
        "update by rebase, and the defaults a pull request starts with; settings repo_ensure does not reach. " +
        "Sends only the settings given and writes only when one differs; with none given it only reads. " +
        "Verify-first; an unapplied change is an error. Refuses a repository whose pull requests are off.",
      arguments: RepoMergeSettingsEnsureArgs,
      execute: async (args: RepoMergeSettingsEnsureArgsT, context: Ctx) => {
        const a = RepoMergeSettingsEnsureArgs.parse(args);
        const info = await repoMergeSettingsEnsure(
          callerOf(context),
          a,
        );
        context.logger.info(
          "Merge settings of {repo}: {action} ({changed})",
          {
            repo: `${info.owner}/${info.repo}`,
            action: info.action,
            changed: info.changed.join(",") || "none",
          },
        );
        const name = dataName("repo-merge-settings", info.owner, info.repo);
        const handle = await writeRecord(
          context,
          "repoMergeSettings",
          name,
          name,
          info,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
