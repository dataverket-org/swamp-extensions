/**
 * `@dataverket/openstack/port` — Neutron ports through the `openstack` CLI:
 * discover, create with fixed IPs and security groups, update and delete.
 * Ports are how a server gets a static address or an extra NIC.
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
  objList,
  type Raw,
  repeatFlag,
  showRaw,
  showRawOrNull,
  str,
  strList,
  writeAll,
} from "./common.ts";

const KIND = ["port"];
const PREFIX = "port";

/** One Neutron port as written to the `port` spec. */
export const PortSchema = z.object({
  id: z.string(),
  name: z.string().describe(
    "Often empty; the id is used for the instance name then",
  ),
  status: z.string().describe("ACTIVE, DOWN, BUILD or ERROR"),
  networkId: z.string(),
  macAddress: z.string(),
  fixedIps: z.array(z.object({ subnetId: z.string(), ipAddress: z.string() })),
  ipAddresses: z.array(z.string()).describe("Every fixed address, flattened"),
  deviceId: z.string().describe(
    "Server, router or load balancer owning the port",
  ),
  deviceOwner: z.string().describe(
    "compute:<zone>, network:router_interface, Octavia, ...",
  ),
  adminStateUp: z.boolean(),
  portSecurityEnabled: z.boolean(),
  securityGroupIds: z.array(z.string()),
  allowedAddressPairs: z.array(
    z.object({ ipAddress: z.string(), macAddress: z.string() }),
  ),
  description: z.string(),
  projectId: z.string(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** {@link PortSchema} */
export type Port = z.infer<typeof PortSchema>;

/** Shape a raw `port show` object into a {@link Port}. */
export function normalizePort(raw: Raw): Port {
  const fixedIps = objList(raw.fixed_ips).map((f) => ({
    subnetId: str(f.subnet_id),
    ipAddress: str(f.ip_address),
  }));
  return {
    id: str(raw.id),
    name: str(raw.name),
    status: str(raw.status),
    networkId: str(raw.network_id),
    macAddress: str(raw.mac_address),
    fixedIps,
    ipAddresses: fixedIps.map((f) => f.ipAddress),
    deviceId: str(raw.device_id),
    deviceOwner: str(raw.device_owner),
    adminStateUp: bool(raw.admin_state_up),
    portSecurityEnabled: bool(raw.port_security_enabled),
    securityGroupIds: strList(raw.security_group_ids),
    allowedAddressPairs: objList(raw.allowed_address_pairs).map((p) => ({
      ipAddress: str(p.ip_address),
      macAddress: str(p.mac_address),
    })),
    description: str(raw.description),
    projectId: str(raw.project_id),
    tags: strList(raw.tags),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

async function writePort(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "port", PREFIX, [normalizePort(raw)]);
}

const Target = z.string().min(1).describe("Port name or ID");
const FixedIp = z.object({
  subnet: z.string().optional().describe("Subnet name or ID"),
  ipAddress: z.string().optional(),
});
const AllowedAddress = z.object({
  ipAddress: z.string().min(1).describe("Address or CIDR"),
  macAddress: z.string().optional(),
});
const ListArgs = z.object({
  network: z.string().optional().describe(
    "Only ports on this network (name or ID)",
  ),
  server: z.string().optional().describe(
    "Only ports of this server (name or ID)",
  ),
  device: z.string().optional().describe("Only ports owned by this device ID"),
  name: z.string().optional().describe("Exact name filter"),
  status: z.enum(["ACTIVE", "DOWN", "BUILD", "ERROR"]).optional(),
});
const GetArgs = z.object({ port: Target });
const CreateArgs = z.object({
  name: z.string().min(1).describe(
    "Port name; an existing port of the same name is reused",
  ),
  network: z.string().min(1).describe("Network (name or ID)"),
  fixedIps: z.array(FixedIp).optional().describe(
    "Requested addresses; omit for DHCP-style allocation",
  ),
  securityGroups: z.array(z.string()).optional().describe(
    "Empty list means no security group",
  ),
  portSecurity: z.boolean().optional(),
  allowedAddresses: z.array(AllowedAddress).optional(),
  description: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const UpdateArgs = z.object({
  port: Target,
  name: z.string().optional(),
  description: z.string().optional(),
  securityGroups: z.array(z.string()).optional().describe(
    "Replaces the current groups; empty clears them",
  ),
  allowedAddresses: z.array(AllowedAddress).optional().describe(
    "Replaces the current pairs; empty clears them",
  ),
  portSecurity: z.boolean().optional(),
  fixedIps: z.array(FixedIp).optional().describe(
    "Replaces the current fixed IPs",
  ),
});
const DeleteArgs = z.object({ port: Target });

function fixedIpFlags(ips: z.infer<typeof FixedIp>[] | undefined): string[] {
  const out: string[] = [];
  for (const ip of ips ?? []) {
    if (ip.subnet) assertArg(ip.subnet, "fixedIp.subnet");
    if (ip.ipAddress) assertArg(ip.ipAddress, "fixedIp.ipAddress");
    const pair = csvPairs({ subnet: ip.subnet, "ip-address": ip.ipAddress });
    if (pair.length === 0) {
      throw new Error("a fixedIp needs a subnet or an ipAddress");
    }
    out.push("--fixed-ip", pair);
  }
  return out;
}

function allowedAddressFlags(
  pairs: z.infer<typeof AllowedAddress>[] | undefined,
): string[] {
  const out: string[] = [];
  for (const p of pairs ?? []) {
    out.push(
      "--allowed-address",
      csvPairs({
        "ip-address": assertArg(p.ipAddress, "allowedAddress.ipAddress"),
        "mac-address": p.macAddress,
      }),
    );
  }
  return out;
}

function securityGroupFlags(groups: string[] | undefined): string[] {
  if (groups === undefined) return [];
  if (groups.length === 0) return ["--no-security-group"];
  return repeatFlag("--security-group", groups, "securityGroup");
}

/** Neutron port model. */
export const model = {
  type: "@dataverket/openstack/port",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    port: {
      description:
        "A Neutron port: network, fixed IPs, MAC, owner device, security groups and allowed address pairs",
      schema: PortSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "Discover ports (optionally of one network, server or device) and store each one",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const filters: string[] = [];
        if (args.network) {
          filters.push("--network", assertArg(args.network, "network"));
        }
        if (args.server) {
          filters.push("--server", assertArg(args.server, "server"));
        }
        if (args.device) {
          filters.push("--device-id", assertArg(args.device, "device"));
        }
        if (args.name) filters.push("--name", assertArg(args.name, "name"));
        if (args.status) filters.push("--status", args.status);
        context.logger.info("listing ports");
        const ports = (await listThenShow(context, KIND, filters)).map(
          normalizePort,
        );
        const handles = await writeAll(context, "port", PREFIX, ports);
        context.logger.info("stored {count} ports", { count: ports.length });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one port by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading port {port}", { port: args.port });
        return {
          dataHandles: await writePort(
            context,
            await showRaw(context, KIND, args.port),
          ),
        };
      },
    },
    create: {
      description:
        "Create a port on a network with optional fixed IPs and security groups; an existing name is reused",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.name, "name");
        const existing = await showRawOrNull(context, KIND, args.name);
        if (existing) {
          context.logger.info("port {name} already exists as {id}; reusing", {
            name: args.name,
            id: str(existing.id),
          });
          return { dataHandles: await writePort(context, existing) };
        }
        const cli = [
          "port",
          "create",
          "--network",
          assertArg(args.network, "network"),
        ];
        cli.push(...fixedIpFlags(args.fixedIps));
        cli.push(...securityGroupFlags(args.securityGroups));
        if (args.portSecurity !== undefined) {
          cli.push(
            args.portSecurity
              ? "--enable-port-security"
              : "--disable-port-security",
          );
        }
        cli.push(...allowedAddressFlags(args.allowedAddresses));
        if (args.description !== undefined) {
          cli.push("--description", args.description);
        }
        cli.push(...repeatFlag("--tag", args.tags, "tag"));
        context.logger.info("creating port {name} on {network}", {
          name: args.name,
          network: args.network,
        });
        const created = assertShow(
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            args.name,
          ], context.signal),
          "port create",
        );
        return {
          dataHandles: await writePort(
            context,
            await showRaw(context, KIND, str(created.id)),
          ),
        };
      },
    },
    update: {
      description:
        "Change a port's name, description, security groups, allowed addresses, port security or fixed IPs",
      arguments: UpdateArgs,
      execute: async (
        args: z.infer<typeof UpdateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const before = normalizePort(await showRaw(context, KIND, args.port));
        const set: string[] = [];
        if (args.name !== undefined) {
          set.push("--name", assertArg(args.name, "name"));
        }
        if (args.description !== undefined) {
          set.push("--description", args.description);
        }
        if (args.securityGroups !== undefined) {
          set.push(
            "--no-security-group",
            ...securityGroupFlags(
              args.securityGroups.length ? args.securityGroups : undefined,
            ),
          );
        }
        if (args.allowedAddresses !== undefined) {
          set.push(
            "--no-allowed-address",
            ...allowedAddressFlags(args.allowedAddresses),
          );
        }
        if (args.portSecurity !== undefined) {
          set.push(
            args.portSecurity
              ? "--enable-port-security"
              : "--disable-port-security",
          );
        }
        if (args.fixedIps !== undefined) {
          set.push("--no-fixed-ip", ...fixedIpFlags(args.fixedIps));
        }
        if (set.length === 0) {
          context.logger.info("nothing to update on port {id}", {
            id: before.id,
          });
          return {
            dataHandles: await writeAll(context, "port", PREFIX, [before]),
          };
        }
        context.logger.info("updating port {id}", { id: before.id });
        await openstack(cliOptions(context.globalArgs), [
          "port",
          "set",
          ...set,
          before.id,
        ], context.signal);
        const after = normalizePort(await showRaw(context, KIND, before.id));
        if (after.name !== before.name && context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, before));
        }
        return {
          dataHandles: await writeAll(context, "port", PREFIX, [after]),
        };
      },
    },
    delete: {
      description:
        "Delete a port (no-op when already gone) and drop its stored resource",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showRawOrNull(context, KIND, args.port);
        if (!existing) {
          context.logger.info("port {port} is already gone", {
            port: args.port,
          });
          return { dataHandles: [] };
        }
        const port = normalizePort(existing);
        context.logger.info("deleting port {name} ({id})", {
          name: port.name || port.id,
          id: port.id,
        });
        await openstack(cliOptions(context.globalArgs), [
          "port",
          "delete",
          port.id,
        ], context.signal);
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, port));
        }
        return { dataHandles: [] };
      },
    },
  },
};
