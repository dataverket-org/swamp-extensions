/**
 * `@dataverket/zitadel/system` — the instance's domain list, kept with a
 * System API user.
 *
 * Zitadel resolves every request by its Host against the instance's domains,
 * and the list is written by nobody but a System API user: adding a custom
 * domain, removing one and choosing the primary all need `system.domain.write`,
 * which only the system role `SYSTEM_OWNER` carries. That user is a key named
 * in Zitadel's configuration (`SystemAPIUsers`), not a user in its database, so
 * this type authenticates with `systemKeyFile` and `systemUser` and with
 * nothing else: the signed assertion is the bearer, verified against the
 * public key the instance was configured with.
 *
 * The scope is the four domain operations and the instances themselves, and no
 * other, although the role could do more. `domainRemove` is verify-first:
 * `confirm` must repeat the live domain, a generated domain is refused before
 * Zitadel refuses it, and `dryRun` only reports. `domainAdd` and
 * `domainSetPrimary` are idempotent.
 *
 * `instanceList` is the one read that spans instances, which is how one
 * deployment hosting several is seen as one thing. `instanceCreate` makes an
 * instance with its first organization and a machine user as its owner, and
 * emits that owner's token or key exactly once into a sensitive spec: a human
 * owner would need a password in the request, and no password is ever an
 * argument in this extension, so people are added to the instance afterwards
 * with the user type as that owner. An instance already named so is left as it
 * is. There is no `instanceRemove`: removing an instance removes every
 * organization and user in it, and stays a deliberate act with the key in hand.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  asArray,
  call,
  credentialKind,
  fromBase64,
  getToken,
  type Json,
  seg,
} from "./api.ts";
import {
  assertArg,
  type CheckContext,
  type CheckResult,
  DryRun,
  forgetInstance,
  friendlyState,
  type MethodResult,
  type ModelContext,
  nowIso,
  optStr,
  requireConfirm,
  str,
  writeAll,
  writeOne,
} from "./common.ts";
import {
  InstanceDomain,
  InstanceInfo,
  InstanceOwnerCredential,
} from "./schema.ts";

/** What a System API definition names: the instance, the key, the key's name. */
export const SystemGlobalArgsSchema = z.object({
  apiUrl: z.string().describe(
    "Zitadel base URL and issuer, e.g. https://zitadel.example.org; the " +
      "assertion's audience, which must equal what ExternalDomain, " +
      "ExternalPort and ExternalSecure build on the server",
  ),
  systemUser: z.string().describe(
    "The key's name in the instance's SystemAPIUsers configuration; the " +
      "assertion's issuer and subject",
  ),
  systemKeyFile: z.string().describe(
    "Path to the System API user's RSA private key, PEM, read at call time; " +
      "a leading ~/ is expanded from HOME. Name a path that exists for one " +
      "run, such as what sops exec-file provides, rather than a file on disk",
  ),
  instanceId: z.string().optional().describe(
    "The instance to act on. Omit when the System API lists exactly one, " +
      "which is then taken",
  ),
  httpTimeoutMs: z.coerce.number().int().default(30000).describe(
    "Per-request timeout in milliseconds",
  ),
});

/** Resolved global arguments, as a method sees them. */
export type SystemGlobalArgs = z.infer<typeof SystemGlobalArgsSchema>;

/** A System API path. */
function system(path: string): string {
  return `/system/v1${path}`;
}

