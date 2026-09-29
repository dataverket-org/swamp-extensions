/**
 * `@dataverket/zitadel` — global arguments, context typings, pre-flight checks
 * and the shaping helpers every model type shares.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { getToken, type Json, readKeyJson } from "./api.ts";

/**
 * Global arguments shared by every `@dataverket/zitadel/*` model. The service
 * user's key is either a value from a vault (`keyJson`) or a file the
 * definition names (`keyJsonFile`) and that is read at call time — one or the
 * other, never both.
 */
export const GlobalArgsSchema = z.object({
  apiUrl: z.string().describe(
    "Zitadel base URL and issuer, e.g. https://zitadel.example.org",
  ),
  keyJson: z.string().optional().meta({ sensitive: true }).describe(
    "Service-user machine key JSON (keyId, key, userId), from a vault: " +
      "${{ vault.get(<vault>, zitadel/key_json) }}. Use keyJsonFile instead " +
      "to keep the value out of the definition entirely.",
  ),
  keyJsonFile: z.string().optional().describe(
    "Path to the service user's machine key JSON, read at call time; " +
      "mutually exclusive with keyJson",
  ),
  orgId: z.string().optional().describe(
    "Target organization id (the x-zitadel-orgid header). Omit to act in the " +
      "service user's own organization.",
  ),
  httpTimeoutMs: z.coerce.number().int().default(30000).describe(
    "Per-request timeout in milliseconds, for the token exchange and API calls",
  ),
  tokenScope: z.string().default(
    "openid profile urn:zitadel:iam:org:project:id:zitadel:aud",
  ).describe(
    "OAuth scope requested for the API token. The project:id:zitadel:aud " +
      "scope is what grants access to Zitadel's own APIs.",
  ),
});

/** Resolved global arguments, as a method sees them. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

// Minimal structural typings for the method context, declared locally so the
// registry scorer's `deno doc` never has to resolve a JSR dependency.

/** Handle returned by `writeResource`. */
export interface DataHandle {
  name: string;
}

/** The subset of the swamp logger the models use. */
export interface Logger {
  debug(message: string, props?: Record<string, unknown>): void;
  info(message: string, props?: Record<string, unknown>): void;
  warning(message: string, props?: Record<string, unknown>): void;
}

/** The subset of the swamp method context the models use. */
export interface ModelContext {
  globalArgs: GlobalArgs;
  logger: Logger;
  signal?: AbortSignal;
  repoDir?: string;
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandle>;
  deleteResource?(instanceName: string): Promise<void>;
}

/** What every `execute` returns. */
export interface MethodResult {
  dataHandles: DataHandle[];
}

/** Result of a pre-flight check. */
export interface CheckResult {
  pass: boolean;
  errors?: string[];
}

/** The subset of the check context the shared checks use. */
interface CheckContext {
  globalArgs: GlobalArgs;
}

