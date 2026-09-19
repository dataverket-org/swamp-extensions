/**
 * `@dataverket/omni` — `omnictl` and `talosctl` subprocess transport.
 *
 * The inventory model reads Omni's COSI resources through the `omnictl` CLI
 * (`omnictl get <type> -o json`); the `volumes` method also mints a cluster
 * talosconfig (`omnictl talosconfig`) and reads every machine through Omni's
 * Talos proxy with `talosctl`. Both processes authenticate with the service
 * account key in the environment (`OMNI_ENDPOINT` + `OMNI_SERVICE_ACCOUNT_KEY`),
 * so nothing touches an on-disk omniconfig or opens a browser. One injectable
 * seam — {@link __setRunner} — lets tests supply canned output.
 *
 * @module
 */
import { redactSecret } from "./util.ts";
import { parseConcatJson } from "./talos_layout.ts";

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
  /** Path to (or name of) the `talosctl` binary. */
  talosctlPath: string;
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
 * resource, concatenated with no array wrapper. Same format as
 * `talosctl get -o json`, so one parser serves both.
 */
export function parseOmnictlJson(stdout: string): CosiResource[] {
  return parseConcatJson(stdout) as unknown as CosiResource[];
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
 * Write the cluster's admin talosconfig for the service account to `path`
 * (`omnictl talosconfig -c <cluster> --merge=false --force <path>`). The
 * file's endpoints are Omni's proxy; talosctl still needs the key in the
 * environment to authenticate with it.
 */
export async function writeTalosconfig(
  cluster: string,
  path: string,
  opts: OmnictlOptions,
  signal?: AbortSignal,
): Promise<void> {
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
}

/** Run `talosctl` against `nodes` through the given talosconfig. */
export function talosctl(
  talosconfig: string,
  nodes: string[],
  args: string[],
  opts: OmnictlOptions,
  signal?: AbortSignal,
): Promise<string> {
  return run(
    [
      opts.talosctlPath,
      "--talosconfig",
      talosconfig,
      "--nodes",
      nodes.join(","),
      ...args,
    ],
    opts,
    signal,
    args[0],
  );
}
