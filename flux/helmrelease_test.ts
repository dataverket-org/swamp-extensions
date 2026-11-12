import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { dataName } from "../lib/kubectl.ts";
import { detailName } from "./get.ts";
import { resetName } from "./reset.ts";
import { model, parseHelmRelease } from "./helmrelease.ts";
import { forbidden, harness, list, notFound } from "./stub_test.ts";
import { HR, hrItem } from "./test_support.ts";

Deno.test("parseHelmRelease reads chart, versions, history and source", () => {
  const r = parseHelmRelease(hrItem);
  assertEquals(r.name, "kps");
  assertEquals(r.chartName, "kube-prometheus-stack");
  assertEquals(r.requestedVersion, "65.x");
  assertEquals(r.appliedVersion, "65.1.0");
  assertEquals(r.appVersion, "v0.77");
  assertEquals(r.deployStatus, "deployed");
  assertEquals(r.ready, true);
  assertEquals(r.sourceRef, {
    kind: "HelmRepository",
    name: "prom",
    namespace: "flux",
  });
  assertEquals(r.suspended, false);
  assertEquals(r.observedGeneration, 3);
});

Deno.test("parseHelmRelease takes chartRef as the source and survives a bare object", () => {
  const r = parseHelmRelease({
    metadata: { name: "a", namespace: "b" },
    spec: { chartRef: { kind: "OCIRepository", name: "oci" }, suspend: true },
  });
  assertEquals(r.sourceRef, {
    kind: "OCIRepository",
    name: "oci",
    namespace: undefined,
  });
  assertEquals(r.chartName, "");
  assertEquals(r.requestedVersion, "*");
  assertEquals(r.appliedVersion, "");
  assertEquals(r.suspended, true);
  assertEquals(r.ready, false);
  assertEquals(r.readyReason, "Unknown");
  const bare = parseHelmRelease({ metadata: { name: "x", namespace: "y" } });
  assertEquals(bare.sourceRef, { kind: "", name: "", namespace: undefined });
  assertEquals(bare.conditions, []);
});

Deno.test("the three records of one release on a helmrelease model have three different data names", () => {
  // swamp keys data by name, whatever the spec: a reset or a get must not
  // replace the record that list wrote.
  for (const [ns, name] of [["apps", "podinfo"], ["a", "b.c"], ["a--b", "c"]]) {
    const names = [
      dataName(ns, name),
      detailName(ns, name),
      resetName(ns, name),
    ];
    assertEquals(new Set(names).size, 3, names.join(" "));
    // A namespace holds no dot, so neither prefix can be a list record's name.
    assertEquals(names.filter((n) => /^[a-z0-9-]+--/.test(n)).length, 1);
  }
  assertEquals(resetName("apps", "podinfo"), "reset.apps--podinfo");
});

// ───── the methods, through createModelTestContext with a stub spawn ─────

const M = model.methods;
const G = { namespace: "monitoring" };
const GET = `kubectl get ${HR} kps -n monitoring`;
const suspended = {
  ...hrItem,
  spec: { ...hrItem.spec, suspend: true },
};

Deno.test("list records each HelmRelease under <namespace>--<name> and logs the count", async () => {
  using h = harness({
    [`kubectl get ${HR} -n monitoring`]: { stdout: list([hrItem]) },
  }, { globalArgs: G });
  await M.list.execute({}, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [[
    "helmrelease",
    "monitoring--kps",
  ]]);
  assertEquals(w[0].data.appliedVersion, "65.1.0");
  assertEquals(w[0].data.ready, true);
  assertEquals(h.logs().includes("Found {count} HelmReleases"), true);
});

Deno.test("list passes on a refused read and records nothing", async () => {
  using h = harness({
    [`kubectl get ${HR} -A`]: forbidden("list", HR),
  });
  await assertRejects(
    () => M.list.execute({}, h.context),
    Error,
    "forbidden",
  );
  assertEquals(h.written(), []);
});

Deno.test("reconcile runs flux reconcile, then reads the release back and records it", async () => {
  using h = harness({
    "flux reconcile helmrelease kps -n monitoring --with-source": {
      stdout: "",
    },
    [GET]: { stdout: hrItem },
  }, { globalArgs: G });
  await M.reconcile.execute({ name: "kps", withSource: true }, h.context);
  assertEquals(h.calls.map((c) => c.key), [
    "flux reconcile helmrelease kps -n monitoring --with-source",
    GET,
  ]);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [[
    "helmrelease",
    "monitoring--kps",
  ]]);
  assertEquals(
    h.logs().includes("Reconciliation complete, ready={ready}"),
    true,
  );
});

Deno.test("reconcile throws what flux said when it fails, reads nothing back and records nothing", async () => {
  using h = harness({
    "flux reconcile helmrelease kps -n monitoring": {
      code: 1,
      stderr:
        "► annotating HelmRelease kps\n✗ HelmRelease reconciliation failed: install retries exhausted",
    },
  }, { globalArgs: G });
  await assertRejects(
    () => M.reconcile.execute({ name: "kps" }, h.context),
    Error,
    "flux reconcile failed: ✗ HelmRelease reconciliation failed: install retries exhausted",
  );
  assertEquals(h.calls.length, 1);
  assertEquals(h.written(), []);
});

Deno.test("suspend runs flux suspend and records the release as suspended", async () => {
  using h = harness({
    "flux suspend helmrelease kps -n monitoring": { stdout: "" },
    [GET]: { stdout: suspended },
  }, { globalArgs: G });
  await M.suspend.execute({ name: "kps" }, h.context);
  const w = h.written();
  assertEquals(w.length, 1);
  assertEquals(w[0].data.suspended, true);
  assertEquals(
    h.logs().includes("Suspended HelmRelease {name}: suspended={suspended}"),
    true,
  );
});

Deno.test("suspend refuses a namespace it cannot name before flux runs", async () => {
  using h = harness({});
  await assertRejects(() => M.suspend.execute({ name: "kps" }, h.context));
  assertEquals(h.calls, []);
  assertEquals(h.written(), []);
});

Deno.test("resume runs flux resume and records the release as resumed", async () => {
  using h = harness({
    "flux resume helmrelease kps -n monitoring": { stdout: "" },
    [GET]: { stdout: hrItem },
  }, { globalArgs: G });
  await M.resume.execute({ name: "kps" }, h.context);
  const w = h.written();
  assertEquals(w.length, 1);
  assertEquals(w[0].data.suspended, false);
  assertEquals(
    h.logs().includes(
      "Resumed HelmRelease {name}: suspended={suspended}, ready={ready}",
    ),
    true,
  );
});

Deno.test("resume passes on a release that is gone when it is read back, and records nothing", async () => {
  using h = harness({
    "flux resume helmrelease kps -n monitoring": { stdout: "" },
    [GET]: notFound(HR, "kps"),
  }, { globalArgs: G });
  await assertRejects(
    () => M.resume.execute({ name: "kps" }, h.context),
    Error,
    "not found",
  );
  assertEquals(h.written(), []);
});
