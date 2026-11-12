/**
 * `@dataverket/gateway-api/gatewayclass`: GatewayClass objects of the
 * Kubernetes Gateway API, read with kubectl. A Gateway whose class no
 * controller accepted gets no status at all, so the class is the first thing
 * to read when a Gateway reports nothing.
 *
 * `list` records every GatewayClass and an inventory; `get` records one. A
 * class that is not accepted is recorded, never thrown.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  arr,
  checkName,
  ConditionSchema,
  conditionState,
  dataName,
  findCondition,
  inventoryName,
  kubectlCliCheck,
  KubectlGlobalArgsSchema,
  obj,
  readConditions,
  readMeta,
  strOrNull,
} from "../lib/kubectl.ts";
import {
  conditionsCurrent,
  getObject,
  GROUP,
  listInventory,
  ListInventorySchema,
  listObjects,
  type MethodContext,
  reasonLine,
  warnOnVersions,
} from "./_helpers.ts";

/** The resource, by its full group, as kubectl is asked for it. */
export const RESOURCE = `gatewayclasses.${GROUP}`;

const UnhealthySchema = z.object({
  condition: z.string().nullable().describe(
    "The condition that is not as it should be; null for a status that is old",
  ),
  status: z.string().nullable(),
  reason: z.string().nullable(),
  message: z.string().nullable(),
});

type Unhealthy = z.infer<typeof UnhealthySchema>;

/** Zod schema for a stored GatewayClass. */
export const GatewayClassSchema = z.object({
  name: z.string(),
  apiVersion: z.string(),
  generation: z.number().nullable(),
  controllerName: z.string().nullable(),
  description: z.string().nullable(),
  parametersRef: z.object({
    group: z.string(),
    kind: z.string(),
    name: z.string(),
    namespace: z.string().nullable(),
  }).nullable(),
  supportedFeatures: z.array(z.string()),
  conditions: z.array(ConditionSchema),
  summary: z.object({
    accepted: z.boolean().nullable().describe(
      "The Accepted condition; null when missing or Unknown",
    ),
    acceptedReason: z.string().nullable(),
    acceptedMessage: z.string().nullable(),
    supportedVersion: z.boolean().nullable().describe(
      "The SupportedVersion condition: false when the controller does not support the Gateway API CRDs installed; null when missing or Unknown",
    ),
    statusCurrent: z.boolean().nullable().describe(
      "false when a condition was observed at an older generation than the object has now",
    ),
    healthy: z.boolean().describe(
      "Accepted is True, SupportedVersion is not False, and status is current",
    ),
    unhealthy: z.array(UnhealthySchema).describe(
      "Every finding that keeps healthy false, with the controller's reason",
    ),
  }),
  observedAt: z.iso.datetime(),
});

/** One stored GatewayClass record. */
export type GatewayClassData = z.infer<typeof GatewayClassSchema>;

/** Reduce a GatewayClass object as kubectl prints it to the stored record. */
export function parseGatewayClass(
  item: Record<string, unknown>,
  observedAt: string,
): GatewayClassData {
  const meta = readMeta(item, false, "GatewayClass");
  const spec = obj(item.spec);
  const status = obj(item.status);
  const conditions = readConditions(status.conditions);
  const accepted = conditionState(conditions, "Accepted");
  const acceptedCondition = findCondition(conditions, "Accepted");
  const statusCurrent = conditionsCurrent(meta.generation, conditions);
  const supported = findCondition(conditions, "SupportedVersion");
  const unhealthy: Unhealthy[] = [];
  if (accepted !== true) {
    unhealthy.push({
      condition: "Accepted",
      status: acceptedCondition?.status ?? null,
      reason: acceptedCondition?.reason ?? "NotReported",
      message: acceptedCondition
        ? acceptedCondition.message
        : "no Accepted condition is reported",
    });
  }
  // A controller may accept a class on CRDs of a version it does not know
  // ("best effort") and say so here; only False is a finding.
  if (supported?.status === "False") {
    unhealthy.push({
      condition: "SupportedVersion",
      status: supported.status,
      reason: supported.reason,
      message: supported.message,
    });
  }
  if (statusCurrent === false) {
    unhealthy.push({
      condition: null,
      status: null,
      reason: "StaleStatus",
      message:
        `a condition was observed before generation ${meta.generation}; the controller has not yet reported on the object as it is now`,
    });
  }
  const params = spec.parametersRef === undefined || spec.parametersRef === null
    ? null
    : obj(spec.parametersRef);
  return {
    name: meta.name,
    apiVersion: meta.apiVersion,
    generation: meta.generation,
    controllerName: strOrNull(spec.controllerName),
    description: strOrNull(spec.description),
    parametersRef: params === null ? null : {
      group: strOrNull(params.group) ?? "",
      kind: strOrNull(params.kind) ?? "",
      name: strOrNull(params.name) ?? "",
      namespace: strOrNull(params.namespace),
    },
    // Features are objects with a name since Gateway API v1.2, strings before.
    supportedFeatures: arr(status.supportedFeatures)
      .map((f) => typeof f === "string" ? f : strOrNull(obj(f).name))
      .filter((f): f is string => f !== null && f !== ""),
    conditions,
    summary: {
      accepted,
      acceptedReason: acceptedCondition?.reason ?? null,
      acceptedMessage: acceptedCondition?.message ?? null,
      supportedVersion: conditionState(conditions, "SupportedVersion"),
      statusCurrent,
      healthy: unhealthy.length === 0,
      unhealthy,
    },
    observedAt,
  };
}

