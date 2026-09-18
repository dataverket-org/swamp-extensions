/**
 * `@dataverket/openstack/server` — Nova instances through the `openstack`
 * CLI: discover, create, update, start/stop/reboot and delete servers.
 *
 * `list` and `get` write the same `server` shape (a fan-out of
 * `server show` follows every `server list`), so downstream CEL never has to
 * care which method produced the data. Every mutating method finishes by
 * re-reading the server and writing the fresh state; `delete` removes the
 * stored resource.
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
  obj,
  objList,
  propertyFlags,
  type Raw,
  repeatFlag,
  resolveId,
  showRaw,
  showRawOrNull,
  str,
  strList,
  strRecord,
  withTempFile,
  writeAll,
} from "./common.ts";

const KIND = ["server"];
const PREFIX = "server";

/** One Nova server as written to the `server` spec. */
export const ServerSchema = z.object({
  id: z.string().describe("Server UUID"),
  name: z.string(),
  status: z.string().describe("ACTIVE, SHUTOFF, BUILD, ERROR, ..."),
  vmState: z.string().describe("OS-EXT-STS:vm_state"),
  taskState: z.string().describe("OS-EXT-STS:task_state, empty when idle"),
  powerState: z.string().describe("RUNNING, SHUTDOWN, PAUSED, ..."),
  hostname: z.string(),
  availabilityZone: z.string(),
  addresses: z.record(z.string(), z.array(z.string())).describe(
    "Network name to the IP addresses on it",
  ),
  ipAddresses: z.array(z.string()).describe("Every address, flattened"),
  imageName: z.string(),
  imageId: z.string().describe("Empty when booted from a volume"),
  flavorName: z.string(),
  flavorId: z.string(),
  vcpus: z.number(),
  ramMb: z.number(),
  diskGb: z.number(),
  keyName: z.string(),
  securityGroups: z.array(z.string()),
  serverGroups: z.array(z.string()),
  volumesAttached: z.array(z.string()).describe("Attached volume ids"),
  properties: z.record(z.string(), z.string()),
  tags: z.array(z.string()),
  description: z.string(),
  locked: z.boolean(),
  projectId: z.string(),
  userId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
  launchedAt: z.string(),
});
/** {@link ServerSchema} */
export type Server = z.infer<typeof ServerSchema>;

const POWER_STATES: Record<number, string> = {
  0: "NOSTATE",
  1: "RUNNING",
  3: "PAUSED",
  4: "SHUTDOWN",
  6: "CRASHED",
  7: "SUSPENDED",
};

/** Split the CLI's `"Name (uuid)"` rendering, or read a `{name, id}` object. */
export function parseNameId(v: unknown): { name: string; id: string } {
  if (v !== null && typeof v === "object") {
    const o = obj(v);
    return {
      name: str(o.name ?? o.original_name),
      id: str(o.id),
    };
  }
  const text = str(v);
  const m = text.match(/^(.*) \(([0-9a-f-]{36})\)$/i);
  if (m) return { name: m[1], id: m[2] };
  return { name: text, id: "" };
}

