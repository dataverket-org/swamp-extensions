import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { durationMs, isKindProgress, model, shellQuote } from "./cluster.ts";
import { harness } from "./stub_test.ts";

Deno.test("each pre-flight check names exactly the methods that run its binary", () => {
  // swamp runs no check before a read, so get is in neither list; delete
  // never runs kubectl and must not be stopped by a machine without it.
  assertEquals(Object.keys(model.checks).sort(), [
    "kind-cli-available",
    "kubectl-cli-available",
  ]);
  assertEquals(model.checks["kind-cli-available"].appliesTo, [
    "ensure",
    "delete",
  ]);
  assertEquals(model.checks["kubectl-cli-available"].appliesTo, ["ensure"]);
  for (const applies of Object.values(model.checks).map((c) => c.appliesTo)) {
    for (const method of applies) assert(method in model.methods, method);
  }
});

Deno.test("durationMs reads what kind takes for --wait", () => {
  assertEquals(durationMs("120s"), 120_000);
  assertEquals(durationMs("2m"), 120_000);
  assertEquals(durationMs("1m30s"), 90_000);
  assertEquals(durationMs("1.5m"), 90_000);
  assertEquals(durationMs("500ms"), 500);
  assertEquals(durationMs("1h"), 3_600_000);
  assertEquals(durationMs("0"), 0);
  assertEquals(durationMs("0s"), 0);
});

Deno.test("isKindProgress drops progress and keeps the error", () => {
  for (
    const noise of [
      "using podman due to KIND_EXPERIMENTAL_PROVIDER",
      "enabling experimental podman provider",
      'Creating cluster "t" ...',
      'Deleting cluster "t" ...',
      " • Ensuring node image (kindest/node:v1.37.0) 🖼️  ...",
      " ✓ Preparing nodes 📦 ",
    ]
  ) assert(isKindProgress(noise), noise);
  for (
    const kept of [
      " ✗ Starting control-plane 🕹️",
      "ERROR: failed to create cluster: error reading file",
      "Command Output: I1110 10:00:00.000000",
    ]
  ) assert(!isKindProgress(kept), kept);
});

Deno.test("shellQuote leaves a plain path and quotes the rest", () => {
  assertEquals(
    shellQuote("/tmp/a-b_c.d/kube:config"),
    "/tmp/a-b_c.d/kube:config",
  );
  assertEquals(shellQuote("my dir/kc"), "'my dir/kc'");
  assertEquals(shellQuote("a'b"), "'a'\\''b'");
  assertEquals(shellQuote("$(id)"), "'$(id)'");
  assertEquals(shellQuote("a;b"), "'a;b'");
});

// ───── the methods, through createModelTestContext with a stub spawn ─────

const M = model.methods;
const DIR = Deno.makeTempDirSync({ prefix: "kind-unit-" });
const KC = `${DIR}/kubeconfig`;
globalThis.addEventListener("unload", () => {
  Deno.removeSync(DIR, { recursive: true });
});
const G = {
  clusterName: "t",
  configPath: "kind.yaml",
  manifests: ["a.yaml"],
  waitTimeout: "120s",
  kubeconfig: KC,
  kindBinary: "kind",
  kubectlBinary: "kubectl",
};
const SERVER = "https://127.0.0.1:40000";
const LIST = "kind get clusters";
const READY = "kubectl get --raw /readyz";
const VIEW =
  "kubectl config view --minify -o jsonpath={.clusters[0].cluster.server}";
const CREATE =
  `kind create cluster --name t --config kind.yaml --wait 120s --kubeconfig ${KC}`;
const DELETE = `kind delete cluster --name t --kubeconfig ${KC}`;

Deno.test("ensure creates a missing cluster, applies the manifests and records the context and address", async () => {
  using h = harness({
    [LIST]: { stdout: "other\n" },
    [CREATE]: { stdout: "" },
    [READY]: { stdout: "ok" },
    ["kubectl apply -f a.yaml"]: { stdout: "namespace/a created\n" },
    [VIEW]: { stdout: SERVER },
  }, { globalArgs: G });
  await M.ensure.execute({}, h.context);
  const w = h.written();
  assertEquals(w.length, 1);
  assertEquals([w[0].spec, w[0].name], ["cluster", "cluster"]);
  const d = w[0].data;
  assertEquals(
    [d.exists, d.created, d.context, d.apiServer, d.manifestsApplied],
    [true, true, "kind-t", SERVER, ["a.yaml"]],
  );
  assertEquals(d.kubeconfig, KC);
  assertEquals("manifestFailed" in d, false);
  assertEquals(
    h.logs().at(-1),
    "kind cluster t is up (created), 1 manifest(s) applied",
  );
});

