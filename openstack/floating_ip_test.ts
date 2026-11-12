import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeFloatingIp } from "./floating_ip.ts";
import { fail, NOT_FOUND, withStub } from "./test_support.ts";
import { FLOATING_IP_FREE, FLOATING_IP_SHOW } from "./fixtures.ts";

const ADDR = FLOATING_IP_SHOW.floating_ip_address;

Deno.test("normalizeFloatingIp exposes the binding through port details", () => {
  const ip = normalizeFloatingIp(FLOATING_IP_SHOW);
  assertEquals(ip.address, ADDR);
  assertEquals(ip.name, ADDR);
  assertEquals(ip.fixedIpAddress, "192.0.2.10");
  assertEquals(ip.attachedDeviceId, "55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8");
  assertEquals(ip.attachedDeviceOwner, "compute:nova");
  assertEquals(ip.status, "ACTIVE");
  const free = normalizeFloatingIp(FLOATING_IP_FREE);
  assertEquals(free.portId, "");
  assertEquals(free.fixedIpAddress, "");
  assertEquals(free.attachedDeviceId, "");
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;
const BOUND = FLOATING_IP_SHOW;
const FREE = FLOATING_IP_FREE;
const FREE_ADDR = FREE.floating_ip_address;
const BOUND_NAME = "floatingip-203-0-113-20";
const FREE_NAME = "floatingip-203-0-113-21";
const PORT = BOUND.port_id;

Deno.test("list shows each floating IP and writes one record each", () =>
  withStub([
    ["floating ip list -c ID --status DOWN", { json: [{ ID: FREE.id }] }],
    [`floating ip show ${FREE.id}`, { json: FREE }],
  ], async (h) => {
    await M.list.execute({ status: "DOWN" }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.address]), [[
      "floatingIp",
      FREE_NAME,
      FREE_ADDR,
    ]]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} floating ips");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub(
    [["floating ip list", fail("Unauthorized (HTTP 401)")]],
    async (h) => {
      await assertRejects(
        () => M.list.execute({}, h.context),
        Error,
        "floating ip list failed (exit 1)",
      );
      assertEquals(h.written(), []);
    },
  ));

Deno.test("get writes the floating IP it reads", () =>
  withStub([[`floating ip show ${ADDR}`, { json: BOUND }]], async (h) => {
    await M.get.execute({ floatingIp: ADDR }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.portId]), [[
      "floatingIp",
      BOUND_NAME,
      PORT,
    ]]);
  }));

