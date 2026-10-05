/**
 * `@dataverket/flux/kustomization`: Flux Kustomization objects, read with
 * kubectl and driven with the flux CLI. `list` records every Kustomization
 * with its source, path, applied and attempted revisions and readiness;
 * `reconcile`, `suspend` and `resume` act on one and record what it says
 * afterwards.
 *
 * Forked from `@ginger_pappa/flux` 2026.06.09.1 (MIT, copyright ginger_pappa).
 * Method names and the stored shape are upstream's.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  ConditionRaw,
  ConditionSchema,
  extractReadyCondition,
  fluxCliCheck,
  FluxContext,
  FluxGlobalArgsSchema,
  FORK_VERSION,
  forkUpgrades,
  kubectlCliCheck,
  listArgs,
  narrowConditions,
  requireNamespace,
  runFlux,
  runKubectl,
  RunOpts,
  SourceRefSchema,
} from "./_helpers.ts";

/** Zod schema for a stored FluxCD Kustomization resource. */
export const KustomizationSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  ready: z.boolean(),
  readyReason: z.string(),
  readyMessage: z.string(),
  suspended: z.boolean(),
  /** Path within the source repository. */
  path: z.string(),
  /** Whether to delete objects removed from the source. */
  prune: z.boolean(),
  sourceRef: SourceRefSchema,
  /** Namespace to deploy manifests into (may differ from the Kustomization namespace). */
  targetNamespace: z.string().optional(),
  /** Reconciliation interval (e.g. "10m0s"). */
  interval: z.string().optional(),
  /** Last successfully applied revision (branch@sha or tag@sha). */
  lastAppliedRevision: z.string().optional(),
  /** Last attempted revision (may differ from applied if it failed). */
  lastAttemptedRevision: z.string().optional(),
  conditions: z.array(ConditionSchema),
  observedGeneration: z.number().optional(),
});

/** One stored Kustomization record. */
export type KustomizationData = z.infer<typeof KustomizationSchema>;

const RESOURCE = "kustomizations.kustomize.toolkit.fluxcd.io";

/** Reduce a Kustomization object as kubectl prints it to the stored record. */
export function parseKustomization(
  item: Record<string, unknown>,
): KustomizationData {
  const meta = (item.metadata ?? {}) as Record<string, string>;
  const spec = (item.spec ?? {}) as Record<string, unknown>;
  const srcRef = (spec.sourceRef ?? {}) as Record<string, string>;
  const status = (item.status ?? {}) as Record<string, unknown>;
  const conditions = (status.conditions ?? []) as ConditionRaw[];
  const { ready, reason, message } = extractReadyCondition(conditions);

  return {
    name: meta.name,
    namespace: meta.namespace,
    ready,
    readyReason: reason,
    readyMessage: message,
    suspended: (spec.suspend as boolean) ?? false,
    path: (spec.path as string) ?? "./",
    prune: (spec.prune as boolean) ?? false,
    sourceRef: {
      kind: srcRef.kind ?? "",
      name: srcRef.name ?? "",
      namespace: srcRef.namespace,
    },
    targetNamespace: spec.targetNamespace as string | undefined,
    interval: spec.interval as string | undefined,
    lastAppliedRevision: status.lastAppliedRevision as string | undefined,
    lastAttemptedRevision: status.lastAttemptedRevision as string | undefined,
    conditions: narrowConditions(conditions),
    observedGeneration: status.observedGeneration as number | undefined,
  };
}

type Ctx = FluxContext<KustomizationData>;

function runOpts(context: Ctx): RunOpts {
  return {
    kubeconfig: context.globalArgs.kubeconfig,
    context: context.globalArgs.context,
  };
}

/** Read one Kustomization back and record it. */
async function recordOne(
  context: Ctx,
  name: string,
  ns: string,
): Promise<{ parsed: KustomizationData; handle: unknown }> {
  const updated = (await runKubectl(
    ["get", RESOURCE, name, "-n", ns],
    runOpts(context),
  )) as Record<string, unknown>;
  const parsed = parseKustomization(updated);
  const handle = await context.writeResource(
    "kustomization",
    `${ns}--${name}`,
    parsed,
  );
  return { parsed, handle };
}

