/**
 * Adds to `@dataverket/forgejo` an organization's teams: a team found or
 * created with the access it gives per repository unit, a member added, a
 * repository added, and one team read back with its members and repositories.
 * Upstream has none.
 *
 * Everything here adds: no method removes a team, a member or a repository,
 * and a unit not named in `unitsMap` is given no access, so a rerun with the
 * same arguments writes nothing. A team here grants `read` or `write` per
 * unit; a team with administrator access, and the Owners team, are left to a
 * person, since either lets its members remove a branch rule: no method here
 * changes one, or adds a member or a repository to one.
 *
 * Forgejo answers a member or a repository that is not in a team with 404,
 * the same as a team or a user that does not exist, so each write is read
 * back and a name the forge did not take is an error that names it.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type ApiCall,
  type ApiResult,
  call,
  type Caller,
  callerOf,
  failure,
  type GlobalArgs,
} from "./api.ts";
import { dataName, writeRecord } from "./names.ts";

export type { ApiCall, Caller };

const enc = encodeURIComponent;
const PAGE = 50;
const MAX_PAGES = 20;
const OWNERS = "Owners";

const Access = z.enum(["none", "read", "write"]);
const UNIT = /^repo\.[a-z_]+$/;

const obj = (v: unknown): Record<string, unknown> =>
  v !== null && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};
const items = (v: unknown): Record<string, unknown>[] =>
  Array.isArray(v) ? v.map(obj) : [];

/** A unit map with every unit that grants nothing left out, keys sorted. */
export function grants(map: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  for (const k of Object.keys(obj(map)).sort()) {
    const v = String(obj(map)[k]);
    if (v !== "none" && v !== "") out[k] = v;
  }
  return out;
}

/** Whether two unit maps grant the same, a unit at `none` counting as absent. */
export function sameGrants(a: unknown, b: unknown): boolean {
  return JSON.stringify(grants(a)) === JSON.stringify(grants(b));
}

/** The general permission Forgejo wants beside a unit map: the highest in it. */
export function highest(map: Record<string, string>): "read" | "write" {
  return Object.values(map).some((v) => v === "write") ? "write" : "read";
}

/** Every item of a paged list. */
async function listAll(
  api: Caller,
  path: string,
): Promise<Record<string, unknown>[]> {
  const out: Record<string, unknown>[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await call(api, {
      method: "GET",
      path: `${path}?limit=${PAGE}&page=${page}`,
    });
    const got = items(r.body);
    out.push(...got);
    if (got.length < PAGE) break;
  }
  return out;
}

/**
 * The organization's team of that name, or null. Forgejo holds no two teams
 * whose names differ only by case, so a name in another case is an error that
 * gives the forge's spelling: a caller that compares names sees one spelling.
 */
export async function findTeam(
  api: Caller,
  org: string,
  name: string,
): Promise<Record<string, unknown> | null> {
  const teams = await listAll(api, `/api/v1/orgs/${enc(org)}/teams`);
  const want = name.toLowerCase();
  const team = teams.find((t) => String(t.name ?? "").toLowerCase() === want);
  if (team === undefined) return null;
  if (team.name !== name) {
    throw new Error(
      `${org}: the team is named ${JSON.stringify(team.name)}, not ${
        JSON.stringify(name)
      }. Use the forge's spelling. Nothing was sent.`,
    );
  }
  return team;
}

/** Whether a team lets its members remove a branch rule: the Owners team, or administrator access. */
export function administers(team: Record<string, unknown>): boolean {
  const p = String(team.permission ?? "");
  return p === "admin" || p === "owner" ||
    String(team.name ?? "").toLowerCase() === OWNERS.toLowerCase();
}

/** The team, or an error that says it is not there. */
async function requireTeam(
  api: Caller,
  org: string,
  name: string,
): Promise<Record<string, unknown>> {
  const team = await findTeam(api, org, name);
  if (team === null) {
    throw new Error(
      `${org}: there is no team named ${
        JSON.stringify(name)
      }. Make it first (team_ensure).`,
    );
  }
  return team;
}

/** The team to add to, or an error: one that administers is given its members and repositories by a person. */
async function requireAddable(
  api: Caller,
  org: string,
  name: string,
): Promise<Record<string, unknown>> {
  const team = await requireTeam(api, org, name);
  if (administers(team)) {
    throw new Error(
      `${org}/${
        String(team.name)
      } is the Owners team or has administrator access; nothing is added to it here. Nothing was sent.`,
    );
  }
  return team;
}

/** A GET whose 404 is an answer, not an error. */
async function present(api: Caller, path: string): Promise<boolean> {
  const c: ApiCall = { method: "GET", path };
  const r: ApiResult = await api(c);
  if (r.status === 404) return false;
  if (r.status >= 300) throw failure(c, r);
  return true;
}

