/**
 * `@dataverket/talosctl` — `talosctl` subprocess transport.
 *
 * Every method talks to Talos through the `talosctl` CLI: it already handles
 * the Talos API's mutual TLS, Omni's proxy (a talosconfig from
 * `omnictl talosconfig`), and node fan-out (`--nodes a,b,c`). The models only
 * shape its output. One injectable seam — {@link __setRunner} — lets tests
 * supply canned output without a binary or a cluster.
 *
 * Authentication is whatever the talosconfig says: a client certificate for
 * a plain cluster, or an Omni identity whose key comes from
 * `OMNI_SERVICE_ACCOUNT_KEY` in the environment. Extra environment
 * variables (such as that key) may be passed per call and are redacted from
 * error text.
 *
 * @module
 */

/** Where and how `talosctl` connects. */
export interface TalosctlOptions {
  /** Path to (or name of) the `talosctl` binary. */
  talosctlPath: string;
  /** Path to a talosconfig; omitted means talosctl's default lookup. */
  talosconfig?: string;
  /** `--endpoints`; omitted means the talosconfig's endpoints. */
  endpoints?: string[];
  /** `--nodes`: the machines the command targets. */
  nodes: string[];
  /** `--insecure`: maintenance-mode API without client certificates. */
  insecure?: boolean;
  /** Extra environment for the subprocess (inherits the rest). */
  env?: Record<string, string>;
  /** Values to mask in any error text. */
  secrets?: string[];
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

let testRunner: Runner | undefined;

/** Install a fake runner (tests only); call with no argument to restore. */
export function __setRunner(runner?: Runner): void {
  testRunner = runner;
}

/** Mask every occurrence of each secret in `text` with `[REDACTED]`. */
export function redactSecrets(text: string, secrets: string[] = []): string {
  let out = text;
  for (const s of secrets) if (s) out = out.split(s).join("[REDACTED]");
  return out;
}

/** True for gRPC-level failures worth a retry while a node is (re)booting. */
export function isTransientError(text: string): boolean {
  return [
    "connection refused",
    "connection reset",
    "connection error",
    "Unavailable",
    "deadline exceeded",
    "i/o timeout",
    "transport is closing",
  ].some((s) => text.includes(s));
}

const defaultRunner: Runner = async (argv, opts) => {
  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    env: opts.env,
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
        `talosctl binary not found (talosctlPath="${argv[0]}"); ` +
          "install talosctl or set globalArguments.talosctlPath",
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

/** The exact argument list for one invocation; pure so tests can pin it. */
export function talosctlArgs(
  opts: TalosctlOptions,
  args: string[],
): string[] {
  const full = [...args];
  if (opts.insecure) full.push("--insecure");
  if (opts.endpoints && opts.endpoints.length > 0) {
    full.push("--endpoints", opts.endpoints.join(","));
  }
  if (opts.nodes.length > 0) full.push("--nodes", opts.nodes.join(","));
  if (opts.talosconfig) full.push("--talosconfig", opts.talosconfig);
  return full;
}

/**
 * Run one `talosctl` command and return its stdout. A non-zero exit throws
 * with the redacted stderr; transient gRPC errors are retried `retries`
 * times, `retryDelayMs` apart, for commands that race a rebooting node.
 */
export async function talosctl(
  opts: TalosctlOptions,
  args: string[],
  extra: { retries?: number; retryDelayMs?: number; signal?: AbortSignal } = {},
): Promise<{ stdout: string; stderr: string }> {
  const retries = extra.retries ?? 0;
  const delay = extra.retryDelayMs ?? 15000;
  const argv = [opts.talosctlPath, ...talosctlArgs(opts, args)];
  const env = { ...Deno.env.toObject(), ...(opts.env ?? {}) };
  for (let attempt = 0; attempt <= retries; attempt++) {
    const r = await (testRunner ?? defaultRunner)(argv, {
      env,
      signal: extra.signal,
    });
    if (r.code === 0) return { stdout: r.stdout, stderr: r.stderr };
    const text = redactSecrets((r.stderr || r.stdout).trim(), opts.secrets);
    if (attempt < retries && isTransientError(text)) {
      await new Promise((res) => setTimeout(res, delay));
      continue;
    }
    throw new Error(`talosctl ${args[0]} failed (exit ${r.code}): ${text}`);
  }
  throw new Error(`talosctl ${args[0]} failed after ${retries + 1} attempts`);
}
