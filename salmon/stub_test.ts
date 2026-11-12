/**
 * The unit tests' stub, in the pattern of swamp's testing guide: a method
 * runs its `execute` through `createModelTestContext`, docker and kubectl are
 * a stub spawn installed through `__setSpawn` of `../lib/cli.ts`, and
 * Salmon's HTTP answers are a stub `fetch` put in place of the global one.
 * Each test lists the few commands and requests it needs and what each
 * answers; one it did not list is an error, so a test cannot pass on a call
 * it never meant to make. The stub is not a model of Salmon or a cluster.
 * The live suite in `smoke/` is the proof against real ones; these tests pin
 * what a method writes and refuses.
 *
 * @module
 */
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import { __setSpawn, type SpawnOptions } from "../lib/cli.ts";

/** One command as the stub saw it. */
export interface Call {
  /** The binary and its arguments without the runner's own flags. */
  key: string;
  args: string[];
  stdin?: string;
}

/** One HTTP request as the stub saw it. */
export interface HttpCall {
  /** `METHOD url`. */
  key: string;
  body: string;
}

/** One HTTP answer: a status and a body (an object is sent as JSON). */
export type HttpReply =
  | { status: number; body?: unknown }
  | ((r: HttpCall) => { status: number; body?: unknown });

/**
 * One answer: what the command prints and how it exits, or a function of
 * the call. A `stdout` that is not a string is printed as JSON.
 */
export type Reply =
  | { stdout?: unknown; stderr?: string; code?: number }
  | ((c: Call) => { stdout?: unknown; stderr?: string; code?: number });

/**
 * The command as a test names it: the binary and its arguments, without the
 * flags the kubectl runner adds to every call (the request timeout, the
 * cluster flags and the trailing `-o json`).
 */
export function keyOf(bin: string, args: string[]): string {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--request-timeout=")) continue;
    if (a === "--kubeconfig" || a === "--context") {
      i++;
      continue;
    }
    rest.push(a);
  }
  if (rest.at(-2) === "-o" && rest.at(-1) === "json") rest.splice(-2);
  return [bin, ...rest].join(" ");
}

/**
 * A swamp method context with the stub spawn installed, and what the method
 * wrote and logged. Declare it with `using`: the real spawn is put back when
 * the test ends.
 */
export function harness(
  routes: Record<string, Reply>,
  opts: {
    globalArgs?: Record<string, unknown>;
    storedResources?: Record<string, Record<string, unknown>>;
    http?: Record<string, HttpReply>;
  } = {},
) {
  const calls: Call[] = [];
  const requests: HttpCall[] = [];
  const realFetch = globalThis.fetch;
  globalThis.fetch = (input: RequestInfo | URL, init?: RequestInit) => {
    const url = input instanceof Request ? input.url : String(input);
    const req = {
      key: `${init?.method ?? "GET"} ${url}`,
      body: init?.body === undefined || init.body === null
        ? ""
        : String(init.body),
    };
    requests.push(req);
    const r = opts.http?.[req.key];
    if (r === undefined) {
      return Promise.reject(
        new TypeError(`the stub has no answer for ${req.key}`),
      );
    }
    const a = typeof r === "function" ? r(req) : r;
    return Promise.resolve(
      new Response(
        a.body === undefined
          ? null
          : typeof a.body === "string"
          ? a.body
          : JSON.stringify(a.body),
        { status: a.status },
      ),
    );
  };
  __setSpawn((bin: string, args: string[], o: SpawnOptions) => {
    const key = keyOf(bin, args);
    const call = { key, args, stdin: o.stdin };
    calls.push(call);
    const r = routes[key];
    if (r === undefined) {
      return Promise.reject(new Error(`the stub has no answer for ${key}`));
    }
    const a = typeof r === "function" ? r(call) : r;
    const out = a.stdout === undefined
      ? ""
      : typeof a.stdout === "string"
      ? a.stdout
      : JSON.stringify(a.stdout);
    return Promise.resolve({
      code: a.code ?? 0,
      stdout: new TextEncoder().encode(out),
      stderr: a.stderr ?? "",
    });
  });
  const t = createModelTestContext({
    globalArgs: opts.globalArgs ?? { namespace: "" },
    storedResources: opts.storedResources ?? {},
  });
  return {
    // deno-lint-ignore no-explicit-any
    context: t.context as any,
    calls,
    requests,
    written: () =>
      t.getWrittenResources().map((w) => ({
        spec: w.specName,
        name: w.name,
        data: w.data as Record<string, unknown>,
      })),
    logs: () =>
      t.getLogs().map((l) => {
        const values = (l.args?.[0] ?? {}) as Record<string, unknown>;
        return l.message.replace(
          /\{(\w+)\}/g,
          (m, k: string) => k in values ? String(values[k]) : m,
        );
      }),
    [Symbol.dispose]: () => {
      __setSpawn();
      globalThis.fetch = realFetch;
    },
  };
}

/** What kubectl prints on standard error for a missing object. */
export function notFound(resource: string, name: string) {
  return {
    code: 1,
    stderr: `Error from server (NotFound): ${resource} "${name}" not found`,
  };
}
