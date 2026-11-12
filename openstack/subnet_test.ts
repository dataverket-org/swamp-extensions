import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeSubnet } from "./subnet.ts";
import { fail, NOT_FOUND, withStub } from "./test_support.ts";
import { SUBNET_SHOW } from "./fixtures.ts";

Deno.test("normalizeSubnet keeps pools, DNS servers and host routes", () => {
  const s = normalizeSubnet(SUBNET_SHOW);
  assertEquals(s.cidr, "192.0.2.0/24");
  assertEquals(s.ipVersion, 4);
  assertEquals(s.gatewayIp, "192.0.2.1");
  assertEquals(s.enableDhcp, true);
  assertEquals(s.allocationPools, [{
    start: "192.0.2.100",
    end: "192.0.2.200",
  }]);
  assertEquals(s.dnsNameservers, ["198.51.100.53", "198.51.100.54"]);
  assertEquals(s.hostRoutes, [{
    destination: "203.0.113.0/24",
    nexthop: "192.0.2.254",
  }]);
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;
const ID = SUBNET_SHOW.id;
const NAME = "subnet-private-subnet";

Deno.test("list shows each subnet of a network and writes one record each", () =>
  withStub([
    ["subnet list -c ID --network private-net --ip-version 4", {
      json: [{ ID }],
    }],
    [`subnet show ${ID}`, { json: SUBNET_SHOW }],
  ], async (h) => {
    await M.list.execute({ network: "private-net", ipVersion: 4 }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.cidr]), [[
      "subnet",
      NAME,
      "192.0.2.0/24",
    ]]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} subnets");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([["subnet list", fail("Unauthorized (HTTP 401)")]], async (h) => {
    await assertRejects(
      () => M.list.execute({}, h.context),
      Error,
      "subnet list failed (exit 1)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the subnet it reads", () =>
  withStub(
    [["subnet show private-subnet", { json: SUBNET_SHOW }]],
    async (h) => {
      await M.get.execute({ subnet: "private-subnet" }, h.context);
      assertEquals(h.written().map((w) => [w.spec, w.name, w.data.gatewayIp]), [
        ["subnet", NAME, "192.0.2.1"],
      ]);
    },
  ));

Deno.test("get fails on a missing subnet, and writes nothing", () =>
  withStub([["subnet show nope", NOT_FOUND]], async (h) => {
    await assertRejects(
      () => M.get.execute({ subnet: "nope" }, h.context),
      Error,
      "subnet show nope failed",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create makes a subnet with pools and routes and writes it", () =>
  withStub([
    ["subnet show private-subnet", NOT_FOUND],
    [
      "subnet create --network private-net --subnet-range 192.0.2.0/24 --ip-version 4 --dhcp --dns-nameserver 198.51.100.53 --allocation-pool start=192.0.2.100,end=192.0.2.200 --host-route destination=203.0.113.0/24,gateway=192.0.2.254 private-subnet",
      { json: { id: ID } },
    ],
    [`subnet show ${ID}`, { json: SUBNET_SHOW }],
  ], async (h) => {
    await M.create.execute({
      name: "private-subnet",
      network: "private-net",
      cidr: "192.0.2.0/24",
      ipVersion: 4,
      dhcp: true,
      dnsNameservers: ["198.51.100.53"],
      allocationPools: [{ start: "192.0.2.100", end: "192.0.2.200" }],
      hostRoutes: [{ destination: "203.0.113.0/24", nexthop: "192.0.2.254" }],
    }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name]), [["subnet", NAME]]);
  }));

Deno.test("create fails on an overlapping range, and writes nothing", () =>
  withStub([
    ["subnet show private-subnet", NOT_FOUND],
    [
      "subnet create",
      fail(
        "Invalid input for operation: Requested subnet with cidr: 192.0.2.0/24 overlaps with another subnet. (HTTP 400)",
      ),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.create.execute({
          name: "private-subnet",
          network: "private-net",
          cidr: "192.0.2.0/24",
          ipVersion: 4,
          dhcp: true,
        }, h.context),
      Error,
      "overlaps with another subnet",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("update replaces DNS servers and writes the subnet as re-read", () =>
  withStub([
    ["subnet show private-subnet", { json: SUBNET_SHOW }],
    [`subnet set --no-dns-nameservers --dns-nameserver 9.9.9.9 ${ID}`, {
      stdout: "",
    }],
    [`subnet show ${ID}`, {
      json: { ...SUBNET_SHOW, dns_nameservers: ["9.9.9.9"] },
    }],
  ], async (h) => {
    await M.update.execute(
      { subnet: "private-subnet", dnsNameservers: ["9.9.9.9"] },
      h.context,
    );
    assertEquals(h.deleted(), []);
    assertEquals(h.written().map((w) => [w.name, w.data.dnsNameservers]), [[
      NAME,
      ["9.9.9.9"],
    ]]);
  }));

Deno.test("update fails when the set fails, and writes nothing", () =>
  withStub([
    ["subnet show private-subnet", { json: SUBNET_SHOW }],
    ["subnet set", fail("Forbidden (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () =>
        M.update.execute({ subnet: "private-subnet", dhcp: false }, h.context),
      Error,
      "subnet set failed",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("delete deletes the subnet and drops its stored resource", () =>
  withStub([
    ["subnet show private-subnet", { json: SUBNET_SHOW }],
    [`subnet delete ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.delete.execute({ subnet: "private-subnet" }, h.context);
    assertEquals(h.deleted(), [NAME]);
  }));

Deno.test("delete fails on a subnet in use, and drops nothing", () =>
  withStub([
    ["subnet show private-subnet", { json: SUBNET_SHOW }],
    [
      "subnet delete",
      fail(
        "Unable to complete operation on subnet: One or more ports have an IP allocation from this subnet. (HTTP 409)",
      ),
    ],
  ], async (h) => {
    await assertRejects(
      () => M.delete.execute({ subnet: "private-subnet" }, h.context),
      Error,
      "IP allocation from this subnet",
    );
    assertEquals(h.deleted(), []);
  }));
