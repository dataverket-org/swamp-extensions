/**
 * Adds `get` to `@dataverket/flux/helmrelease`: one HelmRelease read with
 * kubectl and recorded with the fields `list` stores, its whole Helm history,
 * the failure counters, the last action helm-controller attempted and the
 * Jobs Flux labelled for the release. A caller asks the record whether the
 * last action was an install or an upgrade and how it ended, instead of
 * parsing the Ready message. In its own file, like `reset`; the reduction of
 * what kubectl prints is pure, so it is tested without a cluster.
 *
 * The shape follows `.status` of the HelmRelease `v2` API as helm-controller
 * v1.7.1 (Flux 2.10.0) writes it. Nothing is read from a condition's message
 * text: the last action comes from `lastAttemptedReleaseAction`, then from the
 * newest history entry, then from the reason of the Released or Ready
 * condition, then from the failure counters.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  checkName,
  dataName,
  expectObject,
  getArgs as kubectlGetArgs,
  isKubectlError,
  kubectlOpts,
  listItems,
  NAMESPACE_NAME,
  nonEmpty,
  numOrNull,
  obj,
  OBJECT_NAME,
  requireNamespace,
  runKubectl,
} from "../lib/kubectl.ts";
import type { FluxGlobalArgs } from "./_helpers.ts";
import { HelmReleaseSchema, parseHelmRelease } from "./helmrelease.ts";

/** One Helm test hook of a history entry, as helm-controller recorded it. */
export const TestHookSchema = z.object({
  /** Name of the test hook object, usually a Pod. */
  name: z.string(),
  /** Succeeded, Failed, Running or Unknown; absent before the hook has run. */
  phase: z.string().optional(),
  lastStarted: z.string().optional(),
  lastCompleted: z.string().optional(),
});

/** One entry of `status.history`: a Helm release revision Flux knows of. */
export const HistoryEntrySchema = z.object({
  /** Helm's revision number of the release, counted from 1. */
  version: z.number(),
  /** Helm's status of the revision: deployed, superseded, failed, ... */
  status: z.string(),
  /** install or upgrade, when helm-controller recorded it on the entry. */
  action: z.string().optional(),
  /** Helm release name and the namespace it is installed in. */
  name: z.string(),
  namespace: z.string(),
  chartName: z.string(),
  chartVersion: z.string(),
  appVersion: z.string().optional(),
  firstDeployed: z.string().optional(),
  lastDeployed: z.string().optional(),
  /** When Helm marked the revision deleted, for an uninstalled release. */
  deleted: z.string().optional(),
  /** Digest of the release object in Helm's storage. */
  digest: z.string().optional(),
  /** Digest of the values the revision was rendered with. */
  configDigest: z.string().optional(),
  /** Digest of the chart artifact, when the chart came from an OCI source. */
  ociDigest: z.string().optional(),
  /** Whether tests were run for the revision at all. */
  tested: z.boolean(),
  /** The test hooks of the revision, in name order; empty when none ran. */
  testHooks: z.array(TestHookSchema),
});

/** One Job in the release namespace that Flux labelled for the release. */
export const ReleaseJobSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  /** The `helm.sh/hook` annotation split on commas; empty for a plain Job. */
  hooks: z.array(z.string()),
  /** The `helm.sh/hook-delete-policy` annotation split on commas. */
  hookDeletePolicies: z.array(z.string()),
  /** succeeded, failed, running or pending, from the Job's own conditions. */
  state: z.enum(["succeeded", "failed", "running", "pending"]),
  /** Reason of the Complete or Failed condition, such as BackoffLimitExceeded. */
  reason: z.string().optional(),
  active: z.number(),
  succeeded: z.number(),
  failed: z.number(),
  startTime: z.string().optional(),
  completionTime: z.string().optional(),
});

/** Where the derived `lastAction` was read from. */
export const LAST_ACTION_SOURCES = [
  "lastAttemptedReleaseAction",
  "historyAction",
  "conditionReason",
  "historyVersion",
  "failureCounters",
  "none",
] as const;

