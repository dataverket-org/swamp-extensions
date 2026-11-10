/**
 * The process layer: the only place that spawns a command. It runs one
 * binary with no shell, stops it at a time limit, makes what it wrote to
 * standard error safe to repeat, and names every way a call can fail.
 *
 * This module is shared: it lives once, in `lib/`, and every extension that
 * drives a command line tool imports it as `../lib/cli.ts`. A change here
 * changes each of them. Nothing here knows about one tool; what belongs to
 * one tool lives in that extension's own files.
 *
 * Safety properties, each pinned by a test in `cli_test.ts`:
 *
 * - no shell: arguments reach the process as they are, and `positionalArg`
 *   refuses a value that the tool would read as a flag;
 * - every process has a time limit; at the limit, or when the run is
 *   cancelled, it gets SIGTERM, then SIGKILL, and then its pipes are let go;
 * - what reaches an error is one bounded line with credentials blanked;
 * - standard output is the payload and is never copied into an error,
 *   unless the caller asks for it, and then redacted and bounded;
 * - environment additions are passed to the process and to nothing else.
 *
 * Permission: `--allow-run=<bin>` for each binary run. Nothing else.
 *
 * @module
 */

// ---------------------------------------------------------------------------
// Spawn
// ---------------------------------------------------------------------------

/** How a process is run. */
export interface SpawnOptions {
  /** The process is stopped when it still runs after this long. */
  timeoutMs: number;
  /** Stops the process when aborted. */
  signal?: AbortSignal;
  /** Written to the process's standard input, which is then closed. */
  stdin?: string;
  /** Variables added to the inherited environment, or all of it. */
  env?: Record<string, string>;
  /** Inherit nothing: `env` is the whole environment. */
  clearEnv?: boolean;
  /** Working directory. */
  cwd?: string;
}

/** One spawned command's outcome. */
export interface SpawnResult {
  /** The exit code; null when the process was ended by a signal. */
  code: number | null;
  /** Standard output as bytes: for some tools it is a blob. */
  stdout: Uint8Array;
  stderr: string;
  /** The process was stopped because it ran past its time limit. */
  timedOut?: boolean;
  /** The process was stopped because the run was cancelled. */
  cancelled?: boolean;
}

/** Spawns a command; replaceable so everything built on it is testable. */
export type Spawn = (
  bin: string,
  args: string[],
  opts: SpawnOptions,
) => Promise<SpawnResult>;

/** How long a process gets to end after SIGTERM before it is killed. */
export const KILL_GRACE_MS = 2000;

/** Read a stream to its end, or until told to stop waiting for it. */
function collect(stream: ReadableStream<Uint8Array>): {
  done: Promise<void>;
  cancel: () => void;
  bytes: () => Uint8Array;
} {
  const reader = stream.getReader();
  const chunks: Uint8Array[] = [];
  const done = (async () => {
    try {
      for (;;) {
        const chunk = await reader.read();
        if (chunk.done) break;
        chunks.push(chunk.value);
      }
    } catch {
      // The stream was closed under the reader; what was read is kept.
    }
  })();
  return {
    done,
    cancel: () => {
      reader.cancel().catch(() => {});
    },
    bytes: () => {
      const all = new Uint8Array(chunks.reduce((n, c) => n + c.length, 0));
      let at = 0;
      for (const c of chunks) {
        all.set(c, at);
        at += c.length;
      }
      return all;
    },
  };
}

/**
 * The real spawn. The process runs with no shell. At the time limit, or when
 * the signal aborts, it gets SIGTERM, then SIGKILL after `graceMs`, and after
 * one more `graceMs` its output is no longer waited for, so neither a process
 * that ignores SIGTERM nor a child of it that keeps the pipes open can hold
 * the caller. A binary that is not found throws `Deno.errors.NotFound`.
 */
