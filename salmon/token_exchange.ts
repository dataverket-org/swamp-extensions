/**
 * `@dataverket/salmon/token-exchange` — an end-to-end check of Salmon's
 * RFC 8693 token-exchange grant.
 *
 * `test` mints a bound Kubernetes ServiceAccount token from a cluster, POSTs
 * it to Salmon's token endpoint as a `subject_token` and passes only when an
 * `access_token` comes back. The issued token itself is never stored.
 *
 * Requires the Salmon server to be running and a trust matching the
 * ServiceAccount to exist; its id is the client_id. With `requestAudience` it
 * asks for a token for that app and records the token's sub and roles claims.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { brief, valueArg } from "../lib/cli.ts";
import {
  checkName,
  checkNamespace,
  getArgs,
  isKubectlError,
  kubectlCheck,
  type KubectlOpts,
  NAMESPACE_NAME,
  OBJECT_NAME,
  runKubectl,
  runKubectlText,
} from "../lib/kubectl.ts";
import {
  FETCH_LIMITS,
  fetchWithin,
  type MethodContext,
  NO_USERINFO,
  withoutUserinfo,
} from "./common.ts";

/** The check's arguments. */
export const GlobalArgsSchema = z.object({
  issuerUrl: z.string().url().default("http://localhost:8080/issuer").refine(
    withoutUserinfo,
    { message: `issuerUrl ${NO_USERINFO}` },
  ).describe(
    "Salmon issuer URL; the token endpoint is read from its discovery document",
  ),
  kubeContext: z.string().min(1).describe(
    "kubeconfig context of the cluster that mints the subject token",
  ),
  kubeconfig: z.string().min(1).optional().describe(
    "Path to a kubeconfig file. Defaults to KUBECONFIG or ~/.kube/config",
  ),
  namespace: z.string().regex(
    NAMESPACE_NAME,
    "namespace must be a Kubernetes namespace name",
  ).default("default").describe("Namespace of the ServiceAccount"),
  serviceAccount: z.string().regex(
    OBJECT_NAME,
    "serviceAccount must be a Kubernetes object name",
  ).default("salmon-token-exchange-test").describe(
    "ServiceAccount whose token is exchanged; created when missing and then kept",
  ),
  trustId: z.string().min(1).describe(
    "Salmon trust id, sent as client_id",
  ),
  requestAudience: z.string().optional().describe(
    "App id sent as the RFC 8693 audience; its roles are recorded",
  ),
  audience: z.string().optional().describe(
    "Audience of the minted ServiceAccount token (defaults to issuerUrl with a trailing slash)",
  ),
  scope: z.string().default("openid"),
  // A lifetime such as 10m, not a token.
  // swamp-quality-ignore credentials-sensitive-field
  tokenDuration: z.string().default("10m").describe(
    "Lifetime of the minted ServiceAccount token, as kubectl create token --duration takes it",
  ),
  kubectlBinary: z.string().default("kubectl"),
});

/** The check's arguments, parsed. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ResultSchema = z.object({
  passed: z.boolean(),
  tokenEndpoint: z.string(),
  trustId: z.string(),
  subject: z.string(),
  tokenType: z.string(),
  issuedTokenType: z.string(),
  expiresIn: z.number(),
  scope: z.string(),
  // The sub claim of the issued token, not the token.
  // swamp-quality-ignore credentials-sensitive-field
  tokenSubject: z.string(),
  roles: z.array(z.string()),
  httpStatus: z.number().describe("HTTP status of Salmon's answer"),
  error: z.string().describe(
    "Empty when the exchange passed; else why Salmon's answer did not pass, redacted",
  ),
  testedAt: z.iso.datetime(),
});

type Context = MethodContext<GlobalArgs>;

/** The cluster and binary of this check, as the kubectl layer takes them. */
function cluster(ctx: Context): KubectlOpts {
  const g = ctx.globalArgs;
  return {
    context: g.kubeContext,
    kubeconfig: g.kubeconfig,
    bin: g.kubectlBinary,
    signal: ctx.signal,
  };
}

/**
 * The token endpoint a discovery document names, or a named refusal. The
 * ServiceAccount token is posted there, so it must be an http or https URL
 * without a user or password. It need not share the issuer's origin: RFC
 * 8414 does not ask for that, and Salmon itself answers with the host of
 * its configured issuer whatever host it was asked on. The value is not
 * repeated in the refusal.
 */