/** Zod schema for the record `get` stores. */
export const HelmReleaseDetailSchema = HelmReleaseSchema.extend({
  /**
   * `metadata.generation` of the object. When it is ahead of
   * `observedGeneration`, helm-controller has not yet acted on the newest
   * spec and the rest of the record describes the one before.
   */
  generation: z.number().optional(),
  /** Helm release name: the newest history entry's, else spec, else the object's. */
  releaseName: z.string(),
  /** Namespace the release is installed in; the Jobs are read there. */
  releaseNamespace: z.string(),
  /** Namespace of Helm's release storage, from status. */
  storageNamespace: z.string().optional(),
  /** `<namespace>/<name>` of the HelmChart object, when the release has one. */
  helmChart: z.string().optional(),
  /** Every history entry Flux keeps, newest first. */
  history: z.array(HistoryEntrySchema),
  /** install, upgrade, or unknown when status says nothing structured. */
  lastAction: z.enum(["install", "upgrade", "unknown"]),
  /** Which part of status `lastAction` came from. */
  lastActionSource: z.enum(LAST_ACTION_SOURCES),
  /** succeeded or failed from the Released condition; unknown without one. */
  lastActionOutcome: z.enum(["succeeded", "failed", "unknown"]),
  /** Reason of the Released condition, such as UpgradeFailed. */
  releasedReason: z.string().optional(),
  /** `status.lastAttemptedReleaseAction` as helm-controller wrote it. */
  lastAttemptedReleaseAction: z.string().optional(),
  lastAttemptedReleaseActionDuration: z.string().optional(),
  lastAttemptedRevisionDigest: z.string().optional(),
  lastAttemptedGeneration: z.number().optional(),
  lastAttemptedConfigDigest: z.string().optional(),
  /** Chart version of the newest history entry with status deployed. */
  lastAppliedRevision: z.string().optional(),
  /** Helm revision number of that entry. */
  lastAppliedReleaseVersion: z.number().optional(),
  /** Failed reconciliations since the last success; 0 when status has none. */
  failures: z.number(),
  installFailures: z.number(),
  upgradeFailures: z.number(),
  /** True when the Stalled condition is True, such as after RetriesExceeded. */
  stalled: z.boolean(),
  lastHandledResetAt: z.string().optional(),
  lastHandledForceAt: z.string().optional(),
  /** False when the Jobs could not be read; `jobsNote` then says why. */
  jobsRead: z.boolean(),
  /** Why the Jobs were not read: no permission, or a release on another cluster. */
  jobsNote: z.string().optional(),
  /** Jobs labelled for the release, in name order. Empty is a fact: hook Jobs are often deleted by their delete policy. */
  jobs: z.array(ReleaseJobSchema),
  /** When this record was read, ISO 8601. */
  readAt: z.string(),
});

/** One stored `detail` record. */
export type HelmReleaseDetail = z.infer<typeof HelmReleaseDetailSchema>;
/** One stored history entry. */
export type HistoryEntry = z.infer<typeof HistoryEntrySchema>;
/** One stored Job. */
export type ReleaseJob = z.infer<typeof ReleaseJobSchema>;

type Obj = Record<string, unknown>;

function objs(v: unknown): Obj[] {
  return Array.isArray(v)
    ? v.filter((e) => e !== null && typeof e === "object" && !Array.isArray(e))
    : [];
}

/** A string that is not empty, else undefined: the stored fields are optional. */
function str(v: unknown): string | undefined {
  return nonEmpty(v) ?? undefined;
}

/** A finite number, else undefined. */
function num(v: unknown): number | undefined {
  return numOrNull(v) ?? undefined;
}

