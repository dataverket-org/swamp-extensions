/**
 * The stored record of one CloudNativePG Backup, shared by the `backup` type
 * and by the `scheduledbackup` type, which stores the newest Backup a
 * schedule made inside its own record.
 *
 * A Backup's status repeats the object store's credential references
 * (`s3Credentials`, `azureCredentials`, `googleCredentials`) and the output of
 * the backup command. None of that is read: the record holds where the backup
 * went and how it ended, nothing about how the store is opened.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { redact } from "../lib/cli.ts";
import { arr, boolOrNull, nonEmpty, numOrNull, obj } from "../lib/kubectl.ts";
import { reasonLine, url } from "./_helpers.ts";

/** The label the operator puts on every Backup a ScheduledBackup makes. */
export const SCHEDULED_BACKUP_LABEL = "cnpg.io/scheduled-backup";

/** Zod schema for a stored Backup record. */
export const BackupSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  /** When the Backup object was created. */
  createdAt: z.string().nullable(),
  /** The Cluster the backup is of. */
  cluster: z.string().nullable(),
  /** barmanObjectStore, plugin or volumeSnapshot. */
  method: z.string().nullable(),
  /** primary or prefer-standby; null when the Cluster's default applies. */
  target: z.string().nullable(),
  /** Whether the backup was taken online; null when not stated. */
  online: z.boolean().nullable(),
  /** The plugin that takes the backup, when the method is plugin. */
  pluginName: z.string().nullable(),
  /** The ScheduledBackup that made this Backup, or null for an on-demand one. */
  scheduledBackup: z.string().nullable(),
  /** The operator's phase: pending, started, running, completed, failed, ... */
  phase: z.string().nullable(),
  /** The phase is completed. */
  completed: z.boolean(),
  /** The phase is failed. */
  failed: z.boolean(),
  /** The backup has ended, completed or failed; false while it still runs. */
  finished: z.boolean(),
  /** The operator's error text for a failed backup. */
  error: z.string().nullable(),
  startedAt: z.string().nullable(),
  stoppedAt: z.string().nullable(),
  beginWal: z.string().nullable(),
  endWal: z.string().nullable(),
  beginLSN: z.string().nullable(),
  endLSN: z.string().nullable(),
  /** The backup's id in the object store or snapshot system. */
  backupId: z.string().nullable(),
  /** The backup's name in the object store. */
  backupName: z.string().nullable(),
  /** Where the backup went, for example s3://bucket/path. */
  destinationPath: z.string().nullable(),
  /** The object store's endpoint, when it is not the provider's default. */
  endpointURL: z.string().nullable(),
  /** The folder name of this server inside the destination. */
  serverName: z.string().nullable(),
  /** The instance pod the backup ran on. */
  instance: z.string().nullable(),
  /** The PostgreSQL major version the backup was taken from. */
  majorVersion: z.number().nullable(),
  /** The timeline of the backup, when the status or the plugin reports it. */
  timeline: z.number().nullable(),
  /** The volume snapshots of a volumeSnapshot backup, by name. */
  snapshots: z.array(z.string()),
  /**
   * How long the Backup had existed, in seconds, when it was read without
   * having completed or failed. Null once it has ended, and when its
   * creation time is not known.
   */
  unfinishedSeconds: z.number().nullable(),
  /**
   * Set by `create` only. False: this run created the Backup and saw its
   * create confirmed. True: the Backup was found under that name with the
   * same request and taken as it was, so it may be another caller's. Null
   * in a record written by `list` or `get`.
   */
  adopted: z.boolean().nullable(),
});

/** One stored Backup record. */
export type BackupData = z.infer<typeof BackupSchema>;

/** The phases after which a Backup does not change any more. */
export const FINAL_PHASES = ["completed", "failed"];

function timelineOf(status: Record<string, unknown>): number | null {
  const meta = obj(status.pluginMetadata);
  const fromPlugin = Number.parseInt(String(meta.timeline ?? ""), 10);
  if (Number.isFinite(fromPlugin)) return fromPlugin;
  // A WAL file name starts with the timeline as eight hex digits.
  const wal = nonEmpty(status.beginWal);
  if (wal && /^[0-9A-Fa-f]{24}/.test(wal)) {
    return Number.parseInt(wal.slice(0, 8), 16);
  }
  return null;
}

