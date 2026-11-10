/**
 * `@dataverket/gateway-api/gateway`: Gateway objects of the Kubernetes Gateway
 * API, read with kubectl. `list` records every Gateway of a namespace or of
 * the cluster and an inventory of what it saw; `get` records one.
 *
 * A record holds the class, the addresses asked for and assigned, the
 * Gateway's conditions, every listener with its own conditions, and a summary
 * a workflow asserts on without parsing text. A Gateway that is not accepted
 * or not programmed is recorded, never thrown; only a call that could not be
 * made fails the method.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  arr,
  assertDistinctDataNames,
  checkName,
  type Condition,
  ConditionSchema,
  conditionState,
  dataName,
  findCondition,
  inventoryName,
  kubectlCliCheck,
  KubectlGlobalArgsSchema,
  listNamespace,
  numOrNull,
  obj,
  readConditions,
  readMeta,
  requireNamespace,
  strOrNull,
} from "../lib/kubectl.ts";
import {
  conditionsCurrent,
  getObject,
  GROUP,
  GroupKindSchema,
  listInventory,
  ListInventorySchema,
  listObjects,
  type MethodContext,
  readGroupKinds,
  reasonLine,
  warnOnVersions,
} from "./_helpers.ts";

/** The resource, by its full group, as kubectl is asked for it. */
export const RESOURCE = `gateways.${GROUP}`;

const AddressSchema = z.object({
  type: z.string().nullable(),
  value: z.string(),
});

const ListenerSchema = z.object({
  name: z.string(),
  hostname: z.string().nullable().describe("null matches every hostname"),
  port: z.number().nullable(),
  protocol: z.string().nullable(),
  tls: z.object({
    mode: z.string().nullable(),
    certificateRefs: z.array(z.object({
      group: z.string(),
      kind: z.string(),
      name: z.string(),
      namespace: z.string().describe(
        "The namespace the reference points into; the Gateway's own when none is written",
      ),
    })).describe("References by name only; no certificate or key is read"),
  }).nullable(),
  allowedRoutes: z.object({
    namespacesFrom: z.string().describe("Same, All or Selector"),
    namespaceSelector: z.string().nullable().describe(
      "The label selector in words, when namespacesFrom is Selector",
    ),
    kinds: z.array(GroupKindSchema),
  }),
  reported: z.boolean().describe(
    "The controller wrote a status entry for this listener",
  ),
  attachedRoutes: z.number().nullable(),
  supportedKinds: z.array(GroupKindSchema),
  accepted: z.boolean().nullable(),
  programmed: z.boolean().nullable(),
  refsResolved: z.boolean().nullable(),
  conflicted: z.boolean().nullable(),
  conditions: z.array(ConditionSchema),
});

const UnhealthySchema = z.object({
  listener: z.string().nullable().describe(
    "The listener's name; null when the finding is about the Gateway itself",
  ),
  condition: z.string().nullable().describe(
    "The condition that is not as it should be; null when nothing was reported",
  ),
  status: z.string().nullable(),
  reason: z.string().nullable(),
  message: z.string().nullable(),
});

/** Zod schema for a stored Gateway. */
export const GatewaySchema = z.object({
  name: z.string(),
  namespace: z.string(),
  apiVersion: z.string(),
  generation: z.number().nullable(),
  gatewayClassName: z.string().nullable(),
  addresses: z.object({
    spec: z.array(AddressSchema).describe("Addresses the Gateway asks for"),
    status: z.array(AddressSchema).describe("Addresses the controller bound"),
  }),
  conditions: z.array(ConditionSchema),
  listeners: z.array(ListenerSchema),
  summary: z.object({
    accepted: z.boolean().nullable().describe(
      "The Gateway's Accepted condition; null when missing or Unknown",
    ),
    programmed: z.boolean().nullable().describe(
      "The Gateway's Programmed condition; null when missing or Unknown",
    ),
    statusCurrent: z.boolean().nullable().describe(
      "false when a condition was observed at an older generation than the object has now",
    ),
    hasAddress: z.boolean().describe(
      "The controller bound at least one address; a fact, not judged: Programmed is the controller's own verdict on it",
    ),
    listenerCount: z.number().int(),
    attachedRoutes: z.number().int().describe("Summed over every listener"),
    allListenersAccepted: z.boolean(),
    allListenersProgrammed: z.boolean(),
    allListenersRefsResolved: z.boolean(),
    anyListenerConflicted: z.boolean(),
    leftoverListenerReports: z.number().int().describe(
      "Status entries for listeners that are not in the spec, such as one the controller kept after a listener was renamed or removed; counted, not judged",
    ),
    healthy: z.boolean().describe(
      "Accepted and Programmed, status current, and every listener accepted, programmed, with resolved references and not conflicted",
    ),
    unhealthy: z.array(UnhealthySchema).describe(
      "Every finding that keeps healthy false, with the controller's reason",
    ),
  }),
  observedAt: z.iso.datetime(),
});