const TeamEnsureArgs = z.object({
  org: z.string().min(1).describe("The organization the team belongs to."),
  name: z.string().min(1).describe("Team name (find-or-create key)."),
  description: z.string().optional().describe(
    "What the team is for. Left as it is when not given.",
  ),
  unitsMap: z.record(z.string().regex(UNIT), Access).describe(
    "The access the team gives, per repository unit: repo.code, repo.issues, repo.pulls, " +
      "repo.releases, repo.wiki, repo.projects, repo.packages, repo.actions, each none, read or write. " +
      "Converged as the whole map: a unit not named is given no access.",
  ),
  includesAllRepositories: z.coerce.boolean().default(false).describe(
    "True gives the team every repository of the organization, those made later included. " +
      "False gives it only the repositories added to it (team_repo_ensure).",
  ),
  canCreateOrgRepo: z.coerce.boolean().default(false).describe(
    "Whether a member may create repositories in the organization.",
  ),
});
/** {@link TeamEnsureArgs} */
export type TeamEnsureArgsT = z.infer<typeof TeamEnsureArgs>;

const TeamInfo = z.object({
  org: z.string(),
  id: z.number().int(),
  name: z.string(),
  description: z.string(),
  permission: z.string().describe(
    "The team's general permission as the forge reports it.",
  ),
  unitsMap: z.record(z.string(), z.string()).describe(
    "The units the team has access to; a unit with no access is left out.",
  ),
  includesAllRepositories: z.boolean(),
  canCreateOrgRepo: z.boolean(),
  members: z.array(z.string()).optional().describe(
    "Logins in the team; only in a record team_get wrote.",
  ),
  repositories: z.array(z.string()).optional().describe(
    "Full names of the team's repositories; only in a record team_get wrote.",
  ),
  action: z.enum(["created", "updated", "unchanged", "observed"]),
  timestamp: z.string(),
});
/** {@link TeamInfo} */
export type Team = z.infer<typeof TeamInfo>;

function toTeam(
  org: string,
  t: Record<string, unknown>,
  action: Team["action"],
): Team {
  return {
    org,
    id: Number(t.id),
    name: String(t.name ?? ""),
    description: String(t.description ?? ""),
    permission: String(t.permission ?? ""),
    unitsMap: grants(t.units_map),
    includesAllRepositories: t.includes_all_repositories === true,
    canCreateOrgRepo: t.can_create_org_repo === true,
    action,
    timestamp: new Date().toISOString(),
  };
}

/** Find-or-create a team and converge its access. */
export async function teamEnsure(
  api: Caller,
  a: TeamEnsureArgsT,
): Promise<Team> {
  if (a.name.toLowerCase() === OWNERS.toLowerCase()) {
    throw new Error(
      `${a.org}: the ${OWNERS} team is the forge's own and is not changed here.`,
    );
  }
  const wanted = grants(a.unitsMap);
  if (Object.keys(wanted).length === 0) {
    throw new Error(
      `${a.org}/${a.name}: unitsMap gives no access to any unit; name at least one with read or write.`,
    );
  }
  const found = await findTeam(api, a.org, a.name);
  const body = {
    name: a.name,
    ...(a.description === undefined ? {} : { description: a.description }),
    permission: highest(wanted),
    units_map: wanted,
    includes_all_repositories: a.includesAllRepositories,
    can_create_org_repo: a.canCreateOrgRepo,
  };
  let team: Record<string, unknown>;
  let action: Team["action"];
  if (found === null) {
    team = (await call(api, {
      method: "POST",
      path: `/api/v1/orgs/${enc(a.org)}/teams`,
      body,
    })).body;
    action = "created";
  } else if (administers(found)) {
    throw new Error(
      `${a.org}/${a.name} has administrator access, which this method does not give or take away. Nothing was sent.`,
    );
  } else if (
    sameGrants(found.units_map, wanted) &&
    (found.includes_all_repositories === true) === a.includesAllRepositories &&
    (found.can_create_org_repo === true) === a.canCreateOrgRepo &&
    (a.description === undefined || found.description === a.description)
  ) {
    return toTeam(a.org, found, "unchanged");
  } else {
    team = (await call(api, {
      method: "PATCH",
      path: `/api/v1/teams/${Number(found.id)}`,
      body,
    })).body;
    action = "updated";
  }
  // What the forge holds is read back; the write's own answer is not taken for it.
  const stored = (await call(api, {
    method: "GET",
    path: `/api/v1/teams/${Number(team.id)}`,
  })).body;
  if (
    !sameGrants(stored.units_map, wanted) ||
    (stored.includes_all_repositories === true) !== a.includesAllRepositories
  ) {
    throw new Error(
      `${a.org}/${a.name}: the forge did not take the access asked for (the team was ${action}). ` +
        `It holds ${
          JSON.stringify(grants(stored.units_map))
        }, includes all repositories: ${
          stored.includes_all_repositories === true
        }.`,
    );
  }
  return toTeam(a.org, stored, action);
}

