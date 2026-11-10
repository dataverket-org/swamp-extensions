import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  currentRequest,
  diagnose,
  model,
  RenewalSchema,
  type TraceData,
  TraceSchema,
  withIssuingTrue,
} from "./certificate.ts";
import { KubectlError } from "../lib/kubectl.ts";
import { CAPTURE } from "../lib/kubectl_fake.ts";
import { StateInventorySchema } from "./_helpers.ts";
import {
  CertificateSchema,
  parseCertificate,
  parseChallenge,
} from "./_records.ts";
import {
  ACME_TOKEN,
  assertNoKeyAuthorization,
  SELF_CHECK_REASON,
  selfCheckChallenge,
} from "./test_support.ts";
import {
  assertGetRefusals,
  assertListFailures,
  assertNoSecrets,
  type Call,
  certificate,
  challenge,
  clusterIssuer,
  ctx,
  forbiddenList,
  HOSTILE,
  issuingStatus,
  list,
  order,
  request,
  SAID,
  SECRETS,
  withCalls,
} from "./test_support.ts";

const CERTS = "certificates.cert-manager.io";
const REQS = "certificaterequests.cert-manager.io";
const ORDERS = "orders.acme.cert-manager.io";
const CHALLENGES = "challenges.acme.cert-manager.io";
const m = model.methods;

Deno.test("list records every Certificate and one inventory, in all namespaces", async () => {
  const c = ctx({});
  await withCalls([{
    args: ["get", CERTS, "-A"],
    out: list([
      certificate(),
      certificate({
        name: "hanging",
        namespace: "acme-test",
        status: issuingStatus,
      }),
    ]),
  }], async () => {
    const r = await m.list.execute({}, c.context);
    assertEquals(r.dataHandles.length, 3);
  });
  assertEquals(c.written.map((w) => [w.spec, w.name]), [
    ["certificate", "pki--leaf"],
    ["certificate", "acme-test--hanging"],
    ["inventory", "inventory_all"],
  ]);
  for (const w of c.written.slice(0, 2)) CertificateSchema.parse(w.data);
  const inventory = StateInventorySchema.parse(c.written[2].data);
  assertEquals(c.written[2].data, inventory);
  assertEquals(
    [
      inventory.namespace,
      inventory.count,
      inventory.healthyCount,
      inventory.unhealthyCount,
    ],
    [null, 2, 1, 1],
  );
  assertEquals(inventory.items, [
    {
      namespace: "pki",
      name: "leaf",
      dataName: "pki--leaf",
      healthy: true,
      reason: null,
      state: "Ready",
    },
    {
      namespace: "acme-test",
      name: "hanging",
      dataName: "acme-test--hanging",
      healthy: false,
      reason: "Issuing certificate as Secret does not exist",
      state: "Issuing",
    },
  ]);
  assertEquals(
    inventory.observedAt,
    (c.written[0].data as { readAt: string }).readAt,
  );
});

Deno.test("list in one namespace uses -n, from the argument or the definition", async () => {
  for (
    const [args, global] of [[{ namespace: "pki" }, ""], [{}, "pki"], [{
      namespace: "",
    }, "pki"]] as const
  ) {
    const c = ctx({ namespace: global, context: "kind-x" });
    await withCalls(
      [{ args: ["get", CERTS, "-n", "pki"], out: list([]) }],
      () => m.list.execute(args, c.context),
      { context: "kind-x" },
    );
    assertEquals(c.written.map((w) => w.name), ["inventory_ns_pki"]);
    assertEquals(
      StateInventorySchema.parse(c.written[0].data),
      {
        namespace: "pki",
        count: 0,
        healthyCount: 0,
        unhealthyCount: 0,
        items: [],
        observedAt: (c.written[0].data as { observedAt: string }).observedAt,
      },
    );
  }
});

Deno.test("a list that fails writes nothing: RBAC, expired login, no CRD, no JSON, timeout, an answer that is not a list", async () => {
  await assertListFailures(m.list.execute, CERTS, "Certificate");
});

Deno.test("a list refuses two Certificates that would share one record, and writes neither", async () => {
  const c = ctx({});
  await withCalls([{
    args: ["get", CERTS, "-A"],
    out: list([
      certificate({ name: "b--c", namespace: "a" }),
      certificate({ name: "c", namespace: "a--b" }),
    ]),
  }], async () => {
    await assertRejects(
      () => m.list.execute({}, c.context),
      Error,
      "Certificate a/b--c and a--b/c would both be stored as a--b--c",
    );
  });
  assertEquals(c.written, []);
});

Deno.test("no method lets an injection-shaped name or namespace reach kubectl", async () => {
  for (const bad of HOSTILE) {
    for (const method of [m.get, m.trace, m.renew]) {
      const c = ctx({ namespace: "pki" });
      await withCalls([], async () => {
        await assertRejects(
          () => method.execute({ name: bad }, c.context),
          Error,
          "is not a Kubernetes object name",
        );
      });
      assertEquals(c.written, []);
    }
  }
  for (const bad of HOSTILE.filter((b) => b !== "")) {
    for (const method of [m.get, m.trace, m.renew]) {
      const c = ctx({});
      await withCalls([], async () => {
        await assertRejects(
          () => method.execute({ name: "leaf", namespace: bad }, c.context),
          Error,
          "is not a Kubernetes namespace name",
        );
      });
      const g = ctx({ namespace: bad });
      await withCalls([], async () => {
        await assertRejects(
          () => method.execute({ name: "leaf" }, g.context),
          Error,
        );
        await assertRejects(() => m.list.execute({}, g.context), Error);
      });
      assertEquals([...c.written, ...g.written], []);
    }
  }
});

Deno.test("a method on one Certificate without a namespace refuses before kubectl", async () => {
  for (
    const [name, method] of Object.entries({
      get: m.get,
      trace: m.trace,
      renew: m.renew,
    })
  ) {
    const c = ctx({});
    await withCalls([], async () => {
      const e = await assertRejects(
        () => method.execute({ name: "leaf" }, c.context),
        Error,
      );
      assertStringIncludes(e.message, `namespace is required for ${name}`);
    });
    assertEquals(c.written, []);
  }
});

