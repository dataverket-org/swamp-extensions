import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeImage } from "./image.ts";
import { IMAGE_SHOW } from "./fixtures.ts";
import { instanceName } from "./common.ts";
import { fail, withStub } from "./test_support.ts";

const ID = IMAGE_SHOW.id;

Deno.test("normalizeImage lifts well-known Glance properties and keeps the rest", () => {
  const i = normalizeImage(IMAGE_SHOW);
  assertEquals(i.id, ID);
  assertEquals(i.name, "Debian GNU/Linux 13 (Trixie)");
  assertEquals(i.diskFormat, "raw");
  assertEquals(i.sizeBytes, 8589934592);
  assertEquals(i.minDiskGb, 10);
  assertEquals(i.protected, false);
  assertEquals(i.hidden, false);
  assertEquals(i.osDistro, "debian");
  assertEquals(i.osVersion, "13");
  assertEquals(i.architecture, "x86_64");
  assertEquals(i.description, "");
  assertEquals(i.properties, { hw_disk_bus: "virtio" });
  assertEquals(i.visibility, "public");
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;
const NAME = instanceName("image", { id: ID, name: IMAGE_SHOW.name });
const OLDER = {
  ...IMAGE_SHOW,
  id: "11111111-2222-4333-8444-555555555555",
  name: "Debian GNU/Linux 12 (Bookworm)",
  created_at: "2020-01-01T00:00:00Z",
};

Deno.test("list shows each listed image and writes one record each", () =>
  withStub([
    ["image list -c ID --public --status active", { json: [{ ID }] }],
    [`image show ${ID}`, { json: IMAGE_SHOW }],
  ], async (h) => {
    await M.list.execute(
      { visibility: "public", status: "active" },
      h.context,
    );
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.id]), [[
      "image",
      NAME,
      ID,
    ]]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} images");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([["image list", fail("Unauthorized (HTTP 401)")]], async (h) => {
    await assertRejects(
      () => M.list.execute({}, h.context),
      Error,
      "image list failed (exit 1): Unauthorized (HTTP 401)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the image it reads", () =>
  withStub([[`image show ${ID}`, { json: IMAGE_SHOW }]], async (h) => {
    await M.get.execute({ image: ID }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.diskFormat], ["image", NAME, "raw"]);
  }));

Deno.test("get fails on a missing image, and writes nothing", () =>
  withStub(
    [["image show nope", fail("No Image found for nope")]],
    async (h) => {
      await assertRejects(
        () => M.get.execute({ image: "nope" }, h.context),
        Error,
        "No Image found for nope",
      );
      assertEquals(h.written(), []);
    },
  ));

Deno.test("create uploads the file and writes the image Glance shows", async () => {
  const file = await Deno.makeTempFile({ suffix: ".raw" });
  try {
    await withStub([
      ["image list -c ID -c Name --name debian", { json: [] }],
      [
        `image create --file ${file} --disk-format raw --container-format bare --private --tag base debian`,
        { json: IMAGE_SHOW },
      ],
      [`image show ${ID}`, { json: IMAGE_SHOW }],
    ], async (h) => {
      await M.create.execute({
        name: "debian",
        file,
        diskFormat: "raw",
        containerFormat: "bare",
        visibility: "private",
        tags: ["base"],
      }, h.context);
      assertEquals(h.written().map((w) => [w.spec, w.data.id]), [[
        "image",
        ID,
      ]]);
      assertEquals(
        h.logs().some((l) => l.message === "created image {name} as {id}"),
        true,
      );
    });
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("create fails when Glance refuses the upload, and writes nothing", async () => {
  const file = await Deno.makeTempFile({ suffix: ".raw" });
  try {
    await withStub([
      ["image list -c ID -c Name --name debian", { json: [] }],
      ["image create", fail("Request Entity Too Large (HTTP 413)")],
    ], async (h) => {
      await assertRejects(
        () =>
          M.create.execute({
            name: "debian",
            file,
            diskFormat: "qcow2",
            containerFormat: "bare",
          }, h.context),
        Error,
        "Request Entity Too Large (HTTP 413)",
      );
      assertEquals(h.written(), []);
    });
  } finally {
    await Deno.remove(file);
  }
});

Deno.test("find writes only the newest image that matches", () =>
  withStub([
    ["image list -c ID --status active", {
      json: [{ ID: OLDER.id }, { ID }],
    }],
    [`image show ${OLDER.id}`, { json: OLDER }],
    [`image show ${ID}`, { json: IMAGE_SHOW }],
  ], async (h) => {
    await M.find.execute(
      { nameRegex: "^Debian", status: "active" },
      h.context,
    );
    assertEquals(h.written().map((w) => w.data.id), [ID]);
  }));

Deno.test("find fails when no image matches, and writes nothing", () =>
  withStub([
    ["image list -c ID --status active", { json: [{ ID }] }],
    [`image show ${ID}`, { json: IMAGE_SHOW }],
  ], async (h) => {
    await assertRejects(
      () =>
        M.find.execute({ nameRegex: "^Ubuntu", status: "active" }, h.context),
      Error,
      "no image matches the given criteria",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("update renames the image, drops the old record and writes the new one", () =>
  withStub([
    [`image show ${ID}`, [{ json: IMAGE_SHOW }, {
      json: { ...IMAGE_SHOW, name: "trixie" },
    }]],
    [`image set --name trixie ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.update.execute({ image: ID, name: "trixie" }, h.context);
    assertEquals(h.deleted(), [NAME]);
    assertEquals(h.written().map((w) => [w.name, w.data.name]), [[
      "image-trixie",
      "trixie",
    ]]);
  }));

Deno.test("update fails when the CLI does, and writes nothing", () =>
  withStub([
    [`image show ${ID}`, { json: IMAGE_SHOW }],
    ["image set", fail("403 Forbidden: image is protected")],
  ], async (h) => {
    await assertRejects(
      () => M.update.execute({ image: ID, protected: false }, h.context),
      Error,
      "image is protected",
    );
    assertEquals(h.written(), []);
    assertEquals(h.deleted(), []);
  }));

Deno.test("delete deletes the image by id and drops its record", () =>
  withStub([
    [`image show ${ID}`, { json: IMAGE_SHOW }],
    [`image delete ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.delete.execute({ image: ID }, h.context);
    assertEquals(h.calls.at(-1), `image delete ${ID}`);
    assertEquals(h.deleted(), [NAME]);
  }));

Deno.test("delete fails when the CLI does, and drops nothing", () =>
  withStub([
    [`image show ${ID}`, { json: IMAGE_SHOW }],
    ["image delete", fail("Image is in use (HTTP 409)")],
  ], async (h) => {
    await assertRejects(
      () => M.delete.execute({ image: ID }, h.context),
      Error,
      "Image is in use (HTTP 409)",
    );
    assertEquals(h.deleted(), []);
  }));
