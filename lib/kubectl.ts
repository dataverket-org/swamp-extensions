/**
 * The kubectl layer, built on the process layer in `cli.ts`: the global
 * arguments for cluster access, the kubectl runner with its named failures,
 * the name checks, the argument builders, the readers that take an object
 * apart without trusting its shape, the data names and the inventory record.
 *
 * This module is shared: it lives once, in `lib/`, and every extension that
 * drives kubectl imports it as `../lib/kubectl.ts`. A change here changes
 * each of them. Nothing here knows about one API group; what belongs to one
 * domain lives in that extension's own helpers.
 *
 * Safety properties on top of those of `cli.ts`, each pinned by a test in
 * `kubectl_test.ts`:
 *
 * - a name or namespace that is not a Kubernetes name never becomes an
 *   argument (`checkName`, `checkNamespace`, also inside the builders);
 * - every call carries `--request-timeout`, and the process is stopped a
 *   little later when it still runs;
 * - a non-zero exit is a failure whatever was printed on standard output;
 * - client-go log lines are dropped, so kubectl's own sentence is what an
 *   error holds and what the failure is sorted by;
 * - a patch body is not named in an error.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  brief,
  type CheckResult,
  type CliCheck,
  cliCheck,
  CliError,
  type CliResult,
  KILL_GRACE_MS,
  redact,
  shown,
  tryCli,
} from "./cli.ts";

// ---------------------------------------------------------------------------
// Global arguments
// ---------------------------------------------------------------------------

/**
 * The global arguments every kubectl-driven type takes. The names are the
 * ones `@swamp/kubernetes` uses, so one definition style works across both.
 */
export const KubectlGlobalArgsSchema = z.object({
  namespace: z.string().default("").describe(
    "Kubernetes namespace. Empty means every namespace for a list; a method on one object then needs its namespace argument",
  ),
  kubeconfig: z.string().optional().describe(
    "Path to a kubeconfig file. Defaults to KUBECONFIG or ~/.kube/config",
  ),
  context: z.string().optional().describe(
    "Kubeconfig context. Defaults to the current context",
  ),
});

/** The global arguments as a method receives them. */
export type KubectlGlobalArgs = z.infer<typeof KubectlGlobalArgsSchema>;

/** Which cluster a command talks to. */
export interface ClusterOpts {
  kubeconfig?: string;
  context?: string;
}

/** What one kubectl call may be given besides its arguments. */
export interface KubectlOpts extends ClusterOpts {
  /** Stops the running kubectl when the method run is cancelled. */
  signal?: AbortSignal;
  /** Given to kubectl on standard input, for `create -f -` and the like. */
  stdin?: string;
  /** The kubectl binary, for a type that lets it be overridden. */
  bin?: string;
  /** Working directory, for a command that names a file by a relative path. */
  cwd?: string;
  /**
   * Values blanked word for word in every error of the call: in kubectl's
   * error text and in the arguments the message names. For an opaque value
   * that no pattern would recognise as a credential.
   */
  secrets?: string[];
  /**
   * How long the API server may take to answer this one call, in seconds:
   * a whole number from 1 to 600. It sets `--request-timeout`, and the
   * process is stopped 5 seconds later. Leave it out for a read; set it for
   * a write that can take long and must not be cut off part-way. A value
   * out of range is an error before anything is spawned.
   */
  requestTimeoutSeconds?: number;
}

/** The runner options of a method's context: its cluster and its signal. */
export function kubectlOpts(
  context: { globalArgs: ClusterOpts; signal?: AbortSignal },
): KubectlOpts {
  return {
    kubeconfig: context.globalArgs.kubeconfig,
    context: context.globalArgs.context,
    signal: context.signal,
  };
}

/**
 * The cluster flags, when set, then the command. `kubectl` and other tools
 * built on client-go take the same two flags. Pure, so a test can pin it.
 */
export function cliArgs(args: string[], opts?: ClusterOpts): string[] {
  const full: string[] = [];
  if (opts?.kubeconfig) full.push("--kubeconfig", opts.kubeconfig);
  if (opts?.context) full.push("--context", opts.context);
  full.push(...args);
  return full;
}

