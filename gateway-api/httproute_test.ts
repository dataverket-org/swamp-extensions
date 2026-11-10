import { assertEquals } from "jsr:@std/assert@1.0.13";
import { ListInventorySchema } from "./_helpers.ts";
import {
  HttpRouteSchema,
  model as httproute,
  parentLabel,
  parseHttpRoute,
  readMatch,
  routeReasons,
} from "./httproute.ts";
import { cond, ctx, healthyRoute, withCluster } from "./test_support.ts";

const AT = "2026-11-10T09:00:00.000Z";
const RES = "httproutes.gateway.networking.k8s.io";
const GROUP = "gateway.networking.k8s.io";

function withParentConditions(conditions: unknown[]): Record<string, unknown> {
  const r = healthyRoute();
  const parents = (r.status as { parents: Record<string, unknown>[] }).parents;
  parents[0].conditions = conditions;
  return r;
}

Deno.test("a healthy HTTPRoute reads whole and is healthy", () => {
  const r = parseHttpRoute(healthyRoute(), AT);
  HttpRouteSchema.parse(r);
  assertEquals(r.hostnames, ["app.example.org"]);
  const parent = {
    group: GROUP,
    kind: "Gateway",
    namespace: "infra",
    name: "edge",
    sectionName: "https",
    port: null,
  };
  assertEquals(r.parentRefs, [parent]);
  assertEquals(r.rules, [{
    name: null,
    matches: [{
      path: { type: "PathPrefix", value: "/api" },
      method: "GET",
      headers: 1,
      queryParams: 0,
      summary: "GET PathPrefix /api headers:1",
    }],
    filters: ["RequestHeaderModifier"],
    backendRefs: [{
      group: "",
      kind: "Service",
      name: "app",
      namespace: "apps",
      port: 8080,
      weight: 1,
    }],
  }]);
  assertEquals(r.parents.length, 1);
  assertEquals(r.parents[0].parentRef, parent);
  assertEquals(r.parents[0].controllerName, "example.org/gateway-controller");
  assertEquals(r.parents[0].requested, true);
  assertEquals(r.parents[0].accepted, true);
  assertEquals(r.parents[0].refsResolved, true);
  assertEquals(r.parents[0].partiallyInvalid, false);
  assertEquals(r.parents[0].current, true);
  assertEquals(r.parents[0].judged, true);
  assertEquals(r.parents[0].notJudgedBecause, null);
  assertEquals(r.summary, {
    parentCount: 1,
    reportedParentCount: 1,
    leftoverParentReports: 0,
    refusedListenerReports: 0,
    backendCount: 1,
    statusCurrent: true,
    partiallyInvalid: false,
    allParentsAccepted: true,
    allRefsResolved: true,
    healthy: true,
    unhealthy: [],
  });
});

Deno.test("a backend that does not exist is ResolvedRefs False with the reason", () => {
  const r = parseHttpRoute(
    withParentConditions([
      cond("Accepted", "True", "Accepted", "", 2),
      cond(
        "ResolvedRefs",
        "False",
        "BackendNotFound",
        "Service apps/app not found",
        2,
      ),
    ]),
    AT,
  );
  assertEquals(r.summary.allParentsAccepted, true);
  assertEquals(r.summary.allRefsResolved, false);
  assertEquals(r.summary.healthy, false);
  assertEquals(r.summary.unhealthy, [{
    parent: "infra/edge/https",
    controllerName: "example.org/gateway-controller",
    condition: "ResolvedRefs",
    status: "False",
    reason: "BackendNotFound",
    message: "Service apps/app not found",
  }]);
  assertEquals(routeReasons(r), [
    "parent infra/edge/https (example.org/gateway-controller): ResolvedRefs=False (BackendNotFound)",
  ]);
});

Deno.test("a parent that rejects the route is Accepted False with the reason", () => {
  const r = parseHttpRoute(
    withParentConditions([
      cond("Accepted", "False", "NoMatchingListenerHostname", "no match", 2),
      cond("ResolvedRefs", "True", "ResolvedRefs", "", 2),
    ]),
    AT,
  );
  assertEquals(r.parents[0].accepted, false);
  assertEquals(r.summary.allParentsAccepted, false);
  assertEquals(r.summary.allRefsResolved, true);
  assertEquals(r.summary.unhealthy.map((u) => u.reason), [
    "NoMatchingListenerHostname",
  ]);
});

