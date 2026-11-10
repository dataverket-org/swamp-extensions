/**
 * `@dataverket/kind/cluster`: a single named kind (Kubernetes in Docker)
 * cluster, created on demand.
 *
 * `ensure` is idempotent: it creates the cluster from a kind config file only
 * when `kind get clusters` does not list it, then (re)applies a set of
 * manifests and records the cluster's kube context and API server URL so
 * other behaviors can target it.
 *
 * kind picks its node provider (Docker, Podman or nerdctl) from the
 * environment variable `KIND_EXPERIMENTAL_PROVIDER`. Every command here
 * inherits the environment of the method run unchanged, so the provider is
 * chosen where swamp is started and nowhere else.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  brief,
  type CheckResult,
  cliProblem,
  isCliError,
  MAX_TIMEOUT_MS,
  positionalArg,
  runCli,
  tryCli,
} from "../lib/cli.ts";
import {
  checkName,
  isCancelled,
  isKubectlError,
  type KubectlError,
  type KubectlOpts,
  runKubectlText,
} from "../lib/kubectl.ts";

/** The cluster's arguments. */
export const GlobalArgsSchema = z.object({
  clusterName: z.string().min(1).describe("kind cluster name"),
  configPath: z.string().min(1).describe(
    "kind cluster config, absolute or relative to the repository root",
  ),
  manifests: z.array(z.string()).default([]).describe(
    "Manifests applied with kubectl after the cluster is up, relative to the repository root",
  ),
  waitTimeout: z.string().default("120s").describe(
    "How long kind waits for the control plane to become ready, written as kind takes --wait: digits and a unit, such as 90s, 2m or 1m30s; at most 596h",
  ),
  kubeconfig: z.string().optional().describe(
    "Kubeconfig file kind writes the cluster's context to and kubectl reads, absolute or relative to the repository root. Its directory must exist. Defaults to KUBECONFIG or ~/.kube/config",
  ),
  kindBinary: z.string().default("kind"),
  kubectlBinary: z.string().default("kubectl"),
});