// ---------------------------------------------------------------------------
// The runner
// ---------------------------------------------------------------------------

/** The binary, run by name from PATH. */
export const KUBECTL = "kubectl";

/** How long the API server may take to answer one request, in seconds. */
export const REQUEST_TIMEOUT_SECONDS = 30;

/** The flag every kubectl call carries. */
export const REQUEST_TIMEOUT_FLAG =
  `--request-timeout=${REQUEST_TIMEOUT_SECONDS}s`;

/**
 * How long one kubectl process may live. A little more than the request
 * timeout, so kubectl's own sentence is seen when the server is slow, and a
 * kubectl that hangs before or after the request still ends.
 */
export const KUBECTL_KILL_AFTER_MS = (REQUEST_TIMEOUT_SECONDS + 5) * 1000;

/** The longest request timeout one call may ask for, in seconds. */
export const MAX_REQUEST_TIMEOUT_SECONDS = 600;

/** What one call may set about its own time limit. */
export interface KubectlLimit {
  requestTimeoutSeconds?: number;
}

/**
 * The request timeout of one call in seconds: its own when it sets one, the
 * default otherwise. Throws for anything but a whole number from 1 to 600.
 */
export function requestTimeoutOf(opts?: KubectlLimit): number {
  const seconds = opts?.requestTimeoutSeconds;
  if (seconds === undefined) return REQUEST_TIMEOUT_SECONDS;
  if (
    !Number.isInteger(seconds) || seconds < 1 ||
    seconds > MAX_REQUEST_TIMEOUT_SECONDS
  ) {
    throw new Error(
      `requestTimeoutSeconds ${
        shown(seconds)
      } is refused: a whole number of seconds from 1 to ${MAX_REQUEST_TIMEOUT_SECONDS}`,
    );
  }
  return seconds;
}

/** When the process of one call is stopped: its request timeout plus 5 s. */
export function kubectlKillAfterMs(opts?: KubectlLimit): number {
  return (requestTimeoutOf(opts) + 5) * 1000;
}

/**
 * The longest one kubectl call can take before `runKubectl` returns or
 * throws: the request timeout, the 5 s margin, and the two grace periods
 * it takes to stop a process that does not end by itself (SIGTERM, then
 * SIGKILL, then its pipes are let go). 39 s for a call with the default
 * limit. Use it to keep one call's worth of a method's time back.
 */
export function kubectlCallLimitMs(opts?: KubectlLimit): number {
  return kubectlKillAfterMs(opts) + 2 * KILL_GRACE_MS;
}

/** `kubectlCallLimitMs()` of a call with the default limit: 39 s. */
export const KUBECTL_CALL_LIMIT_MS: number = KUBECTL_KILL_AFTER_MS +
  2 * KILL_GRACE_MS;

/**
 * True when `err` says the run was cancelled, wherever it was noticed:
 * while kubectl ran (`KubectlError`), while another command ran or during
 * a wait between two polls (`CliError`).
 */
export function isCancelled(err: unknown): boolean {
  return (err instanceof KubectlError || err instanceof CliError) &&
    err.kind === "cancelled";
}

/**
 * True for a client-go log line (`E1110 10:48:48.424103 ...`). kubectl
 * prints them before its own message: on a refused login or a closed port
 * they repeat five times and push the one sentence that says what is wrong
 * out of a shortened message. The noise filter of every kubectl call.
 */
export function isClientGoLogLine(line: string): boolean {
  return /^[EWIF]\d{4} \d\d:\d\d:\d\d/.test(line);
}

/** Pre-flight check that `kubectl version --client` runs. */
export const kubectlCliCheck: {
  description: string;
  labels: string[];
  execute: (context?: { signal?: AbortSignal }) => Promise<CheckResult>;
} = cliCheck({
  bin: KUBECTL,
  args: ["version", "--client"],
  description:
    "The kubectl binary runs and reports its client version; every method talks to the cluster with it",
});

/**
 * The same check for a type whose kubectl binary can be overridden: `bin` is
 * the binary, or reads it from the global arguments, as `cliCheck` does.
 *
 * ```ts
 * checks: { "kubectl-cli-available": kubectlCheck((g) => String(g.kubectlBinary ?? "kubectl")) }
 * ```
 */