export async function spawnProcess(
  bin: string,
  args: string[],
  opts: SpawnOptions & { graceMs?: number },
): Promise<SpawnResult> {
  if (opts.signal?.aborted) {
    return {
      code: null,
      stdout: new Uint8Array(),
      stderr: "",
      cancelled: true,
    };
  }
  const grace = opts.graceMs ?? KILL_GRACE_MS;
  // The CLI is the interface being driven; see README "Prerequisites".
  // swamp-quality-ignore deno-command
  const child = new Deno.Command(bin, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    clearEnv: opts.clearEnv,
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  }).spawn();
  const out = collect(child.stdout);
  const err = collect(child.stderr);
  const timers: ReturnType<typeof setTimeout>[] = [];
  let timedOut = false;
  let cancelled = false;
  let stopping = false;
  const kill = (sig: Deno.Signal) => {
    try {
      child.kill(sig);
    } catch {
      // The process has already ended.
    }
  };
  const stop = () => {
    if (stopping) return;
    stopping = true;
    kill("SIGTERM");
    timers.push(setTimeout(() => {
      kill("SIGKILL");
      timers.push(setTimeout(() => {
        out.cancel();
        err.cancel();
      }, grace));
    }, grace));
  };
  const onCancel = () => {
    if (!stopping) cancelled = true;
    stop();
  };
  timers.push(setTimeout(() => {
    if (!stopping) timedOut = true;
    stop();
  }, opts.timeoutMs));
  opts.signal?.addEventListener("abort", onCancel, { once: true });
  try {
    if (opts.stdin !== undefined) {
      const writer = child.stdin.getWriter();
      try {
        await writer.write(new TextEncoder().encode(opts.stdin));
        await writer.close();
      } catch {
        // The process ended before it read its input; its exit says why.
        await writer.abort().catch(() => {});
      }
    }
    const [status] = await Promise.all([child.status, out.done, err.done]);
    return {
      code: status.signal === null ? status.code : null,
      stdout: out.bytes(),
      stderr: new TextDecoder().decode(err.bytes()),
      timedOut,
      cancelled,
    };
  } finally {
    for (const t of timers) clearTimeout(t);
    opts.signal?.removeEventListener("abort", onCancel);
  }
}

let testSpawn: Spawn | undefined;

/** Install a fake spawn (tests only); call with no argument to restore. */
export function __setSpawn(s?: Spawn): void {
  testSpawn = s;
}

// ---------------------------------------------------------------------------
// Waiting
// ---------------------------------------------------------------------------

/** Waits; replaceable so a poll is testable without real time. */
export type Sleep = (ms: number, signal?: AbortSignal) => Promise<void>;

/**
 * The error of a wait that ended because the run was cancelled: a
 * `CliError` of kind `cancelled` with the message `cancelled`, so a run
 * cancelled between two polls is told apart from a failure the same way as
 * one cancelled while a command ran.
 */
export function cancelledError(): CliError {
  return new CliError("cancelled", "cancelled", { bin: "" });
}

const defaultSleep: Sleep = (ms, signal) =>
  new Promise((resolve, reject) => {
    if (signal?.aborted) return reject(cancelledError());
    const onAbort = () => {
      clearTimeout(timer);
      reject(cancelledError());
    };
    const timer = setTimeout(() => {
      signal?.removeEventListener("abort", onAbort);
      resolve();
    }, ms);
    signal?.addEventListener("abort", onAbort, { once: true });
  });

let testSleep: Sleep | undefined;

/** Install a fake sleep (tests only); call with no argument to restore. */
export function __setSleep(s?: Sleep): void {
  testSleep = s;
}

/**
 * Wait `ms` milliseconds; rejects with `cancelledError()` when the signal
 * aborts.
 */
export function sleep(ms: number, signal?: AbortSignal): Promise<void> {
  return (testSleep ?? defaultSleep)(ms, signal);
}

let testClock: (() => number) | undefined;

/** Install a fake clock in milliseconds (tests only); no argument restores. */
export function __setClock(c?: () => number): void {
  testClock = c;
}

function clock(): number {
  return (testClock ?? Date.now)();
}

