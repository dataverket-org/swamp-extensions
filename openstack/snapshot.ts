/**
 * `@dataverket/openstack/volume-snapshot` — Cinder volume snapshots through
 * the `openstack` CLI: discover, create (waiting for `available`) and
 * delete (waiting until gone).
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
  num,
  pollUntil,
  propertyFlags,
  type Raw,
  showRaw,
  showRawOrNull,
  str,
  strRecord,
  writeAll,
} from "./common.ts";

const KIND = ["volume", "snapshot"];
const PREFIX = "snapshot";

/** One Cinder snapshot as written to the `snapshot` spec. */
export const SnapshotSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  volumeId: z.string(),
  sizeGb: z.number(),
  status: z.string().describe("available, creating, deleting, error, ..."),
  properties: z.record(z.string(), z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** {@link SnapshotSchema} */
export type Snapshot = z.infer<typeof SnapshotSchema>;

/** Shape a raw `volume snapshot show` object into a {@link Snapshot}. */
export function normalizeSnapshot(raw: Raw): Snapshot {
  return {
    id: str(raw.id),
    name: str(raw.name),
    description: str(raw.description),
    volumeId: str(raw.volume_id),
    sizeGb: num(raw.size),
    status: str(raw.status),
    properties: strRecord(raw.properties),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

async function writeSnapshot(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "snapshot", PREFIX, [normalizeSnapshot(raw)]);
}

const Target = z.string().min(1).describe("Snapshot name or ID");
const Timeout = z.number().int().positive().default(600).describe(
  "Seconds to wait for Cinder to settle",
);
const ListArgs = z.object({
  volume: z.string().optional().describe(
    "Only snapshots of this volume (name or ID)",
  ),
  name: z.string().optional().describe("Exact name filter"),
  status: z.string().optional(),
});
const GetArgs = z.object({ snapshot: Target });
const CreateArgs = z.object({
  name: z.string().min(1).describe(
    "Snapshot name; an existing snapshot is reused",
  ),
  volume: z.string().min(1).describe("Volume to snapshot (name or ID)"),
  description: z.string().optional(),
  force: z.boolean().default(false).describe(
    "Allow snapshotting an attached volume",
  ),
  properties: z.record(z.string(), z.string()).optional(),
  wait: z.boolean().default(true),
  timeoutSeconds: Timeout,
});
const DeleteArgs = z.object({
  snapshot: Target,
  wait: z.boolean().default(true),
  timeoutSeconds: Timeout,
});

/** Cinder volume snapshot model. */
export const model = {
  type: "@dataverket/openstack/volume-snapshot",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    snapshot: {
      description: "A Cinder volume snapshot: source volume, size and status",
      schema: SnapshotSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "Discover snapshots (optionally of one volume) and store each one",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const filters: string[] = [];
        if (args.volume) {
          filters.push("--volume", assertArg(args.volume, "volume"));
        }
        if (args.name) filters.push("--name", assertArg(args.name, "name"));
        if (args.status) {
          filters.push("--status", assertArg(args.status, "status"));
        }
        context.logger.info("listing volume snapshots");
        const snapshots = (await listThenShow(context, KIND, filters)).map(
          normalizeSnapshot,
        );
        const handles = await writeAll(context, "snapshot", PREFIX, snapshots);
        context.logger.info("stored {count} snapshots", {
          count: snapshots.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one snapshot by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading snapshot {snapshot}", {
          snapshot: args.snapshot,
        });
        return {
          dataHandles: await writeSnapshot(
            context,
            await showRaw(context, KIND, args.snapshot),
          ),
        };
      },
    },
    create: {
      description:
        "Snapshot a volume and wait until the snapshot is available; an existing name is reused",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.name, "name");
        const existing = await showRawOrNull(context, KIND, args.name);
        if (existing) {
          context.logger.info(
            "snapshot {name} already exists as {id}; reusing",
            { name: args.name, id: str(existing.id) },
          );
          return { dataHandles: await writeSnapshot(context, existing) };
        }
        const cli = [
          ...KIND,
          "create",
          "--volume",
          assertArg(args.volume, "volume"),
        ];
        if (args.description !== undefined) {
          cli.push("--description", args.description);
        }
        if (args.force) cli.push("--force");
        cli.push(...propertyFlags("--property", args.properties));
        context.logger.info("snapshotting volume {volume} as {name}", {
          volume: args.volume,
          name: args.name,
        });
        const created = assertShow(
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            args.name,
          ], context.signal),
          "volume snapshot create",
        );
        const id = str(created.id);
        let raw = await showRaw(context, KIND, id);
        if (args.wait) {
          raw = await pollUntil(
            async () => {
              const current = await showRaw(context, KIND, id);
              const status = str(current.status);
              if (status.startsWith("error")) {
                throw new Error(`snapshot ${id} entered status ${status}`);
              }
              return status === "creating" ? undefined : current;
            },
            `snapshot ${id} to become available`,
            args.timeoutSeconds * 1000,
            context.signal,
          );
        }
        context.logger.info("snapshot {name} is {status}", {
          name: args.name,
          status: str(raw.status),
        });
        return { dataHandles: await writeSnapshot(context, raw) };
      },
    },
    delete: {
      description:
        "Delete a snapshot (no-op when already gone), wait until it vanishes and drop its stored resource",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showRawOrNull(context, KIND, args.snapshot);
        if (!existing) {
          context.logger.info("snapshot {snapshot} is already gone", {
            snapshot: args.snapshot,
          });
          return { dataHandles: [] };
        }
        const snapshot = normalizeSnapshot(existing);
        context.logger.info("deleting snapshot {name} ({id})", {
          name: snapshot.name,
          id: snapshot.id,
        });
        await openstack(cliOptions(context.globalArgs), [
          ...KIND,
          "delete",
          snapshot.id,
        ], context.signal);
        if (args.wait) {
          await pollUntil(
            async () =>
              (await showRawOrNull(context, KIND, snapshot.id)) === null
                ? true
                : undefined,
            `snapshot ${snapshot.id} to be deleted`,
            args.timeoutSeconds * 1000,
            context.signal,
          );
        }
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, snapshot));
        }
        return { dataHandles: [] };
      },
    },
  },
};
