import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeKeypair } from "./keypair.ts";
import { KEYPAIR_SHOW } from "./fixtures.ts";
import { fail, withStub } from "./test_support.ts";

const GONE = fail("No keypair with a name or ID of 'ops-key' exists.");

Deno.test("normalizeKeypair keeps the public half only", () => {
  const k = normalizeKeypair(KEYPAIR_SHOW);
  assertEquals(k.id, "ops-key");
  assertEquals(k.name, "ops-key");
  assertEquals(k.type, "ssh");
  assert(k.publicKey.startsWith("ssh-ed25519 "));
  assert(!k.publicKey.endsWith("\n"));
  assertEquals(Object.keys(k).includes("privateKey"), false);
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;

Deno.test("list shows each listed keypair and writes one record each", () =>
  withStub([
    ["keypair list -c Name", { json: [{ Name: "ops-key" }] }],
    ["keypair show ops-key", { json: KEYPAIR_SHOW }],
  ], async (h) => {
    await M.list.execute({}, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.type]), [[
      "keypair",
      "keypair-ops-key",
      "ssh",
    ]]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} keypairs");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([["keypair list", fail("Unauthorized (HTTP 401)")]], async (h) => {
    await assertRejects(
      () => M.list.execute({}, h.context),
      Error,
      "keypair list failed (exit 1): Unauthorized (HTTP 401)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the keypair, its id defaulting to its name", () =>
  withStub([
    ["keypair show ops-key", { json: { ...KEYPAIR_SHOW, id: undefined } }],
  ], async (h) => {
    await M.get.execute({ keypair: "ops-key" }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.id], [
      "keypair",
      "keypair-ops-key",
      "ops-key",
    ]);
  }));

Deno.test("get fails on a missing keypair, and writes nothing", () =>
  withStub([["keypair show ops-key", GONE]], async (h) => {
    await assertRejects(
      () => M.get.execute({ keypair: "ops-key" }, h.context),
      Error,
      "No keypair with a name or ID of 'ops-key' exists.",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create lets Nova generate a key and stores the private half once", () =>
  withStub([
    ["keypair show ops-key", [GONE, { json: KEYPAIR_SHOW }]],
    ["keypair create ops-key", {
      json: {
        ...KEYPAIR_SHOW,
        private_key: "-----BEGIN OPENSSH PRIVATE KEY-----",
      },
    }],
  ], async (h) => {
    await M.create.execute({ name: "ops-key" }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name]), [
      ["keypair", "keypair-ops-key"],
      ["privateKey", "privatekey-ops-key"],
    ]);
    assertEquals(
      h.written()[1].data.privateKey,
      "-----BEGIN OPENSSH PRIVATE KEY-----",
    );
    assertEquals(
      h.written()[0].data.publicKey,
      KEYPAIR_SHOW.public_key.trim(),
    );
    assert(
      h.logs().some((l) =>
        l.message === "stored generated private key for {name}"
      ),
    );
  }));

Deno.test("create imports a public key from a file and stores no private key", () =>
  withStub([
    ["keypair show ops-key", [GONE, { json: KEYPAIR_SHOW }]],
    ["keypair create --public-key ", { json: KEYPAIR_SHOW }],
  ], async (h) => {
    await M.create.execute(
      { name: "ops-key", publicKey: KEYPAIR_SHOW.public_key },
      h.context,
    );
    assertEquals(h.written().map((w) => w.spec), ["keypair"]);
  }));

Deno.test("create fails when Nova refuses, and writes nothing", () =>
  withStub([
    ["keypair show ops-key", GONE],
    ["keypair create", fail("Quota exceeded, too many key pairs. (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () => M.create.execute({ name: "ops-key" }, h.context),
      Error,
      "Quota exceeded",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("delete deletes the keypair and drops its record", () =>
  withStub([
    ["keypair show ops-key", { json: KEYPAIR_SHOW }],
    ["keypair delete ops-key", { stdout: "" }],
  ], async (h) => {
    await M.delete.execute({ keypair: "ops-key" }, h.context);
    assertEquals(h.calls.at(-1), "keypair delete ops-key");
    assertEquals(h.deleted(), ["keypair-ops-key"]);
  }));

Deno.test("delete fails when the CLI does, and drops nothing", () =>
  withStub([
    ["keypair show ops-key", { json: KEYPAIR_SHOW }],
    ["keypair delete ops-key", fail("Internal Server Error (HTTP 500)")],
  ], async (h) => {
    await assertRejects(
      () => M.delete.execute({ keypair: "ops-key" }, h.context),
      Error,
      "keypair delete ops-key failed (exit 1): Internal Server Error",
    );
    assertEquals(h.deleted(), []);
  }));