Deno.test("a parent nobody reported on is named, and nothing is accepted", () => {
  const r = healthyRoute();
  (r.spec as { parentRefs: unknown[] }).parentRefs.push({ name: "ghost" });
  const p = parseHttpRoute(r, AT);
  assertEquals(p.parentRefs[1], {
    group: GROUP,
    kind: "Gateway",
    namespace: "apps",
    name: "ghost",
    sectionName: null,
    port: null,
  });
  assertEquals(p.summary.parentCount, 2);
  assertEquals(p.summary.reportedParentCount, 1);
  assertEquals(p.summary.allParentsAccepted, false);
  assertEquals(p.summary.allRefsResolved, false);
  assertEquals(p.summary.healthy, false);
  assertEquals(p.summary.unhealthy.map((u) => [u.parent, u.reason]), [
    ["apps/ghost", "NotReported"],
  ]);

  const none = healthyRoute();
  delete none.status;
  const q = parseHttpRoute(none, AT);
  HttpRouteSchema.parse(q);
  assertEquals(q.parents, []);
  assertEquals(q.summary.statusCurrent, null);
  assertEquals(q.summary.allParentsAccepted, false);
  assertEquals(q.summary.unhealthy.map((u) => u.reason), ["NotReported"]);
});

Deno.test("a route with no parents is not healthy", () => {
  const r = healthyRoute();
  delete (r.spec as Record<string, unknown>).parentRefs;
  delete r.status;
  const p = parseHttpRoute(r, AT);
  assertEquals(p.summary.parentCount, 0);
  assertEquals(p.summary.allParentsAccepted, false);
  assertEquals(p.summary.healthy, false);
  assertEquals(p.summary.unhealthy.map((u) => u.reason), ["NoParentRefs"]);
});

Deno.test("two controllers on one parent are both judged", () => {
  const r = healthyRoute();
  const parents = (r.status as { parents: Record<string, unknown>[] }).parents;
  parents.push({
    ...parents[0],
    controllerName: "other.example/controller",
    conditions: [cond("Accepted", "False", "NotAllowedByListeners", "", 2)],
  });
  const p = parseHttpRoute(r, AT);
  assertEquals(p.summary.reportedParentCount, 1);
  assertEquals(p.summary.allParentsAccepted, false);
  assertEquals(
    p.summary.unhealthy.map((u) => [u.controllerName, u.condition, u.reason]),
    [
      ["other.example/controller", "Accepted", "NotAllowedByListeners"],
      ["other.example/controller", "ResolvedRefs", "NotReported"],
    ],
  );
});

Deno.test("a report left behind for a section no longer asked for is recorded, not judged", () => {
  // A listener was renamed, the route followed, and the controller kept its
  // old refusal for the old name at the old generation.
  const r = healthyRoute();
  const parents = (r.status as { parents: Record<string, unknown>[] }).parents;
  parents.push({
    controllerName: "example.org/gateway-controller",
    parentRef: {
      group: GROUP,
      kind: "Gateway",
      name: "edge",
      namespace: "infra",
      sectionName: "https-old-name",
    },
    conditions: [
      cond("Accepted", "False", "NoMatchingParent", "No listeners match", 1),
      cond("ResolvedRefs", "True", "ResolvedRefs", "", 1),
    ],
  });
  const p = parseHttpRoute(r, AT);
  assertEquals(p.parents.map((x) => x.requested), [true, false]);
  assertEquals(p.parents[1].accepted, false);
  assertEquals(p.summary.leftoverParentReports, 1);
  assertEquals(p.summary.statusCurrent, true);
  assertEquals(p.summary.allParentsAccepted, true);
  assertEquals(p.summary.healthy, true);
  assertEquals(p.summary.unhealthy, []);
});

Deno.test("conditions observed at an older generation make the route stale", () => {
  const r = healthyRoute();
  (r.metadata as Record<string, unknown>).generation = 9;
  const p = parseHttpRoute(r, AT);
  assertEquals(p.summary.statusCurrent, false);
  assertEquals(p.summary.healthy, false);
  assertEquals(p.parents[0].current, false);
  // The finding says whose report is old, and on which parent.
  assertEquals(
    p.summary.unhealthy.map((
      u,
    ) => [u.parent, u.controllerName, u.condition, u.reason]),
    [[
      "infra/edge/https",
      "example.org/gateway-controller",
      null,
      "StaleStatus",
    ]],
  );
});

Deno.test("malformed and partial routes are read without throwing", () => {
  const p = parseHttpRoute({
    metadata: { name: "r", namespace: "n" },
    spec: {
      hostnames: ["a.example", 7, null],
      parentRefs: "x",
      rules: [
        "junk",
        {
          name: "r1",
          matches: [{}, { path: {} }, { queryParams: [{}, {}] }],
          filters: [{}, { type: "RequestRedirect" }],
          backendRefs: [{}, { name: "s", namespace: "o", port: "80" }],
        },
      ],
    },
    status: { parents: [{}, "junk", { parentRef: { name: "p" } }] },
  }, AT);
  HttpRouteSchema.parse(p);
  assertEquals(p.hostnames, ["a.example"]);
  assertEquals(p.rules[0].backendRefs, []);
  assertEquals(p.rules[1].matches.map((m) => m.summary), [
    "(everything)",
    "PathPrefix /",
    "query:2",
  ]);
  assertEquals(p.rules[1].filters, ["RequestRedirect"]);
  assertEquals(p.rules[1].backendRefs[1], {
    group: "",
    kind: "Service",
    name: "s",
    namespace: "o",
    port: null,
    weight: null,
  });
  assertEquals(p.parents.length, 3);
  assertEquals(p.parents.map((x) => x.requested), [false, false, false]);
  assertEquals(p.summary.leftoverParentReports, 3);
  assertEquals(p.summary.healthy, false);
  assertEquals(p.summary.unhealthy.map((u) => u.reason), ["NoParentRefs"]);
});

