/**
 * Test support for the Salmon types: a strict grammar of the docker commands
 * the stack runs, on the shared fake of `../lib/cli_fake.ts`; the text
 * commands the token-exchange check runs, for the shared fake kubectl of
 * `../lib/kubectl_fake.ts`; a fake `fetch`; and a method context that keeps
 * what was logged and written. Test-only; no model imports it.
 *
 * @module
 */
import { CHECK_TIMEOUT_MS } from "../lib/cli.ts";
import {
  type FakeCli,
  type FakeCliOptions,
  type FakeTime,
  type Grammar,
  withCli,
} from "../lib/cli_fake.ts";
import {
  type FakeKubectl,
  type FakeKubectlOptions,
  type TextCommand,
  withKubectl,
} from "../lib/kubectl_fake.ts";
import { type DataHandle, FETCH_LIMITS, type MethodContext } from "./common.ts";

function refuse(bin: string, why: string, args: string[]): never {
  throw new Error(`fake ${bin}: ${why} (${bin} ${args.join(" ")})`);
}

const same = (a: string[], b: string[]) =>
  JSON.stringify(a) === JSON.stringify(b);

const PROJECT = /^[a-z0-9][a-z0-9_-]*$/;

/**
 * docker as these types drive it: the four commands, word for word, with a
 * project name compose accepts, input only where compose reads it, and no
 * environment of its own.
 */
export const dockerGrammar: Grammar = (call) => {
  const a = call.args;
  const no = (why: string) => refuse("docker", why, a);
  if (call.env !== undefined || call.clearEnv !== undefined) {
    no("a call takes no environment of its own");
  }
  if (same(a, ["compose", "version"])) {
    if (call.timeoutMs !== CHECK_TIMEOUT_MS) no("the check has its own limit");
    if (call.stdin !== undefined) no("input given to the version check");
    return;
  }
  if (
    same(a, ["compose", "-f", "-", "up", "-d", "--wait", "--remove-orphans"])
  ) {
    if (call.stdin === undefined) no("up -f - without a project on input");
    const project = JSON.parse(call.stdin!);
    if (!PROJECT.test(project.name)) no("the project has no valid name");
    return;
  }
  if (call.stdin !== undefined) no("input given to a command that reads none");
  if (a[0] === "compose" && a[1] === "-p") {
    if (!PROJECT.test(a[2] ?? "")) no(`-p ${JSON.stringify(a[2])}`);
    const rest = a.slice(3);
    if (
      same(rest, ["logs", "--tail", "20", "salmon"]) ||
      same(rest, ["down", "--volumes", "--remove-orphans"])
    ) return;
    no("unknown compose command");
  }
  if (
    a.length === 6 && a[0] === "ps" && a[1] === "-q" && a[2] === "--filter" &&
    /^label=com\.docker\.compose\.project=[a-z0-9][a-z0-9_-]*$/.test(a[3]) &&
    a[4] === "--filter" && a[5] === "label=com.docker.compose.service=salmon"
  ) return;
  no("unknown command");
};

/** `withCli` with the docker grammar. */
export function withDocker<T>(
  o: FakeCliOptions,
  body: (k: FakeCli & FakeTime) => Promise<T>,
): Promise<T> {
  return withCli({ ...o, grammar: { docker: dockerGrammar } }, body);
}

/**
 * The two kubectl commands of the token-exchange check that print text, as
 * the shared fake kubectl is told about them: one name, a namespace, and for
 * a token its lifetime and audience. Any other flag is refused.
 */
export const TEXT_COMMANDS: TextCommand[] = [
  {
    words: ["create", "serviceaccount"],
    valueFlags: ["-n"],
    required: ["-n"],
    positionals: [1, 1],
  },
  {
    words: ["create", "token"],
    valueFlags: ["-n"],
    flags: ["--duration=", "--audience="],
    required: ["-n", "--duration=", "--audience="],
    positionals: [1, 1],
  },
];

