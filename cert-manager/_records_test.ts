import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import { buildInventory, KubectlError } from "../lib/kubectl.ts";
import { StateInventorySchema, StateItemSchema } from "./_helpers.ts";
import {
  CertificateRequestSchema,
  CertificateSchema,
  ChallengeSchema,
  IssuerSchema,
  OrderSchema,
  parseCertificate,
  parseCertificateRequest,
  parseChallenge,
  parseIssuer,
  parseOrder,
  requestRevision,
  solverKind,
} from "./_records.ts";
import {
  certificateItem,
  certificateRequestItem,
  challengeItem,
  issuerDataName,
  issuerItem,
  orderItem,
} from "./_records.ts";
import {
  ACME_TOKEN,
  assertNoKeyAuthorization,
  assertNoSecrets,
  certificate,
  challenge,
  clusterIssuer,
  issuingStatus,
  order,
  request,
  SELF_CHECK_REASON,
  SELF_CHECK_UNREACHABLE,
  selfCheckChallenge,
} from "./test_support.ts";

const NOW = new Date("2026-11-10T10:42:49Z");

/** Answers without a name or a namespace: not objects, and refused. */
const NAMELESS: unknown[] = [
  {},
  { metadata: null, spec: null, status: null },
  { metadata: "x", spec: 7, status: [] },
  { metadata: { name: 1, namespace: [] }, spec: { dnsNames: "x" }, status: "" },
  { metadata: { name: "", namespace: "b" } },
  { metadata: { name: "a", namespace: "" } },
  { metadata: { namespace: "b" } },
];

/**
 * Named objects that are not what the CRD promises; no parser may throw on
 * one.
 */
const JUNK: unknown[] = [
  { metadata: { name: "a", namespace: "b" } },
  { metadata: { name: "a", namespace: "b" }, spec: null, status: null },
  { metadata: { name: "a", namespace: "b" }, spec: 7, status: [] },
  {
    metadata: { name: "a", namespace: "b" },
    spec: { dnsNames: "x" },
    status: "",
  },
  {
    metadata: {
      name: "a",
      namespace: "b",
      annotations: "x",
      ownerReferences: 3,
    },
    spec: {
      dnsNames: [1, null, "ok"],
      issuerRef: "x",
      solver: "x",
      wildcard: "yes",
      acme: "x",
    },
    status: {
      conditions: [{ type: 1 }, 2],
      revision: "3",
      notAfter: "not a date",
      renewalTime: 12,
      failedIssuanceAttempts: "many",
      authorizations: [null, { challenges: "x" }, { challenges: [null, {}] }],
      presented: "true",
      state: 5,
    },
  },
];

Deno.test("parseCertificate reads conditions, validity, names and derives expiry", () => {
  const c = parseCertificate(certificate(), NOW);
  CertificateSchema.parse(c);
  assertEquals(c.name, "leaf");
  assertEquals(c.namespace, "pki");
  assertEquals(c.ready, true);
  assertEquals(c.readyReason, "Ready");
  assertEquals(c.issuing, false);
  assertEquals(c.issuingSince, null);
  assertEquals(c.notAfter, "2026-11-11T09:42:49Z");
  assertEquals(c.secondsUntilExpiry, 23 * 3600);
  assertEquals(c.expired, false);
  assertEquals(c.renewalDue, false);
  assertEquals(c.dnsNames, ["leaf.example.test", "www.leaf.example.test"]);
  assertEquals(c.commonName, "leaf.example.test");
  assertEquals(c.issuerRef, {
    name: "ca",
    kind: "Issuer",
    group: "cert-manager.io",
  });
  assertEquals(c.secretName, "leaf-tls");
  assertEquals(c.revision, 3);
  assertEquals(c.failedIssuanceAttempts, 0);
  assertEquals(c.nextPrivateKeySecretNamePresent, false);
  assertEquals(c.readAt, NOW.toISOString());
  assertEquals(certificateItem(c), {
    namespace: "pki",
    name: "leaf",
    dataName: "pki--leaf",
    healthy: true,
    reason: null,
    state: "Ready",
  });
});

Deno.test("renewalDue and expired follow the clock", () => {
  const due = parseCertificate(certificate(), new Date("2026-11-11T01:42:49Z"));
  assertEquals(due.renewalDue, true);
  assertEquals(due.expired, false);
  const gone = parseCertificate(
    certificate(),
    new Date("2026-11-11T09:42:50Z"),
  );
  assertEquals(gone.expired, true);
  assertEquals(gone.secondsUntilExpiry, -1);
  assertEquals(certificateItem(gone).healthy, false);
  assertEquals(certificateItem(gone).state, "Expired");
  assertEquals(
    certificateItem(gone).reason,
    "expired at 2026-11-11T09:42:49Z",
  );
});

