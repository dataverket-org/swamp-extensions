/**
 * `@dataverket/zitadel/app` — the applications of a project: OIDC clients, API
 * resource servers, their secrets and their keys.
 *
 * Applications belong to a project, so every method takes the project as well,
 * by id or by name. This type never creates the project; `@dataverket/zitadel/
 * project`'s `ensure` does that, and an application asked for in a project that
 * does not exist is an error rather than a surprise.
 *
 * Secrets are emitted once. `ensureOidc` and `ensureApi` return a client secret
 * only on create, `secretRotate` returns a new one, and `keyCreate` returns the
 * key JSON a client would download — each into a sensitive spec that swamp
 * vaults, each unreadable afterwards.
 *
 * `redirectSet` is the careful path for a client several things depend on: it
 * re-reads the live OIDC configuration and writes it back with only the
 * redirect allowlist changed, so a converge cannot quietly reset PKCE, the auth
 * method or the token type. `setState inactive` takes an application out of
 * service reversibly; `delete` is the guarded end of the line.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { asArray, call, fromBase64, mgmt, searchAll, seg } from "./api.ts";
import {
  ACCESS_TOKEN_TYPE,
  API_AUTH_METHOD,
  APP_TYPE,
  AUTH_METHOD,
  boolArg,
  checks,
  DryRun,
  forgetInstance,
  friendlyState,
  GlobalArgsSchema,
  GRANT_TYPE,
  jsonArray,
  mapEnum,
  type MethodResult,
  type ModelContext,
  nowIso,
  obj,
  optStr,
  requireConfirm,
  RESPONSE_TYPE,
  str,
  writeAll,
  writeOne,
} from "./common.ts";
import {
  AppCredential,
  AppInfo,
  AppKey,
  DeleteResult,
  OidcRedirectResult,
  shapeApp,
  StateResult,
} from "./schema.ts";
import {
  findAppByName,
  getApp,
  resolveApp,
  resolveProject,
  tryResolveApp,
} from "./lookup.ts";

const ProjectRef = z.string().min(1).describe(
  "Project id, or its name — a name is looked up",
);
const AppRef = z.string().min(1).describe(
  "Application id, or its name within the project",
);

const ListArgs = z.object({ project: ProjectRef });
const GetArgs = z.object({ project: ProjectRef, app: AppRef });
const EnsureOidcArgs = z.object({
  project: ProjectRef,
  name: z.string().min(1).describe(
    "Application name; an existing application of this name is converged",
  ),
  redirectUris: jsonArray(z.string()).default([]).describe(
    "Allowed redirect URIs",
  ),
  postLogoutUris: jsonArray(z.string()).default([]).describe(
    "Allowed post-logout redirect URIs",
  ),
  appType: z.enum(["web", "spa", "native"]).default("web"),
  authMethod: z.enum(["basic", "post", "none", "jwt"]).default("basic")
    .describe("Client authentication; none is a public PKCE client"),
  grantTypes: jsonArray(
    z.enum(["authorization_code", "implicit", "refresh_token", "device_code"]),
  ).default(["authorization_code", "refresh_token"]),
  responseTypes: jsonArray(z.enum(["code", "id_token", "id_token_token"]))
    .default(["code"]),
  accessTokenType: z.enum(["bearer", "jwt"]).default("bearer"),
  devMode: boolArg(false).describe(
    "Relax redirect-URI checks for non-https hosts. Test instances only.",
  ),
});
const EnsureApiArgs = z.object({
  project: ProjectRef,
  name: z.string().min(1),
  authMethod: z.enum(["basic", "jwt"]).default("jwt").describe(
    "basic returns a client secret once; jwt authenticates with a key",
  ),
});
const RedirectSetArgs = z.object({
  project: ProjectRef,
  app: AppRef,
  add: jsonArray(z.string()).default([]).describe("Redirect URIs to allow"),
  remove: jsonArray(z.string()).default([]).describe(
    "Redirect URIs to stop allowing",
  ),
});
const UpdateArgs = z.object({
  project: ProjectRef,
  app: AppRef,
  name: z.string().min(1).describe("New application name"),
});
const SetStateArgs = z.object({
  project: ProjectRef,
  app: AppRef,
  state: z.enum(["active", "inactive"]),
});
const SecretRotateArgs = z.object({
  project: ProjectRef,
  app: AppRef,
});
const DeleteArgs = z.object({
  project: ProjectRef,
  app: AppRef,
  confirm: z.string().min(1).describe(
    "The application's exact name, repeated — a mismatch refuses the delete",
  ),
  dryRun: DryRun.describe("Report what would be deleted and change nothing"),
});
const KeyCreateArgs = z.object({
  project: ProjectRef,
  app: AppRef,
  expirationDate: z.string().optional().describe(
    "RFC3339 expiry, e.g. 2027-01-01T00:00:00Z; omit for the instance default",
  ),
});
const KeyListArgs = z.object({ project: ProjectRef, app: AppRef });
const KeyDeleteArgs = z.object({
  project: ProjectRef,
  app: AppRef,
  keyId: z.string().min(1).describe("Key id, verified to belong to the app"),
  dryRun: DryRun.describe("Report what would be deleted and change nothing"),
});

/** The OIDC configuration fields a write may carry, in Zitadel's own enums. */
const WRITABLE_OIDC = [
  "responseTypes",
  "grantTypes",
  "appType",
  "authMethodType",
  "postLogoutRedirectUris",
  "devMode",
  "accessTokenType",
  "idTokenRoleAssertion",
  "idTokenUserinfoAssertion",
  "clockSkew",
  "additionalOrigins",
  "skipNativeAppSuccessPage",
  "backChannelLogoutUri",
];

