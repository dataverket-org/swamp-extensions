/**
 * The repository settings of `@dataverket/github` that `ensureRepo` in
 * `github.ts` does not cover: the branches a repository has, converging its
 * default branch, and a verify-first delete. Both are needed by the forge-to-GitHub mirroring workflow: a push
 * mirror from a repository whose default branch is not `main` is rejected
 * by GitHub as long as GitHub's default branch is one the mirror does not
 * carry ("refusing to delete the current branch").
 *
 * Talks to the GitHub REST API directly with the model's token; the token is
 * never recorded. Find-or-converge: `default_branch_ensure` reports
 * unchanged when the default already matches, and refuses to point at a
 * branch the repository does not have.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** One REST request against the GitHub API. */
export interface ApiCall {
  method: "GET" | "PATCH" | "DELETE";
  path: string;
  body?: unknown;
}

/** Status plus parsed JSON body (`{}` when empty, an array for lists). */
export interface ApiResult {
  status: number;
  body: unknown;
}

/** The authenticated-call seam; swapped for a fake in tests. */
export type Caller = (call: ApiCall) => Promise<ApiResult>;

/** The `@dataverket/github` global arguments this module reads. */
export interface GlobalArgs {
  token: string;
  owner: string;
  baseUrl?: string;
}

/**
 * Mask the token wherever the API echoes it back. GitHub itself answers a bad
 * credential without repeating it, but a proxy or a self-hosted endpoint in
 * front of `baseUrl` may not, and this is the one place a response becomes
 * data, so masking here covers every caller.
 */
/** Below this length a "token" is not a credential, and masking it corrupts text. */
const MIN_REDACTABLE = 8;

export function redactToken(text: string, token: string): string {
  // Short enough to be a substring of ordinary prose is short enough to
  // mangle it: a token of "t" would turn "Not Found" into "No[REDACTED] Found".
  // Nothing that short is a real credential, so leave it alone.
  if (!token || token.length < MIN_REDACTABLE) return text;
  return text.split(token).join("[REDACTED]");
}

/** A {@link Caller} over `fetch` against api.github.com (or `baseUrl`). */
export function fetchCaller(g: GlobalArgs, signal?: AbortSignal): Caller {
  const base = (g.baseUrl ?? "https://api.github.com").replace(/\/+$/, "");
  return async (c) => {
    const res = await fetch(`${base}${c.path}`, {
      method: c.method,
      headers: {
        authorization: `Bearer ${g.token}`,
        accept: "application/vnd.github+json",
        "x-github-api-version": "2022-11-28",
        ...(c.body !== undefined ? { "content-type": "application/json" } : {}),
      },
      body: c.body !== undefined ? JSON.stringify(c.body) : undefined,
      signal,
    });
    const text = redactToken(await res.text(), g.token);
    let body: unknown = {};
    if (text) {
      try {
        body = JSON.parse(text);
      } catch {
        body = { raw: text };
      }
    }
    return { status: res.status, body };
  };
}

async function call(api: Caller, c: ApiCall): Promise<ApiResult> {
  const r = await api(c);
  if (r.status >= 400) {
    const b = (r.body ?? {}) as Record<string, unknown>;
    const msg = typeof b.message === "string" ? b.message : JSON.stringify(b);
    throw new Error(
      `GitHub API ${c.method} ${c.path} -> HTTP ${r.status}: ${msg}`,
    );
  }
  return r;
}

const enc = encodeURIComponent;
const repoPath = (owner: string, repo: string) =>
  `/repos/${enc(owner)}/${enc(repo)}`;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");
/** Pages of 100 branches to follow; 10000 branches is far past any real repo. */
const MAX_BRANCH_PAGES = 100;

const BranchesInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  defaultBranch: z.string().describe("Empty for a repository with no commits"),
  branches: z.array(z.string()),
  truncated: z.boolean().describe(
    "True when the repository has more branches than the page cap allows listing",
  ),
  timestamp: z.string(),
});
const DefaultBranchInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  defaultBranch: z.string(),
  action: z.enum(["updated", "unchanged"]),
  timestamp: z.string(),
});

const BranchesArgs = z.object({
  name: z.string().min(1).describe("Repository name under the model's owner."),
});
const DefaultBranchArgs = z.object({
  name: z.string().min(1).describe("Repository name under the model's owner."),
  defaultBranch: z.string().min(1).describe(
    "Branch that should be the default.",
  ),
});

