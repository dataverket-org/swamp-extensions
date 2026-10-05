/**
 * Adds to `@dataverket/forgejo` a pull mirror that states only what it is asked
 * to. Upstream's `mirror_ensure` defaults `private` to true and `lfs`,
 * `service` and the interval to its own values, and converges an existing
 * mirror to those defaults on every run, so running it without `private`
 * turns a public mirror private. `pull_mirror_ensure` sends a setting only
 * when the caller gives it: a new mirror gets Forgejo's own defaults for
 * the rest (public, unless the instance forces new repositories private),
 * and an existing one is changed only in the settings named.
 *
 * Find-or-create on owner and name. An existing repository that is not a
 * mirror is refused; an empty one is reported as the likely leftover of a
 * failed migration, never deleted. A mirror's source is fixed at migration
 * time, so a different `cloneAddr` is an error rather than a change.
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
  redactToken,
} from "./api.ts";

export type { ApiCall, Caller };

const enc = encodeURIComponent;
const repoPath = (owner: string, repo: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}`;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");

/** A Go duration such as `8h0m0s`, `10m` or `0s`. */
const GO_DURATION = /^(\d+h)?(\d+m)?(\d+s)?$/;

/** Seconds in a Go duration of hours, minutes and seconds; null if not one. */
export function goDurationSeconds(d: string): number | null {
  const m = GO_DURATION.exec(d.trim());
  if (!m || d.trim() === "") return null;
  const n = (s: string | undefined) => s ? parseInt(s, 10) : 0;
  return n(m[1]) * 3600 + n(m[2]) * 60 + n(m[3]);
}

/** A pull mirror as Forgejo reports it after the call. */
const PullMirrorInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  originalUrl: z.string().describe("The source the mirror pulls from"),
  private: z.boolean(),
  interval: z.string().describe("Go duration; 0s disables periodic sync"),
  description: z.string(),
  lastSynced: z.string().describe("Empty until the first sync"),
  changed: z.array(z.string()).describe(
    "Settings this call changed on an existing mirror",
  ),
  action: z.enum(["created", "updated", "unchanged"]),
  timestamp: z.string(),
});
/** {@link PullMirrorInfo} */
export type PullMirror = z.infer<typeof PullMirrorInfo>;

const PullMirrorEnsureArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login for the mirror."),
  name: z.string().min(1).describe(
    "Mirror repository name (find-or-create key).",
  ),
  cloneAddr: z.string().url().describe(
    "Source clone URL, e.g. https://github.com/<owner>/<repo>.git. Fixed once the mirror exists.",
  ),
  private: z.boolean().optional().describe(
    "Mirror visibility. Unset: a new mirror gets Forgejo's default (public unless the instance forces private) and an existing one keeps its own.",
  ),
  interval: z.string().regex(GO_DURATION).optional().describe(
    "Periodic sync interval as a Go duration; 0s disables it. Unset: the forge's default, or the mirror's own.",
  ),
  description: z.string().optional().describe(
    "Repository description. Unset: none on create, unchanged after.",
  ),
  lfs: z.boolean().optional().describe(
    "Mirror LFS objects too. Only used on create; unset is the forge's default.",
  ),
  service: z.enum(["git", "github", "gitea", "gitlab", "forgejo"]).optional()
    .describe(
      "Source service type, for the migration. Only used on create; unset is the forge's default.",
    ),
  authToken: z.string().min(1).optional().meta({ sensitive: true }).describe(
    "Token for a private source. Supply via vault: ${{ vault.get('<vault>', '<key>') }}. Sent once to Forgejo on create, never recorded.",
  ),
});
/** {@link PullMirrorEnsureArgs} */
export type PullMirrorEnsureArgsT = z.infer<typeof PullMirrorEnsureArgs>;

function shape(
  a: { owner: string; name: string },
  r: Record<string, unknown>,
  changed: string[],
  action: PullMirror["action"],
): PullMirror {
  const synced = String(r.mirror_updated ?? "");
  return {
    owner: a.owner,
    repo: a.name,
    originalUrl: String(r.original_url ?? ""),
    private: r.private === true,
    interval: String(r.mirror_interval ?? ""),
    description: String(r.description ?? ""),
    // Forgejo reports "never" as Go's zero time.
    lastSynced: synced.startsWith("0001-01-01") ? "" : synced,
    changed,
    action,
    timestamp: new Date().toISOString(),
  };
}

