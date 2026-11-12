import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeSnapshot } from "./snapshot.ts";
import { fail, NOT_FOUND, withStub } from "./test_support.ts";
import { SNAPSHOT_SHOW } from "./fixtures.ts";

Deno.test("normalizeSnapshot reads volume, size and status", () => {
  const s = normalizeSnapshot(SNAPSHOT_SHOW);
  assertEquals(s.volumeId, "7f84cddf-5cfd-45a9-9048-6026b41c5a45");
  assertEquals(s.sizeGb, 20);
  assertEquals(s.status, "available");
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;
const ID = SNAPSHOT_SHOW.id;
const NAME = "snapshot-web-01-state-pre-upgrade";

Deno.test("list shows each listed snapshot and writes one record each", () =>
  withStub([
    ["volume snapshot list -c ID --volume web-01-state", {
      json: [{ ID }],
    }],
    [`volume snapshot show ${ID}`, { json: SNAPSHOT_SHOW }],
  ], async (h) => {
    await M.list.execute({ volume: "web-01-state" }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.sizeGb]), [[
      "snapshot",
      NAME,
      20,
    ]]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} snapshots");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub(
    [["volume snapshot list", fail("Unauthorized (HTTP 401)")]],
    async (h) => {
      await assertRejects(
        () => M.list.execute({}, h.context),
        Error,
        "volume snapshot list failed (exit 1): Unauthorized (HTTP 401)",
      );
      assertEquals(h.written(), []);
    },
  ));

Deno.test("get writes the snapshot it reads", () =>
  withStub(
    [[`volume snapshot show ${ID}`, { json: SNAPSHOT_SHOW }]],
    async (h) => {
      await M.get.execute({ snapshot: ID }, h.context);
      const [w] = h.written();
      assertEquals([w.spec, w.name, w.data.volumeId], [
        "snapshot",
        NAME,
        SNAPSHOT_SHOW.volume_id,
      ]);
    },
  ));

Deno.test("get fails on a missing snapshot, and writes nothing", () =>
  withStub([["volume snapshot show gone", NOT_FOUND]], async (h) => {
    await assertRejects(
      () => M.get.execute({ snapshot: "gone" }, h.context),
      Error,
      "No Server found for missing",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create snapshots the volume, waits for available and writes it", () =>
  withStub([
    [`volume snapshot show ${SNAPSHOT_SHOW.name}`, NOT_FOUND],
    ["volume snapshot create --volume web-01-state --force", {
      json: { ...SNAPSHOT_SHOW, status: "creating" },
    }],
    [`volume snapshot show ${ID}`, [
      { json: { ...SNAPSHOT_SHOW, status: "creating" } },
      { json: { ...SNAPSHOT_SHOW, status: "creating" } },
      { json: SNAPSHOT_SHOW },
    ]],
  ], async (h) => {
    await M.create.execute({
      name: SNAPSHOT_SHOW.name,
      volume: "web-01-state",
      force: true,
      wait: true,
      timeoutSeconds: 5,
    }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.status], [
      "snapshot",
      NAME,
      "available",
    ]);
    assertEquals(
      h.calls.filter((c) => c.startsWith("volume snapshot create")).length,
      1,
    );
    assertEquals(h.logs().at(-1)?.message, "snapshot {name} is {status}");
  }));

Deno.test("create reuses an existing snapshot of the same name", () =>
  withStub([
    [`volume snapshot show ${SNAPSHOT_SHOW.name}`, { json: SNAPSHOT_SHOW }],
  ], async (h) => {
    await M.create.execute({
      name: SNAPSHOT_SHOW.name,
      volume: "web-01-state",
      force: false,
      wait: true,
      timeoutSeconds: 5,
    }, h.context);
    assertEquals(h.written().map((w) => w.name), [NAME]);
    assertEquals(h.calls.some((c) => c.includes(" create ")), false);
  }));

Deno.test("create fails when the snapshot enters error, and writes nothing", () =>
  withStub([
    [`volume snapshot show ${SNAPSHOT_SHOW.name}`, NOT_FOUND],
    ["volume snapshot create", {
      json: { ...SNAPSHOT_SHOW, status: "creating" },
    }],
    [`volume snapshot show ${ID}`, [
      { json: { ...SNAPSHOT_SHOW, status: "creating" } },
      { json: { ...SNAPSHOT_SHOW, status: "error" } },
    ]],
  ], async (h) => {
    await assertRejects(
      () =>
        M.create.execute({
          name: SNAPSHOT_SHOW.name,
          volume: "web-01-state",
          force: false,
          wait: true,
          timeoutSeconds: 5,
        }, h.context),
      Error,
      `snapshot ${ID} entered status error`,
    );
    assertEquals(h.written(), []);
  }));

Deno.test("delete deletes, waits until gone and drops the stored resource", () =>
  withStub([
    [`volume snapshot show ${SNAPSHOT_SHOW.name}`, { json: SNAPSHOT_SHOW }],
    [`volume snapshot delete ${ID}`, { stdout: "" }],
    [`volume snapshot show ${ID}`, [{ json: SNAPSHOT_SHOW }, NOT_FOUND]],
  ], async (h) => {
    await M.delete.execute(
      { snapshot: SNAPSHOT_SHOW.name, wait: true, timeoutSeconds: 5 },
      h.context,
    );
    assertEquals(h.deleted(), [NAME]);
    assertEquals(h.written(), []);
  }));

Deno.test("delete fails when the CLI refuses, and drops nothing", () =>
  withStub([
    [`volume snapshot show ${SNAPSHOT_SHOW.name}`, { json: SNAPSHOT_SHOW }],
    [
      `volume snapshot delete ${ID}`,
      fail("Invalid snapshot: status must be available (HTTP 400)"),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.delete.execute(
          { snapshot: SNAPSHOT_SHOW.name, wait: true, timeoutSeconds: 5 },
          h.context,
        ),
      Error,
      "volume snapshot delete",
    );
    assertEquals(h.deleted(), []);
  }));
