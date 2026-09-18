import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model as typeModel, normalizeVolumeType } from "./volume_type.ts";
import { idRows, VOLUME_TYPE_SHOW } from "./fixtures.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

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

Deno.test("volume type get surfaces a missing type as an error", async () => {
  const fake = installFake(() => notFound("volume type", "nope"));
  const { context, written } = makeContext();
  try {
    await assertRejects(
      () => typeModel.methods.get.execute({ volumeType: "nope" }, context),
      Error,
      "No volume type",
    );
    assertEquals(written.length, 0);
  } finally {
    fake.restore();
  }
});