/**
 * Find-or-create a pull mirror, sending only the settings given. An existing
 * mirror is patched in the named settings that differ, and nothing else.
 */
export async function pullMirrorEnsure(
  api: Caller,
  a: PullMirrorEnsureArgsT,
): Promise<PullMirror> {
  const path = repoPath(a.owner, a.name);
  const current = await api({ method: "GET", path });
  if (current.status === 404) {
    const body: Record<string, unknown> = {
      clone_addr: a.cloneAddr,
      repo_owner: a.owner,
      repo_name: a.name,
      mirror: true,
    };
    if (a.private !== undefined) body.private = a.private;
    if (a.interval !== undefined) body.mirror_interval = a.interval;
    if (a.description !== undefined) body.description = a.description;
    if (a.lfs !== undefined) body.lfs = a.lfs;
    if (a.service !== undefined) body.service = a.service;
    if (a.authToken !== undefined) body.auth_token = a.authToken;
    let created;
    try {
      created = await call(api, {
        method: "POST",
        path: "/api/v1/repos/migrate",
        body,
      });
    } catch (err) {
      // A failed migration's message can quote the source, and a source
      // given with credentials carries the token in it.
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(redactToken(msg, a.authToken ?? ""));
    }
    return shape(a, created.body, [], "created");
  }
  if (current.status >= 400) {
    throw new Error(`Forgejo API GET ${path} -> HTTP ${current.status}`);
  }
  const r = current.body;
  if (r.mirror !== true) {
    throw new Error(
      r.empty === true
        ? `${a.owner}/${a.name} exists as an empty repository that is not a mirror: a migration still running ` +
          "(a large source can outlast the HTTP timeout) or the leftover of a failed one. Wait and run again; " +
          "only if it stays empty, delete it (repo_delete) and run pull_mirror_ensure again."
        : `${a.owner}/${a.name} exists and is not a mirror; refusing to touch it.`,
    );
  }
  const source = String(r.original_url ?? "");
  if (source && canonicalAddress(source) !== canonicalAddress(a.cloneAddr)) {
    throw new Error(
      `${a.owner}/${a.name} already mirrors ${source}, not ${a.cloneAddr}; a mirror's source cannot be changed.`,
    );
  }
  const patch: Record<string, unknown> = {};
  const changed: string[] = [];
  if (a.private !== undefined && a.private !== (r.private === true)) {
    patch.private = a.private;
    changed.push("private");
  }
  if (
    a.interval !== undefined &&
    goDurationSeconds(a.interval) !==
      goDurationSeconds(String(r.mirror_interval ?? ""))
  ) {
    patch.mirror_interval = a.interval;
    changed.push("interval");
  }
  if (
    a.description !== undefined &&
    a.description !== String(r.description ?? "")
  ) {
    patch.description = a.description;
    changed.push("description");
  }
  if (changed.length === 0) return shape(a, r, [], "unchanged");
  const updated = await call(api, { method: "PATCH", path, body: patch });
  return shape(a, updated.body, changed, "updated");
}

interface Ctx {
  globalArgs: GlobalArgs;
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

/** Extension adding a pull mirror that sends only what it is given. */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    pullMirror: {
      description:
        "A pull mirror after pull_mirror_ensure: source, visibility, interval, last sync, and what changed.",
      schema: PullMirrorInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    pull_mirror_ensure: {
      description:
        "Find-or-create a pull mirror of an external repository. Sends only the settings given: a new mirror gets " +
        "the forge's defaults for the rest, visibility included, and an existing one changes only in the settings " +
        "named. Refuses a repository that is not a mirror or mirrors another source.",
      arguments: PullMirrorEnsureArgs,
      execute: async (args: PullMirrorEnsureArgsT, context: Ctx) => {
        const a = PullMirrorEnsureArgs.parse(args);
        context.logger.info("Ensuring pull mirror {repo} <- {source}", {
          repo: `${a.owner}/${a.name}`,
          source: canonicalAddress(a.cloneAddr),
        });
        const info = await pullMirrorEnsure(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info("Pull mirror {repo}: {action} {changed}", {
          repo: `${info.owner}/${info.repo}`,
          action: info.action,
          changed: info.changed.join(","),
        });
        const handle = await context.writeResource(
          "pullMirror",
          safeName(`${info.owner}:${info.repo}:pull-mirror`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
