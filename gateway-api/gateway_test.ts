import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  gatewayReasons,
  GatewaySchema,
  model,
  parseGateway,
  RESOURCE,
  selectorSummary,
} from "./gateway.ts";
import { cond, healthyGateway, healthyRoute } from "./test_support.ts";
import { forbidden, harness, list } from "./stub_test.ts";

const AT = "2026-11-10T09:00:00.000Z";

function withListener(
  status: Record<string, unknown> | undefined,
  spec: Record<string, unknown> = {},
): Record<string, unknown> {
  const g = healthyGateway();
  const s = g.spec as { listeners: Record<string, unknown>[] };
  s.listeners[0] = { ...s.listeners[0], ...spec };
  const st = g.status as { listeners: unknown[] };
  st.listeners = status === undefined ? [] : [{ name: "https", ...status }];
  return g;
}

Deno.test("a healthy Gateway reads whole and is healthy", () => {
  const r = parseGateway(healthyGateway(), AT);
  GatewaySchema.parse(r);
  assertEquals(r.name, "edge");
  assertEquals(r.namespace, "infra");
  assertEquals(r.apiVersion, "gateway.networking.k8s.io/v1");
  assertEquals(r.gatewayClassName, "example");
  assertEquals(r.addresses, {
    spec: [{ type: "IPAddress", value: "192.0.2.10" }],
    status: [{ type: "IPAddress", value: "192.0.2.10" }],
  });
  const l = r.listeners[0];
  assertEquals(l.name, "https");
  assertEquals(l.hostname, "*.example.org");
  assertEquals(l.port, 443);
  assertEquals(l.protocol, "HTTPS");
  assertEquals(l.tls, {
    mode: "Terminate",
    certificateRefs: [{
      group: "",
      kind: "Secret",
      name: "wildcard",
      namespace: "infra",
    }],
  });
  assertEquals(l.allowedRoutes, {
    namespacesFrom: "Selector",
    namespaceSelector: "routes=allowed",
    kinds: [],
  });
  assertEquals(l.attachedRoutes, 1);
  assertEquals(l.supportedKinds.map((k) => k.kind), ["HTTPRoute", "GRPCRoute"]);
  assertEquals(
    [l.accepted, l.programmed, l.refsResolved, l.conflicted],
    [true, true, true, null],
  );
  assertEquals(r.summary, {
    accepted: true,
    programmed: true,
    statusCurrent: true,
    hasAddress: true,
    listenerCount: 1,
    attachedRoutes: 1,
    allListenersAccepted: true,
    allListenersProgrammed: true,
    allListenersRefsResolved: true,
    anyListenerConflicted: false,
    leftoverListenerReports: 0,
    healthy: true,
    unhealthy: [],
  });
  assertEquals(r.observedAt, AT);
});

Deno.test("a certificate reference that does not resolve is named with the controller's reason", () => {
  const r = parseGateway(
    withListener({
      attachedRoutes: 0,
      conditions: [
        cond("Accepted", "True", "Accepted"),
        cond(
          "ResolvedRefs",
          "False",
          "InvalidCertificateRef",
          "Secret infra/wildcard does not exist",
        ),
        cond("Programmed", "False", "Invalid", "Listener is invalid"),
      ],
    }),
    AT,
  );
  assertEquals(r.summary.healthy, false);
  assertEquals(r.summary.allListenersRefsResolved, false);
  assertEquals(r.summary.allListenersProgrammed, false);
  assertEquals(r.summary.allListenersAccepted, true);
  assertEquals(r.summary.unhealthy, [
    {
      listener: "https",
      condition: "Programmed",
      status: "False",
      reason: "Invalid",
      message: "Listener is invalid",
    },
    {
      listener: "https",
      condition: "ResolvedRefs",
      status: "False",
      reason: "InvalidCertificateRef",
      message: "Secret infra/wildcard does not exist",
    },
  ]);
  assertEquals(gatewayReasons(r), [
    "listener https: Programmed=False (Invalid)",
    "listener https: ResolvedRefs=False (InvalidCertificateRef)",
  ]);
});

