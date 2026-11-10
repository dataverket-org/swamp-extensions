/**
 * `@dataverket/cnpg/backup`: CloudNativePG Backup objects
 * (`postgresql.cnpg.io/v1`), read and created with kubectl. `list` records
 * every Backup and `get` one: phase, method, start and stop time, the WAL
 * and LSN range, the id and destination, the instance it ran on and the
 * error of a failed one. `create` makes an on-demand Backup of a named
 * Cluster after checking that the Cluster exists and is configured for the
 * method, waits a short while, and records where the Backup stands.
 *
 * A Backup that failed is a record with `failed: true` and the operator's
 * error, never a failed method. Only a create that was refused or not
 * applied is an error: when the create's answer cannot be read, when kubectl
 * was stopped at its limit, and when a Backup of that name appeared in the
 * meantime, the Backup is read back once by name, and it counts as created
 * when it is there with this request.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { brief, pollBudget } from "../lib/cli.ts";
import {
  assertDistinctDataNames,
  checkName,
  dataName,
  expectObject,
  getArgs,
  InventoryItemSchema,
  InventorySchema,
  isCancelled,
  isKubectlError,
  KUBECTL_CALL_LIMIT_MS,
  kubectlCliCheck,
  type KubectlOpts,
  kubectlOpts,
  listArgs,
  listItems,
  listNamespace,
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
  RESOURCES,
  warn,
  writeInventory,
} from "./_helpers.ts";
import {
  type BackupData,
  backupReason,
  BackupSchema,
  parseBackup,
} from "./_backup_record.ts";
import { parseCluster } from "./cluster.ts";

/** The method a Backup uses when it names none; the CRD's own default. */
const DEFAULT_METHOD = "barmanObjectStore";

/** The longest wait `create` accepts, in seconds. */
export const MAX_WAIT_SECONDS = 120;

/**
 * The longest `create` runs, from its first call to the end of its last
 * read. The wait is shortened when the calls before it were slow, so that
 * the whole method ends inside this limit whatever the cluster does.
 */
export const CREATE_LIMIT_MS = 170_000;

/** One Backup in the inventory of a list. */
export const BackupInventoryItemSchema = InventoryItemSchema.extend({
  phase: z.string().nullable().describe(
    "The operator's phase. A Backup that still runs counts as healthy until it is older than the definition's unfinishedAfterSeconds",
  ),
});

/** The inventory a Backup list writes. */
export const BackupInventorySchema = InventorySchema.extend({
  items: z.array(BackupInventoryItemSchema),
});

/** The arguments of `create`: the fields of a Backup's spec, and the wait. */
export const CreateArgsSchema = z.object({
  name: z.string().min(1).describe(
    "Name of the Backup object. Running create again with the same name and request changes nothing.",
  ),
  namespace: z.string().optional().describe(
    "Namespace of the Cluster and the Backup. Left out or empty: the definition's namespace.",
  ),
  cluster: z.string().min(1).describe(
    "The Cluster to back up.",
  ),
  /** How the backup is taken. The Cluster must be configured for it. */
  method: z.enum(["barmanObjectStore", "plugin", "volumeSnapshot"])
    .default(DEFAULT_METHOD),
  target: z.enum(["primary", "prefer-standby"]).optional().describe(
    "Where the backup runs. Unset means the Cluster's own default.",
  ),
  online: z.boolean().optional().describe(
    "Take the backup online (volumeSnapshot). Unset means the Cluster's default.",
  ),
  /** Options of an online backup. */
  onlineConfiguration: z.object({
    immediateCheckpoint: z.boolean().optional(),
    waitForArchive: z.boolean().optional(),
  }).optional(),
  /** The plugin that takes the backup; required when method is plugin. */
  pluginConfiguration: z.object({
    name: z.string().min(1).describe(
      "The plugin's name as the Cluster lists it.",
    ),
    parameters: z.record(z.string(), z.string()).optional().describe(
      "Parameters for the plugin. Never a secret: they are stored in the Backup object, and swamp keeps the arguments of a run.",
    ),
  }).optional(),
  waitSeconds: z.number().int().min(0).max(MAX_WAIT_SECONDS).default(60)
    .describe(
      "How long to wait for the Backup to end before recording it as it stands. The time the reads take counts, and the wait is cut short when the calls before it were slow: the method never runs longer than 170 seconds.",
    ),
  pollSeconds: z.number().int().min(1).max(30).default(5).describe(
    "How long to wait between two reads of the Backup.",
  ),
});