Deno.test("an issuing Certificate without a certificate yet is a record, not an error", () => {
  const c = parseCertificate(certificate({ status: issuingStatus }), NOW);
  CertificateSchema.parse(c);
  assertEquals(c.ready, false);
  assertEquals(c.issuing, true);
  assertEquals(c.issuingReason, "DoesNotExist");
  assertEquals(c.issuingSince, "2026-11-10T09:41:45Z");
  assertEquals(c.notAfter, null);
  assertEquals(c.secondsUntilExpiry, null);
  assertEquals(c.expired, false);
  assertEquals(c.renewalDue, false);
  assertEquals(c.revision, null);
  assertEquals(c.nextPrivateKeySecretNamePresent, true);
  assertEquals(JSON.stringify(c).includes("hanging-sq9m9"), false);
  assertEquals(certificateItem(c).state, "Issuing");
  assertEquals(
    certificateItem(c).reason,
    "Issuing certificate as Secret does not exist",
  );
});

Deno.test("a failed issuance shows its attempts and failure time", () => {
  const c = parseCertificate(
    certificate({
      status: {
        conditions: [
          {
            type: "Ready",
            status: "False",
            reason: "DoesNotExist",
            message: "no",
          },
          {
            type: "Issuing",
            status: "False",
            reason: "Failed",
            message: "order invalid",
          },
        ],
        failedIssuanceAttempts: 4,
        lastFailureTime: "2026-11-10T09:00:00Z",
      },
    }),
    NOW,
  );
  assertEquals(c.issuing, false);
  assertEquals(c.issuingReason, "Failed");
  assertEquals(c.failedIssuanceAttempts, 4);
  assertEquals(c.lastFailureTime, "2026-11-10T09:00:00Z");
  assertEquals(certificateItem(c), {
    namespace: "pki",
    name: "leaf",
    dataName: "pki--leaf",
    healthy: false,
    reason: "no",
    state: "NotReady",
  });
});

Deno.test("no parser throws on a malformed or partial object that has a name, each record fits its schema, and a nameless answer is refused", () => {
  for (const junk of JUNK) {
    const item = junk as Record<string, unknown>;
    CertificateSchema.parse(parseCertificate(item, NOW));
    CertificateRequestSchema.parse(parseCertificateRequest(item, NOW));
    OrderSchema.parse(parseOrder(item, NOW));
    ChallengeSchema.parse(parseChallenge(item, NOW));
    IssuerSchema.parse(parseIssuer(item, "Issuer", NOW));
    IssuerSchema.parse(parseIssuer(item, "ClusterIssuer", NOW));
    // Every inventory line fits its schema too, whatever the object held.
    StateItemSchema.parse(certificateItem(parseCertificate(item, NOW)));
    StateItemSchema.parse(orderItem(parseOrder(item, NOW)));
    StateItemSchema.parse(challengeItem(parseChallenge(item, NOW)));
    StateItemSchema.parse(issuerItem(parseIssuer(item, "Issuer", NOW)));
    StateItemSchema.parse(
      certificateRequestItem(parseCertificateRequest(item, NOW)),
    );
  }
  for (const junk of NAMELESS) {
    const item = junk as Record<string, unknown>;
    for (
      const parse of [
        parseCertificate,
        parseCertificateRequest,
        parseOrder,
        parseChallenge,
        (i: Record<string, unknown>, now: Date) =>
          parseIssuer(i, "Issuer", now),
      ]
    ) {
      const e = assertThrows(() => parse(item, NOW), KubectlError);
      assertEquals(e.message.includes("without a name or namespace"), true);
    }
  }
  // A ClusterIssuer has no namespace, and needs none.
  assertThrows(() => parseIssuer({}, "ClusterIssuer", NOW), KubectlError);
  IssuerSchema.parse(
    parseIssuer({ metadata: { name: "a" } }, "ClusterIssuer", NOW),
  );
  const c = parseCertificate(JUNK[4] as Record<string, unknown>, NOW);
  assertEquals(c.dnsNames, ["ok"]);
  assertEquals(c.revision, null);
  assertEquals(c.secondsUntilExpiry, null);
  assertEquals(c.failedIssuanceAttempts, 0);
  const ch = parseChallenge(JUNK[4] as Record<string, unknown>, NOW);
  assertEquals(ch.presented, false);
  assertEquals(ch.wildcard, false);
  assertEquals(ch.state, "");
  assertEquals(ch.solverKind, "unknown");
  const o = parseOrder(JUNK[4] as Record<string, unknown>, NOW);
  assertEquals(o.authorizations.map((a) => a.challengeTypes), [[], [], []]);
});

