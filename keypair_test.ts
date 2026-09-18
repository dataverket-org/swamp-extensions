import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { model, normalizeKeypair } from "./keypair.ts";
import { KEYPAIR_CREATE_GENERATED, KEYPAIR_SHOW } from "./fixtures.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

Deno.test("normalizeKeypair keeps the public half only", () => {
  const k = normalizeKeypair(KEYPAIR_SHOW);
  assertEquals(k.id, "ops-key");
  assertEquals(k.name, "ops-key");
  assertEquals(k.type, "ssh");
  assert(k.publicKey.startsWith("ssh-ed25519 "));
  assert(!k.publicKey.endsWith("\n"));
  assertEquals(Object.keys(k).includes("privateKey"), false);
});

Deno.test("list reads names then shows each keypair", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "keypair list -c Name") return [{ Name: "ops-key" }];
    if (l === "keypair show ops-key") return KEYPAIR_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({}, context);
    assertEquals(written.map((w) => w.name), ["keypair-ops-key"]);
  } finally {
    fake.restore();
  }
});

Deno.test("create generates a keypair and stores the private key sensitively", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "keypair show gen-key") {
      return fake.calls.length > 1
        ? { ...KEYPAIR_SHOW, name: "gen-key", id: "gen-key" }
        : notFound("keypair", "gen-key");
    }
    if (l === "keypair create gen-key") return KEYPAIR_CREATE_GENERATED;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({ name: "gen-key" }, context);
    assertEquals(written.map((w) => `${w.spec}:${w.name}`), [
      "keypair:keypair-gen-key",
      "privateKey:privatekey-gen-key",
    ]);
    assert(
      String(written[1].data.privateKey).includes("BEGIN OPENSSH PRIVATE KEY"),
    );
  } finally {
    fake.restore();
  }
});

Deno.test("create imports a public key through a temp file and writes no private key", async () => {
  let imported = "";
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "keypair show ops-key") {
      return imported ? KEYPAIR_SHOW : notFound("keypair", "ops-key");
    }
    if (args[0] === "keypair" && args[1] === "create") {
      imported = Deno.readTextFileSync(args[args.indexOf("--public-key") + 1]);
      return { ...KEYPAIR_SHOW, private_key: null };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "ops-key",
      publicKey: "ssh-ed25519 AAAA ops",
    }, context);
    assertEquals(imported, "ssh-ed25519 AAAA ops\n");
    assertEquals(written.length, 1);
    assertEquals(written[0].spec, "keypair");
  } finally {
    fake.restore();
  }
});

Deno.test("create reuses an existing keypair", async () => {
  const fake = installFake((args) => {
    if (line({ args, env: {} }) === "keypair show ops-key") return KEYPAIR_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({ name: "ops-key" }, context);
    assertEquals(fake.calls.length, 1);
    assertEquals(written.length, 1);
  } finally {
    fake.restore();
  }
});

Deno.test("delete is idempotent and drops the stored resource", async () => {
  let present = true;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "keypair show ops-key") {
      return present ? KEYPAIR_SHOW : notFound("keypair", "ops-key");
    }
    if (l === "keypair delete ops-key") {
      present = false;
      return "";
    }
    return undefined;
  });
  const { context, deleted } = makeContext();
  try {
    await model.methods.delete.execute({ keypair: "ops-key" }, context);
    await model.methods.delete.execute({ keypair: "ops-key" }, context);
    assertEquals(deleted, ["keypair-ops-key"]);
  } finally {
    fake.restore();
  }
});