Deno.test("get records one Certificate; a missing one is an error that says so", async () => {
  const c = ctx({ namespace: "pki" });
  await withCalls([{
    args: ["get", CERTS, "leaf", "-n", "pki"],
    out: certificate(),
  }], () => m.get.execute({ name: "leaf" }, c.context));
  assertEquals(c.written.map((w) => [w.spec, w.name]), [[
    "certificate",
    "pki--leaf",
  ]]);

  const d = ctx({ namespace: "pki" });
  await withCalls([{
    args: ["get", CERTS, "nope", "-n", "pki"],
    fail: SAID.notFound(CERTS, "nope"),
  }], async () => {
    const e = await assertRejects(
      () => m.get.execute({ name: "nope" }, d.context),
      Error,
    );
    assertEquals(e.message, "Certificate pki/nope does not exist");
  });
  assertEquals(d.written, []);
});

Deno.test("get refuses hostile names, a missing object and an answer that is not the object asked for", async () => {
  await assertGetRefusals(m.get.execute, CERTS, "Certificate");
});

const HANGING = certificate({
  name: "hanging",
  namespace: "acme-test",
  uid: "uid-hanging",
  status: {
    ...issuingStatus,
    revision: 1,
    notAfter: "2026-12-01T00:00:00Z",
  },
  issuerRef: { kind: "ClusterIssuer", name: "acme-dns01" },
});
const OWNER = { uid: "uid-hanging", name: "hanging" };

Deno.test("trace walks Certificate, issuer, request, Order and Challenges, and names the hanging DNS-01", async () => {
  const c = ctx({});
  await withCalls(
    [
      { args: ["get", CERTS, "hanging", "-n", "acme-test"], out: HANGING },
      {
        args: ["get", "clusterissuers.cert-manager.io", "acme-dns01"],
        out: clusterIssuer("acme-dns01"),
      },
      {
        args: ["get", REQS, "-n", "acme-test"],
        out: list([
          request("hanging-1", "1", OWNER, {
            status: "True",
            reason: "Issued",
            message: "ok",
          }),
          request("hanging-2", "2", OWNER),
          request("web-9", "9", { uid: "uid-web", name: "web" }),
          request("same-name-other-uid-7", "7", {
            uid: "uid-old",
            name: "hanging",
          }),
        ]),
      },
      {
        args: ["get", ORDERS, "-n", "acme-test"],
        out: list([
          order("web-9-1", { uid: "uid-web-9", name: "web-9" }, "valid"),
          order(
            "hanging-1-1",
            { uid: "uid-hanging-1", name: "hanging-1" },
            "valid",
          ),
          order("hanging-2-1", { uid: "uid-hanging-2", name: "hanging-2" }),
        ]),
      },
      {
        args: ["get", CHALLENGES, "-n", "acme-test"],
        out: list([
          challenge("web-ch", { uid: "uid-web-9-1", name: "web-9-1" }),
          challenge("hanging-ch-a", {
            uid: "uid-hanging-2-1",
            name: "hanging-2-1",
          }),
          challenge("hanging-ch-b", {
            uid: "uid-hanging-2-1",
            name: "hanging-2-1",
          }, {
            status: null,
            wildcard: false,
          }),
        ]),
      },
    ],
    () =>
      m.trace.execute({ name: "hanging", namespace: "acme-test" }, c.context),
  );

  assertEquals(c.written.map((w) => [w.spec, w.name]), [
    ["certificate", "acme-test--hanging"],
    ["trace", "trace_acme-test--hanging"],
  ]);
  assertEquals(
    Object.keys(c.written[1].data as object).sort(),
    Object.keys(TraceSchema.shape).sort(),
  );
  const t = TraceSchema.parse(c.written[1].data);
  assertEquals(Object.keys(t.issuer).sort(), [
    "error",
    "found",
    "group",
    "kind",
    "message",
    "missing",
    "name",
    "ready",
    "reason",
  ]);
  assertEquals(t.stage, "challenge");
  assertEquals(
    t.summary,
    "Challenge hanging-ch-a (DNS-01 for *.hang.example.test, solver dns01/webhook) is pending, not presented: the server could not find the requested resource",
  );
  assertEquals(t.issuer, {
    name: "acme-dns01",
    kind: "ClusterIssuer",
    group: "cert-manager.io",
    found: true,
    missing: false,
    ready: true,
    reason: "ACMEAccountRegistered",
    message: "The ACME account was registered with the ACME server",
    error: null,
  });
  assertEquals(t.certificateRequest?.name, "hanging-2");
  assertEquals(t.certificateRequest?.certificateRevision, 2);
  assertEquals(t.order?.name, "hanging-2-1");
  assertEquals(t.order?.state, "pending");
  assertEquals(t.challenges.map((ch) => [ch.name, ch.state]), [
    ["hanging-ch-a", "pending"],
    ["hanging-ch-b", ""],
  ]);
  assertNoSecrets(c.written, c.logs);
});

