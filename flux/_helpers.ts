/**
 * What the three Flux model types share and no other extension does: the
 * global arguments, the condition and source-reference schemas as this
 * package has always stored them, the `flux` runner with its time limits, and
 * the upgrade chain. Everything about running a process and about kubectl
 * comes from the shared layer in `../lib/`: `flux` and `kubectl` are run by
 * name from PATH with the model's kubeconfig and context, with no shell, and
 * every call is stopped at a time limit.
 *
 * Forked from `@ginger_pappa/flux` 2026.06.09.1 (MIT, copyright ginger_pappa).
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  brief,
  cliCheck,
  CliError,
  cliError,
  type CliOpts,
  redact,
  tryCli,
} from "../lib/cli.ts";
import {
  cliArgs,
  type KubectlGlobalArgs,
  KubectlGlobalArgsSchema,
  type KubectlOpts,
  readMeta,
} from "../lib/kubectl.ts";

/**
 * Global argument schema of all flux model types: `namespace` (default
 * empty), `kubeconfig` and `context`, as published. The shared schema has
 * the same three keys, types and defaults, and describes each.
 */
export const FluxGlobalArgsSchema = KubectlGlobalArgsSchema;

/** The global arguments as a method receives them. */
export type FluxGlobalArgs = KubectlGlobalArgs;

/**
 * Common condition schema matching the FluxCD metav1.Condition shape. This
 * is the shape the `list` records are published with, a field left out when
 * the controller wrote none; it is kept, and is not the shared layer's.
 */
export const ConditionSchema = z.object({
  type: z.string(),
  status: z.string(),
  reason: z.string().optional(),
  message: z.string().optional(),
  lastTransitionTime: z.string().optional(),
  observedGeneration: z.number().optional(),
});

/** A condition as kubectl reports it, before it is narrowed to the schema. */
export type ConditionRaw = z.infer<typeof ConditionSchema>;

/** Source reference as embedded in HelmRelease and Kustomization specs. */
export const SourceRefSchema = z.object({
  kind: z.string(),
  name: z.string(),
  namespace: z.string().optional(),
});

/** Options passed to runKubectl and runFlux. */
export type RunOpts = KubectlOpts;

/** The logger a method receives; only `info` is used here. */
export interface MethodLogger {
  info: (msg: string, props?: Record<string, string>) => void;
}

/** The context every method in this extension reads. */
export interface FluxContext<T> {
  globalArgs: FluxGlobalArgs;
  /** Aborted when the method run is cancelled; it stops the running command. */
  signal?: AbortSignal;
  logger: MethodLogger;
  writeResource: (
    spec: string,
    name: string,
    data: T,
  ) => Promise<unknown>;
}

/**
 * How long one `flux` process may live, by what the command does. `flux`
 * gives up by itself after its own `--timeout`, five minutes by default, and
 * says why; each limit here is a little longer than what flux may take, so
 * flux's own sentence is what an operator reads, and a flux that hangs
 * outside that wait still ends.
 */
export const FLUX_TIMEOUTS = {
  /** `suspend`: one patch, no wait. */
  suspend: 60_000,
  /** `resume`: the patch, then flux waits for the apply, five minutes at most. */
  resume: 330_000,
  /** `reconcile`, also with `--reset`: flux waits for it, five minutes at most. */
  reconcile: 330_000,
  /**
   * `reconcile --with-source` of a Kustomization: flux waits for the source
   * and then for the object, five minutes at most each.
   */
  reconcileWithSource: 630_000,
  /**
   * `reconcile --with-source` of a HelmRelease: flux waits for the chart's
   * repository, for the HelmChart and then for the release, five minutes at
   * most each. A release on an OCIRepository has two waits and the same
   * limit.
   */
  reconcileHelmReleaseWithSource: 930_000,
  /** `push artifact`: the upload, five minutes at most by flux's own limit. */
  push: 330_000,
} as const;

/**
 * The time limit of a `flux reconcile` of one kind, with or without its
 * source. flux gives each object it waits for its own five minutes: the
 * object alone is one wait, a Kustomization with its source two, and a
 * HelmRelease with its source up to three, because flux reconciles the
 * HelmChart between the repository and the release.
 */
export function reconcileTimeout(
  kind: "helmrelease" | "kustomization",
  withSource: boolean | undefined,
): number {
  if (!withSource) return FLUX_TIMEOUTS.reconcile;
  return kind === "helmrelease"
    ? FLUX_TIMEOUTS.reconcileHelmReleaseWithSource
    : FLUX_TIMEOUTS.reconcileWithSource;
}

