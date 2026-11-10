import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { forbiddenList, list, withKubectl } from "../lib/kubectl_fake.ts";
import { model as kustomization, parseKustomization } from "./kustomization.ts";
import { ctx, KS, ksItem } from "./test_support.ts";

const methods = kustomization.methods;

Deno.test("parseKustomization reads path, prune, revisions and defaults", () => {
  const r = parseKustomization({
    metadata: { name: "flux-system", namespace: "flux-system" },
    spec: {
      path: "./clusters/prod",
      prune: true,
      interval: "10m0s",
      sourceRef: { kind: "GitRepository", name: "flux-system" },
    },
    status: {
      conditions: [{
        type: "Ready",
        status: "False",
        reason: "BuildFailed",
        message: "kustomize build failed",
      }],
      lastAppliedRevision: "main@sha1:aaa",
      lastAttemptedRevision: "main@sha1:bbb",
    },
  });
  assertEquals(r.path, "./clusters/prod");
  assertEquals(r.prune, true);
  assertEquals(r.ready, false);
  assertEquals(r.readyReason, "BuildFailed");
  assertEquals(r.lastAppliedRevision, "main@sha1:aaa");
  assertEquals(r.lastAttemptedRevision, "main@sha1:bbb");
  const d = parseKustomization({ metadata: { name: "k", namespace: "n" } });
  assertEquals(d.path, "./");
  assertEquals(d.prune, false);
  assertEquals(d.conditions, []);
});

Deno.test("kustomization list records one instance per Kustomization with the published fields and names", async () => {
  const c = ctx({ namespace: "flux-system", context: "c" });
  await withKubectl({
    context: "c",
    calls: [{
      args: ["get", KS, "-n", "flux-system"],
      out: list([ksItem("flux-system", "flux-system"), ksItem("apps", "x")]),
    }],
  }, async () => {
    const r = await methods.list.execute({}, c.context);
    assertEquals(r.dataHandles.length, 2);
  });
  assertEquals(c.written.map((w) => [w.spec, w.name]), [
    ["kustomization", "flux-system--flux-system"],
    ["kustomization", "x--apps"],
  ]);
  assertEquals(Object.keys(c.written[0].data as object).sort(), [
    "conditions",
    "interval",
    "lastAppliedRevision",
    "lastAttemptedRevision",
    "name",
    "namespace",
    "observedGeneration",
    "path",
    "prune",
    "ready",
    "readyMessage",
    "readyReason",
    "sourceRef",
    "suspended",
    "targetNamespace",
  ]);
  assertEquals(
    Object.keys(kustomization.resources.kustomization.schema.shape).length,
    15,
  );
});

Deno.test("kustomization reconcile, suspend and resume run flux with their own time limit, then read the object back", async () => {
  const read = { args: ["get", KS, "k", "-n", "n"], out: ksItem("k", "n") };
  const c = ctx({ namespace: "n" });
  await withKubectl({
    calls: [
      {
        bin: "flux",
        args: ["reconcile", "kustomization", "k", "-n", "n", "--with-source"],
        timeoutMs: 630_000,
      },
      read,
      {
        bin: "flux",
        args: ["reconcile", "kustomization", "k", "-n", "n"],
        timeoutMs: 330_000,
      },
      read,
      {
        bin: "flux",
        args: ["suspend", "kustomization", "k", "-n", "n"],
        timeoutMs: 60_000,
      },
      read,
      {
        bin: "flux",
        args: ["resume", "kustomization", "k", "-n", "n"],
        timeoutMs: 330_000,
      },
      read,
    ],
  }, async () => {
    await methods.reconcile.execute(
      { name: "k", withSource: true },
      c.context,
    );
    await methods.reconcile.execute({ name: "k" }, c.context);
    await methods.suspend.execute({ name: "k" }, c.context);
    await methods.resume.execute({ name: "k" }, c.context);
  });
  assertEquals(c.written.map((w) => w.name), [
    "n--k",
    "n--k",
    "n--k",
    "n--k",
  ]);
  for (
    const line of [
      "Reconciliation complete, ready={ready}",
      "Suspended Kustomization {name}: suspended={suspended}",
      "Resumed Kustomization {name}: suspended={suspended}, ready={ready}",
    ]
  ) {
    assertEquals(c.logs.includes(line), true, line);
  }
});

Deno.test("NEG a single-object method without a namespace refuses before spawning", async () => {
  const c = ctx({ namespace: "" });
  await withKubectl({}, async () => {
    for (const namespace of [undefined, ""]) {
      const e = await assertRejects(
        () => methods.suspend.execute({ name: "k", namespace }, c.context),
        Error,
      );
      assertStringIncludes(e.message, "namespace is required for suspend");
    }
  });
  assertEquals(c.written, []);
});

Deno.test("NEG a failing flux command is an error and nothing is written", async () => {
  const c = ctx({ namespace: "n" });
  await withKubectl({
    calls: [{
      bin: "flux",
      args: ["suspend", "kustomization", "k", "-n", "n"],
      fail: 'kustomization "k" not found',
    }],
  }, async () => {
    const e = await assertRejects(
      () => methods.suspend.execute({ name: "k" }, c.context),
      Error,
    );
    assertEquals(
      e.message,
      'flux suspend failed: kustomization "k" not found',
    );
  });
  assertEquals(c.written, []);
});

Deno.test("NEG kubectl output that is not JSON fails list by name, without repeating the output", async () => {
  const c = ctx({ namespace: "" });
  await withKubectl({
    calls: [{
      args: ["get", KS, "-A"],
      out: "Unable to connect to the server: token=abc123",
    }],
  }, async () => {
    const e = await assertRejects(
      () => methods.list.execute({}, c.context),
      Error,
    );
    assertStringIncludes(e.message, `kubectl get ${KS} -A did not print JSON`);
    assertEquals(e.message.includes("abc123"), false);
  });
  assertEquals(c.written, []);
});

Deno.test("NEG a refused list, a wrong answer and a colliding pair write nothing; a bad namespace never reaches kubectl", async () => {
  for (
    const [answer, phrase] of [
      [forbiddenList(KS), "is forbidden"],
      [{ out: { kind: "Status" } }, "did not return a list"],
      [{ out: list([{ kind: "HelmRelease" }]) }, "not Kustomization"],
      [
        { out: list([ksItem("b--c", "a"), ksItem("c", "a--b")]) },
        "would both be stored as a--b--c",
      ],
    ] as const
  ) {
    const c = ctx({ namespace: "" });
    await withKubectl({
      calls: [{ args: ["get", KS, "-A"], ...answer }],
    }, async () => {
      await assertRejects(
        () => methods.list.execute({}, c.context),
        Error,
        phrase,
      );
    });
    assertEquals(c.written, []);
  }
  await withKubectl({}, async () => {
    await assertRejects(
      () =>
        methods.list.execute(
          { namespace: "-A" },
          ctx({ namespace: "" }).context,
        ),
      Error,
      "is not a Kubernetes namespace name",
    );
  });
});
