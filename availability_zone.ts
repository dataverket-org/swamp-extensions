/**
 * `@dataverket/openstack/availability-zone` — availability zones per
 * service, read-only. Nova, Neutron and Cinder each keep their own list.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { openstackJson } from "./cli.ts";
import {
  assertList,
  checks,
  cliOptions,
  GlobalArgsSchema,
  type MethodResult,
  type ModelContext,
  str,
  writeAll,
} from "./common.ts";

const PREFIX = "zone";

/** One availability zone as written to the `zone` spec. */
export const ZoneSchema = z.object({
  id: z.string().describe("<service>/<zone name>"),
  name: z.string(),
  service: z.string().describe("compute, network or volume"),
  status: z.string().describe("available or not available"),
});
/** {@link ZoneSchema} */
export type Zone = z.infer<typeof ZoneSchema>;

/**
 * Shape the rows of `availability zone list --<service>` into zones. The CLI
 * repeats a zone once per host, so rows are de-duplicated by name.
 */
export function normalizeZones(
  rows: Record<string, unknown>[],
  service: string,
): Zone[] {
  const byName = new Map<string, Zone>();
  for (const row of rows) {
    const name = str(row["Zone Name"]);
    if (!name || byName.has(name)) continue;
    byName.set(name, {
      id: `${service}/${name}`,
      name,
      service,
      status: str(row["Zone Status"]),
    });
  }
  return [...byName.values()];
}

const ListArgs = z.object({
  service: z.enum(["compute", "network", "volume"]).default("compute"),
});

/** Availability zone lookup model (read-only). */
export const model = {
  type: "@dataverket/openstack/availability-zone",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    zone: {
      description: "An availability zone of one service and its status",
      schema: ZoneSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    list: {
      description:
        "Discover the zones of one service (compute by default) and store each one",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing {service} availability zones", {
          service: args.service,
        });
        const rows = assertList(
          await openstackJson(
            cliOptions(context.globalArgs),
            ["availability", "zone", "list", `--${args.service}`],
            context.signal,
          ),
          "availability zone list",
        );
        const zones = normalizeZones(rows, args.service);
        // Instance names carry the service so compute and volume zones of the
        // same name never collide: zone-compute-<name>, zone-volume-<name>.
        const handles = await writeAll(
          context,
          "zone",
          `${PREFIX}-${args.service}`,
          zones,
        );
        context.logger.info("stored {count} zones", { count: zones.length });
        return { dataHandles: handles };
      },
    },
  },
};
