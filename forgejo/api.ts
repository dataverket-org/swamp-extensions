/**
 * The Forgejo REST transport these extensions share: a `fetch` caller
 * authenticated with a `@dataverket/forgejo` model's token, and a `call` wrapper
 * that turns any 3xx/4xx/5xx into an error carrying Forgejo's own message. A
 * redirect is never followed: Forgejo answers a renamed repository's old name
 * with a 301 to the new one, and following it would read, patch or delete the
 * renamed repository under a name nobody asked for. Kept
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

/** The 3xx statuses that carry a Location; 304 is not one of them. */
export function isRedirect(status: number): boolean {
  return status >= 300 && status < 400 && status !== 304;
}

/**
 * What a redirect answer becomes: a message naming where it points. A
 * repository path is the forge's rename (or transfer) redirect; anything else
 * is an `apiUrl` that is not where the forge answers, a proxy sending http to
 * https or to a login page, say. The token is masked in the Location.
 */
export function redirectMessage(
  path: string,
  location: string | null,
  token: string,
): string {
  const where = redactToken(location || "(no Location given)", token);
  const repo = path.match(/^\/api\/v1\/repos\/([^/?]+)\/([^/?]+)/);
  if (repo) {
    return `${decodeURIComponent(repo[1])}/${
      decodeURIComponent(repo[2])
    } was renamed; it now redirects to ${where}`;
  }
  return `the forge redirects ${path.split("?")[0]} to ${where}; ` +
    "apiUrl must be the address the forge answers on, redirects are not followed";
}

/**
 * A request that got no answer, as an error naming the method and the URL it
 * went to, and the transport's own reason: `fetch failed` alone names nothing,
 * so the cause (`connect ECONNREFUSED 127.0.0.1:3000`, say) goes with it. An
 * abort is passed through as it is, so a timeout stays a timeout.
 */
export function unreachable(
  method: string,
  url: string,
  err: unknown,
  token: string,
): unknown {
  if (err instanceof DOMException && err.name === "AbortError") return err;
  if (!(err instanceof Error)) return err;
  const cause = err.cause instanceof Error ? `: ${err.cause.message}` : "";
  return new Error(
    redactToken(
      `Forgejo API ${method} ${url} could not be reached: ${err.message}${cause}`,
      token,
    ),
    { cause: err },
  );
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
    const url = `${g.apiUrl.replace(/\/+$/, "")}${c.path}`;
    try {
      let res: Response;
      try {
        res = await fetch(url, {
          method: c.method,
          headers,
          body,
          signal: ctrl.signal,
          redirect: "manual",
        });
      } catch (err) {
        throw unreachable(c.method, url, err, g.token);
      }
      if (isRedirect(res.status)) {
        await res.body?.cancel();
        return {
          status: res.status,
          body: {
            message: redirectMessage(
              c.path,
              res.headers.get("location"),
              g.token,
            ),
          },
        };
      }
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

/**
 * A method's context as far as the client goes. `forgejoClient` is the
 * injectable client of swamp's testing guide: a unit test puts a stub there
 * and the method talks to it instead of the forge. swamp never sets it, so a
 * real run always gets {@link fetchCaller}.
 */
export interface ClientContext {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  forgejoClient?: Caller;
}

/** The client a method uses: the injected one in a unit test, else the forge. */
export function callerOf(context: ClientContext): Caller {
  return context.forgejoClient ??
    fetchCaller(context.globalArgs, context.signal);
}

/** Whether a status is a refusal: a 3xx (never followed), a 4xx or a 5xx. */
export function isFailure(status: number): boolean {
  return status >= 300;
}

/** The error a refused call becomes, with Forgejo's own message. */
export function failure(c: ApiCall, r: ApiResult): Error {
  const b = r.body;
  const msg = typeof b.message === "string"
    ? b.message
    : typeof b.raw === "string"
    ? b.raw
    : JSON.stringify(b);
  return new Error(
    `Forgejo API ${c.method} ${c.path} -> HTTP ${r.status}: ${msg}`,
  );
}

/** Perform a call and throw on any 3xx/4xx/5xx with Forgejo's message. */
export async function call(api: Caller, c: ApiCall): Promise<ApiResult> {
  const r = await api(c);
  if (isFailure(r.status)) throw failure(c, r);
  return r;
}

/**
 * Strip credentials from a clone or remote address, and case, trailing
 * slashes and a trailing `.git` with them, so an address Forgejo reports
 * (never with the secret) compares equal to the one requested, and
 * `.../repo` and `.../repo.git` are one remote, as every git host serves them.
 */
export function canonicalAddress(address: string): string {
  let s: string;
  try {
    const u = new URL(address);
    u.username = "";
    u.password = "";
    s = u.toString();
  } catch {
    s = address.trim();
  }
  return s.replace(/\/+$/, "").replace(/\.git$/i, "").replace(/\/+$/, "")
    .toLowerCase();
}

/**
 * Whether a repository is what Forgejo leaves when a pull mirror's migration
 * fails: marked a mirror, empty, and never synced (Go's zero time, or no time
 * at all). It cannot be converged, the forge answers a patch of its interval
 * with "Mirror does not exist", and it never syncs; it has to be deleted.
 */
export function isFailedMigration(r: Record<string, unknown>): boolean {
  const synced = r.mirror_updated;
  return r.mirror === true && r.empty === true &&
    (synced == null || String(synced).startsWith("0001-01-01"));
}

/** The refusal of a failed migration's leftover, for both mirror methods. */
export function failedMigrationError(owner: string, name: string): Error {
  return new Error(
    `${owner}/${name} is a pull mirror whose migration failed: it is empty and has never synced. ` +
      "Delete it (repo_delete) and run again; it cannot be converged in place.",
  );
}
