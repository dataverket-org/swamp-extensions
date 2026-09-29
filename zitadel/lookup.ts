/**
 * `@dataverket/zitadel` — resolving the names a person types into the ids the
 * API wants, and finding what is already there before creating it.
 *
 * Every model method takes friendly references: a project by name or id, a user
 * by username or id, an application by name within its project. A reference of
 * digits only is an id and is used as given; anything else is looked up, and a
 * miss is an error naming what was not found rather than a create.
 *
 * @module
 */
import { asArray, call, type Json, mgmt, searchAllV2, seg, v2 } from "./api.ts";
import { looksLikeId, str } from "./common.ts";

/** Find a project by exact name. */
export async function findProjectByName(
  globalArgs: Json,
  name: string,
): Promise<Json | null> {
  const result = await call(globalArgs, {
    method: "POST",
    path: mgmt("/projects/_search"),
    body: {
      queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
    },
  });
  const rows = asArray(result.body.result);
  return rows.find((row) => row.name === name) ?? null;
}

/** Read one project by id. */
export async function getProject(
  globalArgs: Json,
  projectId: string,
): Promise<Json | null> {
  try {
    const result = await call(globalArgs, {
      method: "GET",
      path: mgmt(`/projects/${seg(projectId)}`),
    });
    const project = result.body.project;
    return project ? (project as Json) : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Resolve a project reference (id or name) to the project record. */
export async function resolveProject(
  globalArgs: Json,
  reference: string,
): Promise<Json> {
  const project = looksLikeId(reference)
    ? await getProject(globalArgs, reference)
    : await findProjectByName(globalArgs, reference);
  if (!project) {
    throw new Error(`no project ${JSON.stringify(reference)}`);
  }
  return project;
}

/** Resolve a project reference to its id. */
export async function resolveProjectId(
  globalArgs: Json,
  reference: string,
): Promise<string> {
  return str((await resolveProject(globalArgs, reference)).id);
}

/** Find an application by exact name within a project. */
export async function findAppByName(
  globalArgs: Json,
  projectId: string,
  name: string,
): Promise<Json | null> {
  const result = await call(globalArgs, {
    method: "POST",
    path: mgmt(`/projects/${seg(projectId)}/apps/_search`),
    body: {
      queries: [{ nameQuery: { name, method: "TEXT_QUERY_METHOD_EQUALS" } }],
    },
  });
  return asArray(result.body.result).find((row) => row.name === name) ?? null;
}

/** Read one application by id. */
export async function getApp(
  globalArgs: Json,
  projectId: string,
  appId: string,
): Promise<Json | null> {
  try {
    const result = await call(globalArgs, {
      method: "GET",
      path: mgmt(`/projects/${seg(projectId)}/apps/${seg(appId)}`),
    });
    const app = result.body.app;
    return app ? (app as Json) : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Resolve an application reference (id or name) within a project. */
export async function resolveApp(
  globalArgs: Json,
  projectId: string,
  reference: string,
): Promise<Json> {
  const app = looksLikeId(reference)
    ? await getApp(globalArgs, projectId, reference)
    : await findAppByName(globalArgs, projectId, reference);
  if (!app) {
    throw new Error(
      `no application ${JSON.stringify(reference)} in project ${projectId}`,
    );
  }
  return app;
}

/**
 * Find a user by exact username, over the v2 user service, within the
 * organization the model acts in — a service user with instance-wide rights
 * would otherwise reach a username in somebody else's organization.
 */
export async function findUserByUsername(
  globalArgs: Json,
  username: string,
): Promise<Json | null> {
  const rows = await searchAllV2(
    globalArgs,
    v2("/users"),
    {
      queries: [
        {
          userNameQuery: {
            userName: username,
            method: "TEXT_QUERY_METHOD_EQUALS",
          },
        },
        {
          organizationIdQuery: {
            organizationId: await resolveOrgId(globalArgs),
          },
        },
      ],
    },
    "query",
  );
  return rows.find((row) => row.username === username) ?? rows[0] ?? null;
}

/** Read one user by id, over the v2 user service. */
export async function getUser(
  globalArgs: Json,
  userId: string,
): Promise<Json | null> {
  try {
    const result = await call(globalArgs, {
      method: "GET",
      path: v2(`/users/${seg(userId)}`),
    });
    const user = result.body.user;
    return user ? (user as Json) : null;
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/** Resolve a user reference (id or username) to the user record. */
export async function resolveUser(
  globalArgs: Json,
  reference: string,
): Promise<Json> {
  const user = looksLikeId(reference)
    ? await getUser(globalArgs, reference)
    : await findUserByUsername(globalArgs, reference);
  if (!user) throw new Error(`no user ${JSON.stringify(reference)}`);
  return user;
}

/** Resolve a user reference to its id. */
export async function resolveUserId(
  globalArgs: Json,
  reference: string,
): Promise<string> {
  const user = await resolveUser(globalArgs, reference);
  return str(user.userId ?? user.id);
}

/** Find a project role by exact key. */
export async function findRoleByKey(
  globalArgs: Json,
  projectId: string,
  roleKey: string,
): Promise<Json | null> {
  const result = await call(globalArgs, {
    method: "POST",
    path: mgmt(`/projects/${seg(projectId)}/roles/_search`),
    body: {
      queries: [{
        keyQuery: { key: roleKey, method: "TEXT_QUERY_METHOD_EQUALS" },
      }],
    },
  });
  // The key query filters loosely, so match the key exactly here.
  return asArray(result.body.result).find((row) => row.key === roleKey) ?? null;
}

/** Find a user's grant on a project. */
export async function findGrant(
  globalArgs: Json,
  userId: string,
  projectId: string,
): Promise<Json | null> {
  const result = await call(globalArgs, {
    method: "POST",
    path: mgmt("/users/grants/_search"),
    body: {
      queries: [
        { userIdQuery: { userId } },
        { projectIdQuery: { projectId } },
      ],
    },
  });
  return asArray(result.body.result).find((row) =>
    row.userId === userId && row.projectId === projectId
  ) ?? null;
}

/** True when an API error is Zitadel reporting that a thing does not exist. */
export function isNotFound(err: unknown): boolean {
  const message = err instanceof Error ? err.message : String(err);
  return /HTTP 404/.test(message) || /NotFound|not found/i.test(message);
}

/** {@link resolveProject} returning `null` instead of throwing when it is gone. */
export async function tryResolveProject(
  globalArgs: Json,
  reference: string,
): Promise<Json | null> {
  return looksLikeId(reference)
    ? await getProject(globalArgs, reference)
    : await findProjectByName(globalArgs, reference);
}

/** {@link resolveApp} returning `null` instead of throwing when it is gone. */
export async function tryResolveApp(
  globalArgs: Json,
  projectId: string,
  reference: string,
): Promise<Json | null> {
  return looksLikeId(reference)
    ? await getApp(globalArgs, projectId, reference)
    : await findAppByName(globalArgs, projectId, reference);
}

/** {@link resolveUser} returning `null` instead of throwing when it is gone. */
export async function tryResolveUser(
  globalArgs: Json,
  reference: string,
): Promise<Json | null> {
  return looksLikeId(reference)
    ? await getUser(globalArgs, reference)
    : await findUserByUsername(globalArgs, reference);
}

/** Cached organization ids, keyed by instance and by the org the caller named. */
const orgIdCache = new Map<string, string>();

/** Test-only seam: forget the cached organization ids. */
export function __resetOrgCache(): void {
  orgIdCache.clear();
}

/**
 * The organization the model acts in: the `orgId` global argument when the
 * definition names one, otherwise the service user's own organization.
 *
 * The v1 Management API takes this from the token and the `x-zitadel-orgid`
 * header, but the v2 user service wants it in the request body, so creating a
 * user has to know it rather than assume it.
 */
export async function resolveOrgId(globalArgs: Json): Promise<string> {
  const named = typeof globalArgs.orgId === "string" ? globalArgs.orgId : "";
  if (named) return named;
  const key = String(globalArgs.apiUrl ?? "");
  const cached = orgIdCache.get(key);
  if (cached) return cached;
  const result = await call(globalArgs, {
    method: "GET",
    path: mgmt("/orgs/me"),
  });
  const id = str((result.body.org as Json | undefined)?.id);
  if (!id) {
    throw new Error("cannot determine the organization of the service user");
  }
  orgIdCache.set(key, id);
  return id;
}