/** The shared fake kubectl, knowing the check's text commands. */
export function withCluster<T>(
  o: FakeKubectlOptions,
  body: (k: FakeKubectl & FakeTime) => Promise<T>,
): Promise<T> {
  return withKubectl({ textCommands: TEXT_COMMANDS, ...o }, body);
}

/** Returned by a fake `fetch` answer for a server that never answers. */
export const NEVER = Symbol("never answers");

/**
 * `work`, or a failure when it has not ended after `ms` of real time: a
 * request without a time limit fails the test instead of hanging it.
 */
export async function ends<T>(work: Promise<T>, ms = 3000): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  try {
    return await Promise.race([
      work,
      new Promise<never>((_resolve, reject) => {
        timer = setTimeout(
          () => reject(new Error(`still waiting after ${ms} ms`)),
          ms,
        );
      }),
    ]);
  } finally {
    clearTimeout(timer);
  }
}

/** Run `body` with every HTTP time limit set to `ms`, then put them back. */
export async function withFetchLimits<T>(
  ms: number,
  body: () => Promise<T>,
): Promise<T> {
  const real = { ...FETCH_LIMITS };
  FETCH_LIMITS.probeMs = ms;
  FETCH_LIMITS.discoveryMs = ms;
  FETCH_LIMITS.exchangeMs = ms;
  try {
    return await body();
  } finally {
    Object.assign(FETCH_LIMITS, real);
  }
}

/** One request the fake `fetch` saw. */
export interface Fetched {
  method: string;
  url: string;
  body: string;
}

/**
 * Run `body` with `fetch` replaced by `answer`, which gets each request and
 * returns a Response or throws as a network would. The real `fetch` is put
 * back whatever happened.
 */
export async function withFetch<T>(
  answer: (req: Fetched, n: number) => Response | typeof NEVER,
  body: (seen: Fetched[]) => Promise<T>,
): Promise<T> {
  const real = globalThis.fetch;
  const seen: Fetched[] = [];
  globalThis.fetch = (input, init) => {
    if (init?.signal?.aborted) {
      return Promise.reject(new DOMException("aborted", "AbortError"));
    }
    const req = {
      method: init?.method ?? "GET",
      url: String(input),
      body: init?.body === undefined ? "" : String(init.body),
    };
    seen.push(req);
    try {
      const res = answer(req, seen.length);
      if (res !== NEVER) return Promise.resolve(res);
    } catch (err) {
      return Promise.reject(err);
    }
    // A server that never answers: only the request's own signal ends it.
    return new Promise((_resolve, reject) => {
      if (init?.signal?.aborted) {
        return reject(new DOMException("aborted", "AbortError"));
      }
      init?.signal?.addEventListener(
        "abort",
        () => reject(new DOMException("aborted", "AbortError")),
        { once: true },
      );
    });
  };
  try {
    return await body(seen);
  } finally {
    globalThis.fetch = real;
  }
}

/** A JSON response. */
export function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: { "Content-Type": "application/json" },
  });
}

/** A method context that keeps what was logged and written. */
export interface Recorded<G> extends MethodContext<G> {
  logs: string[];
  writes: { spec: string; name: string; data: Record<string, unknown> }[];
  /** Everything a run left behind, as one text to search for a secret. */
  everything: () => string;
}

/** Build the context of one method run. */
export function context<G>(globalArgs: G, signal?: AbortSignal): Recorded<G> {
  const logs: string[] = [];
  const writes: Recorded<G>["writes"] = [];
  return {
    globalArgs,
    signal,
    logs,
    writes,
    logger: {
      info: (msg, props) => {
        logs.push(`${msg} ${JSON.stringify(props ?? {})}`);
      },
    },
    writeResource: (spec, name, data): Promise<DataHandle> => {
      writes.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    everything: () => JSON.stringify({ logs, writes }),
  };
}

function b64url(s: string): string {
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** An unsigned JWT with these claims; the signature part is `sig`. */
export function jwt(claims: Record<string, unknown>, sig = "c2lnbmF0dXJl") {
  return `${b64url('{"alg":"RS256"}')}.${
    b64url(JSON.stringify(claims))
  }.${sig}`;
}
