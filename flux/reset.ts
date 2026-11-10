/**
 * Adds to `@dataverket/flux/helmrelease` the one recovery action the base
 * type lacks: a reconcile with `--reset`, which clears a HelmRelease's failure
 * counters so helm-controller tries again after `RetriesExceeded`. Without it a
 * release whose first install timed out stays failed forever, even when every
 * workload it created is healthy.
 *
 * Same shape as the base type, and deliberately so: `flux` and `kubectl` are
 * run by name from PATH through the same runners `helmrelease.ts` uses, so a
 * pinned toolchain is arranged the same way for the base type and for this
 * method.
 * The object is read back with kubectl and the outcome recorded. Written as
 * an extension before the base type was forked in, and kept as one: it
 * carries the two CLI pre-flight checks the base type's methods rely on.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { type CliError, isCliError, pollBudget, redact } from "../lib/cli.ts";
import {
  checkName,
  dataName,
  getArgs,
  kubectlCliCheck,
  kubectlOpts,
  nonEmpty,
  obj,
  requireNamespace,
  runKubectl,
} from "../lib/kubectl.ts";
import { fluxCliCheck, reconcileTimeout, runFlux } from "./_helpers.ts";

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

const RESOURCE = "helmreleases.helm.toolkit.fluxcd.io";

/**
 * The data name of a `resetResult` record. The dot keeps it apart from the
 * `<namespace>--<name>` record of `list`, as `detail.` does for `get`: swamp
 * keys data by name, and a namespace holds no dot.
 */
export function resetName(namespace: string, name: string): string {
  return `reset.${dataName(namespace, name)}`;
}

/**
 * The reset request helm-controller last handled, from
 * `status.lastHandledResetAt`. `flux reconcile --reset` writes a new
 * timestamp in the `reconcile.fluxcd.io/resetAt` annotation, and
 * helm-controller copies it here when it clears the failure counters. A
 * value that changed over a flux run is the proof that the reset happened.
 */
export function handledResetAt(item: Record<string, unknown>): string {
  return nonEmpty(obj(item.status).lastHandledResetAt) ?? "";
}

/**
 * How long, and how often, `status.lastHandledResetAt` is read again after a
 * flux that ran out of time. helm-controller writes the field to the object
 * just before it starts the Helm action, so during a long install or upgrade
 * it is already there; the wait is for a controller that had not got to the
 * release yet when flux gave up.
 */
export const RESET_SETTLE_MS = 30_000;
export const RESET_POLL_MS = 5_000;

/**
 * Whether a failed flux ran out of time: stopped at the process limit, or
 * giving up by itself after its own five minutes. Anything else, a refused
 * patch or an expired login among it, is an answer and is not waited on.
 */
export function ranOutOfTime(err: CliError): boolean {
  return err.kind === "timeout" ||
    /context deadline exceeded|timed out waiting/i.test(
      `${err.message}\n${err.stderr}`,
    );
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
    readyMessage: redact(ready?.message ?? ""),
    deployStatus: history[0]?.status as string | undefined,
    installFailures: Number(status.installFailures ?? 0),
    upgradeFailures: Number(status.upgradeFailures ?? 0),
    timestamp: new Date().toISOString(),
  };
}

/** Adds `reset` and the CLI checks to `@dataverket/flux/helmrelease`. */
export const extension = {
  type: "@dataverket/flux/helmrelease",
  checks: [{
    "flux-cli-available": fluxCliCheck,
    "kubectl-cli-available": kubectlCliCheck,
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
        "Reconcile a HelmRelease with --reset: clears its failure counters so helm-controller retries a release stuck at RetriesExceeded. Waits for the attempt and records the result. When flux fails and helm-controller did not handle the reset, nothing is recorded and flux's error is thrown.",
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
        checkName(args.name);
        const namespace = requireNamespace(
          "reset",
          args.namespace,
          context.globalArgs.namespace,
        );
        const opts = kubectlOpts(context);
        context.logger.info(
          "Resetting and reconciling HelmRelease {name} in {namespace}",
          {
            name: args.name,
            namespace,
          },
        );
        // Read first: a release that is not there is refused before flux
        // runs, and this is the value a handled reset must change.
        const read = async () =>
          obj(await runKubectl(getArgs(RESOURCE, args.name, namespace), opts));
        const handledBefore = handledResetAt(await read());
        let attemptError: string | undefined;
        let outOfTime = false;
        try {
          await runFlux(
            resetArgs({
              name: args.name,
              namespace,
              withSource: args.withSource,
            }),
            opts,
            reconcileTimeout("helmrelease", args.withSource),
          );
        } catch (e) {
          // Only a flux that ran and failed, or ran out of time, is an
          // attempt. A cancelled run, a missing binary and anything else are
          // thrown as they are.
          if (!isCliError(e, "failed", "timeout")) throw e;
          // The attempt itself may fail again; record what the object says rather than hide it.
          attemptError = e.message;
          outOfTime = ranOutOfTime(e);
        }
        let raw = await read();
        if (outOfTime) {
          // flux stopped waiting, which says nothing about helm-controller:
          // give the field a short, bounded time to show up.
          const budget = pollBudget(RESET_SETTLE_MS);
          while (
            handledResetAt(raw) === handledBefore &&
            await budget.wait(RESET_POLL_MS, context.signal)
          ) raw = await read();
        }
        if (
          attemptError !== undefined && handledResetAt(raw) === handledBefore
        ) {
          // flux failed and helm-controller shows no handled reset. After a
          // refused patch or an expired login nothing was asked for. After
          // a flux that ran out of time the request may still be waiting.
          // Either way what the object says is what it said before, so it
          // is not recorded as the outcome of a reset.
          throw new Error(
            outOfTime
              ? `${attemptError}; the reset was not handled within ${
                RESET_SETTLE_MS / 1000
              } more seconds: not yet, or not at all (status.lastHandledResetAt did not change), so nothing was recorded`
              : `${attemptError}; the reset was not handled (status.lastHandledResetAt did not change), so nothing was recorded`,
          );
        }
        const result = summarize(raw, args.name, namespace);
        const handle = await context.writeResource(
          "resetResult",
          resetName(namespace, args.name),
          result,
        );
        context.logger.info("HelmRelease {name}: ready={ready} {reason}", {
          name: args.name,
          ready: String(result.ready),
          reason: result.readyReason,
        });
        if (attemptError !== undefined) {
          if (!result.ready) throw new Error(attemptError);
          // The reset was handled and the release is ready, so the method
          // succeeds; what flux said is kept in the log.
          context.logger.info(
            "flux reported a failure, but the reset was handled and HelmRelease {name} is ready: {error}",
            { name: args.name, error: attemptError },
          );
        }
        return { dataHandles: [handle] };
      },
    },
  }],
};
