import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeVolume } from "./volume.ts";
import { VOLUME_SHOW } from "./fixtures.ts";
import { fail, withStub } from "./test_support.ts";

Deno.test("normalizeVolume flattens attachments and tenant attributes", () => {
  const v = normalizeVolume(VOLUME_SHOW);
  assertEquals(v.name, "web-01-state");
  assertEquals(v.sizeGb, 20);
  assertEquals(v.type, "SSD");
  assertEquals(v.status, "in-use");
  assertEquals(v.attachments, [{
    serverId: "55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8",
    device: "/dev/vdb",
    attachmentId: "2e096722-4d9b-40d5-b783-cdd9f8853f38",
    attachedAt: "2026-09-18T08:03:45.000000",
  }]);
  assertEquals(v.projectId, "0123456789abcdef0123456789abcdef");
  assertEquals(v.properties, { purpose: "state" });
  assertEquals(v.snapshotId, "");
});

Deno.test("create needs a size unless cloning, and calls nothing", () =>
  withStub([], async (h) => {
    await assertRejects(
      () =>
        model.methods.create.execute(
          { name: "x", wait: true, timeoutSeconds: 1 },
          h.context,
        ),
      Error,
      "needs sizeGb",
    );
    assertEquals(h.calls, []);
  }));

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;
const ID = VOLUME_SHOW.id;
const SERVER = "55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8";
const NAME = "volume-web-01-state";
const AVAILABLE = { ...VOLUME_SHOW, status: "available", attachments: [] };
const GONE = fail("No volume with a name or ID of 'web-01-state' exists.");

Deno.test("list shows each listed volume and writes one record each", () =>
  withStub([
    ["volume list -c ID --status in-use", { json: [{ ID }] }],
    [`volume show ${ID}`, { json: VOLUME_SHOW }],
  ], async (h) => {
    await M.list.execute({ status: "in-use" }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.sizeGb]), [[
      "volume",
      NAME,
      20,
    ]]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} volumes");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([["volume list", fail("Unauthorized (HTTP 401)")]], async (h) => {
    await assertRejects(
      () => M.list.execute({}, h.context),
      Error,
      "volume list failed (exit 1): Unauthorized (HTTP 401)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the volume it reads", () =>
  withStub([["volume show web-01-state", { json: VOLUME_SHOW }]], async (h) => {
    await M.get.execute({ volume: "web-01-state" }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.status], ["volume", NAME, "in-use"]);
  }));