/** Applications of a Zitadel project. */
export const model = {
  type: "@dataverket/zitadel/app",
  version: "2026.09.29.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    app: {
      description: "An application's configuration; never a secret",
      schema: AppInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "app-credential": {
      description:
        "An application's client id, and its client secret once at create or rotate",
      schema: AppCredential,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "app-key": {
      description: "An application key, with its JSON once at create",
      schema: AppKey,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "oidc-redirect": {
      description: "The outcome of changing a redirect allowlist",
      schema: OidcRedirectResult,
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
        "List a project's applications with their configuration and store each one. Read-only, no secrets.",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        context.logger.info("listing applications of project {id}", {
          id: projectId,
        });
        const rows = await searchAll(
          globalArgs,
          mgmt(`/projects/${seg(projectId)}/apps/_search`),
        );
        const timestamp = nowIso();
        const apps = rows.map((row) =>
          shapeApp(projectId, row, "observed", timestamp)
        );
        const handles = await writeAll(
          context,
          "app",
          "app",
          apps,
          (app) => `${projectName}-${str(app.name) || str(app.appId)}`,
        );
        context.logger.info("stored {count} applications", {
          count: apps.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description:
        "Read one application's full configuration and store it. Read-only, no secret.",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        context.logger.info("reading application {app}", { app: args.app });
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const live = await resolveApp(globalArgs, projectId, args.app);
        const app = shapeApp(projectId, live, "observed", nowIso());
        return {
          dataHandles: await writeOne(
            context,
            "app",
            "app",
            `${projectName}-${str(app.name) || str(app.appId)}`,
            app,
          ),
        };
      },
    },
    ensureOidc: {
      kind: "create" as const,
      description:
        "Find or create an OIDC application in a project and converge its whole OIDC configuration to what is given here — a field left at its default is written as that default, so use redirectSet on a client other things depend on. Returns the client secret once, on create, for a confidential client. Idempotent.",
      arguments: EnsureOidcArgs,
      execute: async (
        args: z.infer<typeof EnsureOidcArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const config = {
          redirectUris: args.redirectUris,
          postLogoutRedirectUris: args.postLogoutUris,
          responseTypes: args.responseTypes.map((type) =>
            mapEnum(RESPONSE_TYPE, type, "responseType")
          ),
          grantTypes: args.grantTypes.map((type) =>
            mapEnum(GRANT_TYPE, type, "grantType")
          ),
          appType: mapEnum(APP_TYPE, args.appType, "appType"),
          authMethodType: mapEnum(AUTH_METHOD, args.authMethod, "authMethod"),
          accessTokenType: mapEnum(
            ACCESS_TOKEN_TYPE,
            args.accessTokenType,
            "accessTokenType",
          ),
          devMode: args.devMode,
        };
        const timestamp = nowIso();
        const existing = await findAppByName(globalArgs, projectId, args.name);

        if (existing) {
          const appId = str(existing.id);
          let action: "updated" | "unchanged" = "updated";
          try {
            await call(globalArgs, {
              method: "PUT",
              path: mgmt(
                `/projects/${seg(projectId)}/apps/${seg(appId)}/oidc_config`,
              ),
              body: config,
            });
          } catch (err) {
            // Zitadel answers 400 "No changes" when the configuration already
            // matches; that is this method being idempotent, not a failure.
            const message = err instanceof Error ? err.message : String(err);
            if (!/no changes/i.test(message)) throw err;
            action = "unchanged";
          }
          const after = await getApp(globalArgs, projectId, appId) ?? existing;
          context.logger.info("converged OIDC application {name} ({action})", {
            name: args.name,
            action,
          });
          const oidc = obj(after.oidcConfig);
          return {
            dataHandles: [
              ...await writeOne(
                context,
                "app",
                "app",
                `${projectName}-${args.name}`,
                shapeApp(projectId, after, action, timestamp),
              ),
              ...await writeOne(
                context,
                "app-credential",
                "app-credential",
                `${projectName}-${args.name}`,
                {
                  projectId,
                  appId,
                  name: args.name,
                  clientId: str(oidc.clientId),
                  action,
                  timestamp,
                },
              ),
            ],
          };
        }

        context.logger.info("creating OIDC application {name}", {
          name: args.name,
        });
        const created = await call(globalArgs, {
          method: "POST",
          path: mgmt(`/projects/${seg(projectId)}/apps/oidc`),
          body: { name: args.name, ...config },
        });
        const appId = str(created.body.appId);
        const after = await getApp(globalArgs, projectId, appId);
        return {
          dataHandles: [
            ...await writeOne(
              context,
              "app",
              "app",
              `${projectName}-${args.name}`,
              shapeApp(
                projectId,
                after ?? { id: appId, name: args.name, oidcConfig: {} },
                "created",
                timestamp,
              ),
            ),
            ...await writeOne(
              context,
              "app-credential",
              "app-credential",
              `${projectName}-${args.name}`,
              {
                projectId,
                appId,
                name: args.name,
                clientId: str(created.body.clientId),
                clientSecret: optStr(created.body.clientSecret),
                action: "created",
                timestamp,
              },
            ),
          ],
        };
      },
    },
    ensureApi: {
      kind: "create" as const,
      description:
        "Find or create an API application (a resource server for machine-to-machine calls). Returns the client secret once, on create, for the basic method. Idempotent.",
      arguments: EnsureApiArgs,
      execute: async (
        args: z.infer<typeof EnsureApiArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const timestamp = nowIso();
        const existing = await findAppByName(globalArgs, projectId, args.name);

        if (existing) {
          const api = obj(existing.apiConfig);
          context.logger.info("API application {name} already exists", {
            name: args.name,
          });
          return {
            dataHandles: [
              ...await writeOne(
                context,
                "app",
                "app",
                `${projectName}-${args.name}`,
                shapeApp(projectId, existing, "unchanged", timestamp),
              ),
              ...await writeOne(
                context,
                "app-credential",
                "app-credential",
                `${projectName}-${args.name}`,
                {
                  projectId,
                  appId: str(existing.id),
                  name: args.name,
                  clientId: str(api.clientId),
                  action: "unchanged",
                  timestamp,
                },
              ),
            ],
          };
        }

        context.logger.info("creating API application {name}", {
          name: args.name,
        });
        const created = await call(globalArgs, {
          method: "POST",
          path: mgmt(`/projects/${seg(projectId)}/apps/api`),
          body: {
            name: args.name,
            authMethodType: mapEnum(
              API_AUTH_METHOD,
              args.authMethod,
              "authMethod",
            ),
          },
        });
        const appId = str(created.body.appId);
        const after = await getApp(globalArgs, projectId, appId);
        return {
          dataHandles: [
            ...await writeOne(
              context,
              "app",
              "app",
              `${projectName}-${args.name}`,
              shapeApp(
                projectId,
                after ?? { id: appId, name: args.name, apiConfig: {} },
                "created",
                timestamp,
              ),
            ),
            ...await writeOne(
              context,
              "app-credential",
              "app-credential",
              `${projectName}-${args.name}`,
              {
                projectId,
                appId,
                name: args.name,
                clientId: str(created.body.clientId),
                clientSecret: optStr(created.body.clientSecret),
                action: "created",
                timestamp,
              },
            ),
          ],
        };
      },
    },
    redirectSet: {
      description:
        "Add and remove redirect URIs on an OIDC application by reading the live configuration and writing it back with only the allowlist changed — safe on a client others depend on. Idempotent.",
      arguments: RedirectSetArgs,
      execute: async (
        args: z.infer<typeof RedirectSetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const live = await resolveApp(globalArgs, projectId, args.app);
        const appId = str(live.id);
        const oidc = live.oidcConfig === undefined
          ? undefined
          : obj(live.oidcConfig);
        if (!oidc) {
          throw new Error(`application ${appId} is not an OIDC application`);
        }
        const previous = asArray(oidc.redirectUris).map((uri) => str(uri));
        const removing = new Set(args.remove);
        const next = previous.filter((uri) => !removing.has(uri));
        for (const uri of args.add) if (!next.includes(uri)) next.push(uri);
        const added = args.add.filter((uri) => !previous.includes(uri));
        const removed = previous.filter((uri) => removing.has(uri));
        const timestamp = nowIso();
        const postLogout = asArray(oidc.postLogoutRedirectUris).map((uri) =>
          str(uri)
        );

        if (added.length === 0 && removed.length === 0) {
          context.logger.info(
            "redirect allowlist of {app} is already as asked",
            {
              app: str(live.name) || appId,
            },
          );
          return {
            dataHandles: await writeOne(
              context,
              "oidc-redirect",
              "oidc-redirect",
              `${projectName}-${appId}`,
              {
                projectId,
                appId,
                name: str(live.name),
                redirectUris: previous,
                postLogoutUris: postLogout,
                added: [],
                removed: [],
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }

        // Carry every writable field over verbatim — Zitadel's own enum values
        // round-trip on PUT — so only the allowlist changes. Read-only fields
        // (clientId, complianceProblems) are left out on purpose.
        const body: Record<string, unknown> = { redirectUris: next };
        for (const field of WRITABLE_OIDC) {
          if (oidc[field] !== undefined) body[field] = oidc[field];
        }
        context.logger.info("setting redirect URIs on {app}", {
          app: str(live.name) || appId,
          added: added.length,
          removed: removed.length,
        });
        await call(globalArgs, {
          method: "PUT",
          path: mgmt(
            `/projects/${seg(projectId)}/apps/${seg(appId)}/oidc_config`,
          ),
          body,
        });
        const after = await getApp(globalArgs, projectId, appId);
        const afterOidc = obj(obj(after ?? {}).oidcConfig);
        return {
          dataHandles: await writeOne(
            context,
            "oidc-redirect",
            "oidc-redirect",
            `${projectName}-${appId}`,
            {
              projectId,
              appId,
              name: str(live.name),
              redirectUris: asArray(afterOidc.redirectUris).map((uri) =>
                str(uri)
              ),
              postLogoutUris: asArray(afterOidc.postLogoutRedirectUris).map((
                uri,
              ) => str(uri)),
              added,
              removed,
              action: "updated",
              timestamp,
            },
          ),
        };
      },
    },
    update: {
      description:
        "Rename an application, leaving its configuration alone. Idempotent.",
      arguments: UpdateArgs,
      execute: async (
        args: z.infer<typeof UpdateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const live = await resolveApp(globalArgs, projectId, args.app);
        const appId = str(live.id);
        const timestamp = nowIso();
        if (str(live.name) === args.name) {
          context.logger.info("application {id} is already named {name}", {
            id: appId,
            name: args.name,
          });
          return {
            dataHandles: await writeOne(
              context,
              "app",
              "app",
              `${projectName}-${args.name}`,
              shapeApp(projectId, live, "unchanged", timestamp),
            ),
          };
        }
        await call(globalArgs, {
          method: "PUT",
          path: mgmt(`/projects/${seg(projectId)}/apps/${seg(appId)}`),
          body: { name: args.name },
        });
        const after = await getApp(globalArgs, projectId, appId);
        context.logger.info("renamed application {id} to {name}", {
          id: appId,
          name: args.name,
        });
        return {
          dataHandles: await writeOne(
            context,
            "app",
            "app",
            `${projectName}-${args.name}`,
            shapeApp(
              projectId,
              after ?? { ...live, name: args.name },
              "updated",
              timestamp,
            ),
          ),
        };
      },
    },
    setState: {
      description:
        "Deactivate or reactivate an application. Reversible, and a no-op when it is already in that state.",
      arguments: SetStateArgs,
      execute: async (
        args: z.infer<typeof SetStateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const live = await resolveApp(globalArgs, projectId, args.app);
        const appId = str(live.id);
        const before = friendlyState(live.state);
        const timestamp = nowIso();
        if (before === args.state) {
          context.logger.info("application {id} is already {state}", {
            id: appId,
            state: args.state,
          });
          return {
            dataHandles: await writeOne(
              context,
              "state",
              "app-state",
              `${projectName}-${str(live.name)}`,
              {
                kind: "app",
                id: appId,
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
          path: mgmt(`/projects/${seg(projectId)}/apps/${seg(appId)}/${path}`),
          body: {},
        });
        context.logger.info("application {id} is now {state}", {
          id: appId,
          state: args.state,
        });
        return {
          dataHandles: await writeOne(
            context,
            "state",
            "app-state",
            `${projectName}-${str(live.name)}`,
            {
              kind: "app",
              id: appId,
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
    secretRotate: {
      description:
        "Regenerate an application's client secret, verifying the application first. Returns the new secret once; the old one stops working immediately.",
      arguments: SecretRotateArgs,
      execute: async (
        args: z.infer<typeof SecretRotateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const live = await resolveApp(globalArgs, projectId, args.app);
        const appId = str(live.id);
        const kind = live.oidcConfig !== undefined
          ? "oidc_config"
          : live.apiConfig !== undefined
          ? "api_config"
          : null;
        if (!kind) {
          throw new Error(
            `application ${appId} is neither an OIDC nor an API application`,
          );
        }
        context.logger.info("rotating the client secret of {app}", {
          app: str(live.name) || appId,
        });
        const rotated = await call(globalArgs, {
          method: "POST",
          path: mgmt(
            `/projects/${seg(projectId)}/apps/${
              seg(appId)
            }/${kind}/_generate_client_secret`,
          ),
          body: {},
        });
        const config = obj(live.oidcConfig ?? live.apiConfig);
        return {
          dataHandles: await writeOne(
            context,
            "app-credential",
            "app-credential",
            `${projectName}-${str(live.name) || appId}`,
            {
              projectId,
              appId,
              name: str(live.name),
              clientId: str(rotated.body.clientId ?? config.clientId),
              clientSecret: optStr(rotated.body.clientSecret),
              action: "rotated",
              timestamp: nowIso(),
            },
          ),
        };
      },
    },
    delete: {
      kind: "action" as const,
      description:
        "Delete an application. Verify-first: confirm must repeat the live name, and dryRun only reports. Prefer setState inactive, which is reversible.",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const timestamp = nowIso();
        const live = await tryResolveApp(globalArgs, projectId, args.app);
        if (!live) {
          context.logger.warning("no application {app}; nothing to delete", {
            app: args.app,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "app-deletion",
              `${projectName}-${args.app}`,
              {
                kind: "app",
                id: "",
                name: args.app,
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        const appId = str(live.id);
        const name = str(live.name);
        requireConfirm(name, args.confirm, "application name");
        if (args.dryRun) {
          context.logger.info("dry run: would delete application {name}", {
            name,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "app-deletion",
              appId,
              {
                kind: "app",
                id: appId,
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
          path: mgmt(`/projects/${seg(projectId)}/apps/${seg(appId)}`),
        });
        await forgetInstance(context, "app", `${projectName}-${name}`);
        context.logger.warning("deleted application {name}", { name });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "app-deletion",
            appId,
            {
              kind: "app",
              id: appId,
              name,
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
    keyCreate: {
      description:
        "Add a JSON key to an API application for private-key authentication. Returns the key JSON once, marked sensitive.",
      arguments: KeyCreateArgs,
      execute: async (
        args: z.infer<typeof KeyCreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const live = await resolveApp(globalArgs, projectId, args.app);
        const appId = str(live.id);
        const body: Record<string, unknown> = { type: "KEY_TYPE_JSON" };
        if (args.expirationDate) body.expirationDate = args.expirationDate;
        context.logger.info("creating an application key for {app}", {
          app: str(live.name) || appId,
        });
        const created = await call(globalArgs, {
          method: "POST",
          path: mgmt(`/projects/${seg(projectId)}/apps/${seg(appId)}/keys`),
          body,
        });
        const details = created.body.keyDetails;
        const keyJson = typeof details === "string" && details.length > 0
          ? fromBase64(details)
          : undefined;
        return {
          dataHandles: await writeOne(
            context,
            "app-key",
            "app-key",
            `${projectName}-${str(live.name)}-${str(created.body.id)}`,
            {
              projectId,
              appId,
              keyId: str(created.body.id),
              type: "json",
              expirationDate: optStr(args.expirationDate),
              keyJson,
              action: "created",
              timestamp: nowIso(),
            },
          ),
        };
      },
    },
    keyList: {
      kind: "list" as const,
      description:
        "List an application's keys by id and expiry. Read-only; the key material is not readable after it was created.",
      arguments: KeyListArgs,
      execute: async (
        args: z.infer<typeof KeyListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const live = await resolveApp(globalArgs, projectId, args.app);
        const appId = str(live.id);
        const rows = await searchAll(
          globalArgs,
          mgmt(`/projects/${seg(projectId)}/apps/${seg(appId)}/keys/_search`),
        );
        const timestamp = nowIso();
        const keys = rows.map((row) => ({
          projectId,
          appId,
          keyId: str(row.id),
          type: friendlyState(row.type),
          expirationDate: optStr(row.expirationDate),
          action: "observed" as const,
          timestamp,
        }));
        const handles = await writeAll(
          context,
          "app-key",
          "app-key",
          keys,
          (key) => `${projectName}-${str(live.name)}-${key.keyId}`,
        );
        context.logger.info("stored {count} application keys", {
          count: keys.length,
        });
        return { dataHandles: handles };
      },
    },
    keyDelete: {
      kind: "action" as const,
      description:
        "Delete an application key, verifying first that it belongs to the application. dryRun only reports.",
      arguments: KeyDeleteArgs,
      execute: async (
        args: z.infer<typeof KeyDeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const project = await resolveProject(globalArgs, args.project);
        const projectId = str(project.id);
        const projectName = str(project.name) || projectId;
        const live = await resolveApp(globalArgs, projectId, args.app);
        const appId = str(live.id);
        const rows = await searchAll(
          globalArgs,
          mgmt(`/projects/${seg(projectId)}/apps/${seg(appId)}/keys/_search`),
        );
        const timestamp = nowIso();
        if (!rows.some((row) => str(row.id) === args.keyId)) {
          context.logger.warning("no key {key} on this application", {
            key: args.keyId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "app-key-deletion",
              `${projectName}-${str(live.name)}-${args.keyId}`,
              {
                kind: "key",
                id: args.keyId,
                name: str(live.name),
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        if (args.dryRun) {
          context.logger.info("dry run: would delete key {key}", {
            key: args.keyId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "app-key-deletion",
              `${projectName}-${str(live.name)}-${args.keyId}`,
              {
                kind: "key",
                id: args.keyId,
                name: str(live.name),
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
            `/projects/${seg(projectId)}/apps/${seg(appId)}/keys/${
              seg(args.keyId)
            }`,
          ),
        });
        await forgetInstance(
          context,
          "app-key",
          `${projectName}-${str(live.name)}-${args.keyId}`,
        );
        context.logger.warning("deleted application key {key}", {
          key: args.keyId,
        });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "app-key-deletion",
            `${projectName}-${str(live.name)}-${args.keyId}`,
            {
              kind: "key",
              id: args.keyId,
              name: str(live.name),
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