Deno.test("readMatch and parentLabel write what a person reads", () => {
  assertEquals(
    readMatch({ method: "POST", path: { type: "Exact", value: "/x" } }).summary,
    "POST Exact /x",
  );
  assertEquals(
    parentLabel({
      group: GROUP,
      kind: "Gateway",
      namespace: "a",
      name: "b",
      sectionName: "s",
      port: 443,
    }),
    "a/b/s:443",
  );
});

Deno.test("list records every HTTPRoute and an inventory; get records one", async () => {
  const bad = withParentConditions([
    cond("Accepted", "True", "Accepted", "", 2),
    cond("ResolvedRefs", "False", "BackendNotFound", "", 2),
  ]);
  (bad.metadata as Record<string, unknown>).name = "bad";
  await withCluster(
    { objects: { httproutes: [healthyRoute(), bad] } },
    async (k) => {
      const c = ctx({ namespace: "apps" });
      await httproute.methods.list.execute({}, c.context);
      assertEquals(k.calls[0].args, [
        "--request-timeout=30s",
        "get",
        RES,
        "-n",
        "apps",
        "-o",
        "json",
      ]);
      assertEquals(c.written.map((w) => [w.spec, w.name]), [
        ["httproute", "apps--app"],
        ["httproute", "apps--bad"],
        ["inventory", "inventory_ns_apps"],
      ]);
      const inv = ListInventorySchema.parse(c.written[2].data);
      assertEquals(inv.unhealthy, [{
        namespace: "apps",
        name: "bad",
        reasons: [
          "parent infra/edge/https (example.org/gateway-controller): ResolvedRefs=False (BackendNotFound)",
        ],
      }]);
      assertEquals(inv.items.map((i) => [i.dataName, i.reason]), [
        ["apps--app", null],
        [
          "apps--bad",
          "parent infra/edge/https (example.org/gateway-controller): ResolvedRefs=False (BackendNotFound)",
        ],
      ]);

      const all = ctx();
      await httproute.methods.list.execute({ namespace: "" }, all.context);
      assertEquals(k.kubectl[1].command, ["get", RES, "-A"]);
      assertEquals(all.written[2].name, "inventory_all");

      const one = ctx();
      await httproute.methods.get.execute(
        { name: "bad", namespace: "apps" },
        one.context,
      );
      assertEquals(k.kubectl[2].command, ["get", RES, "bad", "-n", "apps"]);
      assertEquals(one.written.map((w) => w.name), ["apps--bad"]);
      assertEquals(
        HttpRouteSchema.parse(one.written[0].data).summary.healthy,
        false,
      );
    },
  );
});

Deno.test("a route with a leftover parent report is listed as healthy, and the report is counted", async () => {
  const r = healthyRoute();
  (r.status as { parents: Record<string, unknown>[] }).parents.push({
    controllerName: "example.org/gateway-controller",
    parentRef: {
      group: GROUP,
      kind: "Gateway",
      name: "edge",
      namespace: "infra",
      sectionName: "https-old-name",
    },
    conditions: [
      cond("Accepted", "False", "NoMatchingParent", "No listeners match", 1),
    ],
  });
  await withCluster({ objects: { httproutes: [r] } }, async () => {
    const c = ctx();
    await httproute.methods.list.execute({}, c.context);
    const stored = HttpRouteSchema.parse(c.written[0].data);
    assertEquals(stored.summary.healthy, true);
    assertEquals(stored.summary.leftoverParentReports, 1);
    const inv = ListInventorySchema.parse(c.written[1].data);
    assertEquals(inv.allHealthy, true);
    assertEquals(inv.items[0].reason, null);
  });
});

const CTRL = "example.org/gateway-controller";

/** A route with these spec parents and these reports, at generation 5. */
function routeWith(
  parentRefs: Record<string, unknown>[],
  reports: Array<{
    ref: Record<string, unknown>;
    conditions: unknown[];
    controllerName?: string;
  }>,
): Record<string, unknown> {
  const r = healthyRoute();
  (r.metadata as Record<string, unknown>).generation = 5;
  (r.spec as Record<string, unknown>).parentRefs = parentRefs;
  (r.status as Record<string, unknown>).parents = reports.map((p) => ({
    controllerName: p.controllerName ?? CTRL,
    parentRef: { group: GROUP, kind: "Gateway", ...p.ref },
    conditions: p.conditions,
  }));
  return r;
}

