/**
 * Adds to `@dataverket/forgejo` the push-mirror side that upstream lacks (its
 * `mirror_ensure` is a pull mirror, Forgejo fetching from elsewhere). A push
 * mirror makes Forgejo push a repository to a remote, here GitHub, on every
 * commit and on an interval. The remote credential is a vault reference,
 * sent once to Forgejo and never recorded; Forgejo keeps it and reports only
 * the remote address, the timing and the last error.
 *
 * Find-or-create on the remote address: an existing mirror to the same
 * address is left alone (Forgejo has no update endpoint; changing interval
 * or filter means delete and recreate, which this file never does on its
 * own). The org-wide `push_mirror_list` is the audit the mirroring workflow
 * asserts on.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type ApiCall,
  call,
  type Caller,
  canonicalAddress,
  fetchCaller,
  type GlobalArgs,
} from "./api.ts";

const enc = encodeURIComponent;
const repoPath = (owner: string, repo: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}`;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");

/** One push mirror as Forgejo reports it. */
const PushMirrorInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  remoteName: z.string().describe("Forgejo's generated remote name"),
  remoteAddress: z.string().describe("Where the repository is pushed to"),
  interval: z.string().describe("Go duration; 0s means only on commit"),
  syncOnCommit: z.boolean(),
  branchFilter: z.string(),
  lastUpdate: z.string().describe("Empty until the first push"),
  lastError: z.string().describe("Empty when the last push succeeded"),
  syncQueued: z.boolean().describe(
    "Whether an immediate push was queued by this call",
  ),
  action: z.enum(["created", "unchanged", "observed"]),
  timestamp: z.string(),
});
/** {@link PushMirrorInfo} */
export type PushMirror = z.infer<typeof PushMirrorInfo>;

const PushMirrorEnsureArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login on Forgejo."),
  name: z.string().min(1).describe("Repository name on Forgejo."),
  remoteAddress: z.string().url().describe(
    "HTTPS clone URL to push to, e.g. https://github.com/<org>/<repo>.git",
  ),
  remoteUsername: z.string().min(1).default("x-access-token").describe(
    "Username sent with the token; GitHub accepts any non-empty value for a PAT.",
  ),
  remotePassword: z.string().min(1).meta({ sensitive: true }).describe(
    "Token for the remote. Supply via vault: ${{ vault.get('<vault>', '<key>') }} — quoted, which is the spelling swamp model validate recognizes. Sent once to Forgejo, never recorded.",
  ),
  interval: z.string().regex(/^\d+[hms]([0-9hms]*)$|^0s$/).default("8h0m0s")
    .describe(
      "Periodic push interval as a Go duration; 0s disables periodic pushes.",
    ),
  syncOnCommit: z.boolean().default(true).describe("Push on every commit."),
  branchFilter: z.string().optional().describe(
    "Glob of branches to push; empty pushes everything.",
  ),
  syncNow: z.boolean().default(true).describe(
    "Queue an immediate push after creating the mirror.",
  ),
});
const PushMirrorListArgs = z.object({
  owner: z.string().min(1).describe(
    "Org or user login whose repositories to audit.",
  ),
  name: z.string().min(1).optional().describe(
    "One repository; omit to audit every repository of the owner.",
  ),
});
const PushMirrorDeleteArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login on Forgejo."),
  name: z.string().min(1).describe("Repository name on Forgejo."),
  remoteAddress: z.string().url().describe(
    "Remote address of the mirror to delete.",
  ),
});
const PushMirrorDeleteInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  remoteAddress: z.string(),
  remoteName: z.string(),
  action: z.enum(["deleted", "absent"]),
  timestamp: z.string(),
});
const PushMirrorSyncArgs = z.object({
  owner: z.string().min(1),
  name: z.string().min(1),
});

