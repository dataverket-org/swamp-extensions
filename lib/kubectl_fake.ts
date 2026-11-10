/**
 * A strict fake kubectl for unit tests, built on the fake of `cli_fake.ts`.
 * It adds kubectl's grammar: every call must have the cluster flags of the
 * test, the request timeout, a verb and flags it knows, names that are
 * Kubernetes names, and `-o json`. Only then is the call matched against
 * the script, or handed to the handler. Anything else throws, which fails
 * the test that caused it.
 *
 * Shared: an extension's tests import it as `../lib/kubectl_fake.ts`, and
 * its own `test_support.ts` holds its fixtures and builds on this. No entry
 * point imports it, so it is never part of a published extension.
 *
 * @module
 */
import {
  type Answer,
  type Expected,
  type FakeCli,
  fakeCli,
  type FakeTime,
  type SpawnedCall,
  withFake,
} from "./cli_fake.ts";
import { CHECK_TIMEOUT_MS } from "./cli.ts";
import {
  KUBECTL,
  KUBECTL_KILL_AFTER_MS,
  MAX_REQUEST_TIMEOUT_SECONDS,
  NAMESPACE_NAME,
  OBJECT_NAME,
  REQUEST_TIMEOUT_SECONDS,
} from "./kubectl.ts";

export { type Answer, CAPTURE, HOSTILE } from "./cli_fake.ts";

/** One scripted call; the binary is kubectl when left out. */
export interface ExpectedKubectl extends Omit<Expected, "bin"> {
  /** Another binary, for a type that also drives one; matched as spawned. */
  bin?: string;
  /**
   * For kubectl: the command only, without the cluster flags, the request
   * timeout and `-o json` (the fake checks those itself). For another
   * binary: every argument, exactly.
   */
  args: string[];
  /**
   * A call made with `runKubectlText`: it does not end with `-o json`, and
   * its command must be one of the fake's `textCommands`.
   */
  text?: boolean;
  /**
   * The request timeout the call must carry, when it sets one of its own
   * (`KubectlOpts.requestTimeoutSeconds`): the flag and the kill time are
   * checked against it. Left out, the call must carry the default 30 s, so
   * a call with another limit never matches by accident.
   */
  requestTimeoutSeconds?: number;
}

/**
 * One kubectl command whose answer is text, as a test declares it. The fake
 * knows no text command by itself: a test names the ones its type runs, and
 * every flag they may carry, and anything else is refused.
 */
export interface TextCommand {
  /** The leading words, exactly: `["create", "token"]`, `["apply"]`. */
  words: string[];
  /**
   * Flags without a value of their own, or `name=` for `--name=<value>`:
   * `["--minify", "--duration=", "--audience="]`.
   */
  flags?: string[];
  /** Flags followed by their value as the next argument: `["-n", "-f"]`. */
  valueFlags?: string[];
  /** Flags the command must carry. */
  required?: string[];
  /** How many arguments besides words and flags: `[min, max]`; none if left out. */
  positionals?: [number, number];
  /**
   * Whether those arguments must be Kubernetes object names. True unless
   * set to false, for a path or another value.
   */
  names?: boolean;
  /** The command reads standard input. */
  stdin?: boolean;
}

/** A kubectl call as the fake understood it. */
export interface KubectlCall {
  /** Every argument, as spawned. */
  args: string[];
  /** The command: the arguments without cluster flags, timeout and output. */
  command: string[];
  verb: string;
  resource?: string;
  name?: string;
  namespace?: string;
  allNamespaces: boolean;
  selector?: string;
  /** The patch body, from `-p` or from standard input. */
  patch?: string;
  stdin?: string;
  /** The request timeout the call carried, in seconds; 30 unless it set one. */
  requestTimeoutSeconds?: number;
  /** True for a text call; then the three fields below are set. */
  text?: boolean;
  /** Text call: the arguments besides words and flags, in order. */
  positionals?: string[];
  /** Text call: each flag with its value, or `true` when it has none. */
  flags?: Record<string, string | true>;
}

