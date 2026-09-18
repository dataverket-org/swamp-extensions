/**
 * `@dataverket/openstack/network` — Neutron networks through the `openstack`
 * CLI: discover (including which network is the external one), create,
 * update and delete.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { openstack, openstackJson } from "./cli.ts";
import {
  assertArg,
  assertShow,
  bool,
  checks,
  cliOptions,
  type DataHandle,
  GlobalArgsSchema,
  instanceName,
  listThenShow,
  type MethodResult,
  type ModelContext,
  num,
  type Raw,
  repeatFlag,
  showRaw,
  showRawOrNull,
  str,
  strList,
  writeAll,
} from "./common.ts";

const KIND = ["network"];
const PREFIX = "network";

/** One Neutron network as written to the `network` spec. */
export const NetworkSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().describe("ACTIVE, DOWN, BUILD or ERROR"),
  external: z.boolean().describe(
    "router:external — usable for floating IPs and gateways",
  ),
  shared: z.boolean(),
  adminStateUp: z.boolean(),
  portSecurityEnabled: z.boolean(),
  mtu: z.number(),
  subnetIds: z.array(z.string()),
  providerNetworkType: z.string().describe(
    "vxlan, vlan, flat, ... when visible",
  ),
  availabilityZones: z.array(z.string()),
  dnsDomain: z.string(),
  description: z.string(),
  projectId: z.string(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** {@link NetworkSchema} */
export type Network = z.infer<typeof NetworkSchema>;

/** Shape a raw `network show` object into a {@link Network}. */
export function normalizeNetwork(raw: Raw): Network {
  return {
    id: str(raw.id),
    name: str(raw.name),
    status: str(raw.status),
    external: bool(raw["router:external"]),
    shared: bool(raw.shared),
    adminStateUp: bool(raw.admin_state_up),
    portSecurityEnabled: bool(raw.port_security_enabled),
    mtu: num(raw.mtu),
    subnetIds: strList(raw.subnets),
    providerNetworkType: str(raw["provider:network_type"]),
    availabilityZones: strList(raw.availability_zones),
    dnsDomain: str(raw.dns_domain),
    description: str(raw.description),
    projectId: str(raw.project_id),
    tags: strList(raw.tags),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

async function writeNetwork(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "network", PREFIX, [normalizeNetwork(raw)]);
}

const Target = z.string().min(1).describe("Network name or ID");
const ListArgs = z.object({
  name: z.string().optional().describe("Exact name filter"),
  external: z.boolean().optional().describe(
    "true: only external networks; false: only internal",
  ),
  status: z.string().optional(),
});
const GetArgs = z.object({ network: Target });
const CreateArgs = z.object({
  name: z.string().min(1).describe(
    "Network name; an existing network is reused",
  ),
  description: z.string().optional(),
  shared: z.boolean().optional(),
  portSecurity: z.boolean().optional().describe(
    "Default port security for ports on it",
  ),
  mtu: z.number().int().positive().optional(),
  dnsDomain: z.string().optional(),
  availabilityZoneHints: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
const UpdateArgs = z.object({
  network: Target,
  name: z.string().optional(),
  description: z.string().optional(),
  shared: z.boolean().optional(),
  portSecurity: z.boolean().optional(),
  mtu: z.number().int().positive().optional(),
  dnsDomain: z.string().optional(),
});
const DeleteArgs = z.object({ network: Target });

/** Neutron network model. */
export const model = {
  type: "@dataverket/openstack/network",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    network: {
      description:
        "A Neutron network: external flag, subnets, MTU, port security and status",
      schema: NetworkSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "Discover networks visible to the project (own, shared and external) and store each one",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const filters: string[] = [];
        if (args.name) filters.push("--name", assertArg(args.name, "name"));
        if (args.external !== undefined) {
          filters.push(args.external ? "--external" : "--internal");
        }
        if (args.status) {
          filters.push("--status", assertArg(args.status, "status"));
        }
        context.logger.info("listing networks");
        const networks = (await listThenShow(context, KIND, filters)).map(
          normalizeNetwork,
        );
        const handles = await writeAll(context, "network", PREFIX, networks);
        context.logger.info("stored {count} networks", {
          count: networks.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one network by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading network {network}", {
          network: args.network,
        });
        return {
          dataHandles: await writeNetwork(
            context,
            await showRaw(context, KIND, args.network),
          ),
        };
      },
    },
    create: {
      description:
        "Create a network; an existing network of the same name is reused",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.name, "name");
        const existing = await showRawOrNull(context, KIND, args.name);
        if (existing) {
          context.logger.info(
            "network {name} already exists as {id}; reusing",
            { name: args.name, id: str(existing.id) },
          );
          return { dataHandles: await writeNetwork(context, existing) };
        }
        const cli = ["network", "create"];
        if (args.description !== undefined) {
          cli.push("--description", args.description);
        }
        if (args.shared !== undefined) {
          cli.push(args.shared ? "--share" : "--no-share");
        }
        if (args.portSecurity !== undefined) {
          cli.push(
            args.portSecurity
              ? "--enable-port-security"
              : "--disable-port-security",
          );
        }
        if (args.mtu !== undefined) cli.push("--mtu", String(args.mtu));
        if (args.dnsDomain) {
          cli.push("--dns-domain", assertArg(args.dnsDomain, "dnsDomain"));
        }
        cli.push(
          ...repeatFlag(
            "--availability-zone-hint",
            args.availabilityZoneHints,
            "availabilityZoneHint",
          ),
        );
        cli.push(...repeatFlag("--tag", args.tags, "tag"));
        context.logger.info("creating network {name}", { name: args.name });
        const created = assertShow(
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            args.name,
          ], context.signal),
          "network create",
        );
        return {
          dataHandles: await writeNetwork(
            context,
            await showRaw(context, KIND, str(created.id)),
          ),
        };
      },
    },
    update: {
      description:
        "Rename, describe or change sharing, port security, MTU or DNS domain of a network",
      arguments: UpdateArgs,
      execute: async (
        args: z.infer<typeof UpdateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const before = normalizeNetwork(
          await showRaw(context, KIND, args.network),
        );
        const set: string[] = [];
        if (args.name !== undefined) {
          set.push("--name", assertArg(args.name, "name"));
        }
        if (args.description !== undefined) {
          set.push("--description", args.description);
        }
        if (args.shared !== undefined) {
          set.push(args.shared ? "--share" : "--no-share");
        }
        if (args.portSecurity !== undefined) {
          set.push(
            args.portSecurity
              ? "--enable-port-security"
              : "--disable-port-security",
          );
        }
        if (args.mtu !== undefined) set.push("--mtu", String(args.mtu));
        if (args.dnsDomain !== undefined) {
          set.push("--dns-domain", args.dnsDomain);
        }
        if (set.length === 0) {
          context.logger.info("nothing to update on network {id}", {
            id: before.id,
          });
          return {
            dataHandles: await writeAll(context, "network", PREFIX, [before]),
          };
        }
        context.logger.info("updating network {id}", { id: before.id });
        await openstack(cliOptions(context.globalArgs), [
          "network",
          "set",
          ...set,
          before.id,
        ], context.signal);
        const after = normalizeNetwork(await showRaw(context, KIND, before.id));
        if (after.name !== before.name && context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, before));
        }
        return {
          dataHandles: await writeAll(context, "network", PREFIX, [after]),
        };
      },
    },
    delete: {
      description:
        "Delete a network (no-op when already gone) and drop its stored resource",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showRawOrNull(context, KIND, args.network);
        if (!existing) {
          context.logger.info("network {network} is already gone", {
            network: args.network,
          });
          return { dataHandles: [] };
        }
        const network = normalizeNetwork(existing);
        context.logger.info("deleting network {name} ({id})", {
          name: network.name,
          id: network.id,
        });
        await openstack(cliOptions(context.globalArgs), [
          "network",
          "delete",
          network.id,
        ], context.signal);
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, network));
        }
        return { dataHandles: [] };
      },
    },
  },
};
