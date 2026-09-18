import { assertEquals } from "jsr:@std/assert@1.0.13";
import { model, normalizeRouter } from "./router.ts";
import { EXT_NET, idRows, ROUTER_SHOW, SUBNET_SHOW } from "./fixtures.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

const ID = ROUTER_SHOW.id;
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

Deno.test("list and create store router-<name>; create passes the gateway", async () => {
  let created = false;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "router list -c ID") return idRows(ID);
    if (l === "router show private-gw") {
      return created ? ROUTER_SHOW : notFound("router", "private-gw");
    }
    if (
      l === "router create --external-gateway ext-net --enable-snat private-gw"
    ) {
      created = true;
      return ROUTER_SHOW;
    }
    if (l === `router show ${ID}`) return ROUTER_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({}, context);
    await model.methods.create.execute({
      name: "private-gw",
      externalGateway: "ext-net",
      snat: true,
    }, context);
    assertEquals(written.map((w) => w.name), [
      "router-private-gw",
      "router-private-gw",
    ]);
  } finally {
    fake.restore();
  }
});

Deno.test("addSubnet resolves the subnet id, skips when attached, otherwise attaches", async () => {
  const other = "11111111-2222-4333-8444-555555555555";
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "router show private-gw" || l === `router show ${ID}`) {
      return ROUTER_SHOW;
    }
    if (l === "subnet show private-subnet") return SUBNET_SHOW;
    if (l === `router add subnet ${ID} ${other}`) return "";
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.addSubnet.execute({
      router: "private-gw",
      subnet: "private-subnet",
    }, context);
    assertEquals(fake.calls.length, 2);
    await model.methods.addSubnet.execute({
      router: "private-gw",
      subnet: other,
    }, context);
    assertEquals(fake.calls.length, 5);
    assertEquals(written.length, 2);
  } finally {
    fake.restore();
  }
});

Deno.test("removeSubnet detaches only when attached", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "router show private-gw" || l === `router show ${ID}`) {
      return ROUTER_SHOW;
    }
    if (l === `router remove subnet ${ID} ${SUBNET}`) return "";
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.removeSubnet.execute({
      router: "private-gw",
      subnet: SUBNET,
    }, context);
    assertEquals(fake.calls.map(line), [
      "router show private-gw",
      `router remove subnet ${ID} ${SUBNET}`,
      `router show ${ID}`,
    ]);
  } finally {
    fake.restore();
  }
});

Deno.test("addRoute and removeRoute are idempotent and use router set/unset --route", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "router show private-gw" || l === `router show ${ID}`) {
      return ROUTER_SHOW;
    }
    if (
      l ===
        `router set --route destination=198.51.100.0/24,gateway=192.0.2.253 ${ID}`
    ) return "";
    if (
      l ===
        `router unset --route destination=203.0.113.0/24,gateway=192.0.2.254 ${ID}`
    ) return "";
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.addRoute.execute({
      router: "private-gw",
      route: { destination: "203.0.113.0/24", nexthop: "192.0.2.254" },
    }, context);
    assertEquals(fake.calls.length, 1);
    await model.methods.addRoute.execute({
      router: "private-gw",
      route: { destination: "198.51.100.0/24", nexthop: "192.0.2.253" },
    }, context);
    assertEquals(fake.calls.length, 4);
    await model.methods.removeRoute.execute({
      router: "private-gw",
      route: { destination: "203.0.113.0/24", nexthop: "192.0.2.254" },
    }, context);
    assertEquals(fake.calls.length, 7);
  } finally {
    fake.restore();
  }
});

Deno.test("update clears the gateway with router unset before setting", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "router show private-gw" || l === `router show ${ID}`) {
      return ROUTER_SHOW;
    }
    if (l === `router unset --external-gateway ${ID}`) return "";
    if (l === `router set --description edge ${ID}`) return "";
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.update.execute({
      router: "private-gw",
      clearExternalGateway: true,
      description: "edge",
    }, context);
    assertEquals(fake.calls.map(line).slice(1, 3), [
      `router unset --external-gateway ${ID}`,
      `router set --description edge ${ID}`,
    ]);
  } finally {
    fake.restore();
  }
});