/** How the fake is set up. */
export interface FakeKubectlOptions {
  /** The kubeconfig every call must carry; none when left out. */
  kubeconfig?: string;
  /** The context every call must carry; none when left out. */
  context?: string;
  /** The calls expected, in order. */
  calls?: ExpectedKubectl[];
  /**
   * Answers kubectl calls that are not scripted: a fake cluster. It gets
   * the call after every check has passed.
   */
  handler?: (call: KubectlCall) => Answer | undefined;
  /**
   * Resources that are cluster-scoped. A get of one of them with `-n` or
   * `-A` is refused, and so is a get of any other resource without either:
   * it would read the namespace of the kubeconfig.
   */
  clusterScoped?: string[];
  /**
   * The text commands this test's type runs through `runKubectlText`. A
   * text call that is none of them, or carries a flag they do not list, is
   * refused.
   */
  textCommands?: TextCommand[];
  /**
   * The kubectl binary every call must be run as, for a type that lets it
   * be overridden; `kubectl` when left out.
   */
  bin?: string;
  /**
   * Request timeouts other than the default that a call answered by the
   * `handler` may carry, in seconds. A scripted call says its own with
   * `requestTimeoutSeconds`.
   */
  requestTimeouts?: number[];
}

/** What a test holds on to. */
export interface FakeKubectl extends FakeCli {
  /** Every kubectl call that passed the grammar, in order. */
  kubectl: KubectlCall[];
}

const VERSION_ARGS = ["version", "--client"];
const RESOURCE = /^[a-z0-9]([-a-z0-9.]*[a-z0-9])?$/;
const SELECTOR = /^[A-Za-z0-9][A-Za-z0-9._\/=!, ()-]*$/;

function refuse(why: string, args: string[]): never {
  throw new Error(`fake kubectl: ${why} (kubectl ${args.join(" ")})`);
}

/**
 * Stands first in the arguments a call is matched by when it carries a
 * request timeout of its own, so it can only match a scripted call that
 * expects that limit.
 */
function limitMark(seconds: number): string[] {
  return seconds === REQUEST_TIMEOUT_SECONDS
    ? []
    : [`<request timeout ${seconds}s>`];
}

/** Take the cluster flags and the timeout off, checking both. */
function command(
  args: string[],
  o: FakeKubectlOptions,
  seconds: number,
): string[] {
  const rest = [...args];
  const want: string[] = [];
  if (o.kubeconfig) want.push("--kubeconfig", o.kubeconfig);
  if (o.context) want.push("--context", o.context);
  want.push(`--request-timeout=${seconds}s`);
  const got = rest.splice(0, want.length);
  if (JSON.stringify(got) !== JSON.stringify(want)) {
    refuse(
      `the call must start with ${
        want.join(" ")
      }: the cluster of this test and the request timeout`,
      args,
    );
  }
  return rest;
}

const JSON_TAIL = ["-o", "json"];

function endsWithJson(cmd: string[]): boolean {
  return cmd.length >= 2 && cmd.at(-2) === "-o" && cmd.at(-1) === "json";
}

/**
 * Check a text call against the commands the test declared, as kubectl
 * would check it against its own.
 */
