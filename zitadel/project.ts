/**
 * `@dataverket/zitadel/project` — projects and the roles they define, with the
 * full life cycle: find or create, converge, deactivate, and delete.
 *
 * A project is what an application and its roles hang from, so deleting one
 * takes its applications, roles and grants with it. `setState inactive` is the
 * reversible way to take a project out of service and is what to reach for
 * first; `delete` exists for the throwaway project that should not linger, and
 * it is guarded: it re-reads the project, refuses unless `confirm` repeats the
 * live name, and does nothing under `dryRun` but report what it would remove.
 *
 * Roles live here because Zitadel scopes them to their project. A role has no
 * deactivated state, so `roleRemove` is a delete — verify-first, `dryRun`-able,
 * and undone by adding the same key back, though it does revoke the grants that
 * referenced it.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { asArray, call, mgmt, searchAll, seg } from "./api.ts";
import {
  assertArg,
  checks,
  DryRun,
  forgetInstance,
  GlobalArgsSchema,
  jsonArray,
  type MethodResult,
  type ModelContext,
  nowIso,
  optBool,
  optStrList,
  requireConfirm,
  sameRoles,
  str,
  writeAll,
  writeOne,
} from "./common.ts";
import {
  DeleteResult,
  ProjectGrantInfo,
  ProjectGrantMember,
  ProjectInfo,
  RoleInfo,
  shapeProject,
  shapeProjectGrant,
  shapeProjectGrantMember,
  shapeRole,
  StateResult,
} from "./schema.ts";
import {
  findProjectByName,
  findRoleByKey,
  getProject,
  resolveProject,
  tryResolveProject,
} from "./lookup.ts";

const ProjectRef = z.string().min(1).describe(
  "Project id, or its name — a name is looked up",
);
const RoleKey = z.string().min(1).describe(
  "Role key, as it appears in a token",
);

const ListArgs = z.object({});
const GetArgs = z.object({ project: ProjectRef });
const EnsureArgs = z.object({
  name: z.string().min(1).describe(
    "Project name; an existing project of this name is reused",
  ),
  roleAssertion: z.boolean().optional().describe(
    "Assert the user's roles into tokens and the userinfo endpoint",
  ),
  roleCheck: z.boolean().optional().describe(
    "Require a role of this project for a user to log in",
  ),
  hasProjectCheck: z.boolean().optional().describe(
    "Require the user's organization to be granted this project",
  ),
});
const UpdateArgs = z.object({
  project: ProjectRef,
  name: z.string().min(1).optional().describe("New project name"),
  roleAssertion: z.boolean().optional(),
  roleCheck: z.boolean().optional(),
  hasProjectCheck: z.boolean().optional(),
});
const SetStateArgs = z.object({
  project: ProjectRef,
  state: z.enum(["active", "inactive"]).describe(
    "Target state; the change is reversible either way",
  ),
});
const DeleteArgs = z.object({
  project: ProjectRef,
  confirm: z.string().min(1).describe(
    "The project's exact name, repeated — a mismatch refuses the delete",
  ),
  dryRun: DryRun.describe("Report what would be deleted and change nothing"),
});
const RoleListArgs = z.object({ project: ProjectRef });
const RoleEnsureArgs = z.object({
  project: ProjectRef,
  roleKey: RoleKey,
  displayName: z.string().optional().describe("Human-readable role name"),
  group: z.string().optional().describe("Group the role belongs to"),
});
const RoleRemoveArgs = z.object({
  project: ProjectRef,
  roleKey: RoleKey,
  dryRun: DryRun.describe("Report what would be removed and change nothing"),
});

const GrantedOrg = z.string().min(1).describe(
  "The organization the project is granted to, by id",
);
const ProjectGrantListArgs = z.object({ project: ProjectRef });
const ProjectGrantEnsureArgs = z.object({
  project: ProjectRef,
  grantedOrgId: GrantedOrg,
  roleKeys: jsonArray(z.string()).describe(
    "The project roles the other organization may use; the set is converged",
  ),
});
const ProjectGrantSetStateArgs = z.object({
  project: ProjectRef,
  grantedOrgId: GrantedOrg,
  state: z.enum(["active", "inactive"]),
});
const ProjectGrantDeleteArgs = z.object({
  project: ProjectRef,
  grantedOrgId: GrantedOrg,
  confirm: z.string().min(1).describe(
    "The granted organization's exact name, or its id when it has no name — " +
      "a mismatch refuses the delete",
  ),
  dryRun: DryRun.describe("Report what would be deleted and change nothing"),
});
const ProjectGrantMemberListArgs = z.object({
  project: ProjectRef,
  grantedOrgId: GrantedOrg,
});
const ProjectGrantMemberEnsureArgs = z.object({
  project: ProjectRef,
  grantedOrgId: GrantedOrg,
  userId: z.string().min(1).describe("A user of the granted organization"),
  roles: jsonArray(z.string()).describe(
    "Manager roles on the grant, e.g. PROJECT_GRANT_OWNER",
  ),
});
const ProjectGrantMemberRemoveArgs = z.object({
  project: ProjectRef,
  grantedOrgId: GrantedOrg,
  userId: z.string().min(1),
  dryRun: DryRun.describe("Report what would be removed and change nothing"),
});

/** The project fields a write sends, merged over what is already there. */
function projectBody(
  live: Record<string, unknown>,
  args: {
    name?: string;
    roleAssertion?: boolean;
    roleCheck?: boolean;
    hasProjectCheck?: boolean;
  },
): Record<string, unknown> {
  return {
    name: args.name ?? str(live.name),
    projectRoleAssertion: args.roleAssertion ??
      (optBool(live.projectRoleAssertion) ?? false),
    projectRoleCheck: args.roleCheck ??
      (optBool(live.projectRoleCheck) ?? false),
    hasProjectCheck: args.hasProjectCheck ??
      (optBool(live.hasProjectCheck) ?? false),
  };
}