/** Every branch of a repository and its current default. */
export async function branchesList(
  api: Caller,
  owner: string,
  a: z.infer<typeof BranchesArgs>,
): Promise<z.infer<typeof BranchesInfo>> {
  const repo =
    (await call(api, { method: "GET", path: repoPath(owner, a.name) }))
      .body as Record<string, unknown>;
  // Every page, not just the first: default_branch_ensure decides whether a
  // branch exists from this list, so a repository past one page would have a
  // branch it really has refused as missing.
  const branches: string[] = [];
  // Stays true only if every page up to the cap was full: then there may be
  // more, and the record says so instead of passing a shortfall off as the
  // whole list.
  let truncated = true;
  for (let page = 1; page <= MAX_BRANCH_PAGES; page++) {
    const list = (await call(api, {
      method: "GET",
      path: `${repoPath(owner, a.name)}/branches?per_page=100&page=${page}`,
    })).body;
    const items = Array.isArray(list) ? list as Record<string, unknown>[] : [];
    for (const b of items) {
      const n = String(b.name ?? "");
      if (n.length > 0) branches.push(n);
    }
    if (items.length < 100) {
      truncated = false;
      break;
    }
  }
  return {
    owner,
    repo: a.name,
    defaultBranch: branches.length ? String(repo.default_branch ?? "") : "",
    branches,
    truncated,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Make `defaultBranch` the repository's default. Unchanged when it already
 * is; refuses when the repository has no branch of that name.
 */
export async function defaultBranchEnsure(
  api: Caller,
  owner: string,
  a: z.infer<typeof DefaultBranchArgs>,
): Promise<z.infer<typeof DefaultBranchInfo>> {
  const current = await branchesList(api, owner, { name: a.name });
  const timestamp = new Date().toISOString();
  if (current.defaultBranch === a.defaultBranch) {
    return {
      owner,
      repo: a.name,
      defaultBranch: a.defaultBranch,
      action: "unchanged",
      timestamp,
    };
  }
  if (!current.branches.includes(a.defaultBranch)) {
    throw new Error(
      `${owner}/${a.name} has no branch ${a.defaultBranch} (has: ${
        current.branches.join(", ") || "none"
      }); ` +
        "push the mirror first",
    );
  }
  await call(api, {
    method: "PATCH",
    path: repoPath(owner, a.name),
    body: { default_branch: a.defaultBranch },
  });
  return {
    owner,
    repo: a.name,
    defaultBranch: a.defaultBranch,
    action: "updated",
    timestamp,
  };
}

const RepoDeleteArgs = z.object({
  name: z.string().min(1).describe("Repository name under the model's owner."),
  expectMirrorOf: z.string().optional().describe(
    "Refuse unless the repository's description or homepage mentions this, e.g. the forge URL of a stale twin.",
  ),
});
const RepoDeleteInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  action: z.enum(["deleted", "absent"]),
  timestamp: z.string(),
});

/**
 * Delete a repository under the model's owner. Verify-first: absent is
 * reported, not an error; with `expectMirrorOf` the repository must mention
 * that text so a typo cannot delete the wrong repository.
 */
export async function repoDelete(
  api: Caller,
  owner: string,
  a: z.infer<typeof RepoDeleteArgs>,
): Promise<z.infer<typeof RepoDeleteInfo>> {
  const timestamp = new Date().toISOString();
  const r = await api({ method: "GET", path: repoPath(owner, a.name) });
  if (r.status === 404) {
    return { owner, repo: a.name, action: "absent", timestamp };
  }
  if (r.status >= 400) {
    await call(api, { method: "GET", path: repoPath(owner, a.name) });
  }
  const repo = (r.body ?? {}) as Record<string, unknown>;
  if (a.expectMirrorOf) {
    const haystack = `${String(repo.description ?? "")} ${
      String(repo.homepage ?? "")
    }`;
    if (!haystack.includes(a.expectMirrorOf)) {
      throw new Error(
        `${owner}/${a.name} does not mention ${a.expectMirrorOf} in its description or homepage; refusing to delete`,
      );
    }
  }
  await call(api, { method: "DELETE", path: repoPath(owner, a.name) });
  return { owner, repo: a.name, action: "deleted", timestamp };
}

