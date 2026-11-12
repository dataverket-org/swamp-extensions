/**
 * `@dataverket/flux/helmrelease`: Flux HelmRelease objects, read with kubectl
 * and driven with the flux CLI. `list` records every release with its chart,
 * requested and applied versions, readiness and source; `reconcile`,
 * `suspend` and `resume` act on one release and record what it says
 * afterwards. `reset.ts` adds the reconcile with `--reset` and this type's
 * two CLI pre-flight checks; the other two types carry theirs directly.
 * `get.ts` adds the read of one release with its whole Helm history.
 *
 * Forked from `@ginger_pappa/flux` 2026.06.09.1 (MIT, copyright ginger_pappa).
 * Method names and the stored shape are upstream's; the spec is read
 * defensively and a release declared through `chartRef` reports that as its
 * source.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  assertDistinctDataNames,
  checkName,
  dataName,
  getArgs,
  kubectlOpts,
  listArgs,
  listItems,
  listNamespace,
  requireNamespace,
  runKubectl,
} from "../lib/kubectl.ts";
import {
  ConditionRaw,
  ConditionSchema,
  extractReadyCondition,
  FLUX_TIMEOUTS,
  FluxContext,
  FluxGlobalArgsSchema,
  forkUpgrades,
  listedNames,
  narrowConditions,
  reconcileTimeout,
  runFlux,
  SourceRefSchema,
} from "./_helpers.ts";

/** Zod schema for a stored HelmRelease resource. */
export const HelmReleaseSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  ready: z.boolean(),
  readyReason: z.string(),
  readyMessage: z.string(),
  suspended: z.boolean(),
  /** Chart name as declared in spec.chart.spec.chart. */
  chartName: z.string(),
  /** Version constraint from spec.chart.spec.version (may be a semver range). */
  requestedVersion: z.string(),
  /** Actual chart version from the last deployed history entry. */
  appliedVersion: z.string(),
  /** Application version embedded in the chart (appVersion field). */
  appVersion: z.string().optional(),
  /** Helm release status of the last deploy (deployed, failed, ...). */
  deployStatus: z.string().optional(),
  /** The chart's source: spec.chart.spec.sourceRef, or spec.chartRef. */
  sourceRef: SourceRefSchema,
  conditions: z.array(ConditionSchema),
  lastAttemptedRevision: z.string().optional(),
  lastHandledReconcileAt: z.string().optional(),
  observedGeneration: z.number().optional(),
});

/** One stored HelmRelease record. */
export type HelmReleaseData = z.infer<typeof HelmReleaseSchema>;

const RESOURCE = "helmreleases.helm.toolkit.fluxcd.io";

/** Reduce a HelmRelease object as kubectl prints it to the stored record. */
export function parseHelmRelease(
  item: Record<string, unknown>,
): HelmReleaseData {
  const meta = (item.metadata ?? {}) as Record<string, string>;
  const spec = (item.spec ?? {}) as Record<string, unknown>;
  const chartSpec = ((spec.chart as Record<string, unknown> | undefined)
    ?.spec ?? {}) as Record<string, unknown>;
  // A release built from a chart template names its source inside the
  // template; one built from an OCIRepository or HelmChart names it in
  // chartRef instead. Either way the record says where the chart comes from.
  const srcRef = (chartSpec.sourceRef ?? spec.chartRef ?? {}) as Record<
    string,
    string
  >;
  const status = (item.status ?? {}) as Record<string, unknown>;
  const conditions = (status.conditions ?? []) as ConditionRaw[];
  const history = (status.history ?? []) as Array<Record<string, unknown>>;
  const latest = history[0] ?? {};
  const { ready, reason, message } = extractReadyCondition(conditions);

  return {
    name: meta.name,
    namespace: meta.namespace,
    ready,
    readyReason: reason,
    readyMessage: message,
    suspended: (spec.suspend as boolean) ?? false,
    chartName: (chartSpec.chart as string) ?? "",
    requestedVersion: (chartSpec.version as string) ?? "*",
    appliedVersion: (latest.chartVersion as string) ?? "",
    appVersion: latest.appVersion as string | undefined,
    deployStatus: latest.status as string | undefined,
    sourceRef: {
      kind: srcRef.kind ?? "",
      name: srcRef.name ?? "",
      namespace: srcRef.namespace,
    },
    conditions: narrowConditions(conditions),
    lastAttemptedRevision: status.lastAttemptedRevision as string | undefined,
    lastHandledReconcileAt: status.lastHandledReconcileAt as string | undefined,
    observedGeneration: status.observedGeneration as number | undefined,
  };
}

type Ctx = FluxContext<HelmReleaseData>;

/** Read one release back and record it. */
async function recordOne(
  context: Ctx,
  name: string,
  ns: string,
): Promise<{ parsed: HelmReleaseData; handle: unknown }> {
  const updated = (await runKubectl(
    getArgs(RESOURCE, name, ns),
    kubectlOpts(context),
  )) as Record<string, unknown>;
  const parsed = parseHelmRelease(updated);
  const handle = await context.writeResource(
    "helmrelease",
    dataName(ns, name),
    parsed,
  );
  return { parsed, handle };
}

const OneArgs = z.object({
  /** HelmRelease name. */
  name: z.string().min(1),
  /** Namespace of the HelmRelease. Defaults to the model's namespace. */
  namespace: z.string().optional(),
});

