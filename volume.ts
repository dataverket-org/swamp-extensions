/**
 * `@dataverket/openstack/volume` — Cinder volumes through the `openstack`
 * CLI: discover, create, update, attach/detach to servers and delete.
 *
 * `create` and `delete` poll `volume show` until Cinder settles, since the CLI
 * returns as soon as the request is accepted.
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
  objList,
  pollUntil,
  propertyFlags,
  type Raw,
  showRaw,
  showRawOrNull,
  str,
  strRecord,
  writeAll,
} from "./common.ts";

const KIND = ["volume"];
const PREFIX = "volume";

/** One attachment of a volume to a server. */
export const AttachmentSchema = z.object({
  serverId: z.string(),
  device: z.string().describe("Device path inside the server, e.g. /dev/vdb"),
  attachmentId: z.string(),
  attachedAt: z.string(),
});

/** One Cinder volume as written to the `volume` spec. */
export const VolumeSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().describe("available, in-use, creating, error, ..."),
  sizeGb: z.number(),
  type: z.string().describe("Volume type name"),
  bootable: z.boolean(),
  encrypted: z.boolean(),
  multiattach: z.boolean(),
  availabilityZone: z.string(),
  description: z.string(),
  attachments: z.array(AttachmentSchema),
  properties: z.record(z.string(), z.string()),
  snapshotId: z.string(),
  sourceVolumeId: z.string(),
  projectId: z.string(),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** {@link VolumeSchema} */
export type Volume = z.infer<typeof VolumeSchema>;