Deno.test("get fails on a missing volume, and writes nothing", () =>
  withStub([["volume show web-01-state", GONE]], async (h) => {
    await assertRejects(
      () => M.get.execute({ volume: "web-01-state" }, h.context),
      Error,
      "No volume with a name or ID",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create makes a volume, waits until it is available and writes it", () =>
  withStub([
    ["volume show web-01-state", GONE],
    ["volume create --size 20 --type SSD web-01-state", {
      json: { ...AVAILABLE, status: "creating" },
    }],
    [`volume show ${ID}`, [
      { json: { ...AVAILABLE, status: "creating" } },
      { json: AVAILABLE },
    ]],
  ], async (h) => {
    await M.create.execute({
      name: "web-01-state",
      sizeGb: 20,
      type: "SSD",
      wait: true,
      timeoutSeconds: 5,
    }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.status]), [[
      "volume",
      NAME,
      "available",
    ]]);
    assertEquals(h.logs().at(-1)?.message, "volume {name} is {status}");
  }));

Deno.test("create fails when the volume enters error, and writes nothing", () =>
  withStub([
    ["volume show web-01-state", GONE],
    ["volume create", { json: { ...AVAILABLE, status: "creating" } }],
    [`volume show ${ID}`, { json: { ...AVAILABLE, status: "error" } }],
  ], async (h) => {
    await assertRejects(
      () =>
        M.create.execute({
          name: "web-01-state",
          sizeGb: 20,
          wait: true,
          timeoutSeconds: 5,
        }, h.context),
      Error,
      `volume ${ID} entered status error`,
    );
    assertEquals(h.written(), []);
  }));

Deno.test("update extends the volume and writes what Cinder shows", () =>
  withStub([
    [`volume show ${ID}`, [{ json: AVAILABLE }, {
      json: { ...AVAILABLE, size: 40 },
    }]],
    [`volume set --size 40 ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.update.execute({ volume: ID, sizeGb: 40 }, h.context);
    assertEquals(h.deleted(), []);
    assertEquals(h.written().map((w) => [w.name, w.data.sizeGb]), [[NAME, 40]]);
  }));

Deno.test("update fails when Cinder refuses, and writes nothing", () =>
  withStub([
    [`volume show ${ID}`, { json: AVAILABLE }],
    [
      "volume set",
      fail("New size for extend must be greater than current size (HTTP 400)"),
    ],
  ], async (h) => {
    await assertRejects(
      () => M.update.execute({ volume: ID, sizeGb: 10 }, h.context),
      Error,
      "must be greater than current size",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("delete deletes the volume, waits for it to vanish and drops its record", () =>
  withStub([
    ["volume show web-01-state", { json: AVAILABLE }],
    [`volume delete ${ID}`, { stdout: "" }],
    [`volume show ${ID}`, [
      { json: { ...AVAILABLE, status: "deleting" } },
      GONE,
    ]],
  ], async (h) => {
    await M.delete.execute({
      volume: "web-01-state",
      force: false,
      wait: true,
      timeoutSeconds: 5,
    }, h.context);
    assertEquals(h.deleted(), [NAME]);
    assertEquals(h.logs().at(-1)?.message, "deleted volume {name}");
  }));

Deno.test("delete fails when the volume is in use, and drops nothing", () =>
  withStub([
    ["volume show web-01-state", { json: VOLUME_SHOW }],
    [
      "volume delete",
      fail("Invalid volume: Volume status must be available (HTTP 400)"),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.delete.execute({
          volume: "web-01-state",
          force: false,
          wait: true,
          timeoutSeconds: 5,
        }, h.context),
      Error,
      "Volume status must be available",
    );
    assertEquals(h.deleted(), []);
  }));

Deno.test("attach adds the volume to the server and writes it once in use", () =>
  withStub([
    [`volume show ${ID}`, [
      { json: AVAILABLE },
      { json: { ...AVAILABLE, status: "attaching" } },
      { json: VOLUME_SHOW },
    ]],
    [`server add volume --device /dev/vdb ${SERVER} ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.attach.execute({
      volume: ID,
      server: SERVER,
      device: "/dev/vdb",
      timeoutSeconds: 5,
    }, h.context);
    const [w] = h.written();
    assertEquals([w.name, w.data.status], [NAME, "in-use"]);
    assertEquals(
      (w.data.attachments as { serverId: string }[])[0].serverId,
      SERVER,
    );
  }));

Deno.test("attach fails when Nova refuses, and writes nothing", () =>
  withStub([
    [`volume show ${ID}`, { json: AVAILABLE }],
    [
      "server add volume",
      fail("No server with a name or ID of 'web-99' exists."),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.attach.execute(
          { volume: ID, server: "web-99", timeoutSeconds: 5 },
          h.context,
        ),
      Error,
      "No server with a name or ID of 'web-99' exists.",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("detach removes the volume from the server and writes it once available", () =>
  withStub([
    [`volume show ${ID}`, [
      { json: VOLUME_SHOW },
      { json: { ...VOLUME_SHOW, status: "detaching" } },
      { json: AVAILABLE },
    ]],
    [`server remove volume ${SERVER} ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.detach.execute(
      { volume: ID, server: SERVER, timeoutSeconds: 5 },
      h.context,
    );
    const [w] = h.written();
    assertEquals([w.name, w.data.status, w.data.attachments], [
      NAME,
      "available",
      [],
    ]);
  }));

Deno.test("detach fails when the volume stays in use past the timeout, and writes nothing", () =>
  withStub([
    [`volume show ${ID}`, { json: VOLUME_SHOW }],
    [`server remove volume ${SERVER} ${ID}`, { stdout: "" }],
  ], async (h) => {
    await assertRejects(
      () =>
        M.detach.execute(
          { volume: ID, server: SERVER, timeoutSeconds: 0.05 },
          h.context,
        ),
      Error,
      `timed out after 0.05s waiting for volume ${ID} to settle`,
    );
    assertEquals(h.written(), []);
  }));
