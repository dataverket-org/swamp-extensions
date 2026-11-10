import { assertEquals } from "jsr:@std/assert@1.0.13";
import { ListInventorySchema } from "./_helpers.ts";
import {
  classReasons,
  GatewayClassSchema,
  model as gatewayclass,
  parseGatewayClass,
} from "./gatewayclass.ts";
import { acceptedClass, cond, ctx, withCluster } from "./test_support.ts";

const AT = "2026-11-10T09:00:00.000Z";
const RES = "gatewayclasses.gateway.networking.k8s.io";

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

Deno.test("a GatewayClass at a version other than v1 is read, recorded and warned about", async () => {
  const c = acceptedClass();
  c.apiVersion = "gateway.networking.k8s.io/v1beta1";
  await withCluster({ objects: { gatewayclasses: [c] } }, async () => {
    const l = ctx();
    await gatewayclass.methods.list.execute({}, l.context);
    assertEquals(
      l.written[0].data.apiVersion,
      "gateway.networking.k8s.io/v1beta1",
    );
    assertEquals(l.written[1].data.apiVersions, [
      "gateway.networking.k8s.io/v1beta1",
    ]);
    assertEquals(l.warnings.length, 1);
    assertEquals(l.warnings[0].includes("GatewayClasses"), true);
    assertEquals(l.warnings[0].includes("v1beta1"), true);
    const one = ctx();
    await gatewayclass.methods.get.execute({ name: "example" }, one.context);
    assertEquals(one.warnings.length, 1);
  });
  await withCluster(
    { objects: { gatewayclasses: [acceptedClass()] } },
    async () => {
      const l = ctx();
      await gatewayclass.methods.list.execute({}, l.context);
      assertEquals(l.warnings, []);
    },
  );
});

Deno.test("list and get read the cluster-scoped resource without a namespace", async () => {
  const refused = acceptedClass();
  (refused.metadata as Record<string, unknown>).name = "refused";
  (refused.status as Record<string, unknown>).conditions = [
    cond("Accepted", "False", "InvalidParameters"),
  ];
  await withCluster(
    { objects: { gatewayclasses: [acceptedClass(), refused] } },
    async (k) => {
      const c = ctx({ namespace: "ignored-here" });
      await gatewayclass.methods.list.execute({}, c.context);
      assertEquals(k.calls[0].args, [
        "--request-timeout=30s",
        "get",
        RES,
        "-o",
        "json",
      ]);
      assertEquals(c.written.map((w) => [w.spec, w.name]), [
        ["gatewayclass", "example"],
        ["gatewayclass", "refused"],
        ["inventory", "inventory_all"],
      ]);
      const inv = ListInventorySchema.parse(c.written[2].data);
      assertEquals(inv.namespace, null);
      assertEquals(inv.items, [{
        namespace: null,
        name: "example",
        dataName: "example",
        healthy: true,
        reason: null,
      }, {
        namespace: null,
        name: "refused",
        dataName: "refused",
        healthy: false,
        reason: "class: Accepted=False (InvalidParameters)",
      }]);

      const one = ctx();
      await gatewayclass.methods.get.execute({ name: "example" }, one.context);
      assertEquals(k.kubectl[1].command, ["get", RES, "example"]);
      assertEquals(one.written.map((w) => w.name), ["example"]);
    },
  );
});
