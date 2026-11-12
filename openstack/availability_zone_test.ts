import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeZones } from "./availability_zone.ts";
import { AZ_ROWS } from "./fixtures.ts";
import { fail, withStub } from "./test_support.ts";

Deno.test("normalizeZones de-duplicates per-host rows and keys by service", () => {
  assertEquals(normalizeZones(AZ_ROWS, "compute"), [
    {
      id: "compute/zone-a",
      name: "zone-a",
      service: "compute",
      status: "available",
    },
    {
      id: "compute/zone-b",
      name: "zone-b",
      service: "compute",
      status: "not available",
    },
  ]);
});

// ───── the methods, through createModelTestContext with a stub runner ─────

Deno.test("list writes one record per zone, its name carrying the service", () =>
  withStub([
    ["availability zone list --volume -f json", { json: AZ_ROWS }],
  ], async (h) => {
    await model.methods.list.execute({ service: "volume" }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.status]), [
      ["zone", "zone-volume-zone-a", "available"],
      ["zone", "zone-volume-zone-b", "not available"],
    ]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} zones");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([
    ["availability zone list", fail("Forbidden (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () => model.methods.list.execute({ service: "compute" }, h.context),
      Error,
      "availability zone list failed (exit 1): Forbidden (HTTP 403)",
    );
    assertEquals(h.written(), []);
  }));
