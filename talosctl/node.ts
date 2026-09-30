/**
 * `@dataverket/talosctl/node` — Talos Linux machines through `talosctl`, with
 * or without Omni. Forked from `@magistr/talos-node` (MIT) and typed; the
 * upstream methods are kept (version, services, etcd members, kubeconfig,
 * apply and patch config, bootstrap, reboot, shutdown, reset, upgrade,
 * health) and four are added: `volumes`, the disk and partition layout of
 * every targeted node with how full EPHEMERAL is; `etcdStatus`, every control
 * plane's view of etcd; `serviceLogs`, a service's recent log lines counted
 * in a time window; and `processes`, the top processes per node.
 *
 * Every method takes `nodes`, a subset of the definition's targets for that
 * call, so a definition can name a whole cluster while a reboot touches one
 * machine. Commands only control planes answer (etcd, health) are sent only
 * to the targets whose machine type says so, asked one node at a time, so a
 * worker in the list or a control plane mid-reboot does not fail the call.
 *
 * Targets: `nodes` is the list of machines a method addresses (`--nodes`);
 * `endpoint` is where the API is reached (`--endpoints`) and doubles as the
 * only node when `nodes` is not given. `talosContext` names the context in the
 * talosconfig (`--context`); without it talosctl uses whichever context is
 * current, which a definition does not control. With an Omni-issued talosconfig leave
 * `endpoint` unset: the config already points at Omni's proxy, and `nodes`
 * are the machines' addresses. A talosconfig can also be given as content
 * (`talosconfigContent`, from a vault or from `@dataverket/omni`'s
 * `talosconfig` resource); it is written to a private temporary file for each
 * call and removed afterwards.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { readSecretFile, talosctl, type TalosctlOptions } from "./talosctl.ts";
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
import {
  parseLogs,
  parsePercent,
  parseSeconds,
  parseSize,
  parseTable,
} from "./tables.ts";

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
  talosContext: z.string().optional().describe(
    "Context in the talosconfig to use (--context), e.g. the cluster's name; without it talosctl uses the config's current context, which is whatever was selected last",
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
  serviceAccountKeyFile: z.string().optional().describe(
    "Path to a file holding the Omni service-account key, read at call time, e.g. ~/.talos/omni/<name>.key, for a key an operator's session writes and rotates; the path is not a secret, so the definition carries no value",
  ),
  serviceAccountKey: z.string().optional().describe(
    "Omni service-account key for an Omni-issued talosconfig (OMNI_SERVICE_ACCOUNT_KEY) as a value, for a key the process owns; supply via a vault expression. Mutually exclusive with serviceAccountKeyFile",
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
 * The talosctl binary, defaulted as the schema does. A check runs with the
 * definition's global arguments as written, without the schema's defaults
 * applied, so a definition that never mentions talosctlPath leaves it
 * undefined there; spawning with that is what "missing field `cmd`" means.
 * Methods get the defaults, so this only matters to a check, and having one
 * place for the fallback keeps the two from drifting.
 */
export function talosctlPathOf(g: Partial<GlobalArgs>): string {
  return g.talosctlPath || "talosctl";
}

/**
 * The Omni service-account key, read from the file when one is named and
 * taken from the argument otherwise; undefined when neither is set, which is
 * the plain-talosctl case where the talosconfig carries a client certificate.
 * Both at once is a mistake worth naming rather than resolving by precedence.
 */
export function serviceAccountKey(g: GlobalArgs): string | undefined {
  if (g.serviceAccountKeyFile && g.serviceAccountKey) {
    throw new Error("set serviceAccountKeyFile or serviceAccountKey, not both");
  }
  if (g.serviceAccountKeyFile) {
    return readSecretFile(g.serviceAccountKeyFile, "serviceAccountKeyFile");
  }
  return g.serviceAccountKey;
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
  const key = serviceAccountKey(g);
  const env: Record<string, string> = {};
  if (key) env.OMNI_SERVICE_ACCOUNT_KEY = key;
  return {
    talosctlPath: talosctlPathOf(g),
    talosconfig: g.talosconfig,
    talosconfigContent: g.talosconfigContent,
    context: g.talosContext,
    endpoints: !explicit && g.endpoint ? [g.endpoint] : undefined,
    nodes,
    insecure: insecure ?? g.insecure,
    env,
    secrets: [key, g.talosconfigContent].filter((
      s,
    ): s is string => Boolean(s)),
    retryDelayMs: g.retryDelayMs,
  };
}

