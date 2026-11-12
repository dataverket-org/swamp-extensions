import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  classReasons,
  GatewayClassSchema,
  model,
  parseGatewayClass,
} from "./gatewayclass.ts";
import { acceptedClass, cond } from "./test_support.ts";
import { forbidden, harness, list } from "./stub_test.ts";

const AT = "2026-11-10T09:00:00.000Z";

Deno.test("an accepted class reads whole and is healthy", () => {
  const r = parseGatewayClass(acceptedClass(), AT);
  GatewayClassSchema.parse(r);
  assertEquals(r.name, "example");
  assertEquals(r.controllerName, "example.org/gateway-controller");
  assertEquals(r.parametersRef, {
    group: "example.org",
    kind: "Config",
    name: "default",
    namespace: "infra",
  });
  assertEquals(r.supportedFeatures, ["Gateway", "HTTPRoute"]);
  assertEquals(r.summary, {
    accepted: true,
    acceptedReason: "Accepted",
    acceptedMessage: "",
    supportedVersion: null,
    statusCurrent: true,
    healthy: true,
    unhealthy: [],
  });
  assertEquals(classReasons(r), []);
});

Deno.test("a class nobody accepted, or with bad parameters, is recorded as such", () => {
  const pending = acceptedClass();
  delete pending.status;
  delete (pending.spec as Record<string, unknown>).parametersRef;
  const p = parseGatewayClass(pending, AT);
  GatewayClassSchema.parse(p);
  assertEquals(p.parametersRef, null);
  assertEquals(p.supportedFeatures, []);
  assertEquals(p.summary.accepted, null);
  assertEquals(p.summary.healthy, false);
  assertEquals(classReasons(p), ["class: Accepted=missing (NotReported)"]);
  assertEquals(p.summary.unhealthy, [{
    condition: "Accepted",
    status: null,
    reason: "NotReported",
    message: "no Accepted condition is reported",
  }]);

  const bad = acceptedClass();
  (bad.status as Record<string, unknown>).conditions = [
    cond("Accepted", "False", "InvalidParameters", "Config not found"),
  ];
  (bad.status as Record<string, unknown>).supportedFeatures = ["Gateway", 3];
  const b = parseGatewayClass(bad, AT);
  assertEquals(b.summary.accepted, false);
  assertEquals(b.summary.acceptedMessage, "Config not found");
  assertEquals(b.supportedFeatures, ["Gateway"]);
  assertEquals(classReasons(b), ["class: Accepted=False (InvalidParameters)"]);
  assertEquals(b.summary.unhealthy, [{
    condition: "Accepted",
    status: "False",
    reason: "InvalidParameters",
    message: "Config not found",
  }]);

  const stale = acceptedClass();
  (stale.metadata as Record<string, unknown>).generation = 4;
  const s = parseGatewayClass(stale, AT);
  assertEquals(s.summary.healthy, false);
  assertEquals(classReasons(s), ["class: StaleStatus"]);
  assertEquals(s.summary.unhealthy.map((u) => [u.condition, u.reason]), [
    [null, "StaleStatus"],
  ]);
});

Deno.test("SupportedVersion False makes an accepted class unhealthy, with the reason", () => {
  // "Best effort" support: accepted, on CRDs of a version it does not know.
  const c = acceptedClass();
  (c.status as Record<string, unknown>).conditions = [
    cond("Accepted", "True", "Accepted"),
    cond("SupportedVersion", "False", "UnsupportedVersion", "CRDs are v9"),
  ];
  const p = parseGatewayClass(c, AT);
  GatewayClassSchema.parse(p);
  assertEquals(p.summary.accepted, true);
  assertEquals(p.summary.supportedVersion, false);
  assertEquals(p.summary.healthy, false);
  assertEquals(p.summary.unhealthy, [{
    condition: "SupportedVersion",
    status: "False",
    reason: "UnsupportedVersion",
    message: "CRDs are v9",
  }]);
  assertEquals(classReasons(p), [
    "class: SupportedVersion=False (UnsupportedVersion)",
  ]);

  // True, Unknown and missing say nothing against the class.
  for (const status of ["True", "Unknown"]) {
    const ok = acceptedClass();
    (ok.status as Record<string, unknown>).conditions = [
      cond("Accepted", "True", "Accepted"),
      cond("SupportedVersion", status, "SupportedVersion"),
    ];
    const q = parseGatewayClass(ok, AT);
    assertEquals(q.summary.supportedVersion, status === "True" ? true : null);
    assertEquals(q.summary.healthy, true, status);
    assertEquals(q.summary.unhealthy, []);
  }

  // Not accepted and unsupported: both are named.
  const both = acceptedClass();
  (both.status as Record<string, unknown>).conditions = [
    cond("Accepted", "False", "UnsupportedVersion"),
    cond("SupportedVersion", "False", "UnsupportedVersion"),
  ];
  assertEquals(classReasons(parseGatewayClass(both, AT)), [
    "class: Accepted=False (UnsupportedVersion)",
    "class: SupportedVersion=False (UnsupportedVersion)",
  ]);
});

// ───── the methods, through createModelTestContext with a stub kubectl ─────

const RESOURCE = "gatewayclasses.gateway.networking.k8s.io";

Deno.test("list records every GatewayClass of the cluster and one inventory, ignoring the definition's namespace", async () => {
  using h = harness({
    [`kubectl get ${RESOURCE}`]: { stdout: list([acceptedClass()]) },
  }, { globalArgs: { namespace: "infra" } });
  await model.methods.list.execute({}, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [
    ["gatewayclass", "example"],
    ["inventory", "inventory_all"],
  ]);
  assertEquals(w[0].data.controllerName, "example.org/gateway-controller");
  assertEquals([w[1].data.count, w[1].data.unhealthyCount], [1, 0]);
  assertEquals(
    h.logs().includes(
      "Recorded {count} GatewayClasses, {unhealthy} not accepted",
    ),
    true,
  );
});

Deno.test("list passes on an RBAC refusal with the verbs it needs, and records nothing", async () => {
  using h = harness({
    [`kubectl get ${RESOURCE}`]: forbidden("list", RESOURCE),
  });
  await assertRejects(
    () => model.methods.list.execute({}, h.context),
    Error,
    "refused by RBAC; the identity needs get and list on",
  );
  assertEquals(h.written(), []);
});

Deno.test("get records one GatewayClass by name and logs whether it is accepted", async () => {
  using h = harness({
    [`kubectl get ${RESOURCE} example`]: { stdout: acceptedClass() },
  });
  await model.methods.get.execute({ name: "example" }, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [["gatewayclass", "example"]]);
  assertEquals((w[0].data.summary as Record<string, unknown>).accepted, true);
  assertEquals(
    h.logs().includes("GatewayClass {name}: accepted={accepted}"),
    true,
  );
});

Deno.test("get refuses a name that is not a Kubernetes name before kubectl runs", async () => {
  using h = harness({});
  await assertRejects(
    () => model.methods.get.execute({ name: "--all" }, h.context),
    Error,
  );
  assertEquals([h.calls, h.written()], [[], []]);
});
