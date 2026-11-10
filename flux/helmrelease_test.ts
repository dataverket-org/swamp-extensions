import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { forbiddenList, list, SAID, withKubectl } from "../lib/kubectl_fake.ts";
import { dataName, isKubectlError } from "../lib/kubectl.ts";
import { detailName } from "./get.ts";
import { resetName } from "./reset.ts";
import { model as helmrelease, parseHelmRelease } from "./helmrelease.ts";
import { ctx, HR, hrItem } from "./test_support.ts";

const methods = helmrelease.methods;

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

Deno.test("helmrelease list records one instance per release, named by namespace and name, with the published fields", async () => {
  const c = ctx({ namespace: "", context: "c", kubeconfig: "/k" });
  await withKubectl({
    context: "c",
    kubeconfig: "/k",
    calls: [{ args: ["get", HR, "-A"], out: list([hrItem]) }],
  }, async () => {
    const r = await methods.list.execute({}, c.context);
    assertEquals(r.dataHandles.length, 1);
  });
  assertEquals(c.written[0].spec, "helmrelease");
  assertEquals(c.written[0].name, "monitoring--kps");
  // Every field, as it was stored before this version.
  assertEquals(c.written[0].data, {
    name: "kps",
    namespace: "monitoring",
    ready: true,
    readyReason: "Ok",
    readyMessage: "",
    suspended: false,
    chartName: "kube-prometheus-stack",
    requestedVersion: "65.x",
    appliedVersion: "65.1.0",
    appVersion: "v0.77",
    deployStatus: "deployed",
    sourceRef: { kind: "HelmRepository", name: "prom", namespace: "flux" },
    conditions: [{
      type: "Ready",
      status: "True",
      reason: "Ok",
      message: "",
      lastTransitionTime: undefined,
      observedGeneration: undefined,
    }],
    lastAttemptedRevision: "65.1.0",
    lastHandledReconcileAt: undefined,
    observedGeneration: 3,
  });
});

Deno.test("NEG a condition message with a credential in it is redacted in the list record and in readyMessage", async () => {
  const c = ctx({ namespace: "" });
  const leaky = {
    ...hrItem,
    status: {
      conditions: [{
        type: "Ready",
        status: "False",
        reason: "ArtifactFailed",
        message:
          "GET https://bot:hunter2@charts.example.org/index.yaml: 401, password=hunter2",
      }],
    },
  };
  await withKubectl({
    calls: [{ args: ["get", HR, "-A"], out: list([leaky]) }],
  }, async () => {
    await methods.list.execute({}, c.context);
  });
  const stored = JSON.stringify(c.written);
  assertEquals(stored.includes("hunter2"), false);
  assertStringIncludes(stored, "https://charts.example.org/index.yaml");
});

Deno.test("helmrelease list reads one namespace from the argument, else from the definition; an empty argument counts as not given", async () => {
  for (
    const [arg, global, flags] of [
      ["apps", "", ["-n", "apps"]],
      ["apps", "other", ["-n", "apps"]],
      [undefined, "other", ["-n", "other"]],
      ["", "other", ["-n", "other"]],
      ["", "", ["-A"]],
      [undefined, "", ["-A"]],
    ] as [string | undefined, string, string[]][]
  ) {
    const c = ctx({ namespace: global });
    await withKubectl({
      calls: [{ args: ["get", HR, ...flags], out: list([]) }],
    }, async () => {
      await methods.list.execute({ namespace: arg }, c.context);
    });
    assertEquals(c.written, []);
  }
});

