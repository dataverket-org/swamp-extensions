/**
 * `@dataverket/talosctl/node` — Talos Linux machines through `talosctl`, with
 * or without Omni. Forked from `@magistr/talos-node` (MIT) and typed; the
 * upstream methods are kept (version, services, etcd members, kubeconfig,
 * apply and patch config, bootstrap, reboot, shutdown, reset, upgrade,
 * health) and one is added: `volumes`, the disk and partition layout of
 * every targeted node with how full EPHEMERAL is.
 *
 * Targets: `nodes` is the list of machines a method addresses (`--nodes`);
 * `endpoint` is where the API is reached (`--endpoints`) and doubles as the
 * only node when `nodes` is not given. With an Omni-issued talosconfig leave
 * `endpoint` unset: the config already points at Omni's proxy, and `nodes`
 * are the machines' addresses. A talosconfig can also be given as content
 * (`talosconfigContent`, from a vault or from `@dataverket/omni`'s
 * `talosconfig` resource); it is written to a private temporary file for each
 * call and removed afterwards.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { talosctl, type TalosctlOptions } from "./talosctl.ts";
import {
  buildLayout,
  forNode,
  hostnameOf,
  layoutProblem,
  parseConcatJson,
  parseUsage,
  sanitizeInstanceName,
  VolumeLayoutSchema,
} from "./layout.ts";

/** Global arguments of every `@dataverket/talosctl/node` instance. */
export const GlobalArgsSchema = z.object({
  endpoint: z.string().optional().describe(
    "Talos API endpoint (--endpoints); also the default node. Leave unset with an Omni talosconfig",
  ),
  nodes: z.array(z.string()).optional().describe(
    "Node addresses the methods target (--nodes); defaults to [endpoint]",
  ),
  talosconfig: z.string().optional().describe(
    "Path to a talosconfig; defaults to talosctl's own lookup",
  ),
  talosconfigContent: z.string().optional().describe(
    'A talosconfig\'s content, e.g. ${{ data.latest("omni", "talosconfig-<cluster>").attributes.content }}; used through a private temporary file, takes precedence over talosconfig',
  ).meta({ sensitive: true }),
  insecure: z.boolean().default(false).describe(
    "Use --insecure (maintenance mode, no client certificate)",
  ),
  talosctlPath: z.string().default("talosctl").describe(
    "Path to the talosctl binary; override when it is not on PATH",
  ),
  serviceAccountKey: z.string().optional().describe(
    "Omni service-account key for an Omni-issued talosconfig (OMNI_SERVICE_ACCOUNT_KEY); supply via a vault expression",
  ).meta({ sensitive: true }),
  retryDelayMs: z.number().int().min(0).default(15000).describe(
    "Pause between retries of transient API errors",
  ),
});
/** {@link GlobalArgsSchema} */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Handle returned by `writeResource`. */
export interface DataHandle {
  name: string;
}
/** The subset of the swamp logger the model uses. */
export interface Logger {
  info(message: string, props?: Record<string, unknown>): void;
  warning(message: string, props?: Record<string, unknown>): void;
}
/** The subset of the swamp method context the model uses. */
export interface ModelContext {
  globalArgs: GlobalArgs;
  logger: Logger;
  signal?: AbortSignal;
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

/**
 * Translate global arguments into transport options; throws with no target.
 * `--endpoints` is only emitted when `endpoint` stands alone: with an
 * explicit `nodes` list the talosconfig's endpoints (Omni's proxy, say) are
 * what should be used.
 */
export function options(g: GlobalArgs, insecure?: boolean): TalosctlOptions {
  const explicit = g.nodes !== undefined && g.nodes.length > 0;
  const nodes = explicit ? g.nodes! : g.endpoint ? [g.endpoint] : [];
  if (nodes.length === 0) {
    throw new Error("set globalArguments.nodes or globalArguments.endpoint");
  }
  const env: Record<string, string> = {};
  if (g.serviceAccountKey) env.OMNI_SERVICE_ACCOUNT_KEY = g.serviceAccountKey;
  return {
    talosctlPath: g.talosctlPath,
    talosconfig: g.talosconfig,
    talosconfigContent: g.talosconfigContent,
    endpoints: !explicit && g.endpoint ? [g.endpoint] : undefined,
    nodes,
    insecure: insecure ?? g.insecure,
    env,
    secrets: [g.serviceAccountKey, g.talosconfigContent].filter((
      s,
    ): s is string => Boolean(s)),
    retryDelayMs: g.retryDelayMs,
  };
}

const now = () => new Date().toISOString();

const VersionSchema = z.object({
  node: z.string(),
  tag: z.string(),
  sha: z.string().optional(),
  arch: z.string().optional(),
  platform: z.string().optional(),
  timestamp: z.string(),
});
const ServiceSchema = z.object({
  node: z.string(),
  id: z.string(),
  state: z.string(),
  health: z.string(),
  timestamp: z.string(),
});
const EtcdMemberSchema = z.object({
  hostname: z.string(),
  id: z.string(),
  peerUrls: z.array(z.string()),
  clientUrls: z.array(z.string()),
  isLearner: z.boolean(),
  timestamp: z.string(),
});
const KubeconfigSchema = z.object({
  kubeconfig: z.string().meta({ sensitive: true }),
  timestamp: z.string(),
});
const ResultSchema = z.object({
  success: z.boolean(),
  message: z.string(),
  warnings: z.array(z.string()).optional(),
  timestamp: z.string(),
});

/** Parse `talosctl services`: NODE SERVICE STATE HEALTH ... rows. */
export function parseServices(
  stdout: string,
): { node: string; id: string; state: string; health: string }[] {
  const out = [];
  for (const line of stdout.trim().split("\n").slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 4) continue;
    out.push({ node: p[0], id: p[1], state: p[2], health: p[3] });
  }
  return out;
}