/** One stored Gateway record. */
export type GatewayData = z.infer<typeof GatewaySchema>;

type Listener = z.infer<typeof ListenerSchema>;
type Unhealthy = z.infer<typeof UnhealthySchema>;

function readAddresses(raw: unknown): Array<z.infer<typeof AddressSchema>> {
  const out: Array<z.infer<typeof AddressSchema>> = [];
  for (const entry of arr(raw)) {
    const value = strOrNull(obj(entry).value);
    if (value !== null) out.push({ type: strOrNull(obj(entry).type), value });
  }
  return out;
}

/** A label selector in words: `env=prod, tier in (a,b)`; null when absent. */
export function selectorSummary(raw: unknown): string | null {
  if (raw === undefined || raw === null) return null;
  const sel = obj(raw);
  const parts: string[] = [];
  for (const [k, v] of Object.entries(obj(sel.matchLabels))) {
    parts.push(`${k}=${String(v)}`);
  }
  for (const entry of arr(sel.matchExpressions)) {
    const e = obj(entry);
    const values = arr(e.values).map(String).join(",");
    parts.push(
      `${strOrNull(e.key) ?? "?"} ${strOrNull(e.operator) ?? "?"}${
        values ? ` (${values})` : ""
      }`,
    );
  }
  return parts.length > 0 ? parts.join(", ") : "(every namespace)";
}

function unhealthyFor(
  listener: string | null,
  conditions: Condition[],
  type: string,
  healthyStatus: "True" | "False",
  requireReported: boolean,
): Unhealthy[] {
  const c = findCondition(conditions, type);
  if (!c) {
    return requireReported
      ? [{
        listener,
        condition: type,
        status: null,
        reason: "NotReported",
        message: `no ${type} condition is reported`,
      }]
      : [];
  }
  if (c.status === healthyStatus) return [];
  // An Unknown Conflicted says nothing against the listener.
  if (!requireReported && c.status !== "True") return [];
  return [{
    listener,
    condition: type,
    status: c.status,
    reason: c.reason,
    message: c.message,
  }];
}

function readListener(
  spec: Record<string, unknown>,
  status: Record<string, unknown> | undefined,
  gatewayNamespace: string,
): Listener {
  const tls = spec.tls === undefined || spec.tls === null
    ? null
    : obj(spec.tls);
  const allowed = obj(spec.allowedRoutes);
  const namespaces = obj(allowed.namespaces);
  const from = strOrNull(namespaces.from) ?? "Same";
  const conditions = readConditions(status?.conditions);
  return {
    name: strOrNull(spec.name) ?? "",
    hostname: strOrNull(spec.hostname),
    port: numOrNull(spec.port),
    protocol: strOrNull(spec.protocol),
    tls: tls === null ? null : {
      mode: strOrNull(tls.mode),
      certificateRefs: arr(tls.certificateRefs).map((r) => ({
        group: strOrNull(obj(r).group) ?? "",
        kind: strOrNull(obj(r).kind) ?? "Secret",
        name: strOrNull(obj(r).name) ?? "",
        namespace: strOrNull(obj(r).namespace) ?? gatewayNamespace,
      })),
    },
    allowedRoutes: {
      namespacesFrom: from,
      namespaceSelector: from === "Selector"
        ? selectorSummary(namespaces.selector)
        : null,
      kinds: readGroupKinds(allowed.kinds),
    },
    reported: status !== undefined,
    attachedRoutes: numOrNull(status?.attachedRoutes),
    supportedKinds: readGroupKinds(status?.supportedKinds),
    accepted: conditionState(conditions, "Accepted"),
    programmed: conditionState(conditions, "Programmed"),
    refsResolved: conditionState(conditions, "ResolvedRefs"),
    conflicted: conditionState(conditions, "Conflicted"),
    conditions,
  };
}