/** Why a class is not healthy, as lines for the inventory. */
export function classReasons(c: GatewayClassData): string[] {
  return c.summary.unhealthy.map((u) =>
    reasonLine("class", u.condition, u.status, u.reason)
  );
}

/** Swamp model for GatewayClass objects of the Kubernetes Gateway API. */
export const model = {
  type: "@dataverket/gateway-api/gatewayclass",
  version: "2026.11.12.1",
  globalArguments: KubectlGlobalArgsSchema,
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
  checks: { "kubectl-cli-available": kubectlCliCheck },
  resources: {
    gatewayclass: {
      description:
        "One GatewayClass: its controller, parameters reference, supported features and the Accepted condition",
      schema: GatewayClassSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    inventory: {
      description:
        "What one list saw: every GatewayClass by name, and the ones not accepted with the reason",
      schema: ListInventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "Read every GatewayClass of the cluster and record each with its controller and Accepted condition, plus an inventory of the list",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        context.logger.info("Listing GatewayClasses");
        const items = await listObjects(
          context,
          RESOURCE,
          "GatewayClass",
          null,
        );
        const observedAt = new Date().toISOString();
        const records = items.map((item) =>
          parseGatewayClass(item, observedAt)
        );
        warnOnVersions(
          context.logger,
          "GatewayClasses",
          records.map((r) => r.apiVersion),
        );

        const handles: unknown[] = [];
        for (const r of records) {
          handles.push(
            await context.writeResource(
              "gatewayclass",
              dataName(null, r.name),
              r,
            ),
          );
        }
        const inventory = listInventory(
          null,
          records.map((r) => ({
            namespace: null,
            name: r.name,
            apiVersion: r.apiVersion,
            healthy: r.summary.healthy,
            reasons: classReasons(r),
          })),
          observedAt,
        );
        handles.push(
          await context.writeResource(
            "inventory",
            inventoryName(null),
            inventory,
          ),
        );
        context.logger.info(
          "Recorded {count} GatewayClasses, {unhealthy} not accepted",
          { count: inventory.count, unhealthy: inventory.unhealthyCount },
        );
        return { dataHandles: handles };
      },
    },

    get: {
      description: "Read one GatewayClass by name and record it",
      arguments: z.object({
        name: z.string().min(1).describe("The GatewayClass's name"),
      }),
      execute: async (
        args: { name: string },
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const name = checkName(args.name);
        context.logger.info("Reading GatewayClass {name}", { name });
        const item = await getObject(
          context,
          RESOURCE,
          "GatewayClass",
          name,
          null,
        );
        const record = parseGatewayClass(item, new Date().toISOString());
        warnOnVersions(context.logger, "GatewayClass", [record.apiVersion]);
        const handle = await context.writeResource(
          "gatewayclass",
          dataName(null, record.name),
          record,
        );
        context.logger.info("GatewayClass {name}: accepted={accepted}", {
          name,
          accepted: record.summary.accepted,
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