Deno.test("parseCertificateRequest reads the four conditions and never the bodies", () => {
  const pending = parseCertificateRequest(
    request("hanging-1", "1", { uid: "uid-cert", name: "hanging" }),
    NOW,
  );
  CertificateRequestSchema.parse(pending);
  assertEquals(pending.certificateName, "hanging");
  assertEquals(pending.certificateRevision, 1);
  assertEquals(pending.approved, true);
  assertEquals(pending.denied, false);
  assertEquals(pending.ready, false);
  assertEquals(pending.invalidRequest, false);
  assertEquals(pending.state, "Pending");
  assertEquals(pending.certificateIssued, false);
  assertEquals(pending.issuerRef.kind, "ClusterIssuer");
  assertEquals(certificateRequestItem(pending).healthy, false);

  const issued = parseCertificateRequest(
    request("leaf-2", "2", { name: "leaf" }, {
      status: "True",
      reason: "Issued",
      message: "Certificate fetched from issuer successfully",
    }),
    NOW,
  );
  assertEquals(issued.state, "Issued");
  assertEquals(issued.certificateIssued, true);
  assertNoSecrets(pending, issued);
});

Deno.test("a request's state follows Denied, InvalidRequest and Failed", () => {
  const withConds = (conditions: unknown[], failureTime?: string) => {
    const r = request("r", "1", { name: "c" });
    r.status = { conditions, failureTime };
    return parseCertificateRequest(r, NOW);
  };
  const denied = withConds([
    { type: "Denied", status: "True", reason: "policy", message: "no" },
    {
      type: "Ready",
      status: "False",
      reason: "Denied",
      message: "denied by policy",
    },
  ]);
  assertEquals([denied.state, denied.denied, denied.approved], [
    "Denied",
    true,
    false,
  ]);
  const invalid = withConds([
    {
      type: "InvalidRequest",
      status: "True",
      reason: "bad",
      message: "bad csr",
    },
    { type: "Ready", status: "False", reason: "Failed", message: "bad csr" },
  ]);
  assertEquals([invalid.state, invalid.invalidRequest], [
    "InvalidRequest",
    true,
  ]);
  const failed = withConds(
    [{
      type: "Ready",
      status: "False",
      reason: "Failed",
      message: "order is invalid",
    }],
    "2026-11-10T09:50:00Z",
  );
  assertEquals(failed.state, "Failed");
  assertEquals(failed.failureTime, "2026-11-10T09:50:00Z");
  assertEquals(certificateRequestItem(failed).reason, "order is invalid");
  assertEquals(withConds([]).state, "Pending");
});

Deno.test("requestRevision reads a whole number and nothing else", () => {
  const rev = (v: unknown) =>
    requestRevision({
      metadata: { annotations: { "cert-manager.io/certificate-revision": v } },
    });
  assertEquals(rev("12"), 12);
  for (const bad of ["", "x", "1.5", "-1", 3, null, undefined]) {
    assertEquals(rev(bad), null);
  }
  assertEquals(requestRevision({}), null);
});

Deno.test("a request made without a Certificate has no certificate name", () => {
  const r = request("manual", undefined, { name: "x" });
  (r.metadata as Record<string, unknown>).annotations = {};
  (r.metadata as Record<string, unknown>).ownerReferences = [];
  const parsed = parseCertificateRequest(r, NOW);
  assertEquals(parsed.certificateName, null);
  assertEquals(parsed.certificateRevision, null);
});

Deno.test("parseOrder summarizes authorizations without URLs or tokens", () => {
  const o = parseOrder(
    order("hanging-1-1", { uid: "u", name: "hanging-1" }),
    NOW,
  );
  OrderSchema.parse(o);
  assertEquals(o.certificateRequestName, "hanging-1");
  assertEquals(o.state, "pending");
  assertEquals(o.dnsNames, ["*.hang.example.test", "hang.example.test"]);
  assertEquals(o.authorizations, [
    {
      identifier: "hang.example.test",
      wildcard: true,
      initialState: "pending",
      challengeTypes: ["dns-account-01", "dns-01"],
    },
    {
      identifier: "hang.example.test",
      wildcard: false,
      initialState: "pending",
      challengeTypes: ["tls-alpn-01", "http-01", "dns-01"],
    },
  ]);
  assertEquals(o.certificateIssued, false);
  assertEquals(orderItem(o).healthy, false);
  assertEquals(orderItem(o).reason, "state is pending");
  const valid = parseOrder(order("o", { uid: "u", name: "r" }, "valid"), NOW);
  assertEquals(valid.certificateIssued, true);
  assertEquals(orderItem(valid).healthy, true);
  assertEquals(orderItem(valid).reason, null);
  assertNoSecrets(o, valid);
});

