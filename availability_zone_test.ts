import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model as zoneModel, normalizeZones } from "./availability_zone.ts";
import { AZ_ROWS } from "./fixtures.ts";
import { installFake, line, makeContext } from "./test_support.ts";

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

Deno.test("zone list stores zone-<service>-<name>", async () => {
  const fake = installFake((
    args,
  ) => (line({ args, env: {} }) === "availability zone list --volume"
    ? AZ_ROWS
    : undefined)
  );
  const { context, written } = makeContext();
  try {
    await zoneModel.methods.list.execute({ service: "volume" }, context);
    assertEquals(written.map((w) => w.name), [
      "zone-volume-zone-a",
      "zone-volume-zone-b",
    ]);
    assertEquals(written[0].data.service, "volume");
  } finally {
    fake.restore();
  }
});

Deno.test("zone list rejects output that is not a list", async () => {
  const fake = installFake(() => ({ oops: true }));
  const { context, written } = makeContext();
  try {
    await assertRejects(
      () => zoneModel.methods.list.execute({ service: "compute" }, context),
      Error,
      "did not return a list",
    );
    assertEquals(written.length, 0);
  } finally {
    fake.restore();
  }
});