const DomainArgs = z.object({
  domain: z.string().min(1).describe("The domain, e.g. id.example.org"),
});
const RemoveArgs = z.object({
  domain: z.string().min(1).describe("The domain to remove"),
  confirm: z.string().describe(
    "Must repeat the domain exactly; the method refuses otherwise",
  ),
  dryRun: DryRun.describe("true reports what would be removed and stops"),
});
const InstanceCreateArgs = z.object({
  name: z.string().min(1).describe(
    "The instance's name; an instance already named so is left as it is",
  ),
  firstOrgName: z.string().optional().describe(
    "The first organization's name; Zitadel names it ZITADEL when omitted",
  ),
  customDomain: z.string().optional().describe(
    "A custom domain added at creation, e.g. id.example.org, beside the " +
      "generated one, and made the primary",
  ),
  defaultLanguage: z.string().optional().describe(
    "BCP-47 tag for the instance's default language, e.g. nb or en",
  ),
  ownerUsername: z.string().min(1).default("admin").describe(
    "The machine user made in the first organization as the instance's " +
      "owner, IAM_OWNER; people are added afterwards with the user type as " +
      "this owner",
  ),
  ownerName: z.string().optional().describe(
    "The owner's display name; the username when omitted",
  ),
  ownerCredential: z.enum(["pat", "key"]).default("pat").describe(
    "What is minted for the owner, once: pat is a personal access token that " +
      "accessTokenFile can name, key a machine key's JSON that keyJsonFile can",
  ),
  expirationDate: z.string().min(1).describe(
    "RFC3339 expiry of the owner's token or key, e.g. 2027-01-01T00:00:00Z; " +
      "the System API requires one",
  ),
});
const Empty = z.object({});

/** The instance to act on, as the System API lists it. */
interface LiveInstance {
  id: string;
  name?: string;
  state?: string;
  version?: string;
}

/** Every instance the System API lists. */
async function listInstances(globalArgs: Json): Promise<LiveInstance[]> {
  const result = await call(globalArgs, {
    method: "POST",
    path: system("/instances/_search"),
    body: { query: { offset: "0", limit: 1000, asc: true } },
  });
  return asArray(result.body.result).filter((row) => str(row.id))
    .map(shapeLiveInstance);
}

function shapeLiveInstance(row: Json): LiveInstance {
  return {
    id: str(row.id),
    name: optStr(row.name),
    state: optStr(row.state),
    version: optStr(row.version),
  };
}

/** The stored record of one instance. */
function instanceRecord(
  live: LiveInstance,
  action: z.infer<typeof InstanceInfo>["action"],
  timestamp: string,
): z.infer<typeof InstanceInfo> {
  return {
    instanceId: live.id,
    name: live.name,
    state: live.state ? friendlyState(live.state) : undefined,
    version: live.version,
    action,
    timestamp,
  };
}

/**
 * The instance to act on: the one named, else the one the System API lists.
 * Two or more without a name is an error that names them.
 */
async function resolveInstance(globalArgs: Json): Promise<LiveInstance> {
  const named = str(globalArgs.instanceId);
  if (named) return { id: named };
  const instances = await listInstances(globalArgs);
  if (instances.length === 1) return instances[0];
  if (instances.length === 0) {
    throw new Error("the System API lists no instance");
  }
  throw new Error(
    `the System API lists ${instances.length} instances (${
      instances.map((i) => i.id).join(", ")
    }); name one with instanceId`,
  );
}

interface LiveDomain {
  domain: string;
  primary: boolean;
  generated: boolean;
}

async function listDomains(
  globalArgs: Json,
  instanceId: string,
): Promise<LiveDomain[]> {
  const result = await call(globalArgs, {
    method: "POST",
    path: system(`/instances/${seg(instanceId)}/domains/_search`),
    body: { query: { offset: "0", limit: 1000, asc: true } },
  });
  return asArray(result.body.result).map((row) => ({
    domain: str(row.domain),
    primary: row.primary === true,
    generated: row.generated === true,
  }));
}

function shapeDomain(
  instanceId: string,
  live: LiveDomain,
  action: z.infer<typeof InstanceDomain>["action"],
  timestamp: string,
): z.infer<typeof InstanceDomain> {
  return {
    instanceId,
    domain: live.domain,
    primary: live.primary,
    generated: live.generated,
    action,
    timestamp,
  };
}

