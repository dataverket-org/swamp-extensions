import { assertEquals } from "jsr:@std/assert@1.0.13";
import { StateInventorySchema } from "./_helpers.ts";
import { ChallengeSchema } from "./_records.ts";
import { model } from "./challenge.ts";
import {
  assertGetRefusals,
  assertListFailures,
  assertNoSecrets,
  challenge,
  ctx,
  list,
  withCalls,
} from "./test_support.ts";

const CHALLENGES = "challenges.acme.cert-manager.io";

Deno.test("challenge list and get record state and never the token, key or solver configuration", async () => {
  const c = ctx({});
  const a = challenge("ch-a", { uid: "u", name: "o" });
  const b = challenge("ch-b", { uid: "u", name: "o" }, { status: null });
  await withCalls([
    { args: ["get", CHALLENGES, "-A"], out: list([a, b]) },
    { args: ["get", CHALLENGES, "ch-b", "-n", "acme-test"], out: b },
  ], async () => {
    await model.methods.list.execute({}, c.context);
    await model.methods.get.execute({
      name: "ch-b",
      namespace: "acme-test",
    }, c.context);
  });
  assertEquals(c.written.map((w) => [w.spec, w.name]), [
    ["challenge", "acme-test--ch-a"],
    ["challenge", "acme-test--ch-b"],
    ["inventory", "inventory_all"],
    ["challenge", "acme-test--ch-b"],
  ]);
  ChallengeSchema.parse(c.written[1].data);
  assertEquals(
    StateInventorySchema.parse(c.written[2].data).items.map((i) => i.state),
    ["pending", ""],
  );
  assertNoSecrets(c.written, c.logs);
});

Deno.test("no challenges is an empty inventory, not an error", async () => {
  const c = ctx({});
  await withCalls(
    [{ args: ["get", CHALLENGES, "-A"], out: list([]) }],
    () => model.methods.list.execute({}, c.context),
  );
  assertEquals(c.written.map((w) => w.name), ["inventory_all"]);
  assertEquals(StateInventorySchema.parse(c.written[0].data).count, 0);
});

Deno.test("challenge get refuses injection-shaped names before kubectl and names a missing object", async () => {
  await assertGetRefusals(model.methods.get.execute, CHALLENGES, "Challenge");
});

Deno.test("challenge list fails whole on RBAC, a missing CRD, an expired login, a timeout, output that is not JSON or an answer that is not a list", async () => {
  await assertListFailures(model.methods.list.execute, CHALLENGES, "Challenge");
});