/** True while a value is still an unresolved `${{ … }}` expression. */
function unresolved(value: unknown): boolean {
  return typeof value === "string" && /\$\{\{/.test(value);
}

/**
 * Pre-flight checks shared by every model: the credential is named exactly once
 * (policy, offline) and the instance authenticates it (live).
 */
export const checks = {
  "credential-named": {
    description:
      "Exactly one of keyJson or keyJsonFile names the service user's key",
    labels: ["policy"],
    execute: (context: CheckContext): Promise<CheckResult> => {
      const { keyJson, keyJsonFile } = context.globalArgs;
      if (keyJson && keyJsonFile) {
        return Promise.resolve({
          pass: false,
          errors: ["give keyJson or keyJsonFile, not both"],
        });
      }
      if (!keyJson && !keyJsonFile) {
        return Promise.resolve({
          pass: false,
          errors: ["no credential: set keyJson (from a vault) or keyJsonFile"],
        });
      }
      return Promise.resolve({ pass: true });
    },
  },
  "reachable": {
    description:
      "The instance answers and the service-user key authenticates against it",
    labels: ["live"],
    execute: async (context: CheckContext): Promise<CheckResult> => {
      const g = context.globalArgs as unknown as Json;
      // `swamp model validate` does not resolve vault expressions, so the key
      // is still a literal `${{ … }}` there and cannot authenticate. The real
      // check runs at method-run time, when the secret has been resolved.
      if (unresolved(g.keyJson) || unresolved(g.apiUrl)) {
        return { pass: true };
      }
      try {
        await readKeyJson(g);
        await getToken(g);
        return { pass: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return {
          pass: false,
          errors: [
            `cannot authenticate to Zitadel at ${context.globalArgs.apiUrl}: ${message}`,
          ],
        };
      }
    },
  },
};

// ---------------------------------------------------------------------------
// Outcomes and enums
// ---------------------------------------------------------------------------

/** What a method reports it did, in every resource's `action` field. */
export const Action = z.enum([
  "observed",
  "created",
  "updated",
  "unchanged",
  "rotated",
  "revoked",
  "deactivated",
  "reactivated",
  "locked",
  "removed",
  "planned",
]);

/** {@link Action} */
export type ActionValue = z.infer<typeof Action>;

/** Friendly OIDC application type to the Zitadel enum. */
export const APP_TYPE: Record<string, string> = {
  web: "OIDC_APP_TYPE_WEB",
  spa: "OIDC_APP_TYPE_USER_AGENT",
  native: "OIDC_APP_TYPE_NATIVE",
};
/** Friendly OIDC authentication method to the Zitadel enum. */
export const AUTH_METHOD: Record<string, string> = {
  basic: "OIDC_AUTH_METHOD_TYPE_BASIC",
  post: "OIDC_AUTH_METHOD_TYPE_POST",
  none: "OIDC_AUTH_METHOD_TYPE_NONE",
  jwt: "OIDC_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT",
};
/** Friendly API-application authentication method to the Zitadel enum. */
export const API_AUTH_METHOD: Record<string, string> = {
  basic: "API_AUTH_METHOD_TYPE_BASIC",
  jwt: "API_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT",
};
/** Friendly OIDC grant type to the Zitadel enum. */
export const GRANT_TYPE: Record<string, string> = {
  authorization_code: "OIDC_GRANT_TYPE_AUTHORIZATION_CODE",
  implicit: "OIDC_GRANT_TYPE_IMPLICIT",
  refresh_token: "OIDC_GRANT_TYPE_REFRESH_TOKEN",
  device_code: "OIDC_GRANT_TYPE_DEVICE_CODE",
};
/** Friendly OIDC response type to the Zitadel enum. */
export const RESPONSE_TYPE: Record<string, string> = {
  code: "OIDC_RESPONSE_TYPE_CODE",
  id_token: "OIDC_RESPONSE_TYPE_ID_TOKEN",
  id_token_token: "OIDC_RESPONSE_TYPE_ID_TOKEN_TOKEN",
};
/** Friendly access-token type to the Zitadel OIDC enum. */
export const ACCESS_TOKEN_TYPE: Record<string, string> = {
  bearer: "OIDC_TOKEN_TYPE_BEARER",
  jwt: "OIDC_TOKEN_TYPE_JWT",
};
/** Friendly access-token type to the v2 user-service enum. */
export const USER_TOKEN_TYPE: Record<string, string> = {
  bearer: "ACCESS_TOKEN_TYPE_BEARER",
  jwt: "ACCESS_TOKEN_TYPE_JWT",
};
/** Friendly gender to the v2 user-service enum. */
export const GENDER: Record<string, string> = {
  unspecified: "GENDER_UNSPECIFIED",
  female: "GENDER_FEMALE",
  male: "GENDER_MALE",
  diverse: "GENDER_DIVERSE",
};

/** Invert a friendly-to-Zitadel map, for shaping reads back. */
export function invertEnum(
  map: Record<string, string>,
): Record<string, string> {
  return Object.fromEntries(Object.entries(map).map(([k, v]) => [v, k]));
}

/** Map a friendly value to its Zitadel enum, listing the alternatives. */
export function mapEnum(
  map: Record<string, string>,
  value: string,
  label: string,
): string {
  const mapped = map[value];
  if (!mapped) {
    throw new Error(
      `invalid ${label} ${JSON.stringify(value)}; allowed: ${
        Object.keys(map).join(", ")
      }`,
    );
  }
  return mapped;
}

/** Reduce a Zitadel state enum (`APP_STATE_ACTIVE`) to its tail (`active`). */
export function friendlyState(value: unknown): string {
  if (typeof value !== "string" || !value) return "unknown";
  const parts = value.split("_");
  return parts[parts.length - 1].toLowerCase();
}

/** Reverse-map an array of wire enums to friendly values. */
export function friendlyEnumArray(
  value: unknown,
  reverse: Record<string, string>,
): string[] | undefined {
  if (!Array.isArray(value)) return undefined;
  return value.map((entry) =>
    typeof entry === "string"
      ? (reverse[entry] ?? friendlyState(entry))
      : String(entry)
  );
}

// ---------------------------------------------------------------------------
// Small coercions
// ---------------------------------------------------------------------------

/** A value as a string, with `undefined` and `null` becoming `""`. */
export function str(value: unknown): string {
  return value === undefined || value === null ? "" : String(value);
}

/** A value as a string, or `undefined` when it is not one. */
export function optStr(value: unknown): string | undefined {
  return typeof value === "string" && value.length > 0 ? value : undefined;
}

/** A value as a boolean, or `undefined` when it is not one. */
export function optBool(value: unknown): boolean | undefined {
  return typeof value === "boolean" ? value : undefined;
}

/** A nested object, or `{}` when the field is absent. */
export function obj(value: unknown): Json {
  return value && typeof value === "object" && !Array.isArray(value)
    ? (value as Json)
    : {};
}

/** A string array, or `undefined` when the field is absent. */
export function optStrList(value: unknown): string[] | undefined {
  return Array.isArray(value) ? value.map((v) => str(v)) : undefined;
}

/** Now, as an ISO timestamp — every stored resource is stamped with it. */
export function nowIso(): string {
  return new Date().toISOString();
}

/** A Zitadel id is all digits; anything else is a name the caller typed. */
export function looksLikeId(value: string): boolean {
  return /^[0-9]+$/.test(value);
}

// ---------------------------------------------------------------------------
// Argument helpers
// ---------------------------------------------------------------------------

/**
 * An array argument that also accepts a JSON-encoded string, so the raw CLI
 * `--input key=["a","b"]` works while a real array from CEL passes through.
 */
export function jsonArray<T extends z.ZodTypeAny>(
  item: T,
): z.ZodType<z.infer<T>[]> {
  return z.preprocess((value) => {
    if (typeof value === "string") {
      const trimmed = value.trim();
      if (trimmed.startsWith("[")) {
        try {
          return JSON.parse(trimmed);
        } catch {
          return value;
        }
      }
    }
    return value;
  }, z.array(item)) as z.ZodType<z.infer<T>[]>;
}

/**
 * A boolean argument that also accepts the strings "true" and "false" from the
 * raw CLI.
 *
 * The default is declared on the schema and not only inside the preprocessor:
 * swamp reads a method's required inputs from the schema, so a fallback hidden
 * in a `preprocess` makes `dryRun` and `devMode` look mandatory to
 * `swamp workflow validate`, and every workflow step would have to pass them.
 */
export function boolArg(fallback: boolean): z.ZodType<boolean> {
  return z.preprocess(
    (value) =>
      value === undefined ? fallback : value === true || value === "true",
    z.boolean(),
  ).default(fallback) as unknown as z.ZodType<boolean>;
}

/** The `dryRun` argument every destructive method takes. */
export const DryRun = boolArg(false);

/** The same set of roles, in any order? Role sets are converged, not appended. */
export function sameRoles(a: readonly string[], b: readonly string[]): boolean {
  if (a.length !== b.length) return false;
  const sortedA = [...a].sort();
  const sortedB = [...b].sort();
  return sortedA.every((role, index) => role === sortedB[index]);
}

/** Reject an empty or whitespace-only argument. */
export function assertArg(value: string, label: string): string {
  if (!value || !value.trim()) throw new Error(`${label} must not be empty`);
  return value;
}

/**
 * The guard in front of every hard delete: the caller has to repeat the live
 * name of what they are deleting, and a mismatch stops the method before it
 * touches the API. Deactivating is the reversible alternative, so a delete is
 * worth this much friction.
 */
export function requireConfirm(
  live: string,
  confirm: string,
  label: string,
): void {
  if (live !== confirm) {
    throw new Error(
      `refusing to delete ${label}: confirm was ${
        JSON.stringify(confirm)
      } but the live ${label} is ${JSON.stringify(live)}`,
    );
  }
}

// ---------------------------------------------------------------------------
// Instance naming and writing
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash as zero-padded hex; keeps truncated names unique. */
function stableHash(input: string): string {
  let hash = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    hash ^= input.charCodeAt(i);
    hash = Math.imul(hash, 0x01000193);
  }
  return (hash >>> 0).toString(16).padStart(8, "0");
}

/**
 * Normalize a name into a safe `writeResource` instance name: lowercase,
 * non-alphanumeric runs collapsed to `-`, truncated with a hash when long.
 */
export function sanitizeInstanceName(raw: string): string {
  const cleaned = raw
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "");
  if (cleaned.length === 0) return "unnamed";
  if (cleaned.length <= 100) return cleaned;
  return `${cleaned.slice(0, 91)}-${stableHash(raw)}`;
}

/** Instance name for one resource: `<prefix>-<sanitized key>`. */
export function instanceName(prefix: string, key: string): string {
  return `${prefix}-${sanitizeInstanceName(key)}`;
}

/**
 * Write every item under `spec`, keyed by `keyOf`. Zitadel names are not
 * unique, so when two items in one batch collide the later ones get a hash
 * suffix rather than silently overwriting the first.
 */
export async function writeAll<T extends Record<string, unknown>>(
  context: ModelContext,
  spec: string,
  prefix: string,
  items: readonly T[],
  keyOf: (item: T) => string,
): Promise<DataHandle[]> {
  const seen = new Set<string>();
  const handles: DataHandle[] = [];
  for (const item of items) {
    let name = instanceName(prefix, keyOf(item));
    if (seen.has(name)) {
      const suffixed = `${name}-${
        stableHash(JSON.stringify(item)).slice(0, 8)
      }`;
      context.logger.warning(
        "duplicate instance {name}; storing as {instance}",
        {
          name,
          instance: suffixed,
        },
      );
      name = suffixed;
    }
    seen.add(name);
    handles.push(await context.writeResource(spec, name, item));
  }
  return handles;
}

/**
 * Tombstone one stored instance, for the member of a collection that has just
 * been deleted upstream.
 *
 * Swamp infers a method's lifecycle kind from its name, and a method named
 * `delete`, `destroy` or `remove` marks *every* declared resource of the model
 * deleted — right for a model that stands for one resource, wrong for these
 * types, where one model holds every project or user of an organization. The
 * destructive methods here therefore declare `kind: "action"` and tombstone the
 * one instance that is gone, which is what `context.deleteResource` does.
 */
export async function forgetInstance(
  context: ModelContext,
  prefix: string,
  key: string,
): Promise<void> {
  if (!context.deleteResource) return;
  await context.deleteResource(instanceName(prefix, key));
}

/** Write one item under `spec`, keyed by `key`. */
export async function writeOne<T extends Record<string, unknown>>(
  context: ModelContext,
  spec: string,
  prefix: string,
  key: string,
  item: T,
): Promise<DataHandle[]> {
  return [
    await context.writeResource(spec, instanceName(prefix, key), item),
  ];
}