/** Conditions with a type and a status, every field of the right type. */
function cleanConditions(v: unknown): Obj[] {
  return objs(v).filter((c) => str(c.type) && str(c.status)).map((c) => ({
    type: c.type,
    status: c.status,
    reason: str(c.reason),
    message: typeof c.message === "string" ? c.message : undefined,
    lastTransitionTime: str(c.lastTransitionTime),
    observedGeneration: num(c.observedGeneration),
  }));
}

/** A source reference with string fields, or nothing when it names nothing. */
function cleanRef(v: unknown): Obj | undefined {
  const r = obj(v);
  if (!str(r.kind) && !str(r.name)) return undefined;
  return { kind: str(r.kind), name: str(r.name), namespace: str(r.namespace) };
}

function csv(v: unknown): string[] {
  return typeof v === "string"
    ? v.split(",").map((s) => s.trim()).filter((s) => s !== "")
    : [];
}

/** Reduce one `status.history` entry; missing fields read as empty, not as a crash. */
export function parseHistoryEntry(entry: Obj): HistoryEntry {
  const hooks = entry.testHooks;
  const tested = hooks !== null && typeof hooks === "object" &&
    !Array.isArray(hooks);
  return {
    version: num(entry.version) ?? 0,
    status: str(entry.status) ?? "unknown",
    action: str(entry.action),
    name: str(entry.name) ?? "",
    namespace: str(entry.namespace) ?? "",
    chartName: str(entry.chartName) ?? "",
    chartVersion: str(entry.chartVersion) ?? "",
    appVersion: str(entry.appVersion),
    firstDeployed: str(entry.firstDeployed),
    lastDeployed: str(entry.lastDeployed),
    deleted: str(entry.deleted),
    digest: str(entry.digest),
    configDigest: str(entry.configDigest),
    ociDigest: str(entry.ociDigest),
    tested,
    testHooks: tested
      ? Object.keys(hooks as Obj).sort().map((name) => {
        const h = obj((hooks as Obj)[name]);
        return {
          name,
          phase: str(h.phase),
          lastStarted: str(h.lastStarted),
          lastCompleted: str(h.lastCompleted),
        };
      })
      : [],
  };
}

const ACTIONS = ["install", "upgrade"] as const;
type Action = typeof ACTIONS[number];

function asAction(v: unknown): Action | undefined {
  return ACTIONS.find((a) => a === v);
}

/** Condition reasons helm-controller sets after an install or an upgrade. */
const REASON_ACTION: Record<string, Action> = {
  InstallSucceeded: "install",
  InstallFailed: "install",
  UpgradeSucceeded: "upgrade",
  UpgradeFailed: "upgrade",
};

/**
 * Whether the last action was an install or an upgrade, and where that was
 * read. The order is from the most direct statement to the least: the field
 * helm-controller writes for exactly this, the action on the newest history
 * entry, the reason of the Released then the Ready condition, the newest
 * entry's revision number (1 is an install, more is an upgrade), and last the
 * failure counters. A condition's message is never read.
 */
export function deriveLastAction(
  status: Obj,
  history: HistoryEntry[],
  conditions: Obj[],
): Pick<HelmReleaseDetail, "lastAction" | "lastActionSource"> {
  const attempted = asAction(status.lastAttemptedReleaseAction);
  if (attempted) {
    return {
      lastAction: attempted,
      lastActionSource: "lastAttemptedReleaseAction",
    };
  }
  const newest = history[0];
  const recorded = asAction(newest?.action);
  if (recorded) {
    return { lastAction: recorded, lastActionSource: "historyAction" };
  }
  for (const type of ["Released", "Ready"]) {
    const reason = conditions.find((c) => c.type === type)?.reason;
    const fromReason = typeof reason === "string"
      ? REASON_ACTION[reason]
      : undefined;
    if (fromReason) {
      return { lastAction: fromReason, lastActionSource: "conditionReason" };
    }
  }
  if (newest && newest.version >= 1) {
    return {
      lastAction: newest.version === 1 ? "install" : "upgrade",
      lastActionSource: "historyVersion",
    };
  }
  if ((num(status.upgradeFailures) ?? 0) > 0) {
    return { lastAction: "upgrade", lastActionSource: "failureCounters" };
  }
  if ((num(status.installFailures) ?? 0) > 0) {
    return { lastAction: "install", lastActionSource: "failureCounters" };
  }
  return { lastAction: "unknown", lastActionSource: "none" };
}