function parseText(
  args: string[],
  cmd: string[],
  stdin: string | undefined,
  o: FakeKubectlOptions,
): KubectlCall {
  const spec = (o.textCommands ?? [])
    .filter((c) => c.words.length > 0 && c.words.every((w, i) => cmd[i] === w))
    .sort((x, y) => y.words.length - x.words.length)[0];
  if (spec === undefined) {
    refuse(
      "the call must end with -o json, or be a text command this test declared in textCommands",
      args,
    );
  }
  const label = spec.words.join(" ");
  const rest = cmd.slice(spec.words.length);
  const flags: Record<string, string | true> = {};
  const positional: string[] = [];
  const set = (flag: string, value: string | true) => {
    if (flag in flags) refuse(`flag given twice: ${flag}`, args);
    flags[flag] = value;
  };
  while (rest.length > 0) {
    const a = rest.shift()!;
    const eq = a.indexOf("=");
    if ((spec.valueFlags ?? []).includes(a)) {
      const v = rest.shift();
      if (v === undefined) refuse(`${a} needs a value`, args);
      set(a, v);
    } else if ((spec.flags ?? []).includes(a)) {
      set(a, true);
    } else if (
      a.startsWith("-") && eq > 0 &&
      (spec.flags ?? []).includes(a.slice(0, eq + 1))
    ) {
      set(a.slice(0, eq), a.slice(eq + 1));
    } else if (a.startsWith("-")) {
      refuse(`unknown flag for ${label}: ${a}`, args);
    } else {
      positional.push(a);
    }
  }
  for (const flag of spec.required ?? []) {
    if (!(flag.replace(/=$/, "") in flags)) {
      refuse(`${label} needs ${flag}`, args);
    }
  }
  const [min, max] = spec.positionals ?? [0, 0];
  if (positional.length < min || positional.length > max) {
    refuse(
      `${label} takes ${
        min === max ? min : `${min} to ${max}`
      } argument(s), got ${positional.length}`,
      args,
    );
  }
  if (spec.names !== false) {
    for (const p of positional) {
      if (!OBJECT_NAME.test(p)) {
        refuse(`${JSON.stringify(p)} is no object name`, args);
      }
    }
  }
  const namespace = flags["-n"] ?? flags["--namespace"];
  if (namespace !== undefined && !NAMESPACE_NAME.test(String(namespace))) {
    refuse(`-n ${JSON.stringify(namespace)} is no namespace`, args);
  }
  const fromStdin = Object.values(flags).includes("-");
  if (stdin !== undefined && !spec.stdin) {
    refuse(`${label} was given input it does not read`, args);
  }
  if (fromStdin && stdin === undefined) {
    refuse(`${label} reads standard input and was given none`, args);
  }
  return {
    args,
    command: cmd,
    verb: spec.words[0],
    name: spec.names !== false ? positional[0] : undefined,
    namespace: typeof namespace === "string" ? namespace : undefined,
    allNamespaces: false,
    stdin,
    text: true,
    positionals: positional,
    flags,
  };
}

/** Parse a command as kubectl would, refusing what kubectl would refuse. */
function parse(
  args: string[],
  cmd: string[],
  stdin: string | undefined,
  o: FakeKubectlOptions,
): KubectlCall {
  const rest = [...cmd];
  const verb = rest.shift() ?? "";
  const call: KubectlCall = {
    args,
    command: cmd,
    verb,
    allNamespaces: false,
    stdin,
  };
  const seen = new Set<string>();
  const once = (flag: string) => {
    if (seen.has(flag)) refuse(`flag given twice: ${flag}`, args);
    seen.add(flag);
  };
  const value = (flag: string): string => {
    const v = rest.shift();
    if (v === undefined) refuse(`${flag} needs a value`, args);
    return v;
  };
  const positional: string[] = [];
  let fromFile: string | undefined;
  let patchFile: string | undefined;
  while (rest.length > 0) {
    const a = rest.shift()!;
    if (a === "-n") {
      once(a);
      call.namespace = value(a);
      if (!NAMESPACE_NAME.test(call.namespace)) {
        refuse(`-n ${JSON.stringify(call.namespace)} is no namespace`, args);
      }
    } else if (a === "-A" && verb === "get") {
      once(a);
      call.allNamespaces = true;
    } else if (a === "-l" && verb === "get") {
      once(a);
      call.selector = value(a);
      if (!SELECTOR.test(call.selector)) {
        refuse(`-l ${JSON.stringify(call.selector)} is no selector`, args);
      }
    } else if (a === "-f" && verb === "create") {
      once(a);
      fromFile = value(a);
    } else if (a === "-p" && verb === "patch") {
      once(a);
      call.patch = value(a);
    } else if (a.startsWith("--patch-file=") && verb === "patch") {
      once("--patch-file");
      patchFile = a.slice("--patch-file=".length);
    } else if (
      /^--type=(merge|json|strategic)$/.test(a) && verb === "patch"
    ) {
      once("--type");
    } else if (/^--subresource=(status|scale)$/.test(a) && verb !== "create") {
      once("--subresource");
    } else if (a.startsWith("-")) {
      refuse(`unknown flag for ${verb}: ${a}`, args);
    } else {
      positional.push(a);
    }
  }

  if (verb === "create") {
    if (fromFile !== "-") refuse("create is only known as create -f -", args);
    if (positional.length > 0) refuse("create takes no name", args);
    if (stdin === undefined) refuse("create -f - without input", args);
    return call;
  }
  if (verb !== "get" && verb !== "patch") {
    refuse(`the fake does not know the verb ${JSON.stringify(verb)}`, args);
  }
  if (positional.length > 2) {
    refuse(`unexpected argument: ${positional[2]}`, args);
  }
  [call.resource, call.name] = positional;
  if (call.resource === undefined || !RESOURCE.test(call.resource)) {
    refuse(`${verb} needs a resource, got ${call.resource}`, args);
  }
  if (call.name !== undefined && !OBJECT_NAME.test(call.name)) {
    refuse(`${JSON.stringify(call.name)} is no object name`, args);
  }
  if (call.allNamespaces && call.namespace !== undefined) {
    refuse("-A together with -n", args);
  }
  if (call.allNamespaces && call.name !== undefined) {
    refuse("-A together with a name", args);
  }
  const scoped = call.allNamespaces || call.namespace !== undefined;
  if ((o.clusterScoped ?? []).includes(call.resource)) {
    if (scoped) refuse(`${call.resource} is cluster-scoped: no -n, -A`, args);
  } else if (!scoped) {
    refuse(
      `${call.resource} without -n or -A reads the kubeconfig's namespace; list it in clusterScoped when it has none`,
      args,
    );
  }
  if (verb === "patch") {
    if (call.name === undefined) refuse("patch needs a name", args);
    if ((call.patch === undefined) === (patchFile === undefined)) {
      refuse("patch needs exactly one of -p and --patch-file", args);
    }
    if (patchFile !== undefined) {
      if (patchFile !== "/dev/stdin" || stdin === undefined) {
        refuse("--patch-file is only known as /dev/stdin with input", args);
      }
      call.patch = stdin;
    }
  }
  if (stdin !== undefined && patchFile === undefined) {
    refuse(`${verb} was given input it does not read`, args);
  }
  return call;
}

