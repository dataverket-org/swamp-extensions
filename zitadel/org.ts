/**
 * `@dataverket/zitadel/org` — read the organizations the service user can see,
 * and who administers them.
 *
 * Read-only by design. Creating, renaming and deleting an organization decides
 * who exists on an instance rather than what they may do, and it stays a
 * deliberate act in the console; the scope of this type is knowing what is
 * there. `managerList` is the audit that answers "who can administer this
 * organization", which is the question worth asking on a schedule.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { asArray, call, mgmt, searchAllV2, v2 } from "./api.ts";
import {
  checks,
  type DataHandle,
  GlobalArgsSchema,
  type MethodResult,
  type ModelContext,
  nowIso,
  str,
  writeAll,
  writeOne,
} from "./common.ts";
import { ManagerInfo, OrgInfo, shapeManager, shapeOrg } from "./schema.ts";

const Empty = z.object({});

/** Zitadel organizations. */
export const model = {
  type: "@dataverket/zitadel/org",
  version: "2026.09.29.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    org: {
      description: "An organization on the instance",
      schema: OrgInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    manager: {
      description: "An organization manager and the manager roles they hold",
      schema: ManagerInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    get: {
      description:
        "Read the service user's own organization and store it. Read-only.",
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading the service user's organization");
        const result = await call(context.globalArgs, {
          method: "GET",
          path: mgmt("/orgs/me"),
        });
        const org = shapeOrg(
          (result.body.org ?? {}) as Record<string, unknown>,
          "observed",
          nowIso(),
        );
        return {
          dataHandles: await writeOne(
            context,
            "org",
            "org",
            str(org.name) || str(org.id),
            org,
          ),
        };
      },
    },
    list: {
      description:
        "List every organization the service user can see and store each one. Read-only.",
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing organizations");
        const rows = await searchAllV2(
          context.globalArgs,
          v2("/organizations/_search"),
          {},
          "query",
        );
        const timestamp = nowIso();
        const orgs = rows.map((row) => shapeOrg(row, "observed", timestamp));
        const handles = await writeAll(
          context,
          "org",
          "org",
          orgs,
          (org) => str(org.name) || str(org.id),
        );
        context.logger.info("stored {count} organizations", {
          count: orgs.length,
        });
        return { dataHandles: handles };
      },
    },
    managerList: {
      kind: "list" as const,
      description:
        "List the managers of the service user's organization with their roles — who can administer it. Read-only.",
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing organization managers");
        const me = await call(context.globalArgs, {
          method: "GET",
          path: mgmt("/orgs/me"),
        });
        const orgId = str(((me.body.org ?? {}) as Record<string, unknown>).id);
        const result = await call(context.globalArgs, {
          method: "POST",
          path: mgmt("/orgs/me/members/_search"),
          body: { query: { offset: "0", limit: 100, asc: true } },
        });
        const timestamp = nowIso();
        const managers = asArray(result.body.result).map((row) =>
          shapeManager(orgId, row, "observed", timestamp)
        );
        const handles: DataHandle[] = await writeAll(
          context,
          "manager",
          "manager",
          managers,
          (manager) => str(manager.preferredLoginName) || str(manager.userId),
        );
        context.logger.info("stored {count} managers", {
          count: managers.length,
        });
        return { dataHandles: handles };
      },
    },
  },
};
