import { assertEquals } from "jsr:@std/assert@1.0.13";
import { KubectlGlobalArgsSchema } from "../lib/kubectl.ts";
import {
  acmeSecrets,
  keyAuthorizations,
  NameSchema,
  NamespaceSchema,
  readIssuerRef,
  seal,
  StateInventorySchema,
  stateItem,
  StateItemSchema,
} from "./_helpers.ts";
import { model as certificate } from "./certificate.ts";
import { model as certificaterequest } from "./certificaterequest.ts";
import { model as challenge } from "./challenge.ts";
import { model as issuer } from "./issuer.ts";
import { model as order } from "./order.ts";
import {
  ACME_THUMBPRINT,
  ACME_TOKEN,
  HOSTILE,
  KEY_AUTHORIZATION,
  SECRETS,
  SELF_CHECK_REASON,
  SELF_CHECK_UNREACHABLE,
  selfCheckChallenge,
} from "./test_support.ts";

const MODELS = [certificate, certificaterequest, order, challenge, issuer];

Deno.test("the five types carry the package name and one version", () => {
  assertEquals(MODELS.map((m) => m.type), [
    "@dataverket/cert-manager/certificate",
    "@dataverket/cert-manager/certificaterequest",
    "@dataverket/cert-manager/order",
    "@dataverket/cert-manager/challenge",
    "@dataverket/cert-manager/issuer",
  ]);
  for (const m of MODELS) {
    assertEquals(m.version, "2026.11.10.1");
    assertEquals(Object.keys(m.checks), ["kubectl-cli-available"]);
  }
});

Deno.test("every type takes the shared global arguments and writes one inventory spec", () => {
  for (const m of MODELS) {
    assertEquals(m.globalArguments, KubectlGlobalArgsSchema);
    assertEquals(m.resources.inventory.schema, StateInventorySchema);
    assertEquals("listing" in m.resources, false);
  }
  assertEquals(KubectlGlobalArgsSchema.parse({}), { namespace: "" });
});

Deno.test("only renew changes anything, and it is an action, never a delete", () => {
  assertEquals(Object.keys(certificate.methods), [
    "list",
    "get",
    "trace",
    "renew",
  ]);
  assertEquals(certificate.methods.trace.kind, "read");
  assertEquals(certificate.methods.renew.kind, "action");
  for (const m of [certificaterequest, order, challenge, issuer]) {
    assertEquals(Object.keys(m.methods), ["list", "get"]);
  }
});

Deno.test("every resource spec has a lifetime and garbage collection", () => {
  for (const m of MODELS) {
    for (
      const spec of Object.values(
        m.resources as Record<
          string,
          { lifetime: string; garbageCollection: number }
        >,
      )
    ) {
      assertEquals(typeof spec.lifetime, "string");
      assertEquals(spec.garbageCollection > 0, true);
    }
  }
});

Deno.test("the name argument accepts Kubernetes names and refuses everything else", () => {
  for (
    const ok of ["a", "leaf", "a.b-c", "0", "web-1-861441386", "a".repeat(253)]
  ) {
    assertEquals(NameSchema.safeParse(ok).success, true);
  }
  for (const bad of [...HOSTILE, undefined, null, 7, {}, ["a"]]) {
    assertEquals(NameSchema.safeParse(bad).success, false, String(bad));
  }
});

Deno.test("the namespace argument is a DNS label; empty means not given", () => {
  for (const ok of ["", "a", "kube-system", "0", "a".repeat(63)]) {
    assertEquals(NamespaceSchema.safeParse(ok).success, true, ok);
  }
  for (
    const bad of [
      ...HOSTILE.filter((b) => b !== ""),
      "a.b",
      "a".repeat(64),
      "a\n",
      "\na",
      undefined,
      null,
      7,
    ]
  ) {
    assertEquals(NamespaceSchema.safeParse(bad).success, false, String(bad));
  }
});

Deno.test("readIssuerRef fills cert-manager's defaults", () => {
  assertEquals(readIssuerRef({ name: "ca" }), {
    name: "ca",
    kind: "Issuer",
    group: "cert-manager.io",
  });
  assertEquals(readIssuerRef(null), {
    name: "",
    kind: "Issuer",
    group: "cert-manager.io",
  });
  assertEquals(
    readIssuerRef({
      name: "x",
      kind: "AWSPCAIssuer",
      group: "awspca.example.org",
    }),
    { name: "x", kind: "AWSPCAIssuer", group: "awspca.example.org" },
  );
});

