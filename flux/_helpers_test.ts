import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import { MAX_TIMEOUT_MS } from "../lib/cli.ts";
import { dataName } from "../lib/kubectl.ts";
import {
  ConditionSchema,
  extractReadyCondition,
  FLUX_TIMEOUTS,
  FluxGlobalArgsSchema,
  listedNames,
  narrowConditions,
  reconcileTimeout,
  storedUrl,
} from "./_helpers.ts";
import { model as helmrelease } from "./helmrelease.ts";
import { model as kustomization } from "./kustomization.ts";
import { model as source } from "./source.ts";
import { extension as reset } from "./reset.ts";

const FORK = "2026.10.05.1";

const VERSION = "2026.11.12.1";

Deno.test("the three types carry the fork's name, a version and an upgrade chain ending at it", () => {
  assertEquals(helmrelease.type, "@dataverket/flux/helmrelease");
  assertEquals(kustomization.type, "@dataverket/flux/kustomization");
  assertEquals(source.type, "@dataverket/flux/source");
  assertEquals(
    [helmrelease.version, kustomization.version, source.version],
    [VERSION, VERSION, VERSION],
  );
  for (const m of [helmrelease, kustomization, source]) {
    assertEquals(m.upgrades[0].toVersion, FORK);
    assertEquals(m.upgrades.at(-1)!.toVersion, m.version);
    for (const u of m.upgrades) {
      assertEquals(u.upgradeAttributes({ namespace: "x" }), { namespace: "x" });
    }
  }
  assertEquals(reset.type, helmrelease.type);
});

Deno.test("the method names are upstream's", () => {
  assertEquals(Object.keys(helmrelease.methods).sort(), [
    "list",
    "reconcile",
    "resume",
    "suspend",
  ]);
  assertEquals(Object.keys(kustomization.methods).sort(), [
    "list",
    "reconcile",
    "resume",
    "suspend",
  ]);
  assertEquals(Object.keys(source.methods), ["list"]);
  assertEquals(Object.keys(reset.methods[0]), ["reset"]);
});

Deno.test("the global arguments are the three that were published, with the same defaults", () => {
  for (const m of [helmrelease, kustomization, source]) {
    assertEquals(m.globalArguments, FluxGlobalArgsSchema);
  }
  assertEquals(Object.keys(FluxGlobalArgsSchema.shape).sort(), [
    "context",
    "kubeconfig",
    "namespace",
  ]);
  assertEquals(FluxGlobalArgsSchema.parse({}), { namespace: "" });
  assertEquals(
    FluxGlobalArgsSchema.parse({
      namespace: "apps",
      kubeconfig: "/k",
      context: "c",
    }),
    { namespace: "apps", kubeconfig: "/k", context: "c" },
  );
  // Plain strings, as published: a definition that validated before still
  // does, whatever the value; it is checked when a method uses it.
  assertEquals(
    FluxGlobalArgsSchema.safeParse({ namespace: "-A" }).success,
    true,
  );
  assertEquals(FluxGlobalArgsSchema.safeParse({ namespace: 1 }).success, false);
});

Deno.test("the stored condition keeps its published shape: a field the controller left out is left out", () => {
  assertEquals(Object.keys(ConditionSchema.shape), [
    "type",
    "status",
    "reason",
    "message",
    "lastTransitionTime",
    "observedGeneration",
  ]);
  assertEquals(ConditionSchema.parse({ type: "Ready", status: "True" }), {
    type: "Ready",
    status: "True",
  });
  // Null is the shared layer's way to say "not written"; it is not this one's.
  assertEquals(
    ConditionSchema.safeParse({ type: "Ready", status: "True", reason: null })
      .success,
    false,
  );
});

Deno.test("the data names are the published ones for every Kubernetes name", () => {
  for (
    const [ns, name] of [
      ["monitoring", "kube-prometheus-stack"],
      ["a", "b.c-d"],
      ["flux-system", "flux-system"],
      ["a--b", "c"],
    ]
  ) {
    assertEquals(dataName(ns, name), `${ns}--${name}`);
  }
});

