/**
 * `@dataverket/openstack/application-credential` — Keystone application
 * credentials through the `openstack` CLI: discover, create (the secret is
 * shown once and stored sensitively) and delete.
 *
 * Keystone only lets a password-authenticated user, or an *unrestricted*
 * application credential, create and delete application credentials. A
 * model instance authenticating with a restricted credential can list and
 * read but its `create`/`delete` will be refused by the cloud.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { isNotFound, openstack, openstackJson } from "./cli.ts";
import {
  assertArg,
  assertList,
  bool,
  checks,
  cliOptions,
  type DataHandle,
  GlobalArgsSchema,
  instanceName,
  mapLimit,
  type MethodResult,
  type ModelContext,
  obj,
  objList,
  type Raw,
  repeatFlag,
  sanitizeInstanceName,
  str,
  writeAll,
} from "./common.ts";

const PREFIX = "appcred";

/** One application credential as written to the `applicationCredential` spec. */
export const ApplicationCredentialSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  projectId: z.string(),
  roles: z.array(z.string()).describe("Role names the credential carries"),
  unrestricted: z.boolean().describe(
    "May itself create and delete application credentials",
  ),
  expiresAt: z.string().describe("Empty when it never expires"),
  accessRules: z.string().describe(
    "JSON access rules, empty when unrestricted by rules",
  ),
});
/** {@link ApplicationCredentialSchema} */
export type ApplicationCredential = z.infer<typeof ApplicationCredentialSchema>;

/** The secret of a credential this model created; shown once by Keystone. */
export const SecretSchema = z.object({
  name: z.string(),
  id: z.string(),
  secret: z.string().meta({ sensitive: true }),
});

/**
 * Shape a raw `application credential show` object (the identity commands
 * print capitalised column names) into an {@link ApplicationCredential}.
 */
export function normalizeApplicationCredential(
  raw: Raw,
): ApplicationCredential {
  const rules = raw["Access Rules"];
  return {
    id: str(raw.ID),
    name: str(raw.Name),
    description: str(raw.Description),
    projectId: str(raw["Project ID"]),
    roles: objList(raw.Roles).map((r) => str(r.name)),
    unrestricted: bool(raw.Unrestricted),
    expiresAt: str(raw["Expires At"]),
    accessRules: rules === null || rules === undefined ? "" : str(rules),
  };
}

const KIND = ["application", "credential"];

async function showCredential(
  context: ModelContext,
  target: string,
): Promise<Raw> {
  const raw = obj(
    await openstackJson(cliOptions(context.globalArgs), [
      ...KIND,
      "show",
      assertArg(target, "applicationCredential"),
    ], context.signal),
  );
  if (!str(raw.ID)) {
    throw new Error(
      `openstack application credential show returned no ID: ${str(raw)}`,
    );
  }
  return raw;
}

async function showCredentialOrNull(
  context: ModelContext,
  target: string,
): Promise<Raw | null> {
  try {
    return await showCredential(context, target);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

async function writeCredential(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "applicationCredential", PREFIX, [
    normalizeApplicationCredential(raw),
  ]);
}

const Target = z.string().min(1).describe("Application credential name or ID");
const ListArgs = z.object({});
const GetArgs = z.object({ applicationCredential: Target });
const CreateArgs = z.object({
  name: z.string().min(1).describe(
    "Credential name; an existing one of the same name is reused (its secret is not recoverable)",
  ),
  roles: z.array(z.string()).optional().describe(
    "Roles to grant; default is every role the user holds on the project",
  ),
  description: z.string().optional(),
  expiration: z.string().optional().describe(
    "ISO-8601 expiry, e.g. 2027-01-01T00:00:00",
  ),
  unrestricted: z.boolean().default(false),
});
const DeleteArgs = z.object({ applicationCredential: Target });

/** Keystone application credential model. */
export const model = {
  type: "@dataverket/openstack/application-credential",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    applicationCredential: {
      description:
        "A Keystone application credential: roles, restrictions and expiry (never the secret)",
      schema: ApplicationCredentialSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    secret: {
      description:
        "The secret of a credential created by this model; written once at create",
      schema: SecretSchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    list: {
      description:
        "Discover the caller's application credentials and store each one",
      arguments: ListArgs,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing application credentials");
        const rows = assertList(
          await openstackJson(cliOptions(context.globalArgs), [
            ...KIND,
            "list",
            "-c",
            "ID",
          ], context.signal),
          "application credential list",
        );
        const ids = rows.map((r) => str(r.ID)).filter((id) => id.length > 0);
        const raws = await mapLimit(
          ids,
          context.globalArgs.concurrency,
          (id) => showCredential(context, id),
        );
        const creds = raws.map(normalizeApplicationCredential);
        const handles = await writeAll(
          context,
          "applicationCredential",
          PREFIX,
          creds,
        );
        context.logger.info("stored {count} application credentials", {
          count: creds.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one application credential by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading application credential {name}", {
          name: args.applicationCredential,
        });
        return {
          dataHandles: await writeCredential(
            context,
            await showCredential(context, args.applicationCredential),
          ),
        };
      },
    },
    create: {
      description:
        "Create an application credential and store its one-time secret sensitively; an existing name is reused without a secret",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.name, "name");
        const existing = await showCredentialOrNull(context, args.name);
        if (existing) {
          context.logger.warning(
            "application credential {name} already exists as {id}; reusing it, but its secret cannot be recovered",
            { name: args.name, id: str(existing.ID) },
          );
          return { dataHandles: await writeCredential(context, existing) };
        }
        const cli = [...KIND, "create"];
        cli.push(...repeatFlag("--role", args.roles, "role"));
        if (args.description !== undefined) {
          cli.push("--description", args.description);
        }
        if (args.expiration) {
          cli.push("--expiration", assertArg(args.expiration, "expiration"));
        }
        cli.push(args.unrestricted ? "--unrestricted" : "--restricted");
        context.logger.info("creating application credential {name}", {
          name: args.name,
        });
        const created = obj(
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            args.name,
          ], context.signal),
        );
        const secret = str(created.Secret);
        const id = str(created.ID);
        if (!id || !secret) {
          throw new Error(
            "openstack application credential create returned no ID or Secret",
          );
        }
        const handles = await writeCredential(
          context,
          await showCredential(context, id),
        );
        handles.push(
          await context.writeResource(
            "secret",
            `secret-${sanitizeInstanceName(args.name)}`,
            {
              name: args.name,
              id,
              secret,
            },
          ),
        );
        context.logger.info(
          "stored the secret of application credential {name}",
          { name: args.name },
        );
        return { dataHandles: handles };
      },
    },
    delete: {
      description:
        "Delete an application credential (no-op when already gone) and drop its stored resources",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showCredentialOrNull(
          context,
          args.applicationCredential,
        );
        if (!existing) {
          context.logger.info("application credential {name} is already gone", {
            name: args.applicationCredential,
          });
          return { dataHandles: [] };
        }
        const cred = normalizeApplicationCredential(existing);
        context.logger.info("deleting application credential {name} ({id})", {
          name: cred.name,
          id: cred.id,
        });
        await openstack(cliOptions(context.globalArgs), [
          ...KIND,
          "delete",
          cred.id,
        ], context.signal);
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, cred));
          await context.deleteResource(
            `secret-${sanitizeInstanceName(cred.name)}`,
          );
        }
        return { dataHandles: [] };
      },
    },
  },
};
