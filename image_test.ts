import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeImage } from "./image.ts";
import { idRows, IMAGE_SHOW } from "./fixtures.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

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

Deno.test("list translates visibility into the CLI's flag form and fans out show", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "image list -c ID --private") return idRows(ID);
    if (l === `image show ${ID}`) return IMAGE_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({ visibility: "private" }, context);
    assertEquals(written[0].name, "image-debian-gnu-linux-13-trixie");
  } finally {
    fake.restore();
  }
});

Deno.test("list --all is passed when visibility is all", async () => {
  const fake = installFake((args) => {
    if (line({ args, env: {} }) === "image list -c ID --all") return [];
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.list.execute({ visibility: "all" }, context);
  } finally {
    fake.restore();
  }
});

Deno.test("create reuses an image found by exact name", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "image list -c ID -c Name --name my-image") {
      return [{ ID, Name: "my-image" }];
    }
    if (l === `image show ${ID}`) return IMAGE_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "my-image",
      file: "/tmp/x.qcow2",
      diskFormat: "qcow2",
      containerFormat: "bare",
    }, context);
    assertEquals(fake.calls.length, 2);
    assertEquals(written.length, 1);
  } finally {
    fake.restore();
  }
});

Deno.test("create uploads a repo-relative file with format, visibility and properties", async () => {
  const file = await Deno.makeTempFile({ suffix: ".qcow2" });
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l.startsWith("image list -c ID -c Name --name")) return [];
    if (args[0] === "image" && args[1] === "create") {
      return { ...IMAGE_SHOW, status: "queued" };
    }
    if (l === `image show ${ID}`) return IMAGE_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "my-image",
      file,
      diskFormat: "qcow2",
      containerFormat: "bare",
      minDiskGb: 10,
      visibility: "private",
      protected: true,
      properties: { os_distro: "debian" },
      tags: ["base"],
    }, context);
    const create = fake.calls[1].args;
    assertEquals(create.slice(0, 2), ["image", "create"]);
    assert(create.includes("--file") && create.includes(file));
    assert(create.includes("--disk-format") && create.includes("qcow2"));
    assert(create.includes("--private"));
    assert(create.includes("--protected"));
    assert(create.includes("os_distro=debian"));
    assert(create.includes("--tag") && create.includes("base"));
    assertEquals(create.at(-1), "my-image");
    assertEquals(written[0].data.status, "active");
  } finally {
    fake.restore();
    await Deno.remove(file);
  }
});

Deno.test("create fails early when the file does not exist", async () => {
  const fake = installFake((args) => {
    if (line({ args, env: {} }).startsWith("image list")) return [];
    return undefined;
  });
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.create.execute({
          name: "x",
          file: "missing/file.qcow2",
          diskFormat: "qcow2",
          containerFormat: "bare",
        }, context),
      Error,
      "image file not found: /repo/missing/file.qcow2",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("update with nothing to change only re-stores the image", async () => {
  const fake = installFake((args) => {
    if (line({ args, env: {} }) === `image show ${ID}`) return IMAGE_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.update.execute({ image: ID }, context);
    assertEquals(fake.calls.length, 1);
    assertEquals(written.length, 1);
  } finally {
    fake.restore();
  }
});

Deno.test("update runs image set then re-reads", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `image show ${ID}`) return IMAGE_SHOW;
    if (l === `image set --min-ram 512 --unprotected ${ID}`) return "";
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.update.execute({
      image: ID,
      minRamMb: 512,
      protected: false,
    }, context);
    assertEquals(fake.calls.length, 3);
  } finally {
    fake.restore();
  }
});

Deno.test("delete tolerates a missing image and otherwise drops the resource", async () => {
  let present = true;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `image show ${ID}`) {
      return present ? IMAGE_SHOW : notFound("image", ID);
    }
    if (l === `image delete ${ID}`) {
      present = false;
      return "";
    }
    return undefined;
  });
  const { context, deleted } = makeContext();
  try {
    await model.methods.delete.execute({ image: ID }, context);
    await model.methods.delete.execute({ image: ID }, context);
    assertEquals(deleted, ["image-debian-gnu-linux-13-trixie"]);
    assertEquals(fake.calls.length, 3);
  } finally {
    fake.restore();
  }
});

Deno.test("find passes server-side filters, applies the regex client-side and keeps only the newest", async () => {
  const older = {
    ...IMAGE_SHOW,
    id: "11111111-2222-4333-8444-555555555555",
    name: "talos-1.9.0",
    created_at: "2026-01-01T00:00:00Z",
  };
  const newer = {
    ...IMAGE_SHOW,
    id: "22222222-2222-4333-8444-555555555555",
    name: "talos-1.10.2",
    created_at: "2026-08-01T00:00:00Z",
  };
  const other = {
    ...IMAGE_SHOW,
    id: "33333333-2222-4333-8444-555555555555",
    name: "debian-13",
    created_at: "2026-09-01T00:00:00Z",
  };
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (
      l ===
        "image list -c ID --private --status active --tag k8s --property os_distro=talos"
    ) return idRows(older.id, newer.id, other.id);
    if (args[1] === "show") {
      return [older, newer, other].find((i) => i.id === args[2]);
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.find.execute({
      nameRegex: "^talos-",
      tags: ["k8s"],
      properties: { os_distro: "talos" },
      visibility: "private",
      status: "active",
    }, context);
    assertEquals(written.map((w) => w.name), ["image-talos-1-10-2"]);
  } finally {
    fake.restore();
  }
});

Deno.test("find fails when nothing matches", async () => {
  const fake = installFake((
    args,
  ) => (line({ args, env: {} }).startsWith("image list") ? [] : undefined));
  const { context, written } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.find.execute({ name: "nope", status: "active" }, context),
      Error,
      "no image matches",
    );
    assertEquals(written.length, 0);
  } finally {
    fake.restore();
  }
});
