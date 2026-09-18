/**
 * `@dataverket/openstack` — `openstack` CLI subprocess transport.
 *
 * Every model in this extension talks to OpenStack through the official
 * `openstack` CLI (python-openstackclient) and reads its `-f json` output.
 * The CLI already handles Keystone auth types, the service catalog, API
 * microversion negotiation and pagination, so the models only shape JSON.
 *
 * Authentication is passed through the environment. Either a named cloud from
 * `clouds.yaml` (`OS_CLOUD`) or an application credential
 * (`OS_AUTH_TYPE=v3applicationcredential` + id/secret) is exported for the
 * subprocess; when the model supplies either, inherited `OS_*` variables are
 * dropped so the call is deterministic. The application-credential secret is
 * redacted from any error text.
 *
 * One injectable seam — {@link __setRunner} — lets tests supply canned CLI
 * output without an `openstack` binary or a live cloud.
 *
 * @module
 */

/** How the CLI authenticates and where the binary lives. */
export interface CliOptions {
  /** Named cloud in `clouds.yaml` (`OS_CLOUD`). */
  cloud?: string;
  /** Explicit clouds.yaml path (`OS_CLIENT_CONFIG_FILE`). */
  cloudsFile?: string;
  /** Keystone v3 endpoint (`OS_AUTH_URL`). */
  authUrl?: string;
  /** Application credential id (`OS_APPLICATION_CREDENTIAL_ID`). */
  applicationCredentialId?: string;
  /** Application credential secret (`OS_APPLICATION_CREDENTIAL_SECRET`). */
  applicationCredentialSecret?: string;
  /** Region (`OS_REGION_NAME`). */
  region?: string;
  /** Endpoint interface (`OS_INTERFACE`). */
  interface?: string;
  /** Path to (or name of) the `openstack` binary. */
  openstackPath: string;
}

/** Captured outcome of one CLI invocation. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Process options a runner receives. */
export interface RunOptions {
  env: Record<string, string>;
  signal?: AbortSignal;
}

/** Spawns `argv` and captures the result; replaceable for tests. */
export type Runner = (argv: string[], opts: RunOptions) => Promise<RunResult>;

/** A non-zero CLI exit, carrying the (redacted) stderr for classification. */
export class CliError extends Error {
  constructor(
    message: string,
    /** Process exit code. */
    readonly code: number,
    /** Redacted stderr text. */
    readonly stderr: string,
  ) {
    super(message);
    this.name = "CliError";
  }
}

let testRunner: Runner | undefined;

/** Install a fake runner (tests only); call with no argument to restore. */
export function __setRunner(runner?: Runner): void {
  testRunner = runner;
}

/**
 * Mask every occurrence of `secret` in `text` with `[REDACTED]`. An empty or
 * undefined `secret` is a no-op.
 */
export function redactSecret(text: string, secret?: string): string {
  if (!secret) return text;
  return text.split(secret).join("[REDACTED]");
}

/**
 * Inherited variables that survive the `OS_*` strip: they say where
 * `clouds.yaml` and `secure.yaml` live, not how to authenticate.
 */
const KEEP_OS_VARS = new Set([
  "OS_CLIENT_CONFIG_FILE",
  "OS_CLIENT_SECURE_FILE",
]);

/**
 * Build the subprocess environment. Starts from `base` (the parent process
 * environment by default); when `opts` names a cloud or an application
 * credential, every inherited `OS_*` variable except the clouds.yaml
 * location hints is dropped first so nothing ambient leaks into the call.
 * Env vars override `clouds.yaml`, so a cloud plus a credential composes:
 * the cloud supplies auth URL and region, the credential replaces its auth
 * section.
 */
export function buildEnv(
  opts: CliOptions,
  base: Record<string, string> = Deno.env.toObject(),
): Record<string, string> {
  const explicit = Boolean(
    opts.cloud || opts.applicationCredentialId || opts.authUrl,
  );
  const env: Record<string, string> = {};
  for (const [k, v] of Object.entries(base)) {
    if (explicit && k.startsWith("OS_") && !KEEP_OS_VARS.has(k)) continue;
    env[k] = v;
  }
  if (opts.cloud) env.OS_CLOUD = opts.cloud;
  if (opts.cloudsFile) env.OS_CLIENT_CONFIG_FILE = opts.cloudsFile;
  if (opts.authUrl) env.OS_AUTH_URL = opts.authUrl;
  if (opts.applicationCredentialId) {
    env.OS_AUTH_TYPE = "v3applicationcredential";
    env.OS_IDENTITY_API_VERSION = "3";
    env.OS_APPLICATION_CREDENTIAL_ID = opts.applicationCredentialId;
    env.OS_APPLICATION_CREDENTIAL_SECRET = opts.applicationCredentialSecret ??
      "";
  }
  if (opts.region) env.OS_REGION_NAME = opts.region;
  if (opts.interface) env.OS_INTERFACE = opts.interface;
  return env;
}

/**
 * Throw unless the environment carries enough for the CLI to authenticate:
 * a named cloud, or an auth URL. Returns the human-readable source so callers
 * can log it.
 */