/** Parse `talosctl etcd members`: NODE ID HOSTNAME PEER CLIENT LEARNER rows. */
export function parseEtcdMembers(stdout: string) {
  const out = [];
  for (const line of stdout.trim().split("\n").slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p.length < 6) continue;
    out.push({
      hostname: p[2],
      id: p[1],
      peerUrls: [p[3]],
      clientUrls: [p[4]],
      isLearner: p[5] === "true",
    });
  }
  return out;
}

const ApplyArgs = z.object({
  configFile: z.string().describe("Path to the machine config YAML file"),
  mode: z.enum(["auto", "reboot", "no-reboot", "staged"]).default("auto"),
  insecure: z.boolean().default(false).describe(
    "Override the global insecure flag (maintenance mode)",
  ),
});
const PatchArgs = z.object({
  patchFile: z.string().describe("Path to the YAML patch file"),
  mode: z.enum(["auto", "reboot", "no-reboot", "staged"]).default("auto"),
});

async function resultOf(
  context: ModelContext,
  name: string,
  message: string,
  warnings?: string,
): Promise<MethodResult> {
  const handle = await context.writeResource("result", name, {
    success: true,
    message,
    warnings: warnings
      ? warnings.split("\n").filter((l) => l.trim())
      : undefined,
    timestamp: now(),
  });
  return { dataHandles: [handle] };
}

