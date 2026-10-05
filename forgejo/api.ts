/**
 * The Forgejo REST transport these extensions share: a `fetch` caller
 * authenticated with a `@dataverket/forgejo` model's token, and a `call` wrapper
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

/** The `@dataverket/forgejo` global arguments these modules read. */
export interface GlobalArgs {
  apiUrl: string;
  token: string;
  httpTimeoutMs?: number;
}

/**
 * Mask the token wherever the forge echoes it back. Forgejo answers a bad
 * credential with `access token does not exist [sha: <the token>]`, so the
 * value arrives inside the response body and would otherwise reach an error
 * message, a check's output and the log. Masking here covers every caller,
 * because this is the one place a response becomes data.
 */
/** Below this length a "token" is not a credential, and masking it corrupts text. */
const MIN_REDACTABLE = 8;

export function redactToken(text: string, token: string): string {
  // Short enough to be a substring of ordinary prose is short enough to
  // mangle it: a token of "t" would turn "Not Found" into "No[REDACTED] Found".
  // Nothing that short is a real credential, so leave it alone.
  if (!token || token.length < MIN_REDACTABLE) return text;
  return text.split(token).join("[REDACTED]");
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
          parsed = JSON.parse(redactToken(text, g.token));
        } catch {
          parsed = { raw: redactToken(text, g.token) };
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

/**
 * Strip credentials from a clone or remote address, and case and trailing
 * slashes with them, so an address Forgejo reports (never with the secret)
 * compares equal to the one requested.
 */
export function canonicalAddress(address: string): string {
  try {
    const u = new URL(address);
    u.username = "";
    u.password = "";
    return u.toString().replace(/\/+$/, "").toLowerCase();
  } catch {
    return address.trim().toLowerCase();
  }
}