export function kubectlCheck(
  bin: string | ((globalArgs: Record<string, unknown>) => string) = KUBECTL,
): CliCheck {
  return cliCheck({
    bin,
    args: ["version", "--client"],
    description: kubectlCliCheck.description,
  });
}

/** Why a kubectl call failed, as a word a caller can branch on. */
export type KubectlFailure =
  /** The object does not exist. */
  | "not-found"
  /** The API server refused the request for this identity. */
  | "forbidden"
  /** The cluster did not accept the credentials: expired, wrong or absent. */
  | "unauthorized"
  /** The API group or kind is not served: its CRDs are not installed. */
  | "missing-crd"
  /** The object changed since it was read, or it already exists. */
  | "conflict"
  /** No answer in time; kubectl gave up or was stopped. */
  | "timeout"
  /** The API server could not be reached at all. */
  | "unreachable"
  /** kubectl exited zero and printed something that is not JSON. */
  | "not-json"
  /** The method run was cancelled while kubectl ran. */
  | "cancelled"
  /** The kubectl binary was not found. */
  | "not-installed"
  /** Anything else, including an answer of the wrong shape. */
  | "other";

/** A failed kubectl call: `kind` says which failure, the message says more. */
export class KubectlError extends Error {
  /** Which kind of failure this is. */
  readonly kind: KubectlFailure;
  /** kubectl's standard error, made safe; empty when there was none. */
  readonly stderr: string;
  constructor(kind: KubectlFailure, message: string, stderr = "") {
    super(message);
    this.name = "KubectlError";
    this.kind = kind;
    this.stderr = stderr;
  }
}

/** True when `err` is a KubectlError of one of the given kinds, or of any. */
export function isKubectlError(
  err: unknown,
  ...kinds: KubectlFailure[]
): err is KubectlError {
  return err instanceof KubectlError &&
    (kinds.length === 0 || kinds.includes(err.kind));
}

/**
 * Sort a failed call by kubectl's own sentence. Give it standard error with
 * the log lines already dropped. The order matters: the server's verdict in
 * `Error from server (...)` comes before the transport guesses.
 */
export function classifyStderr(stderr: string): KubectlFailure {
  const has = (re: RegExp) => re.test(stderr);
  if (
    has(/the server doesn't have a resource type/) ||
    has(/no matches for kind/) ||
    // A NotFound that names no object: the path itself is not served.
    has(/\(NotFound\): the server could not find the requested resource/)
  ) return "missing-crd";
  if (has(/\(NotFound\)/)) return "not-found";
  // The server's own refusal starts a line; the word quoted inside another
  // message is not one.
  if (has(/^Error from server \(Forbidden\)/m) || has(/ is forbidden: /)) {
    return "forbidden";
  }
  if (
    // An expired or wrong token prints the second or third form, without
    // the word Unauthorized in brackets.
    has(/\(Unauthorized\)/) ||
    has(/You must be logged in to the server/) ||
    has(/the server has asked for the client to provide credentials/) ||
    has(/getting credentials: |failed to refresh token/)
  ) return "unauthorized";
  if (has(/\(Conflict\)|\(AlreadyExists\)/)) return "conflict";
  if (
    has(
      /\((Timeout|ServerTimeout)\)|context deadline exceeded|Client\.Timeout exceeded|i\/o timeout|TLS handshake timeout|request canceled while waiting/,
    )
  ) return "timeout";
  if (
    has(
      /connection to the server .* was refused|Unable to connect to the server|connection refused|no such host|no route to host|network is unreachable|dial tcp|connection reset by peer|certificate signed by unknown authority|certificate has expired/i,
    )
  ) return "unreachable";
  return "other";
}

/** What a kind of failure means, for the kinds whose sentence does not say. */
const HINTS: Partial<Record<KubectlFailure, string>> = {
  unauthorized:
    "the cluster did not accept the credentials of this context; they are expired or wrong, log in again",
  "missing-crd":
    "the cluster does not serve this resource type; the CRDs that define it are not installed",
  unreachable: "the cluster could not be reached",
  timeout: "no answer in time",
};

/**
 * The arguments as they are named in a message: a patch body is left out,
 * the rest is redacted and bounded.
 */
export function describeKubectlArgs(
  args: string[],
  secrets?: string[],
): string {
  const named: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a === "-p" || a === "--patch") {
      named.push(a, "<patch>");
      i++;
    } else if (a.startsWith("--patch=")) {
      named.push("--patch=<patch>");
    } else {
      named.push(a);
    }
  }
  return brief(named.join(" "), 200, secrets);
}

