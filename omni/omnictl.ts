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
 * Parse `omnictl get -o json` (and `talosctl get -o json`) output: one
 * pretty-printed JSON object per resource, concatenated with no array
 * wrapper. A leading `[` is treated as a single array for forward
 * compatibility; empty input yields an empty array.
 */
export function parseOmnictlJson(stdout: string): CosiResource[] {
  const text = stdout.trim();
  if (text.length === 0) return [];
  if (text.startsWith("[")) {
    const parsed = JSON.parse(text);
    return Array.isArray(parsed) ? parsed : [parsed];
  }
  const objects: CosiResource[] = [];
  let depth = 0;
  let start = -1;
  let inString = false;
  let escaped = false;
  for (let i = 0; i < text.length; i++) {
    const ch = text[i];
    if (inString) {
      if (escaped) escaped = false;
      else if (ch === "\\") escaped = true;
      else if (ch === '"') inString = false;
      continue;
    }
    if (ch === '"') {
      inString = true;
    } else if (ch === "{") {
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

const defaultRunner: Runner = async (argv, env, signal) => {
  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    env: { ...Deno.env.toObject(), ...env },
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

/** Run one command; a non-zero exit throws with the redacted stderr. */
export async function run(
  argv: string[],
  opts: OmnictlOptions,
  signal?: AbortSignal,
): Promise<string> {
  const r = await (testRunner ?? defaultRunner)(argv, authEnv(opts), signal);
  if (r.code !== 0) {
    const text = redactSecret(
      (r.stderr || r.stdout).trim(),
      opts.serviceAccountKey,
    );
    throw new Error(
      `${argv[0]} ${argv[1]} failed (exit ${r.code}): ${
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
  );
}