Deno.test("helmrelease reconcile, suspend and resume run flux with their own time limit, then read the object back", async () => {
  const read = { args: ["get", HR, "kps", "-n", "monitoring"], out: hrItem };
  const flux = (args: string[], timeoutMs: number) => ({
    bin: "flux",
    args: ["--context", "c", ...args, "kps", "-n", "monitoring"],
    timeoutMs,
  });
  const c = ctx({ namespace: "", context: "c" });
  const one = { name: "kps", namespace: "monitoring" };
  await withKubectl({
    context: "c",
    calls: [
      {
        ...flux(["reconcile", "helmrelease"], 930_000),
        args: [
          ...flux(["reconcile", "helmrelease"], 0).args,
          "--with-source",
        ],
      },
      read,
      flux(["reconcile", "helmrelease"], 330_000),
      read,
      flux(["suspend", "helmrelease"], 60_000),
      read,
      flux(["resume", "helmrelease"], 330_000),
      read,
    ],
  }, async () => {
    await methods.reconcile.execute({ ...one, withSource: true }, c.context);
    await methods.reconcile.execute(one, c.context);
    await methods.suspend.execute(one, c.context);
    await methods.resume.execute(one, c.context);
  });
  assertEquals(c.written.map((w) => [w.spec, w.name]), [
    ["helmrelease", "monitoring--kps"],
    ["helmrelease", "monitoring--kps"],
    ["helmrelease", "monitoring--kps"],
    ["helmrelease", "monitoring--kps"],
  ]);
  // Each method says how it ended, suspend and resume too.
  for (
    const line of [
      "Reconciliation complete, ready={ready}",
      "Suspended HelmRelease {name}: suspended={suspended}",
      "Resumed HelmRelease {name}: suspended={suspended}, ready={ready}",
    ]
  ) {
    assertEquals(c.logs.includes(line), true, line);
  }
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

// --- the negative suite ------------------------------------------------------

Deno.test("NEG a list namespace that is a flag or not a name is refused before kubectl runs", async () => {
  await withKubectl({}, async () => {
    for (const namespace of ["-A", "--all-namespaces", "a b", "a;id", "Apps"]) {
      const c = ctx({ namespace: "" });
      await assertRejects(
        () => methods.list.execute({ namespace }, c.context),
        Error,
        "is not a Kubernetes namespace name",
      );
      const g = ctx({ namespace });
      await assertRejects(
        () => methods.list.execute({}, g.context),
        Error,
        "is not a Kubernetes namespace name",
      );
      assertEquals([c.written, g.written], [[], []]);
    }
  });
});

Deno.test("NEG a refused list is an error though kubectl printed an empty List; so are an expired login and a closed port", async () => {
  for (
    const [answer, kind, phrase] of [
      [forbiddenList(HR), "forbidden", "is forbidden"],
      [{ fail: SAID.unauthorized }, "unauthorized", "log in again"],
      [{ fail: SAID.badToken }, "unauthorized", "log in again"],
      [{ fail: SAID.refused }, "unreachable", "could not be reached"],
      [{ fail: SAID.requestTimeout }, "timeout", "no answer in time"],
      [{ hang: true }, "timeout", "no answer within 35 seconds"],
      [{ notInstalled: true }, "not-installed", "kubectl is not on PATH"],
      [{ fail: SAID.missingCrd("helmreleases") }, "missing-crd", "CRDs"],
    ] as const
  ) {
    const c = ctx({ namespace: "" });
    await withKubectl({
      calls: [{ args: ["get", HR, "-A"], ...answer }],
    }, async () => {
      const e = await assertRejects(
        () => methods.list.execute({}, c.context),
        Error,
      );
      assertEquals(isKubectlError(e) && e.kind, kind);
      assertStringIncludes(e.message, phrase);
      if (kind !== "not-installed") {
        assertStringIncludes(e.message, `kubectl get ${HR} -A`);
      }
    });
    assertEquals(c.written, []);
  }
});

Deno.test("NEG a list answer that is not JSON, not a List, or holds something that is not a HelmRelease is an error and nothing is written", async () => {
  for (
    const [out, phrase] of [
      ["Unable to connect to the server", "did not print JSON (31 characters"],
      ["", "did not print JSON (no output)"],
      [{ kind: "Status", status: "Failure" }, "did not return a list"],
      [{ items: [hrItem] }, "did not return a list"],
      [null, "did not return a list"],
      [list([hrItem, 7]), "item 1 is not an object"],
      [list([hrItem, { kind: "Pod" }]), "not HelmRelease"],
      [
        list([hrItem, { kind: "HelmRelease", metadata: {} }]),
        "without a name or namespace",
      ],
    ] as [unknown, string][]
  ) {
    const c = ctx({ namespace: "" });
    await withKubectl({
      calls: [{ args: ["get", HR, "-A"], out }],
    }, async () => {
      await assertRejects(
        () => methods.list.execute({}, c.context),
        Error,
        phrase,
      );
    });
    assertEquals(c.written, [], phrase);
  }
});

Deno.test("NEG two releases that would be stored under one name are refused before the first write", async () => {
  const named = (namespace: string, name: string) => ({
    ...hrItem,
    metadata: { name, namespace },
  });
  const c = ctx({ namespace: "" });
  await withKubectl({
    calls: [{
      args: ["get", HR, "-A"],
      out: list([hrItem, named("a", "b--c"), named("a--b", "c")]),
    }],
  }, async () => {
    await assertRejects(
      () => methods.list.execute({}, c.context),
      Error,
      "HelmRelease a/b--c and a--b/c would both be stored as a--b--c",
    );
  });
  assertEquals(c.written, []);
});

Deno.test("NEG a failing flux is an error and nothing is read or written; a failing read after flux writes nothing", async () => {
  const c = ctx({ namespace: "apps" });
  await withKubectl({
    calls: [
      {
        bin: "flux",
        args: ["suspend", "helmrelease", "x", "-n", "apps"],
        fail: '✗ HelmRelease "x" not found',
      },
      { bin: "flux", args: ["resume", "helmrelease", "x", "-n", "apps"] },
      { args: ["get", HR, "x", "-n", "apps"], fail: SAID.notFound(HR, "x") },
      {
        bin: "flux",
        args: ["reconcile", "helmrelease", "x", "-n", "apps"],
        hang: true,
      },
    ],
  }, async () => {
    await assertRejects(
      () => methods.suspend.execute({ name: "x" }, c.context),
      Error,
      'flux suspend failed: ✗ HelmRelease "x" not found',
    );
    const e = await assertRejects(
      () => methods.resume.execute({ name: "x" }, c.context),
      Error,
      `kubectl get ${HR} x -n apps failed`,
    );
    assertEquals(isKubectlError(e, "not-found"), true);
    await assertRejects(
      () => methods.reconcile.execute({ name: "x" }, c.context),
      Error,
      "flux reconcile failed: no answer within 330 seconds",
    );
  });
  assertEquals(c.written, []);
});

Deno.test("NEG a cancelled run stops the command that is running: flux, or the read after it", async () => {
  for (const hangs of ["flux", "kubectl"]) {
    const controller = new AbortController();
    const c = ctx({ namespace: "apps" }, controller.signal);
    await withKubectl({
      calls: hangs === "flux"
        ? [{
          bin: "flux",
          args: ["reconcile", "helmrelease", "x", "-n", "apps"],
          hang: "until-cancelled",
        }]
        : [
          {
            bin: "flux",
            args: ["reconcile", "helmrelease", "x", "-n", "apps"],
          },
          { args: ["get", HR, "x", "-n", "apps"], hang: "until-cancelled" },
        ],
    }, async () => {
      const pending = assertRejects(
        () => methods.reconcile.execute({ name: "x" }, c.context),
        Error,
        "was cancelled",
      );
      await new Promise((r) => setTimeout(r, 0));
      controller.abort();
      await pending;
    });
    assertEquals(c.written, []);
  }
});
