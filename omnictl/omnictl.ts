/**
 * `@dataverket/omnictl` — `omnictl` subprocess transport.
 *
 * The inventory model reads Omni's COSI resources through the `omnictl` CLI
 * (`omnictl get <type> -o json`) and mints cluster talosconfigs
 * (`omnictl talosconfig`). The process authenticates with the service
 * account key in the environment (`OMNI_ENDPOINT` + `OMNI_SERVICE_ACCOUNT_KEY`),
 * so nothing touches an on-disk omniconfig or opens a browser. One injectable
 * seam — {@link __setRunner} — lets tests supply canned output.
 *
 * @module
 */
import { redactSecret } from "./util.ts";

/**
 * A COSI resource as emitted by `omnictl get -o json`: every Omni resource is
 * a `{ metadata, spec }` pair. Fields are intentionally loose — callers narrow
 * what they read in `transform.ts`.
 */
export interface CosiResource {
  metadata: {
    id: string;
    namespace?: string;
    type?: string;
    labels?: Record<string, unknown>;
    [key: string]: unknown;
  };
  spec: Record<string, unknown>;
}

/** Connection options for an `omnictl` invocation. */
export interface OmnictlOptions {
  /** Omni API endpoint, e.g. `https://omni.example.net`. */
  endpoint: string;
  /** Omni service-account key (`OMNI_SERVICE_ACCOUNT_KEY`). */
  serviceAccountKey: string;
  /** Skip TLS verification for the Omni API. */
  insecureSkipTlsVerify: boolean;
  /** Path to (or name of) the `omnictl` binary. */
  omnictlPath: string;
}

/** Captured outcome of one CLI invocation. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Spawns `argv` with `env` and captures the result; replaceable for tests. */
export type Runner = (
  argv: string[],
  env: Record<string, string>,
  signal?: AbortSignal,
) => Promise<RunResult>;

let testRunner: Runner | undefined;

/** Install a fake runner (tests only); call with no argument to restore. */
export function __setRunner(runner?: Runner): void {
  testRunner = runner;
}

/**
 * Parse `omnictl get -o json` output: one pretty-printed JSON object per
 * resource, concatenated with no array wrapper. A leading `[` is treated as
 * a single array for forward compatibility; empty input yields an empty array.
 */
export function parseOmnictlJson(stdout: string): CosiResource[] {
  const text = stdout.trim();
  if (text.length === 0) return [];
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const objects: CosiResource[] = [];
  let depth = 0, start = -1, inString = false, escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') inString = true;
    else if (ch === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (ch === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        objects.push(JSON.parse(text.slice(start, i + 1)) as CosiResource);
        start = -1;
      } else if (depth < 0) {
        throw new Error("omnictl JSON output has an unbalanced closing brace");
      }
    }
  }
  if (depth !== 0) {
    throw new Error("omnictl JSON output ended with unbalanced braces");
  }
  return objects;
}

/** Inherited variables the subprocesses keep; everything else is dropped. */
const KEEP_ENV = ["PATH", "HOME", "TMPDIR", "USER"];

/** The subprocess environment: a short allow-list plus the Omni auth. */
export function buildEnv(
  extra: Record<string, string>,
  base: Record<string, string> = Deno.env.toObject(),
): Record<string, string> {
  const env: Record<string, string> = {};
  for (const k of KEEP_ENV) if (base[k] !== undefined) env[k] = base[k];
  return { ...env, ...extra };
}

const defaultRunner: Runner = async (argv, env, signal) => {
  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    env,
    clearEnv: true,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal,
  });
  let output: Deno.CommandOutput;
  try {
    output = await command.output();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        `${
          argv[0]
        } binary not found; install it or set the *Path global argument`,
      );
    }
    throw err;
  }
  return {
    code: output.code,
    stdout: new TextDecoder().decode(output.stdout),
    stderr: new TextDecoder().decode(output.stderr),
  };
};

/** The environment both CLIs authenticate with. */
export function authEnv(opts: OmnictlOptions): Record<string, string> {
  return {
    OMNI_ENDPOINT: opts.endpoint,
    OMNI_SERVICE_ACCOUNT_KEY: opts.serviceAccountKey,
  };
}

/**
 * Run one command; a non-zero exit throws with the redacted stderr, labelled
 * `<binary> <label>` (the subcommand, not whatever flag comes first).
 */