/** Reduce one Job as kubectl prints it. */
export function parseJob(item: Obj): ReleaseJob {
  const meta = obj(item.metadata);
  const annotations = obj(meta.annotations);
  const status = obj(item.status);
  const conditions = objs(status.conditions);
  const isTrue = (type: string): Obj | undefined =>
    conditions.find((c) => c.type === type && c.status === "True");
  const complete = isTrue("Complete");
  const failed = isTrue("Failed");
  const active = num(status.active) ?? 0;
  return {
    name: str(meta.name) ?? "",
    namespace: str(meta.namespace) ?? "",
    hooks: csv(annotations["helm.sh/hook"]),
    hookDeletePolicies: csv(annotations["helm.sh/hook-delete-policy"]),
    state: failed
      ? "failed"
      : complete
      ? "succeeded"
      : active > 0
      ? "running"
      : "pending",
    reason: str((failed ?? complete)?.reason),
    active,
    succeeded: num(status.succeeded) ?? 0,
    failed: num(status.failed) ?? 0,
    startTime: str(status.startTime),
    completionTime: str(status.completionTime),
  };
}

/**
 * The Jobs of a `kubectl get jobs.batch` list, in name order. An answer that
 * is not a list of Jobs is an error, not "no Jobs".
 */
export function parseJobs(list: unknown): ReleaseJob[] {
  return listItems(list, `kubectl get ${JOBS}`, "Job").map(parseJob).sort((
    a,
    b,
  ) => a.name < b.name ? -1 : a.name > b.name ? 1 : 0);
}

/** What `get` knows about the Jobs once it has tried to read them. */
export interface JobsOutcome {
  jobsRead: boolean;
  jobsNote?: string;
  jobs: ReleaseJob[];
}

/**
 * Where the release is installed and whether its Jobs are in the cluster
 * being read. A release with `spec.kubeConfig` is installed on another
 * cluster, so its Jobs cannot be read through this one.
 */
export function releaseTarget(
  item: Obj,
  name: string,
  namespace: string,
): { releaseName: string; releaseNamespace: string; remote: boolean } {
  const spec = obj(item.spec);
  const newest = objs(obj(item.status).history)[0] ?? {};
  return {
    releaseName: str(newest.name) ?? str(spec.releaseName) ?? name,
    releaseNamespace: str(newest.namespace) ?? str(spec.targetNamespace) ??
      namespace,
    remote: Object.keys(obj(spec.kubeConfig)).length > 0,
  };
}

/**
 * Reduce a HelmRelease object and the outcome of the Job read to the stored
 * record. `name` and `namespace` are what was asked for; they stand in when
 * the object's own metadata is missing. Malformed parts of status (history
 * that is not a list, entries that are not objects, counters that are not
 * numbers) read as absent.
 */