/** Swamp model for FluxCD HelmRelease objects. */
export const model = {
  type: "@dataverket/flux/helmrelease",
  version: "2026.11.12.1",
  globalArguments: FluxGlobalArgsSchema,
  upgrades: [
    ...forkUpgrades,
    {
      toVersion: "2026.11.10.1",
      description:
        "get added with its detail record; the resetResult record is named reset.<namespace>--<name>; a name or namespace that is not a Kubernetes name is refused before flux or kubectl runs; every flux and kubectl call has a time limit; condition messages are stored with credentials blanked. No global argument and no stored field changed",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.11.12.1",
      description:
        "unit tests in the swamp skill's pattern; the bundled lib/ adds a 64 MiB output limit per command (a larger output is refused as too-large); global arguments unchanged",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  resources: {
    helmrelease: {
      description:
        "HelmRelease status including chart name, requested and applied versions, sync conditions, and source reference",
      schema: HelmReleaseSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    /** List HelmReleases across all namespaces (or a specific namespace). */
    list: {
      description:
        "List all HelmReleases with chart versions, ready status, and sync conditions",
      arguments: z.object({
        /** Override the namespace configured on the model. Empty = all namespaces. */
        namespace: z.string().optional(),
      }),
      execute: async (
        args: { namespace?: string },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = listNamespace(args.namespace, context.globalArgs.namespace);

        context.logger.info("Listing HelmReleases in {namespace}", {
          namespace: ns || "all namespaces",
        });

        const call = listArgs(RESOURCE, ns);
        const items = listItems(
          await runKubectl(call, kubectlOpts(context)),
          `kubectl ${call.join(" ")}`,
          "HelmRelease",
        );
        // Checked before the first write: a second record under one name
        // would silently replace the first.
        assertDistinctDataNames(
          "HelmRelease",
          listedNames(items, "HelmRelease"),
        );

        context.logger.info("Found {count} HelmReleases", {
          count: String(items.length),
        });

        const handles: unknown[] = [];
        for (const item of items) {
          const parsed = parseHelmRelease(item);
          handles.push(
            await context.writeResource(
              "helmrelease",
              dataName(parsed.namespace, parsed.name),
              parsed,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },

    /** Trigger an immediate reconciliation of a named HelmRelease. */
    reconcile: {
      description:
        "Trigger an immediate reconciliation of a HelmRelease, optionally including its source",
      arguments: OneArgs.extend({
        /** Also reconcile the upstream source (HelmRepository) before the release. */
        withSource: z.boolean().optional(),
      }),
      execute: async (
        args: { name: string; namespace?: string; withSource?: boolean },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        checkName(args.name);
        const ns = requireNamespace(
          "reconcile",
          args.namespace,
          context.globalArgs.namespace,
        );
        context.logger.info("Reconciling HelmRelease {name} in {namespace}", {
          name: args.name,
          namespace: ns,
        });

        const fluxArgs = ["reconcile", "helmrelease", args.name, "-n", ns];
        if (args.withSource) fluxArgs.push("--with-source");
        await runFlux(
          fluxArgs,
          kubectlOpts(context),
          reconcileTimeout("helmrelease", args.withSource),
        );

        const { parsed, handle } = await recordOne(context, args.name, ns);
        context.logger.info("Reconciliation complete, ready={ready}", {
          ready: String(parsed.ready),
        });
        return { dataHandles: [handle] };
      },
    },

    /** Suspend a HelmRelease to pause all reconciliation. */
    suspend: {
      description: "Suspend a HelmRelease to pause reconciliation",
      arguments: OneArgs,
      execute: async (
        args: { name: string; namespace?: string },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        checkName(args.name);
        const ns = requireNamespace(
          "suspend",
          args.namespace,
          context.globalArgs.namespace,
        );
        context.logger.info("Suspending HelmRelease {name} in {namespace}", {
          name: args.name,
          namespace: ns,
        });
        await runFlux(
          ["suspend", "helmrelease", args.name, "-n", ns],
          kubectlOpts(context),
          FLUX_TIMEOUTS.suspend,
        );
        const { parsed, handle } = await recordOne(context, args.name, ns);
        context.logger.info(
          "Suspended HelmRelease {name}: suspended={suspended}",
          { name: args.name, suspended: String(parsed.suspended) },
        );
        return { dataHandles: [handle] };
      },
    },

    /** Resume a suspended HelmRelease. */
    resume: {
      description: "Resume a previously suspended HelmRelease",
      arguments: OneArgs,
      execute: async (
        args: { name: string; namespace?: string },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        checkName(args.name);
        const ns = requireNamespace(
          "resume",
          args.namespace,
          context.globalArgs.namespace,
        );
        context.logger.info("Resuming HelmRelease {name} in {namespace}", {
          name: args.name,
          namespace: ns,
        });
        await runFlux(
          ["resume", "helmrelease", args.name, "-n", ns],
          kubectlOpts(context),
          FLUX_TIMEOUTS.resume,
        );
        const { parsed, handle } = await recordOne(context, args.name, ns);
        context.logger.info(
          "Resumed HelmRelease {name}: suspended={suspended}, ready={ready}",
          {
            name: args.name,
            suspended: String(parsed.suspended),
            ready: String(parsed.ready),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