Deno.test("ensure records the manifest whose apply failed, then fails", async () => {
  using h = harness({
    [LIST]: { stdout: "t\n" },
    [READY]: { stdout: "ok" },
    ["kubectl apply -f a.yaml"]: {
      code: 1,
      stderr:
        'Error from server (Forbidden): namespaces is forbidden: User "u" cannot create resource "namespaces"',
    },
    [VIEW]: { stdout: SERVER },
  }, { globalArgs: G });
  await assertRejects(
    () => M.ensure.execute({}, h.context),
    Error,
    "forbidden",
  );
  assertEquals(h.calls.some((c) => c.key.startsWith("kind create")), false);
  const d = h.written()[0].data;
  assertEquals(
    [d.exists, d.created, d.manifestsApplied, d.manifestFailed],
    [true, false, [], "a.yaml"],
  );
  assertStringIncludes(String(d.error), "forbidden");
});

Deno.test("ensure refuses a kubeconfig whose directory is missing before kind creates anything", async () => {
  using h = harness({ [LIST]: { stdout: "" } }, {
    globalArgs: { ...G, kubeconfig: `${DIR}/absent/kubeconfig` },
  });
  await assertRejects(
    () => M.ensure.execute({}, h.context),
    Error,
    "does not exist; create it first",
  );
  assertEquals(h.calls.map((c) => c.key), [LIST]);
  assertEquals(h.written(), []);
});

Deno.test("get records an existing cluster with its API server address", async () => {
  using h = harness({
    [LIST]: { stdout: "t\nother\n" },
    [VIEW]: { stdout: `${SERVER}\n` },
  }, { globalArgs: G });
  await M.get.execute({}, h.context);
  const d = h.written()[0].data;
  assertEquals([d.exists, d.created, d.apiServer], [true, false, SERVER]);
  assertEquals("error" in d, false);
  assertEquals(h.logs().at(-1), "kind cluster t: exists");
});

Deno.test("get records a cluster that is not there without reading kubectl", async () => {
  using h = harness({ [LIST]: { stdout: "other\n" } }, { globalArgs: G });
  await M.get.execute({}, h.context);
  const d = h.written()[0].data;
  assertEquals([d.exists, d.apiServer], [false, ""]);
  assertEquals(h.calls.map((c) => c.key), [LIST]);
});

Deno.test("get records why the address of an existing cluster could not be read", async () => {
  using h = harness({
    [LIST]: { stdout: "t\n" },
    [VIEW]: { code: 1, stderr: 'error: context "kind-t" does not exist' },
  }, { globalArgs: G });
  await M.get.execute({}, h.context);
  const d = h.written()[0].data;
  assertEquals([d.exists, d.apiServer], [true, ""]);
  assertStringIncludes(String(d.error), "kind export kubeconfig --name t");
});

Deno.test("get fails and records nothing when kind cannot list clusters", async () => {
  using h = harness({
    [LIST]: { code: 1, stderr: "ERROR: failed to list clusters" },
  }, { globalArgs: G });
  await assertRejects(
    () => M.get.execute({}, h.context),
    Error,
    "failed to list clusters",
  );
  assertEquals(h.written(), []);
});

Deno.test("delete deletes an existing cluster and records it gone", async () => {
  using h = harness({
    [LIST]: { stdout: "t\n" },
    [DELETE]: { stdout: "" },
  }, { globalArgs: G });
  await M.delete.execute({}, h.context);
  assertEquals(h.calls.map((c) => c.key), [LIST, DELETE]);
  const d = h.written()[0].data;
  assertEquals([d.exists, d.created, d.apiServer], [false, false, ""]);
  assertEquals(h.logs().at(-1), "kind cluster t is gone");
});

Deno.test("delete without a kubeconfig argument does not run kind for a cluster that is gone", async () => {
  const { kubeconfig: _, ...noKc } = G;
  using h = harness({ [LIST]: { stdout: "other\n" } }, { globalArgs: noKc });
  await M.delete.execute({}, h.context);
  assertEquals(h.calls.map((c) => c.key), [LIST]);
  assertEquals(h.written()[0].data.exists, false);
});

Deno.test("delete fails and records nothing when kind cannot delete the cluster", async () => {
  using h = harness({
    [LIST]: { stdout: "t\n" },
    [DELETE]: { code: 1, stderr: "ERROR: failed to delete cluster" },
  }, { globalArgs: G });
  await assertRejects(
    () => M.delete.execute({}, h.context),
    Error,
    "failed to delete cluster",
  );
  assertEquals(h.written(), []);
});

Deno.test("delete refuses a kubeconfig whose directory is missing before kind runs", async () => {
  using h = harness({}, {
    globalArgs: { ...G, kubeconfig: `${DIR}/absent/kubeconfig` },
  });
  await assertRejects(
    () => M.delete.execute({}, h.context),
    Error,
    "does not exist; create it first",
  );
  assertEquals([h.calls, h.written()], [[], []]);
});
