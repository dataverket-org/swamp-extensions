/**
 * `@dataverket/zitadel/instance` — the instance as its own administrators see
 * it: its domains, the domains it trusts, and who administers it.
 *
 * The system type keeps the domain list with a System API key, which is the
 * only key that may write it. This type reads the same instance with an
 * ordinary service-user key or a person's token, over the v1 Admin API, which
 * is what an audit on a schedule should hold: `read` stores the instance, its
 * domains and its trusted domains; `memberList` stores every holder of an
 * instance role, IAM_OWNER and the rest, which is the question "who can change
 * everything here" put into a data model.
 *
 * Trusted domains are the one thing written: a host Zitadel will accept as the
 * public origin of a request, such as a login UI or an application served on
 * a name that is not one of the instance's own. `trustedDomainAdd` is
 * idempotent; `trustedDomainRemove` is verify-first, with `confirm` and
 * `dryRun`. Both need `iam.write`, the IAM_OWNER role; the reads need
 * `iam.read` and `iam.member.read`, which IAM_OWNER_VIEWER carries.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { call, type Json, searchAll, seg } from "./api.ts";
import {
  assertArg,
  checks,
  type DataHandle,
  DryRun,
  forgetInstance,
  friendlyState,
  GlobalArgsSchema,
  type MethodResult,
  type ModelContext,
  nowIso,
  obj,
  optStr,
  optStrList,
  requireConfirm,
  str,
  writeAll,
  writeOne,
} from "./common.ts";
import {
  InstanceDomain,
  InstanceInfo,
  InstanceMember,
  TrustedDomain,
} from "./schema.ts";

/** A v1 Admin API path. */
function admin(path: string): string {
  return `/admin/v1${path}`;
}

const Empty = z.object({});
const DomainArgs = z.object({
  domain: z.string().min(1).describe("The host, e.g. login.example.org"),
});
const RemoveArgs = z.object({
  domain: z.string().min(1).describe("The trusted domain to remove"),
  confirm: z.string().describe(
    "Must repeat the domain exactly; the method refuses otherwise",
  ),
  dryRun: DryRun.describe("true reports what would be removed and stops"),
});

/** The instance the credential belongs to, from the Admin API. */
async function myInstance(globalArgs: Json): Promise<Json> {
  const result = await call(globalArgs, {
    method: "GET",
    path: admin("/instances/me"),
  });
  return obj(result.body.instance);
}

async function listTrusted(globalArgs: Json): Promise<string[]> {
  const rows = await searchAll(globalArgs, admin("/trusted_domains/_search"));
  return rows.map((row) => str(row.domain)).filter((d) => d);
}

function trustedRecord(
  domain: string,
  action: z.infer<typeof TrustedDomain>["action"],
  timestamp: string,
): z.infer<typeof TrustedDomain> {
  return { domain, action, timestamp };
}