/**
 * The error for a kubectl call that exited non-zero. `stderr` is standard
 * error as `tryCli` returns it: log lines dropped, redacted, bounded.
 */
export function kubectlFailure(
  args: string[],
  stderr: string,
  secrets?: string[],
): KubectlError {
  const kind = classifyStderr(stderr);
  const detail = brief(stderr) || "(no error output)";
  const hint = HINTS[kind];
  return new KubectlError(
    kind,
    `kubectl ${describeKubectlArgs(args, secrets)} failed: ${
      hint ? `${hint} (${detail})` : detail
    }`,
    stderr,
  );
}

/**
 * Parse what kubectl printed. Output that is not JSON is a `not-json` error
 * that names the command and the size of the output, never its text: the
 * objects read here can hold tokens and keys.
 */
export function parseKubectlJson(
  text: string,
  args: string[],
  secrets?: string[],
): unknown {
  try {
    return JSON.parse(text);
  } catch {
    throw new KubectlError(
      "not-json",
      `kubectl ${describeKubectlArgs(args, secrets)} did not print JSON (${
        text.trim() === "" ? "no output" : `${text.length} characters of output`
      })`,
    );
  }
}

/**
 * The full kubectl argument list: cluster flags, the request timeout, the
 * command and, unless `output` is false, `-o json`. Refuses a command that
 * brings one of the runner's flags itself, because kubectl would take the
 * last one given.
 */
export function kubectlArgs(
  args: string[],
  opts?: ClusterOpts & KubectlLimit,
  output = true,
): string[] {
  const owned = output
    ? /^(--request-timeout|--kubeconfig|--context|-o|--output)/
    : /^(--request-timeout|--kubeconfig|--context)/;
  const own = args.find((a) => owned.test(a));
  if (own !== undefined) {
    throw new Error(
      `kubectl arguments may not hold ${own.split("=")[0]}: the runner sets ${
        output
          ? "the cluster, the request timeout and the output format"
          : "the cluster and the request timeout"
      }`,
    );
  }
  return cliArgs(
    [
      `--request-timeout=${requestTimeoutOf(opts)}s`,
      ...args,
      ...(output ? ["-o", "json"] : []),
    ],
    opts,
  );
}

/** Run kubectl and return its standard output, or throw a KubectlError. */
async function kubectl(
  args: string[],
  full: string[],
  opts: KubectlOpts,
): Promise<string> {
  const what = `kubectl ${describeKubectlArgs(args, opts.secrets)}`;
  const killAfterMs = kubectlKillAfterMs(opts);
  let result: CliResult;
  try {
    result = await tryCli(opts.bin ?? KUBECTL, full, {
      timeoutMs: killAfterMs,
      signal: opts.signal,
      stdin: opts.stdin,
      cwd: opts.cwd,
      secrets: opts.secrets,
      noise: isClientGoLogLine,
    });
  } catch (err) {
    if (err instanceof CliError && err.kind === "not-installed") {
      throw new KubectlError("not-installed", err.message);
    }
    throw err;
  }
  if (result.cancelled) {
    throw new KubectlError("cancelled", `${what} was cancelled`);
  }
  if (result.timedOut) {
    throw new KubectlError(
      "timeout",
      `${what} failed: no answer within ${
        killAfterMs / 1000
      } seconds; kubectl was stopped`,
      result.stderr,
    );
  }
  // The exit status decides, before standard output is looked at.
  if (!result.success) {
    throw kubectlFailure(args, result.stderr, opts.secrets);
  }
  return result.stdout;
}

/**
 * Run `kubectl <args> -o json` against the cluster of `opts` and return the
 * parsed answer. Every failure is a `KubectlError` with a `kind`. The exit
 * status decides: on a non-zero exit standard output is not read, whatever
 * it holds (a refused list prints an empty List and exits 1).
 */