Deno.test("trace of a failed HTTP-01 self check: the key authorization is in no level, not in the summary and not in a log line", async () => {
  const c = ctx({});
  const cert = certificate({
    name: "wrong",
    namespace: "acme-test",
    uid: "uid-wrong",
    status: {
      conditions: [
        {
          type: "Ready",
          status: "False",
          reason: "DoesNotExist",
          // Only the token, which no pattern can know by its shape.
          message: `Issuing: challenge token ${ACME_TOKEN} not served`,
        },
        {
          type: "Issuing",
          status: "True",
          reason: "DoesNotExist",
          message: `Issuing: waiting for ${ACME_TOKEN}`,
        },
      ],
    },
    issuerRef: { kind: "ClusterIssuer", name: "acme-dns01" },
  });
  const owner = { uid: "uid-wrong", name: "wrong" };
  const o = order("wrong-1-1", { uid: "uid-wrong-1", name: "wrong-1" });
  (o.status as Record<string, unknown>).reason = `waiting: ${ACME_TOKEN}`;
  await withCalls(
    [
      { args: ["get", CERTS, "wrong", "-n", "acme-test"], out: cert },
      {
        args: ["get", "clusterissuers.cert-manager.io", "acme-dns01"],
        out: clusterIssuer("acme-dns01", {
          status: "False",
          reason: "Err",
          message: `last challenge: ${ACME_TOKEN}`,
        }),
      },
      {
        args: ["get", REQS, "-n", "acme-test"],
        out: list([
          request("wrong-1", "1", owner, {
            status: "False",
            reason: "Pending",
            message: `order pending, token ${ACME_TOKEN}: ${SELF_CHECK_REASON}`,
          }),
        ]),
      },
      { args: ["get", ORDERS, "-n", "acme-test"], out: list([o]) },
      {
        args: ["get", CHALLENGES, "-n", "acme-test"],
        out: list([
          selfCheckChallenge("wrong-ch", {
            uid: "uid-wrong-1-1",
            name: "wrong-1-1",
          }),
        ]),
      },
    ],
    () => m.trace.execute({ name: "wrong", namespace: "acme-test" }, c.context),
  );
  const t = TraceSchema.parse(c.written[1].data);
  assertEquals(t.stage, "challenge");
  assertEquals(
    t.summary,
    'Challenge wrong-ch (HTTP-01 for wrong.example.test, solver http01/ingress) is pending, presented: Waiting for HTTP-01 challenge propagation: did not get expected response when querying endpoint, expected "[redacted]" but got: wrong-answer-84b645d94f-... (truncated)',
  );
  assertEquals(
    t.certificate.readyMessage,
    "Issuing: challenge token [redacted] not served",
  );
  assertEquals(t.issuer.message, "last challenge: [redacted]");
  assertEquals(t.order?.reason, "waiting: [redacted]");
  assertEquals(c.logs.some((l) => l.includes("wrong-answer-84b645d94f")), true);
  assertNoKeyAuthorization(c.written, c.logs);
  assertNoSecrets(c.written, c.logs);
});

Deno.test("trace of a Ready CA Certificate stops after the requests: no Order is asked for when none exists", async () => {
  const c = ctx({ namespace: "pki" });
  await withCalls([
    { args: ["get", CERTS, "leaf", "-n", "pki"], out: certificate() },
    {
      args: ["get", "issuers.cert-manager.io", "ca", "-n", "pki"],
      out: {
        kind: "Issuer",
        metadata: { name: "ca", namespace: "pki" },
        spec: { ca: { secretName: "root-ca" } },
        status: {
          conditions: [{
            type: "Ready",
            status: "True",
            reason: "KeyPairVerified",
            message: "Signing CA verified",
          }],
        },
      },
    },
    { args: ["get", REQS, "-n", "pki"], out: list([]) },
  ], () => m.trace.execute({ name: "leaf" }, c.context));
  const t = c.written[1].data as TraceData;
  assertEquals(t.stage, "ready");
  assertEquals(
    t.summary,
    "Certificate leaf is Ready and valid until 2026-11-11T09:42:49Z",
  );
  assertEquals([t.certificateRequest, t.order, t.challenges], [null, null, []]);
});

Deno.test("trace records an issuer it cannot read and goes on; only a missing one is where issuance stands", async () => {
  const UNKNOWN =
    "Certificate hanging is issuing: Issuing certificate as Secret does not exist";
  const cases: Array<[Call | null, unknown, string, string]> = [
    [
      {
        args: ["get", "clusterissuers.cert-manager.io", "acme-dns01"],
        fail: SAID.notFound("clusterissuers.cert-manager.io", "acme-dns01"),
      },
      { kind: "ClusterIssuer", name: "acme-dns01" },
      "does not exist",
      "ClusterIssuer acme-dns01 does not exist",
    ],
    [
      {
        args: ["get", "clusterissuers.cert-manager.io", "acme-dns01"],
        fail: SAID.forbidden("get", "clusterissuers.cert-manager.io"),
      },
      { kind: "ClusterIssuer", name: "acme-dns01" },
      "could not be read: access was refused",
      UNKNOWN,
    ],
    [
      null,
      { kind: "AWSPCAClusterIssuer", name: "pca", group: "awspca.example.org" },
      "is of API group awspca.example.org, which this type does not read",
      UNKNOWN,
    ],
    [
      null,
      { kind: "ClusterIssuer", name: "--all" },
      "has no valid name in the issuerRef",
      "ClusterIssuer --all has no valid name in the issuerRef",
    ],
    [
      null,
      { kind: "Secret", name: "x" },
      "is of kind Secret, which is not read",
      UNKNOWN,
    ],
  ];
  for (const [issuerCall, issuerRef, error, summary] of cases) {
    const c = ctx({});
    const cert = certificate({
      name: "hanging",
      namespace: "acme-test",
      status: issuingStatus,
      issuerRef,
    });
    await withCalls(
      [
        { args: ["get", CERTS, "hanging", "-n", "acme-test"], out: cert },
        ...(issuerCall ? [issuerCall] : []),
        { args: ["get", REQS, "-n", "acme-test"], out: list([]) },
      ],
      () =>
        m.trace.execute({ name: "hanging", namespace: "acme-test" }, c.context),
    );
    const t = TraceSchema.parse(c.written[1].data);
    assertEquals([t.issuer.found, t.issuer.error], [false, error]);
    assertEquals([t.stage, t.summary], [
      summary === UNKNOWN ? "certificate" : "issuer",
      summary,
    ]);
    assertEquals(t.issuer.missing, summary !== UNKNOWN);
  }
});