/** The arguments of `create` as the method receives them. */
export type CreateArgs = z.infer<typeof CreateArgsSchema>;

/** The spec of the Backup a create request asks for. */
export function desiredSpec(args: CreateArgs): Record<string, unknown> {
  const spec: Record<string, unknown> = {
    cluster: { name: args.cluster },
    method: args.method ?? DEFAULT_METHOD,
  };
  if (args.target !== undefined) spec.target = args.target;
  if (args.online !== undefined) spec.online = args.online;
  if (args.onlineConfiguration !== undefined) {
    spec.onlineConfiguration = args.onlineConfiguration;
  }
  if (args.pluginConfiguration !== undefined) {
    spec.pluginConfiguration = args.pluginConfiguration;
  }
  return spec;
}

/**
 * The shortest parameter value that is blanked word for word in an error of
 * the create call. A shorter value (`on`, `true`, a name) is no credential,
 * and blanking it would blank the same letters all over the message.
 */
export const OPAQUE_MIN_LENGTH = 8;

function canonical(v: unknown): string {
  if (Array.isArray(v)) return `[${v.map(canonical).join(",")}]`;
  if (v !== null && typeof v === "object") {
    const o = v as Record<string, unknown>;
    return `{${
      Object.keys(o).filter((k) => o[k] !== undefined).sort()
        .map((k) => `${JSON.stringify(k)}:${canonical(o[k])}`).join(",")
    }}`;
  }
  return JSON.stringify(v);
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * Whether `have` lacks something `want` asks for. An object is compared
 * field by field, at any depth, and only in the fields `want` sets: the API
 * server fills in defaults beside them (`onlineConfiguration.waitForArchive`
 * beside `immediateCheckpoint`). Anything else, a list included, must be
 * equal as a whole.
 */
function lacks(have: unknown, want: unknown): boolean {
  if (!isRecord(want)) return canonical(have) !== canonical(want);
  if (!isRecord(have)) return true;
  return Object.keys(want).some((k) =>
    want[k] !== undefined && lacks(have[k], want[k])
  );
}

/** The parameters of a plugin configuration; none is the same as empty. */
function parametersOf(spec: Record<string, unknown>): string {
  const config = spec.pluginConfiguration;
  const parameters = isRecord(config) ? config.parameters : undefined;
  return canonical(isRecord(parameters) ? parameters : {});
}

/**
 * The top-level fields in which an existing Backup differs from a request.
 * Every field the request sets, at any depth, must be equal in the existing
 * object; a field the request leaves out is the API server's to default and
 * is not compared. The plugin parameters are the exception: nothing defaults
 * that map and every entry changes what the plugin does, so it is compared
 * as a whole, also when the request has none.
 */
export function specDifferences(
  existing: Record<string, unknown>,
  desired: Record<string, unknown>,
): string[] {
  const have: Record<string, unknown> = {
    ...existing,
    method: existing.method ?? DEFAULT_METHOD,
  };
  // The parameters are left out of the field-by-field comparison: they are
  // compared as a whole map below.
  const wanted = (k: string): unknown => {
    const v = desired[k];
    if (k !== "pluginConfiguration" || !isRecord(v)) return v;
    return Object.fromEntries(
      Object.entries(v).filter(([name]) => name !== "parameters"),
    );
  };
  const differs = new Set(
    Object.keys(desired)
      .filter((k) => desired[k] !== undefined && lacks(have[k], wanted(k))),
  );
  if (parametersOf(existing) !== parametersOf(desired)) {
    differs.add("pluginConfiguration");
  }
  return [...differs].sort();
}

/**
 * Why a Cluster cannot take a Backup with this request, or null when it can.
 * The Cluster is the object as kubectl prints it.
 */
export function refusal(
  cluster: Record<string, unknown>,
  args: CreateArgs,
): string | null {
  const method = args.method ?? DEFAULT_METHOD;
  const config = parseCluster(cluster).backup;
  if (method !== "plugin" && args.pluginConfiguration !== undefined) {
    return `pluginConfiguration is only for method plugin, not ${method}`;
  }
  if (method === "barmanObjectStore") {
    return config.barmanObjectStore === null
      ? "the Cluster has no spec.backup.barmanObjectStore"
      : null;
  }
  if (method === "volumeSnapshot") {
    return config.volumeSnapshot === null
      ? "the Cluster has no spec.backup.volumeSnapshot"
      : null;
  }
  if (args.pluginConfiguration === undefined) {
    return "method plugin needs pluginConfiguration.name";
  }
  const wanted = args.pluginConfiguration.name;
  const plugin = config.plugins.find((p) => p.name === wanted);
  if (!plugin) {
    return `the Cluster does not list the plugin ${
      JSON.stringify(brief(wanted, 80))
    } in spec.plugins`;
  }
  if (!plugin.enabled) {
    return `the Cluster has the plugin ${
      JSON.stringify(brief(wanted, 80))
    } disabled`;
  }
  return null;
}

type Ctx = CnpgContext<BackupData>;

/**
 * One object by name, or null when the API server says there is none. An
 * answer that is not that object is an error, like any other failed call.
 */
async function getOrNull(
  resource: string,
  kind: string,
  name: string,
  ns: string,
  opts: KubectlOpts,
): Promise<Record<string, unknown> | null> {
  try {
    return expectObject(
      await runKubectl(getArgs(resource, name, ns), opts),
      { kind, name, namespace: ns },
    );
  } catch (err) {
    if (isKubectlError(err, "not-found")) return null;
    throw err;
  }
}

/** Swamp model for CloudNativePG Backup objects. */
export const model = {
  type: "@dataverket/cnpg/backup",
  version: "2026.11.10.1",
  globalArguments: BackupGlobalArgsSchema,
  checks: {
    "kubectl-cli-available": kubectlCliCheck,
  },
  resources: {
    backup: {
      description:
        "CloudNativePG Backup: phase, method, start and stop time, WAL and LSN range, id, destination, the instance it ran on and the error of a failed one",
      schema: BackupSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    inventory: inventoryResource("Backup", BackupInventorySchema),
  },
  methods: {
    /** List Backups across all namespaces (or one namespace). */
    list: {
      description:
        "List CloudNativePG Backups with phase, method, times, WAL range and destination, and record an inventory of the list that names each Backup that failed, or has not ended for too long, and why",
      arguments: z.object({
        namespace: z.string().optional().describe(
          "The namespace to list instead of the definition's. Left out or empty: the definition's namespace, and every namespace when that is empty too.",
        ),
        cluster: z.string().optional().describe(
          "Only the Backups of this Cluster. No inventory is recorded then: the inventory says what a whole list saw.",
        ),
      }),
      execute: async (
        args: { namespace?: string; cluster?: string },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = listNamespace(args.namespace, context.globalArgs.namespace);
        const cluster = args.cluster === undefined
          ? undefined
          : checkName(args.cluster, "cluster name");
        context.logger.info("Listing Backups in {namespace}", {
          namespace: ns || "all namespaces",
        });

        const backups = listItems(
          await runKubectl(
            listArgs(RESOURCES.backup, ns),
            kubectlOpts(context),
          ),
          `kubectl get ${RESOURCES.backup}`,
          "Backup",
        );
        // Nothing is written when one item has no name or two share a data name.
        assertDistinctDataNames(
          "Backup",
          backups.map((b) => readMeta(b, true, "Backup")),
        );

        const after = context.globalArgs.unfinishedAfterSeconds ??
          DEFAULT_UNFINISHED_AFTER_SECONDS;
        const handles: unknown[] = [];
        const lines: z.infer<typeof BackupInventoryItemSchema>[] = [];
        for (const item of backups) {
          const parsed = parseBackup(item);
          if (cluster !== undefined && parsed.cluster !== cluster) continue;
          const stored = dataName(parsed.namespace, parsed.name);
          handles.push(await context.writeResource("backup", stored, parsed));
          lines.push({
            namespace: parsed.namespace,
            name: parsed.name,
            dataName: stored,
            healthy: backupReason(parsed, after) === null,
            reason: backupReason(parsed, after),
            phase: parsed.phase,
          });
        }
        if (cluster === undefined) {
          handles.push(await writeInventory(context, "Backup", ns, lines));
        } else {
          context.logger.info(
            "Recorded {count} Backups of Cluster {cluster}; no inventory for a list of one Cluster",
            { count: String(handles.length), cluster },
          );
        }
        return { dataHandles: handles };
      },
    },

    /** Read one Backup. */
    get: {
      description:
        "Read one CloudNativePG Backup: phase, times, WAL range, destination and error",
      arguments: z.object({
        name: z.string().min(1).describe(
          "Backup name.",
        ),
        namespace: z.string().optional().describe(
          "Namespace of the Backup. Left out or empty: the definition's namespace.",
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
        const name = checkName(args.name, "backup name");
        context.logger.info("Reading Backup {name} in {namespace}", {
          name,
          namespace: ns,
        });
        const parsed = parseBackup(expectObject(
          await runKubectl(
            getArgs(RESOURCES.backup, name, ns),
            kubectlOpts(context),
          ),
          { kind: "Backup", name, namespace: ns },
        ));
        const handle = await context.writeResource(
          "backup",
          dataName(ns, name),
          parsed,
        );
        context.logger.info("Backup {name} is {phase}", {
          name,
          phase: parsed.phase ?? "without a phase yet",
        });
        return { dataHandles: [handle] };
      },
    },

    /** Create an on-demand Backup of a Cluster and record where it stands. */
    create: {
      description:
        "Create an on-demand Backup of a CloudNativePG Cluster after checking the Cluster is configured for the method; waits a bounded time and records the Backup as it stands. The method ends within 170 seconds. Run get for the result of a long backup",
      kind: "action" as const,
      arguments: CreateArgsSchema,
      execute: async (
        args: CreateArgs,
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const whole = pollBudget(CREATE_LIMIT_MS);
        const ns = requireNamespace(
          "create",
          args.namespace,
          context.globalArgs.namespace,
        );
        const name = checkName(args.name, "backup name");
        const clusterName = checkName(args.cluster, "cluster name");
        const opts = kubectlOpts(context);
        const spec = desiredSpec(args);
        context.logger.info(
          "Creating Backup {name} of Cluster {cluster} in {namespace} with method {method}",
          {
            name,
            cluster: clusterName,
            namespace: ns,
            method: String(spec.method),
          },
        );

        // Verify first: the Cluster exists and can take this kind of backup.
        const cluster = await getOrNull(
          RESOURCES.cluster,
          "Cluster",
          clusterName,
          ns,
          opts,
        );
        if (cluster === null) {
          throw new Error(
            `Backup ${name} was not created: there is no Cluster ${clusterName} in namespace ${ns}`,
          );
        }
        const why = refusal(cluster, args);
        if (why !== null) {
          throw new Error(
            `Backup ${name} was not created: ${why} (Cluster ${clusterName} in namespace ${ns})`,
          );
        }

        // A Backup of this name that asks for the same thing is this request.
        const want = { kind: "Backup", name, namespace: ns };
        const read = () =>
          getOrNull(RESOURCES.backup, "Backup", name, ns, opts);
        const sameRequest = (found: Record<string, unknown>): void => {
          const differs = specDifferences(obj(found.spec), spec);
          if (differs.length > 0) {
            throw new Error(
              `Backup ${name} already exists in namespace ${ns} with a different request (${
                differs.join(", ")
              }); nothing was changed. Choose another name`,
            );
          }
        };
        let item = await read();
        // Whether the Backup is one this run found, not one it saw itself make.
        let adopted = false;
        if (item !== null) {
          sameRequest(item);
          adopted = true;
          context.logger.info(
            "Backup {name} already exists with the same request; nothing created",
            { name },
          );
        } else {
          // The create may have been applied although it was not confirmed:
          // an answer that cannot be read or is not the Backup, a kubectl
          // stopped at its limit, a Backup of this name made by another run,
          // or a failure kubectl gives no name to. A refusal that has a name
          // (forbidden, no such resource type, bad login) is thrown at once.
          let unconfirmed: unknown = null;
          try {
            item = expectObject(
              await runKubectl(["create", "-f", "-", "-n", ns], {
                ...opts,
                stdin: JSON.stringify({
                  apiVersion: "postgresql.cnpg.io/v1",
                  kind: "Backup",
                  metadata: { name, namespace: ns },
                  spec,
                }),
                secrets: Object.values(
                  args.pluginConfiguration?.parameters ?? {},
                ).filter((v) => v.length >= OPAQUE_MIN_LENGTH),
              }),
              want,
            );
            context.logger.info("Backup {name} created", { name });
          } catch (err) {
            if (
              !isKubectlError(err, "not-json", "timeout", "conflict", "other")
            ) {
              throw err;
            }
            unconfirmed = err;
          }
          if (unconfirmed !== null) {
            // Read it back once by name: the Backup decides, not the answer.
            const why = brief(
              unconfirmed instanceof Error
                ? unconfirmed.message
                : String(unconfirmed),
              200,
            );
            try {
              item = await read();
            } catch (err) {
              if (isCancelled(err)) throw err;
              throw new Error(
                `Backup ${name}: the create was not confirmed (${why}) and the Backup could not be read back (${
                  brief(err instanceof Error ? err.message : String(err), 200)
                }); run get to see whether it exists`,
              );
            }
            if (item === null) throw unconfirmed;
            sameRequest(item);
            adopted = true;
            warn(
              context,
              "The create of Backup {name} was not confirmed ({why}); the Backup exists with this request and is taken as created",
              { name, why },
            );
          }
        }

        // The Backup exists from here on: nothing below fails the method but
        // a cancelled run, which must end and not be read as a slow cluster.
        const record = (found: Record<string, unknown>): BackupData => ({
          ...parseBackup(found),
          adopted,
        });
        let parsed = record(item!);
        const wait = args.waitSeconds ?? 60;
        const poll = args.pollSeconds ?? 5;
        // The time the reads take counts as waited. One call's worth of the
        // method's limit is kept back, for the read that follows the last
        // wait; what the calls above used is gone already.
        const budget = pollBudget(
          Math.max(
            0,
            Math.min(wait * 1000, whole.leftMs() - KUBECTL_CALL_LIMIT_MS),
          ),
        );
        while (
          !parsed.finished && await budget.wait(poll * 1000, context.signal)
        ) {
          try {
            parsed = record(expectObject(
              await runKubectl(getArgs(RESOURCES.backup, name, ns), opts),
              want,
            ));
          } catch (err) {
            if (isCancelled(err)) throw err;
            warn(
              context,
              "Backup {name} could not be read while waiting: {error}",
              {
                name,
                error: brief(
                  err instanceof Error ? err.message : String(err),
                  200,
                ),
              },
            );
            break;
          }
        }

        const handle = await context.writeResource(
          "backup",
          dataName(ns, name),
          parsed,
        );
        if (parsed.failed) {
          warn(context, "Backup {name} failed: {error}", {
            name,
            error: brief(parsed.error ?? "no error text", 300),
          });
        } else if (parsed.finished) {
          context.logger.info("Backup {name} completed", { name });
        } else {
          context.logger.info(
            "Backup {name} is {phase} after {wait} s; run get for the result",
            {
              name,
              phase: parsed.phase ?? "without a phase yet",
              wait: String(Math.round(budget.usedMs() / 1000)),
            },
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
