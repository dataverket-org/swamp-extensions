/**
 * Adds to `@thomas/forgejo` the assignment of a pull request, which upstream
 * `pr_ensure` does not take. Every login is checked against the forge first,
 * so a typo is an error and not a silently empty assignee list, and the PR
 * must exist and be open. `PATCH /repos/{owner}/{repo}/pulls/{index}` with
 * `assignees` replaces the whole list; what is recorded is what Forgejo
 * reports back, not what was asked for.
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
const prPath = (owner: string, repo: string, index: number) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}/pulls/${index}`;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");

/** A pull request's assignees as Forgejo reports them after the change. */
const PrAssignmentInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  index: z.number().int(),
  title: z.string(),
  state: z.string(),
  assignees: z.array(z.string()).describe("Logins, as Forgejo lists them"),
  action: z.enum(["assigned", "unchanged"]),
  timestamp: z.string(),
});
/** {@link PrAssignmentInfo} */
export type PrAssignment = z.infer<typeof PrAssignmentInfo>;

const PrAssignArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  index: z.number().int().positive().describe("PR number within the repo."),
  assignees: z.array(z.string().min(1)).min(1).describe(
    "Logins to assign; replaces the current list. Each must exist on the forge.",
  ),
});
/** {@link PrAssignArgs} */
export type PrAssignArgsT = z.infer<typeof PrAssignArgs>;

/** One user as `GET /users/search` lists them; no admin scope needed. */
const UserMatchInfo = z.object({
  query: z.string(),
  login: z.string(),
  fullName: z.string(),
  timestamp: z.string(),
});
const UserSearchArgs = z.object({
  q: z.string().min(1).describe("Login or name fragment to search for."),
});

/** Search users by login or name; the way to find a login for pr_assign. */
export async function userSearch(
  api: Caller,
  q: string,
): Promise<{ login: string; fullName: string }[]> {
  const r = await call(api, {
    method: "GET",
    path: `/api/v1/users/search?q=${enc(q)}&limit=50`,
  });
  const data = Array.isArray(r.body.data) ? r.body.data : [];
  return data
    .filter((u): u is Json => !!u && typeof u === "object")
    .map((u) => ({
      login: String(u.login ?? ""),
      fullName: String(u.full_name ?? ""),
    }))
    .filter((u) => u.login !== "");
}

function logins(pr: Record<string, unknown>): string[] {
  const list = Array.isArray(pr.assignees) ? pr.assignees : [];
  return list
    .map((u) => (u && typeof u === "object") ? (u as Json).login : undefined)
    .filter((l): l is string => typeof l === "string")
    .sort();
}
type Json = Record<string, unknown>;

/** Check every login, read the PR, assign, and return what Forgejo reports. */
export async function prAssign(
  api: Caller,
  a: PrAssignArgsT,
): Promise<PrAssignment> {
  const wanted = [...new Set(a.assignees)].sort();
  for (const login of wanted) {
    const r = await api({ method: "GET", path: `/api/v1/users/${enc(login)}` });
    if (r.status === 404) {
      throw new Error(`No user "${login}" on the forge; check the login`);
    }
    if (r.status >= 400) {
      throw new Error(
        `Forgejo API GET /api/v1/users/${login} -> HTTP ${r.status}`,
      );
    }
  }
  const path = prPath(a.owner, a.name, a.index);
  const current = await api({ method: "GET", path });
  if (current.status === 404) {
    throw new Error(`${a.owner}/${a.name}#${a.index} does not exist`);
  }
  if (current.status >= 400) {
    throw new Error(`Forgejo API GET ${path} -> HTTP ${current.status}`);
  }
  if (String(current.body.state ?? "") !== "open") {
    throw new Error(
      `${a.owner}/${a.name}#${a.index} is ${
        String(current.body.state ?? "?")
      }, not open`,
    );
  }
  const timestamp = new Date().toISOString();
  const base = {
    owner: a.owner,
    repo: a.name,
    index: a.index,
    title: String(current.body.title ?? ""),
    state: String(current.body.state ?? ""),
    timestamp,
  };
  if (logins(current.body).join(",") === wanted.join(",")) {
    return { ...base, assignees: wanted, action: "unchanged" };
  }
  const r = await call(api, {
    method: "PATCH",
    path,
    body: { assignees: wanted },
  });
  return {
    ...base,
    title: String(r.body.title ?? base.title),
    state: String(r.body.state ?? base.state),
    assignees: logins(r.body),
    action: "assigned",
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

/** Extension adding pull-request assignment to @thomas/forgejo. */
export const extension = {
  type: "@thomas/forgejo",
  resources: {
    prAssignment: {
      description:
        "A pull request's assignees after pr_assign, as Forgejo reports them.",
      schema: PrAssignmentInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    userMatch: {
      description: "A user matched by user_search: login and full name.",
      schema: UserMatchInfo,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    user_search: {
      description:
        "Search forge users by login or name fragment, without admin scope; the way to find a login for pr_assign. Read-only.",
      arguments: UserSearchArgs,
      execute: async (args: z.infer<typeof UserSearchArgs>, context: Ctx) => {
        const a = UserSearchArgs.parse(args);
        const found = await userSearch(
          fetchCaller(context.globalArgs, context.signal),
          a.q,
        );
        context.logger.info("{count} users match {q}: {logins}", {
          count: found.length,
          q: a.q,
          logins: found.map((u) => u.login).join(", "),
        });
        const timestamp = new Date().toISOString();
        const dataHandles = [];
        for (const u of found) {
          dataHandles.push(
            await context.writeResource(
              "userMatch",
              safeName(`user:${u.login}`),
              { query: a.q, ...u, timestamp },
            ),
          );
        }
        return { dataHandles };
      },
    },
    pr_assign: {
      description:
        "Assign a pull request to one or more logins, replacing the current assignees. Every login is " +
        "checked on the forge first; the PR must exist and be open. Idempotent.",
      arguments: PrAssignArgs,
      execute: async (args: z.infer<typeof PrAssignArgs>, context: Ctx) => {
        const a = PrAssignArgs.parse(args);
        context.logger.info("Assigning {pr} to {assignees}", {
          pr: `${a.owner}/${a.name}#${a.index}`,
          assignees: a.assignees.join(", "),
        });
        const info = await prAssign(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        const handle = await context.writeResource(
          "prAssignment",
          safeName(`${a.owner}/${a.name}#${a.index}:assignees`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