Deno.test("an inventory line has no reason when healthy and always one line when not", () => {
  const base = { namespace: "pki", name: "leaf", dataName: "pki--leaf" };
  assertEquals(
    stateItem({ ...base, healthy: true, state: "Ready", why: "Ready" }),
    { ...base, healthy: true, reason: null, state: "Ready" },
  );
  assertEquals(
    stateItem({ ...base, healthy: false, state: "pending", why: "" }).reason,
    "state is pending",
  );
  assertEquals(
    stateItem({ ...base, healthy: false, state: "", why: "" }).reason,
    "no state yet",
  );
  const long = stateItem({
    ...base,
    namespace: "",
    healthy: false,
    state: "errored",
    why: `first line\nsecond  line ${"x".repeat(500)}`,
  });
  StateItemSchema.parse(long);
  assertEquals(long.namespace, null);
  assertEquals(long.reason?.startsWith("first line second line xxx"), true);
  assertEquals(long.reason?.includes("\n"), false);
  assertEquals(long.reason?.length, 303);
  // What a controller copied into its reason is blanked like any error text.
  assertEquals(
    stateItem({
      ...base,
      healthy: false,
      state: "errored",
      why: `429 from https://user:${SECRETS[0]}@acme.example.test/x token=${
        SECRETS[1]
      }`,
    }).reason,
    "429 from https://acme.example.test/x token=[redacted]",
  );
});

Deno.test("keyAuthorizations finds a key authorization by its shape, with its token, wherever a message quotes it", () => {
  const both = [KEY_AUTHORIZATION, ACME_TOKEN];
  assertEquals(keyAuthorizations(SELF_CHECK_REASON), both);
  for (
    const text of [
      KEY_AUTHORIZATION,
      `"${KEY_AUTHORIZATION}"`,
      `\\"${KEY_AUTHORIZATION}\\"`,
      `expected '${KEY_AUTHORIZATION}' but`,
      `key=${KEY_AUTHORIZATION}`,
      `key: ${KEY_AUTHORIZATION}, next`,
      `(${KEY_AUTHORIZATION})`,
      `got ${KEY_AUTHORIZATION}.`,
      `got ${KEY_AUTHORIZATION}. Then`,
      `line\n${KEY_AUTHORIZATION}\nline`,
      `http://wrong.example.test/.well-known/acme-challenge/${KEY_AUTHORIZATION}`,
    ]
  ) {
    assertEquals(keyAuthorizations(text), both, text);
  }
  // The token as the last part of the HTTP-01 URL, as cert-manager quotes
  // it when the solver cannot be reached.
  assertEquals(keyAuthorizations(SELF_CHECK_UNREACHABLE), [ACME_TOKEN]);
  assertEquals(
    seal({ reason: SELF_CHECK_UNREACHABLE }).reason,
    `Waiting for HTTP-01 challenge propagation: failed to perform self check GET request 'http://wrong.example.test/.well-known/acme-challenge/[redacted]': Get "http://wrong.example.test/.well-known/acme-challenge/[redacted]": dial tcp 10.96.100.80:80: connect: connection refused`,
  );
  assertEquals(
    keyAuthorizations("see /.well-known/acme-challenge/ for more"),
    [],
  );
  // The shortest token RFC 8555 allows (128 bits: 22 characters), and two
  // keys in one text.
  const short = `${"aB3-_xY9".repeat(3).slice(0, 22)}.${ACME_THUMBPRINT}`;
  assertEquals(keyAuthorizations(`a ${short} b ${KEY_AUTHORIZATION}`), [
    short,
    short.slice(0, 22),
    ...both,
  ]);
});

