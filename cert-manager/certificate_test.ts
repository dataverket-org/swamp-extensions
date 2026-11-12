import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  currentRequest,
  diagnose,
  model,
  withIssuingTrue,
} from "./certificate.ts";
import { parseCertificate, parseChallenge } from "./_records.ts";
import { forbidden, harness, list, notFound } from "./stub_test.ts";
import {
  assertNoSecrets,
  certificate,
  challenge,
  clusterIssuer,
  issuingStatus,
  order,
  request,
} from "./test_support.ts";

const OWNER = { uid: "uid-hanging", name: "hanging" };

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

// ───── the methods, through createModelTestContext with a stub kubectl ─────

const M = model.methods;
const C = "certificates.cert-manager.io";

Deno.test("list records each Certificate and one inventory", async () => {
  using h = harness({
    [`kubectl get ${C} -n pki`]: {
      stdout: list([
        certificate(),
        certificate({ name: "web", uid: "u2", status: issuingStatus }),
      ]),
    },
  });
  await M.list.execute({ namespace: "pki" }, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [
    ["certificate", "pki--leaf"],
    ["certificate", "pki--web"],
    ["inventory", "inventory_ns_pki"],
  ]);
  assertEquals([w[0].data.ready, w[0].data.revision], [true, 3]);
  assertEquals([w[1].data.ready, w[1].data.issuing], [false, true]);
  // The fixture's expiry is a fixed date, so health depends on today.
  assertStringIncludes(h.logs().at(-1) ?? "", "Found 2 Certificate objects, ");
});

Deno.test("list refuses an answer that is not a List and records nothing", async () => {
  using h = harness({
    [`kubectl get ${C} -n pki`]: { stdout: certificate() },
  });
  await assertRejects(
    () => M.list.execute({ namespace: "pki" }, h.context),
    Error,
    "did not return a list",
  );
  assertEquals(h.written(), []);
});

Deno.test("get records one Certificate", async () => {
  using h = harness({
    [`kubectl get ${C} leaf -n pki`]: { stdout: certificate() },
  });
  await M.get.execute({ name: "leaf", namespace: "pki" }, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name, x.data.notAfter]), [
    ["certificate", "pki--leaf", "2026-11-11T09:42:49Z"],
  ]);
  assertEquals(h.logs().at(-1), "Read Certificate leaf");
});

Deno.test("get passes on a refusal and records nothing", async () => {
  using h = harness({
    [`kubectl get ${C} leaf -n pki`]: forbidden("get", C),
  });
  await assertRejects(
    () => M.get.execute({ name: "leaf", namespace: "pki" }, h.context),
    Error,
    "forbidden",
  );
  assertEquals(h.written(), []);
});

const HANGING = { uid: "uid-hanging", name: "hanging" };

Deno.test("trace walks to the Challenge, records the Certificate and the trace, and blanks the ACME values", async () => {
  using h = harness({
    [`kubectl get ${C} hanging -n acme-test`]: {
      stdout: certificate({
        name: "hanging",
        namespace: "acme-test",
        uid: HANGING.uid,
        status: issuingStatus,
        issuerRef: { kind: "ClusterIssuer", name: "acme-dns01" },
      }),
    },
    "kubectl get clusterissuers.cert-manager.io acme-dns01": {
      stdout: clusterIssuer("acme-dns01"),
    },
    "kubectl get certificaterequests.cert-manager.io -n acme-test": {
      stdout: list([
        request("hanging-1", "1", HANGING),
        request("other-1", "4", { uid: "x", name: "other" }),
      ]),
    },
    "kubectl get orders.acme.cert-manager.io -n acme-test": {
      stdout: list([order("o1", { uid: "uid-hanging-1", name: "hanging-1" })]),
    },
    "kubectl get challenges.acme.cert-manager.io -n acme-test": {
      stdout: list([challenge("ch1", { uid: "uid-o1", name: "o1" })]),
    },
  });
  await M.trace.execute(
    { name: "hanging", namespace: "acme-test" },
    h.context,
  );
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [
    ["certificate", "acme-test--hanging"],
    ["trace", "trace_acme-test--hanging"],
  ]);
  const t = w[1].data as Record<string, Record<string, unknown>> & {
    stage: string;
    challenges: unknown[];
  };
  assertEquals(t.stage, "challenge");
  assertEquals(t.issuer.ready, true);
  assertEquals(t.certificateRequest.name, "hanging-1");
  assertEquals(t.order.name, "o1");
  assertEquals(t.challenges.length, 1);
  assertStringIncludes(h.logs().at(-1) ?? "", "Trace of hanging: challenge: ");
  assertNoSecrets(w, h.logs());
});