const EDGE = { name: "edge", namespace: "infra" };
const fine = (generation = 5) => [
  cond("Accepted", "True", "Accepted", "", generation),
  cond("ResolvedRefs", "True", "ResolvedRefs", "", generation),
];
const refused = (reason: string, generation = 5) => [
  cond("Accepted", "False", reason, "refused", generation),
  cond("ResolvedRefs", "True", "ResolvedRefs", "", generation),
];
const findings = (p: ReturnType<typeof parseHttpRoute>) =>
  p.summary.unhealthy.map((
    u,
  ) => [u.parent, u.controllerName, u.condition, u.reason]);

const HTTP = { ...EDGE, sectionName: "http" };
const HTTPS = { ...EDGE, sectionName: "https" };
const roles = (p: ReturnType<typeof parseHttpRoute>) =>
  p.parents.map((x) => [x.judged, x.notJudgedBecause]);

Deno.test("a parent named without a listener is attached when one listener accepts; the refusing one is counted", () => {
  // An HTTP and an HTTPS listener; the HTTPS one rightly refuses the route.
  for (
    const reports of [
      [
        { ref: HTTP, conditions: fine() },
        { ref: HTTPS, conditions: refused("NotAllowedByListeners") },
      ],
      [
        { ref: HTTPS, conditions: refused("NotAllowedByListeners") },
        { ref: HTTP, conditions: fine() },
      ],
    ]
  ) {
    const p = parseHttpRoute(routeWith([EDGE], reports), AT);
    HttpRouteSchema.parse(p);
    assertEquals(p.parents.map((x) => x.requested), [true, true]);
    const refusing = p.parents.find((x) => x.accepted === false)!;
    assertEquals(refusing.judged, false);
    assertEquals(refusing.notJudgedBecause, "another-listener-accepted");
    assertEquals(p.summary.refusedListenerReports, 1);
    assertEquals(p.summary.leftoverParentReports, 0);
    assertEquals(p.summary.parentCount, 1);
    assertEquals(p.summary.reportedParentCount, 1);
    assertEquals(p.summary.allParentsAccepted, true);
    assertEquals(p.summary.healthy, true);
    assertEquals(p.summary.unhealthy, []);
  }
  // The same holds for a parent named by port and no listener.
  const byPort = parseHttpRoute(
    routeWith([{ ...EDGE, port: 443 }], [
      { ref: { ...HTTPS, port: 443 }, conditions: fine() },
      {
        ref: { ...EDGE, sectionName: "https-b", port: 443 },
        conditions: refused("NoMatchingListenerHostname"),
      },
    ]),
    AT,
  );
  assertEquals(byPort.summary.healthy, true);
  assertEquals(byPort.summary.refusedListenerReports, 1);
});

Deno.test("when every listener refuses, the parent is not accepted and each refusal is a finding", () => {
  const p = parseHttpRoute(
    routeWith([EDGE], [
      { ref: HTTP, conditions: refused("NoMatchingListenerHostname") },
      { ref: HTTPS, conditions: refused("NotAllowedByListeners") },
    ]),
    AT,
  );
  assertEquals(roles(p), [[true, null], [true, null]]);
  assertEquals(p.summary.refusedListenerReports, 0);
  assertEquals(p.summary.allParentsAccepted, false);
  assertEquals(p.summary.healthy, false);
  assertEquals(findings(p), [
    ["infra/edge/http", CTRL, "Accepted", "NoMatchingListenerHostname"],
    ["infra/edge/https", CTRL, "Accepted", "NotAllowedByListeners"],
  ]);
  // Unknown is not an acceptance either.
  const pending = parseHttpRoute(
    routeWith([EDGE], [
      {
        ref: HTTP,
        conditions: [cond("Accepted", "Unknown", "Pending", "", 5)],
      },
      { ref: HTTPS, conditions: refused("NotAllowedByListeners") },
    ]),
    AT,
  );
  assertEquals(pending.summary.healthy, false);
  assertEquals(pending.summary.refusedListenerReports, 0);
});

Deno.test("the listener that accepts must also resolve the route's references", () => {
  const p = parseHttpRoute(
    routeWith([EDGE], [
      {
        ref: HTTP,
        conditions: [
          cond("Accepted", "True", "Accepted", "", 5),
          cond("ResolvedRefs", "False", "BackendNotFound", "", 5),
        ],
      },
      { ref: HTTPS, conditions: refused("NotAllowedByListeners") },
    ]),
    AT,
  );
  assertEquals(p.summary.allParentsAccepted, true);
  assertEquals(p.summary.allRefsResolved, false);
  assertEquals(p.summary.refusedListenerReports, 1);
  assertEquals(p.summary.healthy, false);
  assertEquals(findings(p), [
    ["infra/edge/http", CTRL, "ResolvedRefs", "BackendNotFound"],
  ]);
  // Two listeners accept and one of them does not resolve: still a finding.
  const two = parseHttpRoute(
    routeWith([EDGE], [
      { ref: HTTP, conditions: fine() },
      {
        ref: HTTPS,
        conditions: [
          cond("Accepted", "True", "Accepted", "", 5),
          cond("ResolvedRefs", "False", "RefNotPermitted", "", 5),
        ],
      },
    ]),
    AT,
  );
  assertEquals(findings(two), [
    ["infra/edge/https", CTRL, "ResolvedRefs", "RefNotPermitted"],
  ]);
});