export async function run(
  argv: string[],
  opts: OmnictlOptions,
  signal?: AbortSignal,
  label = argv[1],
): Promise<string> {
  const r = await (testRunner ?? defaultRunner)(
    argv,
    buildEnv(authEnv(opts)),
    signal,
  );
  if (r.code !== 0) {
    const text = redactSecret(
      (r.stderr || r.stdout).trim(),
      opts.serviceAccountKey,
    );
    throw new Error(
      `${argv[0]} ${label} failed (exit ${r.code}): ${
        text || "no stderr output"
      }`,
    );
  }
  return r.stdout;
}

/** Fetch every resource of `resourceType` from Omni. */
export async function getResources(
  resourceType: string,
  opts: OmnictlOptions,
  signal?: AbortSignal,
): Promise<CosiResource[]> {
  const args = [opts.omnictlPath, "get", resourceType, "-o", "json"];
  if (opts.insecureSkipTlsVerify) args.push("--insecure-skip-tls-verify");
  return parseOmnictlJson(await run(args, opts, signal));
}

/**
 * Mint the cluster's admin talosconfig for the service account and return
 * its content (`omnictl talosconfig -c <cluster> --merge=false --force` into a
 * file in a private temporary directory, mode 0700, removed afterwards; the
 * directory, not the file, carries the protection since omnictl may recreate
 * the file). The file's endpoints are
 * Omni's proxy; talosctl still needs the key in the environment to
 * authenticate with it.
 */
export async function mintTalosconfig(
  cluster: string,
  opts: OmnictlOptions,
  signal?: AbortSignal,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "omni-talosconfig-" });
  const path = `${dir}/talosconfig`;
  try {
    const args = [
      opts.omnictlPath,
      "talosconfig",
      "-c",
      cluster,
      "--merge=false",
      "--force",
      path,
    ];
    if (opts.insecureSkipTlsVerify) args.push("--insecure-skip-tls-verify");
    await run(args, opts, signal);
    return await Deno.readTextFile(path);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** True when omnictl's failure text says the resource does not exist. */
function isNotFound(message: string): boolean {
  return /not found|doesn't exist|does not exist|NotFound/i.test(message);
}

/**
 * Fetch one resource by type and id, or `null` when Omni has none. Any other
 * failure throws as {@link run} does.
 */
export async function getResource(
  resourceType: string,
  id: string,
  opts: OmnictlOptions,
  signal?: AbortSignal,
): Promise<CosiResource | null> {
  const args = [opts.omnictlPath, "get", resourceType, id, "-o", "json"];
  if (opts.insecureSkipTlsVerify) args.push("--insecure-skip-tls-verify");
  try {
    const out = parseOmnictlJson(await run(args, opts, signal));
    return out[0] ?? null;
  } catch (err) {
    if (err instanceof Error && isNotFound(err.message)) return null;
    throw err;
  }
}

/**
 * `omnictl apply -f` one resource, written as JSON (valid YAML) into a file
 * in a private temporary directory that is removed afterwards. With `dryRun`
 * omnictl validates and prints what it would do but changes nothing; the
 * output is returned either way.
 */
export async function applyResource(
  resource: CosiResource,
  opts: OmnictlOptions,
  signal?: AbortSignal,
  dryRun = false,
): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "omnictl-apply-" });
  const path = `${dir}/resource.json`;
  try {
    await Deno.writeTextFile(path, JSON.stringify(resource, null, 2));
    const args = [opts.omnictlPath, "apply", "-f", path];
    if (dryRun) args.push("--dry-run");
    if (opts.insecureSkipTlsVerify) args.push("--insecure-skip-tls-verify");
    return await run(args, opts, signal);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** `omnictl delete <type> <id>`; waits for the deletion to complete. */
export async function deleteResource(
  resourceType: string,
  id: string,
  opts: OmnictlOptions,
  signal?: AbortSignal,
): Promise<void> {
  const args = [opts.omnictlPath, "delete", resourceType, id];
  if (opts.insecureSkipTlsVerify) args.push("--insecure-skip-tls-verify");
  await run(args, opts, signal);
}

/**
 * `omnictl cluster machine delete <id> --timeout <d>`: Omni drains the node,
 * wipes the machine and returns it to the unallocated pool; the command waits
 * for that to finish. Never passes `--force` or `--force-etcd-leave`.
 */
export async function clusterMachineDelete(
  id: string,
  timeout: string,
  opts: OmnictlOptions,
  signal?: AbortSignal,
): Promise<string> {
  const args = [
    opts.omnictlPath,
    "cluster",
    "machine",
    "delete",
    id,
    "--timeout",
    timeout,
  ];
  if (opts.insecureSkipTlsVerify) args.push("--insecure-skip-tls-verify");
  return await run(args, opts, signal, "cluster machine delete");
}