const TeamMemberEnsureArgs = z.object({
  org: z.string().min(1).describe("The organization the team belongs to."),
  team: z.string().min(1).describe("Team name."),
  username: z.string().min(1).describe("Login to add to the team."),
});
/** {@link TeamMemberEnsureArgs} */
export type TeamMemberEnsureArgsT = z.infer<typeof TeamMemberEnsureArgs>;

const TeamMemberInfo = z.object({
  org: z.string(),
  team: z.string(),
  username: z.string(),
  action: z.enum(["added", "unchanged"]),
  timestamp: z.string(),
});
/** {@link TeamMemberInfo} */
export type TeamMember = z.infer<typeof TeamMemberInfo>;

/** Add a login to a team unless it is in it. */
export async function teamMemberEnsure(
  api: Caller,
  a: TeamMemberEnsureArgsT,
): Promise<TeamMember> {
  const team = await requireAddable(api, a.org, a.team);
  const path = `/api/v1/teams/${Number(team.id)}/members/${enc(a.username)}`;
  let action: TeamMember["action"] = "unchanged";
  if (!(await present(api, path))) {
    // A team's 404 for a non-member and the forge's for no such user are one
    // answer, so the user is asked for by name before anything is written.
    if (!(await present(api, `/api/v1/users/${enc(a.username)}`))) {
      throw new Error(
        `${a.org}/${a.team}: there is no user ${
          JSON.stringify(a.username)
        }. Nothing was sent.`,
      );
    }
    await call(api, { method: "PUT", path });
    if (!(await present(api, path))) {
      throw new Error(
        `${a.org}/${a.team}: the forge accepted ${
          JSON.stringify(a.username)
        } and does not list it as a member.`,
      );
    }
    action = "added";
  }
  return {
    org: a.org,
    team: a.team,
    username: a.username,
    action,
    timestamp: new Date().toISOString(),
  };
}

const TeamRepoEnsureArgs = z.object({
  org: z.string().min(1).describe(
    "The organization that owns the team and the repository.",
  ),
  team: z.string().min(1).describe("Team name."),
  name: z.string().min(1).describe("Repository name."),
});
/** {@link TeamRepoEnsureArgs} */
export type TeamRepoEnsureArgsT = z.infer<typeof TeamRepoEnsureArgs>;

const TeamRepoInfo = z.object({
  org: z.string(),
  team: z.string(),
  repo: z.string().describe("Repo full name, owner/name."),
  includedByAll: z.boolean().describe(
    "True when the team has every repository of the organization, so nothing was added.",
  ),
  action: z.enum(["added", "unchanged"]),
  timestamp: z.string(),
});
/** {@link TeamRepoInfo} */
export type TeamRepo = z.infer<typeof TeamRepoInfo>;

/** Add a repository to a team unless the team has it. */
export async function teamRepoEnsure(
  api: Caller,
  a: TeamRepoEnsureArgsT,
): Promise<TeamRepo> {
  const team = await requireAddable(api, a.org, a.team);
  const full = `${a.org}/${a.name}`;
  const path = `/api/v1/teams/${Number(team.id)}/repos/${enc(a.org)}/${
    enc(a.name)
  }`;
  const info = (
    action: TeamRepo["action"],
    includedByAll: boolean,
  ): TeamRepo => ({
    org: a.org,
    team: a.team,
    repo: full,
    includedByAll,
    action,
    timestamp: new Date().toISOString(),
  });
  // A team's 404 for a repository it does not have and the forge's for no
  // such repository are one answer, so the repository is asked for first.
  if (!(await present(api, `/api/v1/repos/${enc(a.org)}/${enc(a.name)}`))) {
    throw new Error(
      `repository ${full} does not exist, or the token cannot see it. Nothing was sent.`,
    );
  }
  if (team.includes_all_repositories === true) return info("unchanged", true);
  if (await present(api, path)) return info("unchanged", false);
  await call(api, { method: "PUT", path });
  if (!(await present(api, path))) {
    throw new Error(
      `${a.org}/${a.team}: the forge accepted ${full} and does not list it among the team's repositories.`,
    );
  }
  return info("added", false);
}

const TeamGetArgs = z.object({
  org: z.string().min(1).describe("The organization the team belongs to."),
  name: z.string().min(1).describe("Team name."),
});
/** {@link TeamGetArgs} */
export type TeamGetArgsT = z.infer<typeof TeamGetArgs>;

