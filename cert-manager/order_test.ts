import { assertEquals } from "jsr:@std/assert@1.0.13";
import { StateInventorySchema } from "./_helpers.ts";
import { OrderSchema } from "./_records.ts";
import { model } from "./order.ts";
import {
  assertGetRefusals,
  assertListFailures,
  assertNoSecrets,
  ctx,
  list,
  order,
  withCalls,
} from "./test_support.ts";

const ORDERS = "orders.acme.cert-manager.io";

Deno.test("order list and get record state and never a token, URL or body", async () => {
  const c = ctx({ namespace: "acme-test" });
  const o = order("hanging-1-1", { uid: "u", name: "hanging-1" });
  await withCalls([
    { args: ["get", ORDERS, "-n", "acme-test"], out: list([o]) },
    { args: ["get", ORDERS, "hanging-1-1", "-n", "acme-test"], out: o },
  ], async () => {
    await model.methods.list.execute({}, c.context);
    await model.methods.get.execute({ name: "hanging-1-1" }, c.context);
  });
  assertEquals(c.written.map((w) => [w.spec, w.name]), [
    ["order", "acme-test--hanging-1-1"],
    ["inventory", "inventory_ns_acme-test"],
    ["order", "acme-test--hanging-1-1"],
  ]);
  OrderSchema.parse(c.written[0].data);
  assertEquals(StateInventorySchema.parse(c.written[1].data).unhealthyCount, 1);
  assertNoSecrets(c.written, c.logs);
});

Deno.test("order get refuses injection-shaped names before kubectl and names a missing object", async () => {
  await assertGetRefusals(model.methods.get.execute, ORDERS, "Order");
});

Deno.test("order list fails whole on RBAC, a missing CRD, an expired login, a timeout, output that is not JSON or an answer that is not a list", async () => {
  await assertListFailures(model.methods.list.execute, ORDERS, "Order");
});