Deno.test("one listener is enough per controller, not across controllers", () => {
  const other = "b.example/controller";
  const p = parseHttpRoute(
    routeWith([EDGE], [
      { ref: HTTP, conditions: fine() },
      { ref: HTTPS, conditions: refused("NotAllowedByListeners") },
      {
        ref: HTTP,
        conditions: refused("NoMatchingListenerHostname"),
        controllerName: other,
      },
      {
        ref: HTTPS,
        conditions: refused("NotAllowedByListeners"),
        controllerName: other,
      },
    ]),
    AT,
  );
  assertEquals(roles(p), [
    [true, null],
    [false, "another-listener-accepted"],
    [true, null],
    [true, null],
  ]);
  assertEquals(p.summary.refusedListenerReports, 1);
  assertEquals(p.summary.healthy, false);
  assertEquals(findings(p), [
    ["infra/edge/http", other, "Accepted", "NoMatchingListenerHostname"],
    ["infra/edge/https", other, "Accepted", "NotAllowedByListeners"],
  ]);
});

Deno.test("one listener is not enough where the rule does not reach", () => {
  // A report that names no listener is the controller's verdict on the whole
  // parent: it is judged, whatever a listener report says.
  const whole = parseHttpRoute(
    routeWith([EDGE], [
      { ref: HTTP, conditions: fine() },
      { ref: EDGE, conditions: refused("NotAllowedByListeners") },
    ]),
    AT,
  );
  assertEquals(whole.summary.healthy, false);
  assertEquals(whole.summary.refusedListenerReports, 0);
  assertEquals(findings(whole), [
    ["infra/edge", CTRL, "Accepted", "NotAllowedByListeners"],
  ]);
  // A parent the route names with its listener must be accepted there.
  const named = parseHttpRoute(
    routeWith([HTTP, HTTPS], [
      { ref: HTTP, conditions: fine() },
      { ref: HTTPS, conditions: refused("NotAllowedByListeners") },
    ]),
    AT,
  );
  assertEquals(named.summary.healthy, false);
  assertEquals(named.summary.refusedListenerReports, 0);
  // Named both ways: the listener named on its own is still judged.
  const both = parseHttpRoute(
    routeWith([EDGE, HTTPS], [
      { ref: HTTP, conditions: fine() },
      { ref: HTTPS, conditions: refused("NotAllowedByListeners") },
    ]),
    AT,
  );
  assertEquals(both.summary.healthy, false);
  assertEquals(findings(both), [
    ["infra/edge/https", CTRL, "Accepted", "NotAllowedByListeners"],
  ]);
  // An acceptance at an old generation is none: nothing is waived by it.
  const old = parseHttpRoute(
    routeWith([EDGE], [
      { ref: HTTP, conditions: fine(3) },
      { ref: HTTPS, conditions: refused("NotAllowedByListeners", 3) },
    ]),
    AT,
  );
  assertEquals(old.summary.refusedListenerReports, 0);
  assertEquals(old.summary.healthy, false);
});

Deno.test("a report that left out the section or the port of the spec's parent is still that parent's", () => {
  const spec = { ...EDGE, sectionName: "https", port: 443 };
  for (
    const ref of [
      { ...EDGE, sectionName: "https" },
      { ...EDGE, port: 443 },
      { ...EDGE },
    ]
  ) {
    const ok = parseHttpRoute(
      routeWith([spec], [{ ref, conditions: fine() }]),
      AT,
    );
    assertEquals(ok.parents[0].requested, true, JSON.stringify(ref));
    assertEquals(ok.summary.reportedParentCount, 1);
    assertEquals(ok.summary.leftoverParentReports, 0);
    assertEquals(ok.summary.healthy, true, JSON.stringify(ref));
    assertEquals(ok.summary.unhealthy, []);

    const bad = parseHttpRoute(
      routeWith([spec], [{
        ref,
        conditions: refused("NoMatchingListenerHostname"),
      }]),
      AT,
    );
    assertEquals(bad.summary.healthy, false, JSON.stringify(ref));
    assertEquals(bad.summary.unhealthy.map((u) => u.reason), [
      "NoMatchingListenerHostname",
    ]);
    assertEquals(bad.summary.unhealthy[0].controllerName, CTRL);
  }
});