const OneArgs = z.object({
  /** Kustomization name. */
  name: z.string().min(1),
  /** Namespace of the Kustomization. Defaults to the model's namespace. */
  namespace: z.string().optional(),
});

/** Swamp model for FluxCD Kustomization objects. */
export const model = {
  type: "@dataverket/flux/kustomization",
  version: FORK_VERSION,
  globalArguments: FluxGlobalArgsSchema,
  upgrades: forkUpgrades,
  checks: {
    "flux-cli-available": fluxCliCheck,
    "kubectl-cli-available": kubectlCliCheck,
  },
  resources: {
    kustomization: {
      description:
        "FluxCD Kustomization status including source reference, path, applied revision, and sync conditions",
      schema: KustomizationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    /** List Kustomizations across all namespaces (or a specific namespace). */
    list: {
      description:
        "List all FluxCD Kustomizations with applied revisions, paths, and sync conditions",
      arguments: z.object({
        /** Override the namespace configured on the model. Empty = all namespaces. */
        namespace: z.string().optional(),
      }),
      execute: async (
        args: { namespace?: string },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = args.namespace ?? context.globalArgs.namespace;

        context.logger.info("Listing Kustomizations in {namespace}", {
          namespace: ns || "all namespaces",
        });

        const data = (await runKubectl(
          listArgs(RESOURCE, ns),
          runOpts(context),
        )) as { items?: Record<string, unknown>[] };
        const items = data.items ?? [];

        context.logger.info("Found {count} Kustomizations", {
          count: String(items.length),
        });

        const handles: unknown[] = [];
        for (const item of items) {
          const parsed = parseKustomization(item);
          handles.push(
            await context.writeResource(
              "kustomization",
              `${parsed.namespace}--${parsed.name}`,
              parsed,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },

    /** Trigger an immediate reconciliation of a named Kustomization. */
    reconcile: {
      description:
        "Trigger an immediate reconciliation of a FluxCD Kustomization",
      arguments: OneArgs.extend({
        /** Also reconcile the upstream source before applying. */
        withSource: z.boolean().optional(),
      }),
      execute: async (
        args: { name: string; namespace?: string; withSource?: boolean },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = requireNamespace(
          "reconcile",
          args.namespace,
          context.globalArgs.namespace,
        );
        context.logger.info("Reconciling Kustomization {name} in {namespace}", {
          name: args.name,
          namespace: ns,
        });

        const fluxArgs = ["reconcile", "kustomization", args.name, "-n", ns];
        if (args.withSource) fluxArgs.push("--with-source");
        await runFlux(fluxArgs, runOpts(context));

        const { parsed, handle } = await recordOne(context, args.name, ns);
        context.logger.info("Reconciliation complete, ready={ready}", {
          ready: String(parsed.ready),
        });
        return { dataHandles: [handle] };
      },
    },

    /** Suspend a Kustomization to pause all reconciliation. */
    suspend: {
      description: "Suspend a FluxCD Kustomization to pause reconciliation",
      arguments: OneArgs,
      execute: async (
        args: { name: string; namespace?: string },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = requireNamespace(
          "suspend",
          args.namespace,
          context.globalArgs.namespace,
        );
        context.logger.info("Suspending Kustomization {name} in {namespace}", {
          name: args.name,
          namespace: ns,
        });
        await runFlux(
          ["suspend", "kustomization", args.name, "-n", ns],
          runOpts(context),
        );
        const { handle } = await recordOne(context, args.name, ns);
        return { dataHandles: [handle] };
      },
    },

    /** Resume a suspended Kustomization. */
    resume: {
      description: "Resume a previously suspended FluxCD Kustomization",
      arguments: OneArgs,
      execute: async (
        args: { name: string; namespace?: string },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = requireNamespace(
          "resume",
          args.namespace,
          context.globalArgs.namespace,
        );
        context.logger.info("Resuming Kustomization {name} in {namespace}", {
          name: args.name,
          namespace: ns,
        });
        await runFlux(
          ["resume", "kustomization", args.name, "-n", ns],
          runOpts(context),
        );
        const { handle } = await recordOne(context, args.name, ns);
        return { dataHandles: [handle] };
      },
    },
  },
};