export function describeAuth(env: Record<string, string>): string {
  if (env.OS_CLOUD) {
    return env.OS_AUTH_TYPE
      ? `cloud "${env.OS_CLOUD}" with ${env.OS_AUTH_TYPE} override`
      : `cloud "${env.OS_CLOUD}"`;
  }
  if (env.OS_AUTH_URL) {
    return `${env.OS_AUTH_TYPE ?? "password"} auth against ${env.OS_AUTH_URL}`;
  }
  throw new Error(
    "no OpenStack authentication configured: set globalArguments.cloud " +
      "(a clouds.yaml entry) or authUrl + applicationCredentialId/Secret, " +
      "or export OS_CLOUD in the environment",
  );
}

const defaultRunner: Runner = async (argv, opts) => {
  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    env: opts.env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: opts.signal,
  });
  let output: Deno.CommandOutput;
  try {
    output = await command.output();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        `openstack binary not found (openstackPath="${argv[0]}"); ` +
          "install python-openstackclient or set globalArguments.openstackPath",
      );
    }
    throw err;
  }
  const decoder = new TextDecoder();
  return {
    code: output.code,
    stdout: decoder.decode(output.stdout),
    stderr: decoder.decode(output.stderr).trim(),
  };
};

/**
 * Run `openstack <args>` and return stdout. Throws {@link CliError} on a
 * non-zero exit with the secret-redacted stderr in the message.
 */
export async function openstack(
  opts: CliOptions,
  args: string[],
  signal?: AbortSignal,
): Promise<string> {
  const env = buildEnv(opts);
  describeAuth(env);
  const argv = [opts.openstackPath, ...args];
  const result = await (testRunner ?? defaultRunner)(argv, { env, signal });
  if (result.code !== 0) {
    const stderr = redactSecret(
      result.stderr || "no stderr output",
      opts.applicationCredentialSecret,
    );
    throw new CliError(
      `openstack ${describeArgs(args)} failed (exit ${result.code}): ${stderr}`,
      result.code,
      stderr,
    );
  }
  return result.stdout;
}

/**
 * `openstack --version` — needs no authentication, so it does not insist on
 * any; used by the live pre-flight check to prove the binary runs.
 */
export async function openstackVersion(opts: CliOptions): Promise<string> {
  const argv = [opts.openstackPath, "--version"];
  const result = await (testRunner ?? defaultRunner)(argv, {
    env: buildEnv(opts),
  });
  if (result.code !== 0) {
    throw new CliError(
      `openstack --version failed (exit ${result.code}): ${result.stderr}`,
      result.code,
      result.stderr,
    );
  }
  return result.stdout.trim();
}

/**
 * Run `openstack <args> -f json` and parse the result. The CLI prints a single
 * JSON document (an object for `show`/`create`, an array for `list`).
 */
export async function openstackJson<T = unknown>(
  opts: CliOptions,
  args: string[],
  signal?: AbortSignal,
): Promise<T> {
  const stdout = await openstack(opts, [...args, "-f", "json"], signal);
  const text = stdout.trim();
  if (text.length === 0) {
    throw new Error(`openstack ${describeArgs(args)} printed no JSON output`);
  }
  try {
    return JSON.parse(text) as T;
  } catch (err) {
    const detail = err instanceof Error ? err.message : String(err);
    throw new Error(
      `openstack ${describeArgs(args)} printed unparseable JSON: ${detail}`,
    );
  }
}

/** The command words of an argv (up to the first flag) for error messages. */
function describeArgs(args: string[]): string {
  const words: string[] = [];
  for (const a of args) {
    if (a.startsWith("-")) break;
    words.push(a);
  }
  return words.join(" ");
}

const NOT_FOUND = [
  /No \w[\w ]* with a name or ID of/i,
  /No \w+ found for/i,
  /could not be found/i,
  /not found/i,
  /\(HTTP 404\)/,
  /ResourceNotFound/,
];

/** True when a {@link CliError} says the target resource does not exist. */
export function isNotFound(err: unknown): boolean {
  return err instanceof CliError && NOT_FOUND.some((re) => re.test(err.stderr));
}

const CONFLICT = [/already exists/i, /\(HTTP 409\)/, /Conflict/];

/** True when a {@link CliError} says the resource (or rule) already exists. */
export function isConflict(err: unknown): boolean {
  return err instanceof CliError && CONFLICT.some((re) => re.test(err.stderr));
}

/**
 * Map `items` through `fn` with at most `limit` in flight. Used to fan out
 * `show` calls after a `list`, since each CLI invocation costs a fresh
 * Keystone round-trip.
 */
export async function mapLimit<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results: R[] = new Array(items.length);
  let next = 0;
  const workers = Array.from(
    { length: Math.max(1, Math.min(limit, items.length)) },
    async () => {
      while (next < items.length) {
        const i = next++;
        results[i] = await fn(items[i]);
      }
    },
  );
  await Promise.all(workers);
  return results;
}
