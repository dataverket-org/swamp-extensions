/**
 * `@dataverket/openstack/security-group` — Neutron security groups and their
 * rules through the `openstack` CLI.
 *
 * Rules are stored inline on the `securityGroup` resource (as `security group
 * show` reports them); `addRule` and `removeRule` re-read the group afterwards
 * so the stored rule list is always the live one.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { isConflict, openstack, openstackJson } from "./cli.ts";
import {
  assertArg,
  assertShow,
  bool,
  checks,
  cliOptions,
  type DataHandle,
  GlobalArgsSchema,
  instanceName,
  isNotFound,
  listThenShow,
  type MethodResult,
  type ModelContext,
  numOrNull,
  objList,
  type Raw,
  repeatFlag,
  showRaw,
  showRawOrNull,
  str,
  strList,
  writeAll,
} from "./common.ts";

const KIND = ["security", "group"];
const PREFIX = "securitygroup";

/** One rule inside a security group. */
export const RuleSchema = z.object({
  id: z.string(),
  direction: z.string().describe("ingress or egress"),
  ethertype: z.string().describe("IPv4 or IPv6"),
  protocol: z.string().describe("tcp, udp, icmp, ... or empty for any"),
  portRangeMin: z.number().nullable(),
  portRangeMax: z.number().nullable(),
  remoteIpPrefix: z.string().describe("CIDR, empty when unrestricted"),
  remoteGroupId: z.string(),
  description: z.string(),
});

/** One security group as written to the `securityGroup` spec. */
export const SecurityGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  stateful: z.boolean(),
  shared: z.boolean(),
  projectId: z.string(),
  tags: z.array(z.string()),
  rules: z.array(RuleSchema),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** {@link SecurityGroupSchema} */
export type SecurityGroup = z.infer<typeof SecurityGroupSchema>;

