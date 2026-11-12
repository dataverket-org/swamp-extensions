import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeVolumeType } from "./volume_type.ts";
import { fail, withStub } from "./test_support.ts";

/** `openstack volume type show <id>` as the CLI prints it. */
const TYPE_SHOW = {
  id: "7d2b6a3e-3a7f-4f4a-9b0e-5a3c1d2e4f60",
  name: "fast",
  description: "SSD-backed",
  is_public: true,
  properties: { volume_backend_name: "ssd" },
};

Deno.test("normalizeVolumeType reads the public flag and extra specs", () => {
  assertEquals(normalizeVolumeType(TYPE_SHOW), {
    id: TYPE_SHOW.id,
    name: "fast",
    description: "SSD-backed",
    public: true,
    properties: { volume_backend_name: "ssd" },
  });
});

// ───── the methods, through createModelTestContext with a stub runner ─────

Deno.test("list shows each listed volume type and writes one record each", () =>
  withStub([
    ["volume type list -c ID", { json: [{ ID: TYPE_SHOW.id }] }],
    [`volume type show ${TYPE_SHOW.id}`, { json: TYPE_SHOW }],
  ], async (h) => {
    await model.methods.list.execute({}, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name]), [[
      "volumeType",
      "volumetype-fast",
    ]]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} volume types");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([
    ["volume type list", fail("Unauthorized (HTTP 401)")],
  ], async (h) => {
    await assertRejects(
      () => model.methods.list.execute({}, h.context),
      Error,
      "volume type list failed (exit 1): Unauthorized (HTTP 401)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the volume type it reads", () =>
  withStub([["volume type show fast", { json: TYPE_SHOW }]], async (h) => {
    await model.methods.get.execute({ volumeType: "fast" }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.properties], [
      "volumeType",
      "volumetype-fast",
      { volume_backend_name: "ssd" },
    ]);
  }));

Deno.test("get fails on a missing volume type, and writes nothing", () =>
  withStub([
    [
      "volume type show nope",
      fail("No volumetype with a name or ID of 'nope' exists."),
    ],
  ], async (h) => {
    await assertRejects(
      () => model.methods.get.execute({ volumeType: "nope" }, h.context),
      Error,
      "No volumetype with a name or ID of 'nope' exists.",
    );
    assertEquals(h.written(), []);
  }));