function listenerFindings(l: Listener): Unhealthy[] {
  if (!l.reported) {
    return [{
      listener: l.name,
      condition: null,
      status: null,
      reason: "NotReported",
      message: "no controller has reported a status for this listener",
    }];
  }
  return [
    ...unhealthyFor(l.name, l.conditions, "Accepted", "True", true),
    ...unhealthyFor(l.name, l.conditions, "Programmed", "True", true),
    ...unhealthyFor(l.name, l.conditions, "ResolvedRefs", "True", true),
    ...unhealthyFor(l.name, l.conditions, "Conflicted", "False", false),
  ];
}

/** Reduce a Gateway object as kubectl prints it to the stored record. */
export function parseGateway(
  item: Record<string, unknown>,
  observedAt: string,
): GatewayData {
  const meta = readMeta(item, true, "Gateway");
  const spec = obj(item.spec);
  const status = obj(item.status);
  const conditions = readConditions(status.conditions);

  const specNames = new Set(
    arr(spec.listeners).map((l) => strOrNull(obj(l).name) ?? ""),
  );
  const statusByName = new Map<string, Record<string, unknown>>();
  let leftoverListenerReports = 0;
  for (const entry of arr(status.listeners)) {
    const name = strOrNull(obj(entry).name);
    // An entry without a name, for a listener the spec does not have, or
    // for a name already seen is not the status of any listener.
    if (name === null || !specNames.has(name) || statusByName.has(name)) {
      leftoverListenerReports++;
    } else {
      statusByName.set(name, obj(entry));
    }
  }
  const listeners = arr(spec.listeners).map((l) =>
    readListener(
      obj(l),
      statusByName.get(strOrNull(obj(l).name) ?? ""),
      meta.namespace,
    )
  );

  const statusCurrent = conditionsCurrent(meta.generation, [
    ...conditions,
    ...listeners.flatMap((l) => l.conditions),
  ]);
  const unhealthy: Unhealthy[] = [
    ...unhealthyFor(null, conditions, "Accepted", "True", true),
    ...unhealthyFor(null, conditions, "Programmed", "True", true),
  ];
  if (statusCurrent === false) {
    unhealthy.push({
      listener: null,
      condition: null,
      status: null,
      reason: "StaleStatus",
      message:
        `a condition was observed before generation ${meta.generation}; the controller has not yet reported on the object as it is now`,
    });
  }
  if (listeners.length === 0) {
    unhealthy.push({
      listener: null,
      condition: null,
      status: null,
      reason: "NoListeners",
      message: "the Gateway has no listeners",
    });
  }
  for (const l of listeners) unhealthy.push(...listenerFindings(l));

  const statusAddresses = readAddresses(status.addresses);
  return {
    name: meta.name,
    namespace: meta.namespace,
    apiVersion: meta.apiVersion,
    generation: meta.generation,
    gatewayClassName: strOrNull(spec.gatewayClassName),
    addresses: {
      spec: readAddresses(spec.addresses),
      status: statusAddresses,
    },
    conditions,
    listeners,
    summary: {
      accepted: conditionState(conditions, "Accepted"),
      programmed: conditionState(conditions, "Programmed"),
      statusCurrent,
      hasAddress: statusAddresses.length > 0,
      listenerCount: listeners.length,
      attachedRoutes: listeners.reduce(
        (sum, l) => sum + (l.attachedRoutes ?? 0),
        0,
      ),
      allListenersAccepted: listeners.every((l) => l.accepted === true),
      allListenersProgrammed: listeners.every((l) => l.programmed === true),
      allListenersRefsResolved: listeners.every((l) => l.refsResolved === true),
      anyListenerConflicted: listeners.some((l) => l.conflicted === true),
      leftoverListenerReports,
      healthy: unhealthy.length === 0,
      unhealthy,
    },
    observedAt,
  };
}