Deno.test("trace fails whole, and writes nothing, when a level of the chain cannot be read", async () => {
  const head: Call[] = [
    { args: ["get", CERTS, "hanging", "-n", "acme-test"], out: HANGING },
    {
      args: ["get", "clusterissuers.cert-manager.io", "acme-dns01"],
      out: clusterIssuer("acme-dns01"),
    },
  ];
  const reqs: Call = {
    args: ["get", REQS, "-n", "acme-test"],
    out: list([request("hanging-2", "2", OWNER)]),
  };
  const orders: Call = {
    args: ["get", ORDERS, "-n", "acme-test"],
    out: list([
      order("hanging-2-1", { uid: "uid-hanging-2", name: "hanging-2" }),
    ]),
  };
  const scripts: Array<[Call[], string]> = [
    [[{
      args: ["get", CERTS, "hanging", "-n", "acme-test"],
      fail: SAID.notFound(CERTS, "hanging"),
    }], "does not exist"],
    [[head[0], {
      args: ["get", "clusterissuers.cert-manager.io", "acme-dns01"],
      fail: "Unable to connect to the server: i/o timeout",
    }], "i/o timeout"],
    [[...head, {
      args: ["get", REQS, "-n", "acme-test"],
      ...forbiddenList(REQS, "acme-test"),
    }], "is forbidden"],
    [[...head, reqs, {
      args: ["get", ORDERS, "-n", "acme-test"],
      out: "<html>",
    }], "did not print JSON"],
    [[...head, reqs, orders, {
      args: ["get", CHALLENGES, "-n", "acme-test"],
      ...forbiddenList(CHALLENGES, "acme-test"),
    }], "is forbidden"],
  ];
  for (const [calls, text] of scripts) {
    const c = ctx({});
    await withCalls(calls, async () => {
      const e = await assertRejects(
        () =>
          m.trace.execute(
            { name: "hanging", namespace: "acme-test" },
            c.context,
          ),
        Error,
      );
      assertStringIncludes(e.message, text);
      assertNoSecrets(e.message);
    });
    assertEquals(c.written, []);
  }
});

Deno.test("currentRequest takes the highest revision the Certificate owns, the newest on a tie", () => {
  const pick = (reqs: Record<string, unknown>[]) =>
    (currentRequest(reqs, OWNER)?.metadata as { name: string } | undefined)
      ?.name;
  assertEquals(pick([]), undefined);
  assertEquals(
    pick([request("other", "5", { uid: "x", name: "other" })]),
    undefined,
  );
  assertEquals(
    pick([
      request("a-1", "1", OWNER),
      request("a-10", "10", OWNER),
      request("a-9", "9", OWNER),
    ]),
    "a-10",
  );
  assertEquals(
    pick([
      request("old", "2", OWNER, undefined, "2026-11-10T09:00:00Z"),
      request("new", "2", OWNER, undefined, "2026-11-10T10:00:00Z"),
    ]),
    "new",
  );
  assertEquals(
    pick([request("norev", undefined, OWNER), request("rev", "1", OWNER)]),
    "rev",
  );
  assertEquals(pick([request("by-name", "1", { name: "hanging" })]), "by-name");
});

Deno.test("diagnose names the challenge that is being worked on, not one that has not started, whatever their order", () => {
  const now = new Date("2026-11-10T10:00:00Z");
  const owner = { uid: "u", name: "o" };
  const started = parseChallenge(challenge("ch-started", owner), now);
  const waiting = parseChallenge(
    challenge("ch-waiting", owner, { status: null, wildcard: false }),
    now,
  );
  const done = parseChallenge(
    challenge("ch-done", owner, { status: { state: "valid" } }),
    now,
  );
  const base = {
    certificate: parseCertificate(certificate({ status: issuingStatus }), now),
    issuer: {
      name: "i",
      kind: "Issuer",
      group: "cert-manager.io",
      found: true,
      missing: false,
      ready: true,
      reason: "",
      message: "",
      error: null,
    },
    certificateRequest: null,
    order: null,
  };
  for (
    const challenges of [
      [started, waiting],
      [waiting, started],
      [done, waiting, started],
    ]
  ) {
    const d = diagnose({ ...base, challenges });
    assertEquals(d.stage, "challenge");
    assertStringIncludes(d.summary, "Challenge ch-started (DNS-01 for *.");
    assertStringIncludes(d.summary, "is pending, not presented: ");
  }
  assertEquals(
    diagnose({ ...base, challenges: [done, waiting] }).summary,
    "Challenge ch-waiting (DNS-01 for hang.example.test, solver dns01/webhook) is not started, not presented",
  );
  assertEquals(diagnose({ ...base, challenges: [done] }).stage, "certificate");
});

Deno.test("diagnose names the deepest level that is not done", () => {
  const now = new Date("2026-11-10T10:00:00Z");
  const issuing = parseCertificate(certificate({ status: issuingStatus }), now);
  const okIssuer = {
    name: "i",
    kind: "Issuer",
    group: "cert-manager.io",
    found: true,
    missing: false,
    ready: true,
    reason: "",
    message: "",
    error: null,
  };
  const base = {
    certificate: issuing,
    issuer: okIssuer,
    certificateRequest: null,
    order: null,
    challenges: [],
  };
  assertEquals(diagnose(base), {
    stage: "certificate",
    summary:
      "Certificate leaf is issuing: Issuing certificate as Secret does not exist",
  });
  assertEquals(
    diagnose({
      ...base,
      issuer: { ...okIssuer, ready: false, message: "no key pair" },
    }),
    { stage: "issuer", summary: "Issuer i is not Ready: no key pair" },
  );
  const unread = {
    ...okIssuer,
    found: false,
    ready: false,
    error: "could not be read: access was refused",
  };
  assertEquals(diagnose({ ...base, issuer: unread }).stage, "certificate");
  assertEquals(
    diagnose({ ...base, issuer: { ...unread, missing: true } }).stage,
    "issuer",
  );
  assertEquals(
    diagnose({ ...base, issuer: { ...okIssuer, ready: false } }).summary,
    "Issuer i is not Ready",
  );
  const expired = parseCertificate(
    certificate(),
    new Date("2027-01-01T00:00:00Z"),
  );
  assertEquals(
    diagnose({ ...base, certificate: expired }).summary.startsWith(
      "Certificate leaf is expired",
    ),
    true,
  );
  const notReady = parseCertificate(
    certificate({
      status: {
        conditions: [{
          type: "Ready",
          status: "False",
          reason: "Failed",
          message: "",
        }],
      },
    }),
    now,
  );
  assertEquals(diagnose({ ...base, certificate: notReady }), {
    stage: "certificate",
    summary: "Certificate leaf is not Ready: Failed",
  });
  assertEquals(
    diagnose({
      ...base,
      certificate: parseCertificate(certificate({ status: null }), now),
    }),
    { stage: "certificate", summary: "Certificate leaf is not Ready" },
  );
});