Deno.test("a rejection in another form cannot hide behind an acceptance in the spec's form", () => {
  const spec = { ...EDGE, sectionName: "https" };
  for (
    const other of [{ ...EDGE }, { ...EDGE, sectionName: "https", port: 443 }]
  ) {
    for (
      const reports of [
        [
          { ref: spec, conditions: fine() },
          { ref: other, conditions: refused("NotAllowedByListeners") },
        ],
        // The order of the entries must not matter.
        [
          { ref: other, conditions: refused("NotAllowedByListeners") },
          { ref: spec, conditions: fine() },
        ],
      ]
    ) {
      const p = parseHttpRoute(routeWith([spec], reports), AT);
      assertEquals(p.parents.map((x) => x.requested), [true, true]);
      assertEquals(p.summary.leftoverParentReports, 0);
      assertEquals(p.summary.allParentsAccepted, false);
      assertEquals(p.summary.healthy, false, JSON.stringify(other));
      assertEquals(p.summary.unhealthy.map((u) => [u.condition, u.reason]), [
        ["Accepted", "NotAllowedByListeners"],
      ]);
    }
  }
});

Deno.test("two sections named, a third reported: the third is leftover and the route healthy", () => {
  // The shape a renamed listener leaves on a real cluster.
  const p = parseHttpRoute(
    routeWith(
      [
        { ...EDGE, sectionName: "https" },
        { ...EDGE, sectionName: "https-id" },
      ],
      [
        { ref: { ...EDGE, sectionName: "https" }, conditions: fine() },
        {
          ref: { ...EDGE, sectionName: "https-auth" },
          conditions: refused("NoMatchingParent", 3),
        },
        { ref: { ...EDGE, sectionName: "https-id" }, conditions: fine() },
      ],
    ),
    AT,
  );
  assertEquals(p.parents.map((x) => x.requested), [true, false, true]);
  assertEquals(p.parents[1].accepted, false);
  assertEquals(p.summary.parentCount, 2);
  assertEquals(p.summary.reportedParentCount, 2);
  assertEquals(p.summary.leftoverParentReports, 1);
  assertEquals(p.summary.statusCurrent, true);
  assertEquals(p.summary.allParentsAccepted, true);
  assertEquals(p.summary.healthy, true);
  assertEquals(p.summary.unhealthy, []);
});

Deno.test("a report for an object, a section or a port the route does not name is leftover", () => {
  const spec = { ...EDGE, sectionName: "https", port: 443 };
  for (
    const ref of [
      { name: "other", namespace: "infra" },
      { name: "edge", namespace: "elsewhere" },
      { ...EDGE, kind: "Service", group: "" },
      { ...EDGE, sectionName: "http" },
      { ...EDGE, sectionName: "https", port: 8443 },
      { ...EDGE, port: 8443 },
    ]
  ) {
    const p = parseHttpRoute(
      routeWith([spec], [
        { ref: spec, conditions: fine() },
        { ref, conditions: refused("NoMatchingParent", 2) },
      ]),
      AT,
    );
    assertEquals(
      p.parents.map((x) => x.requested),
      [true, false],
      JSON.stringify(ref),
    );
    assertEquals(p.summary.leftoverParentReports, 1);
    assertEquals(p.summary.healthy, true, JSON.stringify(ref));
  }
  // With nothing but a leftover report, the parent asked for is not reported.
  const only = parseHttpRoute(
    routeWith([spec], [{
      ref: { ...EDGE, sectionName: "http" },
      conditions: fine(),
    }]),
    AT,
  );
  assertEquals(only.summary.reportedParentCount, 0);
  assertEquals(findings(only), [
    ["infra/edge/https:443", null, null, "NotReported"],
  ]);
});

Deno.test("a controller's old report on a parent still named is a finding that names the controller", () => {
  // A controller was replaced: its report stays at the generation it last saw.
  const spec = { ...EDGE, sectionName: "https" };
  const p = parseHttpRoute(
    routeWith([spec], [
      { ref: spec, conditions: fine(5) },
      {
        ref: spec,
        conditions: fine(2),
        controllerName: "old.example.org/controller",
      },
    ]),
    AT,
  );
  HttpRouteSchema.parse(p);
  assertEquals(p.parents.map((x) => [x.controllerName, x.current]), [
    [CTRL, true],
    ["old.example.org/controller", false],
  ]);
  assertEquals(p.summary.statusCurrent, false);
  assertEquals(p.summary.healthy, false);
  assertEquals(findings(p), [
    ["infra/edge/https", "old.example.org/controller", null, "StaleStatus"],
  ]);
  // One read cannot know why the report is old, and the message does not guess.
  assertEquals(
    p.summary.unhealthy[0].message,
    "this controller's report is for generation 2 of the route, which is now at generation 5",
  );
  assertEquals(routeReasons(p), [
    "parent infra/edge/https (old.example.org/controller): StaleStatus",
  ]);

  // Two controllers, both old: one finding each, never one for the route.
  const both = parseHttpRoute(
    routeWith([spec], [
      { ref: spec, conditions: fine(4) },
      { ref: spec, conditions: fine(2), controllerName: "b.example/c" },
    ]),
    AT,
  );
  assertEquals(findings(both), [
    ["infra/edge/https", CTRL, null, "StaleStatus"],
    ["infra/edge/https", "b.example/c", null, "StaleStatus"],
  ]);
  // A leftover report's old generation says nothing about the route.
  const leftover = parseHttpRoute(
    routeWith([spec], [
      { ref: spec, conditions: fine(5) },
      { ref: { ...EDGE, sectionName: "gone" }, conditions: fine(1) },
    ]),
    AT,
  );
  assertEquals(leftover.summary.statusCurrent, true);
  assertEquals(leftover.parents[1].current, false);
  assertEquals(leftover.summary.healthy, true);
});

