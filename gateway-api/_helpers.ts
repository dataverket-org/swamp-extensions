/**
 * What the Gateway API model types share and what belongs to this domain
 * only: the API group, the two reads every method is built from, the wording
 * of the two failures an operator of a Gateway API cluster meets most, the
 * readers for group and kind pairs, and the inventory of a list.
 *
 * Everything about running kubectl (the spawn, the time limit, the named
 * failures, the name checks, redaction, the condition readers, the data
 * names) comes from the shared layer in `../lib/kubectl.ts`.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { brief } from "../lib/cli.ts";
import {
  arr,
  buildInventory as buildCoreInventory,
  type Condition,
  dataName,
  describeKubectlArgs,
  expectObject,
  getArgs,
  InventorySchema,
  isKubectlError,
  KubectlError,
  type KubectlGlobalArgsSchema,
  kubectlOpts,
  listArgs,
  listItems,
  obj,
  runKubectl,
  strOrNull,
} from "../lib/kubectl.ts";

/** The API group every resource of this extension lives in. */
export const GROUP = "gateway.networking.k8s.io";

/** The version this extension is written against. */
export const API_VERSION = `${GROUP}/v1`;

/** The logger a method receives. */
export interface MethodLogger {
  info: (msg: string, props?: Record<string, unknown>) => void;
  warning: (msg: string, props?: Record<string, unknown>) => void;
}

/** The context every method in this extension reads. */
export interface MethodContext {
  globalArgs: z.input<typeof KubectlGlobalArgsSchema>;
  logger: MethodLogger;
  /** Set when the method run is cancelled; ends a running kubectl. */
  signal?: AbortSignal;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

/**
 * Run one read and word the two failures that have a Gateway API meaning:
 * a resource the cluster does not serve is the CRDs not being installed, and
 * a refusal names the verbs this extension needs. The failure kind stays the
 * shared layer's (`missing-crd`, `forbidden`); every other failure passes
 * through as it is.
 */
export async function readGatewayApi(
  args: string[],
  resource: string,
  context: Pick<MethodContext, "globalArgs" | "signal">,
): Promise<unknown> {
  try {
    return await runKubectl(args, kubectlOpts(context));
  } catch (err) {
    const what = `kubectl ${describeKubectlArgs(args)}`;
    if (isKubectlError(err, "missing-crd")) {
      throw new KubectlError(
        "missing-crd",
        `${what} failed: the cluster does not serve ${resource}. The Gateway API CRDs are not installed (or not this kind); install the Gateway API before reading it`,
        err.stderr,
      );
    }
    if (isKubectlError(err, "forbidden")) {
      throw new KubectlError(
        "forbidden",
        `${what} failed: refused by RBAC; the identity needs get and list on ${resource} (${
          brief(err.stderr) || "no error output"
        })`,
        err.stderr,
      );
    }
    throw err;
  }
}

/**
 * Every object of one kind: of one namespace, of every namespace (empty), or
 * of the cluster for a cluster-scoped kind (null). The answer must be a list
 * of that kind and nothing else.
 */
export async function listObjects(
  context: Pick<MethodContext, "globalArgs" | "signal">,
  resource: string,
  kind: string,
  namespace: string | null,
): Promise<Record<string, unknown>[]> {
  const args = listArgs(resource, namespace);
  const data = await readGatewayApi(args, resource, context);
  return listItems(data, `kubectl ${describeKubectlArgs(args)}`, kind);
}

/**
 * One object by name; a null namespace reads a cluster-scoped kind. The
 * answer must be the object that was asked for.
 */
export async function getObject(
  context: Pick<MethodContext, "globalArgs" | "signal">,
  resource: string,
  kind: string,
  name: string,
  namespace: string | null,
): Promise<Record<string, unknown>> {
  const data = await readGatewayApi(
    getArgs(resource, name, namespace),
    resource,
    context,
  );
  return expectObject(data, { kind, name, namespace });
}

/**
 * Whether the conditions describe the object as it is now: false when any of
 * them was observed at an older generation, null when that cannot be told.
 */
export function conditionsCurrent(
  generation: number | null,
  conditions: Condition[],
): boolean | null {
  const seen = conditions
    .map((c) => c.observedGeneration)
    .filter((g): g is number => g !== null);
  if (generation === null || seen.length === 0) return null;
  return seen.every((g) => g >= generation);
}

/** A group and kind pair, as route kinds and supported kinds are listed. */
export const GroupKindSchema = z.object({
  group: z.string(),
  kind: z.string(),
});

/** Read a list of group and kind pairs; the group defaults to the Gateway API. */
export function readGroupKinds(
  raw: unknown,
): Array<z.infer<typeof GroupKindSchema>> {
  return arr(raw).map((k) => ({
    group: strOrNull(obj(k).group) ?? GROUP,
    kind: strOrNull(obj(k).kind) ?? "",
  })).filter((k) => k.kind !== "");
}

/**
 * What one list saw: the shared inventory (counts, and every object by name
 * with one reason line), and what this domain adds: whether all are healthy,
 * the API versions served, and every reason of each unhealthy object.
 */
export const ListInventorySchema = InventorySchema.extend({
  allHealthy: z.boolean(),
  apiVersions: z.array(z.string()).describe(
    "The API versions the objects were served at",
  ),
  unhealthy: z.array(z.object({
    namespace: z.string().nullable(),
    name: z.string(),
    reasons: z.array(z.string()),
  })),
  observedAt: z.iso.datetime(),
});

/** One stored inventory. */
export type ListInventory = z.infer<typeof ListInventorySchema>;

/** The reasons of one object as the single line an inventory item holds. */
export function reasonSummary(reasons: string[]): string | null {
  if (reasons.length === 0) return null;
  return reasons.length === 1
    ? reasons[0]
    : `${reasons[0]} (and ${reasons.length - 1} more)`;
}

/** Build the inventory of one list from its records. */
export function listInventory(
  namespace: string | null,
  records: Array<{
    namespace: string | null;
    name: string;
    apiVersion: string;
    healthy: boolean;
    reasons: string[];
  }>,
  observedAt: string,
): ListInventory {
  const core = buildCoreInventory(
    namespace,
    records.map((r) => ({
      namespace: r.namespace,
      name: r.name,
      dataName: dataName(r.namespace, r.name),
      healthy: r.healthy,
      reason: r.healthy
        ? null
        : reasonSummary(r.reasons) ?? "not healthy, no reason given",
    })),
    observedAt,
  );
  return {
    ...core,
    allHealthy: core.unhealthyCount === 0,
    apiVersions: [...new Set(records.map((r) => r.apiVersion))].sort(),
    unhealthy: records.filter((r) => !r.healthy).map((r) => ({
      namespace: r.namespace,
      name: r.name,
      reasons: r.reasons,
    })),
  };
}

/** One line for an inventory: what is wrong, in words a person reads. */
export function reasonLine(
  subject: string,
  condition: string | null,
  status: string | null,
  reason: string | null,
): string {
  if (!condition) return `${subject}: ${reason ?? "no status"}`;
  return `${subject}: ${condition}=${status ?? "missing"}${
    reason ? ` (${reason})` : ""
  }`;
}

/** Warn once when objects were served at a version other than v1. */
export function warnOnVersions(
  logger: MethodLogger,
  kind: string,
  apiVersions: string[],
): void {
  const other = [...new Set(apiVersions)].filter((v) => v !== API_VERSION);
  if (other.length > 0) {
    logger.warning(
      "{kind} served at {versions}, not {expected}; fields are read as v1 and may be incomplete",
      { kind, versions: other.join(", "), expected: API_VERSION },
    );
  }
}