function shape(
  owner: string,
  repo: string,
  m: Record<string, unknown>,
  action: PushMirror["action"],
): PushMirror {
  return {
    owner,
    repo,
    remoteName: String(m.remote_name ?? ""),
    remoteAddress: String(m.remote_address ?? ""),
    interval: String(m.interval ?? ""),
    syncOnCommit: m.sync_on_commit === true,
    branchFilter: String(m.branch_filter ?? ""),
    lastUpdate: m.last_update ? String(m.last_update) : "",
    lastError: String(m.last_error ?? ""),
    syncQueued: false,
    action,
    timestamp: new Date().toISOString(),
  };
}

/** Push mirrors of one repository, as Forgejo lists them. */
async function listMirrors(
  api: Caller,
  owner: string,
  repo: string,
): Promise<Record<string, unknown>[]> {
  // Every page: push_mirror_ensure is find-or-create over this list, so a
  // mirror past the first page would be created a second time.
  const out: Record<string, unknown>[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await call(api, {
      method: "GET",
      path: `${repoPath(owner, repo)}/push_mirrors?limit=50&page=${page}`,
    });
    const items = Array.isArray(r.body)
      ? r.body as Record<string, unknown>[]
      : [];
    out.push(...items);
    if (items.length < 50) break;
  }
  return out;
}

/**
 * Find-or-create a push mirror to `remoteAddress`. An existing mirror to the
 * same address is reported unchanged, whatever its interval or filter.
 */
export async function pushMirrorEnsure(
  api: Caller,
  a: z.infer<typeof PushMirrorEnsureArgs>,
  onSyncError?: (message: string) => void,
): Promise<PushMirror> {
  const want = canonicalAddress(a.remoteAddress);
  const existing = (await listMirrors(api, a.owner, a.name)).find((m) =>
    canonicalAddress(String(m.remote_address ?? "")) === want
  );
  if (existing) return shape(a.owner, a.name, existing, "unchanged");
  const created = await call(api, {
    method: "POST",
    path: `${repoPath(a.owner, a.name)}/push_mirrors`,
    body: {
      remote_address: a.remoteAddress,
      remote_username: a.remoteUsername,
      remote_password: a.remotePassword,
      interval: a.interval,
      sync_on_commit: a.syncOnCommit,
      ...(a.branchFilter ? { branch_filter: a.branchFilter } : {}),
    },
  });
  const info = shape(a.owner, a.name, created.body, "created");
  if (a.syncNow) {
    // Forgejo starts the first push on creation and answers the sync-now
    // request with a 500 while it runs; the mirror exists either way, so a
    // failed queueing is reported, not fatal.
    try {
      await pushMirrorSyncNow(api, { owner: a.owner, name: a.name });
      info.syncQueued = true;
    } catch (err) {
      info.syncQueued = false;
      onSyncError?.(err instanceof Error ? err.message : String(err));
    }
  }
  return info;
}

/** Queue an immediate push of every push mirror of a repository. */
export async function pushMirrorSyncNow(
  api: Caller,
  a: z.infer<typeof PushMirrorSyncArgs>,
): Promise<void> {
  await call(api, {
    method: "POST",
    path: `${repoPath(a.owner, a.name)}/push_mirrors-sync`,
  });
}

/**
 * Delete the push mirror of a repository to `remoteAddress`. Reports whether
 * one was there; a missing mirror is not an error.
 */
export async function pushMirrorDelete(
  api: Caller,
  a: { owner: string; name: string; remoteAddress: string },
): Promise<
  {
    owner: string;
    repo: string;
    remoteAddress: string;
    remoteName: string;
    action: "deleted" | "absent";
    timestamp: string;
  }
> {
  const want = canonicalAddress(a.remoteAddress);
  const existing = (await listMirrors(api, a.owner, a.name)).find((m) =>
    canonicalAddress(String(m.remote_address ?? "")) === want
  );
  const timestamp = new Date().toISOString();
  if (!existing) {
    return {
      owner: a.owner,
      repo: a.name,
      remoteAddress: a.remoteAddress,
      remoteName: "",
      action: "absent",
      timestamp,
    };
  }
  const remoteName = String(existing.remote_name ?? "");
  await call(api, {
    method: "DELETE",
    path: `${repoPath(a.owner, a.name)}/push_mirrors/${enc(remoteName)}`,
  });
  return {
    owner: a.owner,
    repo: a.name,
    remoteAddress: a.remoteAddress,
    remoteName,
    action: "deleted",
    timestamp,
  };
}