Deno.test("a conflicted listener is unhealthy; Conflicted False or Unknown is not", () => {
  const base = [
    cond("Accepted", "True", "Accepted"),
    cond("Programmed", "True", "Programmed"),
    cond("ResolvedRefs", "True", "ResolvedRefs"),
  ];
  const conflicted = parseGateway(
    withListener({
      conditions: [...base, cond("Conflicted", "True", "HostnameConflict")],
    }),
    AT,
  );
  assertEquals(conflicted.summary.anyListenerConflicted, true);
  assertEquals(conflicted.summary.healthy, false);
  assertEquals(conflicted.summary.unhealthy[0].reason, "HostnameConflict");
  for (const status of ["False", "Unknown"]) {
    const ok = parseGateway(
      withListener({
        conditions: [...base, cond("Conflicted", status, "NoConflicts")],
      }),
      AT,
    );
    assertEquals(ok.summary.anyListenerConflicted, false);
    assertEquals(ok.summary.healthy, true);
  }
});

Deno.test("a Gateway that is not programmed says so at the Gateway level", () => {
  const g = healthyGateway();
  (g.status as Record<string, unknown>).conditions = [
    cond("Accepted", "True", "Accepted"),
    cond("Programmed", "False", "AddressNotAssigned", "No addresses assigned"),
  ];
  (g.status as Record<string, unknown>).addresses = [];
  const r = parseGateway(g, AT);
  assertEquals(r.summary.programmed, false);
  assertEquals(r.summary.accepted, true);
  assertEquals(r.summary.hasAddress, false);
  assertEquals(r.summary.healthy, false);
  assertEquals(r.summary.unhealthy, [{
    listener: null,
    condition: "Programmed",
    status: "False",
    reason: "AddressNotAssigned",
    message: "No addresses assigned",
  }]);
});

Deno.test("no status at all reads as null, not healthy, every gap named", () => {
  const g = healthyGateway();
  delete g.status;
  const r = parseGateway(g, AT);
  GatewaySchema.parse(r);
  assertEquals(r.summary.accepted, null);
  assertEquals(r.summary.programmed, null);
  assertEquals(r.summary.statusCurrent, null);
  assertEquals(r.summary.healthy, false);
  assertEquals(r.listeners[0].reported, false);
  assertEquals(r.listeners[0].attachedRoutes, null);
  assertEquals(r.summary.allListenersProgrammed, false);
  assertEquals(r.summary.unhealthy.map((u) => [u.listener, u.reason]), [
    [null, "NotReported"],
    [null, "NotReported"],
    ["https", "NotReported"],
  ]);
});

Deno.test("an Unknown condition is null and unhealthy, with its reason", () => {
  const g = healthyGateway();
  (g.status as Record<string, unknown>).conditions = [
    cond("Accepted", "Unknown", "Pending", "Waiting for controller"),
    cond("Programmed", "Unknown", "Pending"),
  ];
  const r = parseGateway(g, AT);
  assertEquals(r.summary.accepted, null);
  assertEquals(r.summary.healthy, false);
  assertEquals(r.summary.unhealthy[0], {
    listener: null,
    condition: "Accepted",
    status: "Unknown",
    reason: "Pending",
    message: "Waiting for controller",
  });
});

Deno.test("a listener with a status entry but missing conditions is not healthy", () => {
  const r = parseGateway(
    withListener({ conditions: [cond("Accepted", "True", "Accepted")] }),
    AT,
  );
  assertEquals(r.summary.healthy, false);
  assertEquals(r.summary.unhealthy.map((u) => [u.condition, u.reason]), [
    ["Programmed", "NotReported"],
    ["ResolvedRefs", "NotReported"],
  ]);
});