/** One team with its members and repositories, every page. */
export async function teamGet(api: Caller, a: TeamGetArgsT): Promise<Team> {
  const team = await requireTeam(api, a.org, a.name);
  const id = Number(team.id);
  const members = await listAll(api, `/api/v1/teams/${id}/members`);
  const repos = await listAll(api, `/api/v1/teams/${id}/repos`);
  return {
    ...toTeam(a.org, team, "observed"),
    members: members.map((m) => String(m.login ?? "")).filter((l) => l !== "")
      .sort(),
    repositories: repos.map((r) => String(r.full_name ?? "")).filter((n) =>
      n !== ""
    ).sort(),
  };
}

interface Ctx {
  globalArgs: GlobalArgs;
  forgejoClient?: Caller;
  signal?: AbortSignal;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/** Extension adding an organization's teams. */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    team: {
      description:
        "An organization's team: the access it gives per unit, and with team_get its members and repositories.",
      schema: TeamInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    teamMember: {
      description: "A login's membership of a team, as last ensured.",
      schema: TeamMemberInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    teamRepo: {
      description: "A repository's place in a team, as last ensured.",
      schema: TeamRepoInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    team_ensure: {
      description:
        "Find-or-create an organization's team by name and converge the access it gives per repository unit, " +
        "read or write, as the whole map. Reports created, updated or unchanged. Never deletes a team, and " +
        "refuses the Owners team and a team with administrator access.",
      arguments: TeamEnsureArgs,
      execute: async (args: TeamEnsureArgsT, context: Ctx) => {
        const a = TeamEnsureArgs.parse(args);
        context.logger.info("Ensuring team {team} in {org}", {
          team: a.name,
          org: a.org,
        });
        const info = await teamEnsure(callerOf(context), a);
        context.logger.info("Team {team}: {action}", {
          team: info.name,
          action: info.action,
        });
        const name = dataName("team", a.org, a.name);
        const handle = await writeRecord(context, "team", name, name, {
          ...info,
        });
        return { dataHandles: [handle] };
      },
    },
    team_member_ensure: {
      description:
        "Add a login to an organization's team unless it is already a member. Reports added or unchanged. " +
        "A user that does not exist, the Owners team and a team with administrator access are refused before " +
        "anything is sent. Never removes a member.",
      arguments: TeamMemberEnsureArgs,
      execute: async (args: TeamMemberEnsureArgsT, context: Ctx) => {
        const a = TeamMemberEnsureArgs.parse(args);
        const info = await teamMemberEnsure(callerOf(context), a);
        context.logger.info("{user} in team {team}: {action}", {
          user: a.username,
          team: `${a.org}/${a.team}`,
          action: info.action,
        });
        const name = dataName("teammember", a.org, a.team, a.username);
        const handle = await writeRecord(context, "teamMember", name, name, {
          ...info,
        });
        return { dataHandles: [handle] };
      },
    },
    team_repo_ensure: {
      description:
        "Add a repository of the organization to a team unless the team already has it, by itself or because " +
        "the team has every repository. Reports added or unchanged. A repository that does not exist, the Owners " +
        "team and a team with administrator access are refused before anything is sent. Never removes a repository.",
      arguments: TeamRepoEnsureArgs,
      execute: async (args: TeamRepoEnsureArgsT, context: Ctx) => {
        const a = TeamRepoEnsureArgs.parse(args);
        const info = await teamRepoEnsure(callerOf(context), a);
        context.logger.info("{repo} in team {team}: {action}", {
          repo: info.repo,
          team: `${a.org}/${a.team}`,
          action: info.action,
        });
        const name = dataName("teamrepo", a.org, a.team, a.name);
        const handle = await writeRecord(context, "teamRepo", name, name, {
          ...info,
        });
        return { dataHandles: [handle] };
      },
    },
    team_get: {
      description:
        "Read one team of an organization: the access it gives per unit, its members and its repositories, " +
        "every page. The audit view of who a team is and what it reaches.",
      arguments: TeamGetArgs,
      execute: async (args: TeamGetArgsT, context: Ctx) => {
        const a = TeamGetArgs.parse(args);
        const info = await teamGet(callerOf(context), a);
        context.logger.info(
          "Team {team}: {members} members, {repos} repositories",
          {
            team: `${a.org}/${a.name}`,
            members: info.members?.length ?? 0,
            repos: info.repositories?.length ?? 0,
          },
        );
        const name = dataName("team", a.org, a.name);
        const handle = await writeRecord(context, "team", name, name, {
          ...info,
        });
        return { dataHandles: [handle] };
      },
    },
  }],
};
