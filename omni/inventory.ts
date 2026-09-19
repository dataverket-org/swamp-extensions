/**
 * `@dataverket/omni/inventory` — Talos fleet discovery for swamp, via Omni.
 *
 * Omni (https://omni.siderolabs.com) is the control plane for fleets of Talos
 * Linux machines: it registers every machine, assigns machines to clusters, and
 * tracks their health. `discover` asks Omni for that fleet state and writes a
 * typed inventory — one `node` per machine, one `cluster` per cluster, and a
 * `summary` roll-up. `volumes` goes one step further for one cluster: through
 * Omni's Talos proxy it reads every machine's disks, partitions and EPHEMERAL
 * usage and writes one `volumeLayout` per node, the same shape
 * `@dataverket/talosctl/node` produces on a cluster without Omni.
 *
 * Forked from `@mccormick/omni` (MIT). Transport is the `omnictl` CLI, plus
 * `talosctl` for `volumes`, both authenticated with an Omni service account
 * passed through the environment. Strictly read-only. The service-account key
 * is supplied through a vault, marked sensitive, and redacted from logs and
 * error text.
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
  type CosiResource,
  getResources,
  type OmnictlOptions,
  talosctl,
  writeTalosconfig,
} from "./omnictl.ts";
import { mergeInventory } from "./transform.ts";
import { assertHttpsUrl } from "./util.ts";
import {
  buildLayout,
  forNode,
  parseConcatJson,
  parseUsage,
  VolumeLayoutSchema,
} from "./talos_layout.ts";

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
  talosctlPath: z.string().default("talosctl").describe(
    "Path to the talosctl binary (volumes only); override when not on PATH",
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
    warn(message: string, props?: Record<string, unknown>): void;
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
    talosctlPath: g.talosctlPath,
  };
}

/** One machine of a cluster as `ClusterMachineIdentity` names it. */
export interface Member {
  machineId: string;
  hostname: string;
  nodeIp: string;
}

/** Members of `cluster` from `omnictl get clustermachineidentity`, by hostname. */
export function clusterMembers(
  identities: CosiResource[],
  cluster: string,
): Member[] {
  const out: Member[] = [];
  for (const r of identities) {
    if ((r.metadata.labels ?? {})["omni.sidero.dev/cluster"] !== cluster) {
      continue;
    }
    const ips = Array.isArray(r.spec.nodeips)
      ? (r.spec.nodeips as unknown[]).filter((v): v is string =>
        typeof v === "string"
      )
      : [];
    if (ips.length === 0) continue;
    out.push({
      machineId: r.metadata.id,
      hostname: typeof r.spec.nodename === "string" && r.spec.nodename !== ""
        ? r.spec.nodename
        : r.metadata.id,
      nodeIp: ips[0],
    });
  }
  return out.sort((a, b) => a.hostname.localeCompare(b.hostname));
}

const VolumesArgs = z.object({
  cluster: z.string().min(1).describe("Omni cluster name"),
});

/**
 * `@dataverket/omni/inventory` — discovers every Talos machine and cluster an
 * Omni instance manages, and the disk layout of one cluster's machines.
 * Read-only.
 */
export const model = {
  type: "@dataverket/omni/inventory",
  version: "2026.09.19.1",
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
    volumeLayout: {
      description:
        "Disks, partitions by label, unallocated space and EPHEMERAL usage of one machine, read through Omni's Talos proxy",
      schema: VolumeLayoutSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
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
          context.logger.warn("omni: {note}", { note });
        }
        return { dataHandles: handles };
      },
    },
    volumes: {
      description:
        "For every machine in one cluster, through Omni's Talos proxy: disks, partitions (STATE, EPHEMERAL, u-<name>, ...), unallocated bytes on the system disk, and /var usage. One volumeLayout per node, one execution. Read-only.",
      arguments: VolumesArgs,
      execute: async (
        args: z.infer<typeof VolumesArgs>,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        const members = clusterMembers(
          await getResources("clustermachineidentity", opts, context.signal),
          args.cluster,
        );
        if (members.length === 0) {
          throw new Error(
            `cluster ${args.cluster} has no machines with node IPs in Omni`,
          );
        }
        context.logger.info(
          "omni: reading volumes of {count} machines in {cluster}",
          { count: members.length, cluster: args.cluster },
        );
        const cfg = await Deno.makeTempFile({ prefix: "omni-talosconfig-" });
        try {
          await writeTalosconfig(args.cluster, cfg, opts, context.signal);
          const nodes = members.map((m) => m.nodeIp);
          const get = (kind: string) =>
            talosctl(
              cfg,
              nodes,
              ["get", kind, "-o", "json"],
              opts,
              context.signal,
            )
              .then(parseConcatJson);
          const [disks, volumes, usageText] = await Promise.all([
            get("disks"),
            get("discoveredvolumes"),
            talosctl(
              cfg,
              nodes,
              ["usage", "-d", "1", "/var"],
              opts,
              context.signal,
            ),
          ]);
          const usage = parseUsage(usageText, nodes[0]);
          const ts = new Date().toISOString();
          const handles: DataHandle[] = [];
          for (const m of members) {
            const layout = buildLayout(
              m.hostname,
              m.nodeIp,
              forNode(disks, m.nodeIp),
              forNode(volumes, m.nodeIp),
              usage[m.nodeIp],
              ts,
            );
            context.logger.info(
              "{host}: EPHEMERAL {used}% of {size} GiB, {free} MiB unallocated",
              {
                host: m.hostname,
                used: layout.ephemeralUsedPercent,
                size: Math.round(layout.ephemeralSizeBytes / 2 ** 30 * 10) / 10,
                free: Math.round(layout.systemDiskUnallocatedBytes / 2 ** 20),
              },
            );
            handles.push(
              await context.writeResource(
                "volumeLayout",
                `volume-${sanitizeInstanceName(m.hostname)}`,
                layout,
              ),
            );
          }
          return { dataHandles: handles };
        } finally {
          await Deno.remove(cfg).catch(() => {});
        }
      },
    },
  },
};
