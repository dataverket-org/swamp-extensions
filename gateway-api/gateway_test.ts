import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { KubectlError } from "../lib/kubectl.ts";
import {
  gatewayReasons,
  GatewaySchema,
  model as gateway,
  parseGateway,
  selectorSummary,
} from "./gateway.ts";
import { ListInventorySchema } from "./_helpers.ts";
import { cond, ctx, healthyGateway, withCluster } from "./test_support.ts";

const AT = "2026-11-10T09:00:00.000Z";
const RES = "gateways.gateway.networking.k8s.io";

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

Deno.test("list records every Gateway and an inventory, in one namespace or all", async () => {
  const broken = healthyGateway();
  (broken.metadata as Record<string, unknown>).name = "broken";
  (broken.metadata as Record<string, unknown>).namespace = "other";
  delete broken.status;
  const cluster = { context: "c1", kubeconfig: "/k" };
  await withCluster(
    { ...cluster, objects: { gateways: [healthyGateway(), broken] } },
    async (k) => {
      const all = ctx(cluster);
      const out = await gateway.methods.list.execute({}, all.context);
      assertEquals(k.calls[0].args, [
        "--kubeconfig",
        "/k",
        "--context",
        "c1",
        "--request-timeout=30s",
        "get",
        RES,
        "-A",
        "-o",
        "json",
      ]);
      assertEquals(all.written.map((w) => [w.spec, w.name]), [
        ["gateway", "infra--edge"],
        ["gateway", "other--broken"],
        ["inventory", "inventory_all"],
      ]);
      assertEquals(out.dataHandles.length, 3);
      for (const w of all.written.slice(0, 2)) GatewaySchema.parse(w.data);
      const inv = ListInventorySchema.parse(all.written[2].data);
      assertEquals(inv.namespace, null);
      assertEquals(inv.count, 2);
      assertEquals(inv.healthyCount, 1);
      assertEquals(inv.unhealthyCount, 1);
      assertEquals(inv.allHealthy, false);
      assertEquals(inv.unhealthy.map((u) => u.name), ["broken"]);
      assertEquals(inv.apiVersions, ["gateway.networking.k8s.io/v1"]);
      // The shared core: one line per object, with one reason when unhealthy.
      assertEquals(inv.items, [
        {
          namespace: "infra",
          name: "edge",
          dataName: "infra--edge",
          healthy: true,
          reason: null,
        },
        {
          namespace: "other",
          name: "broken",
          dataName: "other--broken",
          healthy: false,
          reason: "gateway: Accepted=missing (NotReported) (and 2 more)",
        },
      ]);
      assertEquals(all.warnings, []);

      const one = ctx({ ...cluster, namespace: "other" });
      await gateway.methods.list.execute({ namespace: "infra" }, one.context);
      assertEquals(k.kubectl[1].command, ["get", RES, "-n", "infra"]);
      assertEquals(one.written.map((w) => w.name), [
        "infra--edge",
        "inventory_ns_infra",
      ]);
      assertEquals(one.written[1].data.allHealthy, true);

      const empty = ctx({ ...cluster, namespace: "nothing-here" });
      await gateway.methods.list.execute({}, empty.context);
      assertEquals(empty.written.map((w) => w.name), [
        "inventory_ns_nothing-here",
      ]);
      assertEquals(empty.written[0].data.count, 0);

      // An empty argument counts as not given: the definition's is read.
      const blank = ctx({ ...cluster, namespace: "other" });
      await gateway.methods.list.execute({ namespace: "" }, blank.context);
      assertEquals(k.kubectl[3].command, ["get", RES, "-n", "other"]);
      assertEquals(blank.written.map((w) => w.name), [
        "other--broken",
        "inventory_ns_other",
      ]);
    },
  );
});

Deno.test("get records one Gateway; an unhealthy one is a record, not an error", async () => {
  const g = healthyGateway();
  (g.status as Record<string, unknown>).conditions = [
    cond("Accepted", "True", "Accepted"),
    cond("Programmed", "False", "AddressNotAssigned"),
  ];
  await withCluster({ objects: { gateways: [g] } }, async (k) => {
    const c = ctx({ namespace: "infra" });
    await gateway.methods.get.execute({ name: "edge" }, c.context);
    assertEquals(k.kubectl[0].command, ["get", RES, "edge", "-n", "infra"]);
    assertEquals(c.written.map((w) => [w.spec, w.name]), [
      ["gateway", "infra--edge"],
    ]);
    const r = GatewaySchema.parse(c.written[0].data);
    assertEquals(r.summary.programmed, false);
    assertEquals(r.summary.healthy, false);

    // An empty namespace argument falls back to the definition's.
    const blank = ctx({ namespace: "infra" });
    await gateway.methods.get.execute(
      { name: "edge", namespace: "" },
      blank.context,
    );
    assertEquals(k.kubectl[1].command, ["get", RES, "edge", "-n", "infra"]);
  });
});

Deno.test("a version other than v1 is read, recorded and warned about", async () => {
  const g = healthyGateway();
  g.apiVersion = "gateway.networking.k8s.io/v1beta1";
  await withCluster({ objects: { gateways: [g] } }, async () => {
    const c = ctx();
    await gateway.methods.list.execute({}, c.context);
    assertEquals(
      c.written[0].data.apiVersion,
      "gateway.networking.k8s.io/v1beta1",
    );
    assertEquals(c.written[1].data.apiVersions, [
      "gateway.networking.k8s.io/v1beta1",
    ]);
    assertEquals(c.warnings.length, 1);
    assertStringIncludes(c.warnings[0], "v1beta1");
    const one = ctx({ namespace: "infra" });
    await gateway.methods.get.execute({ name: "edge" }, one.context);
    assertEquals(one.warnings.length, 1);
  });
});

Deno.test("an answer that is not the Gateway asked for is refused, not recorded", async () => {
  const other = healthyGateway();
  (other.metadata as Record<string, unknown>).name = "another";
  const route = { ...healthyGateway(), kind: "HTTPRoute" };
  for (const answer of [other, route]) {
    await withCluster(
      { stdoutOverride: JSON.stringify(answer) },
      async () => {
        const c = ctx();
        const e = await assertRejects(
          () =>
            gateway.methods.get.execute(
              { name: "edge", namespace: "infra" },
              c.context,
            ),
          KubectlError,
        );
        assertEquals(e.kind, "other");
        assertStringIncludes(e.message, "did not return Gateway infra/edge");
        assertEquals(c.written, []);
      },
    );
  }
  // A list that holds another kind is refused whole.
  await withCluster(
    {
      stdoutOverride: JSON.stringify({
        kind: "List",
        items: [healthyGateway(), route],
      }),
    },
    async () => {
      const c = ctx();
      const e = await assertRejects(
        () => gateway.methods.list.execute({}, c.context),
        KubectlError,
      );
      assertStringIncludes(e.message, "item 1 is of kind");
      assertEquals(c.written, []);
    },
  );
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
