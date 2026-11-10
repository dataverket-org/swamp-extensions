/**
 * `@dataverket/cnpg/cluster`: CloudNativePG Cluster objects
 * (`postgresql.cnpg.io/v1`), read with kubectl. `list` records every Cluster
 * and `get` one: phase, instances wanted and ready, the current and the
 * target primary, each instance's state, image and PostgreSQL version,
 * storage, conditions, the state of WAL archiving and backups, the backup
 * configuration by reference, and a summary a workflow can assert on.
 *
 * Read-only. A Cluster that is unhealthy, failing over or not archiving is a
 * record that says so; only a call that could not be made is an error.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { brief } from "../lib/cli.ts";
import {
  annotation,
  arr,
  assertDistinctDataNames,
  boolOrNull,
  checkName,
  ConditionSchema,
  conditionTrue,
  dataName,
  expectObject,
  findCondition,
  getArgs,
  InventoryItemSchema,
  InventorySchema,
  isCancelled,
  isKubectlError,
  kubectlCliCheck,
  KubectlGlobalArgsSchema,
  kubectlOpts,
  listArgs,
  listItems,
  listNamespace,
  nonEmpty,
  numOrNull,
  obj,
  readConditions,
  readMeta,
  requireNamespace,
  runKubectl,
  strings,
} from "../lib/kubectl.ts";
import {
  type CnpgContext,
  inventoryResource,
  reasonLine,
  RESOURCES,
  text,
  url,
  warn,
  writeInventory,
} from "./_helpers.ts";

/** The phase text the operator sets on a Cluster with nothing to do. */
export const HEALTHY_PHASE = "Cluster in healthy state";

/** The annotation that fences instances: a JSON list of names, or `["*"]`. */
export const FENCED_ANNOTATION = "cnpg.io/fencedInstances";

/** The annotation that hibernates a Cluster when its value is `on`. */
export const HIBERNATION_ANNOTATION = "cnpg.io/hibernation";

/** The plugin parameter that names a Barman Cloud ObjectStore. */
const OBJECT_STORE_PARAMETER = "barmanObjectName";

const InstanceSchema = z.object({
  name: z.string(),
  /** healthy, replicating, failed, ...: the group the operator put the pod in. */
  status: z.string().nullable(),
  isPrimary: z.boolean().nullable(),
  timelineId: z.number().nullable(),
});

const PluginSchema = z.object({
  name: z.string(),
  /** False only when the Cluster disables the plugin. */
  enabled: z.boolean(),
  isWALArchiver: z.boolean(),
  /** The Barman Cloud ObjectStore the plugin is pointed at, when it is. */
  barmanObjectName: z.string().nullable(),
  /** The server folder the plugin writes under, when set. */
  serverName: z.string().nullable(),
  /** The names of every parameter given to the plugin; values are not stored. */
  parameterNames: z.array(z.string()),
  /** The plugin version the operator last talked to. */
  version: z.string().nullable(),
  /** The plugin's status text as the operator reports it; empty means fine. */
  status: z.string().nullable(),
});

const ObjectStoreSchema = z.object({
  name: z.string(),
  /** Whether the ObjectStore object could be read. */
  found: z.boolean(),
  /** Why it could not be read, when it could not. */
  error: z.string().nullable(),
  destinationPath: z.string().nullable(),
  endpointURL: z.string().nullable(),
  retentionPolicy: z.string().nullable(),
  /** The server folder whose recovery window was read. */
  serverName: z.string().nullable(),
});