export function checkedEndpoint(value: unknown, from: string): string {
  const refused = (why: string) =>
    new Error(`the discovery document at ${from} ${why}`);
  if (typeof value !== "string" || value === "") {
    throw refused("names no token_endpoint");
  }
  let url: URL;
  try {
    url = new URL(value);
  } catch {
    throw refused("names a token_endpoint that is not a URL");
  }
  if (
    !["http:", "https:"].includes(url.protocol) || !withoutUserinfo(value)
  ) {
    throw refused(
      "names a token_endpoint that is refused: it must be an http or https URL without a user or password",
    );
  }
  return value;
}

async function tokenEndpoint(ctx: Context): Promise<string> {
  const issuer = ctx.globalArgs.issuerUrl.replace(/\/+$/, "");
  const url = `${issuer}/.well-known/openid-configuration`;
  let res;
  try {
    res = await fetchWithin(url, {}, FETCH_LIMITS.discoveryMs, ctx.signal);
  } catch (err) {
    throw new Error(
      `Salmon issuer is not reachable at ${url} (start a @dataverket/salmon/stack): ${
        brief(err instanceof Error ? err.message : String(err))
      }`,
    );
  }
  if (!res.ok) throw new Error(`GET ${url} returned ${res.status}`);
  let doc: unknown;
  try {
    doc = JSON.parse(res.text);
  } catch {
    doc = undefined;
  }
  if (doc === null || typeof doc !== "object" || Array.isArray(doc)) {
    throw new Error(
      `GET ${url} did not return a discovery document (${res.text.length} characters that are not a JSON object)`,
    );
  }
  return checkedEndpoint((doc as Record<string, unknown>).token_endpoint, url);
}

/**
 * Decodes a JWT's payload without verifying it. What is not a JWT is a named
 * error that holds none of its text.
 */
export function jwtClaims(jwt: string): Record<string, unknown> {
  try {
    const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
    const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
    const claims = JSON.parse(new TextDecoder().decode(bytes));
    if (claims === null || typeof claims !== "object") throw new Error();
    return claims;
  } catch {
    throw new Error("the access_token Salmon issued is not a JWT");
  }
}

/** The ServiceAccount is there, created when the cluster does not hold it. */
async function ensureServiceAccount(
  ctx: Context,
  namespace: string,
  sa: string,
): Promise<void> {
  try {
    await runKubectl(getArgs("serviceaccount", sa, namespace), cluster(ctx));
    return;
  } catch (err) {
    if (!isKubectlError(err, "not-found")) throw err;
  }
  ctx.logger.info("Creating service account {sa}", { sa });
  try {
    await runKubectlText(
      ["create", "serviceaccount", sa, "-n", namespace],
      cluster(ctx),
    );
  } catch (err) {
    // Another run made it between the read and the create.
    if (!isKubectlError(err, "conflict")) throw err;
  }
}

/**
 * A bound token of the ServiceAccount. It is kubectl's standard output,
 * which the kubectl layer never copies into an error.
 */
async function mintToken(
  ctx: Context,
  namespace: string,
  sa: string,
  audience: string,
): Promise<string> {
  const g = ctx.globalArgs;
  const token = (await runKubectlText([
    "create",
    "token",
    sa,
    "-n",
    namespace,
    `--duration=${valueArg(g.tokenDuration, "tokenDuration")}`,
    `--audience=${valueArg(audience, "audience")}`,
  ], cluster(ctx))).trim();
  if (token === "") {
    throw new Error(`kubectl create token ${sa} printed no token`);
  }
  return token;
}