Deno.test("conditions observed at an older generation make the Gateway stale", () => {
  const g = healthyGateway();
  (g.metadata as Record<string, unknown>).generation = 5;
  const r = parseGateway(g, AT);
  assertEquals(r.summary.statusCurrent, false);
  assertEquals(r.summary.healthy, false);
  assertEquals(r.summary.unhealthy.map((u) => u.reason), ["StaleStatus"]);
  assertEquals(gatewayReasons(r), ["gateway: StaleStatus"]);
});

Deno.test("malformed and partial objects are read without throwing", () => {
  const r = parseGateway({
    metadata: { name: "g", namespace: "n" },
    spec: {
      listeners: [
        { name: "a", port: "80", tls: {}, allowedRoutes: "x" },
        "junk",
        { name: "b", allowedRoutes: { namespaces: { from: "Selector" } } },
      ],
      addresses: [{ type: "IPAddress" }, "x"],
    },
    status: {
      conditions: "nope",
      listeners: [{ attachedRoutes: 2 }, { name: "a", attachedRoutes: "3" }],
      addresses: { not: "a list" },
    },
  }, AT);
  GatewaySchema.parse(r);
  assertEquals(r.gatewayClassName, null);
  assertEquals(r.apiVersion, "");
  assertEquals(r.generation, null);
  assertEquals(r.addresses, { spec: [], status: [] });
  assertEquals(r.listeners.map((l) => l.name), ["a", "", "b"]);
  assertEquals(r.listeners[0].port, null);
  assertEquals(r.listeners[0].tls, { mode: null, certificateRefs: [] });
  assertEquals(r.listeners[0].attachedRoutes, null);
  assertEquals(r.listeners[0].reported, true);
  assertEquals(r.listeners[2].allowedRoutes.namespaceSelector, null);
  assertEquals(r.summary.healthy, false);
  const none = parseGateway({ metadata: { name: "g", namespace: "n" } }, AT);
  assertEquals(none.summary.unhealthy.map((u) => u.reason), [
    "NotReported",
    "NotReported",
    "NoListeners",
  ]);
});

Deno.test("selectorSummary writes labels and expressions in words", () => {
  assertEquals(selectorSummary(undefined), null);
  assertEquals(selectorSummary({}), "(every namespace)");
  assertEquals(
    selectorSummary({
      matchLabels: { a: "1" },
      matchExpressions: [
        { key: "t", operator: "In", values: ["x", "y"] },
        { key: "u", operator: "Exists" },
      ],
    }),
    "a=1, t In (x,y), u Exists",
  );
});

Deno.test("nothing outside the read fields reaches the record", () => {
  const r = parseGateway(healthyGateway(), AT);
  assertEquals(JSON.stringify(r).includes("ANNOTATION-SECRET-VALUE"), false);
  assertEquals(JSON.stringify(r).includes("annotations"), false);
});

Deno.test("an accepted, programmed Gateway without an address is healthy, and says it has none", () => {
  // The controller's verdict on a missing address is Programmed; this
  // extension does not second-guess it.
  const g = healthyGateway();
  delete (g.status as Record<string, unknown>).addresses;
  const r = parseGateway(g, AT);
  GatewaySchema.parse(r);
  assertEquals(r.summary.hasAddress, false);
  assertEquals(r.addresses.status, []);
  assertEquals(r.summary.programmed, true);
  assertEquals(r.summary.healthy, true);
  assertEquals(r.summary.unhealthy, []);
  // The controller saying so is what makes it unhealthy.
  (g.status as Record<string, unknown>).conditions = [
    cond("Accepted", "True", "Accepted"),
    cond("Programmed", "False", "AddressNotAssigned"),
  ];
  const n = parseGateway(g, AT);
  assertEquals(n.summary.healthy, false);
  assertEquals(n.summary.unhealthy.map((u) => [u.condition, u.reason]), [
    ["Programmed", "AddressNotAssigned"],
  ]);
});

