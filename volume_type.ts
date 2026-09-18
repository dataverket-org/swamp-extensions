/**
 * `@dataverket/openstack/volume-type` — Cinder volume types, read-only. A
 * lookup source so volume definitions can pick a type by name.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  assertArg,
  bool,
  checks,
  type DataHandle,
  GlobalArgsSchema,
  listThenShow,
  type MethodResult,
  type ModelContext,
  type Raw,
  showRaw,
  str,
  strRecord,
  writeAll,
} from "./common.ts";

const KIND = ["volume", "type"];
const PREFIX = "volumetype";

/** One Cinder volume type as written to the `volumeType` spec. */
export const VolumeTypeSchema = z.object({
  id: z.string(),
  name: z.string(),
  description: z.string(),
  public: z.boolean(),
  properties: z.record(z.string(), z.string()).describe(
    "Extra specs, e.g. volume_backend_name",
  ),
});
/** {@link VolumeTypeSchema} */
export type VolumeType = z.infer<typeof VolumeTypeSchema>;

/** Shape a raw `volume type show` object into a {@link VolumeType}. */
export function normalizeVolumeType(raw: Raw): VolumeType {
  return {
    id: str(raw.id),
    name: str(raw.name),
    description: str(raw.description),
    public: bool(raw.is_public),
    properties: strRecord(raw.properties),
  };
}

async function writeType(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "volumeType", PREFIX, [
    normalizeVolumeType(raw),
  ]);
}

const ListArgs = z.object({});
const GetArgs = z.object({
  volumeType: z.string().min(1).describe("Volume type name or ID"),
});

/** Cinder volume type lookup model (read-only). */
export const model = {
  type: "@dataverket/openstack/volume-type",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    volumeType: {
      description: "A Cinder volume type and its extra specs",
      schema: VolumeTypeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    list: {
      description:
        "Discover the volume types the project can use and store each one",
      arguments: ListArgs,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing volume types");
        const types = (await listThenShow(context, KIND, [])).map(
          normalizeVolumeType,
        );
        const handles = await writeAll(context, "volumeType", PREFIX, types);
        context.logger.info("stored {count} volume types", {
          count: types.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one volume type by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading volume type {type}", {
          type: args.volumeType,
        });
        return {
          dataHandles: await writeType(
            context,
            await showRaw(
              context,
              KIND,
              assertArg(args.volumeType, "volumeType"),
            ),
          ),
        };
      },
    },
  },
};