Deno.test("an errored Order keeps its reason and failure time", () => {
  const raw = order("o", { uid: "u", name: "r" }, "errored");
  Object.assign(raw.status as Record<string, unknown>, {
    reason:
      "Failed to create Order: 429 urn:ietf:params:acme:error:rateLimited",
    failureTime: "2026-11-10T09:55:00Z",
  });
  const o = parseOrder(raw, NOW);
  assertEquals(o.state, "errored");
  assertEquals(o.reason.includes("rateLimited"), true);
  assertEquals(o.failureTime, "2026-11-10T09:55:00Z");
});

Deno.test("text a controller copied from elsewhere is blanked in every record: condition messages, Order and Challenge reasons", () => {
  const leaked =
    `ACME said: Authorization: Bearer SECRET-TOKEN and password=SECRET-KEY`;
  const o = order("o", { uid: "u", name: "r" }, "errored");
  (o.status as Record<string, unknown>).reason = leaked;
  const ch = challenge("c", { uid: "u", name: "o" }, {
    status: { state: "errored", reason: leaked },
  });
  const cert = certificate({
    status: {
      conditions: [
        { type: "Ready", status: "False", reason: "Failed", message: leaked },
        { type: "Issuing", status: "True", reason: "x", message: leaked },
      ],
    },
  });
  const req = request("r", "1", { name: "c" }, {
    status: "False",
    reason: "Failed",
    message: leaked,
  });
  const issuer = clusterIssuer("i", {
    status: "False",
    reason: "ErrRegisterACMEAccount",
    message: leaked,
  });
  const records = [
    parseOrder(o, NOW),
    parseChallenge(ch, NOW),
    parseCertificate(cert, NOW),
    parseCertificateRequest(req, NOW),
    parseIssuer(issuer, "ClusterIssuer", NOW),
  ];
  const lines = [
    orderItem(parseOrder(o, NOW)),
    challengeItem(parseChallenge(ch, NOW)),
    certificateItem(parseCertificate(cert, NOW)),
    certificateRequestItem(parseCertificateRequest(req, NOW)),
    issuerItem(parseIssuer(issuer, "ClusterIssuer", NOW)),
  ];
  assertNoSecrets(records, lines);
  for (const line of lines) {
    assertEquals(line.reason?.startsWith("ACME said: "), true);
    assertEquals(line.reason?.includes("[redacted]"), true);
  }
});