/** The cluster's arguments, parsed. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ClusterSchema = z.object({
  name: z.string(),
  exists: z.boolean(),
  created: z.boolean(),
  context: z.string(),
  apiServer: z.string(),
  manifestsApplied: z.array(z.string()),
  kubeconfig: z.string().optional().describe(
    "Absolute path of the kubeconfig argument; absent when the default kubeconfig is used",
  ),
  manifestFailed: z.string().optional().describe(
    "The manifest whose apply failed in this ensure; manifestsApplied then holds only the ones before it",
  ),
  error: z.string().optional().describe(
    "Why the record is incomplete: the failed apply, or what get could not read of an existing cluster",
  ),
  checkedAt: z.iso.datetime(),
});

type Cluster = z.infer<typeof ClusterSchema>;

/** The parts of swamp's method context the cluster uses. */
export type Context = {
  globalArgs: GlobalArgs;
  repoDir: string;
  signal?: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

// ---------------------------------------------------------------------------
// Time limits
// ---------------------------------------------------------------------------

/**
 * What `kind create cluster` may take on top of `waitTimeout`: the node
 * image pull on a machine that has not got it, the node container start and
 * `kubeadm init`. kind only starts counting `--wait` after those.
 */
export const CREATE_MARGIN_MS = 300_000;

/** The longest `waitTimeout`: with the margin it must still be a time limit. */
export const MAX_WAIT_MS = MAX_TIMEOUT_MS - CREATE_MARGIN_MS;

/** How long `kind delete cluster` may take. */
export const DELETE_TIMEOUT_MS = 120_000;

/**
 * How long the API server may take to answer one `kubectl apply -f`. A
 * manifest with many objects or large CRDs can take longer than the 30
 * seconds of a read, and an apply cut off part-way leaves a half-applied
 * set. The same 300 seconds `kind create cluster` gets on top of its wait:
 * the two slow steps of `ensure` have the same patience.
 */
export const APPLY_TIMEOUT_SECONDS = 300;

/** How long one probe of a container runtime's version may take. */
const PROBE_TIMEOUT_MS = 10_000;

const UNIT_MS: Record<string, number> = {
  ns: 1e-6,
  us: 1e-3,
  "µs": 1e-3,
  ms: 1,
  s: 1000,
  m: 60_000,
  h: 3_600_000,
};

/**
 * A duration as kind takes `--wait`, in milliseconds, or a named refusal.
 * Accepted: `0`, or one or more parts of digits, an optional `.` and more
 * digits, and a unit of `ns`, `us`, `µs`, `ms`, `s`, `m` or `h` (`90s`, `2m`,
 * `1m30s`, `1.5m`). Go also reads a sign, a number that starts with `.` and
 * the Greek letter mu; those are refused here. At most `MAX_WAIT_MS`.
 */
export function durationMs(value: string): number {
  if (value === "0") return 0;
  if (!/^(\d+(\.\d+)?(ns|us|µs|ms|s|m|h))+$/.test(value)) {
    throw new Error(
      `waitTimeout ${
        JSON.stringify(value.slice(0, 80))
      } is not a duration: write it as kind takes --wait, for example 90s, 2m or 1m30s`,
    );
  }
  let total = 0;
  for (const m of value.matchAll(/(\d+(?:\.\d+)?)(ns|us|µs|ms|s|m|h)/g)) {
    total += Number(m[1]) * UNIT_MS[m[2]];
  }
  if (!(total <= MAX_WAIT_MS)) {
    throw new Error(
      `waitTimeout ${JSON.stringify(value.slice(0, 80))} is too long: at most ${
        Math.floor(MAX_WAIT_MS / 3_600_000)
      }h, the longest time limit a process can be given less the ${
        CREATE_MARGIN_MS / 1000
      } seconds ensure adds`,
    );
  }
  return total;
}

// ---------------------------------------------------------------------------
// The validated target
// ---------------------------------------------------------------------------

type Target = {
  name: string;
  context: string;
  configPath: string;
  manifests: string[];
  waitMs: number;
  /** As given, for the command lines. */
  kubeconfig?: string;
  /** Absolute, for the record and the directory check. */
  kubeconfigPath?: string;
  kubectl: KubectlOpts;
};

function absolute(repoDir: string, path: string): string {
  return path.startsWith("/") ? path : `${repoDir}/${path}`;
}

/**
 * Check every argument that becomes part of a command line before anything
 * is spawned. A cluster name must be a name; a path must not be empty or
 * start with `-`, where kind or kubectl would read it as a flag.
 */
function target(ctx: Context): Target {
  const g = ctx.globalArgs;
  const name = checkName(g.clusterName, "clusterName");
  const context = `kind-${name}`;
  const kubeconfig = g.kubeconfig === undefined
    ? undefined
    : positionalArg(g.kubeconfig, "kubeconfig");
  return {
    name,
    context,
    configPath: positionalArg(g.configPath, "configPath"),
    manifests: g.manifests.map((m) => positionalArg(m, "manifest")),
    waitMs: durationMs(g.waitTimeout),
    kubeconfig,
    kubeconfigPath: kubeconfig === undefined
      ? undefined
      : absolute(ctx.repoDir, kubeconfig),
    kubectl: {
      kubeconfig,
      context,
      bin: g.kubectlBinary,
      cwd: ctx.repoDir,
      signal: ctx.signal,
    },
  };
}

function kubeconfigFlag(t: Target): string[] {
  return t.kubeconfig === undefined ? [] : ["--kubeconfig", t.kubeconfig];
}

// ---------------------------------------------------------------------------
// kind
// ---------------------------------------------------------------------------

/**
 * True for what kind prints to standard error that is not its error: the
 * provider notices, the heading and the steps in progress or done. A failed
 * step (`✗`) and the `ERROR:` line are kept.
 */
export function isKindProgress(line: string): boolean {
  return /^using \S+ due to KIND_EXPERIMENTAL_PROVIDER$/.test(line.trim()) ||
    /^enabling experimental \S+ provider$/.test(line.trim()) ||
    /^(Creating|Deleting) cluster "/.test(line) ||
    /^\s*[•✓]\s/.test(line);
}

const KIND_INSTALL_HINT =
  "install kind, or set the kindBinary argument to where it is";

/** Run kind in the repository root, with the environment as it is. */
async function kind(
  ctx: Context,
  args: string[],
  timeoutMs?: number,
): Promise<string> {
  const res = await runCli(ctx.globalArgs.kindBinary, args, {
    cwd: ctx.repoDir,
    signal: ctx.signal,
    timeoutMs,
    noise: isKindProgress,
    installHint: KIND_INSTALL_HINT,
  });
  return res.stdout;
}

async function clusterExists(ctx: Context, t: Target): Promise<boolean> {
  const stdout = await kind(ctx, ["get", "clusters"]);
  return stdout.split("\n").map((l) => l.trim()).includes(t.name);
}

/**
 * kind writes a kubeconfig wherever it is told and makes the directories on
 * the way. A mistyped path is then only noticed after the cluster is up, so
 * the directory must be there before a cluster is created.
 */
async function assertKubeconfigDir(t: Target): Promise<void> {
  if (t.kubeconfigPath === undefined) return;
  const cut = t.kubeconfigPath.lastIndexOf("/");
  const dir = cut <= 0 ? "/" : t.kubeconfigPath.slice(0, cut);
  let isDirectory = false;
  try {
    isDirectory = (await Deno.stat(dir)).isDirectory;
  } catch (err) {
    if (!(err instanceof Deno.errors.NotFound)) throw err;
  }
  if (!isDirectory) {
    throw new Error(
      `kubeconfig ${
        JSON.stringify(t.kubeconfig)
      } is refused: its directory ${dir} does not exist; create it first. Nothing was created or written`,
    );
  }
}

async function createCluster(ctx: Context, t: Target): Promise<void> {
  const args = [
    "create",
    "cluster",
    "--name",
    t.name,
    "--config",
    t.configPath,
    "--wait",
    ctx.globalArgs.waitTimeout,
    ...kubeconfigFlag(t),
  ];
  try {
    await kind(ctx, args, t.waitMs + CREATE_MARGIN_MS);
  } catch (err) {
    if (isCliError(err, "timeout")) {
      throw new Error(
        `${err.message}. The limit is waitTimeout plus ${
          CREATE_MARGIN_MS / 1000
        } seconds. Part of the cluster may be left behind: run delete before the next ensure`,
      );
    }
    throw err;
  }
}

// ---------------------------------------------------------------------------
// The node provider, for the hint about a stopped node container
// ---------------------------------------------------------------------------

function providerFromEnv(): string {
  try {
    return Deno.env.get("KIND_EXPERIMENTAL_PROVIDER") ?? "";
  } catch {
    // No permission to read the environment: as if it were not set.
    return "";
  }
}

async function versionStarts(
  ctx: Context,
  bin: string,
  prefix: string,
): Promise<boolean> {
  try {
    const res = await tryCli(bin, ["-v"], {
      timeoutMs: PROBE_TIMEOUT_MS,
      signal: ctx.signal,
    });
    return res.success && res.stdout.startsWith(prefix);
  } catch {
    // Not there, not runnable, not permitted: in every case not the tool
    // kind uses. The probe only words a hint and must never replace the
    // error the hint is for.
    return false;
  }
}

/**
 * The container command of the provider kind uses, found the way kind finds
 * it: `KIND_EXPERIMENTAL_PROVIDER` when it holds a value kind knows, else
 * the first of docker, nerdctl and podman whose `-v` answers with its own
 * name (Podman's `docker` shim answers `podman version` and is not Docker).
 * Null when none is found.
 */
export async function nodeProviderCommand(
  ctx: Context,
): Promise<string | null> {
  const fromEnv = providerFromEnv();
  if (
    ["docker", "podman", "nerdctl", "finch", "nerdctl.lima"].includes(fromEnv)
  ) return fromEnv;
  ctx.logger.info(
    "KIND_EXPERIMENTAL_PROVIDER names no provider; asking docker, nerdctl and podman for their version to word the hint",
  );
  if (await versionStarts(ctx, "docker", "Docker version")) return "docker";
  if (await versionStarts(ctx, "nerdctl", "nerdctl version")) return "nerdctl";
  if (await versionStarts(ctx, "podman", "podman version")) return "podman";
  return null;
}

// ---------------------------------------------------------------------------
// kubectl
// ---------------------------------------------------------------------------

/** A path as it can be pasted into a shell. */
export function shellQuote(value: string): string {
  return /^[A-Za-z0-9_\/.:=@%+,-]+$/.test(value)
    ? value
    : `'${value.replaceAll("'", `'\\''`)}'`;
}

function exportCommand(t: Target): string {
  return `kind export kubeconfig --name ${t.name}${
    t.kubeconfig === undefined
      ? ""
      : ` --kubeconfig ${shellQuote(t.kubeconfig)}`
  }`;
}

function exportHint(t: Target): string {
  return `if ${
    t.kubeconfig ?? "the default kubeconfig"
  } does not hold a current entry for the context ${t.context}, write it with: ${
    exportCommand(t)
  }`;
}

/**
 * True when the API server presented a certificate the kubeconfig does not
 * trust, or one that has expired. The shared layer sorts that as
 * unreachable; for a kind cluster it means the kubeconfig entry is from an
 * earlier cluster of the same name.
 */
function certificateMismatch(err: KubectlError): boolean {
  return /x509|certificate signed by unknown authority|certificate has expired/i
    .test(`${err.stderr} ${err.message}`);
}

/**
 * True when the failure says the kubeconfig entry is missing or stale, which
 * `kind export kubeconfig` repairs: no file, no context, a certificate of
 * another cluster, or credentials the cluster does not accept.
 */
function staleKubeconfig(err: KubectlError): boolean {
  if (err.kind === "unauthorized" || certificateMismatch(err)) return true;
  return err.kind === "other" &&
    /cannot locate context|context .* does not exist|no such file or directory|current-context must exist|no configuration has been provided/i
      .test(`${err.stderr} ${err.message}`);
}

/**
 * The address could not be read from the kubeconfig. `said` is kubectl's
 * failure and `hint` the command that writes the entry; they are kept apart
 * so a record can bound the first and keep the second whole.
 */
class EntryUnreadable extends Error {
  readonly said: string;
  readonly hint: string;
  constructor(said: string, hint: string) {
    super(`${said}; ${hint}`);
    this.name = "Error";
    this.said = said;
    this.hint = hint;
  }
}

async function apiServer(t: Target): Promise<string> {
  try {
    const out = await runKubectlText([
      "config",
      "view",
      "--minify",
      "-o",
      "jsonpath={.clusters[0].cluster.server}",
    ], t.kubectl);
    return out.trim();
  } catch (err) {
    if (isKubectlError(err, "other")) {
      throw new EntryUnreadable(err.message, exportHint(t));
    }
    throw err;
  }
}

/** The readiness read: null when the API server answers, else the failure. */
async function readiness(t: Target): Promise<KubectlError | null> {
  try {
    await runKubectlText(["get", "--raw", "/readyz"], t.kubectl);
    return null;
  } catch (err) {
    if (!isKubectlError(err)) throw err;
    if (err.kind === "cancelled" || err.kind === "not-installed") throw err;
    return err;
  }
}

/** The question and the command for a node container that may be stopped. */
async function stoppedHint(ctx: Context, node: string): Promise<string> {
  const provider = await nodeProviderCommand(ctx);
  return `is the ${node} container stopped? ${
    provider === null
      ? "start it with the container runtime kind uses"
      : `try '${provider} start ${node}'`
  }`;
}

/** The error for a cluster that exists and did not pass the readiness read. */
async function notReady(
  ctx: Context,
  t: Target,
  err: KubectlError,
): Promise<Error> {
  const node = `${t.name}-control-plane`;
  if (
    (err.kind === "unreachable" || err.kind === "timeout") &&
    !certificateMismatch(err)
  ) {
    return new Error(
      `kind cluster ${t.name} exists but its API server is not reachable ` +
        `(${await stoppedHint(ctx, node)}): ${err.message}`,
    );
  }
  return new Error(
    `kind cluster ${t.name} exists but its API server did not pass the readiness check: ${err.message}; ${
      exportHint(t)
    }`,
  );
}

/**
 * Check that the API server answers. When the `kubeconfig` argument is set
 * and the failure says its entry is missing or stale, the file is this
 * type's own: write the entry with `kind export kubeconfig` and read again.
 * Without the argument the default kubeconfig is left alone.
 */
async function assertReachable(ctx: Context, t: Target): Promise<void> {
  let err = await readiness(t);
  if (err === null) return;
  if (t.kubeconfig !== undefined && staleKubeconfig(err)) {
    await assertKubeconfigDir(t);
    ctx.logger.info(
      "{kubeconfig} holds no current entry for {context}; writing it with kind export kubeconfig",
      { kubeconfig: t.kubeconfig, context: t.context },
    );
    try {
      await kind(ctx, [
        "export",
        "kubeconfig",
        "--name",
        t.name,
        "--kubeconfig",
        t.kubeconfig,
      ]);
    } catch (failed) {
      // kind reads the entry out of the node container, so the export
      // fails when that container is stopped. Say that first; kind's own
      // error is the second sentence, not the only one.
      if (!isCliError(failed, "failed", "timeout")) throw failed;
      throw new Error(
        `kind cluster ${t.name} exists but ${t.kubeconfig} holds no current entry for ${t.context}, and kind could not write one ` +
          `(${await stoppedHint(
            ctx,
            `${t.name}-control-plane`,
          )}). ${failed.message}`,
      );
    }
    err = await readiness(t);
    if (err === null) return;
  }
  throw await notReady(ctx, t, err);
}

async function write(ctx: Context, t: Target, cluster: Cluster) {
  return await ctx.writeResource("cluster", "cluster", {
    ...cluster,
    ...(t.kubeconfigPath === undefined ? {} : { kubeconfig: t.kubeconfigPath }),
  });
}

/** One line of an error, safe to keep in a record. */
function reason(err: unknown): string {
  // The command that repairs the entry comes first and is never cut: a long
  // kubeconfig path must not shorten it. What kubectl said is bounded.
  if (err instanceof EntryUnreadable) return `${err.hint}. ${brief(err.said)}`;
  return brief(err instanceof Error ? err.message : String(err));
}

// ---------------------------------------------------------------------------
// Pre-flight checks
// ---------------------------------------------------------------------------

/** What swamp hands a pre-flight check, as far as it is used here. */
type CheckContext = {
  globalArgs?: Partial<GlobalArgs>;
  repoDir?: string;
  signal?: AbortSignal;
};

/**
 * A check that a binary of the definition runs, from the repository root as
 * the methods run it, so a relative path means the same in both.
 */
function binaryCheck(spec: {
  description: string;
  appliesTo: string[];
  bin: (g: Partial<GlobalArgs>) => string;
  args: string[];
  installHint?: string;
}) {
  return {
    description: spec.description,
    labels: ["live"],
    appliesTo: spec.appliesTo,
    execute: async (context?: CheckContext): Promise<CheckResult> => {
      const problem = await cliProblem(
        spec.bin(context?.globalArgs ?? {}),
        spec.args,
        {
          cwd: context?.repoDir,
          signal: context?.signal,
          installHint: spec.installHint,
        },
      );
      return problem ? { pass: false, errors: [problem] } : { pass: true };
    },
  };
}

/** Model definition for a single on-demand kind cluster. */
export const model = {
  type: "@dataverket/kind/cluster",
  version: "2026.11.10.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.10.1",
      description:
        "New optional global argument kubeconfig and optional record fields kubeconfig, manifestFailed and error. Every command has a time limit, and a cluster name that is not a name is refused before kind runs. No existing global argument and no stored field changed",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  // swamp runs no check before a read, so `get` is not named: it reports a
  // missing binary itself. `delete` never runs kubectl and must work on a
  // machine without it.
  checks: {
    "kind-cli-available": binaryCheck({
      description:
        "The kind binary runs and reports its version; ensure and delete list, create or delete clusters with it",
      appliesTo: ["ensure", "delete"],
      bin: (g) => g.kindBinary ?? "kind",
      args: ["version"],
      installHint: KIND_INSTALL_HINT,
    }),
    "kubectl-cli-available": binaryCheck({
      description:
        "The kubectl binary runs and reports its client version; ensure reads the API server and applies the manifests with it",
      appliesTo: ["ensure"],
      bin: (g) => g.kubectlBinary ?? "kubectl",
      args: ["version", "--client"],
    }),
  },
  resources: {
    "cluster": {
      description: "Observed state of the kind cluster",
      schema: ClusterSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    ensure: {
      description:
        "Create the kind cluster if it does not exist, then apply the configured manifests",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const t = target(ctx);
        let created = false;

        ctx.logger.info("Looking up kind cluster {name}", { name: t.name });
        if (await clusterExists(ctx, t)) {
          ctx.logger.info("kind cluster {name} already exists", {
            name: t.name,
          });
        } else {
          await assertKubeconfigDir(t);
          ctx.logger.info("Creating kind cluster {name} from {config}", {
            name: t.name,
            config: t.configPath,
          });
          await createCluster(ctx, t);
          created = true;
        }

        await assertReachable(ctx, t);

        const applied: string[] = [];
        for (const manifest of t.manifests) {
          ctx.logger.info("Applying {manifest}", { manifest });
          try {
            await runKubectlText(["apply", "-f", manifest], {
              ...t.kubectl,
              requestTimeoutSeconds: APPLY_TIMEOUT_SECONDS,
            });
          } catch (err) {
            // A cancelled run writes nothing, here as everywhere else.
            if (isCancelled(err)) throw err;
            // The cluster and the manifests before this one stay. Record
            // that before failing, or the latest record would still say
            // what was true before this run.
            await write(ctx, t, {
              name: t.name,
              exists: true,
              created,
              context: t.context,
              apiServer: await apiServer(t).catch(() => ""),
              manifestsApplied: applied,
              manifestFailed: manifest,
              error: reason(err),
              checkedAt: new Date().toISOString(),
            });
            throw err;
          }
          applied.push(manifest);
        }

        const handle = await write(ctx, t, {
          name: t.name,
          exists: true,
          created,
          context: t.context,
          apiServer: await apiServer(t),
          manifestsApplied: applied,
          checkedAt: new Date().toISOString(),
        });
        ctx.logger.info(
          "kind cluster {name} is up ({how}), {count} manifest(s) applied",
          {
            name: t.name,
            how: created ? "created" : "already there",
            count: applied.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    get: {
      description:
        "Record whether the kind cluster exists, without creating it",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const t = target(ctx);
        ctx.logger.info("Looking up kind cluster {name}", { name: t.name });
        const exists = await clusterExists(ctx, t);
        // A read records the state. An existing cluster whose kubeconfig
        // entry cannot be read still exists; what could not be read, and
        // why, goes in the record.
        let server = "";
        let error: string | undefined;
        if (exists) {
          try {
            server = await apiServer(t);
          } catch (err) {
            if (isKubectlError(err, "cancelled")) throw err;
            error = reason(err);
          }
        }
        const handle = await write(ctx, t, {
          name: t.name,
          exists,
          created: false,
          context: t.context,
          apiServer: server,
          manifestsApplied: [],
          ...(error === undefined ? {} : { error }),
          checkedAt: new Date().toISOString(),
        });
        ctx.logger.info(
          error === undefined
            ? "kind cluster {name}: {state}"
            : "kind cluster {name}: {state}, but its API server address could not be read: {error}",
          { name: t.name, state: exists ? "exists" : "does not exist", error },
        );
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Delete the kind cluster if it exists",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const t = target(ctx);
        // The file of the kubeconfig argument is this type's own, and kind
        // makes the directories of the path it is given: a mistyped path
        // is refused before kind is run at all.
        await assertKubeconfigDir(t);
        ctx.logger.info("Looking up kind cluster {name}", { name: t.name });
        const existed = await clusterExists(ctx, t);
        if (existed || t.kubeconfig !== undefined) {
          ctx.logger.info(
            existed
              ? "Deleting kind cluster {name}"
              : "kind cluster {name} is already gone; removing what is left of it in {kubeconfig}",
            { name: t.name, kubeconfig: t.kubeconfig },
          );
          // With the kubeconfig argument also for a cluster that is gone:
          // kind then only removes a stale entry from that file. Without
          // the argument it is not run: under another provider than the one
          // the cluster was made with, kind lists no such cluster and would
          // take a live cluster's entry out of the default kubeconfig.
          await kind(
            ctx,
            ["delete", "cluster", "--name", t.name, ...kubeconfigFlag(t)],
            DELETE_TIMEOUT_MS,
          );
        } else {
          ctx.logger.info("kind cluster {name} is already gone", {
            name: t.name,
          });
        }
        const handle = await write(ctx, t, {
          name: t.name,
          exists: false,
          created: false,
          context: t.context,
          apiServer: "",
          manifestsApplied: [],
          checkedAt: new Date().toISOString(),
        });
        ctx.logger.info("kind cluster {name} is gone", { name: t.name });
        return { dataHandles: [handle] };
      },
    },
  },
};
