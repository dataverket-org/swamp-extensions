/**
 * `@dataverket/openstack/flavor` — Nova flavors, read-only. A lookup source
 * so server definitions can reference a flavor by name and pick up its id
 * and sizing through CEL.
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
  num,
  type Raw,
  showRaw,
  str,
  strRecord,
  writeAll,
} from "./common.ts";

const KIND = ["flavor"];
const PREFIX = "flavor";

/** One Nova flavor as written to the `flavor` spec. */
export const FlavorSchema = z.object({
  id: z.string(),
  name: z.string(),
  vcpus: z.number(),
  ramMb: z.number(),
  diskGb: z.number(),
  ephemeralGb: z.number(),
  swapMb: z.number(),
  public: z.boolean(),
  disabled: z.boolean(),
  description: z.string(),
  properties: z.record(z.string(), z.string()).describe("Extra specs"),
});
/** {@link FlavorSchema} */
export type Flavor = z.infer<typeof FlavorSchema>;

/** Shape a raw `flavor show` object into a {@link Flavor}. */
export function normalizeFlavor(raw: Raw): Flavor {
  return {
    id: str(raw.id),
    name: str(raw.name),
    vcpus: num(raw.vcpus),
    ramMb: num(raw.ram),
    diskGb: num(raw.disk),
    ephemeralGb: num(raw["OS-FLV-EXT-DATA:ephemeral"]),
    swapMb: num(raw.swap),
    public: bool(raw["os-flavor-access:is_public"]),
    disabled: bool(raw["OS-FLV-DISABLED:disabled"]),
    description: str(raw.description),
    properties: strRecord(raw.properties),
  };
}

async function writeFlavor(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "flavor", PREFIX, [normalizeFlavor(raw)]);
}

const ListArgs = z.object({
  all: z.boolean().default(false).describe(
    "Include private flavors the project can see",
  ),
  minRamMb: z.number().int().positive().optional(),
  minDiskGb: z.number().int().positive().optional(),
});
const GetArgs = z.object({
  flavor: z.string().min(1).describe("Flavor name or ID"),
});

/** Nova flavor lookup model (read-only). */
export const model = {
  type: "@dataverket/openstack/flavor",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    flavor: {
      description: "A Nova flavor: vCPUs, RAM, disk and extra specs",
      schema: FlavorSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    list: {
      description: "Discover flavors (public by default) and store each one",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const filters: string[] = [];
        if (args.all) filters.push("--all");
        if (args.minRamMb) filters.push("--min-ram", String(args.minRamMb));
        if (args.minDiskGb) filters.push("--min-disk", String(args.minDiskGb));
        context.logger.info("listing flavors");
        const flavors = (await listThenShow(context, KIND, filters)).map(
          normalizeFlavor,
        );
        const handles = await writeAll(context, "flavor", PREFIX, flavors);
        context.logger.info("stored {count} flavors", {
          count: flavors.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one flavor by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading flavor {flavor}", { flavor: args.flavor });
        return {
          dataHandles: await writeFlavor(
            context,
            await showRaw(context, KIND, assertArg(args.flavor, "flavor")),
          ),
        };
      },
    },
  },
};
