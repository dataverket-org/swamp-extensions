/**
 * The Forgejo REST transport these extensions share: a `fetch` caller
 * authenticated with a `@thomas/forgejo` model's token, and a `call` wrapper
 * that turns any 4xx/5xx into an error carrying Forgejo's own message. Kept
 * apart from the feature modules so each one imports the transport and not
 * another feature.
 *
 * @module
 */

/** One REST request against `apiUrl`. */
export interface ApiCall {
  method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE";
  path: string;
  body?: unknown;
}

/** Status plus parsed JSON body (`{}` when empty). */
export interface ApiResult {
  status: number;
  body: Record<string, unknown>;
}

/** The authenticated-call seam; swapped for a fake in tests. */
export type Caller = (call: ApiCall) => Promise<ApiResult>;

/** The @thomas/forgejo global arguments this extension reads. */
export interface GlobalArgs {
  apiUrl: string;
  token: string;
  httpTimeoutMs?: number;
}

/** A {@link Caller} over `fetch` against `apiUrl`, authenticated with the token. */
export function fetchCaller(g: GlobalArgs, signal?: AbortSignal): Caller {
  return async (c) => {
    const headers: Record<string, string> = {
      authorization: `token ${g.token}`,
      accept: "application/json",
    };
    let body: string | undefined;
    if (c.body !== undefined) {
      headers["content-type"] = "application/json";
      body = JSON.stringify(c.body);
    }
    const ctrl = new AbortController();
    const abort = () => ctrl.abort();
    signal?.addEventListener("abort", abort);
    const timer = setTimeout(abort, g.httpTimeoutMs ?? 30000);
    try {
      const res = await fetch(`${g.apiUrl.replace(/\/+$/, "")}${c.path}`, {
        method: c.method,
        headers,
        body,
        signal: ctrl.signal,
      });
      const text = await res.text();
      let parsed: Record<string, unknown> = {};
      if (text) {
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = { raw: text };
        }
      }
      return { status: res.status, body: parsed };
    } finally {
      clearTimeout(timer);
      signal?.removeEventListener("abort", abort);
    }
  };
}

/** Perform a call and throw on any 4xx/5xx with Forgejo's message. */
export async function call(api: Caller, c: ApiCall): Promise<ApiResult> {
  const r = await api(c);
  if (r.status >= 400) {
    const b = r.body;
    const msg = typeof b.message === "string"
      ? b.message
      : typeof b.raw === "string"
      ? b.raw
      : JSON.stringify(b);
    throw new Error(
      `Forgejo API ${c.method} ${c.path} -> HTTP ${r.status}: ${msg}`,
    );
  }
  return r;
}
