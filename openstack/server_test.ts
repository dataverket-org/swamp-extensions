import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeServer, parseNameId } from "./server.ts";
import { SERVER_SHOW, SERVER_SHOW_2 } from "./fixtures.ts";
import { fail, withStub } from "./test_support.ts";

const ID = SERVER_SHOW.id;

Deno.test("normalizeServer shapes the 10.3.0 server show output", () => {
  const s = normalizeServer(SERVER_SHOW);
  assertEquals(s.id, ID);
  assertEquals(s.name, "web-01");
  assertEquals(s.status, "ACTIVE");
  assertEquals(s.powerState, "RUNNING");
  assertEquals(s.vmState, "active");
  assertEquals(s.taskState, "");
  assertEquals(s.availabilityZone, "zone-a");
  assertEquals(
    s.hostId,
    "5576ffc29a3b73a627059d86980f0b8eb70b0cdde14516f63cda4668",
  );
  assertEquals(s.addresses, { "private-net": ["192.0.2.10", "203.0.113.20"] });
  assertEquals(s.ipAddresses, ["192.0.2.10", "203.0.113.20"]);
  assertEquals(s.imageName, "Debian GNU/Linux 13 (Trixie)");
  assertEquals(s.imageId, "5021ee7c-1bcb-49b5-9f96-d477611b29d5");
  assertEquals(s.flavorName, "m5.medium");
  assertEquals(s.vcpus, 1);
  assertEquals(s.ramMb, 4096);
  assertEquals(s.diskGb, 25);
  assertEquals(s.keyName, "ops-key");
  assertEquals(s.securityGroups, ["ssh", "default"]);
  assertEquals(s.volumesAttached, ["7f84cddf-5cfd-45a9-9048-6026b41c5a45"]);
  assertEquals(s.properties, { role: "web" });
  assertEquals(s.tags, ["web"]);
  assertEquals(s.locked, false);
  assertEquals(s.launchedAt, "2026-09-15T10:28:21.000000");
  const stopped = normalizeServer(SERVER_SHOW_2);
  assertEquals(stopped.powerState, "SHUTDOWN");
  assertEquals(stopped.imageName, "N/A (booted from volume)");
  assertEquals(stopped.imageId, "");
});

Deno.test("parseNameId handles objects, name (uuid) strings and plain names", () => {
  assertEquals(parseNameId({ name: "a", id: "b" }), { name: "a", id: "b" });
  assertEquals(parseNameId("m5 (5021ee7c-1bcb-49b5-9f96-d477611b29d5)"), {
    name: "m5",
    id: "5021ee7c-1bcb-49b5-9f96-d477611b29d5",
  });
  assertEquals(parseNameId("m5.medium"), { name: "m5.medium", id: "" });
});

Deno.test("create needs a NIC source and a boot source, and calls nothing", () =>
  withStub([], async (h) => {
    await assertRejects(
      () =>
        model.methods.create.execute({
          name: "x",
          flavor: "f",
          image: "i",
          wait: true,
        }, h.context),
      Error,
      "at least one of networks, ports or nics",
    );
    await assertRejects(
      () =>
        model.methods.create.execute({
          name: "x",
          flavor: "f",
          networks: ["n"],
          nics: [{}],
          wait: true,
        }, h.context),
      Error,
      "image, a volume or a boot-index-0",
    );
    assertEquals(h.calls, []);
  }));

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;
const NAME = "server-web-01";
const NET = "3c6d31a5-9c4a-4bf6-9ad1-38e3a07149e5";
const PORT = "6a1b2c3d-4e5f-4a6b-8c7d-9e0f1a2b3c4d";
const GONE = fail("No server with a name or ID of 'web-01' exists.");
const SHUTOFF = {
  ...SERVER_SHOW,
  status: "SHUTOFF",
  "OS-EXT-STS:power_state": 4,
  "OS-EXT-STS:vm_state": "stopped",
};