/** The conditions of the Ready fixture, as kubectl prints them. */
const READY_CONDITIONS =
  (certificate().status as { conditions: Record<string, unknown>[] })
    .conditions;

/** The patch call of a renewal: the body is on standard input, captured. */
const PATCH_ARGS = [
  "patch",
  CERTS,
  "leaf",
  "-n",
  "pki",
  "--subresource=status",
  "--type=merge",
  "--patch-file=/dev/stdin",
];

/** The Ready fixture as the server answers the trigger patch. */
const STILL = certificate({
  status: {
    ...(certificate().status as Record<string, unknown>),
    conditions: [
      ...READY_CONDITIONS,
      {
        type: "Issuing",
        status: "True",
        reason: "ManuallyTriggered",
        message: "Certificate re-issuance manually triggered",
      },
    ],
  },
});

/** The calls of a renewal that ends as `after`. */
function renewCalls(
  after: Array<Partial<Call>>,
  patched: Partial<Call> = { out: STILL },
  first: unknown = certificate(),
): Call[] {
  const read = ["get", CERTS, "leaf", "-n", "pki"];
  return [
    { args: read, out: first },
    { args: PATCH_ARGS, stdin: CAPTURE, ...patched },
    ...after.map((answer) => ({ args: read, ...answer })),
  ];
}

const ISSUED = certificate({
  status: {
    conditions: READY_CONDITIONS,
    notAfter: "2026-11-12T09:42:49Z",
    revision: 4,
  },
});

Deno.test("renew sets Issuing True as cmctl does, bound to the version it read, and records the new revision", async () => {
  const c = ctx({ namespace: "pki", kubeconfig: "/k" });
  await withCalls(
    renewCalls([{ out: STILL }, { out: ISSUED }]),
    async (k) => {
      await m.renew.execute({ name: "leaf" }, c.context);
      assertEquals(k.slept, [2000, 2000]);
      assertEquals(k.kubectl.map((call) => call.verb), [
        "get",
        "patch",
        "get",
        "get",
      ]);
      // The body is on standard input and in no argument.
      assertEquals(k.captured.length, 1);
      assertEquals(k.kubectl[1].patch, k.captured[0]);
      assertEquals(k.calls[1].args.join(" ").includes("Issuing"), false);
      const patch = JSON.parse(k.captured[0]);
      assertEquals(Object.keys(patch), ["metadata", "status"]);
      assertEquals(patch.metadata, { resourceVersion: "2028" });
      assertEquals(Object.keys(patch.status), ["conditions"]);
      assertEquals(patch.status.conditions.length, 2);
      assertEquals(patch.status.conditions[0], READY_CONDITIONS[0]);
      const issuing = patch.status.conditions[1];
      assertEquals(
        /^\d{4}-\d\d-\d\dT\d\d:\d\d:\d\dZ$/.test(issuing.lastTransitionTime),
        true,
      );
      assertEquals(
        Math.abs(Date.parse(issuing.lastTransitionTime) - Date.now()) < 5000,
        true,
      );
      assertEquals({ ...issuing, lastTransitionTime: "" }, {
        type: "Issuing",
        status: "True",
        reason: "ManuallyTriggered",
        message: "Certificate re-issuance manually triggered",
        lastTransitionTime: "",
        observedGeneration: 4,
      });
    },
    { kubeconfig: "/k" },
  );
  assertEquals(c.written.map((w) => [w.spec, w.name]), [
    ["certificate", "pki--leaf"],
    ["renewal", "renewal_pki--leaf"],
  ]);
  assertEquals(
    Object.keys(c.written[1].data as object).sort(),
    Object.keys(RenewalSchema.shape).sort(),
  );
  const r = RenewalSchema.parse(c.written[1].data);
  assertEquals(
    [
      r.outcome,
      r.revisionBefore,
      r.revisionAfter,
      r.notAfterBefore,
      r.notAfterAfter,
      r.issuing,
      r.waitedSeconds,
    ],
    ["issued", 3, 4, "2026-11-11T09:42:49Z", "2026-11-12T09:42:49Z", false, 4],
  );
  assertEquals((c.written[0].data as { revision: number }).revision, 4);
});

Deno.test("the patch writes every other condition back exactly as it was read: nothing redacted, shortened or dropped", async () => {
  // A merge patch replaces the whole conditions array. A message that looks
  // like a credential is blanked in every record, and must not be blanked
  // in the cluster by a renewal.
  const others = [
    {
      type: "Ready",
      status: "False",
      reason: "IncorrectIssuer",
      message: `Issuer said: password=${SECRETS[0]} bearer ${
        SECRETS[1]
      } https://u:p@acme.example.test ${"x".repeat(900)}`,
      lastTransitionTime: "2026-11-10T09:41:51Z",
      observedGeneration: 4,
    },
    { type: "Custom", status: "Unknown", extraField: { kept: [1, 2] } },
    { type: "NoStatus" },
    { type: "Empty", status: "True", reason: "", message: "" },
  ];
  const first = certificate({
    status: {
      conditions: [
        others[0],
        {
          type: "Issuing",
          status: "False",
          reason: "Failed",
          message: "old failure",
          lastTransitionTime: "2026-11-09T00:00:00Z",
        },
        ...others.slice(1),
        // Not conditions: left out of the patch.
        null,
        "x",
        7,
        { status: "True" },
        { type: "" },
        { type: 3 },
      ],
      revision: 3,
    },
  });
  const c = ctx({ namespace: "pki" });
  await withCalls(
    renewCalls([{ out: ISSUED }], { out: STILL }, first),
    async (k) => {
      await m.renew.execute({ name: "leaf" }, c.context);
      const patch = JSON.parse(k.captured[0]);
      assertEquals(patch.metadata, { resourceVersion: "2028" });
      const conditions = patch.status.conditions as Record<string, unknown>[];
      assertEquals(conditions.slice(0, -1), others);
      assertEquals(conditions.map((x) => x.type), [
        "Ready",
        "Custom",
        "NoStatus",
        "Empty",
        "Issuing",
      ]);
      assertEquals(conditions.at(-1)?.reason, "ManuallyTriggered");
      assertEquals(conditions.at(-1)?.status, "True");
      assertEquals(k.captured[0].includes("[redacted]"), false);
      assertEquals(k.captured[0].includes(SECRETS[0]), true);
    },
  );
  // The records and the log lines of the same run hold none of it.
  assertNoSecrets(c.written, c.logs);
});

