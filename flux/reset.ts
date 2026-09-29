/**
 * Adds to `@ginger_pappa/flux/helmrelease` the one action the upstream model
 * lacks: a reconcile with `--reset`, which clears a HelmRelease's failure
 * counters so helm-controller tries again after `RetriesExceeded`. Without it a
 * release whose first install timed out stays failed forever, even when every
 * workload it created is healthy.
 *
 * Same shape as upstream, and deliberately so: `flux` and `kubectl` are run
 * by name from PATH, exactly as `@ginger_pappa/flux` runs them, so a pinned
 * toolchain is arranged the same way for the base type and for this method.
 * The object is read back with kubectl and the outcome recorded.
 *
 * @module
 */
import { z } from "npm:zod@4";

const ResetArgsSchema = z.object({
  /** HelmRelease name. */
  name: z.string().min(1),
  /** Namespace of the HelmRelease. Defaults to the model's namespace. */
  namespace: z.string().optional(),
  /** Also reconcile the upstream source before the release. */
  withSource: z.boolean().optional(),
});

/** What a reset attempt leaves behind: readiness, Helm status, counters. */
export const ResetResultSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  ready: z.boolean(),
  readyReason: z.string(),
  readyMessage: z.string(),
  /** Helm release status of the newest history entry (deployed, failed, …). */
  deployStatus: z.string().optional(),
  installFailures: z.number(),
  upgradeFailures: z.number(),
  timestamp: z.string(),
});

interface GlobalArgs {
  namespace?: string;
  kubeconfig?: string;
  context?: string;
}

/** The exact `flux` argument list; pure so the test can pin it. */
export function resetArgs(
  a: { name: string; namespace: string; withSource?: boolean },
): string[] {
  const args = [
    "reconcile",
    "helmrelease",
    a.name,
    "-n",
    a.namespace,
    "--reset",
  ];
  if (a.withSource) args.push("--with-source");
  return args;
}

/** Reduce a HelmRelease object to the recorded result. */
export function summarize(
  obj: Record<string, unknown>,
  name: string,
  namespace: string,
): z.infer<typeof ResetResultSchema> {
  const status = (obj.status ?? {}) as Record<string, unknown>;
  const conds = (status.conditions ?? []) as Array<Record<string, string>>;
  const ready = conds.find((c) => c.type === "Ready");
  const history = (status.history ?? []) as Array<Record<string, unknown>>;
  return {
    name,
    namespace,
    ready: ready?.status === "True",
    readyReason: ready?.reason ?? "",
    readyMessage: ready?.message ?? "",
    deployStatus: history[0]?.status as string | undefined,
    installFailures: Number(status.installFailures ?? 0),
    upgradeFailures: Number(status.upgradeFailures ?? 0),
    timestamp: new Date().toISOString(),
  };
}

/** One spawned command's outcome. */
export interface SpawnResult {
  success: boolean;
  stdout: string;
  stderr: string;
}
/** Spawns a command; replaceable so checks and methods are testable. */
export type Spawn = (
  bin: string,
  args: string[],
  signal?: AbortSignal,
) => Promise<SpawnResult>;

const defaultSpawn: Spawn = async (bin, args, signal) => {
  const out = await new Deno.Command(bin, {
    args,
    stdout: "piped",
    stderr: "piped",
    signal,
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
 * Run `bin` and return stdout, or throw with its stderr. A binary that is
 * not on PATH throws Deno.errors.NotFound from the spawn itself, which is a
 * message naming nothing an operator can act on; the checks below turn that
 * into a named failure before a method ever gets here.
 */
async function run(
  bin: string,
  args: string[],
  g: GlobalArgs,
  signal?: AbortSignal,
): Promise<string> {
  const full: string[] = [];
  if (g.kubeconfig) full.push("--kubeconfig", g.kubeconfig);
  if (g.context) full.push("--context", g.context);
  full.push(...args);
  const out = await (testSpawn ?? defaultSpawn)(bin, full, signal);
  const { stdout, stderr } = out;
  if (!out.success) {
    throw new Error(`${bin} ${args[0]} failed: ${(stderr || stdout).trim()}`);
  }
  return stdout;
}

/**
 * Spawn `bin` with a version argument and report why it could not be run.
 * A binary missing from PATH surfaces as Deno.errors.NotFound, whose own
 * message names neither the binary nor what to do, so it is restated here.
 */
export async function cliProblem(
  bin: string,
  args: string[],
  signal?: AbortSignal,
): Promise<string | undefined> {
  try {
    const out = await (testSpawn ?? defaultSpawn)(bin, args, signal);
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

/** Adds `reset` to `@ginger_pappa/flux/helmrelease`. */
export const extension = {
  type: "@ginger_pappa/flux/helmrelease",
  checks: [{
    "flux-cli-available": {
      description: "The flux binary runs and reports its version",
      labels: ["live"],
      execute: async (context: { signal?: AbortSignal }) => {
        const problem = await cliProblem("flux", ["--version"], context.signal);
        return problem ? { pass: false, errors: [problem] } : { pass: true };
      },
    },
    "kubectl-cli-available": {
      description:
        "The kubectl binary runs and reports its client version; reset reads the object back with it",
      labels: ["live"],
      execute: async (context: { signal?: AbortSignal }) => {
        const problem = await cliProblem(
          "kubectl",
          ["version", "--client"],
          context.signal,
        );
        return problem ? { pass: false, errors: [problem] } : { pass: true };
      },
    },
  }],
  resources: {
    resetResult: {
      description:
        "Outcome of a reconcile with --reset: readiness and failure counters afterwards.",
      schema: ResetResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    reset: {
      description:
        "Reconcile a HelmRelease with --reset: clears its failure counters so helm-controller retries a release stuck at RetriesExceeded. Waits for the attempt and records the result.",
      arguments: ResetArgsSchema,
      execute: async (
        args: z.infer<typeof ResetArgsSchema>,
        context: {
          globalArgs: GlobalArgs;
          signal: AbortSignal;
          logger: { info(msg: string, props?: Record<string, unknown>): void };
          writeResource: (
            specName: string,
            name: string,
            data: Record<string, unknown>,
          ) => Promise<{ name: string }>;
        },
      ) => {
        const namespace = args.namespace ?? context.globalArgs.namespace;
        if (!namespace) {
          throw new Error(
            "namespace is required: set it on the model or pass --input namespace=<ns>",
          );
        }
        context.logger.info(
          "Resetting and reconciling HelmRelease {name} in {namespace}",
          {
            name: args.name,
            namespace,
          },
        );
        let attemptError: string | undefined;
        try {
          await run(
            "flux",
            resetArgs({
              name: args.name,
              namespace,
              withSource: args.withSource,
            }),
            context.globalArgs,
            context.signal,
          );
        } catch (e) {
          // The attempt itself may fail again; record what the object says rather than hide it.
          attemptError = e instanceof Error ? e.message : String(e);
        }
        const raw = JSON.parse(
          await run(
            "kubectl",
            ["get", "helmrelease", args.name, "-n", namespace, "-o", "json"],
            context.globalArgs,
            context.signal,
          ),
        ) as Record<string, unknown>;
        const result = summarize(raw, args.name, namespace);
        const handle = await context.writeResource(
          "resetResult",
          `${namespace}--${args.name}`,
          result,
        );
        context.logger.info("HelmRelease {name}: ready={ready} {reason}", {
          name: args.name,
          ready: String(result.ready),
          reason: result.readyReason,
        });
        if (attemptError && !result.ready) throw new Error(attemptError);
        return { dataHandles: [handle] };
      },
    },
  }],
};