export async function runKubectl(
  args: string[],
  opts: KubectlOpts = {},
): Promise<unknown> {
  const stdout = await kubectl(args, kubectlArgs(args, opts), opts);
  return parseKubectlJson(stdout, args, opts.secrets);
}

/**
 * Run `kubectl <args>` for a command whose answer is not JSON (`apply`,
 * `get --raw`, `-o jsonpath=...`) and return what it printed. The cluster
 * flags, the request timeout, the time limit and the named failures are
 * those of `runKubectl`.
 */
export async function runKubectlText(
  args: string[],
  opts: KubectlOpts = {},
): Promise<string> {
  return await kubectl(args, kubectlArgs(args, opts, false), opts);
}

// ---------------------------------------------------------------------------
// Names
// ---------------------------------------------------------------------------

/** A Kubernetes object name: a DNS subdomain of at most 253 characters. */
export const OBJECT_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/** A Kubernetes namespace name: a DNS label of at most 63 characters. */
export const NAMESPACE_NAME = /^[a-z0-9]([-a-z0-9]{0,61}[a-z0-9])?$/;

const RESOURCE_NAME = /^[a-z0-9]([-a-z0-9.]{0,251}[a-z0-9])?$/;

/**
 * An object name as Kubernetes accepts it, or a named refusal. The name
 * becomes one argument of a command, and a value such as `--all` or `-A`
 * would be read there as a flag, so anything else is refused before a
 * command is spawned. `what` names the value in the refusal.
 */
export function checkName(value: unknown, what = "name"): string {
  if (typeof value !== "string" || !OBJECT_NAME.test(value)) {
    throw new Error(
      `${what} ${
        shown(value)
      } is not a Kubernetes object name: lowercase letters, digits, '-' and '.', starting and ending with a letter or digit, at most 253 characters`,
    );
  }
  return value;
}

/** A namespace as Kubernetes accepts it, or a named refusal. */
export function checkNamespace(value: unknown): string {
  if (typeof value !== "string" || !NAMESPACE_NAME.test(value)) {
    throw new Error(
      `namespace ${
        shown(value)
      } is not a Kubernetes namespace name: lowercase letters, digits and '-', starting and ending with a letter or digit, at most 63 characters`,
    );
  }
  return value;
}

/**
 * The namespace a list reads: the argument, else the global argument; empty
 * means every namespace. An empty argument counts as not given, because
 * swamp fills a method argument that was left out from the global argument
 * of the same name, whose default is empty.
 */
export function listNamespace(
  argNamespace: string | undefined,
  globalNamespace: string | undefined,
): string {
  const ns = argNamespace || globalNamespace || "";
  return ns === "" ? "" : checkNamespace(ns);
}

/**
 * The namespace a method on one object acts in, or a named refusal when
 * neither the argument nor the global argument holds one. An empty argument
 * counts as not given, as in `listNamespace`.
 */
export function requireNamespace(
  action: string,
  argNamespace: string | undefined,
  globalNamespace: string | undefined,
): string {
  const ns = argNamespace || globalNamespace || "";
  if (ns === "") {
    throw new Error(
      `namespace is required for ${action}: set it in the definition's global arguments or pass the namespace argument`,
    );
  }
  return checkNamespace(ns);
}

function checkResource(resource: string): string {
  if (typeof resource !== "string" || !RESOURCE_NAME.test(resource)) {
    throw new Error(
      `resource ${shown(resource)} is not a Kubernetes resource name`,
    );
  }
  return resource;
}

/**
 * The `kubectl get` arguments for a list: one namespace when given, every
 * namespace for an empty one, neither for a cluster-scoped resource (null).
 * The namespace is checked here too.
 */
export function listArgs(
  resource: string,
  namespace: string | null,
): string[] {
  checkResource(resource);
  if (namespace === null) return ["get", resource];
  return namespace === ""
    ? ["get", resource, "-A"]
    : ["get", resource, "-n", checkNamespace(namespace)];
}

