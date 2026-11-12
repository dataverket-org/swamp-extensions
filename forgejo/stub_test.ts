/**
 * The unit tests' client stub, in the pattern of swamp's testing guide: a
 * method runs through `createModelTestContext` with a stub client injected as
 * `forgejoClient`. Each test lists the few answers it needs, as
 * `"METHOD path"`; a call it did not list is an error, so a test cannot pass
 * on a call it never meant to make. The live suite in `smoke/` is the proof
 * against a real forge; these tests pin what a method writes and refuses.
 *
 * @module
 */
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import type { ApiCall, ApiResult, Caller } from "./api.ts";

/** Global arguments for a test; the token is a marker tests look for. */
export const G = {
  apiUrl: "https://forge.example.com",
  token: "TEST-TOKEN-0123456789",
  httpTimeoutMs: 1000,
};

/** One answer: a status and a body, or a function of the call. */
export type Reply =
  | { status: number; body?: unknown }
  | ((c: ApiCall) => ApiResult);

/** A stub client answering exactly the calls listed. */
export function stub(routes: Record<string, Reply>): {
  api: Caller;
  calls: ApiCall[];
} {
  const calls: ApiCall[] = [];
  const api: Caller = (c) => {
    calls.push(c);
    const r = routes[`${c.method} ${c.path}`];
    if (r === undefined) {
      return Promise.reject(
        new Error(`the stub has no answer for ${c.method} ${c.path}`),
      );
    }
    if (typeof r === "function") return Promise.resolve(r(c));
    return Promise.resolve({
      status: r.status,
      body: (r.body ?? {}) as Record<string, unknown>,
    });
  };
  return { api, calls };
}

/**
 * A swamp method context with the stub injected, and what the method wrote.
 * `globalArgs` defaults to {@link G}; `extra` adds context fields a method
 * reads (readModelData, say).
 */
export function harness(
  routes: Record<string, Reply>,
  opts: {
    globalArgs?: Record<string, unknown>;
    storedResources?: Record<string, Record<string, unknown>>;
    extra?: Record<string, unknown>;
  } = {},
) {
  const s = stub(routes);
  const t = createModelTestContext({
    globalArgs: opts.globalArgs ?? G,
    storedResources: opts.storedResources ?? {},
  });
  const context = {
    ...t.context,
    ...(opts.extra ?? {}),
    forgejoClient: s.api,
  };
  return {
    // deno-lint-ignore no-explicit-any
    context: context as any,
    calls: s.calls,
    written: () =>
      t.getWrittenResources().map((w) => ({
        spec: w.specName,
        name: w.name,
        data: w.data as Record<string, unknown>,
      })),
    logs: () => t.getLogs(),
  };
}

/** The writes among the calls. */
export const writes = (calls: ApiCall[]) =>
  calls.filter((c) => c.method !== "GET");
