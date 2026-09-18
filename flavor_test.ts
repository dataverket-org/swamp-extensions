import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model as flavorModel, normalizeFlavor } from "./flavor.ts";
import { FLAVOR_SHOW, idRows } from "./fixtures.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

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

Deno.test("flavor get surfaces a missing flavor as an error", async () => {
  const fake = installFake(() => notFound("flavor", "nope"));
  const { context, written } = makeContext();
  try {
    await assertRejects(
      () => flavorModel.methods.get.execute({ flavor: "nope" }, context),
      Error,
      "No flavor",
    );
    assertEquals(written.length, 0);
  } finally {
    fake.restore();
  }
});