/** Zod schema for a stored Cluster record. */
export const ClusterSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  phase: z.string().nullable(),
  phaseReason: z.string().nullable(),
  /**
   * Instances are fenced: the annotation `cnpg.io/fencedInstances` names at
   * least one. PostgreSQL is stopped on a fenced instance while its pod runs.
   */
  fenced: z.boolean(),
  /** The fenced instances by name; `*` means every instance. */
  fencedInstances: z.array(z.string()),
  /**
   * The Cluster is hibernated on purpose: the annotation
   * `cnpg.io/hibernation` is `on`. Its pods are gone and its volumes kept.
   */
  hibernated: z.boolean(),
  /**
   * The operator has acted on the hibernation: the annotation is `on` and
   * the condition `cnpg.io/hibernation` is True. False while the pods are
   * still stopping and when the operator has not seen the annotation.
   */
  hibernationReached: z.boolean(),
  /** Instances wanted (`spec.instances`). */
  instances: z.number().nullable(),
  /** Instances that are ready (`status.readyInstances`). */
  readyInstances: z.number(),
  currentPrimary: z.string().nullable(),
  targetPrimary: z.string().nullable(),
  currentPrimaryTimestamp: z.string().nullable(),
  targetPrimaryTimestamp: z.string().nullable(),
  /** Since when the current primary has been failing, while it is. */
  currentPrimaryFailingSince: z.string().nullable(),
  timelineId: z.number().nullable(),
  instanceNames: z.array(z.string()),
  instanceStates: z.array(InstanceSchema),
  /** The image the instances run, or the one asked for before any runs. */
  image: z.string().nullable(),
  /** The image catalog entry the image comes from, as kind/name. */
  imageCatalog: z.string().nullable(),
  /** The PostgreSQL major version of the data directory. */
  postgresMajor: z.number().nullable(),
  /** The PostgreSQL version read from the image tag, for example 18.1. */
  postgresVersion: z.string().nullable(),
  storageSize: z.string().nullable(),
  storageClass: z.string().nullable(),
  /** Size of the separate WAL volume; null when WAL shares the data volume. */
  walStorageSize: z.string().nullable(),
  walStorageClass: z.string().nullable(),
  conditions: z.array(ConditionSchema),
  archive: z.object({
    firstRecoverabilityPoint: z.string().nullable(),
    lastSuccessfulBackup: z.string().nullable(),
    lastFailedBackup: z.string().nullable(),
    /**
     * Where the three times were read: `clusterStatus` (the Cluster's own
     * status, set for the in-tree methods only), `objectStore` (the recovery
     * window on the Barman Cloud plugin's ObjectStore) or `none`.
     */
    source: z.enum(["clusterStatus", "objectStore", "none"]),
  }),
  /**
   * The volumeSnapshot times of the Cluster's own status, from
   * `firstRecoverabilityPointByMethod` and `lastSuccessfulBackupByMethod`.
   * They stand beside `archive` and are read whatever `archive.source` is:
   * a Cluster whose plugin archives WAL can still take snapshot backups.
   */
  volumeSnapshotTimes: z.object({
    firstRecoverabilityPoint: z.string().nullable(),
    lastSuccessfulBackup: z.string().nullable(),
  }),
  backup: z.object({
    /** A backup method or a WAL-archiving plugin is configured. */
    configured: z.boolean(),
    /** The methods a Backup of this Cluster can use. */
    methods: z.array(z.enum(["barmanObjectStore", "plugin", "volumeSnapshot"])),
    /** What archives WAL: barmanObjectStore, a plugin's name, or null. */
    walArchiver: z.string().nullable(),
    retentionPolicy: z.string().nullable(),
    target: z.string().nullable(),
    barmanObjectStore: z.object({
      destinationPath: z.string().nullable(),
      endpointURL: z.string().nullable(),
      serverName: z.string().nullable(),
    }).nullable(),
    volumeSnapshot: z.object({
      className: z.string().nullable(),
      walClassName: z.string().nullable(),
    }).nullable(),
    plugins: z.array(PluginSchema),
    objectStore: ObjectStoreSchema.nullable(),
  }),
  summary: z.object({
    /**
     * Healthy phase, Ready, every instance ready, no primary change, no
     * fenced instance and not hibernated: the Cluster serves as it was asked
     * to with every instance.
     */
    healthy: z.boolean(),
    /**
     * Something archives WAL, the ContinuousArchiving condition is True, the
     * Cluster is not hibernated and its primary is not fenced. The operator
     * sets that condition True on a Cluster that archives nowhere, and the
     * last condition stays on a Cluster whose PostgreSQL no longer runs, so
     * the condition alone says nothing.
     */
    archiving: z.boolean(),
    /** The current primary is not the target primary. */
    primaryChanging: z.boolean(),
    /** At least one instance is wanted and all wanted instances are ready. */
    instancesReady: z.boolean(),
  }),
});

