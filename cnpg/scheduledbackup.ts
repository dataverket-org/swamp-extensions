/**
 * `@dataverket/cnpg/scheduledbackup`: CloudNativePG ScheduledBackup objects
 * (`postgresql.cnpg.io/v1`), read with kubectl. `list` records every
 * ScheduledBackup and `get` one: the schedule, whether it is suspended, the
 * last and next schedule times, and the newest Backup the schedule made with
 * its result, so "did last night's backup work" is one record.
 *
 * Read-only. A schedule whose newest Backup failed, or that has made none, is
 * a record that says so; only a call that could not be made is an error.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { redact } from "../lib/cli.ts";
import {
  assertDistinctDataNames,
  boolOrNull,
  checkName,
  dataName,
  expectObject,
  getArgs,
  type InventoryItem,
  kubectlCliCheck,
  kubectlOpts,
  listArgs,
  listItems,
  listNamespace,
  nonEmpty,
  obj,
  readMeta,
  requireNamespace,
  runKubectl,
} from "../lib/kubectl.ts";
import {
  BackupGlobalArgsSchema,
  type CnpgContext,
  DEFAULT_UNFINISHED_AFTER_SECONDS,
  inventoryResource,
  reasonLine,
  RESOURCES,
  writeInventory,
} from "./_helpers.ts";
import {
  BackupSchema,
  newest,
  overdue,
  parseBackup,
  scheduledBackupOf,
} from "./_backup_record.ts";

/** Zod schema for a stored ScheduledBackup record. */
export const ScheduledBackupSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  /** The Cluster the schedule backs up. */
  cluster: z.string().nullable(),
  /** The schedule, six fields with seconds first, as the operator reads it. */
  schedule: z.string().nullable(),
  suspend: z.boolean(),
  /** A first Backup is made as soon as the schedule is created. */
  immediate: z.boolean(),
  /** none, self or cluster: who owns the Backups the schedule makes. */
  backupOwnerReference: z.string().nullable(),
  /** barmanObjectStore, plugin or volumeSnapshot. */
  method: z.string().nullable(),
  target: z.string().nullable(),
  online: z.boolean().nullable(),
  /** The plugin that takes the backups, when the method is plugin. */
  pluginName: z.string().nullable(),
  lastScheduleTime: z.string().nullable(),
  nextScheduleTime: z.string().nullable(),
  lastCheckTime: z.string().nullable(),
  /** The schedule's own error, for example a schedule that cannot be parsed. */
  error: z.string().nullable(),
  /** How many Backups made by this schedule still exist. */
  backupCount: z.number(),
  /** The newest Backup this schedule made, or null when none exists. */
  lastBackup: BackupSchema.nullable(),
  /** The newest Backup's phase, or null when none exists. */
  lastBackupPhase: z.string().nullable(),
  /** The newest Backup completed. False when it failed, still runs, or none exists. */
  lastBackupCompleted: z.boolean(),
  /**
   * How long the newest Backup had existed without ending when it was read,
   * in seconds. Null when it has ended or none exists.
   */
  lastBackupUnfinishedSeconds: z.number().nullable(),
});

/** One stored ScheduledBackup record. */
export type ScheduledBackupData = z.infer<typeof ScheduledBackupSchema>;

/**
 * Reduce a ScheduledBackup object as kubectl prints it to the stored record.
 * `backups` are the Backup objects of the same scope; the ones this schedule
 * made are picked out by the operator's label or the owner reference.
 */
export function parseScheduledBackup(
  item: Record<string, unknown>,
  backups: Record<string, unknown>[],
  now: number = Date.now(),
): ScheduledBackupData {
  const meta = obj(item.metadata);
  const spec = obj(item.spec);
  const status = obj(item.status);
  const name = nonEmpty(meta.name) ?? "";
  const namespace = nonEmpty(meta.namespace) ?? "";
  const error = nonEmpty(status.error);

  const mine = backups
    .map(obj)
    .filter((b) =>
      nonEmpty(obj(b.metadata).namespace) === namespace &&
      scheduledBackupOf(b) === name
    )
    .map((b) => parseBackup(b, now));
  const last = newest(mine);

  return {
    name,
    namespace,
    cluster: nonEmpty(obj(spec.cluster).name),
    schedule: nonEmpty(spec.schedule),
    suspend: spec.suspend === true,
    immediate: spec.immediate === true,
    backupOwnerReference: nonEmpty(spec.backupOwnerReference),
    method: nonEmpty(spec.method),
    target: nonEmpty(spec.target),
    online: boolOrNull(spec.online),
    pluginName: nonEmpty(obj(spec.pluginConfiguration).name),
    lastScheduleTime: nonEmpty(status.lastScheduleTime),
    nextScheduleTime: nonEmpty(status.nextScheduleTime),
    lastCheckTime: nonEmpty(status.lastCheckTime),
    error: error === null ? null : redact(error).slice(0, 2000),
    backupCount: mine.length,
    lastBackup: last,
    lastBackupPhase: last?.phase ?? null,
    lastBackupCompleted: last?.completed ?? false,
    lastBackupUnfinishedSeconds: last?.unfinishedSeconds ?? null,
  };
}

/**
 * Why a ScheduledBackup is not healthy, as one line for the inventory, or
 * null when it is: it is suspended, the operator reports an error on the
 * schedule itself, the newest Backup it made failed, or that Backup has not
 * ended for longer than `afterSeconds`. A schedule that has made no Backup
 * yet is not named.
 */
