import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeSnapshot } from "./snapshot.ts";
import { idRows, SNAPSHOT_SHOW } from "./fixtures.ts";
import { __setPollInterval } from "./common.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

const ID = SNAPSHOT_SHOW.id;

Deno.test("normalizeSnapshot reads volume, size and status", () => {
  const s = normalizeSnapshot(SNAPSHOT_SHOW);
  assertEquals(s.volumeId, "7f84cddf-5cfd-45a9-9048-6026b41c5a45");
  assertEquals(s.sizeGb, 20);
  assertEquals(s.status, "available");
});

Deno.test("list filters by volume", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "volume snapshot list -c ID --volume web-01-state") {
      return idRows(ID);
    }
    if (l === `volume snapshot show ${ID}`) return SNAPSHOT_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({ volume: "web-01-state" }, context);
    assertEquals(written[0].name, "snapshot-web-01-state-pre-upgrade");
  } finally {
    fake.restore();
  }
});

Deno.test("create waits for the snapshot to leave creating and rejects error states", async () => {
  __setPollInterval(1);
  let polls = 0;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "volume snapshot show snap") {
      return notFound("volume snapshot", "snap");
    }
    if (l === "volume snapshot create --volume web-01-state --force snap") {
      return { ...SNAPSHOT_SHOW, name: "snap", status: "creating" };
    }
    if (l === `volume snapshot show ${ID}`) {
      polls++;
      return {
        ...SNAPSHOT_SHOW,
        name: "snap",
        status: polls < 3 ? "creating" : "available",
      };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "snap",
      volume: "web-01-state",
      force: true,
      wait: true,
      timeoutSeconds: 10,
    }, context);
    assertEquals(written[0].data.status, "available");
  } finally {
    fake.restore();
    __setPollInterval();
  }
  __setPollInterval(1);
  const failing = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "volume snapshot show bad") {
      return notFound("volume snapshot", "bad");
    }
    if (args[2] === "create") return { ...SNAPSHOT_SHOW, status: "creating" };
    if (l === `volume snapshot show ${ID}`) {
      return { ...SNAPSHOT_SHOW, status: "error" };
    }
    return undefined;
  });
  const second = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.create.execute({
          name: "bad",
          volume: "v",
          force: false,
          wait: true,
          timeoutSeconds: 10,
        }, second.context),
      Error,
      "entered status error",
    );
    assertEquals(second.written.length, 0);
  } finally {
    failing.restore();
    __setPollInterval();
  }
});

Deno.test("delete waits until the snapshot is gone and drops the resource", async () => {
  __setPollInterval(1);
  let gone = false;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `volume snapshot show ${ID}`) {
      return gone ? notFound("volume snapshot", ID) : SNAPSHOT_SHOW;
    }
    if (l === `volume snapshot delete ${ID}`) {
      gone = true;
      return "";
    }
    return undefined;
  });
  const { context, deleted } = makeContext();
  try {
    await model.methods.delete.execute({
      snapshot: ID,
      wait: true,
      timeoutSeconds: 10,
    }, context);
    assertEquals(deleted, ["snapshot-web-01-state-pre-upgrade"]);
  } finally {
    fake.restore();
    __setPollInterval();
  }
});