/** The time budget of one poll loop. */
export interface PollBudget {
  /** Milliseconds used: the waits, and the time spent between them. */
  usedMs: () => number;
  /** Milliseconds left; never below zero. */
  leftMs: () => number;
  /**
   * Wait `stepMs`, or what is left when that is less. Resolves false, without
   * waiting, when nothing is left.
   */
  wait: (stepMs: number, signal?: AbortSignal) => Promise<boolean>;
}

/**
 * A poll loop's budget of `totalMs`. The time the reads between two waits
 * take counts as used, so slow answers cannot stretch a poll far past what
 * was asked for.
 *
 * ```ts
 * const budget = pollBudget(waitSeconds * 1000);
 * while (!done && await budget.wait(5000, signal)) done = await read();
 * ```
 */
export function pollBudget(totalMs: number): PollBudget {
  let used = 0;
  let mark = clock();
  const settle = () => {
    const now = clock();
    used += Math.max(0, now - mark);
    mark = now;
  };
  const usedMs = () => {
    settle();
    return used;
  };
  const leftMs = () => Math.max(0, totalMs - usedMs());
  return {
    usedMs,
    leftMs,
    wait: async (stepMs, signal) => {
      const step = Math.min(stepMs, leftMs());
      if (step <= 0) return false;
      const before = clock();
      await sleep(step, signal);
      // A fake sleep moves no clock, so a wait counts as at least its step.
      used += Math.max(step, clock() - before);
      mark = clock();
      return true;
    },
  };
}

// ---------------------------------------------------------------------------
// Text that is safe to repeat
// ---------------------------------------------------------------------------

const SECRET_KEYS =
  "token|password|passwd|passphrase|secret|client-key-data|client-certificate-data|certificate-authority-data|api[-_]?key|private[-_]?key";

const PAIR = new RegExp(
  `((?:${SECRET_KEYS})["']?[ \\t]*[:=][ \\t]*["']?)(?!\\[redacted\\])[^\\s"',}]+`,
  "gi",
);
const FLAG = new RegExp(
  `(--[a-z0-9-]*(?:${SECRET_KEYS})[a-z0-9-]*[ \\t]+["']?)(?![-\\[])[^\\s"']+`,
  "gi",
);

/**
 * Blank what is shaped like a credential in text that came from outside:
 * each of `secrets` word for word, a PEM block, the user and password part
 * of a URL, an Authorization header, a bearer or basic token, a JWT, and the value after a key or a
 * flag such as `token=`, `password:` or `--password`. Line breaks are kept.
 * This is a second line of defence; the first is not to read secrets.
 */