/** The instance, read with the key of one of its own users. */
export const model = {
  type: "@dataverket/zitadel/instance",
  version: "2026.11.08.1",
  upgrades: [],
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    instance: {
      description: "The instance the credential belongs to",
      schema: InstanceInfo,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "instance-domain": {
      description:
        "One domain of the instance: whether it is the primary, whether setup generated it",
      schema: InstanceDomain,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "trusted-domain": {
      description:
        "A host the instance accepts as the public origin of a request",
      schema: TrustedDomain,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    member: {
      description: "A holder of an instance role, and the roles held",
      schema: InstanceMember,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    read: {
      kind: "list" as const,
      description:
        "Read the instance the credential belongs to and store it with its name and version, one resource per domain with the primary and generated flags, and one per trusted domain. Read-only; needs iam.read.",
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        context.logger.info("reading the instance");
        const timestamp = nowIso();
        const me = await myInstance(globalArgs);
        const instanceId = str(me.id);
        if (!instanceId) {
          throw new Error(
            "the Admin API named no instance for this credential",
          );
        }
        const handles: DataHandle[] = await writeOne(
          context,
          "instance",
          "instance",
          instanceId,
          {
            instanceId,
            name: optStr(me.name),
            state: me.state === undefined ? undefined : friendlyState(me.state),
            version: optStr(me.version),
            action: "observed",
            timestamp,
          },
        );
        const domains = await searchAll(globalArgs, admin("/domains/_search"));
        handles.push(
          ...await writeAll(
            context,
            "instance-domain",
            "instance-domain",
            domains.map((row) => ({
              instanceId,
              domain: str(row.domain),
              primary: row.primary === true,
              generated: row.generated === true,
              action: "observed" as const,
              timestamp,
            })),
            (d) => d.domain,
          ),
        );
        const trusted = await listTrusted(globalArgs);
        handles.push(
          ...await writeAll(
            context,
            "trusted-domain",
            "trusted-domain",
            trusted.map((d) => trustedRecord(d, "observed", timestamp)),
            (d) => d.domain,
          ),
        );
        context.logger.info(
          "stored instance {instance} with {domains} domains and {trusted} trusted domains",
          {
            instance: instanceId,
            domains: domains.length,
            trusted: trusted.length,
          },
        );
        return { dataHandles: handles };
      },
    },
    memberList: {
      kind: "list" as const,
      description:
        "List everyone who holds an instance role — IAM_OWNER, IAM_OWNER_VIEWER, IAM_ORG_MANAGER and the rest — and store one resource per member with their roles. Read-only; needs iam.member.read.",
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing the instance's members");
        const timestamp = nowIso();
        const rows = await searchAll(
          context.globalArgs,
          admin("/members/_search"),
        );
        const members = rows.map((row) => ({
          userId: str(row.userId),
          preferredLoginName: optStr(row.preferredLoginName),
          email: optStr(row.email),
          displayName: optStr(row.displayName),
          userType: row.userType === undefined
            ? undefined
            : friendlyState(row.userType),
          orgId: optStr(row.userResourceOwner),
          roles: optStrList(row.roles) ?? [],
          action: "observed" as const,
          timestamp,
        }));
        const handles = await writeAll(
          context,
          "member",
          "member",
          members,
          (m) => m.preferredLoginName ?? m.userId,
        );
        context.logger.info("stored {count} members", {
          count: members.length,
        });
        return { dataHandles: handles };
      },
    },
    trustedDomainAdd: {
      description:
        "Add a trusted domain, so the instance accepts requests whose public origin is that host. Idempotent: a domain already trusted is left as it is. Needs iam.write.",
      arguments: DomainArgs,
      execute: async (
        args: z.infer<typeof DomainArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const domain = assertArg(args.domain, "domain").trim();
        const timestamp = nowIso();
        if ((await listTrusted(globalArgs)).includes(domain)) {
          context.logger.info("domain {domain} is trusted already", { domain });
          return {
            dataHandles: await writeOne(
              context,
              "trusted-domain",
              "trusted-domain",
              domain,
              trustedRecord(domain, "unchanged", timestamp),
            ),
          };
        }
        context.logger.info("trusting domain {domain}", { domain });
        await call(globalArgs, {
          method: "POST",
          path: admin("/trusted_domains"),
          body: { domain },
        });
        return {
          dataHandles: await writeOne(
            context,
            "trusted-domain",
            "trusted-domain",
            domain,
            trustedRecord(domain, "created", timestamp),
          ),
        };
      },
    },
    trustedDomainRemove: {
      kind: "action" as const,
      description:
        "Stop trusting a domain, after which requests with that public origin are refused. Verify-first: the domain has to be trusted now, confirm must repeat it, and dryRun only reports. Needs iam.write.",
      arguments: RemoveArgs,
      execute: async (
        args: z.infer<typeof RemoveArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const domain = assertArg(args.domain, "domain").trim();
        const live = (await listTrusted(globalArgs)).find((d) => d === domain);
        if (!live) throw new Error(`domain ${domain} is not trusted`);
        requireConfirm(live, args.confirm, "trusted domain");
        const timestamp = nowIso();
        if (args.dryRun) {
          context.logger.info(
            "dry run: would stop trusting domain {domain}",
            { domain },
          );
          return {
            dataHandles: await writeOne(
              context,
              "trusted-domain",
              "trusted-domain",
              domain,
              trustedRecord(domain, "planned", timestamp),
            ),
          };
        }
        await call(globalArgs, {
          method: "DELETE",
          path: admin(`/trusted_domains/${seg(domain)}`),
        });
        await forgetInstance(context, "trusted-domain", domain);
        context.logger.warning("stopped trusting domain {domain}", { domain });
        return {
          dataHandles: await writeOne(
            context,
            "trusted-domain",
            "trusted-domain",
            domain,
            trustedRecord(domain, "removed", timestamp),
          ),
        };
      },
    },
  },
};
