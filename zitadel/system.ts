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
 * The scope is the four domain operations and no other, although the role could
 * do more. `domainRemove` is verify-first: `confirm` must repeat the live
 * domain, a generated domain is refused before Zitadel refuses it, and `dryRun`
 * only reports. `domainAdd` and `domainSetPrimary` are idempotent.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  asArray,
  call,
  credentialKind,
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
  type MethodResult,
  type ModelContext,
  nowIso,
  optStr,
  requireConfirm,
  str,
  writeAll,
  writeOne,
} from "./common.ts";
import { InstanceDomain, InstanceInfo } from "./schema.ts";

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
const Empty = z.object({});

/** The instance to act on, as the System API lists it. */
interface LiveInstance {
  id: string;
  name?: string;
  state?: string;
}

/**
 * The instance to act on: the one named, else the one the System API lists.
 * Two or more without a name is an error that names them.
 */
async function resolveInstance(globalArgs: Json): Promise<LiveInstance> {
  const named = str(globalArgs.instanceId);
  if (named) return { id: named };
  const result = await call(globalArgs, {
    method: "POST",
    path: system("/instances/_search"),
    body: { query: { offset: "0", limit: 1000, asc: true } },
  });
  const instances = asArray(result.body.result).filter((row) => str(row.id))
    .map((row) => ({
      id: str(row.id),
      name: optStr(row.name),
      state: optStr(row.state),
    }));
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
  version: "2026.11.02.1",
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
        "The instance answers the System API and the key is one it was configured with",
      labels: ["live"],
      execute: async (context: CheckContext): Promise<CheckResult> => {
        const g = context.globalArgs as unknown as Json;
        try {
          await getToken(g);
          await resolveInstance(g);
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
      description: "The instance the System API user acts on",
      schema: InstanceInfo,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
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
          ...await writeOne(context, "instance", "instance", instanceId, {
            instanceId,
            name: instance.name,
            state: instance.state,
            action: "observed",
            timestamp,
          }),
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
