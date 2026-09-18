/**
 * `@dataverket/openstack/router` — Neutron routers through the `openstack`
 * CLI: discover, create with an external gateway, attach and detach subnets,
 * manage static routes, and delete.
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
  obj,
  objList,
  type Raw,
  repeatFlag,
  resolveId,
  showRaw,
  showRawOrNull,
  str,
  strList,
  writeAll,
} from "./common.ts";

const KIND = ["router"];
const PREFIX = "router";

/** One Neutron router as written to the `router` spec. */
export const RouterSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string(),
  adminStateUp: z.boolean(),
  externalNetworkId: z.string().describe(
    "Empty when the router has no gateway",
  ),
  externalFixedIps: z.array(
    z.object({ subnetId: z.string(), ipAddress: z.string() }),
  ),
  snatEnabled: z.boolean(),
  interfaces: z.array(
    z.object({
      portId: z.string(),
      subnetId: z.string(),
      ipAddress: z.string(),
    }),
  ).describe(
    "Internal interfaces, one per attached subnet",
  ),
  routes: z.array(z.object({ destination: z.string(), nexthop: z.string() })),
  description: z.string(),
  projectId: z.string(),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** {@link RouterSchema} */
export type Router = z.infer<typeof RouterSchema>;

/** Shape a raw `router show` object into a {@link Router}. */
export function normalizeRouter(raw: Raw): Router {
  const gw = obj(raw.external_gateway_info);
  return {
    id: str(raw.id),
    name: str(raw.name),
    status: str(raw.status),
    adminStateUp: bool(raw.admin_state_up),
    externalNetworkId: str(gw.network_id),
    externalFixedIps: objList(gw.external_fixed_ips).map((f) => ({
      subnetId: str(f.subnet_id),
      ipAddress: str(f.ip_address),
    })),
    snatEnabled: bool(gw.enable_snat),
    interfaces: objList(raw.interfaces_info).map((i) => ({
      portId: str(i.port_id),
      subnetId: str(i.subnet_id),
      ipAddress: str(i.ip_address),
    })),
    routes: objList(raw.routes).map((r) => ({
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

async function writeRouter(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "router", PREFIX, [normalizeRouter(raw)]);
}

async function refresh(
  context: ModelContext,
  id: string,
): Promise<MethodResult> {
  return {
    dataHandles: await writeRouter(context, await showRaw(context, KIND, id)),
  };
}

const Target = z.string().min(1).describe("Router name or ID");
const Route = z.object({
  destination: z.string().min(1).describe("CIDR"),
  nexthop: z.string().min(1).describe("Next-hop address"),
});
const ListArgs = z.object({
  name: z.string().optional().describe("Exact name filter"),
});
const GetArgs = z.object({ router: Target });
const CreateArgs = z.object({
  name: z.string().min(1).describe("Router name; an existing router is reused"),
  externalGateway: z.string().optional().describe(
    "External network (name or ID) to use as gateway",
  ),
  snat: z.boolean().optional().describe(
    "Source NAT on the gateway (cloud default when omitted)",
  ),
  description: z.string().optional(),
  availabilityZoneHints: z.array(z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
const UpdateArgs = z.object({
  router: Target,
  name: z.string().optional(),
  description: z.string().optional(),
  externalGateway: z.string().optional().describe(
    "Set the gateway network (name or ID)",
  ),
  clearExternalGateway: z.boolean().default(false),
  snat: z.boolean().optional(),
});
const SubnetArgs = z.object({
  router: Target,
  subnet: z.string().min(1).describe("Subnet name or ID"),
});
const RouteArgs = z.object({ router: Target, route: Route });
const DeleteArgs = z.object({ router: Target });

/** Neutron router model. */
export const model = {
  type: "@dataverket/openstack/router",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    router: {
      description:
        "A Neutron router: external gateway, attached subnets, static routes and status",
      schema: RouterSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "Discover the project's routers and store each one",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const filters: string[] = [];
        if (args.name) filters.push("--name", assertArg(args.name, "name"));
        context.logger.info("listing routers");
        const routers = (await listThenShow(context, KIND, filters)).map(
          normalizeRouter,
        );
        const handles = await writeAll(context, "router", PREFIX, routers);
        context.logger.info("stored {count} routers", {
          count: routers.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one router by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading router {router}", { router: args.router });
        return {
          dataHandles: await writeRouter(
            context,
            await showRaw(context, KIND, args.router),
          ),
        };
      },
    },
    create: {
      description:
        "Create a router, optionally with an external gateway; an existing name is reused",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.name, "name");
        const existing = await showRawOrNull(context, KIND, args.name);
        if (existing) {
          context.logger.info("router {name} already exists as {id}; reusing", {
            name: args.name,
            id: str(existing.id),
          });
          return { dataHandles: await writeRouter(context, existing) };
        }
        const cli = ["router", "create"];
        if (args.externalGateway) {
          cli.push(
            "--external-gateway",
            assertArg(args.externalGateway, "externalGateway"),
          );
        }
        if (args.snat !== undefined) {
          cli.push(args.snat ? "--enable-snat" : "--disable-snat");
        }
        if (args.description !== undefined) {
          cli.push("--description", args.description);
        }
        cli.push(
          ...repeatFlag(
            "--availability-zone-hint",
            args.availabilityZoneHints,
            "availabilityZoneHint",
          ),
        );
        cli.push(...repeatFlag("--tag", args.tags, "tag"));
        context.logger.info("creating router {name}", { name: args.name });
        const created = assertShow(
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            args.name,
          ], context.signal),
          "router create",
        );
        return await refresh(context, str(created.id));
      },
    },
    update: {
      description:
        "Rename or describe a router, or set/clear its external gateway and SNAT",
      arguments: UpdateArgs,
      execute: async (
        args: z.infer<typeof UpdateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const before = normalizeRouter(
          await showRaw(context, KIND, args.router),
        );
        const opts = cliOptions(context.globalArgs);
        if (args.clearExternalGateway && before.externalNetworkId) {
          context.logger.info("clearing external gateway of router {id}", {
            id: before.id,
          });
          await openstack(opts, [
            "router",
            "unset",
            "--external-gateway",
            before.id,
          ], context.signal);
        }
        const set: string[] = [];
        if (args.name !== undefined) {
          set.push("--name", assertArg(args.name, "name"));
        }
        if (args.description !== undefined) {
          set.push("--description", args.description);
        }
        if (args.externalGateway) {
          set.push(
            "--external-gateway",
            assertArg(args.externalGateway, "externalGateway"),
          );
        }
        if (args.snat !== undefined) {
          set.push(args.snat ? "--enable-snat" : "--disable-snat");
        }
        if (set.length > 0) {
          context.logger.info("updating router {id}", { id: before.id });
          await openstack(
            opts,
            ["router", "set", ...set, before.id],
            context.signal,
          );
        }
        const after = normalizeRouter(await showRaw(context, KIND, before.id));
        if (after.name !== before.name && context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, before));
        }
        return {
          dataHandles: await writeAll(context, "router", PREFIX, [after]),
        };
      },
    },
    addSubnet: {
      description:
        "Attach a subnet as an internal interface (no-op when already attached) and store the router",
      arguments: SubnetArgs,
      execute: async (
        args: z.infer<typeof SubnetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const router = normalizeRouter(
          await showRaw(context, KIND, args.router),
        );
        const subnetId = await resolveId(
          context,
          ["subnet"],
          assertArg(args.subnet, "subnet"),
        );
        if (router.interfaces.some((i) => i.subnetId === subnetId)) {
          context.logger.info(
            "subnet {subnet} is already attached to router {name}",
            {
              subnet: subnetId,
              name: router.name,
            },
          );
          return {
            dataHandles: await writeAll(context, "router", PREFIX, [router]),
          };
        }
        context.logger.info("attaching subnet {subnet} to router {name}", {
          subnet: subnetId,
          name: router.name,
        });
        await openstack(cliOptions(context.globalArgs), [
          "router",
          "add",
          "subnet",
          router.id,
          subnetId,
        ], context.signal);
        return await refresh(context, router.id);
      },
    },
    removeSubnet: {
      description:
        "Detach a subnet interface (no-op when not attached) and store the router",
      arguments: SubnetArgs,
      execute: async (
        args: z.infer<typeof SubnetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const router = normalizeRouter(
          await showRaw(context, KIND, args.router),
        );
        const subnetId = await resolveId(
          context,
          ["subnet"],
          assertArg(args.subnet, "subnet"),
        );
        if (!router.interfaces.some((i) => i.subnetId === subnetId)) {
          context.logger.info(
            "subnet {subnet} is not attached to router {name}",
            { subnet: subnetId, name: router.name },
          );
          return {
            dataHandles: await writeAll(context, "router", PREFIX, [router]),
          };
        }
        context.logger.info("detaching subnet {subnet} from router {name}", {
          subnet: subnetId,
          name: router.name,
        });
        await openstack(cliOptions(context.globalArgs), [
          "router",
          "remove",
          "subnet",
          router.id,
          subnetId,
        ], context.signal);
        return await refresh(context, router.id);
      },
    },
    addRoute: {
      description:
        "Add a static route (no-op when present) and store the router",
      arguments: RouteArgs,
      execute: async (
        args: z.infer<typeof RouteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const router = normalizeRouter(
          await showRaw(context, KIND, args.router),
        );
        const r = args.route;
        if (
          router.routes.some((x) =>
            x.destination === r.destination && x.nexthop === r.nexthop
          )
        ) {
          context.logger.info(
            "route {destination} via {nexthop} already on router {name}",
            { ...r, name: router.name },
          );
          return {
            dataHandles: await writeAll(context, "router", PREFIX, [router]),
          };
        }
        context.logger.info(
          "adding route {destination} via {nexthop} to router {name}",
          { ...r, name: router.name },
        );
        await openstack(
          cliOptions(context.globalArgs),
          [
            "router",
            "set",
            "--route",
            csvPairs({ destination: r.destination, gateway: r.nexthop }),
            router.id,
          ],
          context.signal,
        );
        return await refresh(context, router.id);
      },
    },
    removeRoute: {
      description:
        "Remove a static route (no-op when absent) and store the router",
      arguments: RouteArgs,
      execute: async (
        args: z.infer<typeof RouteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const router = normalizeRouter(
          await showRaw(context, KIND, args.router),
        );
        const r = args.route;
        if (
          !router.routes.some((x) =>
            x.destination === r.destination && x.nexthop === r.nexthop
          )
        ) {
          context.logger.info(
            "route {destination} via {nexthop} is not on router {name}",
            { ...r, name: router.name },
          );
          return {
            dataHandles: await writeAll(context, "router", PREFIX, [router]),
          };
        }
        context.logger.info(
          "removing route {destination} via {nexthop} from router {name}",
          { ...r, name: router.name },
        );
        await openstack(
          cliOptions(context.globalArgs),
          [
            "router",
            "unset",
            "--route",
            csvPairs({ destination: r.destination, gateway: r.nexthop }),
            router.id,
          ],
          context.signal,
        );
        return await refresh(context, router.id);
      },
    },
    delete: {
      description:
        "Delete a router (no-op when already gone) and drop its stored resource; detach subnets first",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showRawOrNull(context, KIND, args.router);
        if (!existing) {
          context.logger.info("router {router} is already gone", {
            router: args.router,
          });
          return { dataHandles: [] };
        }
        const router = normalizeRouter(existing);
        context.logger.info("deleting router {name} ({id})", {
          name: router.name,
          id: router.id,
        });
        await openstack(cliOptions(context.globalArgs), [
          "router",
          "delete",
          router.id,
        ], context.signal);
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, router));
        }
        return { dataHandles: [] };
      },
    },
  },
};