const now = () => new Date().toISOString();

/**
 * The `nodes` argument every method takes: a subset of the definition's
 * targets for this one call. Without it a call addresses every target, which
 * for a lifecycle method such as `reboot` is the whole fleet.
 */
const NodesArg = z.array(z.string()).min(1).optional().describe(
  "Only these of the definition's nodes, for this call; each must be one of the targets",
);
const NodesOnly = z.object({ nodes: NodesArg });
type NodesOnlyArgs = z.infer<typeof NodesOnly>;

/**
 * Narrow transport options to `nodes`, which must all be targets already: an
 * argument may shrink what a definition reaches, never widen it.
 */
export function narrow(
  opts: TalosctlOptions,
  nodes?: string[],
): TalosctlOptions {
  if (!nodes || nodes.length === 0) return opts;
  const stray = nodes.filter((n) => !opts.nodes.includes(n));
  if (stray.length > 0) {
    throw new Error(
      `not among the definition's nodes: ${stray.join(", ")} ` +
        `(targets: ${opts.nodes.join(", ")})`,
    );
  }
  return { ...opts, nodes };
}

/** One node's outcome of a call made to each node on its own. */
export type PerNode<T> =
  | { node: string; ok: true; value: T }
  | { node: string; ok: false; error: string };

/**
 * Run `fn` for every targeted node, one talosctl call per node, in parallel.
 * A fan-out call fails as a whole when one node is down or refuses the
 * command, which is the normal state of a node mid-reboot or of a worker
 * asked about etcd; one call per node keeps the other answers.
 */
export function perNode<T>(
  opts: TalosctlOptions,
  fn: (one: TalosctlOptions, node: string) => Promise<T>,
): Promise<PerNode<T>[]> {
  return Promise.all(opts.nodes.map(async (node): Promise<PerNode<T>> => {
    try {
      const value = await fn({ ...opts, nodes: [node] }, node);
      return { node, ok: true, value };
    } catch (err) {
      return {
        node,
        ok: false,
        error: err instanceof Error ? err.message : String(err),
      };
    }
  }));
}

/** True for the machine types that run etcd: `controlplane`, legacy `init`. */
export function isControlPlaneType(type: unknown): boolean {
  return type === "controlplane" || type === "init";
}

/**
 * The targeted nodes that are control planes, in target order, read from each
 * node's `machinetype` resource. A node that does not answer is left out with
 * a warning, so a control plane mid-reboot does not stop a call to the others.
 */
export async function controlPlanes(
  opts: TalosctlOptions,
  context: Pick<ModelContext, "logger" | "signal">,
): Promise<string[]> {
  const types = await perNode(opts, async (one) => {
    const { stdout } = await talosctl(one, [
      "get",
      "machinetype",
      "-o",
      "json",
    ], { signal: context.signal });
    return parseConcatJson(stdout)[0]?.spec;
  });
  const out: string[] = [];
  for (const t of types) {
    if (!t.ok) {
      context.logger.warning(
        "{node}: machine type unknown, left out: {error}",
        {
          node: t.node,
          error: t.error,
        },
      );
    } else if (isControlPlaneType(t.value)) out.push(t.node);
  }
  if (out.length === 0) {
    throw new Error(
      `no control plane among the reachable targets (${opts.nodes.join(", ")})`,
    );
  }
  return out;
}

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
const EtcdStatusSchema = z.object({
  node: z.string(),
  reachable: z.boolean().describe(
    "false when the control plane did not answer; the fields below are then absent",
  ),
  error: z.string().optional(),
  member: z.string().optional(),
  leader: z.string().optional(),
  isLeader: z.boolean().optional(),
  dbSizeBytes: z.number().optional(),
  dbInUseBytes: z.number().optional(),
  dbInUsePercent: z.number().optional(),
  raftIndex: z.number().optional(),
  raftTerm: z.number().optional(),
  raftAppliedIndex: z.number().optional(),
  isLearner: z.boolean().optional(),
  protocol: z.string().optional(),
  storage: z.string().optional(),
  errors: z.string().optional().describe(
    "etcd's own ERRORS column, e.g. an alarm; empty when healthy",
  ),
  timestamp: z.string(),
});
const ServiceLogSchema = z.object({
  node: z.string(),
  service: z.string(),
  tail: z.number(),
  match: z.string().optional(),
  sinceSeconds: z.number().optional(),
  read: z.number().describe("Lines read, at most tail"),
  counted: z.number().describe(
    "Lines inside the time window (all read lines without sinceSeconds)",
  ),
  matched: z.number().describe(
    "Counted lines matching `match` (equal to counted without it)",
  ),
  oldest: z.string().optional().describe(
    "Time of the oldest counted line that carries one",
  ),
  newest: z.string().optional(),
  lines: z.array(z.string()).describe(
    "The newest `keep` matching lines, oldest first",
  ),
  timestamp: z.string(),
});
const ProcessSchema = z.object({
  pid: z.number(),
  state: z.string(),
  threads: z.number().optional(),
  cpuSeconds: z.number().optional().describe(
    "CPU time used since the process started",
  ),
  virtualBytes: z.number().optional(),
  residentBytes: z.number().optional(),
  label: z.string().optional().describe("SELinux label, e.g. ...:etcd_t:s0"),
  executable: z.string().describe(
    "The command's first word only; arguments can carry secrets",
  ),
});
const ProcessesSchema = z.object({
  node: z.string(),
  sort: z.enum(["cpu", "rss"]),
  processes: z.array(ProcessSchema),
  timestamp: z.string(),
});