export function parseHelmReleaseDetail(
  item: Obj,
  name: string,
  namespace: string,
  jobs: JobsOutcome,
  readAt: string,
): HelmReleaseDetail {
  const meta = obj(item.metadata);
  const spec = obj(item.spec);
  const status = obj(item.status);
  const conditions = cleanConditions(status.conditions);
  const history = objs(status.history).map(parseHistoryEntry);
  // The list parser reads the same object and trusts its types; hand it one
  // whose loose ends are already tied, so a status that is not what the API
  // promises cannot crash it or put a wrong type in the record.
  const base = parseHelmRelease({
    metadata: {
      name: str(meta.name) ?? name,
      namespace: str(meta.namespace) ?? namespace,
    },
    spec: {
      suspend: spec.suspend === true,
      chart: {
        spec: {
          chart: str(obj(obj(spec.chart).spec).chart),
          version: str(obj(obj(spec.chart).spec).version),
          sourceRef: cleanRef(obj(obj(spec.chart).spec).sourceRef),
        },
      },
      chartRef: cleanRef(spec.chartRef),
    },
    status: {
      conditions,
      history: history.map((h) => ({
        chartVersion: h.chartVersion,
        appVersion: h.appVersion,
        status: h.status,
      })),
      lastAttemptedRevision: str(status.lastAttemptedRevision),
      lastHandledReconcileAt: str(status.lastHandledReconcileAt),
      observedGeneration: num(status.observedGeneration),
    },
  });
  const target = releaseTarget(item, name, namespace);
  const released = conditions.find((c) => c.type === "Released");
  const applied = history.find((h) => h.status === "deployed");
  return {
    ...base,
    generation: num(meta.generation),
    releaseName: target.releaseName,
    releaseNamespace: target.releaseNamespace,
    storageNamespace: str(status.storageNamespace),
    helmChart: str(status.helmChart),
    history,
    ...deriveLastAction(status, history, conditions),
    lastActionOutcome: released?.status === "True"
      ? "succeeded"
      : released?.status === "False"
      ? "failed"
      : "unknown",
    releasedReason: str(released?.reason),
    lastAttemptedReleaseAction: str(status.lastAttemptedReleaseAction),
    lastAttemptedReleaseActionDuration: str(
      status.lastAttemptedReleaseActionDuration,
    ),
    lastAttemptedRevisionDigest: str(status.lastAttemptedRevisionDigest),
    lastAttemptedGeneration: num(status.lastAttemptedGeneration),
    lastAttemptedConfigDigest: str(status.lastAttemptedConfigDigest),
    lastAppliedRevision: applied?.chartVersion,
    lastAppliedReleaseVersion: applied?.version,
    failures: num(status.failures) ?? 0,
    installFailures: num(status.installFailures) ?? 0,
    upgradeFailures: num(status.upgradeFailures) ?? 0,
    stalled: conditions.some((c) =>
      c.type === "Stalled" && c.status === "True"
    ),
    lastHandledResetAt: str(status.lastHandledResetAt),
    lastHandledForceAt: str(status.lastHandledForceAt),
    jobsRead: jobs.jobsRead,
    jobsNote: jobs.jobsNote,
    jobs: jobs.jobs,
    readAt,
  };
}

const RESOURCE = "helmreleases.helm.toolkit.fluxcd.io";
const JOBS = "jobs.batch";

/** Flux puts these two labels on every object a HelmRelease renders, hooks too. */
export function jobSelector(name: string, namespace: string): string {
  return `helm.toolkit.fluxcd.io/name=${name},helm.toolkit.fluxcd.io/namespace=${namespace}`;
}

/**
 * The exact `kubectl` argument lists of `get`; pure so a test can pin them.
 * The runner adds the cluster flags, the request timeout and `-o json`.
 */
export function getArgs(name: string, namespace: string): string[] {
  return kubectlGetArgs(RESOURCE, name, namespace);
}

/** The `kubectl` arguments that list the Jobs labelled for a release. */
export function jobsArgs(
  name: string,
  namespace: string,
  releaseNamespace: string,
): string[] {
  return [
    "get",
    JOBS,
    "-n",
    releaseNamespace,
    "-l",
    jobSelector(name, namespace),
  ];
}

const GetArgsSchema = z.object({
  /** HelmRelease name. */
  name: z.string().regex(OBJECT_NAME, "not a Kubernetes object name"),
  /**
   * Namespace of the HelmRelease. Defaults to the model's namespace. Checked
   * in the method, not here: swamp fills an argument left out from the global
   * argument of the same name, and that one is empty on a model for all
   * namespaces.
   */
  namespace: z.string().optional(),
});

