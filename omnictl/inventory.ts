/**
 * `@dataverket/omnictl/inventory` — Talos fleet discovery for swamp, via Omni.
 *
 * Omni (https://omni.siderolabs.com) is the control plane for fleets of Talos
 * Linux machines: it registers every machine, assigns machines to clusters, and
 * tracks their health. `discover` asks Omni for that fleet state and writes a
 * typed inventory — one `node` per machine, one `cluster` per cluster, and a
 * `summary` roll-up. `talosconfig` mints one cluster's admin talosconfig for
 * the service account and stores it, with the node IPs, as a resource, which is what a
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
import { type CosiResource, getResources, mintTalosconfig } from "./omnictl.ts";
import { mergeInventory } from "./transform.ts";
import {
  type DataHandle,
  GlobalArgs,
  type MethodContext,
  type MethodResult,
  optionsOf,
} from "./common.ts";

const TalosconfigArgs = z.object({
  cluster: z.string().min(1).describe("Omni cluster name"),
});

/**
 * How to reach one cluster: its admin talosconfig for the service account,
 * and the machines behind Omni's proxy. `nodes` is what a talosctl model
 * takes as its target list.
 */
export const TalosconfigSchema = z.object({
  cluster: z.string(),
  endpoint: z.string().describe("Omni endpoint the config routes through"),
  nodes: z.array(z.string()).describe(
    "Node IP of every machine in the cluster that has one, sorted by hostname",
  ),
  hostnames: z.array(z.string()).describe("Hostnames in the same order"),
  content: z.string().describe(
    "The talosconfig YAML: Omni's proxy endpoint and the service account's identity, inert without OMNI_SERVICE_ACCOUNT_KEY",
  ),
  timestamp: z.string(),
});

/**
 * One Omni join token as `JoinTokenStatus` reports it. The token is the
 * resource ID and is a secret: only a SHA-256 fingerprint is stored.
 */
export const JoinTokenSchema = z.object({
  name: z.string().describe("Name given when the token was created"),
  fingerprint: z.string().describe(
    "First 12 hex characters of the SHA-256 of the token; the token itself is never stored",
  ),
  state: z.string().describe("active, revoked, expired or unknown"),
  isDefault: z.boolean().describe(
    "Whether new installation media and kernel args use this token",
  ),
  useCount: z.number().int().describe("Machines that have joined with it"),
  expirationTime: z.string().nullable().describe(
    "RFC 3339, null when the token never expires",
  ),
  warnings: z.array(z.string()).default([]),
  timestamp: z.string(),
});

/** Omni `JoinTokenStatusSpec.State` enum values. */
const JOIN_TOKEN_STATES: Record<number, string> = {
  0: "unknown",
  1: "active",
  2: "revoked",
  3: "expired",
};

/** Map a `JoinTokenStatusSpec.State` integer or name to its lowercase name. */
export function decodeJoinTokenState(state: unknown): string {
  if (typeof state === "number") return JOIN_TOKEN_STATES[state] ?? "unknown";
  if (typeof state === "string" && state !== "") return state.toLowerCase();
  return "unknown";
}

/** SHA-256 of `text`, hex, first 12 characters. */
export async function fingerprint(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("")
    .slice(0, 12);
}

/** Fold one `JoinTokenStatus` resource into the stored shape, without the token. */
export async function joinTokenFromStatus(
  r: CosiResource,
  timestamp: string,
): Promise<z.infer<typeof JoinTokenSchema>> {
  const spec = r.spec;
  return {
    name: typeof spec.name === "string" ? spec.name : "",
    fingerprint: await fingerprint(r.metadata.id),
    state: decodeJoinTokenState(spec.state),
    isDefault: spec.isdefault === true,
    useCount: typeof spec.usecount === "number" ? spec.usecount : 0,
    expirationTime: typeof spec.expirationtime === "string" &&
        spec.expirationtime !== ""
      ? spec.expirationtime
      : null,
    warnings: Array.isArray(spec.warnings)
      ? spec.warnings.filter((w): w is string => typeof w === "string")
      : [],
    timestamp,
  };
}

/** One machine of a cluster as `ClusterMachineIdentity` names it. */
export interface Member {
  machineId: string;
  hostname: string;
  nodeIp: string;
}

/** Members of `cluster` with a node IP, from `clustermachineidentity`, by hostname. */
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

/**
 * `@dataverket/omnictl/inventory` — discovers every Talos machine and cluster an
 * Omni instance manages, and mints per-cluster talosconfigs. Read-only.
 */
export const model = {
  type: "@dataverket/omnictl/inventory",
  version: "2026.09.20.1",
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
        "How to reach one cluster: its admin talosconfig for the service account and its machines' node IPs; a talosctl model takes both by CEL. The config carries an identity, not a key",
      schema: TalosconfigSchema,
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
    joinToken: {
      description:
        "One Omni join token: name, state, default flag, how many machines joined with it, expiry. A fingerprint stands in for the token",
      schema: JoinTokenSchema,
      lifetime: "30d" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    joinTokens: {
      description:
        "List Omni's join tokens as joinToken resources: which is default, which are revoked or expired, and how many machines each has joined. The token itself is never stored, only a SHA-256 fingerprint. Read-only against Omni.",
      arguments: z.object({}),
      execute: async (
        _rawArgs: unknown,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        context.logger.info("omni: listing join tokens at {endpoint}", {
          endpoint: opts.endpoint,
        });
        const statuses = await getResources(
          "jointokenstatus",
          opts,
          context.signal,
        );
        const timestamp = new Date().toISOString();
        const handles: DataHandle[] = [];
        for (const r of statuses) {
          const token = await joinTokenFromStatus(r, timestamp);
          handles.push(
            await context.writeResource(
              "joinToken",
              `jointoken-${
                sanitizeInstanceName(token.name || token.fingerprint)
              }`,
              token,
            ),
          );
        }
        context.logger.info("omni: {count} join tokens", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
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
        "Mint one cluster's admin talosconfig for the service account and store it with the cluster's node IPs as a talosconfig resource. The config names an identity and Omni's proxy, no key; nothing is written to ~/.talos/config. Read-only against Omni.",
      arguments: TalosconfigArgs,
      execute: async (
        args: z.infer<typeof TalosconfigArgs>,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        context.logger.info("omni: minting talosconfig for {cluster}", {
          cluster: args.cluster,
        });
        const [content, identities] = await Promise.all([
          mintTalosconfig(args.cluster, opts, context.signal),
          getResources("clustermachineidentity", opts, context.signal),
        ]);
        const members = clusterMembers(identities, args.cluster);
        if (members.length === 0) {
          throw new Error(
            `cluster ${args.cluster} has no machines with node IPs in Omni`,
          );
        }
        const handle = await context.writeResource(
          "talosconfig",
          `talosconfig-${sanitizeInstanceName(args.cluster)}`,
          {
            cluster: args.cluster,
            endpoint: opts.endpoint,
            nodes: members.map((m) => m.nodeIp),
            hostnames: members.map((m) => m.hostname),
            content,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