/** One `talosctl etcd status` row as an {@link EtcdStatusSchema} record. */
export function etcdStatusRecord(row: Record<string, string>) {
  const num = (k: string) => {
    const n = Number(row[k]);
    return row[k] !== undefined && row[k] !== "" && Number.isFinite(n)
      ? n
      : undefined;
  };
  return {
    node: row["NODE"],
    reachable: true,
    member: row["MEMBER"],
    leader: row["LEADER"],
    isLeader: row["MEMBER"] !== undefined && row["MEMBER"] === row["LEADER"],
    dbSizeBytes: parseSize(row["DB SIZE"] ?? ""),
    dbInUseBytes: parseSize(row["IN USE"] ?? ""),
    dbInUsePercent: parsePercent(row["IN USE"] ?? ""),
    raftIndex: num("RAFT INDEX"),
    raftTerm: num("RAFT TERM"),
    raftAppliedIndex: num("RAFT APPLIED INDEX"),
    isLearner: row["LEARNER"] === "true",
    protocol: row["PROTOCOL"] || undefined,
    storage: row["STORAGE"] || undefined,
    errors: row["ERRORS"] ?? "",
  };
}

/** One `talosctl processes` row as a {@link ProcessSchema} entry. */
export function processRecord(row: Record<string, string>) {
  const int = (k: string) => {
    const n = Number(row[k]);
    return row[k] && Number.isInteger(n) ? n : undefined;
  };
  return {
    pid: int("PID") ?? -1,
    state: row["STATE"] ?? "",
    threads: int("THREADS"),
    cpuSeconds: parseSeconds(row["CPU-TIME"] ?? ""),
    virtualBytes: parseSize(row["VIRTMEM"] ?? ""),
    residentBytes: parseSize(row["RESMEM"] ?? ""),
    label: row["LABEL"] || undefined,
    executable: (row["COMMAND"] ?? "").split(/\s+/)[0],
  };
}

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

/**
 * Parse `talosctl config contexts`: CURRENT NAME ENDPOINTS rows, where the
 * current context carries a `*` in the first column and every other row
 * starts with blanks. Trimming the line and dropping a lone `*` leaves the
 * name first either way.
 */
export function parseContexts(stdout: string): string[] {
  const out = [];
  for (const line of stdout.trim().split("\n").slice(1)) {
    const p = line.trim().split(/\s+/);
    if (p[0] === "*") p.shift();
    if (p.length === 0 || p[0] === "") continue;
    out.push(p[0]);
  }
  return out;
}