/**
 * A URL as it is stored: without the user and password before the host,
 * and with anything else shaped like a credential blanked. A token is often
 * the user part alone, so the whole of it goes.
 */
export function storedUrl(url: string): string {
  return redact(url);
}

/**
 * True for a line flux prints while it works (`► annotating ...`,
 * `◎ waiting ...`, `✔ ... annotated`). They come before the one line that
 * says what failed (`✗ ...`), and would push it out of a bounded message.
 */
export function isFluxProgressLine(line: string): boolean {
  return /^\s*[►◎✔]/.test(line);
}

/**
 * Run a flux CLI command with optional kubeconfig/context overrides, stopped
 * after `timeoutMs`. Returns stdout as a string. A non-zero exit throws
 * `flux <subcommand> failed: <what flux said>`, one redacted line; a time
 * limit, a cancelled run and output over the output bound throw lib's own
 * error for each.
 */
export async function runFlux(
  args: string[],
  opts: RunOpts | undefined,
  timeoutMs: number,
): Promise<string> {
  const cli: CliOpts = {
    signal: opts?.signal,
    timeoutMs,
    what: `flux ${args[0]}`,
    noise: isFluxProgressLine,
  };
  const r = await tryCli("flux", cliArgs(args, opts), cli);
  if (r.timedOut || r.cancelled || r.tooLarge) {
    throw cliError("flux", args, r, cli);
  }
  if (!r.success) {
    throw new CliError(
      "failed",
      `flux ${args[0]} failed: ${
        brief(r.stderr || r.stdout) || "(no error output)"
      }`,
      { bin: "flux", code: r.code, stderr: r.stderr },
    );
  }
  return r.stdout;
}

/**
 * A condition message as it is stored: controllers copy error text from
 * elsewhere into it, a URL with a password among it, so what is shaped like
 * a credential is blanked. Anything else is stored as it was written.
 */
function storedMessage<T>(message: T): T {
  return (typeof message === "string" ? redact(message) : message) as T;
}

/**
 * Extract the Ready condition from a FluxCD conditions array and return
 * a normalised { ready, reason, message } triple. No Ready condition at all
 * reads as not ready with reason `Unknown`. The message is redacted.
 */
export function extractReadyCondition(
  conditions: ConditionRaw[],
): { ready: boolean; reason: string; message: string } {
  const c = conditions.find((c) => c.type === "Ready");
  return {
    ready: c?.status === "True",
    reason: c?.reason ?? "Unknown",
    message: storedMessage(c?.message ?? ""),
  };
}

/**
 * Narrow raw conditions to exactly the fields the schema stores, with each
 * message redacted.
 */
export function narrowConditions(conditions: ConditionRaw[]): ConditionRaw[] {
  return conditions.map((c) => ({
    type: c.type,
    status: c.status,
    reason: c.reason,
    message: storedMessage(c.message),
    lastTransitionTime: c.lastTransitionTime,
    observedGeneration: c.observedGeneration,
  }));
}

/**
 * The namespace and name of every item of a list answer, or an error when
 * one has neither: such an item is not an object and cannot be recorded.
 */
export function listedNames(
  items: Record<string, unknown>[],
  kind: string,
): Array<{ namespace: string; name: string }> {
  return items.map((item) => {
    const meta = readMeta(item, true, kind);
    return { namespace: meta.namespace, name: meta.name };
  });
}

/**
 * The version at which this package took the types over from upstream, and
 * where the first, no-op entry of every type's upgrade chain ends. The types
 * themselves carry a later version, written as a string literal in each
 * model file, which the registry catalog needs to list a type; each has its
 * own upgrade entries after this one.
 */
export const FORK_VERSION = "2026.10.05.1";

/** Upgrade chain every type starts with; the fork changed no schema. */
export const forkUpgrades = [
  {
    toVersion: FORK_VERSION,
    description:
      "Forked from @ginger_pappa/flux 2026.06.09.1 as @dataverket/flux; no schema change",
    upgradeAttributes: (
      old: Record<string, unknown>,
    ): Record<string, unknown> => old,
  },
];

/** Live check that `flux --version` runs. */
export const fluxCliCheck = cliCheck({
  bin: "flux",
  args: ["--version"],
  description: "The flux binary runs and reports its version",
});
