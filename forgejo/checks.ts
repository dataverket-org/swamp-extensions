/**
 * Pre-flight checks for `@dataverket/forgejo`. The methods in this package
 * create secrets, rename repositories and delete mirrors and repositories,
 * and until one of them runs there is nothing that says the token still
 * works or that `apiUrl` points where the author meant.
 *
 * Two checks, so either can be skipped on its own: a shape check on the URL
 * that needs no network, and a live call that proves the token is still
 * accepted. A token without read:user is accepted too: Forgejo refuses a
 * scope only after it has authenticated the token, so that 403 passes and a
 * 401 is the failure. Neither writes anything, and neither puts the token in
 * its output.
 *
 * A check receives the definition's global arguments as written, with none
 * of the schema's defaults applied, so `httpTimeoutMs` is undefined here
 * even though the schema gives it 30000. `fetchCaller` supplies that
 * fallback itself, which is why a check can use it unchanged.
 *
 * @module
 */
import { fetchCaller, type GlobalArgs } from "./api.ts";

/**
 * Forgejo's base URL, without the API path. The schema says "no trailing
 * /api/v1" because every path this package builds already starts with it;
 * a URL that includes it produces /api/v1/api/v1/... and a 404 that names
 * nothing useful.
 */
export function apiUrlProblem(apiUrl: string | undefined): string | undefined {
  if (!apiUrl || apiUrl.trim().length === 0) {
    return "globalArguments.apiUrl is not set";
  }
  let u: URL;
  try {
    u = new URL(apiUrl);
  } catch {
    return `apiUrl is not a URL: ${apiUrl}`;
  }
  if (u.protocol !== "http:" && u.protocol !== "https:") {
    return `apiUrl is not http(s): ${apiUrl}`;
  }
  if (/\/api(\/v1)?\/?$/.test(u.pathname)) {
    return `apiUrl should be the forge's base URL without /api/v1, got ${apiUrl}`;
  }
  return undefined;
}

/**
 * Whether a 403 is Forgejo refusing a scope rather than the token. Forgejo
 * checks the token before it checks scopes, so a body that names a required
 * scope ("token does not have at least one of required scope(s), required=
 * [read:user]") can only come back for a token it has already accepted. A
 * token the forge does not know gets a 401 instead. Narrow tokens are the
 * design here, `repo_list` says how to list without read:user, so a token
 * that cannot read its own user is still a working token.
 */
export function scopeRefusal(
  status: number,
  body: Record<string, unknown>,
): boolean {
  if (status !== 403) return false;
  const msg = typeof body.message === "string"
    ? body.message
    : typeof body.raw === "string"
    ? body.raw
    : "";
  return /scope/i.test(msg);
}

/** The pre-flight checks of `@dataverket/forgejo`. */
export const extension = {
  type: "@dataverket/forgejo",
  methods: [],
  checks: [{
    "forgejo-api-url-shape": {
      description:
        "apiUrl is the forge's base URL, http(s) and without a trailing /api/v1",
      labels: ["policy"],
      // deno-lint-ignore require-await
      execute: async (context: { globalArgs: GlobalArgs }) => {
        const problem = apiUrlProblem(context.globalArgs.apiUrl);
        return problem ? { pass: false, errors: [problem] } : { pass: true };
      },
    },
    "forgejo-token-accepted": {
      description:
        "The forge answers and the token is still accepted: it names the login, or refuses only a scope",
      labels: ["live"],
      execute: async (
        context: { globalArgs: GlobalArgs; signal?: AbortSignal },
      ) => {
        const shape = apiUrlProblem(context.globalArgs.apiUrl);
        // a bad URL is the other check's finding; do not repeat it as a 404
        if (shape) return { pass: true };
        if (!context.globalArgs.token) {
          return { pass: false, errors: ["globalArguments.token is not set"] };
        }
        try {
          const api = fetchCaller(context.globalArgs, context.signal);
          const r = await api({ method: "GET", path: "/api/v1/user" });
          // a scope refusal is proof of acceptance: see scopeRefusal
          if (scopeRefusal(r.status, r.body)) return { pass: true };
          if (r.status >= 400) {
            const b = r.body;
            const msg = typeof b.message === "string"
              ? b.message
              : typeof b.raw === "string"
              ? b.raw
              : JSON.stringify(b);
            return {
              pass: false,
              errors: [
                `Forgejo API GET /api/v1/user -> HTTP ${r.status}: ${msg}`,
              ],
            };
          }
          const login = typeof r.body.login === "string" ? r.body.login : "";
          if (!login) {
            return {
              pass: false,
              errors: ["the forge answered /api/v1/user without a login"],
            };
          }
          return { pass: true };
        } catch (err) {
          return {
            pass: false,
            errors: [err instanceof Error ? err.message : String(err)],
          };
        }
      },
    },
  }],
};
