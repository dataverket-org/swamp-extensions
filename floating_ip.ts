/**
 * `@dataverket/openstack/floating-ip` — Neutron floating IPs through the
 * `openstack` CLI: discover, allocate from a public network, bind to and
 * unbind from servers, and release.
 *
 * Floating IPs have no name, so resources are stored as
 * `floatingip-<address>` and a target may be given as address or ID.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { openstack, openstackJson } from "./cli.ts";
import {
  assertArg,
  assertShow,
  checks,
  cliOptions,
  type DataHandle,
  GlobalArgsSchema,
  instanceName,
  listThenShow,
  type MethodResult,
  type ModelContext,
  obj,
  type Raw,
  repeatFlag,
  resolveId,
  showRaw,
  showRawOrNull,
  str,
  strList,
  writeAll,
} from "./common.ts";

const KIND = ["floating", "ip"];
const PREFIX = "floatingip";

/** One floating IP as written to the `floatingIp` spec. */
export const FloatingIpSchema = z.object({
  id: z.string(),
  name: z.string().describe("The address; Neutron has no separate name"),
  address: z.string().describe("Public address"),
  fixedIpAddress: z.string().describe("Bound private address, empty when free"),
  floatingNetworkId: z.string(),
  portId: z.string().describe("Bound port, empty when free"),
  routerId: z.string(),
  status: z.string().describe("ACTIVE or DOWN"),
  description: z.string(),
  dnsName: z.string(),
  dnsDomain: z.string(),
  attachedDeviceId: z.string().describe(
    "Server (or load balancer) id owning the bound port",
  ),
  attachedDeviceOwner: z.string().describe("e.g. compute:nova or Octavia"),
  projectId: z.string(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** {@link FloatingIpSchema} */
export type FloatingIp = z.infer<typeof FloatingIpSchema>;

/** Shape a raw `floating ip show` object into a {@link FloatingIp}. */
export function normalizeFloatingIp(raw: Raw): FloatingIp {
  const address = str(raw.floating_ip_address);
  const port = obj(raw.port_details);
  return {
    id: str(raw.id),
    name: address,
    address,
    fixedIpAddress: str(raw.fixed_ip_address),
    floatingNetworkId: str(raw.floating_network_id),
    portId: str(raw.port_id),
    routerId: str(raw.router_id),
    status: str(raw.status),
    description: str(raw.description),
    dnsName: str(raw.dns_name),
    dnsDomain: str(raw.dns_domain),
    attachedDeviceId: str(port.device_id),
    attachedDeviceOwner: str(port.device_owner),
    projectId: str(raw.project_id),
    tags: strList(raw.tags),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

async function writeFloatingIp(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "floatingIp", PREFIX, [
    normalizeFloatingIp(raw),
  ]);
}

const Target = z.string().min(1).describe("Floating IP address or ID");
const ListArgs = z.object({
  network: z.string().optional().describe(
    "Only IPs from this floating network (name or ID)",
  ),
  status: z.enum(["ACTIVE", "DOWN"]).optional(),
});
const GetArgs = z.object({ floatingIp: Target });
const AllocateArgs = z.object({
  network: z.string().min(1).describe(
    "External network to allocate from (name or ID)",
  ),
  description: z.string().optional().describe(
    "Description; when set, an existing IP on the network with the same description is reused",
  ),
  address: z.string().optional().describe(
    "Request a specific address; reused if already allocated",
  ),
  subnet: z.string().optional(),
  tags: z.array(z.string()).optional(),
});
const BindArgs = z.object({
  floatingIp: Target,
  server: z.string().optional().describe(
    "Server (name or ID) whose first port receives the IP",
  ),
  port: z.string().optional().describe(
    "Port (name or ID) to associate directly, e.g. a load balancer VIP",
  ),
  fixedIpAddress: z.string().optional().describe(
    "Which fixed IP on the server or port to map",
  ),
});
const UnbindArgs = z.object({
  floatingIp: Target,
  server: z.string().optional().describe(
    "Server (name or ID) to remove it from; omit to disassociate whatever port holds it",
  ),
});
const ReleaseArgs = z.object({ floatingIp: Target });

/** Neutron floating IP model. */
export const model = {
  type: "@dataverket/openstack/floating-ip",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    floatingIp: {
      description: "A Neutron floating IP and what it is bound to",
      schema: FloatingIpSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "Discover the project's floating IPs and store each one",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const filters: string[] = [];
        if (args.network) {
          filters.push("--network", assertArg(args.network, "network"));
        }
        if (args.status) filters.push("--status", args.status);
        context.logger.info("listing floating ips");
        const ips = (await listThenShow(context, KIND, filters)).map(
          normalizeFloatingIp,
        );
        const handles = await writeAll(context, "floatingIp", PREFIX, ips);
        context.logger.info("stored {count} floating ips", {
          count: ips.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one floating IP by address or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading floating ip {ip}", {
          ip: args.floatingIp,
        });
        return {
          dataHandles: await writeFloatingIp(
            context,
            await showRaw(context, KIND, args.floatingIp),
          ),
        };
      },
    },
    allocate: {
      description:
        "Allocate a floating IP from an external network; a matching address or description is reused",
      arguments: AllocateArgs,
      execute: async (
        args: z.infer<typeof AllocateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.network, "network");
        if (args.address) {
          const existing = await showRawOrNull(
            context,
            KIND,
            assertArg(args.address, "address"),
          );
          if (existing) {
            context.logger.info(
              "floating ip {address} is already allocated; reusing",
              { address: args.address },
            );
            return { dataHandles: await writeFloatingIp(context, existing) };
          }
        } else if (args.description) {
          const candidates =
            (await listThenShow(context, KIND, ["--network", args.network]))
              .map(normalizeFloatingIp)
              .filter((ip) => ip.description === args.description);
          if (candidates.length > 0) {
            context.logger.info(
              "floating ip {address} already carries description {description}; reusing",
              {
                address: candidates[0].address,
                description: args.description,
              },
            );
            return {
              dataHandles: await writeAll(context, "floatingIp", PREFIX, [
                candidates[0],
              ]),
            };
          }
        }
        const cli = ["floating", "ip", "create"];
        if (args.description !== undefined) {
          cli.push("--description", args.description);
        }
        if (args.address) cli.push("--floating-ip-address", args.address);
        if (args.subnet) cli.push("--subnet", assertArg(args.subnet, "subnet"));
        cli.push(...repeatFlag("--tag", args.tags, "tag"));
        context.logger.info("allocating floating ip from {network}", {
          network: args.network,
        });
        const created = assertShow(
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            args.network,
          ], context.signal),
          "floating ip create",
        );
        context.logger.info("allocated floating ip {address}", {
          address: str(created.floating_ip_address),
        });
        return {
          dataHandles: await writeFloatingIp(
            context,
            await showRaw(context, KIND, str(created.id)),
          ),
        };
      },
    },
    bind: {
      description:
        "Associate a floating IP with a server (its first port) or directly with a port, and store the IP",
      arguments: BindArgs,
      execute: async (
        args: z.infer<typeof BindArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        if ((args.server ? 1 : 0) + (args.port ? 1 : 0) !== 1) {
          throw new Error("bind needs exactly one of server or port");
        }
        const ip = normalizeFloatingIp(
          await showRaw(context, KIND, args.floatingIp),
        );
        const opts = cliOptions(context.globalArgs);
        if (args.port) {
          const portId = await resolveId(
            context,
            ["port"],
            assertArg(args.port, "port"),
          );
          if (ip.portId === portId) {
            context.logger.info(
              "floating ip {address} is already bound to port {port}",
              { address: ip.address, port: portId },
            );
            return {
              dataHandles: await writeAll(context, "floatingIp", PREFIX, [ip]),
            };
          }
          const cli = ["floating", "ip", "set", "--port", portId];
          if (args.fixedIpAddress) {
            cli.push(
              "--fixed-ip-address",
              assertArg(args.fixedIpAddress, "fixedIpAddress"),
            );
          }
          context.logger.info("binding floating ip {address} to port {port}", {
            address: ip.address,
            port: portId,
          });
          await openstack(opts, [...cli, ip.id], context.signal);
        } else {
          const cli = ["server", "add", "floating", "ip"];
          if (args.fixedIpAddress) {
            cli.push(
              "--fixed-ip-address",
              assertArg(args.fixedIpAddress, "fixedIpAddress"),
            );
          }
          context.logger.info(
            "binding floating ip {address} to server {server}",
            { address: ip.address, server: args.server },
          );
          await openstack(
            opts,
            [...cli, assertArg(args.server ?? "", "server"), ip.address],
            context.signal,
          );
        }
        return {
          dataHandles: await writeFloatingIp(
            context,
            await showRaw(context, KIND, ip.id),
          ),
        };
      },
    },
    unbind: {
      description:
        "Disassociate a floating IP from its server or port (keeping the allocation) and store the IP",
      arguments: UnbindArgs,
      execute: async (
        args: z.infer<typeof UnbindArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const ip = normalizeFloatingIp(
          await showRaw(context, KIND, args.floatingIp),
        );
        if (!ip.portId) {
          context.logger.info(
            "floating ip {address} is not bound; nothing to do",
            { address: ip.address },
          );
          return {
            dataHandles: await writeAll(context, "floatingIp", PREFIX, [ip]),
          };
        }
        const opts = cliOptions(context.globalArgs);
        if (args.server) {
          context.logger.info(
            "unbinding floating ip {address} from server {server}",
            { address: ip.address, server: args.server },
          );
          await openstack(
            opts,
            [
              "server",
              "remove",
              "floating",
              "ip",
              assertArg(args.server, "server"),
              ip.address,
            ],
            context.signal,
          );
        } else {
          context.logger.info(
            "disassociating floating ip {address} from port {port}",
            { address: ip.address, port: ip.portId },
          );
          await openstack(
            opts,
            ["floating", "ip", "unset", "--port", ip.id],
            context.signal,
          );
        }
        return {
          dataHandles: await writeFloatingIp(
            context,
            await showRaw(context, KIND, ip.id),
          ),
        };
      },
    },
    release: {
      description:
        "Release a floating IP back to the pool (no-op when already gone) and drop its stored resource",
      arguments: ReleaseArgs,
      execute: async (
        args: z.infer<typeof ReleaseArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showRawOrNull(context, KIND, args.floatingIp);
        if (!existing) {
          context.logger.info("floating ip {ip} is already gone", {
            ip: args.floatingIp,
          });
          return { dataHandles: [] };
        }
        const ip = normalizeFloatingIp(existing);
        if (ip.portId) {
          context.logger.warning(
            "releasing floating ip {address} that is still bound to port {port}",
            {
              address: ip.address,
              port: ip.portId,
            },
          );
        }
        context.logger.info("releasing floating ip {address}", {
          address: ip.address,
        });
        await openstack(cliOptions(context.globalArgs), [
          "floating",
          "ip",
          "delete",
          ip.id,
        ], context.signal);
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, ip));
        }
        return { dataHandles: [] };
      },
    },
  },
};