/** One stored Cluster record. */
export type ClusterData = z.infer<typeof ClusterSchema>;

type ObjectStoreData = z.infer<typeof ObjectStoreSchema>;

/** What an ObjectStore says about one server: where it writes and its window. */
export interface ObjectStoreRead {
  store: ObjectStoreData;
  firstRecoverabilityPoint: string | null;
  lastSuccessfulBackup: string | null;
  lastFailedBackup: string | null;
}

/** The ObjectStore a Cluster's plugins point at: its name and server folder. */
export function objectStoreRef(
  item: Record<string, unknown>,
): { name: string; serverName: string } | null {
  const spec = obj(item.spec);
  for (const p of arr(spec.plugins)) {
    const plugin = obj(p);
    if (plugin.enabled === false) continue;
    const params = obj(plugin.parameters);
    const name = nonEmpty(params[OBJECT_STORE_PARAMETER]);
    if (name) {
      return {
        name,
        serverName: nonEmpty(params.serverName) ??
          nonEmpty(obj(item.metadata).name) ?? "",
      };
    }
  }
  return null;
}

/** Reduce an ObjectStore object to what a Cluster record keeps of it. */
export function parseObjectStore(
  item: Record<string, unknown>,
  serverName: string,
): ObjectStoreRead {
  const spec = obj(item.spec);
  const config = obj(spec.configuration);
  const window = obj(obj(obj(item.status).serverRecoveryWindow)[serverName]);
  return {
    store: {
      name: nonEmpty(obj(item.metadata).name) ?? "",
      found: true,
      error: null,
      destinationPath: url(config.destinationPath),
      endpointURL: url(config.endpointURL),
      retentionPolicy: nonEmpty(spec.retentionPolicy),
      serverName,
    },
    firstRecoverabilityPoint: nonEmpty(window.firstRecoverabilityPoint),
    lastSuccessfulBackup: nonEmpty(window.lastSuccessfulBackupTime),
    lastFailedBackup: nonEmpty(window.lastFailedBackupTime),
  };
}

/** The record of an ObjectStore that was named but could not be read. */
export function missingObjectStore(
  name: string,
  serverName: string,
  error: string,
): ObjectStoreRead {
  return {
    store: {
      name,
      found: false,
      error,
      destinationPath: null,
      endpointURL: null,
      retentionPolicy: null,
      serverName,
    },
    firstRecoverabilityPoint: null,
    lastSuccessfulBackup: null,
    lastFailedBackup: null,
  };
}

/**
 * The fenced instances of a Cluster, from its annotation: a JSON list of
 * instance names. An annotation that holds something else still fences, as
 * far as a reader can tell, so it counts as fenced with no names.
 */
function readFenced(
  item: Record<string, unknown>,
): { fenced: boolean; instances: string[] } {
  const raw = annotation(item, FENCED_ANNOTATION);
  if (raw === null || raw.trim() === "") {
    return { fenced: false, instances: [] };
  }
  try {
    const list: unknown = JSON.parse(raw);
    // Only a list of names is read as one; `[1, 2]` is as unreadable as text.
    if (Array.isArray(list) && list.every((n) => typeof n === "string")) {
      const instances = strings(list).map((n) => brief(n, 80)).sort();
      return { fenced: instances.length > 0, instances };
    }
  } catch {
    // Not JSON: fenced with no names, below.
  }
  return { fenced: true, instances: [] };
}

function versionFromImage(image: string | null): string | null {
  if (!image) return null;
  // The digest goes first: its hex digits must not be read as a tag.
  const tag = /:(\d+(?:\.\d+)*)[^:/@]*$/.exec(image.replace(/@.*$/, ""));
  return tag ? tag[1] : null;
}

function instanceStates(
  status: Record<string, unknown>,
  names: string[],
): ClusterData["instanceStates"] {
  const group = new Map<string, string>();
  for (const [state, pods] of Object.entries(obj(status.instancesStatus))) {
    for (const pod of arr(pods)) {
      if (typeof pod === "string") group.set(pod, state);
    }
  }
  const reported = obj(status.instancesReportedState);
  const all = new Set<string>([
    ...names,
    ...group.keys(),
    ...Object.keys(reported),
  ]);
  return [...all].sort().map((name) => {
    const r = obj(reported[name]);
    return {
      name,
      status: group.get(name) ?? null,
      isPrimary: boolOrNull(r.isPrimary),
      timelineId: numOrNull(r.timeLineID),
    };
  });
}