const ApplyArgs = z.object({
  nodes: NodesArg,
  configFile: z.string().describe("Path to the machine config YAML file"),
  mode: z.enum(["auto", "reboot", "no-reboot", "staged"]).default("auto"),
  insecure: z.boolean().default(false).describe(
    "Override the global insecure flag (maintenance mode)",
  ),
});
const PatchArgs = z.object({
  nodes: NodesArg,
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
  version: "2026.09.30.1",
  upgrades: [
    {
      toVersion: "2026.09.29.1",
      description:
        "serviceAccountKeyFile added; serviceAccountKey unchanged where set",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.29.2",
      description:
        "talosctl-available defaults talosctlPath itself; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.29.3",
      description:
        "omni-key-readable and talos-context-exists checks added; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.09.30.1",
      description:
        "etcd and health go to control planes only; etcdStatus, serviceLogs and processes added; every method takes nodes; no global schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  checks: {
    "talosctl-available": {
      description: "The talosctl binary runs and reports its client version",
      labels: ["live"],
      execute: async (context: { globalArgs: GlobalArgs }) => {
        try {
          await talosctl(
            { talosctlPath: talosctlPathOf(context.globalArgs), nodes: [] },
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
    "omni-key-readable": {
      description:
        "The Omni service-account key is readable when the definition names one",
      labels: ["policy"],
      // deno-lint-ignore require-await
      execute: async (context: { globalArgs: GlobalArgs }) => {
        // serviceAccountKey resolves the same way a method does: it rejects
        // the file and the value set together, and names the path — never the
        // value — when the file is missing, unreadable or empty. An operator's
        // sitting that has expired without rewriting the file reads as empty.
        try {
          serviceAccountKey(context.globalArgs);
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [err instanceof Error ? err.message : String(err)],
          };
        }
      },
    },
    "talos-context-exists": {
      description:
        "The named talosContext is one of the talosconfig's contexts",
      labels: ["live"],
      execute: async (context: { globalArgs: GlobalArgs }) => {
        const g = context.globalArgs;
        // Without talosContext talosctl uses whichever context is current,
        // which the definition does not control and cannot check.
        if (!g.talosContext) return { pass: true };
        try {
          // Deliberately without --context: asking for the missing one only
          // reports that it is missing, while the full list says what to
          // name instead. No node and no Omni key: this reads a local file.
          const { stdout } = await talosctl({
            talosctlPath: talosctlPathOf(g),
            talosconfig: g.talosconfig,
            talosconfigContent: g.talosconfigContent,
            nodes: [],
            // the content is sensitive wherever it came from, and this is the
            // one path that reaches talosctl without going through options()
            secrets: g.talosconfigContent ? [g.talosconfigContent] : [],
            retryDelayMs: g.retryDelayMs,
          }, ["config", "contexts"]);
          const names = parseContexts(stdout);
          if (names.includes(g.talosContext)) return { pass: true };
          return {
            pass: false,
            errors: [
              `talosContext "${g.talosContext}" is not in the talosconfig; ` +
              `it has ${names.length > 0 ? names.join(", ") : "no contexts"}`,
            ],
          };
        } catch (err) {
          return {
            pass: false,
            errors: [err instanceof Error ? err.message : String(err)],
          };
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
    etcdStatus: {
      description:
        "One control plane's etcd member: leader, raft indexes, database size, errors",
      schema: EtcdStatusSchema,
      lifetime: "30d" as const,
      garbageCollection: 20,
    },
    serviceLog: {
      description:
        "The recent lines of one service on one node, with counts in a time window",
      schema: ServiceLogSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
    processes: {
      description: "The top processes of one node by CPU time or memory",
      schema: ProcessesSchema,
      lifetime: "7d" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    version: {
      description: "Read the Talos version of every targeted node",
      arguments: NodesOnly,
      execute: async (
        args: NodesOnlyArgs,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = narrow(options(context.globalArgs), args.nodes);
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
      arguments: NodesOnly,
      execute: async (
        args: NodesOnlyArgs,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const { stdout } = await talosctl(
          narrow(options(context.globalArgs), args.nodes),
          ["services"],
          { signal: context.signal },
        );
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
      description:
        "List the etcd cluster members, as one control plane among the targets sees them; the first that answers is asked",
      arguments: NodesOnly,
      execute: async (
        args: NodesOnlyArgs,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = narrow(options(context.globalArgs), args.nodes);
        const errors: string[] = [];
        for (const cp of await controlPlanes(opts, context)) {
          let stdout: string;
          try {
            ({ stdout } = await talosctl({ ...opts, nodes: [cp] }, [
              "etcd",
              "members",
            ], { signal: context.signal }));
          } catch (err) {
            errors.push(err instanceof Error ? err.message : String(err));
            continue;
          }
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
        }
        throw new Error(
          `no control plane answered etcd members: ${errors.join("; ")}`,
        );
      },
    },
    etcdStatus: {
      description:
        "The etcd status of every control plane among the targets: member, leader, raft index and term, database size, errors. One etcdStatus per control plane; one that does not answer is recorded as unreachable. Read-only.",
      arguments: NodesOnly,
      execute: async (
        args: NodesOnlyArgs,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = narrow(options(context.globalArgs), args.nodes);
        const cps = await controlPlanes(opts, context);
        const results = await perNode({ ...opts, nodes: cps }, async (one) => {
          const { stdout } = await talosctl(one, ["etcd", "status"], {
            signal: context.signal,
          });
          const row = parseTable(stdout)[0];
          if (!row) throw new Error("etcd status printed no row");
          return etcdStatusRecord(row);
        });
        const ts = now();
        const handles: DataHandle[] = [];
        for (const r of results) {
          const data = r.ok
            ? { ...r.value, node: r.node, timestamp: ts }
            : { node: r.node, reachable: false, error: r.error, timestamp: ts };
          if (!r.ok) {
            context.logger.warning("{node}: etcd status failed: {error}", {
              node: r.node,
              error: r.error,
            });
          }
          handles.push(
            await context.writeResource(
              "etcdStatus",
              `etcd-status-${sanitizeInstanceName(r.node)}`,
              data,
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    serviceLogs: {
      description:
        "The last lines of one service's log on every targeted node, with how many fall inside a time window and match a pattern. One serviceLog per node; a node where the service does not exist is skipped. Read-only.",
      arguments: z.object({
        nodes: NodesArg,
        service: z.string().min(1).describe(
          "Talos service or container log, e.g. etcd, kubelet, apid",
        ),
        tail: z.number().int().min(1).max(10000).default(500).describe(
          "How many of the newest lines to read",
        ),
        match: z.string().optional().describe(
          "Regular expression; only matching lines are counted as matched and kept",
        ),
        sinceSeconds: z.number().int().min(1).optional().describe(
          "Count only lines whose own timestamp is this recent; lines without one are counted",
        ),
        keep: z.number().int().min(0).max(1000).default(20).describe(
          "How many of the newest matching lines to store",
        ),
      }),
      execute: async (
        args: {
          nodes?: string[];
          service: string;
          tail: number;
          match?: string;
          sinceSeconds?: number;
          keep: number;
        },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = narrow(options(context.globalArgs), args.nodes);
        const pattern = args.match ? new RegExp(args.match) : undefined;
        const results = await perNode(opts, async (one) => {
          const { stdout } = await talosctl(one, [
            "logs",
            args.service,
            "--tail",
            String(args.tail),
          ], { signal: context.signal });
          return parseLogs(stdout);
        });
        const cutoff = args.sinceSeconds
          ? Date.now() - args.sinceSeconds * 1000
          : undefined;
        const ts = now();
        const handles: DataHandle[] = [];
        for (const r of results) {
          if (!r.ok) {
            if (/not registered|not found/i.test(r.error)) {
              context.logger.warning("{node}: no {service} log, skipped", {
                node: r.node,
                service: args.service,
              });
              continue;
            }
            throw new Error(`${r.node}: ${r.error}`);
          }
          const counted = r.value.filter((l) =>
            cutoff === undefined || l.ts === undefined || l.ts >= cutoff
          );
          const matched = pattern
            ? counted.filter((l) => pattern.test(l.text))
            : counted;
          const times = counted.map((l) => l.ts).filter((t): t is number =>
            t !== undefined
          );
          handles.push(
            await context.writeResource(
              "serviceLog",
              `log-${sanitizeInstanceName(`${r.node}-${args.service}`)}`,
              {
                node: r.node,
                service: args.service,
                tail: args.tail,
                match: args.match,
                sinceSeconds: args.sinceSeconds,
                read: r.value.length,
                counted: counted.length,
                matched: matched.length,
                oldest: times.length > 0
                  ? new Date(Math.min(...times)).toISOString()
                  : undefined,
                newest: times.length > 0
                  ? new Date(Math.max(...times)).toISOString()
                  : undefined,
                lines: args.keep > 0
                  ? matched.slice(-args.keep).map((l) => l.text)
                  : [],
                timestamp: ts,
              },
            ),
          );
        }
        if (handles.length === 0) {
          throw new Error(
            `no targeted node has a ${args.service} log (${
              opts.nodes.join(", ")
            })`,
          );
        }
        return { dataHandles: handles };
      },
    },
    processes: {
      description:
        "The top processes of every targeted node by CPU time or resident memory. One processes record per node, holding each process's executable but never its arguments. Read-only.",
      arguments: z.object({
        nodes: NodesArg,
        sort: z.enum(["cpu", "rss"]).default("cpu"),
        top: z.number().int().min(1).max(200).default(10),
      }),
      execute: async (
        args: { nodes?: string[]; sort: "cpu" | "rss"; top: number },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = narrow(options(context.globalArgs), args.nodes);
        const results = await perNode(opts, async (one) => {
          const { stdout } = await talosctl(one, [
            "processes",
            "--sort",
            args.sort,
          ], { signal: context.signal });
          return parseTable(stdout).slice(0, args.top).map(processRecord);
        });
        const ts = now();
        const handles: DataHandle[] = [];
        for (const r of results) {
          if (!r.ok) throw new Error(`${r.node}: ${r.error}`);
          handles.push(
            await context.writeResource(
              "processes",
              `processes-${sanitizeInstanceName(r.node)}`,
              {
                node: r.node,
                sort: args.sort,
                processes: r.value,
                timestamp: ts,
              },
            ),
          );
        }
        return { dataHandles: handles };
      },
    },
    kubeconfig: {
      description: "Retrieve the cluster kubeconfig",
      arguments: NodesOnly,
      execute: async (
        args: NodesOnlyArgs,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const { stdout } = await talosctl(
          narrow(options(context.globalArgs), args.nodes),
          ["kubeconfig", "-"],
          { signal: context.signal },
        );
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
      arguments: NodesOnly,
      execute: async (
        args: NodesOnlyArgs,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = narrow(options(context.globalArgs), args.nodes);
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
        const opts = narrow(
          options(
            context.globalArgs,
            args.insecure || context.globalArgs.insecure,
          ),
          args.nodes,
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
      arguments: NodesOnly,
      execute: async (
        args: NodesOnlyArgs,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = narrow(options(context.globalArgs), args.nodes);
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
      description:
        "Reboot the targeted nodes; give nodes to reboot fewer than all of them, e.g. one control plane at a time",
      arguments: z.object({
        nodes: NodesArg,
        mode: z.enum(["default", "powercycle"]).default("default"),
      }),
      execute: async (
        args: { nodes?: string[]; mode: "default" | "powercycle" },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = narrow(options(context.globalArgs), args.nodes);
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
      arguments: z.object({
        nodes: NodesArg,
        force: z.boolean().default(false),
      }),
      execute: async (
        args: { nodes?: string[]; force: boolean },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = narrow(options(context.globalArgs), args.nodes);
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
        nodes: NodesArg,
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
          nodes?: string[];
          graceful: boolean;
          reboot: boolean;
          systemLabelsToWipe?: string[];
        },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = narrow(options(context.globalArgs), args.nodes);
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
        nodes: NodesArg,
        image: z.string().describe(
          "Installer image, e.g. ghcr.io/siderolabs/installer:v1.14.1",
        ),
        preserve: z.boolean().default(false).describe(
          "Preserve ephemeral data",
        ),
      }),
      execute: async (
        args: { nodes?: string[]; image: string; preserve: boolean },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = narrow(options(context.globalArgs), args.nodes);
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
        const opts = narrow(options(context.globalArgs), args.nodes);
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
      description:
        "Run the cluster health check from one control plane: the given node, or the first control plane among the targets. Through Omni's proxy the etcd check needs more than a Reader identity; Omni reports cluster health itself",
      arguments: z.object({
        node: z.string().optional().describe(
          "The control plane to run the check from; must be one of the targets",
        ),
        waitTimeout: z.string().default("10s").describe(
          "How long to wait for the check to pass, e.g. 30s, 2m",
        ),
      }),
      execute: async (
        args: { node?: string; waitTimeout: string },
        context: ModelContext,
      ): Promise<MethodResult> => {
        const opts = options(context.globalArgs);
        const node = args.node
          ? narrow(opts, [args.node]).nodes[0]
          : (await controlPlanes(opts, context))[0];
        const { stdout } = await talosctl(
          { ...opts, nodes: [node] },
          ["health", "--wait-timeout", args.waitTimeout],
          { signal: context.signal },
        );
        return await resultOf(
          context,
          "health",
          `${node}: ${stdout.trim() || "cluster healthy"}`,
        );
      },
    },
  },
};
