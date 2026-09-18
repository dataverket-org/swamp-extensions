/**
 * `@dataverket/openstack/subnet` — Neutron subnets through the `openstack`
 * CLI: discover, create, update and delete.
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
  csvPairs,
  type DataHandle,
  GlobalArgsSchema,
  instanceName,
  listThenShow,
  type MethodResult,
  type ModelContext,
  num,
  objList,
  type Raw,
  repeatFlag,
  showRaw,
  showRawOrNull,
  str,
  strList,
  writeAll,
} from "./common.ts";

const KIND = ["subnet"];
const PREFIX = "subnet";

/** One Neutron subnet as written to the `subnet` spec. */
export const SubnetSchema = z.object({
  id: z.string(),
  name: z.string(),
  networkId: z.string(),
  cidr: z.string(),
  ipVersion: z.number(),
  gatewayIp: z.string().describe("Empty when the subnet has no gateway"),
  enableDhcp: z.boolean(),
  allocationPools: z.array(z.object({ start: z.string(), end: z.string() })),
  dnsNameservers: z.array(z.string()),
  hostRoutes: z.array(
    z.object({ destination: z.string(), nexthop: z.string() }),
  ),
  description: z.string(),
  projectId: z.string(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** {@link SubnetSchema} */
export type Subnet = z.infer<typeof SubnetSchema>;

/** Shape a raw `subnet show` object into a {@link Subnet}. */
export function normalizeSubnet(raw: Raw): Subnet {
  return {
    id: str(raw.id),
    name: str(raw.name),
    networkId: str(raw.network_id),
    cidr: str(raw.cidr),
    ipVersion: num(raw.ip_version),
    gatewayIp: str(raw.gateway_ip),
    enableDhcp: bool(raw.enable_dhcp),
    allocationPools: objList(raw.allocation_pools).map((p) => ({
      start: str(p.start),
      end: str(p.end),
    })),
    dnsNameservers: strList(raw.dns_nameservers),
    hostRoutes: objList(raw.host_routes).map((r) => ({
      destination: str(r.destination),
      nexthop: str(r.nexthop),
    })),
    description: str(raw.description),
    projectId: str(raw.project_id),
    tags: strList(raw.tags),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

async function writeSubnet(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "subnet", PREFIX, [normalizeSubnet(raw)]);
}

const Target = z.string().min(1).describe("Subnet name or ID");
const Pool = z.object({ start: z.string().min(1), end: z.string().min(1) });
const Route = z.object({
  destination: z.string().min(1),
  nexthop: z.string().min(1),
});
const ListArgs = z.object({
  network: z.string().optional().describe(
    "Only subnets of this network (name or ID)",
  ),
  name: z.string().optional().describe("Exact name filter"),
  ipVersion: z.union([z.literal(4), z.literal(6)]).optional(),
});
const GetArgs = z.object({ subnet: Target });
const CreateArgs = z.object({
  name: z.string().min(1).describe("Subnet name; an existing subnet is reused"),
  network: z.string().min(1).describe("Parent network (name or ID)"),
  cidr: z.string().min(1).describe("Subnet range, e.g. 192.0.2.0/24"),
  ipVersion: z.union([z.literal(4), z.literal(6)]).default(4),
  gateway: z.string().optional().describe(
    'Gateway address, or "none" for no gateway (default: first address)',
  ),
  dhcp: z.boolean().default(true),
  dnsNameservers: z.array(z.string()).optional(),
  allocationPools: z.array(Pool).optional(),
  hostRoutes: z.array(Route).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const UpdateArgs = z.object({
  subnet: Target,
  name: z.string().optional(),
  description: z.string().optional(),
  gateway: z.string().optional().describe('New gateway address or "none"'),
  dhcp: z.boolean().optional(),
  dnsNameservers: z.array(z.string()).optional().describe(
    "Replaces the current list",
  ),
  allocationPools: z.array(Pool).optional().describe(
    "Replaces the current pools",
  ),
  hostRoutes: z.array(Route).optional().describe("Replaces the current routes"),
});
const DeleteArgs = z.object({ subnet: Target });

function structuredFlags(args: {
  dnsNameservers?: string[];
  allocationPools?: z.infer<typeof Pool>[];
  hostRoutes?: z.infer<typeof Route>[];
}): string[] {
  const out: string[] = [];
  out.push(
    ...repeatFlag("--dns-nameserver", args.dnsNameservers, "dnsNameserver"),
  );
  for (const p of args.allocationPools ?? []) {
    out.push("--allocation-pool", csvPairs({ start: p.start, end: p.end }));
  }
  for (const r of args.hostRoutes ?? []) {
    out.push(
      "--host-route",
      csvPairs({ destination: r.destination, gateway: r.nexthop }),
    );
  }
  return out;
}

/** Neutron subnet model. */
export const model = {
  type: "@dataverket/openstack/subnet",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    subnet: {
      description:
        "A Neutron subnet: CIDR, gateway, DHCP, pools, DNS and host routes",
      schema: SubnetSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "Discover subnets (optionally of one network) and store each one",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const filters: string[] = [];
        if (args.network) {
          filters.push("--network", assertArg(args.network, "network"));
        }
        if (args.name) filters.push("--name", assertArg(args.name, "name"));
        if (args.ipVersion) {
          filters.push("--ip-version", String(args.ipVersion));
        }
        context.logger.info("listing subnets");
        const subnets = (await listThenShow(context, KIND, filters)).map(
          normalizeSubnet,
        );
        const handles = await writeAll(context, "subnet", PREFIX, subnets);
        context.logger.info("stored {count} subnets", {
          count: subnets.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one subnet by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading subnet {subnet}", { subnet: args.subnet });
        return {
          dataHandles: await writeSubnet(
            context,
            await showRaw(context, KIND, args.subnet),
          ),
        };
      },
    },
    create: {
      description:
        "Create a subnet on a network; an existing subnet of the same name is reused",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.name, "name");
        const existing = await showRawOrNull(context, KIND, args.name);
        if (existing) {
          context.logger.info("subnet {name} already exists as {id}; reusing", {
            name: args.name,
            id: str(existing.id),
          });
          return { dataHandles: await writeSubnet(context, existing) };
        }
        const cli = [
          "subnet",
          "create",
          "--network",
          assertArg(args.network, "network"),
          "--subnet-range",
          assertArg(args.cidr, "cidr"),
          "--ip-version",
          String(args.ipVersion),
          args.dhcp ? "--dhcp" : "--no-dhcp",
        ];
        if (args.gateway) {
          cli.push("--gateway", assertArg(args.gateway, "gateway"));
        }
        cli.push(...structuredFlags(args));
        if (args.description !== undefined) {
          cli.push("--description", args.description);
        }
        cli.push(...repeatFlag("--tag", args.tags, "tag"));
        context.logger.info("creating subnet {name} ({cidr}) on {network}", {
          name: args.name,
          cidr: args.cidr,
          network: args.network,
        });
        const created = assertShow(
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            args.name,
          ], context.signal),
          "subnet create",
        );
        return {
          dataHandles: await writeSubnet(
            context,
            await showRaw(context, KIND, str(created.id)),
          ),
        };
      },
    },
    update: {
      description:
        "Change a subnet's name, description, gateway, DHCP, DNS servers, pools or host routes",
      arguments: UpdateArgs,
      execute: async (
        args: z.infer<typeof UpdateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const before = normalizeSubnet(
          await showRaw(context, KIND, args.subnet),
        );
        const set: string[] = [];
        if (args.name !== undefined) {
          set.push("--name", assertArg(args.name, "name"));
        }
        if (args.description !== undefined) {
          set.push("--description", args.description);
        }
        if (args.gateway) {
          set.push("--gateway", assertArg(args.gateway, "gateway"));
        }
        if (args.dhcp !== undefined) {
          set.push(args.dhcp ? "--dhcp" : "--no-dhcp");
        }
        if (args.dnsNameservers) set.push("--no-dns-nameservers");
        if (args.allocationPools) set.push("--no-allocation-pool");
        if (args.hostRoutes) set.push("--no-host-route");
        set.push(...structuredFlags(args));
        if (set.length === 0) {
          context.logger.info("nothing to update on subnet {id}", {
            id: before.id,
          });
          return {
            dataHandles: await writeAll(context, "subnet", PREFIX, [before]),
          };
        }
        context.logger.info("updating subnet {id}", { id: before.id });
        await openstack(cliOptions(context.globalArgs), [
          "subnet",
          "set",
          ...set,
          before.id,
        ], context.signal);
        const after = normalizeSubnet(await showRaw(context, KIND, before.id));
        if (after.name !== before.name && context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, before));
        }
        return {
          dataHandles: await writeAll(context, "subnet", PREFIX, [after]),
        };
      },
    },
    delete: {
      description:
        "Delete a subnet (no-op when already gone) and drop its stored resource",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showRawOrNull(context, KIND, args.subnet);
        if (!existing) {
          context.logger.info("subnet {subnet} is already gone", {
            subnet: args.subnet,
          });
          return { dataHandles: [] };
        }
        const subnet = normalizeSubnet(existing);
        context.logger.info("deleting subnet {name} ({id})", {
          name: subnet.name,
          id: subnet.id,
        });
        await openstack(cliOptions(context.globalArgs), [
          "subnet",
          "delete",
          subnet.id,
        ], context.signal);
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, subnet));
        }
        return { dataHandles: [] };
      },
    },
  },
};