/** The ScheduledBackup a Backup came from: the label, then the owner reference. */
export function scheduledBackupOf(
  item: Record<string, unknown>,
): string | null {
  const meta = obj(item.metadata);
  const label = nonEmpty(obj(meta.labels)[SCHEDULED_BACKUP_LABEL]);
  if (label) return label;
  for (const ref of arr(meta.ownerReferences)) {
    const r = obj(ref);
    if (r.kind === "ScheduledBackup" && nonEmpty(r.name)) {
      return nonEmpty(r.name);
    }
  }
  return null;
}

/**
 * Reduce a Backup object as kubectl prints it to the stored record. `now` is
 * the time of the read in milliseconds, for the age of an unfinished Backup.
 */
export function parseBackup(
  item: Record<string, unknown>,
  now: number = Date.now(),
): BackupData {
  const meta = obj(item.metadata);
  const spec = obj(item.spec);
  const status = obj(item.status);
  const phase = nonEmpty(status.phase);
  const error = nonEmpty(status.error);
  const createdAt = nonEmpty(meta.creationTimestamp);
  const finished = phase !== null && FINAL_PHASES.includes(phase);
  const created = createdAt === null ? NaN : Date.parse(createdAt);
  return {
    name: nonEmpty(meta.name) ?? "",
    namespace: nonEmpty(meta.namespace) ?? "",
    createdAt,
    cluster: nonEmpty(obj(spec.cluster).name),
    method: nonEmpty(status.method) ?? nonEmpty(spec.method),
    target: nonEmpty(spec.target),
    online: boolOrNull(status.online) ?? boolOrNull(spec.online),
    pluginName: nonEmpty(obj(spec.pluginConfiguration).name),
    scheduledBackup: scheduledBackupOf(item),
    phase,
    completed: phase === "completed",
    failed: phase === "failed",
    finished,
    error: error === null ? null : redact(error).slice(0, 2000),
    startedAt: nonEmpty(status.startedAt),
    stoppedAt: nonEmpty(status.stoppedAt),
    beginWal: nonEmpty(status.beginWal),
    endWal: nonEmpty(status.endWal),
    beginLSN: nonEmpty(status.beginLSN),
    endLSN: nonEmpty(status.endLSN),
    backupId: nonEmpty(status.backupId),
    backupName: nonEmpty(status.backupName),
    destinationPath: url(status.destinationPath),
    endpointURL: url(status.endpointURL),
    serverName: nonEmpty(status.serverName),
    instance: nonEmpty(obj(status.instanceID).podName),
    majorVersion: numOrNull(status.majorVersion),
    timeline: timelineOf(status),
    snapshots: arr(obj(status.snapshotBackupStatus).elements)
      .map((e) => nonEmpty(obj(e).name))
      .filter((n): n is string => n !== null),
    unfinishedSeconds: finished || Number.isNaN(created)
      ? null
      : Math.max(0, Math.round((now - created) / 1000)),
    adopted: null,
  };
}

/**
 * What to say of a Backup that has not ended for longer than
 * `afterSeconds`, or null when it has ended or is younger than that.
 */
export function overdue(b: BackupData, afterSeconds: number): string | null {
  if (b.unfinishedSeconds === null || b.unfinishedSeconds <= afterSeconds) {
    return null;
  }
  return `${
    b.phase === null ? "without a phase" : `still ${b.phase}`
  } after ${b.unfinishedSeconds} s, longer than ${afterSeconds} s`;
}

/**
 * Why a Backup counts as not healthy in an inventory, or null: it failed, or
 * it has not ended for longer than `afterSeconds`.
 */
export function backupReason(
  b: BackupData,
  afterSeconds: number,
): string | null {
  if (b.failed) {
    return reasonLine([
      `failed: ${b.error ?? "the operator gave no error text"}`,
    ]);
  }
  const late = overdue(b, afterSeconds);
  return late === null ? null : reasonLine([late]);
}

/**
 * The newest Backup: by creation time, the name deciding between two made in
 * the same second. Null for an empty list.
 */
export function newest(backups: BackupData[]): BackupData | null {
  let best: BackupData | null = null;
  for (const b of backups) {
    if (best === null) {
      best = b;
      continue;
    }
    const a = b.createdAt ?? "";
    const z = best.createdAt ?? "";
    if (a > z || (a === z && b.name > best.name)) best = b;
  }
  return best;
}