/** Pages to follow before giving up; far past any real repository count. */
const MAX_PAGES = 100;

/** Every repository of an org or user, following Forgejo's pagination. */
async function ownerRepos(api: Caller, owner: string): Promise<string[]> {
  const names: string[] = [];
  for (let page = 1; page < 100; page++) {
    const r = await api({
      method: "GET",
      path: `/api/v1/orgs/${enc(owner)}/repos?limit=50&page=${page}`,
    });
    let items: unknown[];
    if (r.status === 404) {
      const u = await call(api, {
        method: "GET",
        path: `/api/v1/users/${enc(owner)}/repos?limit=50&page=${page}`,
      });
      items = Array.isArray(u.body) ? u.body : [];
    } else if (r.status >= 400) {
      await call(api, {
        method: "GET",
        path: `/api/v1/orgs/${enc(owner)}/repos`,
      });
      items = [];
    } else {
      items = Array.isArray(r.body) ? r.body : [];
    }
    for (const it of items as Record<string, unknown>[]) {
      if (typeof it.name === "string") names.push(it.name);
    }
    if (items.length < 50) break;
  }
  return names;
}

/** Push mirrors of one repository or of every repository of an owner. */
export async function pushMirrorList(
  api: Caller,
  a: z.infer<typeof PushMirrorListArgs>,
): Promise<PushMirror[]> {
  const repos = a.name ? [a.name] : await ownerRepos(api, a.owner);
  const out: PushMirror[] = [];
  for (const repo of repos) {
    for (const m of await listMirrors(api, a.owner, repo)) {
      out.push(shape(a.owner, repo, m, "observed"));
    }
  }
  return out;
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
  deleteResource?(instanceName: string): Promise<void>;
  dataRepository?: {
    findAllForModel(
      type: string,
      modelId: string,
    ): Promise<{ name: string; tags?: Record<string, string> }[]>;
  };
  modelType?: string;
  modelId?: string;
}

/**
 * Names of the stored `pushMirror` records under `owner` (or one repository)
 * that a fresh audit did not observe: mirrors deleted since the last audit.
 */
export function staleMirrorRecords(
  stored: { name: string; tags?: Record<string, string> }[],
  owner: string,
  repo: string | undefined,
  observed: Set<string>,
): string[] {
  const prefix = safeName(repo ? `${owner}:${repo}:push-mirror:` : `${owner}:`);
  return stored
    .filter((d) => d.tags?.specName === "pushMirror")
    .map((d) => d.name)
    .filter((n) =>
      n.startsWith(prefix) && n.includes(":push-mirror:") && !observed.has(n)
    );
}

const instance = (m: PushMirror) =>
  safeName(`${m.owner}:${m.repo}:push-mirror:${m.remoteName || "new"}`);