/** The instance's domains, kept with a System API user. */
export const model = {
  type: "@dataverket/zitadel/system",
  version: "2026.11.08.1",
  upgrades: [
    {
      toVersion: "2026.11.06.1",
      description:
        "Released with the settings change of this version (secretGeneratorSet); nothing in this type changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.08.1",
      description:
        "instanceList lists every instance the deployment hosts and instanceCreate makes one with a machine owner whose token or key is emitted once; the instance record's state is now the friendly spelling (running, not INSTANCE_STATE_RUNNING) and carries the version. No argument changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: SystemGlobalArgsSchema,
  checks: {
    "credential-named": {
      description:
        "systemKeyFile and systemUser name the System API user's key",
      labels: ["policy"],
      execute: (context: CheckContext): Promise<CheckResult> => {
        try {
          const kind = credentialKind(context.globalArgs as unknown as Json);
          if (kind !== "systemKeyFile") {
            return Promise.resolve({
              pass: false,
              errors: [`this type takes systemKeyFile, not ${kind}`],
            });
          }
          return Promise.resolve({ pass: true });
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return Promise.resolve({ pass: false, errors: [message] });
        }
      },
    },
    "reachable": {
      description:
        "The instance answers the System API and the key is one it was configured with; which instance a domain method acts on is settled when it runs",
      labels: ["live"],
      execute: async (context: CheckContext): Promise<CheckResult> => {
        const g = context.globalArgs as unknown as Json;
        try {
          await getToken(g);
          await listInstances(g);
          return { pass: true };
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          return {
            pass: false,
            errors: [
              `cannot reach the System API at ${str(g.apiUrl)} as ${
                str(g.systemUser)
              }: ${message}`,
            ],
          };
        }
      },
    },
  },
  resources: {
    "instance-domain": {
      description:
        "One domain of the instance: whether it is the primary, whether setup generated it",
      schema: InstanceDomain,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    instance: {
      description:
        "An instance this deployment hosts: the one acted on, or each one instanceList saw",
      schema: InstanceInfo,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "instance-owner": {
      description:
        "The token or key of a new instance's owner, emitted once by instanceCreate",
      schema: InstanceOwnerCredential,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    instanceList: {
      kind: "list" as const,
      description:
        "List every instance this deployment hosts and store one resource per instance, with its name, state and version. Read-only, and the only read here that spans instances; instanceId is not consulted.",
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs as unknown as Json;
        context.logger.info("listing the instances the System API user sees");
        const timestamp = nowIso();
        const instances = (await listInstances(globalArgs)).map((live) =>
          instanceRecord(live, "observed", timestamp)
        );
        const handles = await writeAll(
          context,
          "instance",
          "instance",
          instances,
          (instance) => instance.instanceId,
        );
        context.logger.info("stored {count} instances", {
          count: instances.length,
        });
        return { dataHandles: handles };
      },
    },
    instanceCreate: {
      kind: "create" as const,
      description:
        "Create an instance with its first organization and a machine user as its owner, IAM_OWNER, whose personal access token or machine key is emitted once into the sensitive instance-owner spec. Idempotent on the name: an instance already named so is stored as unchanged and nothing is minted. The same deployment then answers for the new instance by its generated domain and by customDomain when given.",
      arguments: InstanceCreateArgs,
      execute: async (
        args: z.infer<typeof InstanceCreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs as unknown as Json;
        const name = assertArg(args.name, "name").trim();
        const timestamp = nowIso();
        const existing = (await listInstances(globalArgs)).find((i) =>
          i.name === name
        );
        if (existing) {
          context.logger.info(
            "instance {name} is already there as {instance}",
            { name, instance: existing.id },
          );
          return {
            dataHandles: await writeOne(
              context,
              "instance",
              "instance",
              existing.id,
              instanceRecord(existing, "unchanged", timestamp),
            ),
          };
        }
        const machine: Json = {
          userName: args.ownerUsername,
          name: args.ownerName ?? args.ownerUsername,
        };
        if (args.ownerCredential === "key") {
          machine.machineKey = {
            type: "KEY_TYPE_JSON",
            expirationDate: args.expirationDate,
          };
        } else {
          machine.personalAccessToken = {
            expirationDate: args.expirationDate,
          };
        }
        const body: Json = { instanceName: name, machine };
        if (args.firstOrgName) body.firstOrgName = args.firstOrgName;
        if (args.customDomain) body.customDomain = args.customDomain;
        if (args.defaultLanguage) body.defaultLanguage = args.defaultLanguage;
        context.logger.info(
          "creating instance {name} owned by machine user {owner} with a {kind}",
          { name, owner: args.ownerUsername, kind: args.ownerCredential },
        );
        const created = await call(globalArgs, {
          method: "POST",
          path: system("/instances/_create"),
          body,
        });
        const instanceId = str(created.body.instanceId);
        if (!instanceId) {
          throw new Error("Zitadel created the instance but named no id");
        }
        const secret = args.ownerCredential === "key"
          ? fromBase64(str(created.body.machineKey))
          : str(created.body.pat);
        if (!secret) {
          throw new Error(
            `Zitadel created instance ${instanceId} but returned no ${args.ownerCredential} for its owner`,
          );
        }
        // The owner's credential is stored before anything else is asked of
        // Zitadel: a new instance is not readable the moment it is created,
        // and a read that fails here must not lose the one copy of the secret.
        const handles = await writeOne(
          context,
          "instance-owner",
          "instance-owner",
          `${name}-${args.ownerUsername}`,
          {
            instanceId,
            instanceName: name,
            username: args.ownerUsername,
            kind: args.ownerCredential,
            expirationDate: args.expirationDate,
            secret,
            action: "created",
            timestamp,
          },
        );
        handles.push(
          ...await writeOne(
            context,
            "instance",
            "instance",
            instanceId,
            instanceRecord({ id: instanceId, name }, "created", timestamp),
          ),
        );
        context.logger.warning(
          "created instance {instance} ({name}); its owner's {kind} is stored once as a secret",
          { instance: instanceId, name, kind: args.ownerCredential },
        );
        return { dataHandles: handles };
      },
    },
    domainList: {
      kind: "list" as const,
      description:
        "List the instance's domains and store one resource per domain, saying which is primary and which setup generated. Read-only; the record to check before and after any change to the list.",
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs as unknown as Json;
        const instance = await resolveInstance(globalArgs);
        const instanceId = instance.id;
        context.logger.info("listing the domains of instance {instance}", {
          instance: instanceId,
        });
        const timestamp = nowIso();
        const domains = (await listDomains(globalArgs, instanceId)).map((d) =>
          shapeDomain(instanceId, d, "observed", timestamp)
        );
        const handles = await writeAll(
          context,
          "instance-domain",
          "instance-domain",
          domains,
          (d) => d.domain,
        );
        handles.push(
          ...await writeOne(
            context,
            "instance",
            "instance",
            instanceId,
            instanceRecord(instance, "observed", timestamp),
          ),
        );
        context.logger.info("stored {count} domains", {
          count: domains.length,
        });
        return { dataHandles: handles };
      },
    },
    domainAdd: {
      description:
        "Add a custom domain to the instance, so it answers requests whose Host is that domain and issues tokens with it as issuer. Idempotent: a domain already there is left as it is. Does not make it primary.",
      arguments: DomainArgs,
      execute: async (
        args: z.infer<typeof DomainArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs as unknown as Json;
        const domain = assertArg(args.domain, "domain").trim();
        const instance = await resolveInstance(globalArgs);
        const instanceId = instance.id;
        const live = (await listDomains(globalArgs, instanceId)).find((d) =>
          d.domain === domain
        );
        const timestamp = nowIso();
        if (live) {
          context.logger.info("domain {domain} is already there", { domain });
          return {
            dataHandles: await writeOne(
              context,
              "instance-domain",
              "instance-domain",
              domain,
              shapeDomain(instanceId, live, "unchanged", timestamp),
            ),
          };
        }
        context.logger.info("adding domain {domain} to instance {instance}", {
          domain,
          instance: instanceId,
        });
        await call(globalArgs, {
          method: "POST",
          path: system(`/instances/${seg(instanceId)}/domains`),
          body: { domain },
        });
        return {
          dataHandles: await writeOne(
            context,
            "instance-domain",
            "instance-domain",
            domain,
            shapeDomain(
              instanceId,
              { domain, primary: false, generated: false },
              "created",
              timestamp,
            ),
          ),
        };
      },
    },
    domainRemove: {
      description:
        "Remove a custom domain from the instance, after which requests with that Host are answered 404. Verify-first: confirm must repeat the live domain, a generated domain is refused since Zitadel keeps those for good, the primary is refused until another is primary, and dryRun only reports.",
      arguments: RemoveArgs,
      execute: async (
        args: z.infer<typeof RemoveArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs as unknown as Json;
        const domain = assertArg(args.domain, "domain").trim();
        const instance = await resolveInstance(globalArgs);
        const instanceId = instance.id;
        const live = (await listDomains(globalArgs, instanceId)).find((d) =>
          d.domain === domain
        );
        if (!live) {
          throw new Error(`domain ${domain} is not on instance ${instanceId}`);
        }
        requireConfirm(live.domain, args.confirm, "domain");
        if (live.generated) {
          throw new Error(
            `domain ${domain} was generated by setup and cannot be removed`,
          );
        }
        if (live.primary) {
          throw new Error(
            `domain ${domain} is the primary; set another primary first`,
          );
        }
        const timestamp = nowIso();
        if (args.dryRun) {
          context.logger.info("dry run: would remove domain {domain}", {
            domain,
          });
          return {
            dataHandles: await writeOne(
              context,
              "instance-domain",
              "instance-domain",
              domain,
              shapeDomain(instanceId, live, "planned", timestamp),
            ),
          };
        }
        await call(globalArgs, {
          method: "DELETE",
          path: system(
            `/instances/${seg(instanceId)}/domains/${seg(domain)}`,
          ),
        });
        await forgetInstance(context, "instance-domain", domain);
        context.logger.warning(
          "removed domain {domain} from instance {instance}",
          {
            domain,
            instance: instanceId,
          },
        );
        return {
          dataHandles: await writeOne(
            context,
            "instance-domain",
            "instance-domain",
            domain,
            shapeDomain(instanceId, live, "removed", timestamp),
          ),
        };
      },
    },
    domainSetPrimary: {
      description:
        "Make a domain the instance's primary: the one Zitadel links to in a mail that no request triggered. The domain must be on the instance already. Idempotent.",
      arguments: DomainArgs,
      execute: async (
        args: z.infer<typeof DomainArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs as unknown as Json;
        const domain = assertArg(args.domain, "domain").trim();
        const instance = await resolveInstance(globalArgs);
        const instanceId = instance.id;
        const live = (await listDomains(globalArgs, instanceId)).find((d) =>
          d.domain === domain
        );
        if (!live) {
          throw new Error(
            `domain ${domain} is not on instance ${instanceId}; add it first`,
          );
        }
        const timestamp = nowIso();
        if (live.primary) {
          context.logger.info("domain {domain} is the primary already", {
            domain,
          });
          return {
            dataHandles: await writeOne(
              context,
              "instance-domain",
              "instance-domain",
              domain,
              shapeDomain(instanceId, live, "unchanged", timestamp),
            ),
          };
        }
        context.logger.info("setting domain {domain} as primary", { domain });
        await call(globalArgs, {
          method: "POST",
          path: system(`/instances/${seg(instanceId)}/domains/_set_primary`),
          body: { domain },
        });
        return {
          dataHandles: await writeOne(
            context,
            "instance-domain",
            "instance-domain",
            domain,
            shapeDomain(
              instanceId,
              { ...live, primary: true },
              "updated",
              timestamp,
            ),
          ),
        };
      },
    },
  },
};