/**
 * Build the fake. Install its `spawn` with `__setSpawn`, or use
 * `withKubectl`. A `kubectl version --client` that is not scripted is
 * answered with a version, so a pre-flight check passes.
 */
export function fakeKubectl(o: FakeKubectlOptions = {}): FakeKubectl {
  const kubectl: KubectlCall[] = [];
  const bin = o.bin ?? KUBECTL;
  let last: KubectlCall | undefined;
  const isVersion = (args: string[]) =>
    JSON.stringify(args) === JSON.stringify(VERSION_ARGS);
  const cli = fakeCli({
    // A JSON call is matched with its `-o json`, a text call without, so
    // neither can stand for the other.
    calls: (o.calls ?? []).map((c) => {
      const { text, ...call } = c;
      const { requestTimeoutSeconds, ...rest } = call;
      const own = (rest.bin ?? bin) === bin;
      if (!own || isVersion(rest.args)) {
        return { ...rest, bin: rest.bin ?? bin };
      }
      return {
        ...rest,
        bin,
        args: [
          ...limitMark(requestTimeoutSeconds ?? REQUEST_TIMEOUT_SECONDS),
          ...rest.args,
          ...(text ? [] : JSON_TAIL),
        ],
      };
    }),
    grammar: {
      [bin]: (spawned: SpawnedCall) => {
        last = undefined;
        if (isVersion(spawned.args)) {
          if (spawned.timeoutMs !== CHECK_TIMEOUT_MS) {
            refuse("the version check has its own time limit", spawned.args);
          }
          return spawned.args;
        }
        // The kill time says which request timeout the call must carry:
        // the two belong together, 5 s apart.
        const seconds = spawned.timeoutMs / 1000 - 5;
        if (
          !Number.isInteger(seconds) || seconds < 1 ||
          seconds > MAX_REQUEST_TIMEOUT_SECONDS
        ) {
          refuse(
            `a call must be stopped after ${KUBECTL_KILL_AFTER_MS} ms, or 5 s after a request timeout of its own, not ${spawned.timeoutMs}`,
            spawned.args,
          );
        }
        if (spawned.env !== undefined || spawned.clearEnv !== undefined) {
          refuse("a call takes no environment of its own", spawned.args);
        }
        const cmd = command(spawned.args, o, seconds);
        last = endsWithJson(cmd)
          ? parse(spawned.args, cmd.slice(0, -2), spawned.stdin, o)
          : parseText(spawned.args, cmd, spawned.stdin, o);
        last.requestTimeoutSeconds = seconds;
        kubectl.push(last);
        return [...limitMark(seconds), ...cmd];
      },
    },
    handler: (spawned) => {
      if (spawned.bin !== bin) return undefined;
      if (isVersion(spawned.args)) return { out: "Client Version: v1.34.0" };
      if (last === undefined) return undefined;
      const seconds = last.requestTimeoutSeconds ?? REQUEST_TIMEOUT_SECONDS;
      if (
        o.handler !== undefined && seconds !== REQUEST_TIMEOUT_SECONDS &&
        !(o.requestTimeouts ?? []).includes(seconds)
      ) {
        refuse(
          `a call with a request timeout of ${seconds} s; list it in requestTimeouts when the handler may answer it`,
          spawned.args,
        );
      }
      return o.handler?.(last);
    },
  });
  return { ...cli, kubectl };
}