/** Shape a raw `server show` object into a {@link Server}. */
export function normalizeServer(raw: Raw): Server {
  const addresses: Record<string, string[]> = {};
  for (const [net, ips] of Object.entries(obj(raw.addresses))) {
    addresses[net] = strList(ips);
  }
  const image = parseNameId(raw.image);
  const flavorRaw = raw.flavor;
  const flavor = parseNameId(flavorRaw);
  const flavorObj = obj(flavorRaw);
  const power = raw["OS-EXT-STS:power_state"];
  return {
    id: str(raw.id),
    name: str(raw.name),
    status: str(raw.status),
    vmState: str(raw["OS-EXT-STS:vm_state"]),
    taskState: str(raw["OS-EXT-STS:task_state"]),
    powerState: typeof power === "number"
      ? (POWER_STATES[power] ?? `state-${power}`)
      : str(power).toUpperCase(),
    hostname: str(raw["OS-EXT-SRV-ATTR:hostname"]),
    availabilityZone: str(raw["OS-EXT-AZ:availability_zone"]),
    addresses,
    ipAddresses: Object.values(addresses).flat(),
    imageName: image.name,
    imageId: image.id,
    flavorName: flavor.name,
    flavorId: flavor.id,
    vcpus: num(flavorObj.vcpus),
    ramMb: num(flavorObj.ram),
    diskGb: num(flavorObj.disk),
    keyName: str(raw.key_name),
    securityGroups: objList(raw.security_groups).map((g) => str(g.name)),
    serverGroups: strList(raw.server_groups),
    volumesAttached: objList(raw.volumes_attached).map((v) => str(v.id)),
    properties: strRecord(raw.properties),
    tags: strList(raw.tags),
    description: str(raw.description),
    locked: bool(raw.locked),
    projectId: str(raw.project_id),
    userId: str(raw.user_id),
    createdAt: str(raw.created),
    updatedAt: str(raw.updated),
    launchedAt: str(raw["OS-SRV-USG:launched_at"]),
  };
}

async function writeServer(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "server", PREFIX, [normalizeServer(raw)]);
}

/** Re-read a server by id and store it. */
async function refresh(
  context: ModelContext,
  id: string,
): Promise<MethodResult> {
  return {
    dataHandles: await writeServer(context, await showRaw(context, KIND, id)),
  };
}

const Target = z.string().min(1).describe("Server name or ID");

const ListArgs = z.object({
  name: z.string().optional().describe("Regex filter on server name"),
  status: z.string().optional().describe("Filter on status, e.g. ACTIVE"),
});
const GetArgs = z.object({ server: Target });
const Nic = z.object({
  network: z.string().optional().describe("Network name or ID"),
  port: z.string().optional().describe(
    "Port name or ID (instead of a network)",
  ),
  fixedIpV4: z.string().optional(),
  fixedIpV6: z.string().optional(),
  tag: z.string().optional(),
});
const BlockDevice = z.object({
  sourceType: z.enum(["image", "snapshot", "volume", "blank"]),
  destinationType: z.enum(["volume", "local"]).default("volume"),
  uuid: z.string().optional().describe(
    "Image, snapshot or volume ID (required unless blank)",
  ),
  volumeSizeGb: z.number().int().positive().optional(),
  volumeType: z.string().optional(),
  bootIndex: z.number().int().optional().describe(
    "0 for the boot device, -1 or omitted for data disks",
  ),
  deleteOnTermination: z.boolean().optional(),
  deviceName: z.string().optional(),
  tag: z.string().optional(),
});
const InterfaceArgs = z.object({
  server: Target,
  network: z.string().optional().describe(
    "Attach a new NIC on this network (name or ID)",
  ),
  port: z.string().optional().describe(
    "Attach this existing port (name or ID)",
  ),
  tag: z.string().optional(),
});
const DetachArgs = z.object({
  server: Target,
  network: z.string().optional().describe(
    "Detach every NIC on this network (name or ID)",
  ),
  port: z.string().optional().describe("Detach this port (name or ID)"),
});
const CreateArgs = z.object({
  name: z.string().min(1).describe("Server name; reused if it already exists"),
  flavor: z.string().min(1).describe("Flavor name or ID"),
  image: z.string().optional().describe("Boot image name or ID"),
  volume: z.string().optional().describe("Boot volume name or ID"),
  bootFromVolume: z.number().int().positive().optional().describe(
    "Create a boot volume of this many GB from the image",
  ),
  networks: z.array(z.string()).optional().describe(
    "Networks (name or ID) to attach a NIC to, in order",
  ),
  ports: z.array(z.string()).optional().describe(
    "Pre-created ports (name or ID) to attach, in order",
  ),
  nics: z.array(Nic).optional().describe(
    "NICs with fixed addresses; network or port names are resolved to ids",
  ),
  blockDevices: z.array(BlockDevice).optional().describe(
    "Block device mappings beyond the boot disk",
  ),
  configDrive: z.boolean().optional().describe(
    "Force (true) or forbid (false) a config drive; cloud default when omitted",
  ),
  hints: z.record(z.string(), z.string()).optional().describe(
    "Scheduler hints, e.g. different_host=<id>",
  ),
  keyName: z.string().optional().describe("Keypair name to inject"),
  securityGroups: z.array(z.string()).optional(),
  userData: z.string().optional().describe(
    "cloud-init user data, passed to the CLI through a private temp file; empty means none",
  ),
  availabilityZone: z.string().optional(),
  serverGroup: z.string().optional().describe("Server group name or ID"),
  properties: z.record(z.string(), z.string()).optional(),
  tags: z.array(z.string()).optional(),
  description: z.string().optional(),
  wait: z.boolean().default(true).describe("Wait for the build to finish"),
});
const UpdateArgs = z.object({
  server: Target,
  name: z.string().optional().describe("New name"),
  description: z.string().optional(),
  properties: z.record(z.string(), z.string()).optional().describe(
    "Properties to set (others are left alone)",
  ),
  removeProperties: z.array(z.string()).optional(),
});
const DeleteArgs = z.object({
  server: Target,
  force: z.boolean().default(false),
  wait: z.boolean().default(true),
});
const RebootArgs = z.object({
  server: Target,
  hard: z.boolean().default(false),
  wait: z.boolean().default(true),
});

