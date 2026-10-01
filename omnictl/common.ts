/**
 * `@dataverket/omnictl` — what both model types share: the global arguments
 * (endpoint, service-account key, TLS and binary path), the slice of the swamp
 * method context they use, and the translation into transport options.
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { OmnictlOptions } from "./omnictl.ts";
import { assertHttpsUrl, readSecretFile } from "./util.ts";

/** Global arguments shared by `inventory` and `cluster`. */
export const GlobalArgs = z.object({
  endpoint: z.string().describe(
    "Omni API endpoint, e.g. https://omni.example.net",
  ),
  serviceAccountKeyFile: z.string().optional().describe(
    "Path to a file holding the Omni service-account key, read at call time, " +
      "e.g. ~/.talos/omni/<name>.key. For a key an operator's session writes " +
      "and rotates: the path is not a secret, so the definition carries no " +
      "value. Reader role for inventory, Operator for cluster",
  ),
  serviceAccountKey: z.string().optional().describe(
    "Omni service-account key (OMNI_SERVICE_ACCOUNT_KEY) as a value; " +
      'supply via ${{ vault.get("infra", "omni/service_account_key") }}. ' +
      "For a key the process owns, with no operator session behind it. " +
      "Mutually exclusive with serviceAccountKeyFile",
  ).meta({ sensitive: true }),
  insecureSkipTlsVerify: z.boolean().default(false).describe(
    "Skip TLS verification for the Omni API (use only for self-signed certs)",
  ),
  omnictlPath: z.string().default("omnictl").describe(
    "Path to the omnictl binary; override when it is not on PATH",
  ),
});
/** {@link GlobalArgs} */
export type GlobalArgsData = z.infer<typeof GlobalArgs>;

/** Handle returned by `writeResource`. */
export interface DataHandle {
  name: string;
}
/** The subset of the swamp method context the models use. */
export interface MethodContext {
  globalArgs: GlobalArgsData;
  signal?: AbortSignal;
  /** The repository the method runs in; relative file paths resolve here. */
  repoDir?: string;
  logger: {
    info(message: string, props?: Record<string, unknown>): void;
    warning(message: string, props?: Record<string, unknown>): void;
  };
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandle>;
  deleteResource?(name: string): Promise<void>;
}
/** What every `execute` returns. */
export interface MethodResult {
  dataHandles: DataHandle[];
}

/**
 * The service-account key: read from the file when one is named, taken from
 * the argument otherwise. Exactly one of the two is set; both is a mistake
 * worth naming rather than resolving by precedence, and neither cannot reach
 * Omni at all.
 */
export function resolveServiceAccountKey(g: GlobalArgsData): string {
  if (g.serviceAccountKeyFile && g.serviceAccountKey) {
    throw new Error(
      "set serviceAccountKeyFile or serviceAccountKey, not both",
    );
  }
  if (g.serviceAccountKeyFile) {
    return readSecretFile(g.serviceAccountKeyFile, "serviceAccountKeyFile");
  }
  if (!g.serviceAccountKey) {
    throw new Error(
      "set serviceAccountKeyFile or serviceAccountKey to reach Omni",
    );
  }
  return g.serviceAccountKey;
}

/** Validate the global arguments and turn them into transport options. */
export function optionsOf(g: GlobalArgsData): OmnictlOptions {
  const endpoint = assertHttpsUrl(g.endpoint, "endpoint");
  return {
    endpoint,
    serviceAccountKey: resolveServiceAccountKey(g),
    insecureSkipTlsVerify: g.insecureSkipTlsVerify,
    omnictlPath: g.omnictlPath,
  };
}