/** Find a project's grant to one organization, or `null`. */
async function findProjectGrant(
  globalArgs: Record<string, unknown>,
  projectId: string,
  grantedOrgId: string,
): Promise<Record<string, unknown> | null> {
  const rows = await searchAll(
    globalArgs,
    mgmt(`/projects/${seg(projectId)}/grants/_search`),
  );
  return rows.find((row) => str(row.grantedOrgId) === grantedOrgId) ?? null;
}

/** True when the merged body would change nothing about the live project. */
function sameProject(
  live: Record<string, unknown>,
  body: Record<string, unknown>,
): boolean {
  return body.name === str(live.name) &&
    body.projectRoleAssertion ===
      (optBool(live.projectRoleAssertion) ?? false) &&
    body.projectRoleCheck === (optBool(live.projectRoleCheck) ?? false) &&
    body.hasProjectCheck === (optBool(live.hasProjectCheck) ?? false);
}

/** Zitadel projects and their roles. */
export const model = {
  type: "@dataverket/zitadel/project",
  version: "2026.10.05.1",
  upgrades: [
    {
      toVersion: "2026.10.01.3",
      description: "keyJsonFile expands a leading ~/; no argument changed",
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
    project: {
      description: "A project",
      schema: ProjectInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    role: {
      description: "A role defined by a project",
      schema: RoleInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "project-grant": {
      description: "A project granted to another organization",
      schema: ProjectGrantInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "project-grant-member": {
      description:
        "A user of the granted organization who may administer the grant",
      schema: ProjectGrantMember,
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
        "List every project in the organization and store each one. Read-only.",
      arguments: ListArgs,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing projects");
        const rows = await searchAll(
          context.globalArgs,
          mgmt("/projects/_search"),
        );
        const timestamp = nowIso();
        const projects = rows.map((row) =>
          shapeProject(row, "observed", timestamp)
        );
        const handles = await writeAll(
          context,
          "project",
          "project",
          projects,
          (project) => str(project.name) || str(project.id),
        );
        context.logger.info("stored {count} projects", {
          count: projects.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one project by id or name and store it. Read-only.",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading project {project}", {
          project: args.project,
        });
        const live = await resolveProject(context.globalArgs, args.project);
        const project = shapeProject(live, "observed", nowIso());
        return {
          dataHandles: await writeOne(
            context,
            "project",
            "project",
            str(project.name) || str(project.id),
            project,
          ),
        };
      },
    },
    ensure: {
      kind: "create" as const,
      description:
        "Find or create a project by name, converging any flags given. Idempotent.",
      arguments: EnsureArgs,
      execute: async (
        args: z.infer<typeof EnsureArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.name, "name");
        const globalArgs = context.globalArgs;
        const existing = await findProjectByName(globalArgs, args.name);

        if (existing) {
          const body = projectBody(existing, { ...args, name: args.name });
          if (sameProject(existing, body)) {
            context.logger.info("project {name} is already as asked", {
              name: args.name,
            });
            const project = shapeProject(existing, "unchanged", nowIso());
            return {
              dataHandles: await writeOne(
                context,
                "project",
                "project",
                args.name,
                project,
              ),
            };
          }
          const projectId = str(existing.id);
          await call(globalArgs, {
            method: "PUT",
            path: mgmt(`/projects/${seg(projectId)}`),
            body,
          });
          const live = await getProject(globalArgs, projectId);
          context.logger.info("converged project {name}", { name: args.name });
          return {
            dataHandles: await writeOne(
              context,
              "project",
              "project",
              args.name,
              shapeProject(
                live ?? { ...existing, ...body },
                "updated",
                nowIso(),
              ),
            ),
          };
        }

        context.logger.info("creating project {name}", { name: args.name });
        const created = await call(globalArgs, {
          method: "POST",
          path: mgmt("/projects"),
          body: projectBody({}, { ...args, name: args.name }),
        });
        const projectId = str(created.body.id);
        const live = await getProject(globalArgs, projectId);
        return {
          dataHandles: await writeOne(
            context,
            "project",
            "project",
            args.name,
            shapeProject(
              live ?? { id: projectId, name: args.name },
              "created",
              nowIso(),
            ),
          ),
        };
      },
    },
    update: {
      description:
        "Rename a project or change its authorization flags, leaving the rest as it is. Idempotent.",
      arguments: UpdateArgs,
      execute: async (
        args: z.infer<typeof UpdateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveProject(globalArgs, args.project);
        const projectId = str(live.id);
        const body = projectBody(live, args);
        if (sameProject(live, body)) {
          context.logger.info("project {id} is already as asked", {
            id: projectId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "project",
              "project",
              str(live.name) || projectId,
              shapeProject(live, "unchanged", nowIso()),
            ),
          };
        }
        await call(globalArgs, {
          method: "PUT",
          path: mgmt(`/projects/${seg(projectId)}`),
          body,
        });
        const updated = await getProject(globalArgs, projectId);
        context.logger.info("updated project {id}", { id: projectId });
        return {
          dataHandles: await writeOne(
            context,
            "project",
            "project",
            str((updated ?? body).name),
            shapeProject(updated ?? { ...live, ...body }, "updated", nowIso()),
          ),
        };
      },
    },
    setState: {
      description:
        "Deactivate or reactivate a project. Reversible, and a no-op when it is already in that state.",
      arguments: SetStateArgs,
      execute: async (
        args: z.infer<typeof SetStateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveProject(globalArgs, args.project);
        const projectId = str(live.id);
        const before = str(shapeProject(live, "observed", "").state);
        const timestamp = nowIso();
        if (before === args.state) {
          context.logger.info("project {id} is already {state}", {
            id: projectId,
            state: args.state,
          });
          return {
            dataHandles: await writeOne(
              context,
              "state",
              "project-state",
              projectId,
              {
                kind: "project",
                id: projectId,
                name: str(live.name),
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
          path: mgmt(`/projects/${seg(projectId)}/${path}`),
          body: {},
        });
        context.logger.info("project {id} is now {state}", {
          id: projectId,
          state: args.state,
        });
        return {
          dataHandles: await writeOne(
            context,
            "state",
            "project-state",
            projectId,
            {
              kind: "project",
              id: projectId,
              name: str(live.name),
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
        "Delete a project and everything under it — applications, roles and grants. Verify-first: confirm must repeat the live name, and dryRun only reports. Prefer setState inactive, which is reversible.",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const timestamp = nowIso();
        const live = await tryResolveProject(globalArgs, args.project);
        if (!live) {
          context.logger.warning("no project {project}; nothing to delete", {
            project: args.project,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "project-deletion",
              args.project,
              {
                kind: "project",
                id: "",
                name: args.project,
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        const projectId = str(live.id);
        const name = str(live.name);
        requireConfirm(name, args.confirm, "project name");
        if (args.dryRun) {
          context.logger.info("dry run: would delete project {name}", { name });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "project-deletion",
              projectId,
              {
                kind: "project",
                id: projectId,
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
          path: mgmt(`/projects/${seg(projectId)}`),
        });
        await forgetInstance(context, "project", name);
        context.logger.warning("deleted project {name}", { name });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "project-deletion",
            projectId,
            {
              kind: "project",
              id: projectId,
              name,
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
    roleList: {
      kind: "list" as const,
      description: "List a project's roles and store each one. Read-only.",
      arguments: RoleListArgs,
      execute: async (
        args: z.infer<typeof RoleListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const rows = await searchAll(
          globalArgs,
          mgmt(`/projects/${seg(projectId)}/roles/_search`),
        );
        const timestamp = nowIso();
        const roles = rows.map((row) =>
          shapeRole(projectId, row, "observed", timestamp)
        );
        const handles = await writeAll(
          context,
          "role",
          "role",
          roles,
          (role) => `${projectName}-${str(role.key)}`,
        );
        context.logger.info("stored {count} roles", { count: roles.length });
        return { dataHandles: handles };
      },
    },
    roleEnsure: {
      description:
        "Find or create a project role by key, converging its display name and group. Idempotent.",
      arguments: RoleEnsureArgs,
      execute: async (
        args: z.infer<typeof RoleEnsureArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const existing = await findRoleByKey(
          globalArgs,
          projectId,
          args.roleKey,
        );
        const timestamp = nowIso();
        const displayName = args.displayName ?? args.roleKey;
        const group = args.group ?? "";

        if (existing) {
          const sameName = str(existing.displayName) === displayName;
          const sameGroup = str(existing.group) === group;
          if (sameName && sameGroup) {
            context.logger.info("role {key} is already as asked", {
              key: args.roleKey,
            });
            return {
              dataHandles: await writeOne(
                context,
                "role",
                "role",
                `${projectName}-${args.roleKey}`,
                shapeRole(projectId, existing, "unchanged", timestamp),
              ),
            };
          }
          await call(globalArgs, {
            method: "PUT",
            path: mgmt(
              `/projects/${seg(projectId)}/roles/${seg(args.roleKey)}`,
            ),
            body: { displayName, group },
          });
          context.logger.info("converged role {key}", { key: args.roleKey });
          return {
            dataHandles: await writeOne(
              context,
              "role",
              "role",
              `${projectName}-${args.roleKey}`,
              shapeRole(
                projectId,
                { key: args.roleKey, displayName, group },
                "updated",
                timestamp,
              ),
            ),
          };
        }

        await call(globalArgs, {
          method: "POST",
          path: mgmt(`/projects/${seg(projectId)}/roles`),
          body: { roleKey: args.roleKey, displayName, group },
        });
        context.logger.info("created role {key}", { key: args.roleKey });
        return {
          dataHandles: await writeOne(
            context,
            "role",
            "role",
            `${projectName}-${args.roleKey}`,
            shapeRole(
              projectId,
              { key: args.roleKey, displayName, group },
              "created",
              timestamp,
            ),
          ),
        };
      },
    },
    roleRemove: {
      kind: "action" as const,
      description:
        "Remove a project role. Verify-first, and dryRun only reports. A role has no deactivated state, so this is a delete: it also revokes the grants that reference the role.",
      arguments: RoleRemoveArgs,
      execute: async (
        args: z.infer<typeof RoleRemoveArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const existing = await findRoleByKey(
          globalArgs,
          projectId,
          args.roleKey,
        );
        const timestamp = nowIso();
        if (!existing) {
          context.logger.warning("no role {key}; nothing to remove", {
            key: args.roleKey,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "role-deletion",
              `${projectName}-${args.roleKey}`,
              {
                kind: "role",
                id: args.roleKey,
                name: args.roleKey,
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        if (args.dryRun) {
          context.logger.info("dry run: would remove role {key}", {
            key: args.roleKey,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "role-deletion",
              `${projectName}-${args.roleKey}`,
              {
                kind: "role",
                id: args.roleKey,
                name: str(existing.displayName) || args.roleKey,
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }
        await call(globalArgs, {
          method: "DELETE",
          path: mgmt(`/projects/${seg(projectId)}/roles/${seg(args.roleKey)}`),
        });
        await forgetInstance(context, "role", `${projectName}-${args.roleKey}`);
        context.logger.warning("removed role {key}", { key: args.roleKey });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "role-deletion",
            `${projectName}-${args.roleKey}`,
            {
              kind: "role",
              id: args.roleKey,
              name: str(existing.displayName) || args.roleKey,
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
    projectGrantList: {
      kind: "list" as const,
      description:
        "List the organizations this project has been granted to, with the roles each one got. Read-only.",
      arguments: ProjectGrantListArgs,
      execute: async (
        args: z.infer<typeof ProjectGrantListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        context.logger.info("listing the grants of project {id}", {
          id: projectId,
        });
        const rows = await searchAll(
          globalArgs,
          mgmt(`/projects/${seg(projectId)}/grants/_search`),
        );
        const timestamp = nowIso();
        const grants = rows.map((row) =>
          shapeProjectGrant(projectId, row, "observed", timestamp)
        );
        const handles = await writeAll(
          context,
          "project-grant",
          "project-grant",
          grants,
          (grant) => `${projectName}-${str(grant.grantedOrgId)}`,
        );
        context.logger.info("stored {count} project grants", {
          count: grants.length,
        });
        return { dataHandles: handles };
      },
    },
    projectGrantEnsure: {
      kind: "create" as const,
      description:
        "Grant this project to another organization with exactly these roles, creating the grant when it is missing and converging the role set when it is not. Idempotent.",
      arguments: ProjectGrantEnsureArgs,
      execute: async (
        args: z.infer<typeof ProjectGrantEnsureArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const existing = await findProjectGrant(
          globalArgs,
          projectId,
          args.grantedOrgId,
        );
        const timestamp = nowIso();
        const key = `${projectName}-${args.grantedOrgId}`;

        if (existing) {
          const grantId = str(existing.grantId ?? existing.id);
          const held = optStrList(existing.grantedRoleKeys) ?? [];
          if (sameRoles(held, args.roleKeys)) {
            context.logger.info(
              "project grant {id} already holds those roles",
              {
                id: grantId,
              },
            );
            return {
              dataHandles: await writeOne(
                context,
                "project-grant",
                "project-grant",
                key,
                shapeProjectGrant(projectId, existing, "unchanged", timestamp),
              ),
            };
          }
          await call(globalArgs, {
            method: "PUT",
            path: mgmt(`/projects/${seg(projectId)}/grants/${seg(grantId)}`),
            body: { roleKeys: args.roleKeys },
          });
          context.logger.info("converged the roles of project grant {id}", {
            id: grantId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "project-grant",
              "project-grant",
              key,
              shapeProjectGrant(
                projectId,
                { ...existing, grantedRoleKeys: args.roleKeys },
                "updated",
                timestamp,
              ),
            ),
          };
        }

        context.logger.info("granting project {id} to organization {org}", {
          id: projectId,
          org: args.grantedOrgId,
        });
        const created = await call(globalArgs, {
          method: "POST",
          path: mgmt(`/projects/${seg(projectId)}/grants`),
          body: { grantedOrgId: args.grantedOrgId, roleKeys: args.roleKeys },
        });
        const live = await findProjectGrant(
          globalArgs,
          projectId,
          args.grantedOrgId,
        );
        return {
          dataHandles: await writeOne(
            context,
            "project-grant",
            "project-grant",
            key,
            shapeProjectGrant(
              projectId,
              live ?? {
                grantId: str(created.body.grantId ?? created.body.id),
                grantedOrgId: args.grantedOrgId,
                grantedRoleKeys: args.roleKeys,
                state: "PROJECT_GRANT_STATE_ACTIVE",
              },
              "created",
              timestamp,
            ),
          ),
        };
      },
    },
    projectGrantSetState: {
      description:
        "Deactivate or reactivate a project grant. Reversible, and a no-op when it is already in that state.",
      arguments: ProjectGrantSetStateArgs,
      execute: async (
        args: z.infer<typeof ProjectGrantSetStateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const existing = await findProjectGrant(
          globalArgs,
          projectId,
          args.grantedOrgId,
        );
        if (!existing) {
          throw new Error(
            `project ${projectId} is not granted to organization ${args.grantedOrgId}`,
          );
        }
        const grantId = str(existing.grantId ?? existing.id);
        const before = str(
          shapeProjectGrant(projectId, existing, "observed", "").state,
        );
        const timestamp = nowIso();
        if (before === args.state) {
          context.logger.info("project grant {id} is already {state}", {
            id: grantId,
            state: args.state,
          });
          return {
            dataHandles: await writeOne(
              context,
              "state",
              "project-grant-state",
              `${projectName}-${args.grantedOrgId}`,
              {
                kind: "project-grant",
                id: grantId,
                name: str(existing.grantedOrgName),
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
          path: mgmt(
            `/projects/${seg(projectId)}/grants/${seg(grantId)}/${path}`,
          ),
          body: {},
        });
        context.logger.info("project grant {id} is now {state}", {
          id: grantId,
          state: args.state,
        });
        return {
          dataHandles: await writeOne(
            context,
            "state",
            "project-grant-state",
            `${projectName}-${args.grantedOrgId}`,
            {
              kind: "project-grant",
              id: grantId,
              name: str(existing.grantedOrgName),
              previousState: before,
              state: args.state,
              action: args.state === "inactive" ? "deactivated" : "reactivated",
              timestamp,
            },
          ),
        };
      },
    },
    projectGrantDelete: {
      kind: "action" as const,
      description:
        "Take a project grant back from another organization, which revokes every authorization their users held through it. Verify-first: confirm must repeat the granted organization's name, and dryRun only reports. Prefer projectGrantSetState inactive, which is reversible.",
      arguments: ProjectGrantDeleteArgs,
      execute: async (
        args: z.infer<typeof ProjectGrantDeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const existing = await findProjectGrant(
          globalArgs,
          projectId,
          args.grantedOrgId,
        );
        const timestamp = nowIso();
        const key = `${projectName}-${args.grantedOrgId}`;
        if (!existing) {
          context.logger.warning(
            "project {id} is not granted to {org}; nothing to delete",
            { id: projectId, org: args.grantedOrgId },
          );
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "project-grant-deletion",
              key,
              {
                kind: "project-grant",
                id: "",
                name: args.grantedOrgId,
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        const grantId = str(existing.grantId ?? existing.id);
        const name = str(existing.grantedOrgName) || args.grantedOrgId;
        requireConfirm(name, args.confirm, "granted organization name");
        if (args.dryRun) {
          context.logger.info("dry run: would take back the grant to {org}", {
            org: name,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "project-grant-deletion",
              key,
              {
                kind: "project-grant",
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
          path: mgmt(`/projects/${seg(projectId)}/grants/${seg(grantId)}`),
        });
        await forgetInstance(context, "project-grant", key);
        context.logger.warning("took back the project grant to {org}", {
          org: name,
        });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "project-grant-deletion",
            key,
            {
              kind: "project-grant",
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
    projectGrantMemberList: {
      kind: "list" as const,
      description:
        "List the users of the granted organization who may administer a project grant. Read-only.",
      arguments: ProjectGrantMemberListArgs,
      execute: async (
        args: z.infer<typeof ProjectGrantMemberListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const existing = await findProjectGrant(
          globalArgs,
          projectId,
          args.grantedOrgId,
        );
        if (!existing) {
          throw new Error(
            `project ${projectId} is not granted to organization ${args.grantedOrgId}`,
          );
        }
        const grantId = str(existing.grantId ?? existing.id);
        const result = await call(globalArgs, {
          method: "POST",
          path: mgmt(
            `/projects/${seg(projectId)}/grants/${
              seg(grantId)
            }/members/_search`,
          ),
          body: { query: { offset: "0", limit: 100, asc: true } },
        });
        const timestamp = nowIso();
        const members = asArray(result.body.result).map((row) =>
          shapeProjectGrantMember(
            projectId,
            grantId,
            row,
            "observed",
            timestamp,
          )
        );
        const handles = await writeAll(
          context,
          "project-grant-member",
          "project-grant-member",
          members,
          (member) => `${projectName}-${str(member.userId)}`,
        );
        context.logger.info("stored {count} project-grant members", {
          count: members.length,
        });
        return { dataHandles: handles };
      },
    },
    projectGrantMemberEnsure: {
      kind: "create" as const,
      description:
        "Give a user of the granted organization these manager roles on the grant, adding the membership when it is missing and converging the roles when it is not. Idempotent.",
      arguments: ProjectGrantMemberEnsureArgs,
      execute: async (
        args: z.infer<typeof ProjectGrantMemberEnsureArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const grant = await findProjectGrant(
          globalArgs,
          projectId,
          args.grantedOrgId,
        );
        if (!grant) {
          throw new Error(
            `project ${projectId} is not granted to organization ${args.grantedOrgId}`,
          );
        }
        const grantId = str(grant.grantId ?? grant.id);
        const members = await call(globalArgs, {
          method: "POST",
          path: mgmt(
            `/projects/${seg(projectId)}/grants/${
              seg(grantId)
            }/members/_search`,
          ),
          body: { query: { offset: "0", limit: 100, asc: true } },
        });
        const existing = asArray(members.body.result).find((row) =>
          str(row.userId) === args.userId
        );
        const timestamp = nowIso();
        const key = `${projectName}-${args.userId}`;

        if (existing) {
          const held = optStrList(existing.roles) ?? [];
          if (sameRoles(held, args.roles)) {
            context.logger.info("member {user} already holds those roles", {
              user: args.userId,
            });
            return {
              dataHandles: await writeOne(
                context,
                "project-grant-member",
                "project-grant-member",
                key,
                shapeProjectGrantMember(
                  projectId,
                  grantId,
                  existing,
                  "unchanged",
                  timestamp,
                ),
              ),
            };
          }
          await call(globalArgs, {
            method: "PUT",
            path: mgmt(
              `/projects/${seg(projectId)}/grants/${seg(grantId)}/members/${
                seg(args.userId)
              }`,
            ),
            body: { roles: args.roles },
          });
          context.logger.info("converged the roles of member {user}", {
            user: args.userId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "project-grant-member",
              "project-grant-member",
              key,
              shapeProjectGrantMember(
                projectId,
                grantId,
                { ...existing, roles: args.roles },
                "updated",
                timestamp,
              ),
            ),
          };
        }

        await call(globalArgs, {
          method: "POST",
          path: mgmt(
            `/projects/${seg(projectId)}/grants/${seg(grantId)}/members`,
          ),
          body: { userId: args.userId, roles: args.roles },
        });
        context.logger.info("added member {user} to the project grant", {
          user: args.userId,
        });
        return {
          dataHandles: await writeOne(
            context,
            "project-grant-member",
            "project-grant-member",
            key,
            shapeProjectGrantMember(
              projectId,
              grantId,
              { userId: args.userId, roles: args.roles },
              "created",
              timestamp,
            ),
          ),
        };
      },
    },
    projectGrantMemberRemove: {
      kind: "action" as const,
      description:
        "Take a user's manager roles on a project grant away, verifying the membership exists first. dryRun only reports; the user keeps their account and any other authorization.",
      arguments: ProjectGrantMemberRemoveArgs,
      execute: async (
        args: z.infer<typeof ProjectGrantMemberRemoveArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const grant = await findProjectGrant(
          globalArgs,
          projectId,
          args.grantedOrgId,
        );
        if (!grant) {
          throw new Error(
            `project ${projectId} is not granted to organization ${args.grantedOrgId}`,
          );
        }
        const grantId = str(grant.grantId ?? grant.id);
        const members = await call(globalArgs, {
          method: "POST",
          path: mgmt(
            `/projects/${seg(projectId)}/grants/${
              seg(grantId)
            }/members/_search`,
          ),
          body: { query: { offset: "0", limit: 100, asc: true } },
        });
        const timestamp = nowIso();
        const key = `${projectName}-${args.userId}`;
        if (
          !asArray(members.body.result).some((row) =>
            str(row.userId) === args.userId
          )
        ) {
          context.logger.warning("{user} is not a member of this grant", {
            user: args.userId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "project-grant-member-deletion",
              key,
              {
                kind: "project-grant-member",
                id: args.userId,
                name: args.userId,
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        if (args.dryRun) {
          context.logger.info("dry run: would remove member {user}", {
            user: args.userId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "project-grant-member-deletion",
              key,
              {
                kind: "project-grant-member",
                id: args.userId,
                name: args.userId,
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }
        await call(globalArgs, {
          method: "DELETE",
          path: mgmt(
            `/projects/${seg(projectId)}/grants/${seg(grantId)}/members/${
              seg(args.userId)
            }`,
          ),
        });
        await forgetInstance(context, "project-grant-member", key);
        context.logger.warning("removed member {user} from the project grant", {
          user: args.userId,
        });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "project-grant-member-deletion",
            key,
            {
              kind: "project-grant-member",
              id: args.userId,
              name: args.userId,
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
