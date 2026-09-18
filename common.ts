/**
 * `@dataverket/openstack` — shared global arguments, context typings,
 * pre-flight checks, and JSON-shaping helpers used by every model.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  buildEnv,
  type CliOptions,
  describeAuth,
  isNotFound,
  mapLimit,
  openstackJson,
  openstackVersion,
} from "./cli.ts";

/**
 * Global arguments shared by all `@dataverket/openstack/*` models. Either
 * `cloud` (a `clouds.yaml` entry) or `authUrl` + an application credential
 * must be given; both compose, with the credential overriding the cloud's
 * auth section.
 */
export const GlobalArgsSchema = z.object({
  cloud: z.string().optional().describe(
    "Named cloud from clouds.yaml (exported as OS_CLOUD)",
  ),
  cloudsFile: z.string().optional().describe(
    "clouds.yaml to read instead of the default locations (OS_CLIENT_CONFIG_FILE)",
  ),
  authUrl: z.string().optional().describe(
    "Keystone v3 endpoint (OS_AUTH_URL); needed when no cloud is named",
  ),
  applicationCredentialId: z.string().optional().describe(
    "Application credential id (OS_APPLICATION_CREDENTIAL_ID)",
  ),
  applicationCredentialSecret: z.string().optional().describe(
    'Application credential secret; supply via ${{ vault.get("<vault>", "<key>") }}',
  ).meta({ sensitive: true }),
  region: z.string().optional().describe("Region name (OS_REGION_NAME)"),
  interface: z.enum(["public", "internal", "admin"]).optional().describe(
    "Endpoint interface to use from the catalog (OS_INTERFACE)",
  ),
  openstackPath: z.string().default("openstack").describe(
    "Path to the openstack CLI binary; override when it is not on PATH",
  ),
  concurrency: z.number().int().min(1).max(16).default(4).describe(
    "How many `openstack ... show` calls run in parallel when listing",
  ),
});
/** {@link GlobalArgsSchema} */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Translate validated global arguments into CLI transport options. */
export function cliOptions(g: GlobalArgs): CliOptions {
  return {
    cloud: g.cloud,
    cloudsFile: g.cloudsFile,
    authUrl: g.authUrl,
    applicationCredentialId: g.applicationCredentialId,
    applicationCredentialSecret: g.applicationCredentialSecret,
    region: g.region,
    interface: g.interface,
    openstackPath: g.openstackPath,
  };
}

// Minimal structural typings for the method context, declared locally so the
// registry scorer's `deno doc` never needs to resolve a JSR dependency.

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

/** A raw JSON object as the CLI prints it. */
export type Raw = Record<string, unknown>;

/** The subset of the check context the shared checks use. */
interface CheckContext {
  globalArgs: GlobalArgs;
}

/**
 * Pre-flight checks shared by every model: authentication is configured
 * (policy, offline) and the CLI binary answers (live).
 */