Deno.test("renew refuses a Certificate that is already issuing, after one read and no write", async () => {
  const c = ctx({});
  await withCalls([{
    args: ["get", CERTS, "hanging", "-n", "acme-test"],
    out: HANGING,
  }], async () => {
    const e = await assertRejects(
      () =>
        m.renew.execute({ name: "hanging", namespace: "acme-test" }, c.context),
      Error,
    );
    assertStringIncludes(
      e.message,
      "is already issuing since 2026-11-10T09:41:45Z (DoesNotExist)",
    );
    assertStringIncludes(e.message, "renew is refused");
  });
  assertEquals(c.written, []);
});

Deno.test("renew refuses a Certificate that does not exist", async () => {
  const c = ctx({ namespace: "pki" });
  await withCalls([{
    args: ["get", CERTS, "nope", "-n", "pki"],
    fail: SAID.notFound(CERTS, "nope"),
  }], async () => {
    const e = await assertRejects(
      () => m.renew.execute({ name: "nope" }, c.context),
      Error,
    );
    assertEquals(e.message, "Certificate pki/nope does not exist");
  });
  assertEquals(c.written, []);
});

Deno.test("renew without a resourceVersion to bind to changes nothing", async () => {
  const c = ctx({ namespace: "pki" });
  await withCalls([{
    args: ["get", CERTS, "leaf", "-n", "pki"],
    out: certificate({ resourceVersion: null }),
  }], async () => {
    await assertRejects(
      () => m.renew.execute({ name: "leaf" }, c.context),
      Error,
      "without a resourceVersion",
    );
  });
  assertEquals(c.written, []);
});

/** A Certificate whose Ready message is easy to find again in an error. */
const MARKED = certificate({
  status: {
    conditions: [{
      type: "Ready",
      status: "True",
      reason: "Ready",
      message: `BODY-MARKER password=${SECRETS[0]}`,
    }],
    revision: 3,
  },
});

Deno.test("a refused, conflicting or failing patch is an error, nothing is recorded, and the body is in no message", async () => {
  const cases: Array<[Partial<Call>, string, boolean]> = [
    [
      {
        fail:
          'Error from server (Forbidden): certificates.cert-manager.io "leaf" is forbidden: User "system:serviceaccount:pki:reader" cannot patch resource "certificates/status" in API group "cert-manager.io" in the namespace "pki"',
      },
      "needs the patch verb on certificates/status",
      false,
    ],
    [
      { fail: SAID.conflict(CERTS, "leaf") },
      "changed between the read and the renewal; nothing was changed",
      false,
    ],
    [{ fail: "error: unknown flag: --subresource" }, "unknown flag", false],
    [
      {
        fail:
          "error: unable to read patch file: open /dev/stdin: no such device",
      },
      "unable to read patch file",
      false,
    ],
    [{ notInstalled: true }, "kubectl is not on PATH", false],
    [
      { fail: SAID.missingCrd("certificates") },
      "cert-manager is not installed",
      false,
    ],
    // Nobody knows whether these were applied, and the error says so.
    [
      {
        fail:
          "Unable to connect to the server: net/http: TLS handshake timeout",
      },
      "TLS handshake timeout",
      true,
    ],
    [{ fail: SAID.requestTimeout }, "Client.Timeout exceeded", true],
    [{ fail: SAID.refused }, "the cluster could not be reached", true],
    [{ hang: true }, "no answer within 35 seconds", true],
    [
      { out: "certificate.cert-manager.io/leaf patched" },
      "did not print JSON",
      true,
    ],
    [{ out: "" }, "did not print JSON", true],
    [{ out: {} }, "did not return Certificate pki/leaf", true],
    [{ out: list([STILL]) }, "did not return Certificate pki/leaf", true],
    [
      { out: certificate({ name: "other" }) },
      "did not return Certificate pki/leaf",
      true,
    ],
  ];
  for (const [answer, text, unknown] of cases) {
    const c = ctx({ namespace: "pki" });
    await withCalls(renewCalls([], answer, MARKED), async (k) => {
      const e = await assertRejects(
        () => m.renew.execute({ name: "leaf" }, c.context),
        Error,
      );
      assertStringIncludes(e.message, text);
      assertStringIncludes(k.captured[0], "BODY-MARKER");
      assertEquals(
        e.message.includes("the renewal may have been triggered") &&
          e.message.includes("Read the Certificate with get"),
        unknown,
        e.message,
      );
      assertEquals(e.cause, undefined);
      assertNoSecrets(e.message);
      assertEquals(e.message.length < 800, true);
    });
    assertEquals(c.written, []);
  }
});

