/**
 * Pre-flight checks for `@thomas/forgejo`. The methods in this package
 * create secrets, rename repositories and delete mirrors and repositories,
 * and until one of them runs there is nothing that says the token still
 * works or that `apiUrl` points where the author meant.
 *
 * Two checks, so either can be skipped on its own: a shape check on the URL
 * that needs no network, and a live call that proves the token is still
 * accepted. Neither writes anything, and neither puts the token in its
 * output.
 *
 * A check receives the definition's global arguments as written, with none
 * of the schema's defaults applied, so `httpTimeoutMs` is undefined here
 * even though the schema gives it 30000. `fetchCaller` supplies that
 * fallback itself, which is why a check can use it unchanged.
 *
 * @module
 */
import { call, fetchCaller, type GlobalArgs } from "./api.ts";

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

/** Adds the pre-flight checks to `@thomas/forgejo`. */
export const extension = {
  type: "@thomas/forgejo",
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
        "The forge answers and the token is still accepted, reported as the login it belongs to",
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
          const r = await call(
            fetchCaller(context.globalArgs, context.signal),
            { method: "GET", path: "/api/v1/user" },
          );
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
