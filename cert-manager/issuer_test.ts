import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./issuer.ts";
import { forbidden, harness, list, notFound } from "./stub_test.ts";
import { assertNoSecrets, clusterIssuer } from "./test_support.ts";

// ───── the methods, through createModelTestContext with a stub kubectl ─────

const M = model.methods;
const CI = "clusterissuers.cert-manager.io";
const I = "issuers.cert-manager.io";

/** A namespaced Issuer, made from the ClusterIssuer fixture. */
function issuer(
  name: string,
  ready?: { status: string; reason: string; message: string },
) {
  const i = clusterIssuer(name, ready);
  i.kind = "Issuer";
  Object.assign(i.metadata as Record<string, unknown>, { namespace: "pki" });
  return i;
}

const NOT_READY = {
  status: "False",
  reason: "ErrRegisterACMEAccount",
  message: "Failed to register ACME account",
};

Deno.test("list records the ClusterIssuers and the Issuers of the namespace, and one inventory", async () => {
  using h = harness({
    [`kubectl get ${CI}`]: { stdout: list([clusterIssuer("acme")]) },
    [`kubectl get ${I} -n pki`]: { stdout: list([issuer("ca", NOT_READY)]) },
  });
  await M.list.execute({ namespace: "pki" }, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name, x.data.ready ?? x.data.count]), [
    ["issuer", "Issuer--pki--ca", false],
    ["issuer", "ClusterIssuer--acme", true],
    ["inventory", "inventory_ns_pki", 2],
  ]);
  assertEquals(h.logs().at(-1), "Found 2 issuers, 1 not ready");
  assertNoSecrets(w, h.logs());
});

Deno.test("list of one kind records those issuers and no inventory", async () => {
  using h = harness({
    [`kubectl get ${CI}`]: { stdout: list([clusterIssuer("acme")]) },
  });
  await M.list.execute({ kind: "ClusterIssuer" }, h.context);
  assertEquals(h.written().map((x) => x.name), ["ClusterIssuer--acme"]);
  assertEquals(h.calls.length, 1);
});

Deno.test("list passes on a refused ClusterIssuer read and records nothing, not even the Issuers read before", async () => {
  using h = harness({
    [`kubectl get ${I} -n pki`]: { stdout: list([issuer("ca")]) },
    [`kubectl get ${CI}`]: forbidden("list", CI),
  });
  await assertRejects(
    () => M.list.execute({ namespace: "pki" }, h.context),
    Error,
    "forbidden",
  );
  assertEquals(h.written(), []);
});

Deno.test("get records one Issuer in its namespace", async () => {
  using h = harness({
    [`kubectl get ${I} ca -n pki`]: { stdout: issuer("ca") },
  });
  await M.get.execute({ name: "ca", namespace: "pki" }, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name, x.data.ready]), [
    ["issuer", "Issuer--pki--ca", true],
  ]);
  assertEquals(h.logs().at(-1), "Issuer ca: ready=true");
  assertNoSecrets(w, h.logs());
});

Deno.test("get reads a ClusterIssuer without a namespace", async () => {
  using h = harness({
    [`kubectl get ${CI} acme`]: { stdout: clusterIssuer("acme", NOT_READY) },
  });
  await M.get.execute({ name: "acme", kind: "ClusterIssuer" }, h.context);
  const w = h.written();
  assertEquals(
    [w[0].name, w[0].data.ready, w[0].data.readyReason],
    ["ClusterIssuer--acme", false, "ErrRegisterACMEAccount"],
  );
});

Deno.test("get of a missing ClusterIssuer says it does not exist and records nothing", async () => {
  using h = harness({ [`kubectl get ${CI} gone`]: notFound(CI, "gone") });
  await assertRejects(
    () => M.get.execute({ name: "gone", kind: "ClusterIssuer" }, h.context),
    Error,
    "ClusterIssuer gone does not exist",
  );
  assertEquals(h.written(), []);
});

Deno.test("get of an answer that is another object is refused", async () => {
  using h = harness({
    [`kubectl get ${I} ca -n pki`]: { stdout: issuer("other") },
  });
  await assertRejects(
    () => M.get.execute({ name: "ca", namespace: "pki" }, h.context),
    Error,
    "kubectl did not return Issuer pki/ca",
  );
  assertEquals(h.written(), []);
});