/**
 * Reduce a Cluster object as kubectl prints it to the stored record.
 * `objectStore` is what was read of the ObjectStore the Cluster points at,
 * when it points at one.
 */
export function parseCluster(
  item: Record<string, unknown>,
  objectStore: ObjectStoreRead | null = null,
): ClusterData {
  const meta = obj(item.metadata);
  const spec = obj(item.spec);
  const status = obj(item.status);
  const backup = obj(spec.backup);
  const conditions = readConditions(status.conditions);

  const instances = numOrNull(spec.instances);
  const readyInstances = numOrNull(status.readyInstances) ?? 0;
  const currentPrimary = nonEmpty(status.currentPrimary);
  const targetPrimary = nonEmpty(status.targetPrimary);
  const instanceNames = arr(status.instanceNames)
    .filter((n): n is string => typeof n === "string");

  const statusPlugins = arr(status.pluginStatus).map(obj);
  const plugins = arr(spec.plugins).map(obj)
    .filter((p) => nonEmpty(p.name) !== null)
    .map((p) => {
      const name = nonEmpty(p.name)!;
      const params = obj(p.parameters);
      const seen = statusPlugins.find((s) => s.name === name);
      return {
        name,
        enabled: p.enabled !== false,
        isWALArchiver: p.isWALArchiver === true,
        barmanObjectName: nonEmpty(params[OBJECT_STORE_PARAMETER]),
        serverName: nonEmpty(params.serverName),
        parameterNames: Object.keys(params).sort(),
        version: nonEmpty(seen?.version),
        // Empty means fine; anything else is free text from the plugin.
        status: seen && typeof seen.status === "string"
          ? brief(seen.status, 400)
          : null,
      };
    });
  const active = plugins.filter((p) => p.enabled);

  const hasBarman = Object.keys(obj(backup.barmanObjectStore)).length > 0;
  const hasSnapshot = Object.keys(obj(backup.volumeSnapshot)).length > 0;
  const methods: ClusterData["backup"]["methods"] = [];
  if (hasBarman) methods.push("barmanObjectStore");
  if (active.length > 0) methods.push("plugin");
  if (hasSnapshot) methods.push("volumeSnapshot");
  const walArchiver = active.find((p) => p.isWALArchiver)?.name ??
    (hasBarman ? "barmanObjectStore" : null);

  const fromStatus = {
    firstRecoverabilityPoint: nonEmpty(status.firstRecoverabilityPoint),
    lastSuccessfulBackup: nonEmpty(status.lastSuccessfulBackup),
    lastFailedBackup: nonEmpty(status.lastFailedBackup),
  };
  const statusHasTimes = Object.values(fromStatus).some((v) => v !== null);
  const storeHasTimes = objectStore !== null && (
    objectStore.firstRecoverabilityPoint !== null ||
    objectStore.lastSuccessfulBackup !== null ||
    objectStore.lastFailedBackup !== null
  );
  const fromStore: ClusterData["archive"] | null = storeHasTimes
    ? {
      firstRecoverabilityPoint: objectStore.firstRecoverabilityPoint,
      lastSuccessfulBackup: objectStore.lastSuccessfulBackup,
      lastFailedBackup: objectStore.lastFailedBackup,
      source: "objectStore",
    }
    : null;
  const none: ClusterData["archive"] = {
    firstRecoverabilityPoint: null,
    lastSuccessfulBackup: null,
    lastFailedBackup: null,
    source: "none",
  };
  // A plugin that archives WAL writes its times on the ObjectStore only. The
  // Cluster's own fields are then left over from an in-tree method it was
  // moved away from, and are not shown as if they were current.
  const archive: ClusterData["archive"] = active.some((p) => p.isWALArchiver)
    ? fromStore ?? none
    : statusHasTimes
    ? { ...fromStatus, source: "clusterStatus" }
    : fromStore ?? none;

  const image = nonEmpty(status.image) ?? nonEmpty(spec.imageName);
  const catalog = obj(spec.imageCatalogRef);
  const barman = obj(backup.barmanObjectStore);
  const snapshot = obj(backup.volumeSnapshot);

  const instancesReady = instances !== null && instances > 0 &&
    readyInstances === instances;
  const primaryChanging = currentPrimary !== targetPrimary;
  const phase = text(status.phase);
  const fence = readFenced(item);
  const hibernated = annotation(item, HIBERNATION_ANNOTATION) === "on";
  // An annotation that cannot be read is taken to fence every instance.
  const primaryFenced = fence.fenced && (
    fence.instances.length === 0 || fence.instances.includes("*") ||
    (currentPrimary !== null && fence.instances.includes(currentPrimary))
  );

  return {
    name: nonEmpty(meta.name) ?? "",
    namespace: nonEmpty(meta.namespace) ?? "",
    phase,
    phaseReason: text(status.phaseReason),
    fenced: fence.fenced,
    fencedInstances: fence.instances,
    hibernated,
    hibernationReached: hibernated &&
      conditionTrue(conditions, HIBERNATION_ANNOTATION),
    instances,
    readyInstances,
    currentPrimary,
    targetPrimary,
    currentPrimaryTimestamp: nonEmpty(status.currentPrimaryTimestamp),
    targetPrimaryTimestamp: nonEmpty(status.targetPrimaryTimestamp),
    currentPrimaryFailingSince: nonEmpty(
      status.currentPrimaryFailingSinceTimestamp,
    ),
    timelineId: numOrNull(status.timelineID),
    instanceNames,
    instanceStates: instanceStates(status, instanceNames),
    image,
    imageCatalog: nonEmpty(catalog.name)
      ? `${nonEmpty(catalog.kind) ?? "ImageCatalog"}/${nonEmpty(catalog.name)}`
      : null,
    postgresMajor: numOrNull(obj(status.pgDataImageInfo).majorVersion) ??
      numOrNull(catalog.major),
    postgresVersion: versionFromImage(image),
    storageSize: nonEmpty(obj(spec.storage).size),
    storageClass: nonEmpty(obj(spec.storage).storageClass),
    walStorageSize: nonEmpty(obj(spec.walStorage).size),
    walStorageClass: nonEmpty(obj(spec.walStorage).storageClass),
    conditions,
    archive,
    volumeSnapshotTimes: {
      firstRecoverabilityPoint: nonEmpty(
        obj(status.firstRecoverabilityPointByMethod).volumeSnapshot,
      ),
      lastSuccessfulBackup: nonEmpty(
        obj(status.lastSuccessfulBackupByMethod).volumeSnapshot,
      ),
    },
    backup: {
      configured: methods.length > 0,
      methods,
      walArchiver,
      retentionPolicy: nonEmpty(backup.retentionPolicy) ??
        objectStore?.store.retentionPolicy ?? null,
      target: nonEmpty(backup.target),
      barmanObjectStore: hasBarman
        ? {
          destinationPath: url(barman.destinationPath),
          endpointURL: url(barman.endpointURL),
          serverName: nonEmpty(barman.serverName),
        }
        : null,
      volumeSnapshot: hasSnapshot
        ? {
          className: nonEmpty(snapshot.className),
          walClassName: nonEmpty(snapshot.walClassName),
        }
        : null,
      plugins,
      objectStore: objectStore?.store ?? null,
    },
    summary: {
      healthy: phase === HEALTHY_PHASE && conditionTrue(conditions, "Ready") &&
        instancesReady && !primaryChanging && !fence.fenced && !hibernated,
      archiving: walArchiver !== null &&
        conditionTrue(conditions, "ContinuousArchiving") && !hibernated &&
        !primaryFenced,
      primaryChanging,
      instancesReady,
    },
  };
}