Deno.test("a status entry for a listener no longer in the spec is counted, not judged", () => {
  // A listener was renamed or removed and the controller kept its entry.
  const g = healthyGateway();
  (g.status as { listeners: unknown[] }).listeners.push(
    {
      name: "removed",
      attachedRoutes: 3,
      conditions: [cond("Programmed", "False", "Invalid")],
    },
    { attachedRoutes: 1 },
  );
  const r = parseGateway(g, AT);
  GatewaySchema.parse(r);
  assertEquals(r.listeners.map((l) => l.name), ["https"]);
  assertEquals(r.summary.leftoverListenerReports, 2);
  assertEquals(r.summary.attachedRoutes, 1);
  assertEquals(r.summary.healthy, true);
  assertEquals(r.summary.unhealthy, []);
  assertEquals(r.summary.statusCurrent, true);
  // The same name twice in the status is one entry too many.
  const twice = healthyGateway();
  const st = twice.status as { listeners: unknown[] };
  st.listeners.push(st.listeners[0]);
  assertEquals(parseGateway(twice, AT).summary.leftoverListenerReports, 1);
});

// ───── the methods, through createModelTestContext with a stub kubectl ─────

Deno.test("list records each Gateway of the namespace and one inventory, and logs the count", async () => {
  const bad = healthyGateway();
  (bad.metadata as Record<string, unknown>).name = "broken";
  (bad.status as Record<string, unknown>).conditions = [
    cond("Accepted", "True", "Accepted"),
    cond("Programmed", "False", "AddressNotAssigned", "no address"),
  ];
  using h = harness({
    [`kubectl get ${RESOURCE} -n infra`]: {
      stdout: list([healthyGateway(), bad]),
    },
  }, { globalArgs: { namespace: "infra" } });
  await model.methods.list.execute({}, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [
    ["gateway", "infra--edge"],
    ["gateway", "infra--broken"],
    ["inventory", "inventory_ns_infra"],
  ]);
  assertEquals(
    (w[0].data.summary as Record<string, unknown>).healthy,
    true,
  );
  assertEquals([w[2].data.count, w[2].data.unhealthyCount], [2, 1]);
  assertEquals(
    h.logs().includes("Recorded {count} Gateways, {unhealthy} not healthy"),
    true,
  );
  assertEquals(JSON.stringify(w).includes("ANNOTATION-SECRET-VALUE"), false);
});

Deno.test("list says the Gateway API is not installed when the cluster does not serve it, and records nothing", async () => {
  using h = harness({
    [`kubectl get ${RESOURCE} -A`]: {
      code: 1,
      stderr: 'error: the server doesn\'t have a resource type "gateways"',
    },
  });
  await assertRejects(
    () => model.methods.list.execute({}, h.context),
    Error,
    "The Gateway API CRDs are not installed",
  );
  assertEquals(h.written(), []);
});

Deno.test("get records one Gateway under its namespace and name", async () => {
  using h = harness({
    [`kubectl get ${RESOURCE} edge -n infra`]: { stdout: healthyGateway() },
  });
  await model.methods.get.execute(
    { name: "edge", namespace: "infra" },
    h.context,
  );
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [["gateway", "infra--edge"]]);
  assertEquals(w[0].data.name, "edge");
  assertEquals(
    h.logs().includes(
      "Gateway {name}: healthy={healthy}, programmed={programmed}, {findings} findings",
    ),
    true,
  );
});

Deno.test("get passes on an RBAC refusal with the verbs it needs, and records nothing", async () => {
  using h = harness({
    [`kubectl get ${RESOURCE} edge -n infra`]: forbidden("get", RESOURCE),
  });
  await assertRejects(
    () =>
      model.methods.get.execute(
        { name: "edge", namespace: "infra" },
        h.context,
      ),
    Error,
    "the identity needs get and list on",
  );
  assertEquals(h.written(), []);
});

Deno.test("get refuses an answer that is not the Gateway asked for", async () => {
  using h = harness({
    [`kubectl get ${RESOURCE} edge -n infra`]: { stdout: healthyRoute() },
  });
  await assertRejects(
    () =>
      model.methods.get.execute(
        { name: "edge", namespace: "infra" },
        h.context,
      ),
    Error,
    "kubectl did not return Gateway infra/edge",
  );
  assertEquals(h.written(), []);
});
