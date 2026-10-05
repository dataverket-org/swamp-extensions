import { assertEquals } from "jsr:@std/assert@1";
import { __setSpawn } from "./_helpers.ts";
import { model as helmrelease, parseHelmRelease } from "./helmrelease.ts";
import { ctx, hrItem, script } from "./test_support.ts";

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

Deno.test("helmrelease list records one instance per release, named by namespace and name", async () => {
  const s = script([{
    bin: "kubectl",
    args: [
      "--context",
      "c",
      "get",
      "helmreleases.helm.toolkit.fluxcd.io",
      "-A",
      "-o",
      "json",
    ],
    out: JSON.stringify({ items: [hrItem] }),
  }]);
  const c = ctx({ namespace: "", context: "c" });
  __setSpawn(s.spawn);
  try {
    const r = await helmrelease.methods.list.execute({}, c.context);
    assertEquals(r.dataHandles.length, 1);
    assertEquals(c.written[0].spec, "helmrelease");
    assertEquals(c.written[0].name, "monitoring--kps");
    s.done();
  } finally {
    __setSpawn();
  }
});

Deno.test("helmrelease reconcile runs flux then reads the object back", async () => {
  const s = script([
    {
      bin: "flux",
      args: [
        "reconcile",
        "helmrelease",
        "kps",
        "-n",
        "monitoring",
        "--with-source",
      ],
      out: "",
    },
    {
      bin: "kubectl",
      args: [
        "get",
        "helmreleases.helm.toolkit.fluxcd.io",
        "kps",
        "-n",
        "monitoring",
        "-o",
        "json",
      ],
      out: JSON.stringify(hrItem),
    },
  ]);
  const c = ctx({ namespace: "" });
  __setSpawn(s.spawn);
  try {
    await helmrelease.methods.reconcile.execute(
      { name: "kps", namespace: "monitoring", withSource: true },
      c.context,
    );
    assertEquals(c.written[0].name, "monitoring--kps");
    s.done();
  } finally {
    __setSpawn();
  }
});