export function scheduleReason(
  s: ScheduledBackupData,
  afterSeconds: number,
): string | null {
  const parts: string[] = [];
  const late = s.lastBackup === null
    ? null
    : overdue(s.lastBackup, afterSeconds);
  if (late !== null) {
    parts.push(`newest Backup ${s.lastBackup!.name} is ${late}`);
  }
  if (s.suspend) parts.push("suspended");
  if (s.error !== null) parts.push(`schedule error: ${s.error}`);
  if (s.lastBackup?.failed) {
    parts.push(
      `newest Backup ${s.lastBackup.name} failed: ${
        s.lastBackup.error ?? "the operator gave no error text"
      }`,
    );
  }
  return parts.length === 0 ? null : reasonLine(parts);
}

type Ctx = CnpgContext<ScheduledBackupData>;

/** Swamp model for CloudNativePG ScheduledBackup objects. */
export const model = {
  type: "@dataverket/cnpg/scheduledbackup",
  version: "2026.11.12.1",
  globalArguments: BackupGlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.12.1",
      description:
        "unit tests in the swamp skill's pattern; the bundled lib/ adds a 64 MiB output limit per command (a larger output is refused as too-large); global arguments unchanged",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  checks: {
    "kubectl-cli-available": kubectlCliCheck,
  },
  resources: {
    scheduledbackup: {
      description:
        "CloudNativePG ScheduledBackup: schedule, suspension, last and next schedule time, and the newest Backup it made with its result",
      schema: ScheduledBackupSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    inventory: inventoryResource("ScheduledBackup"),
  },
  methods: {
    /** List ScheduledBackups across all namespaces (or one namespace). */
    list: {
      description:
        "List CloudNativePG ScheduledBackups, each with the newest Backup it made and its result, and record an inventory of the list that names each schedule that is suspended or failing and why",
      arguments: z.object({
        namespace: z.string().optional().describe(
          "The namespace to list instead of the definition's. Left out or empty: the definition's namespace, and every namespace when that is empty too.",
        ),
      }),
      execute: async (
        args: { namespace?: string },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = listNamespace(args.namespace, context.globalArgs.namespace);
        context.logger.info("Listing ScheduledBackups in {namespace}", {
          namespace: ns || "all namespaces",
        });

        const opts = kubectlOpts(context);
        const schedules = listItems(
          await runKubectl(listArgs(RESOURCES.scheduledBackup, ns), opts),
          `kubectl get ${RESOURCES.scheduledBackup}`,
          "ScheduledBackup",
        );
        // Nothing is written when one item has no name or two share a data name.
        assertDistinctDataNames(
          "ScheduledBackup",
          schedules.map((s) => readMeta(s, true, "ScheduledBackup")),
        );
        // The Backups are read only when there is a schedule to match them to.
        const backups = schedules.length === 0 ? [] : listItems(
          await runKubectl(listArgs(RESOURCES.backup, ns), opts),
          `kubectl get ${RESOURCES.backup}`,
          "Backup",
        );

        const handles: unknown[] = [];
        const lines: InventoryItem[] = [];
        for (const item of schedules) {
          const parsed = parseScheduledBackup(item, backups);
          const stored = dataName(parsed.namespace, parsed.name);
          handles.push(
            await context.writeResource("scheduledbackup", stored, parsed),
          );
          const reason = scheduleReason(
            parsed,
            context.globalArgs.unfinishedAfterSeconds ??
              DEFAULT_UNFINISHED_AFTER_SECONDS,
          );
          lines.push({
            namespace: parsed.namespace,
            name: parsed.name,
            dataName: stored,
            healthy: reason === null,
            reason,
          });
        }
        handles.push(
          await writeInventory(context, "ScheduledBackup", ns, lines),
        );
        return { dataHandles: handles };
      },
    },

    /** Read one ScheduledBackup and the newest Backup it made. */
    get: {
      description:
        "Read one CloudNativePG ScheduledBackup and the newest Backup it made, with its result",
      arguments: z.object({
        name: z.string().min(1).describe("ScheduledBackup name."),
        namespace: z.string().optional().describe(
          "Namespace of the ScheduledBackup. Left out or empty: the definition's namespace.",
        ),
      }),
      execute: async (
        args: { name: string; namespace?: string },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = requireNamespace(
          "get",
          args.namespace,
          context.globalArgs.namespace,
        );
        const name = checkName(args.name, "ScheduledBackup name");
        context.logger.info("Reading ScheduledBackup {name} in {namespace}", {
          name,
          namespace: ns,
        });

        const opts = kubectlOpts(context);
        const item = expectObject(
          await runKubectl(getArgs(RESOURCES.scheduledBackup, name, ns), opts),
          { kind: "ScheduledBackup", name, namespace: ns },
        );
        const backups = listItems(
          await runKubectl(listArgs(RESOURCES.backup, ns), opts),
          `kubectl get ${RESOURCES.backup}`,
          "Backup",
        );

        const parsed = parseScheduledBackup(item, backups);
        const handle = await context.writeResource(
          "scheduledbackup",
          dataName(ns, name),
          parsed,
        );
        context.logger.info(
          "ScheduledBackup {name}: {count} Backups, newest {backup} is {phase}",
          {
            name,
            count: String(parsed.backupCount),
            backup: parsed.lastBackup?.name ?? "none",
            phase: parsed.lastBackupPhase ?? "none",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