/**
 * Why a Cluster is not healthy, as one line for the inventory, or null when
 * it is: each part of `summary.healthy` that does not hold is named, a
 * hibernation or a fence first, because the rest follows from it.
 */
export function clusterReason(c: ClusterData): string | null {
  if (c.summary.healthy) return null;
  const parts: string[] = [];
  if (c.hibernationReached) {
    parts.push(`hibernated on purpose (annotation ${HIBERNATION_ANNOTATION})`);
  } else if (c.hibernated) {
    const seen = findCondition(c.conditions, HIBERNATION_ANNOTATION);
    parts.push(
      `hibernation asked for and not reached (annotation ${HIBERNATION_ANNOTATION}; ${
        seen
          ? `the condition is ${seen.status}${
            seen.reason ? ` (${seen.reason})` : ""
          }`
          : "the operator has set no condition for it"
      })`,
    );
  }
  if (c.fenced) {
    parts.push(
      `fenced: ${
        c.fencedInstances.includes("*")
          ? "every instance"
          : c.fencedInstances.join(", ") || "the annotation cannot be read"
      } (annotation ${FENCED_ANNOTATION})`,
    );
  }
  if (c.phase !== HEALTHY_PHASE) {
    parts.push(
      c.phase === null
        ? "no phase yet"
        : `phase ${c.phase}${c.phaseReason ? ` (${c.phaseReason})` : ""}`,
    );
  }
  if (!c.summary.instancesReady) {
    parts.push(`${c.readyInstances} of ${c.instances ?? 0} instances ready`);
  }
  if (c.summary.primaryChanging) {
    parts.push(
      `primary changing from ${c.currentPrimary ?? "none"} to ${
        c.targetPrimary ?? "none"
      }`,
    );
  }
  if (!conditionTrue(c.conditions, "Ready")) {
    const ready = findCondition(c.conditions, "Ready");
    parts.push(
      ready
        ? `Ready is ${ready.status}${ready.reason ? ` (${ready.reason})` : ""}`
        : "no Ready condition",
    );
  }
  return reasonLine(parts);
}