/** Talos machines through `talosctl`: inspection, config, lifecycle. */
export const model = {
  type: "@dataverket/talosctl/node",
  version: "2026.09.19.2",
  globalArguments: GlobalArgsSchema,
  checks: {
    "talosctl-available": {
      description: "The talosctl binary runs and reports its client version",
      labels: ["live"],
      execute: async (context: { globalArgs: GlobalArgs }) => {
        try {
          await talosctl(
            { talosctlPath: context.globalArgs.talosctlPath, nodes: [] },
            ["version", "--client"],
          );
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [err instanceof Error ? err.message : String(err)],
          };
        }
      },
    },
    "talosconfig-exists": {
      description: "The talosconfig file exists when one is named",
      labels: ["policy"],
      execute: async (context: { globalArgs: GlobalArgs }) => {
        const p = context.globalArgs.talosconfig;
        if (!p || context.globalArgs.talosconfigContent) return { pass: true };
        // an empty content string is "unset": the path still has to exist
        try {
          await Deno.stat(p);
          return { pass: true };
        } catch {
          return { pass: false, errors: [`talosconfig not found: ${p}`] };
        }
      },
    },
  },
  resources: {
    version: {
      description: "Talos version of one node",
      schema: VersionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    service: {
      description: "State and health of one Talos service on one node",
      schema: ServiceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    etcdMember: {
      description: "One etcd cluster member",
      schema: EtcdMemberSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    kubeconfig: {
      description: "The cluster's admin kubeconfig",
      schema: KubeconfigSchema,
      sensitiveOutput: true,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    volumeLayout: {
      description:
        "Disks, partitions by label, unallocated space and EPHEMERAL usage of one node",
      schema: VolumeLayoutSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    result: {
      description: "Outcome of a lifecycle or config operation",
      schema: ResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    version: {
      description: "Read the Talos version of every targeted node",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = options(context.globalArgs);
        const handles: DataHandle[] = [];
        for (const node of opts.nodes) {
          const { stdout } = await talosctl({ ...opts, nodes: [node] }, [
            "version",
            "--json",
          ], { signal: context.signal });
          const data = JSON.parse(stdout);
          const ver = data.version ?? data.server?.version ?? {};
          handles.push(
            await context.writeResource(
              "version",
              `version-${sanitizeInstanceName(node)}`,
              {
                node,
                tag: ver.tag ?? "unknown",
                sha: ver.sha,
                arch: ver.arch,
                platform: data.platform?.name,
                timestamp: now(),
              },
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    services: {
      description: "List every service on every targeted node",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const { stdout } = await talosctl(options(context.globalArgs), [
          "services",
        ], { signal: context.signal });
        const handles: DataHandle[] = [];
        for (const s of parseServices(stdout)) {
          handles.push(
            await context.writeResource(
              "service",
              `service-${sanitizeInstanceName(`${s.node}-${s.id}`)}`,
              {
                ...s,
                timestamp: now(),
              },
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    etcdMembers: {
      description: "List the etcd cluster members",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const { stdout } = await talosctl(options(context.globalArgs), [
          "etcd",
          "members",
        ], { signal: context.signal });
        const handles: DataHandle[] = [];
        for (const m of parseEtcdMembers(stdout)) {
          handles.push(
            await context.writeResource(
              "etcdMember",
              `etcd-${sanitizeInstanceName(m.hostname)}`,
              {
                ...m,
                timestamp: now(),
              },
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    kubeconfig: {
      description: "Retrieve the cluster kubeconfig",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const { stdout } = await talosctl(options(context.globalArgs), [
          "kubeconfig",
          "-",
        ], { signal: context.signal });
        const handle = await context.writeResource("kubeconfig", "main", {
          kubeconfig: stdout,
          timestamp: now(),
        });
        return { dataHandles: [handle] };
      },
    },
    volumes: {
      description:
        "For every targeted node: disks, partitions (STATE, EPHEMERAL, u-<name>, ...), unallocated bytes on the system disk, and /var usage. One volumeLayout per node, one execution. Read-only.",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = options(context.globalArgs);
        const get = (kind: string) =>
          talosctl(opts, ["get", kind, "-o", "json"], {
            signal: context.signal,
          }).then((r) => parseConcatJson(r.stdout));
        const [disks, volumes, hostnames, usageText] = await Promise.all([
          get("disks"),
          get("discoveredvolumes"),
          get("hostname"),
          talosctl(opts, ["usage", "-d", "1", "/var"], {
            signal: context.signal,
          }).then((r) => r.stdout),
        ]);
        const usage = parseUsage(usageText, opts.nodes[0]);
        const ts = now();
        const handles: DataHandle[] = [];
        for (const node of opts.nodes) {
          const d = forNode(disks, node), v = forNode(volumes, node);
          const problem = layoutProblem(d, v, usage[node]);
          if (problem) {
            context.logger.warning("{node}: skipped, {problem}", {
              node,
              problem,
            });
            continue;
          }
          const layout = buildLayout(
            hostnameOf(hostnames, node),
            node,
            d,
            v,
            usage[node],
            ts,
          );
          context.logger.info(
            "{host}: EPHEMERAL {used}% of {size} GiB, {free} MiB unallocated",
            {
              host: layout.hostname,
              used: layout.ephemeralUsedPercent,
              size: Math.round(layout.ephemeralSizeBytes / 2 ** 30 * 10) / 10,
              free: Math.round(layout.systemDiskUnallocatedBytes / 2 ** 20),
            },
          );
          handles.push(
            await context.writeResource(
              "volumeLayout",
              `volume-${sanitizeInstanceName(layout.hostname)}`,
              layout,
            ),
          );
        }
        if (handles.length === 0) {
          throw new Error("no targeted node returned a usable disk layout");
        }
        return { dataHandles: handles };
      },
    },
    applyConfig: {
      description:
        "Apply a machine config (insecure=true for maintenance mode)",
      arguments: ApplyArgs,
      execute: async (
        args: z.infer<typeof ApplyArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = options(
          context.globalArgs,
          args.insecure || context.globalArgs.insecure,
        );
        const { stderr } = await talosctl(
          opts,
          ["apply-config", "--file", args.configFile, "--mode", args.mode],
          { retries: 12, signal: context.signal },
        );
        return await resultOf(
          context,
          "applyConfig",
          `Config applied to ${opts.nodes.join(",")} (mode=${args.mode})`,
          stderr,
        );
      },
    },
    bootstrap: {
      description: "Bootstrap etcd (run once, against the first control plane)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = options(context.globalArgs);
        await talosctl(opts, ["bootstrap"], {
          retries: 20,
          signal: context.signal,
        });
        return await resultOf(
          context,
          "bootstrap",
          `Bootstrap initiated on ${opts.nodes.join(",")}`,
        );
      },
    },
    reboot: {
      description: "Reboot the targeted nodes",
      arguments: z.object({
        mode: z.enum(["default", "powercycle"]).default("default"),
      }),
      execute: async (
        args: { mode: "default" | "powercycle" },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = options(context.globalArgs);
        const a = ["reboot"];
        if (args.mode === "powercycle") a.push("--mode", "powercycle");
        await talosctl(opts, a, { signal: context.signal });
        return await resultOf(
          context,
          "reboot",
          `Reboot (${args.mode}) initiated on ${opts.nodes.join(",")}`,
        );
      },
    },
    shutdown: {
      description: "Shut down the targeted nodes",
      arguments: z.object({ force: z.boolean().default(false) }),
      execute: async (
        args: { force: boolean },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = options(context.globalArgs);
        const a = ["shutdown"];
        if (args.force) a.push("--force");
        await talosctl(opts, a, { signal: context.signal });
        return await resultOf(
          context,
          "shutdown",
          `Shutdown initiated on ${opts.nodes.join(",")}`,
        );
      },
    },
    reset: {
      description:
        "Reset the targeted nodes: wipe the system disk, or only the named partitions",
      arguments: z.object({
        graceful: z.boolean().default(true).describe(
          "Cordon, drain and leave etcd first",
        ),
        reboot: z.boolean().default(false).describe(
          "Reboot after the reset instead of shutting down",
        ),
        systemLabelsToWipe: z.array(z.string()).optional().describe(
          "Wipe only these system partitions (e.g. [EPHEMERAL]); keeps STATE and the config",
        ),
      }),
      execute: async (
        args: {
          graceful: boolean;
          reboot: boolean;
          systemLabelsToWipe?: string[];
        },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = options(context.globalArgs);
        const a = ["reset"];
        if (!args.graceful) a.push("--graceful=false");
        if (args.reboot) a.push("--reboot");
        if (args.systemLabelsToWipe && args.systemLabelsToWipe.length > 0) {
          a.push("--system-labels-to-wipe", args.systemLabelsToWipe.join(","));
        }
        await talosctl(opts, a, { signal: context.signal });
        return await resultOf(
          context,
          "reset",
          `Reset initiated on ${
            opts.nodes.join(",")
          } (graceful=${args.graceful}` +
            (args.systemLabelsToWipe
              ? `, wipe=${args.systemLabelsToWipe.join(",")})`
              : ")"),
        );
      },
    },
    upgrade: {
      description: "Upgrade Talos on the targeted nodes",
      arguments: z.object({
        image: z.string().describe(
          "Installer image, e.g. ghcr.io/siderolabs/installer:v1.14.1",
        ),
        preserve: z.boolean().default(false).describe(
          "Preserve ephemeral data",
        ),
      }),
      execute: async (
        args: { image: string; preserve: boolean },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = options(context.globalArgs);
        const a = ["upgrade", "--image", args.image];
        if (args.preserve) a.push("--preserve");
        await talosctl(opts, a, { signal: context.signal });
        return await resultOf(
          context,
          "upgrade",
          `Upgrade to ${args.image} initiated on ${opts.nodes.join(",")}`,
        );
      },
    },
    patchConfig: {
      description: "Patch the machine config with a YAML patch file",
      arguments: PatchArgs,
      execute: async (
        args: z.infer<typeof PatchArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = options(context.globalArgs);
        const { stderr } = await talosctl(
          opts,
          [
            "patch",
            "machineconfig",
            "--patch-file",
            args.patchFile,
            "--mode",
            args.mode,
          ],
          { retries: 12, signal: context.signal },
        );
        return await resultOf(
          context,
          "patchConfig",
          `Config patched on ${opts.nodes.join(",")} (mode=${args.mode})`,
          stderr,
        );
      },
    },
    health: {
      description: "Run the cluster health check",
      arguments: z.object({
        waitTimeout: z.string().default("10s").describe(
          "How long to wait for the check to pass, e.g. 30s, 2m",
        ),
      }),
      execute: async (
        args: { waitTimeout: string },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const { stdout } = await talosctl(
          options(context.globalArgs),
          ["health", "--wait-timeout", args.waitTimeout],
          { signal: context.signal },
        );
        return await resultOf(
          context,
          "health",
          stdout.trim() || "Cluster healthy",
        );
      },
    },
  },
};
