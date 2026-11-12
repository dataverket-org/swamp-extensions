import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { CliError } from "../lib/cli.ts";
import { model, parseKustomization } from "./kustomization.ts";
import { harness, list, notFound } from "./stub_test.ts";

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

// ───── the methods, through createModelTestContext with a stub spawn ─────

const M = model.methods;
const KS = "kustomizations.kustomize.toolkit.fluxcd.io";
const G = { namespace: "flux-system" };
const GET = `kubectl get ${KS} apps -n flux-system`;
function ks(over: Record<string, unknown> = {}): Record<string, unknown> {
  return {
    apiVersion: "kustomize.toolkit.fluxcd.io/v1",
    kind: "Kustomization",
    metadata: { name: "apps", namespace: "flux-system" },
    spec: {
      path: "./apps",
      prune: true,
      sourceRef: { kind: "GitRepository", name: "flux-system" },
      ...over,
    },
    status: {
      conditions: [{ type: "Ready", status: "True", reason: "Succeeded" }],
      lastAppliedRevision: "main@sha1:aaa",
    },
  };
}

Deno.test("list records each Kustomization under <namespace>--<name> and logs the count", async () => {
  using h = harness({
    [`kubectl get ${KS} -n flux-system`]: { stdout: list([ks()]) },
  }, { globalArgs: G });
  await M.list.execute({}, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [[
    "kustomization",
    "flux-system--apps",
  ]]);
  assertEquals(w[0].data.lastAppliedRevision, "main@sha1:aaa");
  assertEquals(h.logs().includes("Found {count} Kustomizations"), true);
});

Deno.test("list refuses an answer that is not a list and records nothing", async () => {
  using h = harness({
    [`kubectl get ${KS} -A`]: { stdout: ks() },
  });
  await assertRejects(
    () => M.list.execute({}, h.context),
    Error,
    "did not return a list",
  );
  assertEquals(h.written(), []);
});

Deno.test("reconcile runs flux reconcile, then reads the Kustomization back and records it", async () => {
  using h = harness({
    "flux reconcile kustomization apps -n flux-system": { stdout: "" },
    [GET]: { stdout: ks() },
  }, { globalArgs: G });
  await M.reconcile.execute({ name: "apps" }, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [[
    "kustomization",
    "flux-system--apps",
  ]]);
  assertEquals(w[0].data.ready, true);
  assertEquals(
    h.logs().includes("Reconciliation complete, ready={ready}"),
    true,
  );
});

Deno.test("reconcile throws what flux said when it fails and records nothing", async () => {
  using h = harness({
    "flux reconcile kustomization apps -n flux-system --with-source": {
      code: 1,
      stderr: "✗ kustomize build failed",
    },
  }, { globalArgs: G });
  await assertRejects(
    () => M.reconcile.execute({ name: "apps", withSource: true }, h.context),
    Error,
    "flux reconcile failed: ✗ kustomize build failed",
  );
  assertEquals(h.written(), []);
});

Deno.test("reconcile fails as too-large when flux writes past the output bound, and records nothing", async () => {
  using h = harness({
    "flux reconcile kustomization apps -n flux-system": {
      code: 143,
      stdout: "► annotating Kustomization apps",
      tooLarge: true,
    },
  }, { globalArgs: G });
  const err = await assertRejects(
    () => M.reconcile.execute({ name: "apps" }, h.context),
    CliError,
    "bytes of output; the process was stopped",
  );
  assertEquals(err.kind, "too-large");
  assertEquals(h.calls.map((c) => c.key), [
    "flux reconcile kustomization apps -n flux-system",
  ]);
  assertEquals(h.written(), []);
});

Deno.test("suspend runs flux suspend and records the Kustomization as suspended", async () => {
  using h = harness({
    "flux suspend kustomization apps -n flux-system": { stdout: "" },
    [GET]: { stdout: ks({ suspend: true }) },
  }, { globalArgs: G });
  await M.suspend.execute({ name: "apps" }, h.context);
  const w = h.written();
  assertEquals(w.length, 1);
  assertEquals(w[0].data.suspended, true);
  assertEquals(
    h.logs().includes("Suspended Kustomization {name}: suspended={suspended}"),
    true,
  );
});

Deno.test("suspend passes on flux's refusal and records nothing", async () => {
  using h = harness({
    "flux suspend kustomization apps -n flux-system": {
      code: 1,
      stderr:
        '✗ kustomizations.kustomize.toolkit.fluxcd.io "apps" is forbidden',
    },
  }, { globalArgs: G });
  await assertRejects(
    () => M.suspend.execute({ name: "apps" }, h.context),
    Error,
    "flux suspend failed",
  );
  assertEquals(h.written(), []);
});

Deno.test("resume runs flux resume and records the Kustomization", async () => {
  using h = harness({
    "flux resume kustomization apps -n flux-system": { stdout: "" },
    [GET]: { stdout: ks() },
  }, { globalArgs: G });
  await M.resume.execute({ name: "apps" }, h.context);
  const w = h.written();
  assertEquals(w.length, 1);
  assertEquals(w[0].data.suspended, false);
  assertEquals(
    h.logs().includes(
      "Resumed Kustomization {name}: suspended={suspended}, ready={ready}",
    ),
    true,
  );
});

Deno.test("resume passes on a Kustomization that is gone when read back, and records nothing", async () => {
  using h = harness({
    "flux resume kustomization apps -n flux-system": { stdout: "" },
    [GET]: notFound(KS, "apps"),
  }, { globalArgs: G });
  await assertRejects(
    () => M.resume.execute({ name: "apps" }, h.context),
    Error,
    "not found",
  );
  assertEquals(h.written(), []);
});

Deno.test("resume refuses a name that is not a Kubernetes name before flux runs", async () => {
  using h = harness({}, { globalArgs: G });
  await assertRejects(() => M.resume.execute({ name: "--all" }, h.context));
  assertEquals(h.calls, []);
});
