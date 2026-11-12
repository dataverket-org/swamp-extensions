/**
 * The method tests' stub, in the pattern of swamp's testing guide: a method's
 * `execute` runs through `createModelTestContext` with a stub standing in for
 * `fetch`, the one call both Octokit (`github.ts`) and the {@link Caller} of
 * `repo_settings.ts` make. Each test lists the few answers it needs, keyed
 * `"METHOD /path?query"`; a request it did not list is an error, so a test
 * cannot pass on a request it never meant to make. The stub is not a model of
 * GitHub; the extension's own runs against GitHub are the proof.
 *
 * @module
 */
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";

/** A marker planted as the token; no record or log may carry it. */
export const PLANTED = "ghp_PLANTEDtoken0123456789abcdef";

/** Global arguments for a method test; the token is {@link PLANTED}. */
export const G = {
  token: PLANTED,
  owner: "acme",
  isOrg: false,
  baseUrl: "https://api.github.test",
};

/** One answer: a status and a JSON body. */
export interface Reply {
  status: number;
  body?: unknown;
}

/** One request the stub saw. */
export interface Seen {
  method: string;
  path: string;
  body: unknown;
  authorization: string | null;
}

/**
 * Run `fn` with `fetch` answering exactly `routes`, and give back what the
 * method wrote and logged and the requests it made. `fetch` is put back
 * afterwards whatever happens.
 */
export async function withStub(
  routes: Record<string, Reply>,
  fn: (context: never) => Promise<unknown>,
  globalArgs: Record<string, unknown> = {},
) {
  const seen: Seen[] = [];
  const t = createModelTestContext({ globalArgs: { ...G, ...globalArgs } });
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request, init?: RequestInit) => {
    const url = new URL(input instanceof Request ? input.url : String(input));
    const method = (init?.method ?? "GET").toUpperCase();
    const key = `${method} ${url.pathname}${url.search}`;
    const headers = new Headers(init?.headers);
    seen.push({
      method,
      path: `${url.pathname}${url.search}`,
      body: init?.body ? JSON.parse(String(init.body)) : undefined,
      authorization: headers.get("authorization"),
    });
    const reply = routes[key];
    if (!reply) {
      return Promise.reject(new Error(`the stub has no answer for ${key}`));
    }
    return Promise.resolve(
      new Response(
        reply.body === undefined ? null : JSON.stringify(reply.body),
        {
          status: reply.status,
          headers: { "content-type": "application/json; charset=utf-8" },
        },
      ),
    );
  };
  let error: unknown;
  try {
    await fn(t.context as never);
  } catch (err) {
    error = err;
  } finally {
    globalThis.fetch = original;
  }
  const written = t.getWrittenResources().map((w) => ({
    spec: w.specName,
    name: w.name,
    data: w.data as Record<string, unknown>,
  }));
  const logs = t.getLogs().map((l) =>
    `${l.level}: ${l.message} ${JSON.stringify(l.args ?? [])}`
  );
  return { error, seen, written, logs };
}

/** Throw when the planted token reached a record, a log or an error. */
export function assertNoPlanted(
  r: { written: unknown; logs: string[]; error?: unknown },
): void {
  const text = JSON.stringify(r.written) + r.logs.join("\n") +
    (r.error instanceof Error ? r.error.message : "");
  if (text.includes(PLANTED)) {
    throw new Error("the planted token reached a record, a log or an error");
  }
}
