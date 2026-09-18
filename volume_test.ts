import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeVolume } from "./volume.ts";
import { idRows, VOLUME_SHOW } from "./fixtures.ts";
import { __setPollInterval } from "./common.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

const ID = VOLUME_SHOW.id;

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

Deno.test("list applies name and status filters", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "volume list -c ID --name web-01-state --status in-use") {
      return idRows(ID);
    }
    if (l === `volume show ${ID}`) return VOLUME_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute(
      { name: "web-01-state", status: "in-use" },
      context,
    );
    assertEquals(written[0].name, "volume-web-01-state");
  } finally {
    fake.restore();
  }
});

Deno.test("create waits for Cinder to leave creating and stores the settled volume", async () => {
  __setPollInterval(1);
  let polls = 0;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "volume show data") return notFound("volume", "data");
    if (
      l ===
        "volume create --size 20 --type SSD --description d --property purpose=state data"
    ) {
      return {
        ...VOLUME_SHOW,
        name: "data",
        status: "creating",
        attachments: [],
      };
    }
    if (l === `volume show ${ID}`) {
      polls++;
      return {
        ...VOLUME_SHOW,
        name: "data",
        status: polls < 3 ? "creating" : "available",
        attachments: [],
      };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "data",
      sizeGb: 20,
      type: "SSD",
      description: "d",
      properties: { purpose: "state" },
      wait: true,
      timeoutSeconds: 10,
    }, context);
    assertEquals(polls, 3);
    assertEquals(written[0].data.status, "available");
  } finally {
    fake.restore();
    __setPollInterval();
  }
});

Deno.test("create surfaces an error status instead of waiting forever", async () => {
  __setPollInterval(1);
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "volume show bad") return notFound("volume", "bad");
    if (args[0] === "volume" && args[1] === "create") {
      return { ...VOLUME_SHOW, status: "creating" };
    }
    if (l === `volume show ${ID}`) return { ...VOLUME_SHOW, status: "error" };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.create.execute({
          name: "bad",
          sizeGb: 1,
          wait: true,
          timeoutSeconds: 10,
        }, context),
      Error,
      "entered status error",
    );
    assertEquals(written.length, 0);
  } finally {
    fake.restore();
    __setPollInterval();
  }
});

Deno.test("create needs a size unless cloning", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      model.methods.create.execute(
        { name: "x", wait: true, timeoutSeconds: 1 },
        context,
      ),
    Error,
    "needs sizeGb",
  );
});

Deno.test("delete waits until show reports not found, then drops the resource", async () => {
  __setPollInterval(1);
  let deleted = false;
  let showsAfterDelete = 0;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "volume show web-01-state") return VOLUME_SHOW;
    if (l === `volume delete --force ${ID}`) {
      deleted = true;
      return "";
    }
    if (l === `volume show ${ID}`) {
      if (!deleted) return VOLUME_SHOW;
      showsAfterDelete++;
      return showsAfterDelete < 2
        ? { ...VOLUME_SHOW, status: "deleting" }
        : notFound("volume", ID);
    }
    return undefined;
  });
  const { context, deleted: dropped } = makeContext();
  try {
    await model.methods.delete.execute({
      volume: "web-01-state",
      force: true,
      wait: true,
      timeoutSeconds: 10,
    }, context);
    assertEquals(dropped, ["volume-web-01-state"]);
    assertEquals(showsAfterDelete, 2);
  } finally {
    fake.restore();
    __setPollInterval();
  }
});

Deno.test("attach and detach go through server add/remove volume and settle", async () => {
  __setPollInterval(1);
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "volume show web-01-state" || l === `volume show ${ID}`) {
      return VOLUME_SHOW;
    }
    if (
      l ===
        `server add volume --device /dev/vdc --enable-delete-on-termination web-01 ${ID}`
    ) return "";
    if (l === `server remove volume web-01 ${ID}`) return "";
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.attach.execute({
      volume: "web-01-state",
      server: "web-01",
      device: "/dev/vdc",
      deleteOnTermination: true,
      timeoutSeconds: 10,
    }, context);
    assert(fake.calls.some((c) => line(c).startsWith("server add volume")));
    assertEquals(written[0].data.status, "in-use");
  } finally {
    fake.restore();
    __setPollInterval();
  }
});

Deno.test("detach polls until the volume leaves in-use", async () => {
  __setPollInterval(1);
  let removed = false;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "volume show web-01-state") return VOLUME_SHOW;
    if (l === `server remove volume web-01 ${ID}`) {
      removed = true;
      return "";
    }
    if (l === `volume show ${ID}`) {
      return removed
        ? { ...VOLUME_SHOW, status: "available", attachments: [] }
        : VOLUME_SHOW;
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.detach.execute({
      volume: "web-01-state",
      server: "web-01",
      timeoutSeconds: 10,
    }, context);
    assertEquals(written[0].data.status, "available");
    assertEquals(written[0].data.attachments, []);
  } finally {
    fake.restore();
    __setPollInterval();
  }
});