Deno.test("extractReadyCondition reads Ready and nothing else", () => {
  assertEquals(
    extractReadyCondition([
      { type: "Healthy", status: "True" },
      { type: "Ready", status: "True", reason: "R", message: "m" },
    ]),
    { ready: true, reason: "R", message: "m" },
  );
  assertEquals(extractReadyCondition([{ type: "Ready", status: "False" }]), {
    ready: false,
    reason: "Unknown",
    message: "",
  });
  assertEquals(extractReadyCondition([]), {
    ready: false,
    reason: "Unknown",
    message: "",
  });
});

Deno.test("NEG a condition message that quotes a credential is stored without it; everything else is stored as it was", () => {
  const leaky = {
    type: "Ready",
    status: "False",
    reason: "GitOperationFailed",
    message:
      "failed to clone https://bot:hunter2@git.example.org/team/repo: Authorization: Bearer abc.def.ghi, token=hunter2",
    lastTransitionTime: "2026-11-10T10:00:00Z",
    observedGeneration: 3,
  };
  const [stored] = narrowConditions([leaky]);
  assertEquals(stored.message!.includes("hunter2"), false);
  assertEquals(stored.message!.includes("abc.def.ghi"), false);
  assert(stored.message!.includes("https://git.example.org/team/repo"));
  assertEquals({ ...stored, message: "" }, { ...leaky, message: "" });
  const ready = extractReadyCondition([leaky]);
  assertEquals(ready.message, stored.message);
  // An ordinary message is not touched, and a missing one stays missing.
  const plain =
    "Helm upgrade succeeded for release apps/podinfo.v2 with chart podinfo@6.9.2+971fef0d04d5";
  assertEquals(
    narrowConditions([{ type: "Ready", status: "True", message: plain }])[0]
      .message,
    plain,
  );
  assertEquals(
    narrowConditions([{ type: "Ready", status: "True" }])[0].message,
    undefined,
  );
  assertEquals(
    storedUrl("https://ghp_s3cret@github.com/org/repo"),
    "https://github.com/org/repo",
  );
  assertEquals(
    storedUrl("oci://ghcr.io/org/charts/app"),
    "oci://ghcr.io/org/charts/app",
  );
  assertEquals(
    storedUrl("git@github.com:org/repo.git"),
    "git@github.com:org/repo.git",
  );
});

Deno.test("listedNames reads namespace and name, and refuses an item that has neither", () => {
  assertEquals(
    listedNames([{ metadata: { name: "a", namespace: "b" } }], "HelmRelease"),
    [{ namespace: "b", name: "a" }],
  );
  for (const item of [{}, { metadata: { name: "a" } }, { metadata: 7 }]) {
    assertThrows(
      () => listedNames([item], "HelmRelease"),
      Error,
      "a HelmRelease without a name or namespace",
    );
  }
});

Deno.test("the flux time limits are the documented ones", () => {
  assertEquals(FLUX_TIMEOUTS, {
    suspend: 60_000,
    resume: 330_000,
    reconcile: 330_000,
    reconcileWithSource: 630_000,
    reconcileHelmReleaseWithSource: 930_000,
    push: 330_000,
  });
  for (const kind of ["helmrelease", "kustomization"] as const) {
    assertEquals(reconcileTimeout(kind, undefined), 330_000);
    assertEquals(reconcileTimeout(kind, false), 330_000);
  }
  // flux waits for the source and the object; for a HelmRelease also for
  // the HelmChart between them.
  assertEquals(reconcileTimeout("kustomization", true), 630_000);
  assertEquals(reconcileTimeout("helmrelease", true), 930_000);
  for (const ms of Object.values(FLUX_TIMEOUTS)) assert(ms <= MAX_TIMEOUT_MS);
});

Deno.test("kustomization and source carry the CLI checks; helmrelease gets them from reset", () => {
  assertEquals(Object.keys(kustomization.checks), [
    "flux-cli-available",
    "kubectl-cli-available",
  ]);
  assertEquals(Object.keys(source.checks), ["kubectl-cli-available"]);
  assertEquals(source.checks["kubectl-cli-available"].appliesTo, ["list"]);
  assertEquals(Object.keys(reset.checks[0]), [
    "flux-cli-available",
    "kubectl-cli-available",
  ]);
  for (
    const check of [
      ...Object.values(kustomization.checks),
      ...Object.values(reset.checks[0]),
    ]
  ) {
    assertEquals(check.labels, ["live"]);
  }
});
