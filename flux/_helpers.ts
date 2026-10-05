/**
 * What the three Flux model types share: the global arguments, the condition
 * and source-reference schemas, and the two CLI runners. `flux` and `kubectl`
 * are run by name from PATH with the model's kubeconfig and context, so one
 * pinned toolchain serves every type.
 *
 * Forked from `@ginger_pappa/flux` 2026.06.09.1 (MIT, copyright ginger_pappa).
 * The spawn is a replaceable seam so the runners and the methods built on
 * them can be unit-tested against a strict fake, and kubectl output that is
 * not JSON is reported as a named error instead of a bare SyntaxError.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** Shared global argument schema for all flux model types. */
export const FluxGlobalArgsSchema = z.object({
  /** Kubernetes namespace. Empty string means all namespaces for list methods. */
  namespace: z.string().default(""),
  /** Path to kubeconfig file. Defaults to KUBECONFIG env var or ~/.kube/config. */
  kubeconfig: z.string().optional(),
  /** Kubernetes context name. Defaults to current context. */
  context: z.string().optional(),
});

/** The global arguments as a method receives them. */
export type FluxGlobalArgs = z.infer<typeof FluxGlobalArgsSchema>;

/** Common condition schema matching the FluxCD metav1.Condition shape. */
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
export interface RunOpts {
  kubeconfig?: string;
  context?: string;
}

/** The logger a method receives; only `info` is used here. */
export interface MethodLogger {
  info: (msg: string, props?: Record<string, string>) => void;
}

/** The context every method in this extension reads. */
export interface FluxContext<T> {
  globalArgs: FluxGlobalArgs;
  logger: MethodLogger;
  writeResource: (
    spec: string,
    name: string,
    data: T,
  ) => Promise<unknown>;
}

/** One spawned command's outcome. */
export interface SpawnResult {
  success: boolean;
  stdout: string;
  stderr: string;
}

/** Spawns a command; replaceable so the runners are testable. */
export type Spawn = (bin: string, args: string[]) => Promise<SpawnResult>;

const defaultSpawn: Spawn = async (bin, args) => {
  const out = await new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
  }).output();
  return {
    success: out.success,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
};

let testSpawn: Spawn | undefined;

/** Install a fake spawn (tests only); call with no argument to restore. */
export function __setSpawn(s?: Spawn): void {
  testSpawn = s;
}

/**
 * The full argument list for `bin`: kubeconfig and context first, when set,
 * then the command. Pure, so a test can pin it.
 */
export function cliArgs(args: string[], opts?: RunOpts): string[] {
  const full: string[] = [];
  if (opts?.kubeconfig) full.push("--kubeconfig", opts.kubeconfig);
  if (opts?.context) full.push("--context", opts.context);
  full.push(...args);
  return full;
}

/**
 * The `kubectl get` arguments for a list: one namespace when given, every
 * namespace otherwise.
 */
export function listArgs(resource: string, namespace: string): string[] {
  return namespace
    ? ["get", resource, "-n", namespace]
    : ["get", resource, "-A"];
}

/**
 * Parse what kubectl printed. Output that is not JSON becomes an error that
 * names the command, because a bare SyntaxError names nothing an operator
 * can act on.
 */
export function parseKubectlJson(text: string, args: string[]): unknown {
  try {
    return JSON.parse(text);
  } catch {
    const head = text.trim().slice(0, 120);
    throw new Error(
      `kubectl ${args.join(" ")} did not print JSON: ${head || "(empty)"}`,
    );
  }
}

/**
 * Run kubectl with optional kubeconfig/context overrides. Appends `-o json`
 * and returns the parsed response. Throws on non-zero exit.
 */
export async function runKubectl(
  args: string[],
  opts?: RunOpts,
): Promise<unknown> {
  const full = cliArgs([...args, "-o", "json"], opts);
  const result = await (testSpawn ?? defaultSpawn)("kubectl", full);
  if (!result.success) {
    throw new Error(
      `kubectl ${args.join(" ")} failed: ${result.stderr.trim()}`,
    );
  }
  return parseKubectlJson(result.stdout, args);
}

/**
 * Run a flux CLI command with optional kubeconfig/context overrides.
 * Returns stdout as a string. Throws on non-zero exit.
 */
export async function runFlux(
  args: string[],
  opts?: RunOpts,
): Promise<string> {
  const result = await (testSpawn ?? defaultSpawn)("flux", cliArgs(args, opts));
  if (!result.success) {
    throw new Error(
      `flux ${args[0]} failed: ${(result.stderr || result.stdout).trim()}`,
    );
  }
  return result.stdout;
}

/**
 * Extract the Ready condition from a FluxCD conditions array and return
 * a normalised { ready, reason, message } triple. No Ready condition at all
 * reads as not ready with reason `Unknown`.
 */
export function extractReadyCondition(
  conditions: ConditionRaw[],
): { ready: boolean; reason: string; message: string } {
  const c = conditions.find((c) => c.type === "Ready");
  return {
    ready: c?.status === "True",
    reason: c?.reason ?? "Unknown",
    message: c?.message ?? "",
  };
}

/** Narrow raw conditions to exactly the fields the schema stores. */
export function narrowConditions(conditions: ConditionRaw[]): ConditionRaw[] {
  return conditions.map((c) => ({
    type: c.type,
    status: c.status,
    reason: c.reason,
    message: c.message,
    lastTransitionTime: c.lastTransitionTime,
    observedGeneration: c.observedGeneration,
  }));
}

/** The namespace a single-object method acts on, or a named refusal. */
export function requireNamespace(
  action: string,
  argNamespace: string | undefined,
  globalNamespace: string,
): string {
  const ns = argNamespace ?? globalNamespace;
  if (!ns) {
    throw new Error(
      `namespace is required for ${action}: set it on the model or pass --arg namespace=<ns>`,
    );
  }
  return ns;
}

/** The no-op upgrade every type in this fork carries. */
export const FORK_VERSION = "2026.10.05.1";

/** Upgrade chain shared by the three types; the fork changed no schema. */
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

/**
 * Spawn `bin` with a version argument and report why it could not be run.
 * A binary missing from PATH surfaces as Deno.errors.NotFound, whose own
 * message names neither the binary nor what to do, so it is restated here.
 */
export async function cliProblem(
  bin: string,
  args: string[],
): Promise<string | undefined> {
  try {
    const out = await (testSpawn ?? defaultSpawn)(bin, args);
    if (!out.success) {
      return `${bin} ${args.join(" ")} failed: ${
        (out.stderr || out.stdout).trim()
      }`;
    }
    return undefined;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      return `${bin} is not on PATH; install it or put it on the PATH this repository runs with`;
    }
    return `${bin} could not be run: ${
      err instanceof Error ? err.message : String(err)
    }`;
  }
}

/** The outcome shape a pre-flight check returns. */
export interface CheckResult {
  pass: boolean;
  errors?: string[];
}

/** Live check that `flux --version` runs. */
export const fluxCliCheck = {
  description: "The flux binary runs and reports its version",
  labels: ["live"],
  execute: async (): Promise<CheckResult> => {
    const problem = await cliProblem("flux", ["--version"]);
    return problem ? { pass: false, errors: [problem] } : { pass: true };
  },
};

/** Live check that `kubectl version --client` runs. */
export const kubectlCliCheck = {
  description:
    "The kubectl binary runs and reports its client version; every method reads objects with it",
  labels: ["live"],
  execute: async (): Promise<CheckResult> => {
    const problem = await cliProblem("kubectl", ["version", "--client"]);
    return problem ? { pass: false, errors: [problem] } : { pass: true };
  },
};