/** The findings of a record as lines for the inventory. */
export function gatewayReasons(g: GatewayData): string[] {
  return g.summary.unhealthy.map((u) =>
    reasonLine(
      u.listener === null ? "gateway" : `listener ${u.listener}`,
      u.condition,
      u.status,
      u.reason,
    )
  );
}

/** Swamp model for Gateway objects of the Kubernetes Gateway API. */
export const model = {
  type: "@dataverket/gateway-api/gateway",
  version: "2026.11.10.1",
  globalArguments: KubectlGlobalArgsSchema,
  checks: { "kubectl-cli-available": kubectlCliCheck },
  resources: {
    gateway: {
      description:
        "One Gateway: class, addresses, conditions, listeners with their conditions, and a summary to assert on",
      schema: GatewaySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    inventory: {
      description:
        "What one list saw: every Gateway by name, and the unhealthy ones with the reasons",
      schema: ListInventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "Read every Gateway of one namespace, or of every namespace, and record each with its listeners and conditions, plus an inventory of the list",
      arguments: z.object({
        namespace: z.string().optional().describe(
          "The namespace to list instead of the definition's. Left out or empty, the definition's namespace is read, and every namespace when that is empty too",
        ),
      }),
      execute: async (
        args: { namespace?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = listNamespace(args.namespace, context.globalArgs.namespace);
        context.logger.info("Listing Gateways in {namespace}", {
          namespace: ns || "every namespace",
        });
        const items = await listObjects(context, RESOURCE, "Gateway", ns);
        const observedAt = new Date().toISOString();
        const records = items.map((item) => parseGateway(item, observedAt));
        assertDistinctDataNames("Gateway", records);
        warnOnVersions(
          context.logger,
          "Gateways",
          records.map((r) => r.apiVersion),
        );

        const handles: unknown[] = [];
        for (const r of records) {
          handles.push(
            await context.writeResource(
              "gateway",
              dataName(r.namespace, r.name),
              r,
            ),
          );
        }
        const inventory = listInventory(
          ns || null,
          records.map((r) => ({
            namespace: r.namespace,
            name: r.name,
            apiVersion: r.apiVersion,
            healthy: r.summary.healthy,
            reasons: gatewayReasons(r),
          })),
          observedAt,
        );
        handles.push(
          await context.writeResource(
            "inventory",
            inventoryName(ns || null),
            inventory,
          ),
        );
        context.logger.info(
          "Recorded {count} Gateways, {unhealthy} not healthy",
          { count: inventory.count, unhealthy: inventory.unhealthyCount },
        );
        return { dataHandles: handles };
      },
    },

    get: {
      description:
        "Read one Gateway by name and record it with its listeners and conditions",
      arguments: z.object({
        name: z.string().min(1).describe("The Gateway's name"),
        namespace: z.string().optional().describe(
          "The Gateway's namespace. Left out or empty, the definition's namespace is used",
        ),
      }),
      execute: async (
        args: { name: string; namespace?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = requireNamespace(
          "get",
          args.namespace,
          context.globalArgs.namespace,
        );
        const name = checkName(args.name);
        context.logger.info("Reading Gateway {name} in {namespace}", {
          name,
          namespace: ns,
        });
        const item = await getObject(context, RESOURCE, "Gateway", name, ns);
        const record = parseGateway(item, new Date().toISOString());
        warnOnVersions(context.logger, "Gateway", [record.apiVersion]);
        const handle = await context.writeResource(
          "gateway",
          dataName(record.namespace, record.name),
          record,
        );
        context.logger.info(
          "Gateway {name}: healthy={healthy}, programmed={programmed}, {findings} findings",
          {
            name,
            healthy: record.summary.healthy,
            programmed: record.summary.programmed,
            findings: record.summary.unhealthy.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