/** Nova server model. */
export const model = {
  type: "@dataverket/openstack/server",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    server: {
      description:
        "A Nova server: state, addresses, image, flavor, keypair, groups and attached volumes",
      schema: ServerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "Discover servers in the project (optionally filtered by name regex or status) and store each one",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const filters: string[] = [];
        if (args.name) filters.push("--name", assertArg(args.name, "name"));
        if (args.status) {
          filters.push("--status", assertArg(args.status, "status"));
        }
        context.logger.info("listing servers");
        const raws = await listThenShow(context, KIND, filters);
        const servers = raws.map(normalizeServer);
        const handles = await writeAll(context, "server", PREFIX, servers);
        context.logger.info("stored {count} servers", {
          count: servers.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one server by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading server {server}", { server: args.server });
        return {
          dataHandles: await writeServer(
            context,
            await showRaw(context, KIND, args.server),
          ),
        };
      },
    },
    create: {
      description:
        "Create a server (image or volume boot) and wait for it; an existing server of the same name is reused",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        if (
          !args.image && !args.volume &&
          !args.blockDevices?.some((b) => b.bootIndex === 0)
        ) {
          throw new Error(
            "create needs an image, a volume or a boot-index-0 block device to boot from",
          );
        }
        if (
          !args.networks?.length && !args.ports?.length && !args.nics?.length
        ) {
          throw new Error(
            "create needs at least one of networks, ports or nics",
          );
        }
        assertArg(args.name, "name");
        const existing = await showRawOrNull(context, KIND, args.name);
        if (existing) {
          context.logger.info("server {name} already exists as {id}; reusing", {
            name: args.name,
            id: str(existing.id),
          });
          return { dataHandles: await writeServer(context, existing) };
        }
        const cli = [
          "server",
          "create",
          "--flavor",
          assertArg(args.flavor, "flavor"),
        ];
        if (args.image) cli.push("--image", assertArg(args.image, "image"));
        if (args.volume) cli.push("--volume", assertArg(args.volume, "volume"));
        if (args.bootFromVolume) {
          cli.push("--boot-from-volume", String(args.bootFromVolume));
        }
        cli.push(...repeatFlag("--network", args.networks, "network"));
        cli.push(...repeatFlag("--port", args.ports, "port"));
        for (const nic of args.nics ?? []) {
          if ((nic.network ? 1 : 0) + (nic.port ? 1 : 0) !== 1) {
            throw new Error("a nic needs exactly one of network or port");
          }
          cli.push(
            "--nic",
            csvPairs({
              "net-id": nic.network
                ? await resolveId(
                  context,
                  ["network"],
                  assertArg(nic.network, "nic.network"),
                )
                : undefined,
              "port-id": nic.port
                ? await resolveId(
                  context,
                  ["port"],
                  assertArg(nic.port, "nic.port"),
                )
                : undefined,
              "v4-fixed-ip": nic.fixedIpV4,
              "v6-fixed-ip": nic.fixedIpV6,
              tag: nic.tag,
            }),
          );
        }
        for (const bd of args.blockDevices ?? []) {
          if (bd.sourceType !== "blank" && !bd.uuid) {
            throw new Error(`a ${bd.sourceType} block device needs a uuid`);
          }
          cli.push(
            "--block-device",
            csvPairs({
              uuid: bd.uuid,
              source_type: bd.sourceType,
              destination_type: bd.destinationType,
              volume_size: bd.volumeSizeGb,
              volume_type: bd.volumeType,
              boot_index: bd.bootIndex,
              delete_on_termination: bd.deleteOnTermination,
              device_name: bd.deviceName,
              tag: bd.tag,
            }),
          );
        }
        if (args.configDrive !== undefined) {
          cli.push(
            args.configDrive ? "--use-config-drive" : "--no-config-drive",
          );
        }
        cli.push(...propertyFlags("--hint", args.hints));
        if (args.keyName) {
          cli.push("--key-name", assertArg(args.keyName, "keyName"));
        }
        cli.push(
          ...repeatFlag(
            "--security-group",
            args.securityGroups,
            "securityGroup",
          ),
        );
        if (args.availabilityZone) {
          cli.push(
            "--availability-zone",
            assertArg(args.availabilityZone, "availabilityZone"),
          );
        }
        if (args.serverGroup) {
          cli.push(
            "--server-group",
            assertArg(args.serverGroup, "serverGroup"),
          );
        }
        cli.push(...propertyFlags("--property", args.properties));
        cli.push(...repeatFlag("--tag", args.tags, "tag"));
        if (args.description !== undefined) {
          cli.push("--description", args.description);
        }
        if (args.wait) cli.push("--wait");
        context.logger.info("creating server {name} ({flavor})", {
          name: args.name,
          flavor: args.flavor,
        });
        const run = (extra: string[]) =>
          openstackJson(
            cliOptions(context.globalArgs),
            [...cli, ...extra, args.name],
            context.signal,
          );
        const created = assertShow(
          args.userData
            ? await withTempFile(
              args.userData,
              (path) => run(["--user-data", path]),
            )
            : await run([]),
          "server create",
        );
        context.logger.info("created server {name} as {id}", {
          name: args.name,
          id: str(created.id),
        });
        return await refresh(context, str(created.id));
      },
    },
    update: {
      description: "Rename, describe or set/unset properties on a server",
      arguments: UpdateArgs,
      execute: async (
        args: z.infer<typeof UpdateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const before = normalizeServer(
          await showRaw(context, KIND, args.server),
        );
        const opts = cliOptions(context.globalArgs);
        const set: string[] = [];
        if (args.name !== undefined) {
          set.push("--name", assertArg(args.name, "name"));
        }
        if (args.description !== undefined) {
          set.push("--description", args.description);
        }
        set.push(...propertyFlags("--property", args.properties));
        if (set.length > 0) {
          context.logger.info("updating server {id}", { id: before.id });
          await openstack(
            opts,
            ["server", "set", ...set, before.id],
            context.signal,
          );
        }
        if (args.removeProperties && args.removeProperties.length > 0) {
          await openstack(
            opts,
            [
              "server",
              "unset",
              ...repeatFlag("--property", args.removeProperties, "property"),
              before.id,
            ],
            context.signal,
          );
        }
        const after = normalizeServer(await showRaw(context, KIND, before.id));
        if (after.name !== before.name && context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, before));
        }
        return {
          dataHandles: await writeAll(context, "server", PREFIX, [after]),
        };
      },
    },
    delete: {
      description:
        "Delete a server (no-op when it is already gone) and drop its stored resource",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showRawOrNull(context, KIND, args.server);
        if (!existing) {
          context.logger.info("server {server} is already gone", {
            server: args.server,
          });
          return { dataHandles: [] };
        }
        const server = normalizeServer(existing);
        const cli = ["server", "delete"];
        if (args.force) cli.push("--force");
        if (args.wait) cli.push("--wait");
        context.logger.info("deleting server {name} ({id})", {
          name: server.name,
          id: server.id,
        });
        await openstack(
          cliOptions(context.globalArgs),
          [...cli, server.id],
          context.signal,
        );
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, server));
        }
        context.logger.info("deleted server {name}", { name: server.name });
        return { dataHandles: [] };
      },
    },
    attachInterface: {
      description:
        "Attach a NIC on a network, or an existing port, to a running server and store it",
      arguments: InterfaceArgs,
      execute: async (
        args: z.infer<typeof InterfaceArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        if ((args.network ? 1 : 0) + (args.port ? 1 : 0) !== 1) {
          throw new Error(
            "attachInterface needs exactly one of network or port",
          );
        }
        const id = str((await showRaw(context, KIND, args.server)).id);
        const cli = ["server", "add", args.port ? "port" : "network"];
        if (args.tag) cli.push("--tag", assertArg(args.tag, "tag"));
        const target = assertArg(
          args.port ?? args.network ?? "",
          args.port ? "port" : "network",
        );
        context.logger.info("attaching {kind} {target} to server {id}", {
          kind: args.port ? "port" : "network",
          target,
          id,
        });
        await openstack(
          cliOptions(context.globalArgs),
          [...cli, id, target],
          context.signal,
        );
        return await refresh(context, id);
      },
    },
    detachInterface: {
      description:
        "Detach a port, or every NIC on a network, from a running server and store it",
      arguments: DetachArgs,
      execute: async (
        args: z.infer<typeof DetachArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        if ((args.network ? 1 : 0) + (args.port ? 1 : 0) !== 1) {
          throw new Error(
            "detachInterface needs exactly one of network or port",
          );
        }
        const id = str((await showRaw(context, KIND, args.server)).id);
        const target = assertArg(
          args.port ?? args.network ?? "",
          args.port ? "port" : "network",
        );
        context.logger.info("detaching {kind} {target} from server {id}", {
          kind: args.port ? "port" : "network",
          target,
          id,
        });
        await openstack(cliOptions(context.globalArgs), [
          "server",
          "remove",
          args.port ? "port" : "network",
          id,
          target,
        ], context.signal);
        return await refresh(context, id);
      },
    },
    start: {
      description: "Start a stopped server and store its new state",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const id = str((await showRaw(context, KIND, args.server)).id);
        context.logger.info("starting server {id}", { id });
        await openstack(
          cliOptions(context.globalArgs),
          ["server", "start", id],
          context.signal,
        );
        return await refresh(context, id);
      },
    },
    stop: {
      description: "Stop a running server and store its new state",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const id = str((await showRaw(context, KIND, args.server)).id);
        context.logger.info("stopping server {id}", { id });
        await openstack(
          cliOptions(context.globalArgs),
          ["server", "stop", id],
          context.signal,
        );
        return await refresh(context, id);
      },
    },
    reboot: {
      description:
        "Soft (default) or hard reboot a server and store its new state",
      arguments: RebootArgs,
      execute: async (
        args: z.infer<typeof RebootArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const id = str((await showRaw(context, KIND, args.server)).id);
        const cli = ["server", "reboot", args.hard ? "--hard" : "--soft"];
        if (args.wait) cli.push("--wait");
        context.logger.info("rebooting server {id} ({mode})", {
          id,
          mode: args.hard ? "hard" : "soft",
        });
        await openstack(
          cliOptions(context.globalArgs),
          [...cli, id],
          context.signal,
        );
        return await refresh(context, id);
      },
    },
  },
};