/** Shape a raw `security group show` object into a {@link SecurityGroup}. */
export function normalizeSecurityGroup(raw: Raw): SecurityGroup {
  return {
    id: str(raw.id),
    name: str(raw.name),
    description: str(raw.description),
    stateful: bool(raw.stateful),
    shared: bool(raw.is_shared ?? raw.shared),
    projectId: str(raw.project_id),
    tags: strList(raw.tags),
    rules: objList(raw.rules).map((r) => ({
      id: str(r.id),
      direction: str(r.direction),
      ethertype: str(r.ethertype),
      protocol: str(r.protocol),
      portRangeMin: numOrNull(r.port_range_min),
      portRangeMax: numOrNull(r.port_range_max),
      remoteIpPrefix: str(r.remote_ip_prefix),
      remoteGroupId: str(r.remote_group_id),
      description: str(r.description),
    })),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

async function writeGroup(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "securityGroup", PREFIX, [
    normalizeSecurityGroup(raw),
  ]);
}

const Target = z.string().min(1).describe("Security group name or ID");
const ListArgs = z.object({
  name: z.string().optional().describe(
    "Keep only groups with exactly this name",
  ),
});
const GetArgs = z.object({ securityGroup: Target });
const CreateArgs = z.object({
  name: z.string().min(1).describe("Group name; an existing group is reused"),
  description: z.string().optional(),
  stateless: z.boolean().default(false),
  tags: z.array(z.string()).optional(),
});
const UpdateArgs = z.object({
  securityGroup: Target,
  name: z.string().optional(),
  description: z.string().optional(),
});
const DeleteArgs = z.object({ securityGroup: Target });
const AddRuleArgs = z.object({
  securityGroup: Target,
  direction: z.enum(["ingress", "egress"]).default("ingress"),
  protocol: z.string().optional().describe("tcp, udp, icmp, ... default any"),
  portRange: z.string().regex(/^\d+(:\d+)?$/).optional().describe(
    "Destination port or range, e.g. 22 or 137:139",
  ),
  remoteIp: z.string().optional().describe(
    "Remote CIDR, default 0.0.0.0/0 or ::/0",
  ),
  remoteGroup: z.string().optional().describe(
    "Remote security group (name or ID)",
  ),
  ethertype: z.enum(["IPv4", "IPv6"]).optional(),
  icmpType: z.number().int().optional(),
  icmpCode: z.number().int().optional(),
  description: z.string().optional(),
});
const RemoveRuleArgs = z.object({
  securityGroup: Target,
  rule: z.string().min(1).describe("Rule ID"),
});

/** Neutron security group model. */
export const model = {
  type: "@dataverket/openstack/security-group",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    securityGroup: {
      description: "A Neutron security group with its rules inline",
      schema: SecurityGroupSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "Discover the project's security groups (with rules) and store each one",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing security groups");
        let groups = (await listThenShow(context, KIND, [])).map(
          normalizeSecurityGroup,
        );
        if (args.name) groups = groups.filter((g) => g.name === args.name);
        const handles = await writeAll(
          context,
          "securityGroup",
          PREFIX,
          groups,
        );
        context.logger.info("stored {count} security groups", {
          count: groups.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one security group by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading security group {group}", {
          group: args.securityGroup,
        });
        return {
          dataHandles: await writeGroup(
            context,
            await showRaw(context, KIND, args.securityGroup),
          ),
        };
      },
    },
    create: {
      description:
        "Create a security group; an existing group of the same name is reused",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.name, "name");
        const existing = await showRawOrNull(context, KIND, args.name);
        if (existing) {
          context.logger.info(
            "security group {name} already exists as {id}; reusing",
            {
              name: args.name,
              id: str(existing.id),
            },
          );
          return { dataHandles: await writeGroup(context, existing) };
        }
        const cli = ["security", "group", "create"];
        if (args.description !== undefined) {
          cli.push("--description", args.description);
        }
        if (args.stateless) cli.push("--stateless");
        cli.push(...repeatFlag("--tag", args.tags, "tag"));
        context.logger.info("creating security group {name}", {
          name: args.name,
        });
        const created = assertShow(
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            args.name,
          ], context.signal),
          "security group create",
        );
        return {
          dataHandles: await writeGroup(
            context,
            await showRaw(context, KIND, str(created.id)),
          ),
        };
      },
    },
    update: {
      description: "Rename or re-describe a security group",
      arguments: UpdateArgs,
      execute: async (
        args: z.infer<typeof UpdateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const before = normalizeSecurityGroup(
          await showRaw(context, KIND, args.securityGroup),
        );
        const set: string[] = [];
        if (args.name !== undefined) {
          set.push("--name", assertArg(args.name, "name"));
        }
        if (args.description !== undefined) {
          set.push("--description", args.description);
        }
        if (set.length === 0) {
          context.logger.info("nothing to update on security group {id}", {
            id: before.id,
          });
          return {
            dataHandles: await writeAll(context, "securityGroup", PREFIX, [
              before,
            ]),
          };
        }
        context.logger.info("updating security group {id}", { id: before.id });
        await openstack(cliOptions(context.globalArgs), [
          "security",
          "group",
          "set",
          ...set,
          before.id,
        ], context.signal);
        const after = normalizeSecurityGroup(
          await showRaw(context, KIND, before.id),
        );
        if (after.name !== before.name && context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, before));
        }
        return {
          dataHandles: await writeAll(context, "securityGroup", PREFIX, [
            after,
          ]),
        };
      },
    },
    delete: {
      description:
        "Delete a security group (no-op when already gone) and drop its stored resource",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showRawOrNull(context, KIND, args.securityGroup);
        if (!existing) {
          context.logger.info("security group {group} is already gone", {
            group: args.securityGroup,
          });
          return { dataHandles: [] };
        }
        const group = normalizeSecurityGroup(existing);
        context.logger.info("deleting security group {name} ({id})", {
          name: group.name,
          id: group.id,
        });
        await openstack(cliOptions(context.globalArgs), [
          "security",
          "group",
          "delete",
          group.id,
        ], context.signal);
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, group));
        }
        return { dataHandles: [] };
      },
    },
    addRule: {
      description:
        "Add a rule to a security group (an identical existing rule is fine) and store the group",
      arguments: AddRuleArgs,
      execute: async (
        args: z.infer<typeof AddRuleArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const group = normalizeSecurityGroup(
          await showRaw(context, KIND, args.securityGroup),
        );
        const cli = [
          "security",
          "group",
          "rule",
          "create",
          `--${args.direction}`,
        ];
        if (args.protocol) {
          cli.push("--protocol", assertArg(args.protocol, "protocol"));
        }
        if (args.portRange) cli.push("--dst-port", args.portRange);
        if (args.remoteIp) {
          cli.push("--remote-ip", assertArg(args.remoteIp, "remoteIp"));
        }
        if (args.remoteGroup) {
          cli.push(
            "--remote-group",
            assertArg(args.remoteGroup, "remoteGroup"),
          );
        }
        if (args.ethertype) cli.push("--ethertype", args.ethertype);
        if (args.icmpType !== undefined) {
          cli.push("--icmp-type", String(args.icmpType));
        }
        if (args.icmpCode !== undefined) {
          cli.push("--icmp-code", String(args.icmpCode));
        }
        if (args.description !== undefined) {
          cli.push("--description", args.description);
        }
        context.logger.info(
          "adding {direction} rule to security group {name}",
          {
            direction: args.direction,
            name: group.name,
          },
        );
        try {
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            group.id,
          ], context.signal);
        } catch (err) {
          if (!isConflict(err)) throw err;
          context.logger.info("rule already exists on security group {name}", {
            name: group.name,
          });
        }
        return {
          dataHandles: await writeGroup(
            context,
            await showRaw(context, KIND, group.id),
          ),
        };
      },
    },
    removeRule: {
      description:
        "Remove a rule by ID (no-op when already gone) and store the group",
      arguments: RemoveRuleArgs,
      execute: async (
        args: z.infer<typeof RemoveRuleArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const group = normalizeSecurityGroup(
          await showRaw(context, KIND, args.securityGroup),
        );
        context.logger.info("removing rule {rule} from security group {name}", {
          rule: args.rule,
          name: group.name,
        });
        try {
          await openstack(
            cliOptions(context.globalArgs),
            [
              "security",
              "group",
              "rule",
              "delete",
              assertArg(args.rule, "rule"),
            ],
            context.signal,
          );
        } catch (err) {
          if (!isNotFound(err)) throw err;
          context.logger.info("rule {rule} is already gone", {
            rule: args.rule,
          });
        }
        return {
          dataHandles: await writeGroup(
            context,
            await showRaw(context, KIND, group.id),
          ),
        };
      },
    },
  },
};