interface Ctx {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/** Branch listing, default-branch convergence, delete and a live check on `@dataverket/github`. */
export const extension = {
  type: "@dataverket/github",
  checks: [{
    "github-token-accepted": {
      description:
        "api.github.com answers and the token is still accepted for the model's owner",
      labels: ["live"],
      execute: async (
        context: { globalArgs: GlobalArgs; signal?: AbortSignal },
      ) => {
        // A check receives the definition as written, without the schema's
        // defaults, so baseUrl is undefined here even though the schema gives
        // it https://api.github.com. fetchCaller supplies that fallback
        // itself, which is why it can be used unchanged.
        if (!context.globalArgs.token) {
          return { pass: false, errors: ["globalArguments.token is not set"] };
        }
        if (!context.globalArgs.owner) {
          return { pass: false, errors: ["globalArguments.owner is not set"] };
        }
        try {
          const api = fetchCaller(context.globalArgs, context.signal);
          const me = (await call(api, { method: "GET", path: "/user" }))
            .body as Record<string, unknown>;
          if (typeof me.login !== "string" || !me.login) {
            return {
              pass: false,
              errors: ["GitHub answered /user without a login"],
            };
          }
          // the owner is what every path is built from; a token that works but
          // cannot see the owner fails later, in the middle of a method
          await call(api, {
            method: "GET",
            path: `/users/${encodeURIComponent(context.globalArgs.owner)}`,
          });
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [err instanceof Error ? err.message : String(err)],
          };
        }
      },
    },
  }],
  resources: {
    repoDelete: {
      description: "A repository deletion under the model's owner.",
      schema: RepoDeleteInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    branches: {
      description: "A repository's branches and its default branch.",
      schema: BranchesInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    defaultBranch: {
      description:
        "A default-branch convergence: which branch is now the default and whether it changed.",
      schema: DefaultBranchInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: [{
    repo_delete: {
      description:
        "Delete a repository under the model's owner (no-op when absent). Verify-first; with expectMirrorOf the " +
        "repository must mention that text. GitHub keeps deleted organisation repositories restorable for 90 days.",
      arguments: RepoDeleteArgs,
      execute: async (args: z.infer<typeof RepoDeleteArgs>, context: Ctx) => {
        const a = RepoDeleteArgs.parse(args);
        context.logger.info("Deleting repository {repo}", {
          repo: `${context.globalArgs.owner}/${a.name}`,
        });
        const info = await repoDelete(
          fetchCaller(context.globalArgs, context.signal),
          context.globalArgs.owner,
          a,
        );
        context.logger.info("Repository {repo}: {action}", {
          repo: `${info.owner}/${info.repo}`,
          action: info.action,
        });
        const handle = await context.writeResource(
          "repoDelete",
          safeName(`${info.owner}:${info.repo}:delete`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
    branches_list: {
      description:
        "List a repository's branches and its default branch. Read-only.",
      arguments: BranchesArgs,
      execute: async (args: z.infer<typeof BranchesArgs>, context: Ctx) => {
        const a = BranchesArgs.parse(args);
        const info = await branchesList(
          fetchCaller(context.globalArgs, context.signal),
          context.globalArgs.owner,
          a,
        );
        context.logger.info("{repo}: {count} branch(es), default {default}", {
          repo: `${info.owner}/${info.repo}`,
          count: info.branches.length,
          default: info.defaultBranch || "(none)",
        });
        const handle = await context.writeResource(
          "branches",
          safeName(`${info.owner}:${info.repo}:branches`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
    default_branch_ensure: {
      description:
        "Make a branch the repository's default (unchanged when it already is). Refuses a branch the repository " +
        "does not have, so run it after the first mirror push.",
      arguments: DefaultBranchArgs,
      execute: async (
        args: z.infer<typeof DefaultBranchArgs>,
        context: Ctx,
      ) => {
        const a = DefaultBranchArgs.parse(args);
        const info = await defaultBranchEnsure(
          fetchCaller(context.globalArgs, context.signal),
          context.globalArgs.owner,
          a,
        );
        context.logger.info("{repo} default branch {branch}: {action}", {
          repo: `${info.owner}/${info.repo}`,
          branch: info.defaultBranch,
          action: info.action,
        });
        const handle = await context.writeResource(
          "defaultBranch",
          safeName(`${info.owner}:${info.repo}:default-branch`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
