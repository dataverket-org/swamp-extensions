/**
 * `@dataverket/flux/source`: Flux source objects, GitRepository,
 * HelmRepository and OCIRepository, read with kubectl. `list` records every
 * source with its URL, reference, artifact revision and readiness; a kind
 * whose CRD is not installed is skipped and logged rather than failing the
 * run.
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
  FluxContext,
  FluxGlobalArgsSchema,
  FORK_VERSION,
  forkUpgrades,
  kubectlCliCheck,
  listArgs,
  narrowConditions,
  runKubectl,
  RunOpts,
} from "./_helpers.ts";

/** Recognised FluxCD source kinds. */
export const SOURCE_KINDS = [
  "GitRepository",
  "HelmRepository",
  "OCIRepository",
] as const;

/** One of the recognised source kinds. */
export type SourceKind = typeof SOURCE_KINDS[number];

/** kubectl resource type strings mapped from source kinds. */
export const KIND_TO_RESOURCE: Record<SourceKind, string> = {
  GitRepository: "gitrepositories.source.toolkit.fluxcd.io",
  HelmRepository: "helmrepositories.source.toolkit.fluxcd.io",
  OCIRepository: "ocirepositories.source.toolkit.fluxcd.io",
};

/** Artifact info from status.artifact. */
const ArtifactSchema = z.object({
  /** Current synced revision (e.g. refs/heads/main@sha1:abc123 or sha256:...). */
  revision: z.string().optional(),
  /** Digest of the artifact archive. */
  digest: z.string().optional(),
  /** When the artifact was last updated. */
  lastUpdateTime: z.string().optional(),
  /** Size of the artifact in bytes. */
  size: z.number().optional(),
});

/** Zod schema for a stored FluxCD source resource. */
export const SourceSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  /** Source kind: GitRepository, HelmRepository, or OCIRepository. */
  kind: z.enum(SOURCE_KINDS),
  ready: z.boolean(),
  readyReason: z.string(),
  readyMessage: z.string(),
  suspended: z.boolean(),
  /** Source URL (git remote, OCI registry URI, or Helm chart repo URL). */
  url: z.string(),
  /** Reconciliation interval (e.g. "1h0m0s"). */
  interval: z.string().optional(),
  /** Git/OCI reference details (branch, tag, semver, digest). */
  ref: z.record(z.string(), z.string()).optional(),
  artifact: ArtifactSchema.optional(),
  conditions: z.array(ConditionSchema),
  observedGeneration: z.number().optional(),
});

/** One stored source record. */
export type SourceData = z.infer<typeof SourceSchema>;

/** Reduce a source object as kubectl prints it to the stored record. */
export function parseSource(
  item: Record<string, unknown>,
  kind: SourceKind,
): SourceData {
  const meta = (item.metadata ?? {}) as Record<string, string>;
  const spec = (item.spec ?? {}) as Record<string, unknown>;
  const status = (item.status ?? {}) as Record<string, unknown>;
  const conditions = (status.conditions ?? []) as ConditionRaw[];
  const artifact = (status.artifact ?? undefined) as
    | Record<string, unknown>
    | undefined;
  const { ready, reason, message } = extractReadyCondition(conditions);

  return {
    name: meta.name,
    namespace: meta.namespace,
    kind,
    ready,
    readyReason: reason,
    readyMessage: message,
    suspended: (spec.suspend as boolean) ?? false,
    url: (spec.url as string) ?? "",
    interval: spec.interval as string | undefined,
    ref: spec.ref as Record<string, string> | undefined,
    artifact: artifact
      ? {
        revision: artifact.revision as string | undefined,
        digest: artifact.digest as string | undefined,
        lastUpdateTime: artifact.lastUpdateTime as string | undefined,
        size: artifact.size as number | undefined,
      }
      : undefined,
    conditions: narrowConditions(conditions),
    observedGeneration: status.observedGeneration as number | undefined,
  };
}

/**
 * Whether a kubectl failure says the CRD is absent. kubectl phrases it two
 * ways depending on how the type was named.
 */
export function isMissingCrd(message: string): boolean {
  return message.includes("no matches for kind") ||
    message.includes("the server doesn't have a resource type");
}

type Ctx = FluxContext<SourceData>;

/** Swamp model for FluxCD source objects (GitRepository, HelmRepository, OCIRepository). */
export const model = {
  type: "@dataverket/flux/source",
  version: FORK_VERSION,
  globalArguments: FluxGlobalArgsSchema,
  upgrades: forkUpgrades,
  checks: {
    "kubectl-cli-available": kubectlCliCheck,
  },
  resources: {
    source: {
      description:
        "FluxCD source status including URL, artifact revision, sync state, and conditions",
      schema: SourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    /**
     * List all FluxCD sources. By default queries GitRepository, HelmRepository,
     * and OCIRepository across all namespaces. Use the `kind` argument to filter.
     */
    list: {
      description:
        "List FluxCD sources (GitRepository, HelmRepository, OCIRepository) with artifact revisions and sync state",
      arguments: z.object({
        /** Override the namespace configured on the model. Empty = all namespaces. */
        namespace: z.string().optional(),
        /** Restrict to a single source kind. Omit to list all three. */
        kind: z.enum(SOURCE_KINDS).optional(),
      }),
      execute: async (
        args: { namespace?: string; kind?: SourceKind },
        context: Ctx,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = args.namespace ?? context.globalArgs.namespace;
        const opts: RunOpts = {
          kubeconfig: context.globalArgs.kubeconfig,
          context: context.globalArgs.context,
        };
        const kindsToQuery = args.kind ? [args.kind] : [...SOURCE_KINDS];

        context.logger.info("Listing {kinds} in {namespace}", {
          kinds: kindsToQuery.join(","),
          namespace: ns || "all namespaces",
        });

        const handles: unknown[] = [];
        for (const kind of kindsToQuery) {
          let data: { items?: Record<string, unknown>[] };
          try {
            data = (await runKubectl(
              listArgs(KIND_TO_RESOURCE[kind], ns),
              opts,
            )) as typeof data;
          } catch (err) {
            const msg = err instanceof Error ? err.message : String(err);
            if (isMissingCrd(msg)) {
              context.logger.info("Skipping {kind}: CRD not installed", {
                kind,
              });
              continue;
            }
            throw err;
          }
          const items = data.items ?? [];

          context.logger.info("Found {count} {kind}", {
            count: String(items.length),
            kind,
          });

          for (const item of items) {
            const parsed = parseSource(item, kind);
            handles.push(
              await context.writeResource(
                "source",
                `${parsed.kind}--${parsed.namespace}--${parsed.name}`,
                parsed,
              ),
            );
          }
        }
        return { dataHandles: handles };
      },
    },
  },
};