Deno.test("a server that repeats the patch in its error: no part of the body reaches the message, whole, cut or already altered", async () => {
  // How a server may repeat the body it calls invalid.
  const echoes: Array<(body: string) => string> = [
    (body) =>
      `The request is invalid: patch: Invalid value: ${
        JSON.stringify(body)
      }: bad`,
    (body) => `The request is invalid: patch: Invalid value: ${body}`,
    // Cut in the middle of a value, so no whole value is left to match.
    (body) =>
      `The request is invalid: ${
        JSON.stringify(body.slice(0, body.indexOf("BODY-MARKER") + 14))
      }`,
    (body) => `Error from server (BadRequest): ${"x".repeat(250)} ${body}`,
    // Only one condition message, with no JSON around it.
    () => `error: bad message: BODY-MARKER password=${SECRETS[0]}`,
    () =>
      `Error from server (Forbidden): is forbidden: BODY-MARKER password=${
        SECRETS[0]
      }`,
  ];
  for (const echo of echoes) {
    const c = ctx({ namespace: "pki" });
    let sent = "";
    await withCalls(
      [{ args: ["get", CERTS, "leaf", "-n", "pki"], out: MARKED }],
      async () => {
        const e = await assertRejects(
          () => m.renew.execute({ name: "leaf" }, c.context),
          Error,
        );
        // The fake did repeat the body, marker included.
        assertStringIncludes(echo(sent), "BODY-MARKER");
        assertEquals(e.message.includes("BODY-MARKER"), false, e.message);
        assertEquals(e.message.includes("ManuallyTriggered"), false);
        assertEquals(e.message.includes("resourceVersion"), false);
        assertEquals(e.message.includes("2028"), false);
        assertEquals(e.cause, undefined);
        assertNoSecrets(e.message);
        assertEquals(e.message.length < 800, true);
      },
      {
        handler: (call) => {
          if (call.verb !== "patch") return undefined;
          sent = call.patch ?? "";
          return { fail: echo(sent) };
        },
      },
    );
    assertEquals(c.written, []);
  }
});

Deno.test("a run cancelled while the patch is out says the renewal may have been triggered", async () => {
  const stop = new AbortController();
  const c = ctx({ namespace: "pki" }, stop.signal);
  await withCalls(
    renewCalls([], { hang: "until-cancelled" }),
    async (k) => {
      const run = m.renew.execute({ name: "leaf" }, c.context);
      while (k.kubectl.length < 2) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      stop.abort();
      const e = await assertRejects(() => run, Error);
      assertStringIncludes(e.message, "the renewal may have been triggered");
      assertStringIncludes(e.message, "was cancelled");
    },
  );
  assertEquals(c.written, []);
});

Deno.test("a patch that the server answered without the change is an error: unapplied is not success", async () => {
  const answers = [
    certificate(),
    {},
    certificate({
      status: {
        conditions: [{
          type: "Issuing",
          status: "True",
          reason: "Renewing",
          message: "",
        }],
      },
    }),
    certificate({
      status: {
        conditions: [{
          type: "Issuing",
          status: "False",
          reason: "ManuallyTriggered",
          message: "",
        }],
      },
    }),
  ];
  for (const answer of answers) {
    const c = ctx({ namespace: "pki" });
    await withCalls(renewCalls([], { out: answer }), async () => {
      const e = await assertRejects(
        () => m.renew.execute({ name: "leaf" }, c.context),
        Error,
      );
      assertStringIncludes(
        e.message,
        answer === answers[1]
          ? "did not return Certificate"
          : "was not applied",
      );
    });
    assertEquals(c.written, []);
  }
  const c = ctx({ namespace: "pki" });
  await withCalls(
    renewCalls([], { out: "certificate.cert-manager.io/leaf patched" }),
    async () => {
      await assertRejects(
        () => m.renew.execute({ name: "leaf" }, c.context),
        Error,
        "did not print JSON",
      );
    },
  );
  assertEquals(c.written, []);
});

Deno.test("renew stops polling at waitSeconds and records an issuance still in progress", async () => {
  const c = ctx({ namespace: "pki" });
  await withCalls(
    renewCalls([{ out: STILL }, { out: STILL }, { out: STILL }]),
    async (k) => {
      await m.renew.execute({ name: "leaf", waitSeconds: 5 }, c.context);
      assertEquals(k.slept, [2000, 2000, 1000]);
    },
  );
  const r = RenewalSchema.parse(c.written[1].data);
  assertEquals(
    [
      r.outcome,
      r.issuing,
      r.issuingReason,
      r.revisionBefore,
      r.revisionAfter,
      r.waitedSeconds,
    ],
    ["in-progress", true, "ManuallyTriggered", 3, 3, 5],
  );
});

Deno.test("slow reads count as waiting: the poll cannot run far past waitSeconds", async () => {
  const c = ctx({ namespace: "pki" });
  // Every read after the trigger takes ten seconds of the fake clock.
  let slow = () => {};
  const read = ["get", CERTS, "leaf", "-n", "pki"].join(" ");
  let reads = 0;
  await withCalls(
    renewCalls([]),
    async (k) => {
      slow = () => k.advance(10_000);
      await m.renew.execute({ name: "leaf", waitSeconds: 20 }, c.context);
      assertEquals(k.slept, [2000, 2000]);
      assertEquals(reads, 2);
    },
    {
      handler: (call) => {
        if (call.command.join(" ") !== read) return undefined;
        reads++;
        slow();
        return { out: STILL };
      },
    },
  );
  const r = RenewalSchema.parse(c.written[1].data);
  assertEquals([r.outcome, r.waitedSeconds], ["in-progress", 24]);
});

Deno.test("renew with waitSeconds 0 records the state right after the trigger", async () => {
  const c = ctx({ namespace: "pki" });
  await withCalls(renewCalls([]), async (k) => {
    await m.renew.execute({ name: "leaf", waitSeconds: 0 }, c.context);
    assertEquals(k.slept, []);
  });
  const r = RenewalSchema.parse(c.written[1].data);
  assertEquals([r.outcome, r.waitedSeconds], ["in-progress", 0]);
});

Deno.test("renew records an issuance that failed or ended without a new revision", async () => {
  const failed = certificate({
    status: {
      conditions: [
        { type: "Ready", status: "True", reason: "Ready", message: "" },
        {
          type: "Issuing",
          status: "False",
          reason: "Failed",
          message: "The certificate request has failed to complete",
        },
      ],
      revision: 3,
      failedIssuanceAttempts: 1,
      notAfter: "2026-11-11T09:42:49Z",
    },
  });
  const c = ctx({ namespace: "pki" });
  await withCalls(
    renewCalls([{ out: failed }]),
    () => m.renew.execute({ name: "leaf" }, c.context),
  );
  const r = RenewalSchema.parse(c.written[1].data);
  assertEquals(
    [
      r.outcome,
      r.issuingReason,
      r.failedIssuanceAttempts,
      r.revisionAfter,
      r.ready,
    ],
    ["failed", "Failed", 1, 3, true],
  );

  const d = ctx({ namespace: "pki" });
  await withCalls(
    renewCalls([{ out: certificate() }]),
    () => m.renew.execute({ name: "leaf" }, d.context),
  );
  assertEquals(
    (d.written[1].data as { outcome: string }).outcome,
    "not-issued",
  );
});

