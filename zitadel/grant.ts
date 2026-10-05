/**
 * `@dataverket/zitadel/grant` — user grants: which roles a user holds on a
 * project, which is what a token's role claim is built from.
 *
 * A grant is the join between a user and a project, so it is its own type
 * rather than a method on either. `ensure` finds the grant by user and project
 * and converges the role set, `setState` suspends it reversibly, and `delete`
 * removes it — verify-first, `dryRun`-able, and re-creatable with `ensure`,
 * which is why it takes no name to repeat back.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { call, mgmt, searchAll, seg } from "./api.ts";
import {
  checks,
  DryRun,
  forgetInstance,
  friendlyState,
  GlobalArgsSchema,
  jsonArray,
  type MethodResult,
  type ModelContext,
  nowIso,
  optStrList,
  sameRoles,
  str,
  writeAll,
  writeOne,
} from "./common.ts";
import { DeleteResult, GrantInfo, shapeGrant, StateResult } from "./schema.ts";
import { findGrant, resolveProject, resolveUser } from "./lookup.ts";

const UserRef = z.string().min(1).describe(
  "User id, or the username — a username is looked up",
);
const ProjectRef = z.string().min(1).describe(
  "Project id, or its name — a name is looked up",
);

const ListArgs = z.object({
  user: UserRef.optional().describe("Only this user's grants"),
  project: ProjectRef.optional().describe("Only grants on this project"),
});
const EnsureArgs = z.object({
  user: UserRef,
  project: ProjectRef,
  roleKeys: jsonArray(z.string()).describe(
    "The roles the user is to hold on the project; the set is converged, not added to",
  ),
});
const SetStateArgs = z.object({
  user: UserRef,
  project: ProjectRef,
  state: z.enum(["active", "inactive"]),
});
const DeleteArgs = z.object({
  user: UserRef,
  project: ProjectRef,
  dryRun: DryRun.describe("Report what would be deleted and change nothing"),
});

/** Zitadel user grants. */
export const model = {
  type: "@dataverket/zitadel/grant",
  version: "2026.10.05.1",
  upgrades: [
    {
      toVersion: "2026.10.01.3",
      description:
        "list names a grant by username and project name, as ensure does, and forgets the id-named record it wrote before; no argument changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.05.1",
      description:
        "Released with the app and settings changes of this version; nothing in this type changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    grant: {
      description: "A user grant: the roles a user holds on a project",
      schema: GrantInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    state: {
      description: "The outcome of a reversible state change",
      schema: StateResult,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    deletion: {
      description: "The outcome of a delete, or of a dry run that planned one",
      schema: DeleteResult,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List user grants, optionally narrowed to one user or one project, and store each one under the username and the project's name. Read-only against Zitadel.",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const queries: Record<string, unknown>[] = [];
        if (args.user) {
          const user = await resolveUser(globalArgs, args.user);
          queries.push({
            userIdQuery: { userId: str(user.userId ?? user.id) },
          });
        }
        if (args.project) {
          queries.push({
            projectIdQuery: {
              projectId: str(
                (await resolveProject(globalArgs, args.project)).id,
              ),
            },
          });
        }
        context.logger.info("listing user grants");
        const rows = await searchAll(
          globalArgs,
          mgmt("/users/grants/_search"),
          queries.length ? queries : undefined,
        );
        const timestamp = nowIso();
        const grants = rows.map((row) =>
          shapeGrant(row, "observed", timestamp)
        );
        // Keyed as `ensure` keys it, by the username and the project's name,
        // which the search row carries; an id stands in only where Zitadel
        // sent no name, so a list and an ensure write the same instance.
        const keys = new Map(
          grants.map((grant, index) => [
            grant,
            `${str(rows[index].userName) || str(grant.userId)}-${
              str(rows[index].projectName) || str(grant.projectId)
            }`,
          ]),
        );
        const handles = await writeAll(
          context,
          "grant",
          "grant",
          grants,
          (grant) => keys.get(grant) ?? "",
        );
        // Before 2026.10.01.2 a listed grant was stored under its two ids.
        // That record is the same grant under a name nothing writes any
        // more, so it is forgotten once the grant is stored under its names.
        for (const [grant, key] of keys) {
          const byId = `${str(grant.userId)}-${str(grant.projectId)}`;
          if (byId !== key) await forgetInstance(context, "grant", byId);
        }
        context.logger.info("stored {count} grants", { count: grants.length });
        return { dataHandles: handles };
      },
    },
    ensure: {
      kind: "create" as const,
      description:
        "Give a user exactly these roles on a project, creating the grant when it is missing and converging the role set when it is not. Idempotent.",
      arguments: EnsureArgs,
      execute: async (
        args: z.infer<typeof EnsureArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const user = await resolveUser(globalArgs, args.user);
        const userId = str(user.userId ?? user.id);
        const username = str(user.username) || userId;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const existing = await findGrant(globalArgs, userId, projectId);
        const timestamp = nowIso();
        const key = `${username}-${projectName}`;

        if (existing) {
          const grantId = str(existing.id);
          const held = optStrList(existing.roleKeys) ?? [];
          if (sameRoles(held, args.roleKeys)) {
            context.logger.info("grant {id} already holds those roles", {
              id: grantId,
            });
            return {
              dataHandles: await writeOne(
                context,
                "grant",
                "grant",
                key,
                shapeGrant(existing, "unchanged", timestamp),
              ),
            };
          }
          await call(globalArgs, {
            method: "PUT",
            path: mgmt(`/users/${seg(userId)}/grants/${seg(grantId)}`),
            body: { roleKeys: args.roleKeys },
          });
          context.logger.info("converged the roles of grant {id}", {
            id: grantId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "grant",
              "grant",
              key,
              shapeGrant(
                { ...existing, roleKeys: args.roleKeys },
                "updated",
                timestamp,
              ),
            ),
          };
        }

        context.logger.info("granting {count} roles on project {project}", {
          count: args.roleKeys.length,
          project: projectId,
        });
        const created = await call(globalArgs, {
          method: "POST",
          path: mgmt(`/users/${seg(userId)}/grants`),
          body: { projectId, roleKeys: args.roleKeys },
        });
        return {
          dataHandles: await writeOne(
            context,
            "grant",
            "grant",
            key,
            shapeGrant(
              {
                id: str(created.body.userGrantId ?? created.body.id),
                userId,
                projectId,
                roleKeys: args.roleKeys,
                state: "USER_GRANT_STATE_ACTIVE",
              },
              "created",
              timestamp,
            ),
          ),
        };
      },
    },
    setState: {
      description:
        "Deactivate or reactivate a user grant. Reversible, and a no-op when it is already in that state.",
      arguments: SetStateArgs,
      execute: async (
        args: z.infer<typeof SetStateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const user = await resolveUser(globalArgs, args.user);
        const userId = str(user.userId ?? user.id);
        const username = str(user.username) || userId;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const existing = await findGrant(globalArgs, userId, projectId);
        if (!existing) {
          throw new Error(
            `user ${userId} has no grant on project ${projectId}`,
          );
        }
        const grantId = str(existing.id);
        const before = friendlyState(existing.state);
        const timestamp = nowIso();
        if (before === args.state) {
          context.logger.info("grant {id} is already {state}", {
            id: grantId,
            state: args.state,
          });
          return {
            dataHandles: await writeOne(
              context,
              "state",
              "grant-state",
              `${username}-${projectName}`,
              {
                kind: "grant",
                id: grantId,
                name: str(existing.displayName),
                previousState: before,
                state: before,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        const path = args.state === "inactive" ? "_deactivate" : "_reactivate";
        await call(globalArgs, {
          method: "POST",
          path: mgmt(`/users/${seg(userId)}/grants/${seg(grantId)}/${path}`),
          body: {},
        });
        context.logger.info("grant {id} is now {state}", {
          id: grantId,
          state: args.state,
        });
        return {
          dataHandles: await writeOne(
            context,
            "state",
            "grant-state",
            `${username}-${projectName}`,
            {
              kind: "grant",
              id: grantId,
              name: str(existing.displayName),
              previousState: before,
              state: args.state,
              action: args.state === "inactive" ? "deactivated" : "reactivated",
              timestamp,
            },
          ),
        };
      },
    },
    delete: {
      kind: "action" as const,
      description:
        "Remove a user's grant on a project, verifying it exists first. dryRun only reports. The grant can be re-created with ensure, so the user keeps their account either way.",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const user = await resolveUser(globalArgs, args.user);
        const userId = str(user.userId ?? user.id);
        const username = str(user.username) || userId;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const existing = await findGrant(globalArgs, userId, projectId);
        const timestamp = nowIso();
        if (!existing) {
          context.logger.warning(
            "user {user} has no grant on project {project}; nothing to delete",
            { user: args.user, project: args.project },
          );
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "grant-deletion",
              `${username}-${projectName}`,
              {
                kind: "grant",
                id: "",
                name: `${userId}@${projectId}`,
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        const grantId = str(existing.id);
        const name = str(existing.displayName) || `${userId}@${projectId}`;
        if (args.dryRun) {
          context.logger.info("dry run: would delete grant {id}", {
            id: grantId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "grant-deletion",
              `${username}-${projectName}`,
              {
                kind: "grant",
                id: grantId,
                name,
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }
        await call(globalArgs, {
          method: "DELETE",
          path: mgmt(`/users/${seg(userId)}/grants/${seg(grantId)}`),
        });
        await forgetInstance(context, "grant", `${userId}-${projectId}`);
        context.logger.warning("deleted grant {id}", { id: grantId });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "grant-deletion",
            `${username}-${projectName}`,
            {
              kind: "grant",
              id: grantId,
              name,
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
  },
};