Deno.test("list shows each listed server and writes one record each", () =>
  withStub([
    ["server list -c ID --status ACTIVE", { json: [{ ID }] }],
    [`server show ${ID}`, { json: SERVER_SHOW }],
  ], async (h) => {
    await M.list.execute({ status: "ACTIVE" }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.status]), [[
      "server",
      NAME,
      "ACTIVE",
    ]]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} servers");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([["server list", fail("Unauthorized (HTTP 401)")]], async (h) => {
    await assertRejects(
      () => M.list.execute({}, h.context),
      Error,
      "server list failed (exit 1): Unauthorized (HTTP 401)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the server it reads", () =>
  withStub([["server show web-01", { json: SERVER_SHOW }]], async (h) => {
    await M.get.execute({ server: "web-01" }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.id, w.data.flavorName], [
      "server",
      NAME,
      ID,
      "m5.medium",
    ]);
  }));

Deno.test("get fails on a missing server, and writes nothing", () =>
  withStub([["server show web-01", GONE]], async (h) => {
    await assertRejects(
      () => M.get.execute({ server: "web-01" }, h.context),
      Error,
      "No server with a name or ID of 'web-01' exists.",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create boots a server, resolving a NIC's network, and writes what Nova shows", () =>
  withStub([
    ["server show web-01", GONE],
    ["network show private-net", { json: { id: NET, name: "private-net" } }],
    [
      `server create --flavor m5.medium --image debian --nic net-id=${NET},v4-fixed-ip=192.0.2.10 --key-name ops-key --wait web-01`,
      { json: SERVER_SHOW },
    ],
    [`server show ${ID}`, { json: SERVER_SHOW }],
  ], async (h) => {
    await M.create.execute({
      name: "web-01",
      flavor: "m5.medium",
      image: "debian",
      nics: [{ network: "private-net", fixedIpV4: "192.0.2.10" }],
      keyName: "ops-key",
      wait: true,
    }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.id]), [[
      "server",
      NAME,
      ID,
    ]]);
    assertEquals(
      h.logs().some((l) => l.message === "created server {name} as {id}"),
      true,
    );
  }));

Deno.test("create fails when Nova cannot build, and writes nothing", () =>
  withStub([
    ["server show web-01", GONE],
    [
      "server create",
      fail("Error creating server: web-01\nError creating server"),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.create.execute({
          name: "web-01",
          flavor: "m5.medium",
          image: "debian",
          networks: ["private-net"],
          wait: true,
        }, h.context),
      Error,
      "server create failed (exit 1)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("update renames the server, drops the old record and writes the new one", () =>
  withStub([
    ["server show web-01", { json: SERVER_SHOW }],
    [`server set --name web-02 ${ID}`, { stdout: "" }],
    [`server show ${ID}`, { json: { ...SERVER_SHOW, name: "web-02" } }],
  ], async (h) => {
    await M.update.execute({ server: "web-01", name: "web-02" }, h.context);
    assertEquals(h.deleted(), [NAME]);
    assertEquals(h.written().map((w) => w.name), ["server-web-02"]);
  }));

Deno.test("update fails when the CLI does, and writes nothing", () =>
  withStub([
    ["server show web-01", { json: SERVER_SHOW }],
    ["server unset", fail("Instance is locked (HTTP 409)")],
  ], async (h) => {
    await assertRejects(
      () =>
        M.update.execute(
          { server: "web-01", removeProperties: ["role"] },
          h.context,
        ),
      Error,
      "Instance is locked (HTTP 409)",
    );
    assertEquals(h.written(), []);
    assertEquals(h.deleted(), []);
  }));

Deno.test("delete deletes the server by id and drops its record", () =>
  withStub([
    ["server show web-01", { json: SERVER_SHOW }],
    [`server delete --wait ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.delete.execute(
      { server: "web-01", force: false, wait: true },
      h.context,
    );
    assertEquals(h.deleted(), [NAME]);
    assertEquals(h.logs().at(-1)?.message, "deleted server {name}");
  }));

Deno.test("delete fails when the CLI does, and drops nothing", () =>
  withStub([
    ["server show web-01", { json: SERVER_SHOW }],
    ["server delete", fail("Instance is locked (HTTP 409)")],
  ], async (h) => {
    await assertRejects(
      () =>
        M.delete.execute(
          { server: "web-01", force: false, wait: false },
          h.context,
        ),
      Error,
      "Instance is locked (HTTP 409)",
    );
    assertEquals(h.deleted(), []);
  }));

Deno.test("attachInterface adds a port and writes the server again", () =>
  withStub([
    ["server show web-01", { json: SERVER_SHOW }],
    [`server add port ${ID} ${PORT}`, { stdout: "" }],
    [`server show ${ID}`, { json: SERVER_SHOW }],
  ], async (h) => {
    await M.attachInterface.execute(
      { server: "web-01", port: PORT },
      h.context,
    );
    assertEquals(h.calls[1], `server add port ${ID} ${PORT}`);
    assertEquals(h.written().map((w) => w.name), [NAME]);
  }));

Deno.test("attachInterface fails when Nova refuses, and writes nothing", () =>
  withStub([
    ["server show web-01", { json: SERVER_SHOW }],
    ["server add network", fail("No Network found for nope")],
  ], async (h) => {
    await assertRejects(
      () =>
        M.attachInterface.execute(
          { server: "web-01", network: "nope" },
          h.context,
        ),
      Error,
      "No Network found for nope",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("detachInterface removes the NICs on a network and writes the server again", () =>
  withStub([
    ["server show web-01", { json: SERVER_SHOW }],
    [`server remove network ${ID} private-net`, { stdout: "" }],
    [`server show ${ID}`, { json: SERVER_SHOW }],
  ], async (h) => {
    await M.detachInterface.execute(
      { server: "web-01", network: "private-net" },
      h.context,
    );
    assertEquals(h.written().map((w) => w.name), [NAME]);
  }));

Deno.test("detachInterface fails when Nova refuses, and writes nothing", () =>
  withStub([
    ["server show web-01", { json: SERVER_SHOW }],
    ["server remove port", fail("Port not attached (HTTP 404)")],
  ], async (h) => {
    await assertRejects(
      () =>
        M.detachInterface.execute(
          { server: "web-01", port: PORT },
          h.context,
        ),
      Error,
      "Port not attached (HTTP 404)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("start starts the server and writes its new state", () =>
  withStub([
    ["server show web-01", { json: SHUTOFF }],
    [`server start ${ID}`, { stdout: "" }],
    [`server show ${ID}`, { json: SERVER_SHOW }],
  ], async (h) => {
    await M.start.execute({ server: "web-01" }, h.context);
    assertEquals(h.written().map((w) => [w.name, w.data.status]), [[
      NAME,
      "ACTIVE",
    ]]);
  }));

Deno.test("start fails when Nova refuses, and writes nothing", () =>
  withStub([
    ["server show web-01", { json: SERVER_SHOW }],
    [
      "server start",
      fail("Cannot 'start' instance while it is in vm_state active (HTTP 409)"),
    ],
  ], async (h) => {
    await assertRejects(
      () => M.start.execute({ server: "web-01" }, h.context),
      Error,
      "Cannot 'start' instance",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("stop stops the server and writes its new state", () =>
  withStub([
    ["server show web-01", { json: SERVER_SHOW }],
    [`server stop ${ID}`, { stdout: "" }],
    [`server show ${ID}`, { json: SHUTOFF }],
  ], async (h) => {
    await M.stop.execute({ server: "web-01" }, h.context);
    assertEquals(h.written().map((w) => [w.name, w.data.status]), [[
      NAME,
      "SHUTOFF",
    ]]);
  }));

Deno.test("stop fails on a missing server, and writes nothing", () =>
  withStub([["server show web-01", GONE]], async (h) => {
    await assertRejects(
      () => M.stop.execute({ server: "web-01" }, h.context),
      Error,
      "No server with a name or ID of 'web-01' exists.",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("reboot hard-reboots the server and writes its new state", () =>
  withStub([
    ["server show web-01", { json: SERVER_SHOW }],
    [`server reboot --hard --wait ${ID}`, { stdout: "" }],
    [`server show ${ID}`, { json: SERVER_SHOW }],
  ], async (h) => {
    await M.reboot.execute(
      { server: "web-01", hard: true, wait: true },
      h.context,
    );
    assertEquals(h.written().map((w) => w.name), [NAME]);
  }));

Deno.test("reboot fails when Nova refuses, and writes nothing", () =>
  withStub([
    ["server show web-01", { json: SHUTOFF }],
    [
      "server reboot",
      fail(
        "Cannot 'reboot' instance while it is in vm_state stopped (HTTP 409)",
      ),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.reboot.execute(
          { server: "web-01", hard: false, wait: false },
          h.context,
        ),
      Error,
      "Cannot 'reboot' instance",
    );
    assertEquals(h.written(), []);
  }));
