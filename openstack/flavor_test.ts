import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeFlavor } from "./flavor.ts";
import { FLAVOR_SHOW } from "./fixtures.ts";
import { fail, withStub } from "./test_support.ts";

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

// ───── the methods, through createModelTestContext with a stub runner ─────

Deno.test("list shows each listed flavor and writes one record each", () =>
  withStub([
    ["flavor list -c ID --min-ram 2048", { json: [{ ID: "28" }] }],
    ["flavor show 28", { json: FLAVOR_SHOW }],
  ], async (h) => {
    await model.methods.list.execute(
      { all: false, minRamMb: 2048 },
      h.context,
    );
    assertEquals(h.written().map((w) => [w.spec, w.data.id]), [[
      "flavor",
      "28",
    ]]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} flavors");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([
    [
      "flavor list",
      fail("The request you have made requires authentication. (HTTP 401)"),
    ],
  ], async (h) => {
    await assertRejects(
      () => model.methods.list.execute({ all: false }, h.context),
      Error,
      "flavor list failed (exit 1): The request you have made requires authentication.",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the flavor it reads", () =>
  withStub([["flavor show m5.medium", { json: FLAVOR_SHOW }]], async (h) => {
    await model.methods.get.execute({ flavor: "m5.medium" }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.data.name, w.data.ramMb], [
      "flavor",
      "m5.medium",
      4096,
    ]);
  }));

Deno.test("get fails on a missing flavor, and writes nothing", () =>
  withStub(
    [["flavor show nope", fail("No Flavor found for nope")]],
    async (h) => {
      await assertRejects(
        () => model.methods.get.execute({ flavor: "nope" }, h.context),
        Error,
        "No Flavor found for nope",
      );
      assertEquals(h.written(), []);
    },
  ));

// ───── the application credential secret ─────

const SECRET_MARK = "appcred-secret-marker-5b8e21";

Deno.test("a CLI error that echoes the application credential secret reaches no error, log or record", () =>
  withStub(
    [[
      "flavor list",
      fail(
        `Authentication failed for secret ${SECRET_MARK} (HTTP 401)`,
      ),
    ]],
    async (h) => {
      const err = await assertRejects(
        () => model.methods.list.execute({ all: false }, h.context),
        Error,
        "failed (exit 1): Authentication failed for secret [REDACTED] (HTTP 401)",
      );
      // the CLI really got the secret, so the redaction had work to do
      assertEquals(h.envs.map((e) => e.OS_APPLICATION_CREDENTIAL_SECRET), [
        SECRET_MARK,
      ]);
      assertEquals(err.message.includes(SECRET_MARK), false);
      assertEquals(JSON.stringify(h.logs()).includes(SECRET_MARK), false);
      assertEquals(JSON.stringify(h.written()).includes(SECRET_MARK), false);
      assertEquals(h.written(), []);
    },
    {
      applicationCredentialId: "0a1b2c3d4e5f60718293a4b5c6d7e8f9",
      applicationCredentialSecret: SECRET_MARK,
    },
  ));