Deno.test("a key authorization quoted by cert-manager's HTTP-01 self check is in no record and no inventory line", () => {
  const owner = { uid: "u", name: "o" };
  // The Challenge holds the token and key itself.
  const ch = parseChallenge(selfCheckChallenge("ch", owner), NOW);
  assertNoKeyAuthorization(ch, challengeItem(ch));
  assertEquals(
    ch.reason,
    'Waiting for HTTP-01 challenge propagation: did not get expected response when querying endpoint, expected "[redacted]" but got: wrong-answer-84b645d94f-... (truncated)',
  );
  assertEquals(ch.name, "ch");
  assertEquals(ch.dnsName, "wrong.example.test");
  assertEquals(challengeItem(ch).reason, ch.reason);
  // The Order holds the token, not the key.
  const rawOrder = order("o", { uid: "u", name: "r" }, "errored");
  const auths = (rawOrder.status as {
    authorizations: Array<{ challenges: Array<{ token: string }> }>;
  }).authorizations;
  auths[1].challenges[1].token = ACME_TOKEN;
  (rawOrder.status as Record<string, unknown>).reason =
    `Failed: ${SELF_CHECK_REASON}; token ${ACME_TOKEN} was not accepted`;
  const o = parseOrder(rawOrder, NOW);
  assertNoKeyAuthorization(o, orderItem(o));
  assertEquals(o.reason.includes('expected "[redacted]" but got'), true);
  assertEquals(o.reason.includes("token [redacted] was not accepted"), true);
  // A token on its own, and a DNS-01 key (a digest with no dot), have no
  // shape: only the object's own values can name them.
  const digest = "Zq1-Xw2_Ce3Vr4Bt5Ny6Mu7Ki8Lo9Pa0Sd1Fg2Hj3Kl";
  const dns = challenge("dns", owner, {
    status: {
      state: "pending",
      reason: `TXT value ${digest} not found for token ${ACME_TOKEN}`,
    },
  });
  Object.assign(dns.spec as Record<string, unknown>, {
    token: ACME_TOKEN,
    key: digest,
  });
  const parsedDns = parseChallenge(dns, NOW);
  assertEquals(
    parsedDns.reason,
    "TXT value [redacted] not found for token [redacted]",
  );
  assertEquals(
    challengeItem(parsedDns).reason,
    "TXT value [redacted] not found for token [redacted]",
  );
  (rawOrder.status as Record<string, unknown>).reason =
    `challenge ${ACME_TOKEN} failed`;
  assertEquals(parseOrder(rawOrder, NOW).reason, "challenge [redacted] failed");
  assertEquals(
    orderItem(parseOrder(rawOrder, NOW)).reason,
    "challenge [redacted] failed",
  );
  // The other text of the self check, in a record that holds no token.
  const unreachable = parseCertificateRequest(
    request("r", "1", { name: "c" }, {
      status: "False",
      reason: "Pending",
      message: SELF_CHECK_UNREACHABLE,
    }),
    NOW,
  );
  assertNoKeyAuthorization(unreachable, certificateRequestItem(unreachable));
  assertEquals(
    unreachable.readyMessage.includes("/acme-challenge/[redacted]': Get"),
    true,
  );
  // A caller that knows more names it: a trace names its chain's values.
  assertEquals(
    parseCertificateRequest(
      request("r", "1", { name: "c" }, {
        status: "False",
        reason: "Pending",
        message: `waiting for ${ACME_TOKEN}`,
      }),
      NOW,
      [ACME_TOKEN],
    ).readyMessage,
    "waiting for [redacted]",
  );
  // A CertificateRequest, a Certificate and an issuer hold neither: the key
  // authorization is found by its shape.
  const said = {
    status: "False",
    reason: "Pending",
    message: SELF_CHECK_REASON,
  };
  const req = parseCertificateRequest(
    request("r", "1", { name: "c" }, said),
    NOW,
  );
  const cert = parseCertificate(
    certificate({
      status: {
        conditions: [
          { type: "Ready", ...said },
          {
            type: "Issuing",
            status: "True",
            reason: "x",
            message: SELF_CHECK_REASON,
          },
        ],
      },
    }),
    NOW,
  );
  const issuer = parseIssuer(clusterIssuer("i", said), "ClusterIssuer", NOW);
  assertNoKeyAuthorization(
    req,
    cert,
    issuer,
    certificateRequestItem(req),
    certificateItem(cert),
    issuerItem(issuer),
  );
  for (
    const m of [
      req.readyMessage,
      cert.readyMessage,
      cert.issuingMessage,
      issuer.readyMessage,
    ]
  ) {
    assertEquals(
      m.includes('expected "[redacted]" but got: wrong-answer'),
      true,
    );
  }
  assertEquals(
    cert.conditions.every((c) => !c.message?.includes(ACME_TOKEN)),
    true,
  );
});

Deno.test("parseChallenge reads a hanging DNS-01 and never the token or key", () => {
  const c = parseChallenge(challenge("ch-1", { uid: "u", name: "o" }), NOW);
  ChallengeSchema.parse(c);
  assertEquals(c.orderName, "o");
  assertEquals(c.type, "DNS-01");
  assertEquals(c.dnsName, "hang.example.test");
  assertEquals(c.wildcard, true);
  assertEquals(c.state, "pending");
  assertEquals(c.presented, false);
  assertEquals(c.processing, true);
  assertEquals(c.solverKind, "dns01/webhook");
  assertEquals(c.solverName, "absent");
  assertEquals(challengeItem(c), {
    namespace: "acme-test",
    name: "ch-1",
    dataName: "acme-test--ch-1",
    healthy: false,
    reason: "the server could not find the requested resource",
    state: "pending",
  });
  assertNoSecrets(c);
});