/** Model definition for the Salmon token-exchange check. */
export const model = {
  type: "@dataverket/salmon/token-exchange",
  version: "2026.11.10.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.10.1",
      description:
        "kubectl runs with a request timeout and a time limit; a namespace or serviceAccount that is not a Kubernetes name is refused before kubectl runs; kubeconfig, optional; a pre-flight check that kubectl runs; an issuerUrl with a user or password is refused; a refused exchange is recorded with passed false. The result record gains httpStatus and error",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  checks: {
    "kubectl-cli-available": kubectlCheck((g) =>
      String(g.kubectlBinary ?? "kubectl")
    ),
  },
  resources: {
    "result": {
      description:
        "Outcome of the last token exchange Salmon answered: passed with the token's subject and roles, or not passed with the reason",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    test: {
      kind: "action",
      description:
        "Exchange a ServiceAccount token for a Salmon access token, record the outcome, and fail unless one is issued",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const g = ctx.globalArgs;
        // Refused before anything is asked of Salmon or the cluster.
        if (!withoutUserinfo(g.issuerUrl)) {
          throw new Error(`issuerUrl ${NO_USERINFO}`);
        }
        const namespace = checkNamespace(g.namespace);
        const sa = checkName(g.serviceAccount, "serviceAccount");
        const endpoint = await tokenEndpoint(ctx);
        const audience = g.audience ??
          `${g.issuerUrl.replace(/\/+$/, "")}/`;

        await ensureServiceAccount(ctx, namespace, sa);
        const subjectToken = await mintToken(ctx, namespace, sa, audience);

        const subject =
          `system:serviceaccount:${g.namespace}:${g.serviceAccount}`;
        ctx.logger.info("Exchanging token for {subject} at {endpoint}", {
          subject,
          endpoint,
        });

        // Salmon answered and the answer does not pass: that is the result
        // this check exists to show, so it is recorded before the method
        // fails. A call that could not be made is only thrown.
        const record = (
          passed: boolean,
          httpStatus: number,
          error: string,
          body: Record<string, unknown> = {},
          claims: Record<string, unknown> = {},
        ) =>
          ctx.writeResource("result", "result", {
            passed,
            tokenEndpoint: endpoint,
            trustId: g.trustId,
            subject,
            tokenType: String(body.token_type ?? ""),
            issuedTokenType: String(body.issued_token_type ?? ""),
            expiresIn: Number(body.expires_in ?? 0) || 0,
            scope: String(body.scope ?? ""),
            tokenSubject: String(claims.sub ?? ""),
            roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
            httpStatus,
            error,
            testedAt: new Date().toISOString(),
          });

        let res;
        try {
          res = await fetchWithin(
            endpoint,
            {
              method: "POST",
              headers: { "Content-Type": "application/x-www-form-urlencoded" },
              body: new URLSearchParams({
                grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
                subject_token: subjectToken,
                subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
                client_id: g.trustId,
                scope: g.scope,
                ...(g.requestAudience ? { audience: g.requestAudience } : {}),
              }),
            },
            FETCH_LIMITS.exchangeMs,
            ctx.signal,
          );
        } catch (err) {
          throw new Error(
            `the token exchange could not be sent to ${endpoint}: ${
              brief(
                err instanceof Error ? err.message : String(err),
                400,
                [subjectToken],
              )
            }`,
          );
        }
        let body: Record<string, unknown> = {};
        try {
          const parsed: unknown = JSON.parse(res.text);
          if (
            parsed !== null && typeof parsed === "object" &&
            !Array.isArray(parsed)
          ) body = parsed as Record<string, unknown>;
        } catch {
          // Not JSON: reported below with the answer's text.
        }

        if (!res.ok || typeof body.access_token !== "string") {
          // Salmon's answer may repeat the token it was sent, or hold the
          // one it issued under a key this check did not expect.
          const reason = brief(
            body.error
              ? `${body.error}: ${body.error_description ?? ""}`
              : res.text,
            500,
            [subjectToken],
          ) || "(an empty answer)";
          await record(false, res.status, reason);
          throw new Error(
            `token exchange failed (HTTP ${res.status}) for trust ${g.trustId}: ${reason}`,
          );
        }

        // Only the claims are kept; the token itself is never stored.
        let claims: Record<string, unknown>;
        try {
          claims = jwtClaims(body.access_token);
        } catch (err) {
          await record(false, res.status, (err as Error).message);
          throw err;
        }
        ctx.logger.info("Salmon issued a token for {sub} with roles {roles}", {
          sub: String(claims.sub ?? ""),
          roles: Array.isArray(claims.roles) ? claims.roles.join(",") : "",
        });
        const handle = await record(true, res.status, "", body, claims);
        return { dataHandles: [handle] };
      },
    },
  },
};