Deno.test("every finding names its parent, and its controller when one reported", () => {
  const spec = { ...EDGE, sectionName: "https" };
  const p = parseHttpRoute(
    routeWith([spec, { name: "ghost", namespace: "infra" }], [
      { ref: spec, conditions: refused("NotAllowedByListeners", 4) },
      {
        ref: spec,
        conditions: [cond("Accepted", "True", "Accepted", "", 5)],
        controllerName: "b.example/c",
      },
    ]),
    AT,
  );
  assertEquals(findings(p), [
    ["infra/ghost", null, null, "NotReported"],
    ["infra/edge/https", CTRL, "Accepted", "NotAllowedByListeners"],
    ["infra/edge/https", CTRL, null, "StaleStatus"],
    ["infra/edge/https", "b.example/c", "ResolvedRefs", "NotReported"],
  ]);
  for (const u of p.summary.unhealthy) {
    assertEquals(u.parent.startsWith("infra/"), true);
  }
});

Deno.test("PartiallyInvalid True is a finding: some rules were dropped", () => {
  const spec = { ...EDGE, sectionName: "https" };
  const p = parseHttpRoute(
    routeWith([spec], [{
      ref: spec,
      conditions: [
        ...fine(),
        cond("PartiallyInvalid", "True", "UnsupportedValue", "rule 2", 5),
      ],
    }]),
    AT,
  );
  HttpRouteSchema.parse(p);
  assertEquals(p.parents[0].partiallyInvalid, true);
  assertEquals(p.summary.partiallyInvalid, true);
  assertEquals(p.summary.allParentsAccepted, true);
  assertEquals(p.summary.healthy, false);
  assertEquals(findings(p), [
    ["infra/edge/https", CTRL, "PartiallyInvalid", "UnsupportedValue"],
  ]);
  assertEquals(p.summary.unhealthy[0].status, "True");
  assertEquals(p.summary.unhealthy[0].message, "rule 2");
  assertEquals(routeReasons(p), [
    "parent infra/edge/https (example.org/gateway-controller): PartiallyInvalid=True (UnsupportedValue)",
  ]);
  // The condition must only be set when True; anything else is not judged.
  for (const status of ["False", "Unknown"]) {
    const q = parseHttpRoute(
      routeWith([spec], [{
        ref: spec,
        conditions: [...fine(), cond("PartiallyInvalid", status, "X", "", 5)],
      }]),
      AT,
    );
    assertEquals(q.summary.partiallyInvalid, false, status);
    assertEquals(q.summary.healthy, true, status);
  }
  // On a leftover report it is recorded and not judged.
  const left = parseHttpRoute(
    routeWith([spec], [
      { ref: spec, conditions: fine() },
      {
        ref: { ...EDGE, sectionName: "gone" },
        conditions: [cond("PartiallyInvalid", "True", "UnsupportedValue")],
      },
    ]),
    AT,
  );
  assertEquals(left.parents[1].partiallyInvalid, true);
  assertEquals(left.summary.partiallyInvalid, false);
  assertEquals(left.summary.healthy, true);
});

Deno.test("an HTTPRoute at a version other than v1 is read, recorded and warned about", async () => {
  const r = healthyRoute();
  r.apiVersion = "gateway.networking.k8s.io/v1beta1";
  await withCluster({ objects: { httproutes: [r] } }, async () => {
    const c = ctx();
    await httproute.methods.list.execute({}, c.context);
    assertEquals(
      c.written[0].data.apiVersion,
      "gateway.networking.k8s.io/v1beta1",
    );
    assertEquals(c.written[1].data.apiVersions, [
      "gateway.networking.k8s.io/v1beta1",
    ]);
    assertEquals(c.warnings.length, 1);
    assertEquals(c.warnings[0].includes("HTTPRoutes"), true, c.warnings[0]);
    assertEquals(c.warnings[0].includes("v1beta1"), true, c.warnings[0]);
    const one = ctx({ namespace: "apps" });
    await httproute.methods.get.execute({ name: "app" }, one.context);
    assertEquals(one.warnings.length, 1);
    assertEquals(one.warnings[0].includes("v1beta1"), true);
  });
  // At v1 nothing is warned about.
  await withCluster({ objects: { httproutes: [healthyRoute()] } }, async () => {
    const c = ctx();
    await httproute.methods.list.execute({}, c.context);
    assertEquals(c.warnings, []);
  });
});

