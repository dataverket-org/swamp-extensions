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
import { z } from "npm:zod@4";
import { exec, type MethodContext, run } from "./common.ts";

/** The check's arguments. */
export const GlobalArgsSchema = z.object({
  issuerUrl: z.string().url().default("http://localhost:8080/issuer").describe(
    "Salmon issuer URL; the token endpoint is read from its discovery document",
  ),
  kubeContext: z.string().min(1).describe(
    "kubeconfig context of the cluster that mints the subject token",
  ),
  namespace: z.string().default("default"),
  serviceAccount: z.string().default("salmon-token-exchange-test"),
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
  tokenDuration: z.string().default("10m"),
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
  tokenSubject: z.string(),
  roles: z.array(z.string()),
  testedAt: z.iso.datetime(),
});

type Context = MethodContext<GlobalArgs>;

function kubectl(args: string[], ctx: Context) {
  const g = ctx.globalArgs;
  return exec(
    g.kubectlBinary,
    ["--context", g.kubeContext, "-n", g.namespace, ...args],
    { signal: ctx.signal },
  );
}

function mustKubectl(args: string[], ctx: Context): Promise<string> {
  const g = ctx.globalArgs;
  return run(
    g.kubectlBinary,
    ["--context", g.kubeContext, "-n", g.namespace, ...args],
    { signal: ctx.signal },
  );
}

async function tokenEndpoint(ctx: Context): Promise<string> {
  const issuer = ctx.globalArgs.issuerUrl.replace(/\/+$/, "");
  const url = `${issuer}/.well-known/openid-configuration`;
  let res: Response;
  try {
    res = await fetch(url, { signal: ctx.signal });
  } catch (err) {
    throw new Error(
      `Salmon issuer is not reachable at ${url} (start a @dataverket/salmon/stack): ${
        (err as Error).message
      }`,
    );
  }
  if (!res.ok) {
    await res.body?.cancel();
    throw new Error(`GET ${url} returned ${res.status}`);
  }
  const doc = await res.json() as { token_endpoint?: string };
  return doc.token_endpoint ?? `${issuer}/token`;
}

/** Decodes a JWT's payload without verifying it. */
export function jwtClaims(jwt: string): Record<string, unknown> {
  const b64 = jwt.split(".")[1].replace(/-/g, "+").replace(/_/g, "/");
  const bytes = Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  return JSON.parse(new TextDecoder().decode(bytes));
}

async function ensureServiceAccount(ctx: Context): Promise<void> {
  const sa = ctx.globalArgs.serviceAccount;
  const res = await kubectl(["get", "serviceaccount", sa], ctx);
  if (res.code === 0) return;
  if (!res.stderr.includes("NotFound")) {
    throw new Error(`kubectl get serviceaccount ${sa}: ${res.stderr.trim()}`);
  }
  ctx.logger.info("Creating service account {sa}", { sa });
  await mustKubectl(["create", "serviceaccount", sa], ctx);
}

/** Model definition for the Salmon token-exchange check. */
export const model = {
  type: "@dataverket/salmon/token-exchange",
  version: "2026.10.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "result": {
      description: "Outcome of the last successful token exchange",
      schema: ResultSchema,
      lifetime: "infinite",
      garbageCollection: 20,
    },
  },
  methods: {
    test: {
      description:
        "Exchange a ServiceAccount token for a Salmon access token and fail unless one is issued",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const g = ctx.globalArgs;
        const endpoint = await tokenEndpoint(ctx);
        const audience = g.audience ??
          `${g.issuerUrl.replace(/\/+$/, "")}/`;

        await ensureServiceAccount(ctx);
        const subjectToken = (await mustKubectl([
          "create",
          "token",
          g.serviceAccount,
          `--duration=${g.tokenDuration}`,
          "--audience",
          audience,
        ], ctx)).trim();

        const subject =
          `system:serviceaccount:${g.namespace}:${g.serviceAccount}`;
        ctx.logger.info("Exchanging token for {subject} at {endpoint}", {
          subject,
          endpoint,
        });

        const res = await fetch(endpoint, {
          method: "POST",
          signal: ctx.signal,
          headers: { "Content-Type": "application/x-www-form-urlencoded" },
          body: new URLSearchParams({
            grant_type: "urn:ietf:params:oauth:grant-type:token-exchange",
            subject_token: subjectToken,
            subject_token_type: "urn:ietf:params:oauth:token-type:jwt",
            client_id: g.trustId,
            scope: g.scope,
            ...(g.requestAudience ? { audience: g.requestAudience } : {}),
          }),
        });
        const text = await res.text();
        let body: Record<string, unknown> = {};
        try {
          body = JSON.parse(text);
        } catch {
          // fall through: reported below with the raw body
        }

        if (!res.ok || typeof body.access_token !== "string") {
          const reason = body.error
            ? `${body.error}: ${body.error_description ?? ""}`.trim()
            : text.slice(0, 500);
          throw new Error(
            `token exchange failed (HTTP ${res.status}) for trust ${g.trustId}: ${reason}`,
          );
        }

        // Only the claims are kept; the token itself is never stored.
        const claims = jwtClaims(body.access_token);
        const handle = await ctx.writeResource("result", "result", {
          passed: true,
          tokenEndpoint: endpoint,
          trustId: g.trustId,
          subject,
          tokenType: String(body.token_type ?? ""),
          issuedTokenType: String(body.issued_token_type ?? ""),
          expiresIn: Number(body.expires_in ?? 0),
          scope: String(body.scope ?? ""),
          tokenSubject: String(claims.sub ?? ""),
          roles: Array.isArray(claims.roles) ? claims.roles.map(String) : [],
          testedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