/** One Cluster in the inventory of a list. */
export const ClusterInventoryItemSchema = InventoryItemSchema.extend({
  archiveFailing: z.boolean().describe(
    "Something is configured to archive WAL, the Cluster is not hibernated, and it is not archiving. Not part of healthy",
  ),
  hibernated: z.boolean().describe(
    "The Cluster is hibernated on purpose, the operator has acted on it, and no instance is fenced. It counts as healthy here, with no reason: it is as it was asked to be, and it serves nothing",
  ),
});

/** The inventory a Cluster list writes. */
export const ClusterInventorySchema = InventorySchema.extend({
  items: z.array(ClusterInventoryItemSchema),
});

type Ctx = CnpgContext<ClusterData>;

/**
 * Why an ObjectStore could not be read, for the Cluster record. A cancelled
 * run is not such a reason: it is thrown on.
 */
function storeError(err: unknown): string {
  if (isCancelled(err)) throw err;
  if (isKubectlError(err, "missing-crd")) {
    return "the cluster has no objectstores.barmancloud.cnpg.io resource type";
  }
  if (isKubectlError(err, "not-found")) return "not found";
  if (isKubectlError(err, "forbidden")) {
    return "reading it is forbidden for this user";
  }
  return brief(err instanceof Error ? err.message : String(err), 200);
}