/** Shape a raw `volume show` object into a {@link Volume}. */
export function normalizeVolume(raw: Raw): Volume {
  return {
    id: str(raw.id),
    name: str(raw.name),
    status: str(raw.status),
    sizeGb: num(raw.size),
    type: str(raw.type),
    bootable: bool(raw.bootable),
    encrypted: bool(raw.encrypted),
    multiattach: bool(raw.multiattach),
    availabilityZone: str(raw.availability_zone),
    description: str(raw.description),
    attachments: objList(raw.attachments).map((a) => ({
      serverId: str(a.server_id),
      device: str(a.device),
      attachmentId: str(a.attachment_id),
      attachedAt: str(a.attached_at),
    })),
    properties: strRecord(raw.properties),
    snapshotId: str(raw.snapshot_id),
    sourceVolumeId: str(raw.source_volid),
    projectId: str(raw["os-vol-tenant-attr:tenant_id"]),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

async function writeVolume(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "volume", PREFIX, [normalizeVolume(raw)]);
}

/** Poll until the volume leaves a transitional status; throw on `error*`. */
async function settle(
  context: ModelContext,
  id: string,
  transitional: string[],
  timeoutSeconds: number,
): Promise<Raw> {
  const raw = await pollUntil(
    async () => {
      const current = await showRaw(context, KIND, id);
      const status = str(current.status);
      if (status.startsWith("error")) {
        throw new Error(`volume ${id} entered status ${status}`);
      }
      return transitional.includes(status) ? undefined : current;
    },
    `volume ${id} to settle`,
    timeoutSeconds * 1000,
    context.signal,
  );
  return raw;
}

const Target = z.string().min(1).describe("Volume name or ID");
const Timeout = z.number().int().positive().default(600).describe(
  "Seconds to wait for Cinder to settle",
);

const ListArgs = z.object({
  name: z.string().optional().describe("Exact name filter"),
  status: z.string().optional(),
});
const GetArgs = z.object({ volume: Target });
const CreateArgs = z.object({
  name: z.string().min(1).describe("Volume name; an existing volume is reused"),
  sizeGb: z.number().int().positive().optional().describe(
    "Size in GB; required unless cloning a snapshot or volume",
  ),
  type: z.string().optional().describe("Volume type"),
  image: z.string().optional().describe(
    "Populate from this image (name or ID)",
  ),
  snapshot: z.string().optional().describe("Populate from this snapshot"),
  source: z.string().optional().describe("Clone this volume"),
  description: z.string().optional(),
  availabilityZone: z.string().optional(),
  bootable: z.boolean().optional(),
  properties: z.record(z.string(), z.string()).optional(),
  wait: z.boolean().default(true).describe(
    "Wait until the volume is available",
  ),
  timeoutSeconds: Timeout,
});
const UpdateArgs = z.object({
  volume: Target,
  name: z.string().optional(),
  description: z.string().optional(),
  sizeGb: z.number().int().positive().optional().describe(
    "Extend to this size",
  ),
  bootable: z.boolean().optional(),
  properties: z.record(z.string(), z.string()).optional(),
});
const DeleteArgs = z.object({
  volume: Target,
  force: z.boolean().default(false).describe("Delete regardless of state"),
  wait: z.boolean().default(true),
  timeoutSeconds: Timeout,
});
const AttachArgs = z.object({
  volume: Target,
  server: z.string().min(1).describe("Server name or ID"),
  device: z.string().optional().describe("Device name inside the server"),
  deleteOnTermination: z.boolean().optional(),
  timeoutSeconds: Timeout,
});
const DetachArgs = z.object({
  volume: Target,
  server: z.string().min(1).describe("Server name or ID"),
  timeoutSeconds: Timeout,
});

/** Cinder volume model. */
export const model = {
  type: "@dataverket/openstack/volume",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    volume: {
      description: "A Cinder volume: size, type, status and server attachments",
      schema: VolumeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "Discover the project's volumes and store each one",
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
        context.logger.info("listing volumes");
        const volumes = (await listThenShow(context, KIND, filters)).map(
          normalizeVolume,
        );
        const handles = await writeAll(context, "volume", PREFIX, volumes);
        context.logger.info("stored {count} volumes", {
          count: volumes.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one volume by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading volume {volume}", { volume: args.volume });
        return {
          dataHandles: await writeVolume(
            context,
            await showRaw(context, KIND, args.volume),
          ),
        };
      },
    },
    create: {
      description:
        "Create a volume (blank, from an image, snapshot or another volume) and wait for it; an existing name is reused",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        if (!args.sizeGb && !args.snapshot && !args.source) {
          throw new Error(
            "create needs sizeGb unless a snapshot or source volume is given",
          );
        }
        assertArg(args.name, "name");
        const existing = await showRawOrNull(context, KIND, args.name);
        if (existing) {
          context.logger.info("volume {name} already exists as {id}; reusing", {
            name: args.name,
            id: str(existing.id),
          });
          return { dataHandles: await writeVolume(context, existing) };
        }
        const cli = ["volume", "create"];
        if (args.sizeGb) cli.push("--size", String(args.sizeGb));
        if (args.type) cli.push("--type", assertArg(args.type, "type"));
        if (args.image) cli.push("--image", assertArg(args.image, "image"));
        if (args.snapshot) {
          cli.push("--snapshot", assertArg(args.snapshot, "snapshot"));
        }
        if (args.source) cli.push("--source", assertArg(args.source, "source"));
        if (args.description !== undefined) {
          cli.push("--description", args.description);
        }
        if (args.availabilityZone) {
          cli.push(
            "--availability-zone",
            assertArg(args.availabilityZone, "availabilityZone"),
          );
        }
        if (args.bootable !== undefined) {
          cli.push(args.bootable ? "--bootable" : "--non-bootable");
        }
        cli.push(...propertyFlags("--property", args.properties));
        context.logger.info("creating volume {name}", { name: args.name });
        const created = assertShow(
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            args.name,
          ], context.signal),
          "volume create",
        );
        const id = str(created.id);
        const raw = args.wait
          ? await settle(
            context,
            id,
            ["creating", "downloading"],
            args.timeoutSeconds,
          )
          : await showRaw(context, KIND, id);
        context.logger.info("volume {name} is {status}", {
          name: args.name,
          status: str(raw.status),
        });
        return { dataHandles: await writeVolume(context, raw) };
      },
    },
    update: {
      description:
        "Rename, describe, extend, toggle bootable or set properties on a volume",
      arguments: UpdateArgs,
      execute: async (
        args: z.infer<typeof UpdateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const before = normalizeVolume(
          await showRaw(context, KIND, args.volume),
        );
        const set: string[] = [];
        if (args.name !== undefined) {
          set.push("--name", assertArg(args.name, "name"));
        }
        if (args.description !== undefined) {
          set.push("--description", args.description);
        }
        if (args.sizeGb !== undefined) set.push("--size", String(args.sizeGb));
        if (args.bootable !== undefined) {
          set.push(args.bootable ? "--bootable" : "--non-bootable");
        }
        set.push(...propertyFlags("--property", args.properties));
        if (set.length === 0) {
          context.logger.info("nothing to update on volume {id}", {
            id: before.id,
          });
          return {
            dataHandles: await writeAll(context, "volume", PREFIX, [before]),
          };
        }
        context.logger.info("updating volume {id}", { id: before.id });
        await openstack(cliOptions(context.globalArgs), [
          "volume",
          "set",
          ...set,
          before.id,
        ], context.signal);
        const after = normalizeVolume(await showRaw(context, KIND, before.id));
        if (after.name !== before.name && context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, before));
        }
        return {
          dataHandles: await writeAll(context, "volume", PREFIX, [after]),
        };
      },
    },
    delete: {
      description:
        "Delete a volume (no-op when already gone), wait for it to vanish and drop its stored resource",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showRawOrNull(context, KIND, args.volume);
        if (!existing) {
          context.logger.info("volume {volume} is already gone", {
            volume: args.volume,
          });
          return { dataHandles: [] };
        }
        const volume = normalizeVolume(existing);
        const cli = ["volume", "delete"];
        if (args.force) cli.push("--force");
        context.logger.info("deleting volume {name} ({id})", {
          name: volume.name,
          id: volume.id,
        });
        await openstack(
          cliOptions(context.globalArgs),
          [...cli, volume.id],
          context.signal,
        );
        if (args.wait) {
          await pollUntil(
            async () =>
              (await showRawOrNull(context, KIND, volume.id)) === null
                ? true
                : undefined,
            `volume ${volume.id} to be deleted`,
            args.timeoutSeconds * 1000,
            context.signal,
          );
        }
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, volume));
        }
        context.logger.info("deleted volume {name}", { name: volume.name });
        return { dataHandles: [] };
      },
    },
    attach: {
      description:
        "Attach a volume to a server and store the volume with its new attachment",
      arguments: AttachArgs,
      execute: async (
        args: z.infer<typeof AttachArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const volume = normalizeVolume(
          await showRaw(context, KIND, args.volume),
        );
        const cli = ["server", "add", "volume"];
        if (args.device) cli.push("--device", assertArg(args.device, "device"));
        if (args.deleteOnTermination !== undefined) {
          cli.push(
            args.deleteOnTermination
              ? "--enable-delete-on-termination"
              : "--disable-delete-on-termination",
          );
        }
        context.logger.info("attaching volume {volume} to server {server}", {
          volume: volume.name,
          server: args.server,
        });
        await openstack(
          cliOptions(context.globalArgs),
          [...cli, assertArg(args.server, "server"), volume.id],
          context.signal,
        );
        const raw = await settle(
          context,
          volume.id,
          ["attaching", "reserved"],
          args.timeoutSeconds,
        );
        return { dataHandles: await writeVolume(context, raw) };
      },
    },
    detach: {
      description: "Detach a volume from a server and store the volume",
      arguments: DetachArgs,
      execute: async (
        args: z.infer<typeof DetachArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const volume = normalizeVolume(
          await showRaw(context, KIND, args.volume),
        );
        context.logger.info("detaching volume {volume} from server {server}", {
          volume: volume.name,
          server: args.server,
        });
        await openstack(
          cliOptions(context.globalArgs),
          [
            "server",
            "remove",
            "volume",
            assertArg(args.server, "server"),
            volume.id,
          ],
          context.signal,
        );
        const raw = await settle(
          context,
          volume.id,
          ["detaching", "in-use"],
          args.timeoutSeconds,
        );
        return { dataHandles: await writeVolume(context, raw) };
      },
    },
  },
};