Deno.test("get fails on a missing floating IP, and writes nothing", () =>
  withStub([["floating ip show 203.0.113.99", NOT_FOUND]], async (h) => {
    await assertRejects(
      () => M.get.execute({ floatingIp: "203.0.113.99" }, h.context),
      Error,
      "floating ip show 203.0.113.99 failed",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("allocate creates an IP when no IP carries the description", () =>
  withStub([
    ["floating ip list -c ID --network ext-net", { json: [] }],
    ["floating ip create --description web ext-net", {
      json: { id: FREE.id, floating_ip_address: FREE_ADDR },
    }],
    [`floating ip show ${FREE.id}`, { json: { ...FREE, description: "web" } }],
  ], async (h) => {
    await M.allocate.execute(
      { network: "ext-net", description: "web" },
      h.context,
    );
    assertEquals(
      h.written().map((w) => [w.spec, w.name, w.data.description]),
      [["floatingIp", FREE_NAME, "web"]],
    );
    assertEquals(
      h.logs().some((l) => l.message === "allocated floating ip {address}"),
      true,
    );
  }));

Deno.test("allocate reuses an IP that carries the description", () =>
  withStub([
    ["floating ip list -c ID --network ext-net", { json: [{ ID: BOUND.id }] }],
    [`floating ip show ${BOUND.id}`, { json: BOUND }],
  ], async (h) => {
    await M.allocate.execute(
      { network: "ext-net", description: "web-01 public" },
      h.context,
    );
    assertEquals(h.written().map((w) => w.name), [BOUND_NAME]);
    assertEquals(
      h.calls.some((c) => c.startsWith("floating ip create")),
      false,
    );
  }));

Deno.test("allocate fails when the pool is empty, and writes nothing", () =>
  withStub([
    [
      "floating ip create",
      fail("No more IP addresses available on network (HTTP 409)"),
    ],
  ], async (h) => {
    await assertRejects(
      () => M.allocate.execute({ network: "ext-net" }, h.context),
      Error,
      "No more IP addresses",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("bind associates a free IP with a port and stores it as re-read", () =>
  withStub([
    [`floating ip show ${FREE_ADDR}`, { json: FREE }],
    [`floating ip set --port ${PORT} ${FREE.id}`, { stdout: "" }],
    [`floating ip show ${FREE.id}`, {
      json: { ...FREE, port_id: PORT, status: "ACTIVE" },
    }],
  ], async (h) => {
    await M.bind.execute({ floatingIp: FREE_ADDR, port: PORT }, h.context);
    assertEquals(h.written().map((w) => [w.name, w.data.portId]), [[
      FREE_NAME,
      PORT,
    ]]);
  }));

Deno.test("bind to a server fails when the CLI does, and writes nothing", () =>
  withStub([
    [`floating ip show ${FREE_ADDR}`, { json: FREE }],
    [
      `server add floating ip web-01 ${FREE_ADDR}`,
      fail("No nw_info cache associated with instance (HTTP 400)"),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.bind.execute({ floatingIp: FREE_ADDR, server: "web-01" }, h.context),
      Error,
      "No nw_info cache",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("bind refuses both a server and a port before any call", () =>
  withStub([], async (h) => {
    await assertRejects(
      () =>
        M.bind.execute(
          { floatingIp: FREE_ADDR, server: "web-01", port: PORT },
          h.context,
        ),
      Error,
      "exactly one of server or port",
    );
    assertEquals(h.calls, []);
  }));

Deno.test("unbind disassociates a bound IP from its port and stores it", () =>
  withStub([
    [`floating ip show ${ADDR}`, { json: BOUND }],
    [`floating ip unset --port ${BOUND.id}`, { stdout: "" }],
    [`floating ip show ${BOUND.id}`, {
      json: { ...BOUND, port_id: null, port_details: null },
    }],
  ], async (h) => {
    await M.unbind.execute({ floatingIp: ADDR }, h.context);
    assertEquals(h.written().map((w) => [w.name, w.data.portId]), [[
      BOUND_NAME,
      "",
    ]]);
  }));

Deno.test("unbind from a server fails when the CLI does, and writes nothing", () =>
  withStub([
    [`floating ip show ${ADDR}`, { json: BOUND }],
    [`server remove floating ip web-01 ${ADDR}`, fail("Forbidden (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () => M.unbind.execute({ floatingIp: ADDR, server: "web-01" }, h.context),
      Error,
      "Forbidden",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("release warns about a bound IP, deletes it and drops its record", () =>
  withStub([
    [`floating ip show ${ADDR}`, { json: BOUND }],
    [`floating ip delete ${BOUND.id}`, { stdout: "" }],
  ], async (h) => {
    await M.release.execute({ floatingIp: ADDR }, h.context);
    assertEquals(h.deleted(), [BOUND_NAME]);
    assertEquals(
      h.logs().filter((l) => l.level === "warning").map((l) => l.message),
      ["releasing floating ip {address} that is still bound to port {port}"],
    );
  }));

Deno.test("release fails when the CLI refuses, and drops nothing", () =>
  withStub([
    [`floating ip show ${FREE_ADDR}`, { json: FREE }],
    ["floating ip delete", fail("Forbidden (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () => M.release.execute({ floatingIp: FREE_ADDR }, h.context),
      Error,
      "Forbidden",
    );
    assertEquals(h.deleted(), []);
  }));
