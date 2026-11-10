import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { StateInventorySchema } from "./_helpers.ts";
import { IssuerSchema } from "./_records.ts";
import { model } from "./issuer.ts";
import {
  assertGetRefusals,
  assertListFailures,
  assertNoSecrets,
  clusterIssuer,
  ctx,
  forbiddenList,
  list,
  SAID,
  withCalls,
} from "./test_support.ts";

const ISSUERS = "issuers.cert-manager.io";
const CLUSTER_ISSUERS = "clusterissuers.cert-manager.io";

const CA = {
  apiVersion: "cert-manager.io/v1",
  kind: "Issuer",
  metadata: { name: "ca", namespace: "pki" },
  spec: { ca: { secretName: "root-ca" } },
  status: {
    conditions: [{
      type: "Ready",
      status: "True",
      reason: "KeyPairVerified",
      message: "Signing CA verified",
    }],
  },
};

Deno.test("issuer list reads Issuers and ClusterIssuers and names each record by kind", async () => {
  const c = ctx({});
  await withCalls([
    { args: ["get", ISSUERS, "-A"], out: list([CA]) },
    {
      args: ["get", CLUSTER_ISSUERS],
      out: list([
        clusterIssuer("acme-dns01"),
        clusterIssuer("ca", { status: "False", reason: "Err", message: "no" }),
      ]),
    },
  ], () => model.methods.list.execute({}, c.context));
  assertEquals(c.written.map((w) => [w.spec, w.name]), [
    ["issuer", "Issuer--pki--ca"],
    ["issuer", "ClusterIssuer--acme-dns01"],
    ["issuer", "ClusterIssuer--ca"],
    ["inventory", "inventory_all"],
  ]);
  for (const w of c.written.slice(0, 3)) IssuerSchema.parse(w.data);
  const inventory = StateInventorySchema.parse(c.written[3].data);
  assertEquals(
    [inventory.namespace, inventory.count, inventory.unhealthyCount],
    [null, 3, 1],
  );
  assertEquals(inventory.items, [
    {
      namespace: "pki",
      name: "ca",
      dataName: "Issuer--pki--ca",
      healthy: true,
      reason: null,
      state: "Ready",
    },
    {
      namespace: null,
      name: "acme-dns01",
      dataName: "ClusterIssuer--acme-dns01",
      healthy: true,
      reason: null,
      state: "Ready",
    },
    {
      namespace: null,
      name: "ca",
      dataName: "ClusterIssuer--ca",
      healthy: false,
      reason: "no",
      state: "NotReady",
    },
  ]);
  assertNoSecrets(c.written, c.logs);
});

Deno.test("issuer list narrowed to one kind records the issuers and no inventory, so it cannot replace the full one", async () => {
  const c = ctx({ namespace: "pki" });
  await withCalls([
    { args: ["get", ISSUERS, "-n", "pki"], out: list([CA]) },
    { args: ["get", CLUSTER_ISSUERS], out: list([]) },
  ], async () => {
    await model.methods.list.execute({ kind: "Issuer" }, c.context);
    await model.methods.list.execute({ kind: "ClusterIssuer" }, c.context);
  });
  assertEquals(c.written.map((w) => w.name), [
    "Issuer--pki--ca",
  ]);
  // Both kinds: the inventory is written, and it holds both.
  const full = ctx({ namespace: "pki" });
  await withCalls([
    { args: ["get", ISSUERS, "-n", "pki"], out: list([CA]) },
    { args: ["get", CLUSTER_ISSUERS], out: list([clusterIssuer("x")]) },
  ], () => model.methods.list.execute({}, full.context));
  assertEquals(full.written.map((w) => w.name), [
    "Issuer--pki--ca",
    "ClusterIssuer--x",
    "inventory_ns_pki",
  ]);
});

Deno.test("issuer list writes nothing when the second kind cannot be read", async () => {
  const c = ctx({});
  await withCalls([
    { args: ["get", ISSUERS, "-A"], out: list([CA]) },
    { args: ["get", CLUSTER_ISSUERS], ...forbiddenList(CLUSTER_ISSUERS) },
  ], async () => {
    await assertRejects(
      () => model.methods.list.execute({}, c.context),
      Error,
      "is forbidden",
    );
  });
  assertEquals(c.written, []);
});

Deno.test("issuer get reads a ClusterIssuer without a namespace and an Issuer with one", async () => {
  const c = ctx({});
  await withCalls([
    {
      args: ["get", CLUSTER_ISSUERS, "acme-dns01"],
      out: clusterIssuer("acme-dns01"),
    },
    { args: ["get", ISSUERS, "ca", "-n", "pki"], out: CA },
    {
      args: ["get", CLUSTER_ISSUERS, "nope"],
      fail: SAID.notFound(CLUSTER_ISSUERS, "nope"),
    },
  ], async () => {
    await model.methods.get.execute({
      name: "acme-dns01",
      kind: "ClusterIssuer",
    }, c.context);
    await model.methods.get.execute(
      { name: "ca", namespace: "pki" },
      c.context,
    );
    const e = await assertRejects(
      () =>
        model.methods.get.execute(
          { name: "nope", kind: "ClusterIssuer" },
          c.context,
        ),
      Error,
    );
    assertEquals(e.message, "ClusterIssuer nope does not exist");
    const n = await assertRejects(
      () => model.methods.get.execute({ name: "ca" }, c.context),
      Error,
    );
    assertStringIncludes(n.message, "namespace is required for get");
  });
  assertEquals(c.written.map((w) => w.name), [
    "ClusterIssuer--acme-dns01",
    "Issuer--pki--ca",
  ]);
});

Deno.test("issuer get refuses injection-shaped names before kubectl and names a missing object", async () => {
  await assertGetRefusals(model.methods.get.execute, ISSUERS, "Issuer");
});

Deno.test("issuer list fails whole on RBAC, a missing CRD, an expired login, a timeout, output that is not JSON or an answer that is not a list", async () => {
  await assertListFailures(model.methods.list.execute, ISSUERS, "Issuer", {
    kind: "Issuer",
  });
});

Deno.test("an issuer named like the inventory, and two issuers of one name, keep their own records", async () => {
  const c = ctx({});
  const named = (kind: string, name: string, namespace?: string) => ({
    kind,
    metadata: { name, ...(namespace ? { namespace } : {}) },
  });
  await withCalls([
    {
      args: ["get", ISSUERS, "-A"],
      out: list([
        named("Issuer", "inventory", "pki"),
        named("Issuer", "x", "a"),
      ]),
    },
    {
      args: ["get", CLUSTER_ISSUERS],
      out: list([
        named("ClusterIssuer", "inventory"),
        named("ClusterIssuer", "x"),
      ]),
    },
  ], () => model.methods.list.execute({}, c.context));
  const names = c.written.map((w) => w.name);
  assertEquals(names, [
    "Issuer--pki--inventory",
    "Issuer--a--x",
    "ClusterIssuer--inventory",
    "ClusterIssuer--x",
    "inventory_all",
  ]);
  assertEquals(new Set(names).size, names.length);
});