/** Extension adding push mirrors (create, audit, sync now). */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    pushMirrorDelete: {
      description:
        "A push mirror deletion: which remote was removed from which repository.",
      schema: PushMirrorDeleteInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    pushMirror: {
      description:
        "A push mirror of a repository: remote address, timing, last push and last error. Never the credential.",
      schema: PushMirrorInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    push_mirror_ensure: {
      description:
        "Find-or-create a push mirror of a repository to a remote (GitHub, for instance). The remote token comes " +
        "from a vault reference and is sent once to Forgejo, never recorded. An existing mirror to the same " +
        "address is left unchanged.",
      arguments: PushMirrorEnsureArgs,
      execute: async (
        args: z.infer<typeof PushMirrorEnsureArgs>,
        context: Ctx,
      ) => {
        const a = PushMirrorEnsureArgs.parse(args);
        context.logger.info("Ensuring push mirror {repo} -> {remote}", {
          repo: `${a.owner}/${a.name}`,
          remote: canonicalAddress(a.remoteAddress),
        });
        const info = await pushMirrorEnsure(
          fetchCaller(context.globalArgs, context.signal),
          a,
          (message) =>
            context.logger.warning(
              "Immediate push of {repo} could not be queued: {message}",
              { repo: `${a.owner}/${a.name}`, message },
            ),
        );
        context.logger.info("Push mirror {repo} -> {remote}: {action}", {
          repo: `${a.owner}/${a.name}`,
          remote: info.remoteAddress,
          action: info.action,
        });
        const handle = await context.writeResource(
          "pushMirror",
          instance(info),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
    push_mirror_list: {
      description:
        "Audit the push mirrors of one repository or of every repository of an org or user (factory): remote, " +
        "last push and last error. Read-only.",
      arguments: PushMirrorListArgs,
      execute: async (
        args: z.infer<typeof PushMirrorListArgs>,
        context: Ctx,
      ) => {
        const a = PushMirrorListArgs.parse(args);
        const mirrors = await pushMirrorList(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        const failing = mirrors.filter((m) => m.lastError !== "");
        context.logger.info(
          "{count} push mirror(s) under {owner}, {failing} with a last error",
          {
            count: mirrors.length,
            owner: a.name ? `${a.owner}/${a.name}` : a.owner,
            failing: failing.length,
          },
        );
        const dataHandles = [];
        const observed = new Set<string>();
        for (const m of mirrors) {
          const name = instance(m);
          observed.add(name);
          dataHandles.push(await context.writeResource("pushMirror", name, m));
        }
        if (
          context.deleteResource && context.dataRepository &&
          context.modelType &&
          context.modelId
        ) {
          const stored = await context.dataRepository.findAllForModel(
            context.modelType,
            context.modelId,
          );
          for (
            const name of staleMirrorRecords(stored, a.owner, a.name, observed)
          ) {
            context.logger.info(
              "Dropping record of vanished push mirror {name}",
              { name },
            );
            await context.deleteResource(name);
          }
        }
        return { dataHandles };
      },
    },
    push_mirror_delete: {
      description:
        "Delete the push mirror of a repository to one remote address (no-op when absent). Forgejo stops " +
        "pushing; nothing on the remote is touched.",
      arguments: PushMirrorDeleteArgs,
      execute: async (
        args: z.infer<typeof PushMirrorDeleteArgs>,
        context: Ctx,
      ) => {
        const a = PushMirrorDeleteArgs.parse(args);
        context.logger.info("Deleting push mirror {repo} -> {remote}", {
          repo: `${a.owner}/${a.name}`,
          remote: canonicalAddress(a.remoteAddress),
        });
        const info = await pushMirrorDelete(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info("Push mirror {repo} -> {remote}: {action}", {
          repo: `${a.owner}/${a.name}`,
          remote: info.remoteAddress,
          action: info.action,
        });
        if (info.action === "deleted" && context.deleteResource) {
          await context.deleteResource(
            safeName(`${a.owner}:${a.name}:push-mirror:${info.remoteName}`),
          );
        }
        const handle = await context.writeResource(
          "pushMirrorDelete",
          safeName(
            `${a.owner}:${a.name}:push-mirror-delete:${
              info.remoteName || "absent"
            }`,
          ),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
    push_mirror_sync_now: {
      description:
        "Queue an immediate push of every push mirror of a repository. Additive; changes no settings.",
      arguments: PushMirrorSyncArgs,
      execute: async (
        args: z.infer<typeof PushMirrorSyncArgs>,
        context: Ctx,
      ) => {
        const a = PushMirrorSyncArgs.parse(args);
        context.logger.info("Queueing push of {repo}", {
          repo: `${a.owner}/${a.name}`,
        });
        await pushMirrorSyncNow(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        return { dataHandles: [] };
      },
    },
  }],
};

// Keep the ApiCall type referenced for readers of the seam; tests import it from here.
export type { ApiCall, Caller };
export { canonicalAddress };
