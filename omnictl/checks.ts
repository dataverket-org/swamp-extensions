/**
 * Pre-flight checks shared by both models: the service-account key resolves,
 * and Omni accepts it. They run before a method touches Omni, so a missing
 * file or an expired key stops the run with a message an operator can act on
 * instead of a signing error from deep inside `omnictl`.
 *
 * @module
 */
import { type GlobalArgsData, optionsOf } from "./common.ts";
import { getResources } from "./omnictl.ts";

/** The subset of the check context the shared checks use. */
export interface CheckContext {
  globalArgs: GlobalArgsData;
}

/** Result of a pre-flight check. */
export interface CheckResult {
  pass: boolean;
  errors?: string[];
}

/** A small resource every Omni role can read; the live check lists it. */
export const PROBE_TYPE = "Clusters.omni.sidero.dev";

/**
 * What `omnictl` prints when the service account's key can no longer sign,
 * which is how an expired key shows: `failed to sign message: gopenpgp: ...
 * no valid signing keys`.
 */
const EXPIRED = /no valid signing keys|key (has )?expired|signature expired/i;

/**
 * Turn an `omnictl` failure into the message a check reports. An expired key
 * names where the key came from, the file or the argument, and says what to
 * do; anything else passes through as `run()` produced it, key redacted.
 */
export function explainAuthFailure(
  message: string,
  g: GlobalArgsData,
): string {
  if (!EXPIRED.test(message)) return message;
  const where = g.serviceAccountKeyFile
    ? `the key in ${g.serviceAccountKeyFile}`
    : "the key in serviceAccountKey";
  return `${where} has expired and Omni will not accept it; mint a new service account key (${message})`;
}

const failed = (err: unknown): CheckResult => ({
  pass: false,
  errors: [err instanceof Error ? err.message : String(err)],
});

export const checks = {
  "service-account-key": {
    description:
      "The endpoint is https, and the service account key is set once: a key file exists, is readable and is not empty, or a value is given",
    labels: ["policy"],
    execute: (context: CheckContext): Promise<CheckResult> => {
      try {
        optionsOf(context.globalArgs);
        return Promise.resolve({ pass: true });
      } catch (err) {
        return Promise.resolve(failed(err));
      }
    },
  },
  "omni-authenticates": {
    description:
      "Omni accepts the service account key: one authenticated read through omnictl",
    labels: ["live"],
    execute: async (context: CheckContext): Promise<CheckResult> => {
      let opts;
      try {
        opts = optionsOf(context.globalArgs);
      } catch (err) {
        return failed(err);
      }
      try {
        await getResources(PROBE_TYPE, opts);
        return { pass: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          pass: false,
          errors: [explainAuthFailure(message, context.globalArgs)],
        };
      }
    },
  },
};
