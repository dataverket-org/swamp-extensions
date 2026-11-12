import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { harness, notFound } from "./stub_test.ts";
import { GlobalArgsSchema, jwtClaims, model } from "./token_exchange.ts";

function b64url(s: string): string {
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

/** A JWT with these claims; the signature is not read. */
function jwt(claims: Record<string, unknown>): string {
  return `${b64url("{}")}.${
    b64url(
      String.fromCharCode(...new TextEncoder().encode(JSON.stringify(claims))),
    )
  }.sig`;
}

Deno.test("claims are read from an unpadded base64url payload", () => {
  const payload = { sub: "trust/x", roles: ["ldap/Registry-Push"], n: "ü?>" };
  assertEquals(jwtClaims(jwt(payload)), payload);
});

Deno.test("the method that changes something says so", () => {
  assertEquals(model.methods.test.kind, "action");
});

// ───── the method, through createModelTestContext with a stub spawn ─────

const M = model.methods;
const G = GlobalArgsSchema.parse({
  issuerUrl: "http://salmon.test/issuer",
  kubeContext: "kind-e2e",
  namespace: "ci",
  serviceAccount: "pusher",
  trustId: "trust-1",
  requestAudience: "app-1",
});
const DISCOVERY =
  "GET http://salmon.test/issuer/.well-known/openid-configuration";
const ENDPOINT = "http://salmon.test/issuer/token";
const GET_SA = "kubectl get serviceaccount pusher -n ci";
const MINT =
  "kubectl create token pusher -n ci --duration=10m --audience=http://salmon.test/issuer/";
const SUBJECT_TOKEN = jwt({ sub: "system:serviceaccount:ci:pusher" });
const discovery = { status: 200, body: { token_endpoint: ENDPOINT } };

Deno.test("test exchanges a minted ServiceAccount token and records the issued token's subject and roles, never a token", async () => {
  const issued = jwt({ sub: "trust/trust-1", roles: ["users/Registry-Push"] });
  using h = harness({
    [GET_SA]: { stdout: { kind: "ServiceAccount" } },
    [MINT]: { stdout: `${SUBJECT_TOKEN}\n` },
  }, {
    globalArgs: G,
    http: {
      [DISCOVERY]: discovery,
      [`POST ${ENDPOINT}`]: {
        status: 200,
        body: {
          access_token: issued,
          token_type: "Bearer",
          issued_token_type: "urn:ietf:params:oauth:token-type:access_token",
          expires_in: 300,
          scope: "openid",
        },
      },
    },
  });
  await M.test.execute({}, h.context);
  const sent = new URLSearchParams(h.requests[1].body);
  assertEquals(
    [sent.get("subject_token"), sent.get("client_id"), sent.get("audience")],
    [SUBJECT_TOKEN, "trust-1", "app-1"],
  );
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [["result", "result"]]);
  assertEquals(
    [
      w[0].data.passed,
      w[0].data.httpStatus,
      w[0].data.tokenSubject,
      w[0].data.roles,
      w[0].data.expiresIn,
      w[0].data.error,
    ],
    [true, 200, "trust/trust-1", ["users/Registry-Push"], 300, ""],
  );
  assertEquals(
    h.logs().at(-1),
    "Salmon issued a token for trust/trust-1 with roles users/Registry-Push",
  );
  const all = JSON.stringify([w, h.logs()]);
  assertEquals([all.includes(issued), all.includes(SUBJECT_TOKEN)], [
    false,
    false,
  ]);
});

Deno.test("test creates a missing ServiceAccount before it mints the token", async () => {
  using h = harness({
    [GET_SA]: notFound("serviceaccounts", "pusher"),
    "kubectl create serviceaccount pusher -n ci": { stdout: "created" },
    [MINT]: { stdout: SUBJECT_TOKEN },
  }, {
    globalArgs: G,
    http: {
      [DISCOVERY]: discovery,
      [`POST ${ENDPOINT}`]: {
        status: 200,
        body: { access_token: jwt({ sub: "s", roles: [] }) },
      },
    },
  });
  await M.test.execute({}, h.context);
  assertEquals(h.calls.map((c) => c.key), [
    GET_SA,
    "kubectl create serviceaccount pusher -n ci",
    MINT,
  ]);
  assertEquals(h.logs()[0], "Creating service account pusher");
  assertEquals(h.written()[0].data.passed, true);
});

Deno.test("test: a refused exchange is recorded as not passed and fails, without the subject token Salmon repeats", async () => {
  using h = harness({
    [GET_SA]: { stdout: { kind: "ServiceAccount" } },
    [MINT]: { stdout: SUBJECT_TOKEN },
  }, {
    globalArgs: G,
    http: {
      [DISCOVERY]: discovery,
      [`POST ${ENDPOINT}`]: {
        status: 400,
        body: {
          error: "invalid_grant",
          error_description: `no trust matches ${SUBJECT_TOKEN}`,
        },
      },
    },
  });
  const err = await assertRejects(() => M.test.execute({}, h.context));
  assertStringIncludes(
    String(err),
    "token exchange failed (HTTP 400) for trust trust-1: invalid_grant: no trust matches",
  );
  const w = h.written();
  assertEquals([w[0].data.passed, w[0].data.httpStatus], [false, 400]);
  assertStringIncludes(String(w[0].data.error), "invalid_grant");
  assertEquals(
    JSON.stringify([w, h.logs(), String(err)]).includes(SUBJECT_TOKEN),
    false,
  );
});

Deno.test("test: an issuer that does not answer fails before the cluster is asked, and records nothing", async () => {
  using h = harness({}, {
    globalArgs: G,
    http: { [DISCOVERY]: { status: 503, body: "starting" } },
  });
  await assertRejects(
    () => M.test.execute({}, h.context),
    Error,
    `GET http://salmon.test/issuer/.well-known/openid-configuration returned 503`,
  );
  assertEquals([h.calls, h.written()], [[], []]);
});
