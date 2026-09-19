/**
 * `@dataverket/omni/inventory` — Talos fleet discovery for swamp, via Omni.
 *
 * Omni (https://omni.siderolabs.com) is the control plane for fleets of Talos
 * Linux machines: it registers every machine, assigns machines to clusters, and
 * tracks their health. `discover` asks Omni for that fleet state and writes a
 * typed inventory — one `node` per machine, one `cluster` per cluster, and a
 * `summary` roll-up. `talosconfig` mints one cluster's admin talosconfig for
 * the service account and stores it as a sensitive resource, which is what a
 * `@dataverket/talosctl/node` model needs to speak to the machines through
 * Omni's proxy; everything said to the Talos API itself lives on that model.
 *
 * Forked from `@mccormick/omni` (MIT). Transport is the `omnictl` CLI,
 * authenticated with an Omni service account passed through the environment.
 * Strictly read-only against Omni. The service-account key is supplied through
 * a vault, marked sensitive, and redacted from logs and error text.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  ClusterSchema,
  NodeSchema,
  sanitizeInstanceName,
  SummarySchema,
} from "./schema.ts";
import {
  getResources,
  mintTalosconfig,
  type OmnictlOptions,
} from "./omnictl.ts";
import { mergeInventory } from "./transform.ts";
import { assertHttpsUrl } from "./util.ts";

/** Global arguments for the Omni inventory model. */
const GlobalArgs = z.object({
  endpoint: z.string().describe(
    "Omni API endpoint, e.g. https://omni.example.net",
  ),
  serviceAccountKey: z.string().describe(
    "Omni service-account key (OMNI_SERVICE_ACCOUNT_KEY); supply via " +
      '${{ vault.get("omni", "OMNI_SERVICE_ACCOUNT_KEY") }}',
  ).meta({ sensitive: true }),
  insecureSkipTlsVerify: z.boolean().default(false).describe(
    "Skip TLS verification for the Omni API (use only for self-signed certs)",
  ),
  omnictlPath: z.string().default("omnictl").describe(
    "Path to the omnictl binary; override when it is not on PATH",
  ),
});
/** {@link GlobalArgs} */
export type GlobalArgsData = z.infer<typeof GlobalArgs>;

/** Handle returned by `writeResource`. */
export interface DataHandle {
  name: string;
}
/** The subset of the swamp method context the model uses. */
export interface MethodContext {
  globalArgs: GlobalArgsData;
  signal?: AbortSignal;
  logger: {
    info(message: string, props?: Record<string, unknown>): void;
    warning(message: string, props?: Record<string, unknown>): void;
  };
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandle>;
}
/** What every `execute` returns. */
export interface MethodResult {
  dataHandles: DataHandle[];
}

function optionsOf(g: GlobalArgsData): OmnictlOptions {
  const endpoint = assertHttpsUrl(g.endpoint, "endpoint");
  if (!g.serviceAccountKey) {
    throw new Error("serviceAccountKey is required to query Omni");
  }
  return {
    endpoint,
    serviceAccountKey: g.serviceAccountKey,
    insecureSkipTlsVerify: g.insecureSkipTlsVerify,
    omnictlPath: g.omnictlPath,
  };
}

const TalosconfigArgs = z.object({
  cluster: z.string().min(1).describe("Omni cluster name"),
});

/** A cluster's admin talosconfig for the service account. */
export const TalosconfigSchema = z.object({
  cluster: z.string(),
  endpoint: z.string().describe("Omni endpoint the config routes through"),
  content: z.string().describe("The talosconfig YAML").meta({
    sensitive: true,
  }),
  timestamp: z.string(),
});

/**
 * `@dataverket/omni/inventory` — discovers every Talos machine and cluster an
 * Omni instance manages, and mints per-cluster talosconfigs. Read-only.
 */
export const model = {
  type: "@dataverket/omni/inventory",
  version: "2026.09.19.2",
  globalArguments: GlobalArgs,
  resources: {
    node: {
      description: "An Omni-managed Talos machine",
      schema: NodeSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    cluster: {
      description: "A Talos cluster managed by Omni",
      schema: ClusterSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    summary: {
      description: "Roll-up of one Omni inventory run",
      schema: SummarySchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    talosconfig: {
      description:
        "One cluster's admin talosconfig for the service account; feed it to a talosctl model as talosconfigContent",
      schema: TalosconfigSchema,
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    discover: {
      description:
        "Query Omni for every managed Talos machine and cluster and write " +
        "one node resource per machine, one cluster resource per cluster, " +
        "and a summary roll-up.",
      arguments: z.object({}),
      execute: async (
        _rawArgs: unknown,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        context.logger.info("omni: discovering machines at {endpoint}", {
          endpoint: opts.endpoint,
        });
        // Read-only COSI queries — independent, so fetched concurrently. Any
        // failure rejects here, before a single resource is written.
        const [
          machineStatuses,
          clusterMachineStatuses,
          clusterMachineIdentities,
          clusters,
        ] = await Promise.all([
          getResources("machinestatus", opts, context.signal),
          getResources("clustermachinestatus", opts, context.signal),
          getResources("clustermachineidentity", opts, context.signal),
          getResources("cluster", opts, context.signal),
        ]);
        const merged = mergeInventory({
          endpoint: opts.endpoint,
          machineStatuses,
          clusterMachineStatuses,
          clusterMachineIdentities,
          clusters,
        }, new Date().toISOString());

        const handles: DataHandle[] = [];
        for (const node of merged.nodes) {
          handles.push(
            await context.writeResource(
              "node",
              `node-${sanitizeInstanceName(node.id)}`,
              node,
            ),
          );
        }
        for (const cluster of merged.clusters) {
          handles.push(
            await context.writeResource(
              "cluster",
              `cluster-${sanitizeInstanceName(cluster.name)}`,
              cluster,
            ),
          );
        }
        handles.push(
          await context.writeResource("summary", "summary", merged.summary),
        );
        context.logger.info(
          "omni: discovered {nodes} nodes across {clusters} clusters " +
            "({connected} connected)",
          {
            nodes: merged.summary.totalNodes,
            clusters: merged.summary.clusterCount,
            connected: merged.summary.connectedCount,
          },
        );
        for (const note of merged.summary.notes) {
          context.logger.warning("omni: {note}", { note });
        }
        return { dataHandles: handles };
      },
    },
    talosconfig: {
      description:
        "Mint one cluster's admin talosconfig for the service account and store it as a sensitive talosconfig resource. Nothing is written to ~/.talos/config. Read-only against Omni.",
      arguments: TalosconfigArgs,
      execute: async (
        args: z.infer<typeof TalosconfigArgs>,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        context.logger.info("omni: minting talosconfig for {cluster}", {
          cluster: args.cluster,
        });
        const content = await mintTalosconfig(
          args.cluster,
          opts,
          context.signal,
        );
        const handle = await context.writeResource(
          "talosconfig",
          `talosconfig-${sanitizeInstanceName(args.cluster)}`,
          {
            cluster: args.cluster,
            endpoint: opts.endpoint,
            content,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