/** The context `get` reads. */
export interface GetContext {
  globalArgs: FluxGlobalArgs;
  signal?: AbortSignal;
  logger: { info(msg: string, props?: Record<string, string>): void };
  writeResource: (
    spec: string,
    name: string,
    data: HelmReleaseDetail,
  ) => Promise<unknown>;
}

/** The data name of a `detail` record. The dot keeps it apart from every `<namespace>--<name>` record of `list`, because a namespace holds no dot. */
export function detailName(namespace: string, name: string): string {
  return `detail.${dataName(namespace, name)}`;
}

/**
 * Read the Jobs labelled for the release. No Job at all is an answer, and so
 * is a refusal for lack of permission in that one namespace: both are
 * recorded. Any other failure is a broken call and is thrown.
 */
async function readJobs(
  item: Obj,
  name: string,
  namespace: string,
  context: GetContext,
): Promise<JobsOutcome> {
  const target = releaseTarget(item, name, namespace);
  if (target.remote) {
    return {
      jobsRead: false,
      jobsNote:
        "the release is installed on another cluster (spec.kubeConfig), so its Jobs are not in the cluster that was read",
      jobs: [],
    };
  }
  if (!NAMESPACE_NAME.test(target.releaseNamespace) || name.length > 63) {
    return {
      jobsRead: false,
      jobsNote: name.length > 63
        ? "the HelmRelease name is longer than a label value can be, so no Job carries it"
        : "the release namespace in the object is not a namespace name",
      jobs: [],
    };
  }
  try {
    const list = await runKubectl(
      jobsArgs(name, namespace, target.releaseNamespace),
      kubectlOpts(context),
    );
    return { jobsRead: true, jobs: parseJobs(list) };
  } catch (err) {
    // Only the API server's own refusal is an answer; the word in any other
    // text is not.
    if (
      !isKubectlError(err, "forbidden") ||
      !err.stderr.startsWith("Error from server (Forbidden)")
    ) throw err;
    return {
      jobsRead: false,
      jobsNote: err.stderr.split("\n")[0].slice(0, 300),
      jobs: [],
    };
  }
}

/** Adds `get` and the `detail` record to `@dataverket/flux/helmrelease`. */
export const extension = {
  type: "@dataverket/flux/helmrelease",
  resources: {
    detail: {
      description:
        "One HelmRelease in full: what list stores, every Helm history entry with its test hooks, the last attempted action and how it ended, the failure counters, and the Jobs labelled for the release.",
      schema: HelmReleaseDetailSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: [{
    get: {
      description:
        "Read one HelmRelease with its whole Helm history: revisions with status, chart and digests, test hook results, whether the last action was an install or an upgrade and how it ended, the failure counters, and the Jobs labelled for the release. Read-only; a release that failed is recorded, not thrown.",
      arguments: GetArgsSchema,
      execute: async (
        args: z.infer<typeof GetArgsSchema>,
        context: GetContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const name = checkName(args.name);
        const namespace = requireNamespace(
          "get",
          args.namespace,
          context.globalArgs.namespace,
        );
        context.logger.info("Reading HelmRelease {name} in {namespace}", {
          name,
          namespace,
        });
        const item = expectObject(
          await runKubectl(getArgs(name, namespace), kubectlOpts(context)),
          { kind: "HelmRelease", name, namespace },
        );
        const jobs = await readJobs(item, name, namespace, context);
        const record = HelmReleaseDetailSchema.parse(
          parseHelmReleaseDetail(
            item,
            name,
            namespace,
            jobs,
            new Date().toISOString(),
          ),
        );
        const handle = await context.writeResource(
          "detail",
          detailName(namespace, name),
          record,
        );
        context.logger.info(
          "HelmRelease {name}: ready={ready}, last action {action} {outcome}, {entries} history entries, {jobs} jobs",
          {
            name,
            ready: String(record.ready),
            action: record.lastAction,
            outcome: record.lastActionOutcome,
            entries: String(record.history.length),
            jobs: record.jobsRead ? String(record.jobs.length) : "unread",
          },
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
