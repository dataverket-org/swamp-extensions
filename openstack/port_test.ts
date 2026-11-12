import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizePort } from "./port.ts";
import { fail, NOT_FOUND, withStub } from "./test_support.ts";
import { PORT_SHOW } from "./fixtures.ts";

Deno.test("normalizePort flattens fixed IPs and allowed address pairs", () => {
  const p = normalizePort(PORT_SHOW);
  assertEquals(p.name, "web-01-eth0");
  assertEquals(p.fixedIps, [{
    subnetId: "e1e8839f-8154-40d8-84d3-38c01020b27e",
    ipAddress: "192.0.2.10",
  }]);
  assertEquals(p.ipAddresses, ["192.0.2.10"]);
  assertEquals(p.deviceId, "55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8");
  assertEquals(p.allowedAddressPairs, [{
    ipAddress: "192.0.2.198",
    macAddress: "fa:16:3e:6c:83:8c",
  }]);
  assertEquals(p.securityGroupIds, ["0ae8b48c-7db0-4903-ba95-5a2a081ea6c9"]);
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;
const ID = PORT_SHOW.id;
const NAME = "port-web-01-eth0";

Deno.test("list shows each port of a server and writes one record each", () =>
  withStub([
    ["port list -c ID --server web-01 --status ACTIVE", { json: [{ ID }] }],
    [`port show ${ID}`, { json: PORT_SHOW }],
  ], async (h) => {
    await M.list.execute({ server: "web-01", status: "ACTIVE" }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.ipAddresses]), [
      ["port", NAME, ["192.0.2.10"]],
    ]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} ports");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([["port list", fail("Unauthorized (HTTP 401)")]], async (h) => {
    await assertRejects(
      () => M.list.execute({}, h.context),
      Error,
      "port list failed (exit 1)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the port it reads", () =>
  withStub([["port show web-01-eth0", { json: PORT_SHOW }]], async (h) => {
    await M.get.execute({ port: "web-01-eth0" }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.id]), [[
      "port",
      NAME,
      ID,
    ]]);
  }));

Deno.test("get fails on a missing port, and writes nothing", () =>
  withStub([["port show nope", NOT_FOUND]], async (h) => {
    await assertRejects(
      () => M.get.execute({ port: "nope" }, h.context),
      Error,
      "port show nope failed",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create makes a port with a fixed IP and no security group", () =>
  withStub([
    ["port show web-01-eth0", NOT_FOUND],
    [
      "port create --network private-net --fixed-ip subnet=private-subnet,ip-address=192.0.2.10 --no-security-group --allowed-address ip-address=192.0.2.198 web-01-eth0",
      { json: { id: ID } },
    ],
    [`port show ${ID}`, { json: PORT_SHOW }],
  ], async (h) => {
    await M.create.execute({
      name: "web-01-eth0",
      network: "private-net",
      fixedIps: [{ subnet: "private-subnet", ipAddress: "192.0.2.10" }],
      securityGroups: [],
      allowedAddresses: [{ ipAddress: "192.0.2.198" }],
    }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name]), [["port", NAME]]);
  }));

Deno.test("create fails on an address in use, and writes nothing", () =>
  withStub([
    ["port show web-01-eth0", NOT_FOUND],
    [
      "port create",
      fail("IP address 192.0.2.10 already allocated in subnet (HTTP 409)"),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.create.execute({
          name: "web-01-eth0",
          network: "private-net",
          fixedIps: [{ ipAddress: "192.0.2.10" }],
        }, h.context),
      Error,
      "already allocated",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("update replaces security groups, renames and drops the old record", () =>
  withStub([
    ["port show web-01-eth0", { json: PORT_SHOW }],
    [
      `port set --name web-01-lan --no-security-group --security-group ssh ${ID}`,
      { stdout: "" },
    ],
    [`port show ${ID}`, { json: { ...PORT_SHOW, name: "web-01-lan" } }],
  ], async (h) => {
    await M.update.execute(
      { port: "web-01-eth0", name: "web-01-lan", securityGroups: ["ssh"] },
      h.context,
    );
    assertEquals(h.deleted(), [NAME]);
    assertEquals(h.written().map((w) => w.name), ["port-web-01-lan"]);
  }));

Deno.test("update fails when the set fails, and writes nothing", () =>
  withStub([
    ["port show web-01-eth0", { json: PORT_SHOW }],
    ["port set", fail("Forbidden (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () =>
        M.update.execute(
          { port: "web-01-eth0", portSecurity: false },
          h.context,
        ),
      Error,
      "port set failed",
    );
    assertEquals(h.deleted(), []);
    assertEquals(h.written(), []);
  }));

Deno.test("delete deletes the port and drops its stored resource", () =>
  withStub([
    ["port show web-01-eth0", { json: PORT_SHOW }],
    [`port delete ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.delete.execute({ port: "web-01-eth0" }, h.context);
    assertEquals(h.deleted(), [NAME]);
  }));

Deno.test("delete fails when the CLI refuses, and drops nothing", () =>
  withStub([
    ["port show web-01-eth0", { json: PORT_SHOW }],
    ["port delete", fail("Forbidden (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () => M.delete.execute({ port: "web-01-eth0" }, h.context),
      Error,
      `port delete ${ID} failed (exit 1): Forbidden`,
    );
    assertEquals(h.deleted(), []);
  }));