/**
 * The `kubectl get` arguments for one object; a null namespace reads a
 * cluster-scoped resource. Name and namespace are checked here too, so a
 * caller that forgot cannot pass a flag.
 */
export function getArgs(
  resource: string,
  name: string,
  namespace: string | null,
): string[] {
  checkResource(resource);
  checkName(name);
  return namespace === null
    ? ["get", resource, name]
    : ["get", resource, name, "-n", checkNamespace(namespace)];
}

// ---------------------------------------------------------------------------
// Readers that do not trust the shape
// ---------------------------------------------------------------------------

/** `v` when it is a plain object, else an empty one. */
export function obj(v: unknown): Record<string, unknown> {
  return v !== null && typeof v === "object" && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};
}

/** `v` when it is an array, else an empty one. */
export function arr(v: unknown): unknown[] {
  return Array.isArray(v) ? v : [];
}

/** `v` when it is a string, else the fallback. */
export function str(v: unknown, fallback = ""): string {
  return typeof v === "string" ? v : fallback;
}

/** `v` when it is a string, the empty one included, else null. */
export function strOrNull(v: unknown): string | null {
  return typeof v === "string" ? v : null;
}

/** `v` when it is a string that is not empty, else null. */
export function nonEmpty(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** `v` when it is a finite number, else the fallback. */
export function num(v: unknown, fallback = 0): number {
  return typeof v === "number" && Number.isFinite(v) ? v : fallback;
}

/** `v` when it is a finite number, else null. */
export function numOrNull(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** `v` when it is a boolean, else the fallback. */
export function bool(v: unknown, fallback = false): boolean {
  return typeof v === "boolean" ? v : fallback;
}

/** `v` when it is a boolean, else null. */
export function boolOrNull(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

/** The strings in `v` when it is an array, else an empty list. */
export function strings(v: unknown): string[] {
  return arr(v).filter((s): s is string => typeof s === "string");
}

/**
 * The items of a `kubectl get` list answer, or an error that says what came
 * instead. The answer must be a List with an items array of objects; with
 * `itemKind`, every item must be of that kind. `what` names the read.
 */
export function listItems(
  data: unknown,
  what: string,
  itemKind?: string,
): Record<string, unknown>[] {
  const list = obj(data);
  const kind = str(list.kind);
  if (!kind.endsWith("List") || !Array.isArray(list.items)) {
    throw new KubectlError(
      "other",
      `${what} did not return a list: ${
        kind ? `the answer is of kind ${shown(kind)}` : "the answer has no kind"
      }${Array.isArray(list.items) ? "" : " and no items array"}`,
    );
  }
  return list.items.map((item, i) => {
    const o = obj(item);
    if (item !== o) {
      throw new KubectlError(
        "other",
        `${what} returned a list whose item ${i} is not an object`,
      );
    }
    if (itemKind !== undefined && o.kind !== itemKind) {
      throw new KubectlError(
        "other",
        `${what} returned a list whose item ${i} is of kind ${
          shown(str(o.kind, "(none)"))
        }, not ${itemKind}`,
      );
    }
    return o;
  });
}

/**
 * One object of a `kubectl get <resource> <name>` answer, or an error when
 * the answer is not the object that was asked for: another kind, another
 * name, or another namespace. A null namespace is a cluster-scoped object.
 */
export function expectObject(
  data: unknown,
  want: { kind: string; name: string; namespace: string | null },
): Record<string, unknown> {
  const item = obj(data);
  const meta = obj(item.metadata);
  const where = want.namespace === null
    ? want.name
    : `${want.namespace}/${want.name}`;
  if (
    item.kind !== want.kind || meta.name !== want.name ||
    (want.namespace !== null && meta.namespace !== want.namespace)
  ) {
    throw new KubectlError(
      "other",
      `kubectl did not return ${want.kind} ${where}: the answer is of kind ${
        shown(str(item.kind, "(none)"))
      } with name ${shown(str(meta.name, "(none)"))}`,
    );
  }
  return item;
}

/** One condition as stored: null where the controller wrote nothing. */
export const ConditionSchema = z.object({
  type: z.string(),
  status: z.string().describe(
    "True, False or Unknown, as the controller set it",
  ),
  reason: z.string().nullable(),
  message: z.string().nullable(),
  lastTransitionTime: z.string().nullable(),
  observedGeneration: z.number().nullable(),
});

/** One stored condition. */
export type Condition = z.infer<typeof ConditionSchema>;

/**
 * A conditions array as kubectl printed it, reduced to the stored fields.
 * Anything that is not a condition (no type) is dropped, a missing status
 * reads as `Unknown`, and a message is redacted: controllers copy error
 * text from elsewhere into it. For records only: never build a status patch
 * from the result, which would write the redacted messages back to the
 * cluster. A writer passes the raw conditions through.
 */
export function readConditions(raw: unknown): Condition[] {
  const out: Condition[] = [];
  for (const entry of arr(raw)) {
    const c = obj(entry);
    const type = nonEmpty(c.type);
    if (type === null) continue;
    const message = strOrNull(c.message);
    out.push({
      type,
      status: nonEmpty(c.status) ?? "Unknown",
      reason: strOrNull(c.reason),
      message: message === null ? null : redact(message),
      lastTransitionTime: nonEmpty(c.lastTransitionTime),
      observedGeneration: numOrNull(c.observedGeneration),
    });
  }
  return out;
}

/** The condition of one type, when the controller reported it. */
export function findCondition(
  conditions: Condition[],
  type: string,
): Condition | undefined {
  return conditions.find((c) => c.type === type);
}

/** Whether the condition of one type is present with status True. */
export function conditionTrue(conditions: Condition[], type: string): boolean {
  return findCondition(conditions, type)?.status === "True";
}

/**
 * A condition as three states: true, false, or null when it is missing or
 * `Unknown`.
 */
export function conditionState(
  conditions: Condition[],
  type: string,
): boolean | null {
  const status = findCondition(conditions, type)?.status;
  return status === "True" ? true : status === "False" ? false : null;
}

/** The identity of an object. */
export interface Meta {
  apiVersion: string;
  kind: string;
  name: string;
  /** Empty for a cluster-scoped object. */
  namespace: string;
  uid: string;
  generation: number | null;
  resourceVersion: string | null;
  createdAt: string | null;
}

/**
 * The identity of an object kubectl returned, or an error when it has no
 * name (or, for a namespaced kind, no namespace): such an answer is not an
 * object and cannot be recorded. Annotations and labels are not returned;
 * read the one you need with `annotation` or `label`.
 */
export function readMeta(
  item: Record<string, unknown>,
  namespaced: boolean,
  kind = "object",
): Meta {
  const meta = obj(item.metadata);
  const name = nonEmpty(meta.name);
  const namespace = nonEmpty(meta.namespace);
  if (name === null || (namespaced && namespace === null)) {
    throw new KubectlError(
      "other",
      `kubectl returned a ${kind} without a name${
        namespaced ? " or namespace" : ""
      }; the answer is not a ${kind}`,
    );
  }
  return {
    apiVersion: str(item.apiVersion),
    kind: str(item.kind),
    name,
    namespace: namespace ?? "",
    uid: str(meta.uid),
    generation: numOrNull(meta.generation),
    resourceVersion: nonEmpty(meta.resourceVersion),
    createdAt: nonEmpty(meta.creationTimestamp),
  };
}

/** The value of one annotation, or null. */
export function annotation(
  item: Record<string, unknown>,
  key: string,
): string | null {
  return strOrNull(obj(obj(item.metadata).annotations)[key]);
}

/** The value of one label, or null. */
export function label(
  item: Record<string, unknown>,
  key: string,
): string | null {
  return strOrNull(obj(obj(item.metadata).labels)[key]);
}

/** The name of the owner of one kind, from the owner references. */
export function ownerName(
  item: Record<string, unknown>,
  kind: string,
): string | null {
  const owner = arr(obj(item.metadata).ownerReferences).map(obj).find((o) =>
    o.kind === kind
  );
  return owner ? nonEmpty(owner.name) : null;
}

/**
 * Whether `item` is owned by the object of `kind` with this uid and name.
 * The uid decides when both sides have one; the name is the fallback.
 */
export function isOwnedBy(
  item: Record<string, unknown>,
  kind: string,
  owner: { uid: string; name: string },
): boolean {
  return arr(obj(item.metadata).ownerReferences).map(obj).some((o) => {
    if (o.kind !== kind) return false;
    const uid = str(o.uid);
    return uid && owner.uid ? uid === owner.uid : o.name === owner.name;
  });
}

// ---------------------------------------------------------------------------
// Data names and the inventory record
// ---------------------------------------------------------------------------

function part(value: string): string {
  return value.replace(/[^A-Za-z0-9._-]/g, "_").replace(/\.+$/, "") || "_";
}

/**
 * The data name of an object's record: `<namespace>--<name>`, or `<name>`
 * for a cluster-scoped object (namespace null or empty). Every valid
 * Kubernetes name passes through unchanged; anything else is reduced to
 * letters, digits, '.', '_' and '-', so the name is a file name everywhere.
 */
export function dataName(namespace: string | null, name: string): string {
  return namespace ? `${part(namespace)}--${part(name)}` : part(name);
}

/**
 * The data name of a list's inventory record: `inventory_all` for every
 * namespace (and for a cluster-scoped kind), `inventory_ns_<namespace>` for
 * one. A Kubernetes name holds no underscore, so no object's data name,
 * namespaced or cluster-scoped, can equal either.
 */
export function inventoryName(namespace: string | null): string {
  return namespace ? `inventory_ns_${part(namespace)}` : "inventory_all";
}

/**
 * Refuse a set of objects in which two would be stored under one data name
 * (`a--b` in `c` and `b--c` in `a` both read `a--b--c`), or one under a
 * `reserved` name such as the inventory's. Call it before the first write:
 * the second record would silently replace the first.
 */
export function assertDistinctDataNames(
  kind: string,
  objects: Array<{ namespace: string | null; name: string }>,
  reserved: string[] = [],
): void {
  const seen = new Map<string, string>();
  for (const o of objects) {
    const stored = dataName(o.namespace, o.name);
    const id = o.namespace ? `${o.namespace}/${o.name}` : o.name;
    if (reserved.includes(stored)) {
      throw new Error(
        `${kind} ${id} would be stored as ${stored}, the name of another record of this list; read it by name instead`,
      );
    }
    const other = seen.get(stored);
    if (other !== undefined && other !== id) {
      throw new Error(
        `${kind} ${other} and ${id} would both be stored as ${stored}; list one namespace at a time`,
      );
    }
    seen.set(stored, id);
  }
}

/** One line of an inventory: an object, whether it is healthy, and why not. */
export const InventoryItemSchema = z.object({
  namespace: z.string().nullable().describe(
    "Null for a cluster-scoped object",
  ),
  name: z.string(),
  dataName: z.string().describe("The data name of the object's own record"),
  healthy: z.boolean(),
  reason: z.string().nullable().describe(
    "One line that says what is wrong; null when healthy",
  ),
});

/** One stored inventory line. */
export type InventoryItem = z.infer<typeof InventoryItemSchema>;

/**
 * What one list saw. The records of objects that no longer exist stay in
 * the data store, so this is the record that says which objects existed at
 * `observedAt`. An extension extends the schema with what its domain adds.
 */
export const InventorySchema = z.object({
  namespace: z.string().nullable().describe(
    "The namespace listed; null when every namespace, or a cluster-scoped kind, was listed",
  ),
  count: z.number().int(),
  healthyCount: z.number().int(),
  unhealthyCount: z.number().int(),
  items: z.array(InventoryItemSchema),
  observedAt: z.string(),
});

/** One stored inventory. */
export type Inventory = z.infer<typeof InventorySchema>;

/**
 * Build the inventory of one list. `namespace` is the listed namespace, or
 * null or empty for all. Items may carry more fields than the core; they
 * are kept as given.
 */
export function buildInventory<T extends InventoryItem>(
  namespace: string | null,
  items: T[],
  observedAt: string,
): Omit<Inventory, "items"> & { items: T[] } {
  const unhealthy = items.filter((i) => !i.healthy).length;
  return {
    namespace: namespace || null,
    count: items.length,
    healthyCount: items.length - unhealthy,
    unhealthyCount: unhealthy,
    items,
    observedAt,
  };
}