Deno.test("keyAuthorizations leaves ordinary dotted text alone", () => {
  const label43 = "a".repeat(43);
  for (
    const text of [
      "",
      "Certificate is up to date and has not expired",
      "web.example.test www.leaf.example.test _acme-challenge.hang.example.test.",
      "cert-manager.io/v1 acme.cert-manager.io v1.20.5 2026.11.10.1 10.96.100.53:8053",
      "registry.k8s.io/e2e-test-images/agnhost:2.53",
      "hanging-1-1264188995-118531346.acme-test",
      "system:serviceaccount:cert-manager:cert-manager",
      "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08",
      // A token or a DNS-01 value on its own has no shape to go by.
      ACME_TOKEN,
      `token ${ACME_TOKEN} was not accepted`,
      ACME_THUMBPRINT,
      // The second part is not 43 characters: 42, 44, or a longer name.
      `${ACME_TOKEN}.${ACME_THUMBPRINT.slice(1)}`,
      `${ACME_TOKEN}.${ACME_THUMBPRINT}x`,
      // The first part is shorter than a token may be.
      `${ACME_TOKEN.slice(0, 21)}.${ACME_THUMBPRINT}`,
      // A DNS name whose labels have these lengths, inside a longer name.
      `${"b".repeat(30)}.${label43}.example.test`,
      `www.${"b".repeat(30)}.${label43}`,
      `${KEY_AUTHORIZATION}.example.test`,
      // Other alphabets.
      `${ACME_TOKEN}.${ACME_THUMBPRINT.slice(0, 42)}+`,
      `${ACME_TOKEN}.${ACME_THUMBPRINT.slice(0, 42)}/`,
      `${ACME_TOKEN} . ${ACME_THUMBPRINT}`,
    ]
  ) {
    assertEquals(keyAuthorizations(text), [], text);
  }
  // Known limit, stated: a name that ends in a label of 43 characters after
  // one of 22 or more is taken for a key authorization.
  assertEquals(
    keyAuthorizations(`${"b".repeat(30)}.${label43}`).length,
    2,
  );
});

Deno.test("acmeSecrets names the token and key of a Challenge and every token of an Order, and nothing short", () => {
  assertEquals(acmeSecrets(selfCheckChallenge("c", { uid: "u", name: "o" })), [
    ACME_TOKEN,
    KEY_AUTHORIZATION,
  ]);
  const order = {
    status: {
      authorizations: [
        {
          challenges: [{ token: "token-of-http-01" }, {
            token: "token-of-dns-01",
          }],
        },
        { challenges: [{ token: "token-of-http-01" }, { token: 7 }, null] },
        null,
        { challenges: "x" },
      ],
    },
  };
  assertEquals(acmeSecrets(order, undefined, null, "x", {}), [
    "token-of-http-01",
    "token-of-dns-01",
  ]);
  // A value too short to be a token would blank ordinary words: not named.
  assertEquals(
    acmeSecrets({ spec: { token: "is", key: "pending" } }, {
      spec: { token: "", key: 3 },
    }),
    [],
  );
  assertEquals(acmeSecrets({ spec: { token: "12345678" } }), ["12345678"]);
});

Deno.test("seal blanks named values and quoted key authorizations in every text, and leaves what identifies the object", () => {
  const dnsLike = `${"b".repeat(30)}.${"a".repeat(43)}`;
  const record = {
    name: dnsLike,
    namespace: "pki",
    dnsNames: [dnsLike, "web.example.test"],
    dnsName: dnsLike,
    secretName: "the-dns01-value-tls",
    reason: SELF_CHECK_REASON,
    summary: `Challenge ${dnsLike}: ${SELF_CHECK_REASON}`,
    conditions: [{
      type: "Ready",
      message: `value the-dns01-value and token ${ACME_TOKEN}`,
      observedGeneration: 2,
      lastTransitionTime: null,
    }],
    nested: { deep: [{ text: `x ${ACME_TOKEN} y`, ok: true }] },
    acmeServer: "https://user:hunter2@acme.example.test/dir",
    readAt: "2026-11-10T10:42:49.000Z",
  };
  const out = seal(record, ["the-dns01-value"]);
  assertEquals(out, {
    name: dnsLike,
    namespace: "pki",
    dnsNames: [dnsLike, "web.example.test"],
    dnsName: dnsLike,
    secretName: "the-dns01-value-tls",
    reason:
      'Waiting for HTTP-01 challenge propagation: did not get expected response when querying endpoint, expected "[redacted]" but got: wrong-answer-84b645d94f-... (truncated)',
    // The known limit: in free text, a name of that shape is taken for a
    // key authorization. Its own fields above keep it.
    summary:
      `Challenge [redacted]: Waiting for HTTP-01 challenge propagation: did not get expected response when querying endpoint, expected "[redacted]" but got: wrong-answer-84b645d94f-... (truncated)`,
    conditions: [{
      type: "Ready",
      // The token is known from the key authorization the reason quotes.
      message: "value [redacted] and token [redacted]",
      observedGeneration: 2,
      lastTransitionTime: null,
    }],
    nested: { deep: [{ text: "x [redacted] y", ok: true }] },
    acmeServer: "https://acme.example.test/dir",
    readAt: "2026-11-10T10:42:49.000Z",
  });
  // Nothing to blank: the record comes back equal, and sealing twice
  // changes nothing more.
  const plain = { name: "leaf", reason: "Ready", n: 1, list: ["a.b", null] };
  assertEquals(seal(plain), plain);
  assertEquals(seal(out, ["the-dns01-value"]), out);
});