/**
 * Run `body` against the fake, a sleep that returns at once and a clock
 * that only moves when told to; then check that every scripted call was
 * made, and restore the real spawn, sleep and clock.
 */
export function withKubectl<T>(
  o: FakeKubectlOptions,
  body: (k: FakeKubectl & FakeTime) => Promise<T>,
): Promise<T> {
  return withFake(fakeKubectl(o), body);
}

/** A kubectl list answer. */
export function list(items: unknown[]): Record<string, unknown> {
  return {
    apiVersion: "v1",
    kind: "List",
    metadata: { resourceVersion: "" },
    items,
  };
}

/** A client-go log line, as kubectl prints before its own sentence. */
export const LOG_LINE =
  'E1110 10:48:48.424103 1157133 memcache.go:381] "Couldn\'t get current server API group list" err="Get \\"https://127.0.0.1:1/api?timeout=30s\\": dial tcp 127.0.0.1:1: connect: connection refused"\n';

/** What kubectl writes to standard error, word for word, for each failure. */
export const SAID = {
  notFound: (resource: string, name: string) =>
    `Error from server (NotFound): ${resource} "${name}" not found\n`,
  forbidden: (verb: string, resource: string, namespace = "") => {
    const [plural, ...group] = resource.split(".");
    return `Error from server (Forbidden): ${resource} is forbidden: User "system:serviceaccount:default:reader" cannot ${verb} resource "${plural}" in API group "${
      group.join(".")
    }" ${
      namespace ? `in the namespace "${namespace}"` : "at the cluster scope"
    }\n`;
  },
  unauthorized: "error: You must be logged in to the server (Unauthorized)\n",
  /** An expired or wrong token: five log lines, and no "(Unauthorized)". */
  badToken: LOG_LINE.replace(
    /err=.*/,
    'err="the server has asked for the client to provide credentials"',
  ).repeat(5) +
    "error: You must be logged in to the server (the server has asked for the client to provide credentials)\n",
  missingCrd: (plural: string) =>
    `error: the server doesn't have a resource type "${plural}"\n`,
  noKind: (kind: string, apiVersion: string) =>
    `error: resource mapping not found for name: "x" namespace: "y" from "STDIN": no matches for kind "${kind}" in version "${apiVersion}"\nensure CRDs are installed first\n`,
  conflict: (resource: string, name: string) =>
    `Error from server (Conflict): Operation cannot be fulfilled on ${resource} "${name}": the object has been modified; please apply your changes to the latest version and try again\n`,
  alreadyExists: (resource: string, name: string) =>
    `Error from server (AlreadyExists): error when creating "STDIN": ${resource} "${name}" already exists\n`,
  /** A closed port: five log lines, then the sentence. */
  refused: LOG_LINE.repeat(5) +
    "The connection to the server 127.0.0.1:1 was refused - did you specify the right host or port?\n",
  requestTimeout:
    "Unable to connect to the server: net/http: request canceled (Client.Timeout exceeded while awaiting headers)\n",
};

/** A refused list: kubectl prints an empty List and exits 1. */
export function forbiddenList(resource: string, namespace = ""): Answer {
  return {
    fail: SAID.forbidden("list", resource, namespace),
    stdout: JSON.stringify(list([])),
  };
}