Deno.test("trace of a missing Certificate says so and records nothing", async () => {
  using h = harness({
    [`kubectl get ${C} gone -n acme-test`]: notFound(C, "gone"),
  });
  await assertRejects(
    () => M.trace.execute({ name: "gone", namespace: "acme-test" }, h.context),
    Error,
    "Certificate acme-test/gone does not exist",
  );
  assertEquals(h.written(), []);
});

const PATCH =
  `kubectl patch ${C} leaf -n pki --subresource=status --type=merge --patch-file=/dev/stdin`;

const triggered = certificate({
  status: {
    conditions: [
      { type: "Ready", status: "True", reason: "Ready", message: "" },
      {
        type: "Issuing",
        status: "True",
        reason: "ManuallyTriggered",
        message: "Certificate re-issuance manually triggered",
      },
    ],
    revision: 3,
  },
});

Deno.test("renew patches the status with the read resourceVersion and records the Certificate and the renewal", async () => {
  using h = harness({
    [`kubectl get ${C} leaf -n pki`]: { stdout: certificate() },
    [PATCH]: { stdout: triggered },
  });
  await M.renew.execute(
    { name: "leaf", namespace: "pki", waitSeconds: 0 },
    h.context,
  );
  const body = JSON.parse(h.calls[1].stdin ?? "{}");
  assertEquals(body.metadata, { resourceVersion: "2028" });
  assertEquals(
    body.status.conditions.find((c: { type: string }) => c.type === "Issuing")
      .reason,
    "ManuallyTriggered",
  );
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [
    ["certificate", "pki--leaf"],
    ["renewal", "renewal_pki--leaf"],
  ]);
  assertEquals(
    [w[1].data.outcome, w[1].data.revisionBefore, w[1].data.issuing],
    ["in-progress", 3, true],
  );
  assertEquals(
    h.logs().at(-1),
    "Renewal of leaf: in-progress, revision 3 to 3",
  );
});

Deno.test("renew refuses a Certificate that is already issuing and sends no patch", async () => {
  using h = harness({
    [`kubectl get ${C} leaf -n pki`]: {
      stdout: certificate({ status: issuingStatus }),
    },
  });
  await assertRejects(
    () => M.renew.execute({ name: "leaf", namespace: "pki" }, h.context),
    Error,
    "renew is refused while an issuance is in progress",
  );
  assertEquals([h.calls.length, h.written()], [1, []]);
});

Deno.test("renew says nothing changed on a conflict and records nothing", async () => {
  using h = harness({
    [`kubectl get ${C} leaf -n pki`]: { stdout: certificate() },
    [PATCH]: {
      code: 1,
      stderr:
        `Error from server (Conflict): Operation cannot be fulfilled on certificates.cert-manager.io "leaf": the object has been modified`,
    },
  });
  await assertRejects(
    () => M.renew.execute({ name: "leaf", namespace: "pki" }, h.context),
    Error,
    "changed between the read and the renewal; nothing was changed",
  );
  assertEquals(h.written(), []);
});

Deno.test("renew names the missing permission on a refused patch", async () => {
  using h = harness({
    [`kubectl get ${C} leaf -n pki`]: { stdout: certificate() },
    [PATCH]: forbidden("patch", "certificates/status"),
  });
  await assertRejects(
    () => M.renew.execute({ name: "leaf", namespace: "pki" }, h.context),
    Error,
    "it needs the patch verb on certificates/status",
  );
  assertEquals(h.written(), []);
});
