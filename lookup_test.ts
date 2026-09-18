import { assertEquals } from "jsr:@std/assert@1.0.13";
import { model as flavorModel, normalizeFlavor } from "./flavor.ts";
import { model as zoneModel, normalizeZones } from "./availability_zone.ts";
import { model as typeModel, normalizeVolumeType } from "./volume_type.ts";
import { AZ_ROWS, FLAVOR_SHOW, idRows, VOLUME_TYPE_SHOW } from "./fixtures.ts";
import { installFake, line, makeContext } from "./test_support.ts";

Deno.test("normalizeFlavor reads sizing and the prefixed public/disabled flags", () => {
  const f = normalizeFlavor(FLAVOR_SHOW);
  assertEquals(f.id, "28");
  assertEquals(f.name, "m5.medium");
  assertEquals(f.vcpus, 1);
  assertEquals(f.ramMb, 4096);
  assertEquals(f.diskGb, 25);
  assertEquals(f.public, true);
  assertEquals(f.disabled, false);
  assertEquals(f.properties, { "quota:disk_read_iops_sec": "500" });
});

Deno.test("flavor list passes --all and minimums, get reads by name", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "flavor list -c ID --all --min-ram 4096") return idRows("28");
    if (l === "flavor show 28" || l === "flavor show m5.medium") {
      return FLAVOR_SHOW;
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await flavorModel.methods.list.execute(
      { all: true, minRamMb: 4096 },
      context,
    );
    await flavorModel.methods.get.execute({ flavor: "m5.medium" }, context);
    assertEquals(written.map((w) => w.name), [
      "flavor-m5-medium",
      "flavor-m5-medium",
    ]);
  } finally {
    fake.restore();
  }
});

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

Deno.test("volume type list and get store volumetype-<name>", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "volume type list -c ID") return idRows(VOLUME_TYPE_SHOW.id);
    if (
      l === `volume type show ${VOLUME_TYPE_SHOW.id}` ||
      l === "volume type show SSD"
    ) return VOLUME_TYPE_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await typeModel.methods.list.execute({}, context);
    await typeModel.methods.get.execute({ volumeType: "SSD" }, context);
    assertEquals(written.map((w) => w.name), [
      "volumetype-ssd",
      "volumetype-ssd",
    ]);
    assertEquals(normalizeVolumeType(VOLUME_TYPE_SHOW).properties, {
      volume_backend_name: "ssd",
    });
  } finally {
    fake.restore();
  }
});