/** Swamp model for CloudNativePG Cluster objects. */
export const model = {
  type: "@dataverket/cnpg/cluster",
  version: "2026.11.10.1",
  globalArguments: KubectlGlobalArgsSchema,
  checks: {
    "kubectl-cli-available": kubectlCliCheck,
  },
  resources: {
    cluster: {
      description:
        "CloudNativePG Cluster status: phase, instances, primary, image, storage, conditions, WAL archiving and backup state, backup configuration by reference, and a summary",
      schema: ClusterSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    inventory: inventoryResource("Cluster", ClusterInventorySchema),
  },
  methods: {
    /** List Clusters across all namespaces (or one namespace). */
    list: {
      description:
        "List CloudNativePG Clusters with phase, instances, primary, WAL archiving and backup state, and record an inventory of the list that names each Cluster that is not healthy and why",
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
        context.logger.info("Listing Clusters in {namespace}", {
          namespace: ns || "all namespaces",
        });

        const opts = kubectlOpts(context);
        const clusters = listItems(
          await runKubectl(listArgs(RESOURCES.cluster, ns), opts),
          `kubectl get ${RESOURCES.cluster}`,
          "Cluster",
        );
        // Nothing is written when one item has no name or two share a data name.
        assertDistinctDataNames(
          "Cluster",
          clusters.map((c) => readMeta(c, true, "Cluster")),
        );

        // One more list, only when a Cluster points at an ObjectStore.
        const stores = new Map<string, Record<string, unknown>>();
        let storesError: string | null = null;
        if (clusters.some((c) => objectStoreRef(c) !== null)) {
          try {
            const listed = listItems(
              await runKubectl(listArgs(RESOURCES.objectStore, ns), opts),
              `kubectl get ${RESOURCES.objectStore}`,
              "ObjectStore",
            );
            for (const s of listed) {
              const m = obj(s.metadata);
              stores.set(`${nonEmpty(m.namespace)}/${nonEmpty(m.name)}`, s);
            }
          } catch (err) {
            storesError = storeError(err);
            warn(context, "ObjectStores could not be read: {error}", {
              error: storesError,
            });
          }
        }

        const handles: unknown[] = [];
        const lines: z.infer<typeof ClusterInventoryItemSchema>[] = [];
        for (const item of clusters) {
          const ref = objectStoreRef(item);
          let read: ObjectStoreRead | null = null;
          if (ref) {
            const found = stores.get(
              `${nonEmpty(obj(item.metadata).namespace)}/${ref.name}`,
            );
            read = found
              ? parseObjectStore(found, ref.serverName)
              : missingObjectStore(
                ref.name,
                ref.serverName,
                storesError ?? "not found",
              );
          }
          const parsed = parseCluster(item, read);
          const asleep = parsed.hibernationReached && !parsed.fenced;
          const stored = dataName(parsed.namespace, parsed.name);
          handles.push(await context.writeResource("cluster", stored, parsed));
          lines.push({
            namespace: parsed.namespace,
            name: parsed.name,
            dataName: stored,
            // A Cluster the operator has hibernated is as it was asked to
            // be: not a fault. One still on its way there, or fenced as
            // well, is judged like any other.
            healthy: parsed.summary.healthy || asleep,
            reason: asleep ? null : clusterReason(parsed),
            archiveFailing: parsed.backup.walArchiver !== null &&
              !parsed.summary.archiving && !parsed.hibernated,
            hibernated: asleep,
          });
        }
        handles.push(await writeInventory(context, "Cluster", ns, lines));
        return { dataHandles: handles };
      },
    },

    /** Read one Cluster. */
    get: {
      description:
        "Read one CloudNativePG Cluster: phase, instances, primary, WAL archiving and backup state",
      arguments: z.object({
        name: z.string().min(1).describe("Cluster name."),
        namespace: z.string().optional().describe(
          "Namespace of the Cluster. Left out or empty: the definition's namespace.",
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
        const name = checkName(args.name, "cluster name");
        context.logger.info("Reading Cluster {name} in {namespace}", {
          name,
          namespace: ns,
        });

        const opts = kubectlOpts(context);
        const item = expectObject(
          await runKubectl(getArgs(RESOURCES.cluster, name, ns), opts),
          { kind: "Cluster", name, namespace: ns },
        );

        const ref = objectStoreRef(item);
        let read: ObjectStoreRead | null = null;
        if (ref) {
          try {
            read = parseObjectStore(
              expectObject(
                await runKubectl(
                  getArgs(
                    RESOURCES.objectStore,
                    checkName(ref.name, "ObjectStore name"),
                    ns,
                  ),
                  opts,
                ),
                { kind: "ObjectStore", name: ref.name, namespace: ns },
              ),
              ref.serverName,
            );
          } catch (err) {
            const error = storeError(err);
            warn(context, "ObjectStore {store} could not be read: {error}", {
              store: brief(ref.name, 80),
              error,
            });
            read = missingObjectStore(ref.name, ref.serverName, error);
          }
        }

        const parsed = parseCluster(item, read);
        const handle = await context.writeResource(
          "cluster",
          dataName(ns, name),
          parsed,
        );
        context.logger.info(
          "Cluster {name}: {phase}, {ready}/{wanted} ready, primary {primary}",
          {
            name,
            phase: parsed.phase ?? "no phase",
            ready: String(parsed.readyInstances),
            wanted: String(parsed.instances ?? 0),
            primary: parsed.currentPrimary ?? "none",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
