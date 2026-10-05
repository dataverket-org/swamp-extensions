/**
 * Adds to `@dataverket/forgejo` the deletion of an organization, which upstream
 * has no method for (`org_ensure` only creates and converges). Verify-first,
 * and cautious: the organization is read before anything else, one that is
 * already gone is a no-op, and one that still holds repositories is refused,
 * because Forgejo has no undelete and `repo_delete` is the place to decide
 * about each repository. What is recorded is what was seen before the delete
 * and what happened.
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

/** The transport types, re-exported so a test needs only this module. */
export type { ApiCall, Caller };

const enc = encodeURIComponent;
const orgPath = (org: string) => `/api/v1/orgs/${enc(org)}`;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");
/** Enough to know whether an org is empty, and to name what is in the way. */
const REPO_PROBE = 10;

/** The outcome of org_delete: what the organization was, and what was done. */
const OrgDeleteInfo = z.object({
  org: z.string(),
  id: z.number().describe(
    "Forgejo's numeric id before the delete; 0 when absent",
  ),
  action: z.enum(["deleted", "absent"]),
  description: z.string(),
  timestamp: z.string(),
});
/** {@link OrgDeleteInfo} */
export type OrgDelete = z.infer<typeof OrgDeleteInfo>;

const OrgDeleteArgs = z.object({
  name: z.string().min(1).describe("Org login name."),
});
/** {@link OrgDeleteArgs} */
export type OrgDeleteArgsT = z.infer<typeof OrgDeleteArgs>;

/** Read the organization, refuse one with repositories, delete, report. */
export async function orgDelete(
  api: Caller,
  a: OrgDeleteArgsT,
): Promise<OrgDelete> {
  const path = orgPath(a.name);
  const timestamp = new Date().toISOString();
  const current = await api({ method: "GET", path });
  if (current.status === 404) {
    return { org: a.name, id: 0, action: "absent", description: "", timestamp };
  }
  if (current.status >= 400) {
    throw new Error(`Forgejo API GET ${path} -> HTTP ${current.status}`);
  }
  const repos = await call(api, {
    method: "GET",
    path: `${path}/repos?limit=${REPO_PROBE}&page=1`,
  });
  const list = Array.isArray(repos.body) ? repos.body : [];
  if (list.length > 0) {
    const names = list
      .map((r) => String((r as Record<string, unknown>).name ?? "?"))
      .join(", ");
    const more = list.length >= REPO_PROBE ? " ..." : "";
    throw new Error(
      `organization ${a.name} still holds repositories (${names}${more}); ` +
        "delete or transfer them first, repo_delete decides about each one",
    );
  }
  await call(api, { method: "DELETE", path });
  return {
    org: a.name,
    id: typeof current.body.id === "number" ? current.body.id : 0,
    action: "deleted",
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

/** Extension adding organization deletion. */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    orgDelete: {
      description:
        "An organization deletion by org_delete: what it was and what happened.",
      schema: OrgDeleteInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    org_delete: {
      description:
        "Delete an organization (no-op when absent). Verify-first: the organization is read, and one that still " +
        "holds repositories is refused, since Forgejo has no undelete; repo_delete decides about each repository.",
      arguments: OrgDeleteArgs,
      execute: async (args: z.infer<typeof OrgDeleteArgs>, context: Ctx) => {
        const a = OrgDeleteArgs.parse(args);
        context.logger.info("Deleting organization {org}", { org: a.name });
        const info = await orgDelete(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info("Organization {org}: {action}", {
          org: info.org,
          action: info.action,
        });
        const handle = await context.writeResource(
          "orgDelete",
          safeName(`${info.org}:delete`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
