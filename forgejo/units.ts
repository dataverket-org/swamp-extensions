/**
 * Adds to `@thomas/forgejo` the repository units its `repo_ensure` does not
 * reach: Actions, packages and projects. Each is a switch on the repository
 * (`has_actions` and friends in Forgejo's repository object), and a workflow
 * under `.forgejo/workflows/` runs only once Actions is on.
 *
 * Sends only the units given, so a repository changes in nothing else, and
 * writes only when a given unit differs from what the forge has. Verify-first:
 * the repository is read before anything is sent, and the forge's answer is
 * read after, so a change the forge accepted but did not apply (Actions
 * disabled for the whole instance, say) is an error rather than a silent
 * no-op.
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

/** The units this method reaches, as the argument name and the forge's field. */
const UNITS = [
  ["hasActions", "has_actions"],
  ["hasPackages", "has_packages"],
  ["hasProjects", "has_projects"],
] as const;
type UnitArg = (typeof UNITS)[number][0];

/** A repository's units after the call, and which ones changed. */
const RepoUnitsInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  hasActions: z.boolean(),
  hasPackages: z.boolean(),
  hasProjects: z.boolean(),
  changed: z.array(z.string()).describe(
    "The units this call switched, by argument name",
  ),
  action: z.enum(["updated", "unchanged"]),
  timestamp: z.string(),
});
/** {@link RepoUnitsInfo} */
export type RepoUnits = z.infer<typeof RepoUnitsInfo>;

const RepoUnitsEnsureArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  hasActions: z.boolean().optional().describe(
    "Forgejo Actions on the repository, so its .forgejo/workflows run.",
  ),
  hasPackages: z.boolean().optional().describe(
    "The package registry unit.",
  ),
  hasProjects: z.boolean().optional().describe("The projects (boards) unit."),
}).refine(
  (a) => UNITS.some(([arg]) => a[arg] !== undefined),
  { message: "name at least one unit: hasActions, hasPackages or hasProjects" },
);
/** {@link RepoUnitsEnsureArgs} */
export type RepoUnitsEnsureArgsT = z.infer<typeof RepoUnitsEnsureArgs>;

function unitsOf(body: Record<string, unknown>) {
  return {
    hasActions: Boolean(body.has_actions),
    hasPackages: Boolean(body.has_packages),
    hasProjects: Boolean(body.has_projects),
  };
}

/** Switch the given units, and only those; write only on change. */
export async function repoUnitsEnsure(
  api: Caller,
  a: RepoUnitsEnsureArgsT,
): Promise<RepoUnits> {
  const path = repoPath(a.owner, a.name);
  const r = await api({ method: "GET", path });
  if (r.status === 404) {
    throw new Error(`repository ${a.owner}/${a.name} does not exist`);
  }
  if (r.status >= 400) {
    throw new Error(
      `Forgejo API GET ${path} -> HTTP ${r.status}: ${
        typeof r.body.message === "string"
          ? r.body.message
          : JSON.stringify(r.body)
      }`,
    );
  }
  const have = unitsOf(r.body);
  const body: Record<string, boolean> = {};
  const changed: UnitArg[] = [];
  for (const [arg, field] of UNITS) {
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
    return { ...base, ...have, action: "unchanged" };
  }
  const w = await call(api, { method: "PATCH", path, body });
  const now = unitsOf(w.body);
  const refused = changed.filter((arg) => now[arg] !== a[arg]);
  if (refused.length > 0) {
    throw new Error(
      `${a.owner}/${a.name}: the forge accepted the change but did not apply ${
        refused.join(", ")
      }; is the unit enabled on the instance?`,
    );
  }
  return { ...base, ...now, action: "updated" };
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

/** Extension adding repository units to @thomas/forgejo. */
export const extension = {
  type: "@thomas/forgejo",
  resources: {
    repoUnits: {
      description:
        "A repository's Actions, packages and projects units after repo_units_ensure, and which changed.",
      schema: RepoUnitsInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    repo_units_ensure: {
      description:
        "Switch a repository's Actions, packages or projects unit on or off; the units repo_ensure does not reach. " +
        "Sends only the units given and writes only when one differs. Verify-first; an unapplied change is an error.",
      arguments: RepoUnitsEnsureArgs,
      execute: async (args: RepoUnitsEnsureArgsT, context: Ctx) => {
        const a = RepoUnitsEnsureArgs.parse(args);
        const info = await repoUnitsEnsure(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info(
          "Units of {repo}: {action} ({changed})",
          {
            repo: `${info.owner}/${info.repo}`,
            action: info.action,
            changed: info.changed.join(",") || "none",
          },
        );
        const handle = await context.writeResource(
          "repoUnits",
          safeName(`${info.owner}:${info.repo}:units`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
