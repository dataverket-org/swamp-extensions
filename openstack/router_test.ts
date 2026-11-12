import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeRouter } from "./router.ts";
import { fail, NOT_FOUND, withStub } from "./test_support.ts";
import { EXT_NET, ROUTER_SHOW, SUBNET_SHOW } from "./fixtures.ts";

const SUBNET = SUBNET_SHOW.id;

Deno.test("normalizeRouter flattens gateway info, interfaces and routes", () => {
  const r = normalizeRouter(ROUTER_SHOW);
  assertEquals(r.externalNetworkId, EXT_NET);
  assertEquals(r.externalFixedIps, [{
    subnetId: "1afef4bd-28f5-43d8-92c6-d0a1e101aec8",
    ipAddress: "203.0.113.2",
  }]);
  assertEquals(r.snatEnabled, true);
  assertEquals(r.interfaces, [{
    portId: "f4cc5fc3-8593-4070-9207-f215fbf90ef9",
    subnetId: SUBNET,
    ipAddress: "192.0.2.1",
  }]);
  assertEquals(r.routes, [{
    destination: "203.0.113.0/24",
    nexthop: "192.0.2.254",
  }]);
  const bare = normalizeRouter({
    ...ROUTER_SHOW,
    external_gateway_info: null,
    interfaces_info: [],
    routes: [],
  });
  assertEquals(bare.externalNetworkId, "");
  assertEquals(bare.snatEnabled, false);
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;
const ID = ROUTER_SHOW.id;
const NAME = "router-private-gw";
const BARE = { ...ROUTER_SHOW, interfaces_info: [], routes: [] };
const ROUTE = { destination: "203.0.113.0/24", nexthop: "192.0.2.254" };

Deno.test("list shows each router and writes one record each", () =>
  withStub([
    ["router list -c ID --name private-gw", { json: [{ ID }] }],
    [`router show ${ID}`, { json: ROUTER_SHOW }],
  ], async (h) => {
    await M.list.execute({ name: "private-gw" }, h.context);
    assertEquals(
      h.written().map((w) => [w.spec, w.name, w.data.externalNetworkId]),
      [["router", NAME, EXT_NET]],
    );
    assertEquals(h.logs().at(-1)?.message, "stored {count} routers");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([["router list", fail("Unauthorized (HTTP 401)")]], async (h) => {
    await assertRejects(
      () => M.list.execute({}, h.context),
      Error,
      "router list failed (exit 1)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the router it reads", () =>
  withStub([["router show private-gw", { json: ROUTER_SHOW }]], async (h) => {
    await M.get.execute({ router: "private-gw" }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name]), [["router", NAME]]);
  }));

Deno.test("get fails on a missing router, and writes nothing", () =>
  withStub([["router show nope", NOT_FOUND]], async (h) => {
    await assertRejects(
      () => M.get.execute({ router: "nope" }, h.context),
      Error,
      "router show nope failed",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create makes a router with a gateway and writes it", () =>
  withStub([
    ["router show private-gw", NOT_FOUND],
    ["router create --external-gateway ext-net --enable-snat private-gw", {
      json: { id: ID },
    }],
    [`router show ${ID}`, { json: ROUTER_SHOW }],
  ], async (h) => {
    await M.create.execute(
      { name: "private-gw", externalGateway: "ext-net", snat: true },
      h.context,
    );
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.snatEnabled]), [
      ["router", NAME, true],
    ]);
  }));

Deno.test("create fails when the CLI refuses, and writes nothing", () =>
  withStub([
    ["router show private-gw", NOT_FOUND],
    [
      "router create",
      fail("Quota exceeded for resources: ['router'] (HTTP 409)"),
    ],
  ], async (h) => {
    await assertRejects(
      () => M.create.execute({ name: "private-gw" }, h.context),
      Error,
      "Quota exceeded",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("update clears the gateway, renames and drops the old record", () =>
  withStub([
    ["router show private-gw", { json: ROUTER_SHOW }],
    [`router unset --external-gateway ${ID}`, { stdout: "" }],
    [`router set --name edge ${ID}`, { stdout: "" }],
    [`router show ${ID}`, {
      json: { ...ROUTER_SHOW, name: "edge", external_gateway_info: null },
    }],
  ], async (h) => {
    await M.update.execute({
      router: "private-gw",
      name: "edge",
      clearExternalGateway: true,
    }, h.context);
    assertEquals(h.deleted(), [NAME]);
    assertEquals(
      h.written().map((w) => [w.name, w.data.externalNetworkId]),
      [["router-edge", ""]],
    );
  }));

Deno.test("update fails when the set fails, and writes nothing", () =>
  withStub([
    ["router show private-gw", { json: ROUTER_SHOW }],
    ["router set", fail("Forbidden (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () =>
        M.update.execute({
          router: "private-gw",
          snat: false,
          clearExternalGateway: false,
        }, h.context),
      Error,
      "router set failed",
    );
    assertEquals(h.deleted(), []);
    assertEquals(h.written(), []);
  }));

Deno.test("addSubnet attaches a subnet and stores the router as re-read", () =>
  withStub([
    ["router show private-gw", { json: BARE }],
    [`router add subnet ${ID} ${SUBNET}`, { stdout: "" }],
    [`router show ${ID}`, { json: ROUTER_SHOW }],
  ], async (h) => {
    await M.addSubnet.execute(
      { router: "private-gw", subnet: SUBNET },
      h.context,
    );
    const [w] = h.written();
    assertEquals(
      (w.data.interfaces as { subnetId: string }[]).map((i) => i.subnetId),
      [SUBNET],
    );
  }));

Deno.test("addSubnet fails when the attach fails, and writes nothing", () =>
  withStub([
    ["router show private-gw", { json: BARE }],
    [
      "router add subnet",
      fail("Router already has a port on subnet (HTTP 400)"),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.addSubnet.execute(
          { router: "private-gw", subnet: SUBNET },
          h.context,
        ),
      Error,
      "router add subnet",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("removeSubnet detaches an attached subnet and stores the router", () =>
  withStub([
    ["router show private-gw", { json: ROUTER_SHOW }],
    [`router remove subnet ${ID} ${SUBNET}`, { stdout: "" }],
    [`router show ${ID}`, { json: BARE }],
  ], async (h) => {
    await M.removeSubnet.execute(
      { router: "private-gw", subnet: SUBNET },
      h.context,
    );
    assertEquals(h.written().map((w) => [w.name, w.data.interfaces]), [[
      NAME,
      [],
    ]]);
  }));

Deno.test("removeSubnet fails when the detach fails, and writes nothing", () =>
  withStub([
    ["router show private-gw", { json: ROUTER_SHOW }],
    [
      "router remove subnet",
      fail("Router interface in use by floating IPs (HTTP 409)"),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.removeSubnet.execute(
          { router: "private-gw", subnet: SUBNET },
          h.context,
        ),
      Error,
      "in use by floating IPs",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("addRoute sets a missing route and stores the router", () =>
  withStub([
    ["router show private-gw", { json: BARE }],
    [
      `router set --route destination=203.0.113.0/24,gateway=192.0.2.254 ${ID}`,
      { stdout: "" },
    ],
    [`router show ${ID}`, { json: ROUTER_SHOW }],
  ], async (h) => {
    await M.addRoute.execute({ router: "private-gw", route: ROUTE }, h.context);
    assertEquals(h.written().map((w) => w.data.routes), [[ROUTE]]);
  }));

Deno.test("addRoute fails when the set fails, and writes nothing", () =>
  withStub([
    ["router show private-gw", { json: BARE }],
    [
      "router set --route",
      fail(
        "Invalid input for routes: nexthop is not connected with router (HTTP 400)",
      ),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.addRoute.execute({ router: "private-gw", route: ROUTE }, h.context),
      Error,
      "nexthop is not connected",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("removeRoute unsets a present route and stores the router", () =>
  withStub([
    ["router show private-gw", { json: ROUTER_SHOW }],
    [
      `router unset --route destination=203.0.113.0/24,gateway=192.0.2.254 ${ID}`,
      { stdout: "" },
    ],
    [`router show ${ID}`, { json: BARE }],
  ], async (h) => {
    await M.removeRoute.execute(
      { router: "private-gw", route: ROUTE },
      h.context,
    );
    assertEquals(h.written().map((w) => w.data.routes), [[]]);
  }));

Deno.test("removeRoute fails when the unset fails, and writes nothing", () =>
  withStub([
    ["router show private-gw", { json: ROUTER_SHOW }],
    ["router unset --route", fail("Forbidden (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () =>
        M.removeRoute.execute(
          { router: "private-gw", route: ROUTE },
          h.context,
        ),
      Error,
      "router unset failed",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("delete deletes the router and drops its stored resource", () =>
  withStub([
    ["router show private-gw", { json: ROUTER_SHOW }],
    [`router delete ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.delete.execute({ router: "private-gw" }, h.context);
    assertEquals(h.deleted(), [NAME]);
  }));

Deno.test("delete fails on a router with interfaces, and drops nothing", () =>
  withStub([
    ["router show private-gw", { json: ROUTER_SHOW }],
    ["router delete", fail("Router still has ports (HTTP 409)")],
  ], async (h) => {
    await assertRejects(
      () => M.delete.execute({ router: "private-gw" }, h.context),
      Error,
      "still has ports",
    );
    assertEquals(h.deleted(), []);
  }));