export function redact(text: string, secrets: string[] = []): string {
  let out = text;
  const literal = [...new Set(secrets.flatMap((s) => [s, s.trim()]))]
    .filter((s) => s !== "").sort((a, b) => b.length - a.length);
  for (const s of literal) out = out.split(s).join("[redacted]");
  return out
    .replace(
      /-----BEGIN [A-Z0-9 ]+-----[\s\S]*?(-----END [A-Z0-9 ]+-----|$)/g,
      "[redacted]",
    )
    .replace(/([a-z][a-z0-9+.-]*:\/\/)[^/\s@"']+@/gi, "$1")
    .replace(/(authorization["']?[ \t]*[:=][ \t]*)[^\n"']+/gi, "$1[redacted]")
    .replace(/\b(bearer\s+)(?!\[)[^\s"']+/gi, "$1[redacted]")
    .replace(/\b(Basic\s+)[A-Za-z0-9+/=]{8,}/g, "$1[redacted]")
    .replace(
      /\beyJ[A-Za-z0-9_-]{5,}\.[A-Za-z0-9_-]+\.[A-Za-z0-9_-]*/g,
      "[redacted]",
    )
    .replace(PAIR, "$1[redacted]")
    .replace(FLAG, "$1[redacted]");
}

/** One redacted line of at most `max` characters, for a message or a log. */
export function brief(text: string, max = 400, secrets?: string[]): string {
  const line = redact(text, secrets).replace(/\s+/g, " ").trim();
  return line.length > max ? `${line.slice(0, max)}...` : line;
}

/**
 * `text` without the lines `noise` picks out. When every line is noise, the
 * last one is all there is, and it is kept. Empty lines are dropped.
 */
export function withoutNoise(
  text: string,
  noise?: (line: string) => boolean,
): string {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  if (!noise) return lines.join("\n");
  const own = lines.filter((l) => !noise(l));
  return (own.length > 0 ? own : lines.slice(-1)).join("\n");
}

/** The most standard error text that is kept from one command. */
export const STDERR_LIMIT = 4000;

/**
 * What a command wrote to standard error, safe to keep: noise lines dropped,
 * credentials blanked, bounded in length. Line breaks are kept; use `brief`
 * for one line.
 */
export function safeStderr(
  stderr: string,
  opts: { secrets?: string[]; noise?: (line: string) => boolean } = {},
): string {
  const text = redact(withoutNoise(stderr, opts.noise), opts.secrets).trim();
  return text.length > STDERR_LIMIT
    ? `${text.slice(0, STDERR_LIMIT)}...`
    : text;
}

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/** A value quoted for an error message, cut so a long one cannot flood it. */
export function shown(value: unknown): string {
  const text = typeof value === "string" ? value : String(value);
  return JSON.stringify(text.length > 80 ? `${text.slice(0, 80)}...` : text);
}

const CONTROL = /[\0\r\n]/;

/**
 * A value that goes where the tool expects a positional argument, or a named
 * refusal: it must be a string that is not empty, does not start with `-`
 * (the tool would read it as a flag) and holds no NUL or line break.
 */
export function positionalArg(value: unknown, what: string): string {
  if (
    typeof value !== "string" || value === "" || value.startsWith("-") ||
    CONTROL.test(value)
  ) {
    throw new Error(
      `${what} ${
        shown(value)
      } is refused: it must not be empty, start with '-' or hold a line break`,
    );
  }
  return value;
}

/**
 * A value that follows a flag, or a named refusal: a string with no NUL or
 * line break. It may start with `-`; the tool reads it as the flag's value.
 */
export function valueArg(value: unknown, what: string): string {
  if (typeof value !== "string" || CONTROL.test(value)) {
    throw new Error(
      `${what} ${shown(value)} is refused: it must not hold a line break`,
    );
  }
  return value;
}

/** The arguments as they are named in a message: redacted and bounded. */
export function describeArgs(args: string[], secrets?: string[]): string {
  return brief(args.join(" "), 200, secrets);
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** Why a command failed, as a word a caller can branch on. */
export type CliFailure =
  /** The binary was not found. */
  | "not-installed"
  /** The process ran past its time limit and was stopped. */
  | "timeout"
  /** The run was cancelled while the process ran. */
  | "cancelled"
  /** The process exited non-zero. */
  | "failed"
  /** The process exited zero and printed something that is not JSON. */
  | "not-json";

/** A failed command: `kind` says which failure, the message says more. */
export class CliError extends Error {
  /** Which kind of failure this is. */
  readonly kind: CliFailure;
  /** The binary that was run. */
  readonly bin: string;
  /** The exit code; null when there was none. */
  readonly code: number | null;
  /** Standard error after `safeStderr`; empty when there was none. */
  readonly stderr: string;
  constructor(
    kind: CliFailure,
    message: string,
    detail: { bin: string; code?: number | null; stderr?: string },
  ) {
    super(message);
    this.name = "CliError";
    this.kind = kind;
    this.bin = detail.bin;
    this.code = detail.code ?? null;
    this.stderr = detail.stderr ?? "";
  }
}

/** True when `err` is a CliError of one of the given kinds, or of any. */
export function isCliError(
  err: unknown,
  ...kinds: CliFailure[]
): err is CliError {
  return err instanceof CliError &&
    (kinds.length === 0 || kinds.includes(err.kind));
}

/** How long a process may live when the caller sets no limit. */
export const DEFAULT_TIMEOUT_MS = 60_000;

/**
 * The longest time limit a call may be given, a little under 25 days: the
 * runtime's timers count milliseconds in 31 bits, and a longer one would fire
 * at once and stop the process as it starts.
 */
export const MAX_TIMEOUT_MS = 2_147_483_647;

/** What one command may be given besides its arguments. */
export interface CliOpts {
  /**
   * The process is stopped when it still runs after this long. Defaults to
   * one minute; a build or a volume operation needs more and says so here.
   */
  timeoutMs?: number;
  /** Stops the process when the method run is cancelled. */
  signal?: AbortSignal;
  /** Given to the process on standard input. Never logged, never in an error. */
  stdin?: string;
  /**
   * Variables added to the inherited environment. They reach the process and
   * nothing else: no log line and no error holds them. Name the secret ones
   * in `secrets` too, in case the tool prints them back.
   */
  env?: Record<string, string>;
  /** Inherit nothing: `env` is the whole environment. */
  clearEnv?: boolean;
  /** Working directory. */
  cwd?: string;
  /** Values blanked word for word wherever text is kept or shown. */
  secrets?: string[];
  /** Picks the lines of standard error that are dropped as noise. */
  noise?: (line: string) => boolean;
  /**
   * How the command is named in an error. Defaults to the binary and its
   * arguments, redacted and bounded; pass `"<bin> <subcommand>"` when the
   * arguments say too much.
   */
  what?: string;
  /**
   * What to do about a missing binary, said after "was not found"; for a
   * type whose binary can be overridden, name the argument that does it.
   */
  installHint?: string;
  /**
   * Fall back to standard output, redacted and bounded, in the error of a
   * failed call that wrote nothing to standard error. Off by default: for a
   * tool that prints secrets, standard output must never reach an error.
   */
  stdoutInError?: boolean;
}

/** One command's outcome, with its standard error made safe. */
export interface CliResult {
  /** Exit code zero, in time, not cancelled. */
  success: boolean;
  code: number | null;
  /** Standard output as text. It is the payload: keep it out of errors. */
  stdout: string;
  /** Standard output as bytes. */
  stdoutBytes: Uint8Array;
  /** Standard error after `safeStderr`. */
  stderr: string;
  timedOut: boolean;
  cancelled: boolean;
}

function seconds(ms: number): string {
  return String(Math.round(ms / 100) / 10);
}

/**
 * Run `bin` with `args` and report how it ended, without throwing for a
 * non-zero exit, a time limit or a cancelled run: use it when the caller
 * decides what a failure means. A binary that is not found throws a
 * `CliError` of kind `not-installed`.
 */
export async function tryCli(
  bin: string,
  args: string[],
  opts: CliOpts = {},
): Promise<CliResult> {
  const timeoutMs = opts.timeoutMs ?? DEFAULT_TIMEOUT_MS;
  if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {
    throw new Error(`${bin} needs a time limit above zero`);
  }
  if (timeoutMs > MAX_TIMEOUT_MS) {
    throw new Error(
      `${bin} was given a time limit longer than a timer can count ` +
        `(${MAX_TIMEOUT_MS} ms); a limit that long would stop it at once`,
    );
  }
  if (typeof bin !== "string" || bin === "" || bin.includes("\0")) {
    throw new Error(`${shown(bin)} is not a binary to run`);
  }
  for (const a of args) {
    if (typeof a !== "string" || a.includes("\0")) {
      throw new Error(`${bin} was given an argument that is not text`);
    }
  }
  let result: SpawnResult;
  try {
    result = await (testSpawn ?? spawnProcess)(bin, args, {
      timeoutMs,
      signal: opts.signal,
      stdin: opts.stdin,
      env: opts.env,
      clearEnv: opts.clearEnv,
      cwd: opts.cwd,
    });
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new CliError(
        "not-installed",
        opts.installHint
          ? `${bin} was not found; ${opts.installHint}`
          : bin.includes("/")
          ? `${bin} was not found; install it there or correct the path`
          : `${bin} is not on PATH; install it or put it on the PATH this repository runs with`,
        { bin },
      );
    }
    throw err;
  }
  const timedOut = result.timedOut === true;
  const cancelled = result.cancelled === true;
  return {
    success: result.code === 0 && !timedOut && !cancelled,
    code: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stdoutBytes: result.stdout,
    stderr: safeStderr(result.stderr, opts),
    timedOut,
    cancelled,
  };
}

/**
 * The error for a command that did not succeed. Exported so a caller of
 * `tryCli` can throw the same error `runCli` would.
 */
export function cliError(
  bin: string,
  args: string[],
  result: CliResult,
  opts: CliOpts = {},
): CliError {
  const what = opts.what ?? `${bin} ${describeArgs(args, opts.secrets)}`;
  const detail = { bin, code: result.code, stderr: result.stderr };
  if (result.cancelled) {
    return new CliError("cancelled", `${what} was cancelled`, detail);
  }
  if (result.timedOut) {
    return new CliError(
      "timeout",
      `${what} failed: no answer within ${
        seconds(opts.timeoutMs ?? DEFAULT_TIMEOUT_MS)
      } seconds; the process was stopped`,
      detail,
    );
  }
  const said = brief(result.stderr) ||
    (opts.stdoutInError ? brief(result.stdout, 400, opts.secrets) : "") ||
    "(no error output)";
  return new CliError(
    "failed",
    `${what} failed (exit ${result.code ?? "by signal"}): ${said}`,
    detail,
  );
}

/**
 * Run `bin` with `args` and no shell, stopped at `timeoutMs` or when the
 * signal aborts, and return how it ended. Anything but success throws a
 * `CliError` with a `kind`, an exit code and a bounded, redacted message.
 */
export async function runCli(
  bin: string,
  args: string[],
  opts: CliOpts = {},
): Promise<CliResult> {
  const result = await tryCli(bin, args, opts);
  if (!result.success) throw cliError(bin, args, result, opts);
  return result;
}

/**
 * Parse what a command printed. Output that is not JSON is a `not-json`
 * error that names the command and the size of the output, never its text:
 * what is read here can hold tokens and keys.
 */
export function parseJson(text: string, what: string, bin = ""): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new CliError(
      "not-json",
      `${what} did not print JSON (${
        text.trim() === "" ? "no output" : `${text.length} characters of output`
      })`,
      { bin, code: 0 },
    );
  }
}

// ---------------------------------------------------------------------------
// Pre-flight check
// ---------------------------------------------------------------------------

/** How long a version check may take. */
export const CHECK_TIMEOUT_MS = 20_000;

/**
 * Run `bin` with a version argument and say why it could not be run, or
 * undefined when it ran.
 */
export async function cliProblem(
  bin: string,
  args: string[],
  opts: CliOpts = {},
): Promise<string | undefined> {
  try {
    await runCli(bin, args, {
      timeoutMs: CHECK_TIMEOUT_MS,
      stdoutInError: true,
      ...opts,
    });
    return undefined;
  } catch (err) {
    if (err instanceof CliError) return err.message;
    return `${bin} could not be run: ${
      brief(err instanceof Error ? err.message : String(err))
    }`;
  }
}

/** The outcome shape a pre-flight check returns. */
export interface CheckResult {
  pass: boolean;
  errors?: string[];
}

/** A pre-flight check as a type registers it. */
export interface CliCheck {
  description: string;
  labels: string[];
  execute: (
    context?: { globalArgs?: unknown; signal?: AbortSignal },
  ) => Promise<CheckResult>;
}

/**
 * A pre-flight check that a binary runs: `<bin> <args>`, for example
 * `crane version`. `bin` may be read from the global arguments, for a type
 * whose binary can be overridden.
 */
export function cliCheck(spec: {
  bin: string | ((globalArgs: Record<string, unknown>) => string);
  args: string[];
  description: string;
  installHint?: string;
}): CliCheck {
  return {
    description: spec.description,
    labels: ["live"],
    execute: async (context) => {
      const bin = typeof spec.bin === "string"
        ? spec.bin
        : spec.bin((context?.globalArgs ?? {}) as Record<string, unknown>);
      const problem = await cliProblem(bin, spec.args, {
        signal: context?.signal,
        installHint: spec.installHint,
      });
      return problem ? { pass: false, errors: [problem] } : { pass: true };
    },
  };
}
