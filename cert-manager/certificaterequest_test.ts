import { assertEquals } from "jsr:@std/assert@1.0.13";
import { StateInventorySchema } from "./_helpers.ts";
import { CertificateRequestSchema } from "./_records.ts";
import { model } from "./certificaterequest.ts";
import {
  assertGetRefusals,
  assertListFailures,
  assertNoSecrets,
  ctx,
  list,
  request,
  withCalls,
} from "./test_support.ts";

const REQS = "certificaterequests.cert-manager.io";
const OWNER = { uid: "u", name: "hanging" };
Deno.test("certificaterequest list and get record state and never a CSR or certificate", async () => {
  const c = ctx({});
  await withCalls([
    {
      args: ["get", REQS, "-A"],
      out: list([
        request("hanging-1", "1", OWNER),
        request("hanging-0", "0", OWNER, {
          status: "True",
          reason: "Issued",
          message: "ok",
        }),
      ]),
    },
    {
      args: ["get", REQS, "hanging-1", "-n", "acme-test"],
      out: request("hanging-1", "1", OWNER),
    },
  ], async () => {
    await model.methods.list.execute({}, c.context);
    await model.methods.get.execute({
      name: "hanging-1",
      namespace: "acme-test",
    }, c.context);
  });
  assertEquals(c.written.map((w) => [w.spec, w.name]), [
    ["certificateRequest", "acme-test--hanging-1"],
    ["certificateRequest", "acme-test--hanging-0"],
    ["inventory", "inventory_all"],
    ["certificateRequest", "acme-test--hanging-1"],
  ]);
  CertificateRequestSchema.parse(c.written[0].data);
  const inventory = StateInventorySchema.parse(c.written[2].data);
  assertEquals([inventory.count, inventory.unhealthyCount], [2, 1]);
  assertEquals(inventory.items[0].state, "Pending");
  assertNoSecrets(c.written, c.logs);
});

Deno.test("certificaterequest get refuses injection-shaped names before kubectl and names a missing object", async () => {
  await assertGetRefusals(
    model.methods.get.execute,
    REQS,
    "CertificateRequest",
  );
});

Deno.test("certificaterequest list fails whole on RBAC, a missing CRD, an expired login, a timeout, output that is not JSON or an answer that is not a list", async () => {
  await assertListFailures(
    model.methods.list.execute,
    REQS,
    "CertificateRequest",
  );
});
