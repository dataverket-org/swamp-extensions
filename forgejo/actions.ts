/**
 * Adds to `@thomas/forgejo` the forge operations that reach beyond a single
 * repository: Actions secrets (repo- or org-scoped, write-only), a runner
 * registration token, runner listing and pruning, and a verify-first
 * repository rename.
 *
 * Same conventions as upstream: find-or-create, and no secret value is ever
 * recorded or logged. The one delete is `runner_prune`, which removes offline
 * runners of a given name: a runner that registers and dies before it can save
 * `.runner` leaves a record behind on every restart. The registration token is
 * the one secret this file produces; it is marked sensitive so swamp stores it
 * in the vault and records a reference, never the value.
 *
 * @module
 */
import { z } from "npm:zod@4";

import { call, type Caller, fetchCaller, type GlobalArgs } from "./api.ts";

const enc = encodeURIComponent;
const repoPath = (owner: string, repo: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}`;
/** Repo-scoped when `repo` is given, else org-scoped. */
const actionsPath = (owner: string, repo?: string) =>
  repo
    ? `${repoPath(owner, repo)}/actions`
    : `/api/v1/orgs/${enc(owner)}/actions`;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");
/** Pages of runners to follow; far past any real runner count. */
const MAX_RUNNER_PAGES = 100;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];

const ActionsSecretPutArgs = z.object({
  owner: z.string().min(1).describe(
    "Org login (org-scoped secret) or repo owner.",
  ),
  repo: z.string().min(1).optional().describe(
    "Repository name for a repo-scoped secret; omit for an org-scoped one.",
  ),
  name: z.string().regex(/^[A-Za-z_][A-Za-z0-9_]*$/).describe(
    "Secret name as the workflow reads it, e.g. COSIGN_PRIVATE_KEY.",
  ),
  value: z.string().min(1).meta({ sensitive: true }).describe(
    "Secret value. Supply via vault: ${{ vault.get(<vault>, <key>) }}. Never recorded.",
  ),
});

const ActionsSecretInfo = z.object({
  scope: z.enum(["repo", "org"]),
  target: z.string(),
  name: z.string(),
  action: z.enum(["created", "updated"]),
  timestamp: z.string(),
});

/** Create or update an Actions secret; records the name and scope only. */
export async function actionsSecretPut(
  api: Caller,
  a: z.infer<typeof ActionsSecretPutArgs>,
): Promise<z.infer<typeof ActionsSecretInfo>> {
  const r = await call(api, {
    method: "PUT",
    path: `${actionsPath(a.owner, a.repo)}/secrets/${enc(a.name)}`,
    body: { data: a.value },
  });
  return {
    scope: a.repo ? "repo" : "org",
    target: a.repo ? `${a.owner}/${a.repo}` : a.owner,
    name: a.name,
    action: r.status === 201 ? "created" : "updated",
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────── runner registration ───────────────────────────

const RunnerRegistrationTokenArgs = z.object({
  owner: z.string().min(1).describe(
    "Org login (org-wide runner) or repo owner.",
  ),
  repo: z.string().min(1).optional().describe(
    "Repository name for a repo-scoped runner; omit for an org-wide one.",
  ),
});

const RunnerRegistrationInfo = z.object({
  scope: z.enum(["repo", "org"]),
  target: z.string(),
  token: z.string().meta({ sensitive: true }),
  timestamp: z.string(),
});

/** Fetch a registration token for `forgejo-runner register`. */
export async function runnerRegistrationToken(
  api: Caller,
  a: z.infer<typeof RunnerRegistrationTokenArgs>,
): Promise<z.infer<typeof RunnerRegistrationInfo>> {
  const r = await call(api, {
    method: "GET",
    path: `${actionsPath(a.owner, a.repo)}/runners/registration-token`,
  });
  if (typeof r.body.token !== "string" || r.body.token.length === 0) {
    throw new Error("Forgejo returned no registration token");
  }
  return {
    scope: a.repo ? "repo" : "org",
    target: a.repo ? `${a.owner}/${a.repo}` : a.owner,
    token: r.body.token,
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────── runner list ───────────────────────────

const RunnerListArgs = z.object({
  owner: z.string().min(1).describe("Org login (org scope) or repo owner."),
  repo: z.string().min(1).optional().describe(
    "Repository name to list the runners visible to that repository; omit for the org's.",
  ),
});

const RunnerInfo = z.object({
  target: z.string(),
  id: z.number().int(),
  uuid: z.string(),
  name: z.string(),
  status: z.string(),
  labels: z.array(z.string()),
  ephemeral: z.boolean(),
  version: z.string(),
  level: z.enum(["instance", "org", "repo"]),
  action: z.literal("observed"),
  timestamp: z.string(),
});

/** Runners visible at a scope: name, status, and labels. Read-only. */
export async function runnerList(
  api: Caller,
  a: z.infer<typeof RunnerListArgs>,
): Promise<z.infer<typeof RunnerInfo>[]> {
  // Every page: runner_prune deletes from this list, so a runner past the
  // first page would survive every prune and keep piling up.
  const items: unknown[] = [];
  for (let page = 1; page <= MAX_RUNNER_PAGES; page++) {
    const r = await call(api, {
      method: "GET",
      path: `${
        actionsPath(a.owner, a.repo)
      }/runners?visible=true&limit=100&page=${page}`,
    });
    const batch = Array.isArray(r.body)
      ? r.body
      : Array.isArray(r.body.runners)
      ? r.body.runners
      : [];
    items.push(...batch);
    if (batch.length < 100) break;
  }
  const target = a.repo ? `${a.owner}/${a.repo}` : a.owner;
  const timestamp = new Date().toISOString();
  return (items as Record<string, unknown>[]).map((x) => ({
    target,
    id: Number(x.id),
    uuid: String(x.uuid ?? ""),
    name: String(x.name ?? ""),
    status: String(x.status ?? ""),
    labels: strings(x.labels).length
      ? strings(x.labels)
      : (Array.isArray(x.labels)
        ? (x.labels as Record<string, unknown>[]).map((l) =>
          String(l.name ?? l)
        )
        : []),
    ephemeral: x.ephemeral === true,
    version: String(x.version ?? ""),
    level: Number(x.repo_id) > 0
      ? "repo"
      : Number(x.owner_id) > 0
      ? "org"
      : "instance",
    action: "observed" as const,
    timestamp,
  }));
}

// ─────────────────────────── repo rename ───────────────────────────

const RepoRenameArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Current repository name."),
  newName: z.string().min(1).regex(/^[A-Za-z0-9_.-]+$/).describe(
    "New repository name. Forgejo keeps a redirect from the old name until it is reused.",
  ),
});

const RepoRenameInfo = z.object({
  owner: z.string(),
  from: z.string(),
  to: z.string(),
  htmlUrl: z.string(),
  cloneUrl: z.string(),
  sshUrl: z.string(),
  action: z.enum(["renamed", "unchanged"]),
  timestamp: z.string(),
});

/**
 * Rename a repository. Verify-first: the source must exist and the target
 * must not (a redirect left by an earlier rename is not a repository and
 * does not block). Reports unchanged when the name is already the target.
 */
export async function repoRename(
  api: Caller,
  a: z.infer<typeof RepoRenameArgs>,
): Promise<z.infer<typeof RepoRenameInfo>> {
  const shape = (
    r: Record<string, unknown>,
    action: "renamed" | "unchanged",
  ) => ({
    owner: a.owner,
    from: a.name,
    to: String(r.name),
    htmlUrl: String(r.html_url ?? ""),
    cloneUrl: String(r.clone_url ?? ""),
    sshUrl: String(r.ssh_url ?? ""),
    action,
    timestamp: new Date().toISOString(),
  });
  if (a.name === a.newName) {
    const same =
      (await call(api, { method: "GET", path: repoPath(a.owner, a.name) }))
        .body;
    return shape(same, "unchanged");
  }
  const source = await api({ method: "GET", path: repoPath(a.owner, a.name) });
  if (source.status === 404) {
    throw new Error(`${a.owner}/${a.name} does not exist; nothing to rename`);
  }
  if (source.status >= 400) {
    await call(api, { method: "GET", path: repoPath(a.owner, a.name) });
  }
  const target = await api({
    method: "GET",
    path: repoPath(a.owner, a.newName),
  });
  if (target.status === 200 && target.body.name === a.newName) {
    throw new Error(
      `${a.owner}/${a.newName} already exists; refusing to rename onto it`,
    );
  }
  const renamed = (await call(api, {
    method: "PATCH",
    path: repoPath(a.owner, a.name),
    body: { name: a.newName },
  })).body;
  if (renamed.name !== a.newName) {
    throw new Error(
      `rename returned name ${String(renamed.name)}, expected ${a.newName}`,
    );
  }
  return shape(renamed, "renamed");
}

// ─────────────────────────── PR merge state ───────────────────────────

const RunnerPruneArgs = z.object({
  owner: z.string().min(1).describe("Org login (org scope) or repo owner."),
  repo: z.string().min(1).optional().describe(
    "Repository name for repo-scoped runners; omit for the org's.",
  ),
  name: z.string().min(1).describe(
    "Runner name whose offline registrations are deleted.",
  ),
});

const RunnerPruneInfo = z.object({
  target: z.string(),
  name: z.string(),
  deleted: z.array(z.object({ id: z.number().int(), uuid: z.string() })),
  kept: z.array(
    z.object({ id: z.number().int(), uuid: z.string(), status: z.string() }),
  ),
  timestamp: z.string(),
});

/** Delete every offline runner called `name` at a scope; online, idle, and active ones are kept. */
export async function runnerPrune(
  api: Caller,
  a: z.infer<typeof RunnerPruneArgs>,
): Promise<z.infer<typeof RunnerPruneInfo>> {
  const runners = (await runnerList(api, { owner: a.owner, repo: a.repo }))
    .filter((r) => r.name === a.name);
  const deleted: { id: number; uuid: string }[] = [];
  const kept: { id: number; uuid: string; status: string }[] = [];
  for (const r of runners) {
    if (r.status !== "offline") {
      kept.push({ id: r.id, uuid: r.uuid, status: r.status });
      continue;
    }
    await call(api, {
      method: "DELETE",
      path: `${actionsPath(a.owner, a.repo)}/runners/${r.id}`,
    });
    deleted.push({ id: r.id, uuid: r.uuid });
  }
  return {
    target: a.repo ? `${a.owner}/${a.repo}` : a.owner,
    name: a.name,
    deleted,
    kept,
    timestamp: new Date().toISOString(),
  };
}

// ─────────────────────────── extension ───────────────────────────

interface Ctx {
  globalArgs: GlobalArgs;
  signal: AbortSignal;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

/** Extension adding Actions secrets, runner registration and pruning, and renames to @thomas/forgejo. */
export const extension = {
  type: "@thomas/forgejo",
  resources: {
    actionsSecret: {
      description: "An Actions secret's name and scope. Never the value.",
      schema: ActionsSecretInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    runnerRegistration: {
      description:
        "A runner registration token, stored in the vault; the record holds a reference.",
      schema: RunnerRegistrationInfo,
      lifetime: "infinite" as const,
      garbageCollection: 5,
      vaultName: "infra",
    },
    runnerPrune: {
      description:
        "Offline runners of one name deleted at a scope, and the live ones kept.",
      schema: RunnerPruneInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    runner: {
      description:
        "A registered Actions runner: name, online/offline status, labels, and scope.",
      schema: RunnerInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    repoRename: {
      description:
        "A repository rename: old and new name and the URLs that changed.",
      schema: RepoRenameInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    runner_list: {
      description:
        "List the Actions runners visible to a repository or an organization, with status and labels (factory). " +
        "Read-only.",
      arguments: RunnerListArgs,
      execute: async (args: z.infer<typeof RunnerListArgs>, context: Ctx) => {
        const a = RunnerListArgs.parse(args);
        const runners = await runnerList(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info("{count} runner(s) visible to {target}", {
          count: runners.length,
          target: a.repo ? `${a.owner}/${a.repo}` : a.owner,
        });
        // Several registrations can share a name (a runner that died before saving .runner
        // re-registers on every restart); a duplicated name gets its id appended.
        const dup = new Set(
          runners.map((r) => r.name).filter((n, i, all) =>
            all.indexOf(n) !== i
          ),
        );
        const dataHandles = [];
        for (const r of runners) {
          const key = !r.name
            ? String(r.id)
            : dup.has(r.name)
            ? `${r.name}:${r.id}`
            : r.name;
          dataHandles.push(
            await context.writeResource(
              "runner",
              safeName(`${r.target}:runner:${key}`),
              r,
            ),
          );
        }
        return { dataHandles };
      },
    },
    runner_prune: {
      description:
        "Delete every offline Actions runner with a given name at a repository or an organization (factory). " +
        "Runners that are online, idle, or active are kept. One call handles all of them.",
      arguments: RunnerPruneArgs,
      execute: async (args: z.infer<typeof RunnerPruneArgs>, context: Ctx) => {
        const a = RunnerPruneArgs.parse(args);
        const info = await runnerPrune(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info(
          "Runner {name} at {target}: deleted {deleted} offline, kept {kept}",
          {
            name: a.name,
            target: info.target,
            deleted: info.deleted.length,
            kept: info.kept.length,
          },
        );
        const handle = await context.writeResource(
          "runnerPrune",
          safeName(`${info.target}:runner-prune:${a.name}`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
    actions_secret_put: {
      description:
        "Create or update an Actions secret on a repository or an organization. Write-only: the value comes " +
        "from a vault reference and is never recorded or logged.",
      arguments: ActionsSecretPutArgs,
      execute: async (
        args: z.infer<typeof ActionsSecretPutArgs>,
        context: Ctx,
      ) => {
        const a = ActionsSecretPutArgs.parse(args);
        context.logger.info("Putting Actions secret {name} on {target}", {
          name: a.name,
          target: a.repo ? `${a.owner}/${a.repo}` : a.owner,
        });
        const info = await actionsSecretPut(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info("Actions secret {name}: {action}", {
          name: info.name,
          action: info.action,
        });
        const handle = await context.writeResource(
          "actionsSecret",
          safeName(`${info.target}:${info.name}`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
    repo_rename: {
      description:
        "Rename a repository. Verify-first: the source must exist and no repository may already hold the new " +
        "name. Forgejo redirects the old name (web and git over HTTPS) until it is reused; fixed remotes such " +
        "as push mirrors are not updated.",
      arguments: RepoRenameArgs,
      execute: async (args: z.infer<typeof RepoRenameArgs>, context: Ctx) => {
        const a = RepoRenameArgs.parse(args);
        context.logger.info("Renaming {from} to {to}", {
          from: `${a.owner}/${a.name}`,
          to: `${a.owner}/${a.newName}`,
        });
        const info = await repoRename(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info("Rename {to}: {action}", {
          to: `${info.owner}/${info.to}`,
          action: info.action,
        });
        const handle = await context.writeResource(
          "repoRename",
          safeName(`${info.owner}:${info.to}`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
    runner_registration_token: {
      description:
        "Fetch a registration token for a repository or organization runner, for `forgejo-runner register` " +
        "on the runner host. The token is stored in the vault; read it with `swamp vault read-secret`.",
      arguments: RunnerRegistrationTokenArgs,
      execute: async (
        args: z.infer<typeof RunnerRegistrationTokenArgs>,
        context: Ctx,
      ) => {
        const a = RunnerRegistrationTokenArgs.parse(args);
        context.logger.info("Fetching runner registration token for {target}", {
          target: a.repo ? `${a.owner}/${a.repo}` : a.owner,
        });
        const info = await runnerRegistrationToken(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        const handle = await context.writeResource(
          "runnerRegistration",
          safeName(`${info.target}:runner`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
