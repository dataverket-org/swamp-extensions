/**
 * Adds to `@thomas/forgejo` the deletion of a repository, which upstream has
 * no method for (`repo_archive` is the nearest). Verify-first, and cautious
 * by default: the repository is read before anything else, one that is
 * already gone is a no-op, and one with commits is refused unless
 * `allowContent` says so, because Forgejo has no undelete. What is recorded
 * is what was seen before the delete and what happened.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type ApiCall,
  call,
  type Caller,
  fetchCaller,
  type GlobalArgs,
} from "./api.ts";

export type { ApiCall, Caller };

const enc = encodeURIComponent;
const repoPath = (owner: string, repo: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}`;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");

/** The outcome of repo_delete: what the repository was, and what was done. */
const RepoDeleteInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  action: z.enum(["deleted", "absent"]),
  wasEmpty: z.boolean().describe(
    "Forgejo's `empty` flag before the delete; true when absent",
  ),
  description: z.string(),
  timestamp: z.string(),
});
/** {@link RepoDeleteInfo} */
export type RepoDelete = z.infer<typeof RepoDeleteInfo>;

const RepoDeleteArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  allowContent: z.boolean().default(false).describe(
    "Delete even when the repository has commits. Off by default: Forgejo has no undelete.",
  ),
});
/** {@link RepoDeleteArgs} */
export type RepoDeleteArgsT = z.infer<typeof RepoDeleteArgs>;

/** Read the repository, refuse content unless allowed, delete, report. */
export async function repoDelete(
  api: Caller,
  a: RepoDeleteArgsT,
): Promise<RepoDelete> {
  const path = repoPath(a.owner, a.name);
  const timestamp = new Date().toISOString();
  const current = await api({ method: "GET", path });
  if (current.status === 404) {
    return {
      owner: a.owner,
      repo: a.name,
      action: "absent",
      wasEmpty: true,
      description: "",
      timestamp,
    };
  }
  if (current.status >= 400) {
    throw new Error(`Forgejo API GET ${path} -> HTTP ${current.status}`);
  }
  const wasEmpty = current.body.empty === true;
  if (!wasEmpty && !a.allowContent) {
    throw new Error(
      `${a.owner}/${a.name} has commits; pass allowContent=true to delete it anyway`,
    );
  }
  await call(api, { method: "DELETE", path });
  return {
    owner: a.owner,
    repo: a.name,
    action: "deleted",
    wasEmpty,
    description: String(current.body.description ?? ""),
    timestamp,
  };
}

interface Ctx {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
    warning(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/** Extension adding repository deletion to @thomas/forgejo. */
export const extension = {
  type: "@thomas/forgejo",
  resources: {
    repoDelete: {
      description:
        "A repository deletion by repo_delete: what it was and what happened.",
      schema: RepoDeleteInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    repo_delete: {
      description:
        "Delete a repository (no-op when absent). Verify-first: the repository is read, and one with commits is " +
        "refused unless allowContent=true, since Forgejo has no undelete.",
      arguments: RepoDeleteArgs,
      execute: async (args: z.infer<typeof RepoDeleteArgs>, context: Ctx) => {
        const a = RepoDeleteArgs.parse(args);
        context.logger.info("Deleting repository {repo}", {
          repo: `${a.owner}/${a.name}`,
        });
        const info = await repoDelete(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info(
          "Repository {repo}: {action} (was empty: {empty})",
          {
            repo: `${info.owner}/${info.repo}`,
            action: info.action,
            empty: info.wasEmpty,
          },
        );
        const handle = await context.writeResource(
          "repoDelete",
          safeName(`${info.owner}:${info.repo}:delete`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