export const checks = {
  "auth-configured": {
    description:
      "A clouds.yaml cloud or an application credential is configured",
    labels: ["policy"],
    execute: (context: CheckContext): Promise<CheckResult> => {
      try {
        describeAuth(buildEnv(cliOptions(context.globalArgs)));
        return Promise.resolve({ pass: true });
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return Promise.resolve({ pass: false, errors: [message] });
      }
    },
  },
  "openstack-cli": {
    description: "The openstack CLI binary runs and reports its version",
    labels: ["live"],
    execute: async (context: CheckContext): Promise<CheckResult> => {
      try {
        await openstackVersion(cliOptions(context.globalArgs));
        return { pass: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { pass: false, errors: [message] };
      }
    },
  },
};

/** Result of a pre-flight check. */
export interface CheckResult {
  pass: boolean;
  errors?: string[];
}

// ---------------------------------------------------------------------------
// Instance naming
// ---------------------------------------------------------------------------

/** FNV-1a 32-bit hash as zero-padded hex; keeps truncated names unique. */
function stableHash(input: string): string {
  let h = 0x811c9dc5;
  for (let i = 0; i < input.length; i++) {
    h ^= input.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return (h >>> 0).toString(16).padStart(8, "0");
}

/**
 * Normalize an arbitrary string into a safe `writeResource` instance name:
 * lowercase, non-alphanumeric runs collapsed to `-`, trimmed, truncated with
 * a hash suffix when long.
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

/** Something with an OpenStack id and a display name. */
export interface Named {
  id: string;
  name: string;
}

/**
 * Instance name for one resource: `<prefix>-<sanitized name>`, falling back
 * to the id when the name is empty. The prefix discriminates specs, since
 * instance names are global within a model.
 */
export function instanceName(prefix: string, item: Named): string {
  return `${prefix}-${sanitizeInstanceName(item.name || item.id)}`;
}

/**
 * Write every item under `spec`. OpenStack names are not unique, so when two
 * items in one batch share a name the later ones get an id suffix instead of
 * silently overwriting the first.
 */
export async function writeAll<T extends Named & Record<string, unknown>>(
  context: ModelContext,
  spec: string,
  prefix: string,
  items: readonly T[],
): Promise<DataHandle[]> {
  const seen = new Set<string>();
  const handles: DataHandle[] = [];
  for (const item of items) {
    let name = instanceName(prefix, item);
    if (seen.has(name)) {
      const suffixed = `${name}-${item.id.slice(0, 8)}`;
      context.logger.warning(
        "duplicate name {name}; storing {id} as {instance}",
        { name: item.name, id: item.id, instance: suffixed },
      );
      name = suffixed;
    }
    seen.add(name);
    handles.push(await context.writeResource(spec, name, item));
  }
  return handles;
}

// ---------------------------------------------------------------------------
// Argument hygiene
// ---------------------------------------------------------------------------

/**
 * Validate a value destined for a CLI positional or flag value. Rejects empty
 * strings, leading dashes (flag injection) and control characters.
 */
export function assertArg(value: string, label: string): string {
  if (value.length === 0) throw new Error(`${label} must not be empty`);
  if (value.startsWith("-")) {
    throw new Error(`${label} must not start with "-" (got ${value})`);
  }
  // deno-lint-ignore no-control-regex
  if (/[\x00-\x1f]/.test(value)) {
    throw new Error(`${label} must not contain control characters`);
  }
  return value;
}

/** True for a canonical 8-4-4-4-12 hex UUID. */
export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i
    .test(value);
}

/** `--flag k=v` pairs for a record of properties. */
export function propertyFlags(
  flag: string,
  props: Record<string, string> | undefined,
): string[] {
  const out: string[] = [];
  for (const [k, v] of Object.entries(props ?? {})) {
    assertArg(k, "property key");
    if (k.includes("=")) throw new Error(`property key must not contain "="`);
    out.push(flag, `${k}=${v}`);
  }
  return out;
}

/** `--flag value` repeated for each value. */
export function repeatFlag(
  flag: string,
  values: readonly string[] | undefined,
  label: string,
): string[] {
  const out: string[] = [];
  for (const v of values ?? []) out.push(flag, assertArg(v, label));
  return out;
}

/**
 * Write `content` to a private temporary file, run `fn` with its path, and
 * remove the file on every code path. Used for `--user-data`, `--public-key`
 * and similar flags that only accept a file.
 */
export async function withTempFile<T>(
  content: string,
  fn: (path: string) => Promise<T>,
): Promise<T> {
  const path = await Deno.makeTempFile({ prefix: "swamp-openstack-" });
  try {
    await Deno.writeTextFile(path, content, { mode: 0o600 });
    return await fn(path);
  } finally {
    await Deno.remove(path).catch(() => {});
  }
}

// ---------------------------------------------------------------------------
// Coercion of raw CLI JSON
// ---------------------------------------------------------------------------

/** String coercion: `null`/`undefined` become `""`, objects are serialized. */
export function str(v: unknown): string {
  if (v === null || v === undefined) return "";
  if (typeof v === "object") return JSON.stringify(v);
  return String(v);
}

/** Number coercion; anything non-numeric becomes `0`. */
export function num(v: unknown): number {
  if (typeof v === "number") return Number.isFinite(v) ? v : 0;
  if (typeof v === "string" && v.trim() !== "") {
    const n = Number(v);
    return Number.isFinite(n) ? n : 0;
  }
  return 0;
}

/** Number or `null` when absent — for fields where 0 is meaningful. */
export function numOrNull(v: unknown): number | null {
  if (v === null || v === undefined || v === "") return null;
  return num(v);
}

/** Boolean coercion accepting the CLI's `True`/`False` strings. */
export function bool(v: unknown): boolean {
  if (typeof v === "boolean") return v;
  if (typeof v === "string") return /^(true|yes|1)$/i.test(v);
  return false;
}

/** Array of strings; non-arrays become `[]`. */
export function strList(v: unknown): string[] {
  return Array.isArray(v) ? v.map(str) : [];
}

/** Record of strings; non-objects become `{}`. */
export function strRecord(v: unknown): Record<string, string> {
  if (v === null || typeof v !== "object" || Array.isArray(v)) return {};
  const out: Record<string, string> = {};
  for (const [k, val] of Object.entries(v as Raw)) out[k] = str(val);
  return out;
}

/** The raw object as a record, or `{}` when it is not one. */
export function obj(v: unknown): Raw {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? v as Raw
    : {};
}

/** Array of raw objects; non-arrays become `[]`. */
export function objList(v: unknown): Raw[] {
  return Array.isArray(v) ? v.map(obj) : [];
}

/** Ensure a CLI `show` result is an object with an `id`. */
export function assertShow(raw: unknown, what: string): Raw {
  const o = obj(raw);
  if (typeof o.id !== "string" || o.id.length === 0) {
    throw new Error(`openstack ${what} returned no id: ${str(raw)}`);
  }
  return o;
}

/** Ensure a CLI `list` result is an array of objects. */
export function assertList(raw: unknown, what: string): Raw[] {
  if (!Array.isArray(raw)) {
    throw new Error(`openstack ${what} did not return a list: ${str(raw)}`);
  }
  return raw.map(obj);
}

// ---------------------------------------------------------------------------
// Common CLI patterns
// ---------------------------------------------------------------------------

/**
 * `openstack <kind> list -c ID [filters]` followed by a bounded fan-out of
 * `openstack <kind> show <id>`, so `list` and `get` yield identical shapes.
 * `kind` is the CLI noun (`server`, `floating ip`, ...), given as words.
 */
export async function listThenShow(
  context: ModelContext,
  kind: string[],
  filters: string[],
): Promise<Raw[]> {
  const opts = cliOptions(context.globalArgs);
  const rows = assertList(
    await openstackJson(opts, [...kind, "list", "-c", "ID", ...filters]),
    `${kind.join(" ")} list`,
  );
  const ids = rows.map((r) => str(r.ID)).filter((id) => id.length > 0);
  context.logger.debug("{kind} list returned {count} ids", {
    kind: kind.join(" "),
    count: ids.length,
  });
  return await mapLimit(
    ids,
    context.globalArgs.concurrency,
    (id) => showRaw(context, kind, id),
  );
}

/** `openstack <kind> show <target>` as a raw object with an id. */
export async function showRaw(
  context: ModelContext,
  kind: string[],
  target: string,
): Promise<Raw> {
  const opts = cliOptions(context.globalArgs);
  const what = `${kind.join(" ")} show`;
  return assertShow(
    await openstackJson(opts, [...kind, "show", assertArg(target, what)]),
    what,
  );
}

/** Like {@link showRaw} but resolves to `null` when the target is missing. */
export async function showRawOrNull(
  context: ModelContext,
  kind: string[],
  target: string,
): Promise<Raw | null> {
  try {
    return await showRaw(context, kind, target);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

/**
 * The id of `target`: unchanged when it already is a UUID, otherwise looked
 * up with `openstack <kind> show`. For CLI flags that only take UUIDs.
 */
export async function resolveId(
  context: ModelContext,
  kind: string[],
  target: string,
): Promise<string> {
  if (isUuid(target)) return target;
  return str((await showRaw(context, kind, target)).id);
}

/**
 * `key=value,key=value` for the CLI's structured flags (`--fixed-ip`,
 * `--nic`, `--block-device`, ...). Undefined values are skipped; a value
 * containing a comma would break the CLI's parser and is rejected.
 */
export function csvPairs(pairs: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const [k, v] of Object.entries(pairs)) {
    if (v === undefined || v === null || v === "") continue;
    const text = String(v);
    if (text.includes(",")) {
      throw new Error(`${k} must not contain a comma (got ${text})`);
    }
    parts.push(`${k}=${text}`);
  }
  return parts.join(",");
}

/** Sleep that rejects when `signal` aborts. */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(new Error("aborted"));
    const t = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    const onAbort = () => {
      clearTimeout(t);
      reject(new Error("aborted"));
    };
    signal?.addEventListener("abort", onAbort, { once: true });
  });
}

let pollIntervalMs = 3000;

/** Override the default poll interval (tests only); omit to restore. */
export function __setPollInterval(ms?: number): void {
  pollIntervalMs = ms ?? 3000;
}

/**
 * Poll `probe` every `intervalMs` until it returns a non-undefined value or
 * `timeoutMs` elapses. The CLI call inside `probe` already takes a couple of
 * seconds, so the interval is a floor, not a period.
 */
export async function pollUntil<T>(
  probe: () => Promise<T | undefined>,
  what: string,
  timeoutMs: number,
  signal?: AbortSignal,
  intervalMs = pollIntervalMs,
): Promise<T> {
  const deadline = Date.now() + timeoutMs;
  for (;;) {
    const value = await probe();
    if (value !== undefined) return value;
    if (Date.now() >= deadline) {
      throw new Error(
        `timed out after ${timeoutMs / 1000}s waiting for ${what}`,
      );
    }
    await sleep(intervalMs, signal);
  }
}

/** Current time as ISO-8601. */
export function now(): string {
  return new Date().toISOString();
}

/** Re-exports so models import everything CLI-related from one place. */
export { isNotFound, mapLimit };
