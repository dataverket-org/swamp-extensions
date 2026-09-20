/**
 * `@dataverket/omnictl` — what both model types share: the global arguments
 * (endpoint, service-account key, TLS and binary path), the slice of the swamp
 * method context they use, and the translation into transport options.
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { OmnictlOptions } from "./omnictl.ts";
import { assertHttpsUrl } from "./util.ts";

/** Global arguments shared by `inventory` and `cluster`. */
export const GlobalArgs = z.object({
  endpoint: z.string().describe(
    "Omni API endpoint, e.g. https://omni.example.net",
  ),
  serviceAccountKey: z.string().describe(
    "Omni service-account key (OMNI_SERVICE_ACCOUNT_KEY); supply via " +
      '${{ vault.get("infra", "omni/service_account_key") }}. Reader role ' +
      "for inventory, Operator role for cluster",
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

/** Validate the global arguments and turn them into transport options. */
export function optionsOf(g: GlobalArgsData): OmnictlOptions {
  const endpoint = assertHttpsUrl(g.endpoint, "endpoint");
  if (!g.serviceAccountKey) {
    throw new Error("serviceAccountKey is required to reach Omni");
  }
  return {
    endpoint,
    serviceAccountKey: g.serviceAccountKey,
    insecureSkipTlsVerify: g.insecureSkipTlsVerify,
    omnictlPath: g.omnictlPath,
  };
}