Deno.test("a Challenge that cert-manager has not started has a null status", () => {
  const c = parseChallenge(
    challenge("ch-2", { uid: "u", name: "o" }, {
      status: null,
      wildcard: false,
    }),
    NOW,
  );
  ChallengeSchema.parse(c);
  assertEquals([c.state, c.reason, c.presented, c.processing], [
    "",
    "",
    false,
    false,
  ]);
  assertEquals(challengeItem(c).reason, "no state yet");
});

Deno.test("solverKind names the solver by its key and copies no configuration", () => {
  assertEquals(
    solverKind({ dns01: { cloudflare: { apiTokenSecretRef: { name: "x" } } } }),
    {
      kind: "dns01/cloudflare",
      name: null,
    },
  );
  assertEquals(
    solverKind({
      dns01: { cnameStrategy: "Follow", rfc2136: { nameserver: "ns" } },
    }),
    { kind: "dns01/rfc2136", name: null },
  );
  assertEquals(
    solverKind({ http01: { ingress: { ingressClassName: "nginx" } } }),
    {
      kind: "http01/ingress",
      name: null,
    },
  );
  assertEquals(solverKind({ http01: { gatewayHTTPRoute: {} } }), {
    kind: "http01/gatewayHTTPRoute",
    name: null,
  });
  assertEquals(solverKind({ dns01: {} }), { kind: "dns01", name: null });
  assertEquals(solverKind({ selector: {} }), { kind: "unknown", name: null });
  assertEquals(solverKind(null), { kind: "unknown", name: null });
});

Deno.test("parseIssuer reads type, readiness and the ACME directory, and no account detail", () => {
  const acme = parseIssuer(clusterIssuer("acme-dns01"), "ClusterIssuer", NOW);
  IssuerSchema.parse(acme);
  assertEquals(acme.namespace, "");
  assertEquals(acme.type, "acme");
  assertEquals(acme.ready, true);
  assertEquals(acme.acmeServer, "https://acme.example.test/dir");
  assertEquals(issuerItem(acme).healthy, true);
  assertEquals(issuerDataName(acme), "ClusterIssuer--acme-dns01");
  assertNoSecrets(acme);

  const down = parseIssuer(
    clusterIssuer("down", {
      status: "False",
      reason: "ErrRegisterACMEAccount",
      message: "Failed to register ACME account: i/o timeout",
    }),
    "ClusterIssuer",
    NOW,
  );
  assertEquals(down.ready, false);
  assertEquals(issuerItem(down), {
    namespace: null,
    name: "down",
    dataName: "ClusterIssuer--down",
    healthy: false,
    reason: "Failed to register ACME account: i/o timeout",
    state: "NotReady",
  });

  const types = ["ca", "selfSigned", "vault", "venafi"].map((t) =>
    parseIssuer(
      { metadata: { name: "i", namespace: "pki" }, spec: { [t]: {} } },
      "Issuer",
      NOW,
    ).type
  );
  assertEquals(types, ["ca", "selfSigned", "vault", "venafi"]);
  const none = parseIssuer(
    { metadata: { name: "i", namespace: "pki" } },
    "Issuer",
    NOW,
  );
  assertEquals([none.type, none.ready, none.namespace], [
    "unknown",
    false,
    "pki",
  ]);
});

Deno.test("every record has exactly the fields of its schema: none missing, none extra", () => {
  const same = (record: object, schema: { shape: object }) =>
    assertEquals(Object.keys(record).sort(), Object.keys(schema.shape).sort());
  same(parseCertificate(certificate(), NOW), CertificateSchema);
  same(
    parseCertificate({ metadata: { name: "a", namespace: "b" } }, NOW),
    CertificateSchema,
  );
  same(
    parseCertificateRequest(request("r", "1", { name: "c" }), NOW),
    CertificateRequestSchema,
  );
  const o = parseOrder(order("o", { uid: "u", name: "r" }), NOW);
  same(o, OrderSchema);
  same(o.authorizations[0], OrderSchema.shape.authorizations.element);
  same(
    parseChallenge(challenge("c", { uid: "u", name: "o" }), NOW),
    ChallengeSchema,
  );
  same(parseIssuer(clusterIssuer("i"), "ClusterIssuer", NOW), IssuerSchema);
  const c = parseCertificate(certificate(), NOW);
  same(c.conditions[0], CertificateSchema.shape.conditions.element);
  same(c.issuerRef, CertificateSchema.shape.issuerRef);
  same(certificateItem(c), StateItemSchema);
  const inventory = buildInventory(
    "",
    [certificateItem(c)],
    NOW.toISOString(),
  );
  same(inventory, StateInventorySchema);
  assertEquals(StateInventorySchema.parse(inventory), inventory);
});
