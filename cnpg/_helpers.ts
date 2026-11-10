/**
 * What the three CloudNativePG model types share on top of the shared kubectl
 * layer in `../lib/kubectl.ts`: the method context, the resource names, the
 * reader for a stored URL and the inventory record a list writes. Running
 * kubectl, its named failures, the name checks, the data names and the
 * redaction all live in `../lib/`; nothing here spawns a process.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { brief, redact } from "../lib/cli.ts";
import {
  buildInventory,
  type Inventory,
  type InventoryItem,
  inventoryName,
  InventorySchema,
  type KubectlGlobalArgs,
  KubectlGlobalArgsSchema,
  nonEmpty,
} from "../lib/kubectl.ts";

/** After how long an unfinished Backup is named in an inventory: an hour. */
export const DEFAULT_UNFINISHED_AFTER_SECONDS = 3600;

/**
 * The global arguments of the `backup` and `scheduledbackup` types: the
 * shared three for cluster access, and the age after which a Backup that has
 * not ended is called out.
 */
export const BackupGlobalArgsSchema = KubectlGlobalArgsSchema.extend({
  unfinishedAfterSeconds: z.number().int().min(1).default(
    DEFAULT_UNFINISHED_AFTER_SECONDS,
  ).describe(
    "After how many seconds a Backup that has neither completed nor failed counts as not healthy in the inventory of a list. Set it above the time your longest base backup takes",
  ),
});

/** The logger a method receives. */
export interface MethodLogger {
  info: (msg: string, props?: Record<string, string>) => void;
  warning?: (msg: string, props?: Record<string, string>) => void;
}

/** The context every method in this extension reads. */
export interface CnpgContext<T> {
  globalArgs: KubectlGlobalArgs & { unfinishedAfterSeconds?: number };
  logger: MethodLogger;
  /** Aborted when the method run is cancelled; stops the running kubectl. */
  signal?: AbortSignal;
  writeResource: (
    spec: string,
    name: string,
    data: T | Inventory,
  ) => Promise<unknown>;
}

/** Log a warning, or an info line when the logger has no warning level. */
export function warn(
  context: { logger: MethodLogger },
  msg: string,
  props: Record<string, string>,
): void {
  (context.logger.warning ?? context.logger.info)(msg, props);
}

/** A stored URL or path: a string with any user and password part removed. */
export function url(v: unknown): string | null {
  const s = nonEmpty(v);
  return s === null ? null : redact(s);
}

/**
 * Free text a controller wrote, as stored: one line of at most `max`
 * characters with what is shaped like a credential blanked. Null when there
 * is none. Controllers copy error text from elsewhere into such fields.
 */
export function text(v: unknown, max = 400): string | null {
  const s = nonEmpty(v);
  return s === null ? null : brief(s, max);
}

/** One line of at most 200 characters that says why an object is unhealthy. */
export function reasonLine(parts: string[]): string {
  return brief(parts.join("; "), 200);
}

/** The inventory resource every type's `list` writes beside its records. */
export function inventoryResource<S = typeof InventorySchema>(
  kind: string,
  schema?: S,
): {
  description: string;
  schema: S;
  lifetime: "infinite";
  garbageCollection: number;
} {
  return {
    description:
      `What one list saw: every ${kind} with its data name, whether it is healthy, and one line that says why not. Named inventory_all for every namespace and inventory_ns_<namespace> for one`,
    schema: (schema ?? InventorySchema) as S,
    lifetime: "infinite" as const,
    garbageCollection: 10,
  };
}

/**
 * Write the inventory of one list under the spec `inventory` and return its
 * handle. `namespace` is the namespace listed, empty for all.
 */
export async function writeInventory<T>(
  context: CnpgContext<T>,
  kind: string,
  namespace: string,
  items: InventoryItem[],
): Promise<unknown> {
  const inventory = buildInventory(
    namespace || null,
    items,
    new Date().toISOString(),
  );
  const handle = await context.writeResource(
    "inventory",
    inventoryName(namespace || null),
    inventory,
  );
  context.logger.info(
    "Recorded {count} {kind} objects in {namespace}, {unhealthy} not healthy",
    {
      count: String(inventory.count),
      kind,
      namespace: namespace || "all namespaces",
      unhealthy: String(inventory.unhealthyCount),
    },
  );
  return handle;
}

/** The resource names, by full group, so no short name can be shadowed. */
export const RESOURCES = {
  cluster: "clusters.postgresql.cnpg.io",
  backup: "backups.postgresql.cnpg.io",
  scheduledBackup: "scheduledbackups.postgresql.cnpg.io",
  objectStore: "objectstores.barmancloud.cnpg.io",
} as const;

/** The version every type in this extension carries. */
export const VERSION = "2026.11.10.1";