Deno.test("a read that fails during the poll ends the poll and is recorded: the trigger was applied", async () => {
  const cases: Array<[Partial<Call>, string]> = [
    [
      { fail: "Unable to connect to the server: EOF" },
      "Unable to connect to the server",
    ],
    [{ fail: SAID.badToken }, "did not accept the credentials"],
    [{ hang: true }, "no answer within 35 seconds"],
    [{ out: "<html>" }, "did not print JSON"],
    [{ out: list([]) }, "did not return Certificate pki/leaf"],
    [{ fail: `error: token=${SECRETS[0]} refused` }, "token=[redacted]"],
  ];
  for (const [answer, text] of cases) {
    const c = ctx({ namespace: "pki" });
    await withCalls(
      renewCalls([answer]),
      () => m.renew.execute({ name: "leaf" }, c.context),
    );
    const r = RenewalSchema.parse(c.written[1].data);
    assertEquals([r.outcome, r.issuing, r.waitedSeconds], [
      "in-progress",
      true,
      2,
    ]);
    assertStringIncludes(r.pollError ?? "", text);
    assertEquals((r.pollError ?? "").length <= 303, true);
    assertNoSecrets(c.written, c.logs);
  }
});

Deno.test("a run cancelled while the poll reads is cancelled: it is not recorded as a failed read", async () => {
  const stop = new AbortController();
  const c = ctx({ namespace: "pki" }, stop.signal);
  await withCalls(
    renewCalls([{ hang: "until-cancelled" }]),
    async (k) => {
      const run = m.renew.execute({ name: "leaf" }, c.context);
      // Let the method reach the read that hangs, then cancel the run.
      while (k.kubectl.length < 3) {
        await new Promise((resolve) => setTimeout(resolve, 0));
      }
      stop.abort();
      const e = await assertRejects(() => run, KubectlError);
      assertEquals(e.kind, "cancelled");
      assertStringIncludes(e.message, "was cancelled");
    },
  );
  assertEquals(c.written, []);
});

Deno.test("a run cancelled between two reads, or before the patch, ends without a record", async () => {
  // Cancelled right after the patch was answered: the wait rejects, and no
  // further read is made.
  const waiting = new AbortController();
  const c = ctx({ namespace: "pki" }, waiting.signal);
  await withCalls(
    [{ args: ["get", CERTS, "leaf", "-n", "pki"], out: certificate() }],
    async (k) => {
      await assertRejects(
        () => m.renew.execute({ name: "leaf" }, c.context),
        Error,
        "cancelled",
      );
      assertEquals(k.kubectl.map((call) => call.verb), ["get", "patch"]);
      assertEquals(k.slept, []);
    },
    {
      handler: (call) => {
        if (call.verb !== "patch") return undefined;
        queueMicrotask(() => waiting.abort());
        return { out: STILL };
      },
    },
  );
  assertEquals(c.written, []);

  // Cancelled before anything ran: the first read is cancelled, no patch.
  const before = new AbortController();
  before.abort();
  const d = ctx({ namespace: "pki" }, before.signal);
  await withCalls(
    [{ args: ["get", CERTS, "leaf", "-n", "pki"], out: certificate() }],
    async (k) => {
      const e = await assertRejects(
        () => m.renew.execute({ name: "leaf" }, d.context),
        KubectlError,
      );
      assertEquals(e.kind, "cancelled");
      assertEquals(k.kubectl.map((call) => call.verb), ["get"]);
    },
  );
  assertEquals(d.written, []);
});

Deno.test("a Certificate deleted during the poll is recorded: the trigger was applied, and the Certificate gets no record of its own", async () => {
  const c = ctx({ namespace: "pki" });
  await withCalls(
    renewCalls([{ out: STILL }, { fail: SAID.notFound(CERTS, "leaf") }]),
    () => m.renew.execute({ name: "leaf" }, c.context),
  );
  assertEquals(c.written.map((w) => [w.spec, w.name]), [
    ["renewal", "renewal_pki--leaf"],
  ]);
  const r = RenewalSchema.parse(c.written[0].data);
  assertEquals(
    [
      r.outcome,
      r.pollError,
      r.revisionBefore,
      r.revisionAfter,
      r.waitedSeconds,
    ],
    ["deleted", "Certificate pki/leaf does not exist", 3, 3, 4],
  );
  assertEquals(c.logs.some((l) => l.includes('"outcome":"deleted"')), true);
});

Deno.test("withIssuingTrue replaces an old Issuing condition and keeps the others as they were", () => {
  const now = new Date("2026-11-10T10:00:00.789Z");
  const ready = {
    type: "Ready",
    status: "True",
    reason: "",
    message: "",
    lastTransitionTime: null,
    observedGeneration: null,
  };
  const out = withIssuingTrue(
    [
      {
        type: "Issuing",
        status: "False",
        reason: "Failed",
        message: "x",
        lastTransitionTime: "t0",
        observedGeneration: 1,
      },
      ready,
    ],
    null,
    now,
  );
  assertEquals(out, [
    ready,
    {
      type: "Issuing",
      status: "True",
      reason: "ManuallyTriggered",
      message: "Certificate re-issuance manually triggered",
      lastTransitionTime: "2026-11-10T10:00:00Z",
    },
  ]);
  assertEquals(out[0] === ready, true);
  for (const junk of [undefined, null, "x", 7, {}, { conditions: [] }]) {
    const only = withIssuingTrue(junk, 2, now);
    assertEquals(only.length, 1);
    assertEquals(only[0].observedGeneration, 2);
  }
});