Deno.test("a report kept from before the route's parent was edited is superseded by the controller's current one", () => {
  const shapes = [
    // [edge] edited to [edge/https]; the report for the whole Gateway stayed.
    { spec: HTTPS, kept: EDGE, keptConditions: fine(4) },
    // [edge/old] edited to [edge]; the refusal for the old listener stayed.
    {
      spec: EDGE,
      kept: { ...EDGE, sectionName: "old" },
      keptConditions: refused("NoMatchingParent", 4),
      now: EDGE,
    },
    // [edge/https] edited to [edge/https:443]; the report without port stayed.
    { spec: { ...HTTPS, port: 443 }, kept: HTTPS, keptConditions: fine(4) },
  ];
  for (const s of shapes) {
    for (const keptFirst of [true, false]) {
      const kept = { ref: s.kept, conditions: s.keptConditions };
      const now = { ref: s.now ?? s.spec, conditions: fine(5) };
      const p = parseHttpRoute(
        routeWith([s.spec], keptFirst ? [kept, now] : [now, kept]),
        AT,
      );
      HttpRouteSchema.parse(p);
      const old = p.parents[keptFirst ? 0 : 1];
      assertEquals(old.requested, true);
      assertEquals(old.current, false);
      assertEquals(old.judged, false);
      assertEquals(old.notJudgedBecause, "superseded");
      assertEquals(p.summary.leftoverParentReports, 1);
      assertEquals(p.summary.refusedListenerReports, 0);
      assertEquals(p.summary.statusCurrent, true);
      assertEquals(p.summary.healthy, true, JSON.stringify(s.spec));
      assertEquals(p.summary.unhealthy, []);
    }
  }
});

Deno.test("an old report is judged when its controller has no current one on that parent", () => {
  const stale = (p: ReturnType<typeof parseHttpRoute>) =>
    p.summary.unhealthy.filter((u) => u.reason === "StaleStatus").map((
      u,
    ) => [u.parent, u.controllerName]);
  // Only an old report: nothing supersedes it.
  const alone = parseHttpRoute(
    routeWith([HTTPS], [{ ref: EDGE, conditions: fine(4) }]),
    AT,
  );
  assertEquals(roles(alone), [[true, null]]);
  assertEquals(stale(alone), [["infra/edge", CTRL]]);
  assertEquals(alone.summary.healthy, false);
  const message = alone.summary.unhealthy[0].message ?? "";
  assertEquals(message.includes("no longer runs"), false, message);
  assertEquals(message.includes("for generation 4 of the route"), true);

  // Another controller's current report supersedes nothing of this one.
  const other = parseHttpRoute(
    routeWith([HTTPS], [
      { ref: EDGE, conditions: fine(4) },
      { ref: HTTPS, conditions: fine(5), controllerName: "b.example/c" },
    ]),
    AT,
  );
  assertEquals(roles(other), [[true, null], [true, null]]);
  assertEquals(stale(other), [["infra/edge", CTRL]]);

  // An old report that covers two parents, with a current one for only one
  // of them: for the other parent it is all this controller said.
  const half = parseHttpRoute(
    routeWith([HTTP, HTTPS], [
      { ref: EDGE, conditions: fine(4) },
      { ref: HTTPS, conditions: fine(5) },
    ]),
    AT,
  );
  assertEquals(roles(half), [[true, null], [true, null]]);
  assertEquals(stale(half), [["infra/edge", CTRL]]);
  // With a current one for both, it is superseded.
  const whole = parseHttpRoute(
    routeWith([HTTP, HTTPS], [
      { ref: EDGE, conditions: fine(4) },
      { ref: HTTPS, conditions: fine(5) },
      { ref: HTTP, conditions: fine(5) },
    ]),
    AT,
  );
  assertEquals(roles(whole)[0], [false, "superseded"]);
  assertEquals(whole.summary.healthy, true);

  // A report whose generation cannot be told supersedes nothing.
  const unknown = parseHttpRoute(
    routeWith([HTTPS], [
      { ref: EDGE, conditions: fine(4) },
      {
        ref: HTTPS,
        conditions: [
          { type: "Accepted", status: "True" },
          { type: "ResolvedRefs", status: "True" },
        ],
      },
    ]),
    AT,
  );
  assertEquals(stale(unknown), [["infra/edge", CTRL]]);
});

Deno.test("an inventory line names the controller, also when only one reported", () => {
  const one = parseHttpRoute(
    routeWith([HTTPS, { name: "ghost", namespace: "infra" }], [{
      ref: HTTPS,
      conditions: refused("NotAllowedByListeners"),
    }]),
    AT,
  );
  assertEquals(routeReasons(one), [
    // Nobody reported: there is no controller to name.
    "parent infra/ghost: NotReported",
    `parent infra/edge/https (${CTRL}): Accepted=False (NotAllowedByListeners)`,
  ]);
});
