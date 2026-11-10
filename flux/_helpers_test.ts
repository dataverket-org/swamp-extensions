import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { CHECK_TIMEOUT_MS, isCliError, MAX_TIMEOUT_MS } from "../lib/cli.ts";
import { withCli } from "../lib/cli_fake.ts";
import { dataName, kubectlCliCheck } from "../lib/kubectl.ts";
import {
  ConditionSchema,
  extractReadyCondition,
  FLUX_TIMEOUTS,
  fluxCliCheck,
  FluxGlobalArgsSchema,
  isFluxProgressLine,
  listedNames,
  narrowConditions,
  reconcileTimeout,
  runFlux,
  storedUrl,
} from "./_helpers.ts";
import { model as helmrelease } from "./helmrelease.ts";
import { model as kustomization } from "./kustomization.ts";
import { model as source } from "./source.ts";
import { extension as reset } from "./reset.ts";

const FORK = "2026.10.05.1";
const VERSION = "2026.11.10.1";

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

Deno.test("runFlux puts the cluster flags first, passes its time limit and returns stdout", async () => {
  await withCli({
    calls: [
      {
        bin: "flux",
        args: ["reconcile", "x"],
        out: "ok\n",
        timeoutMs: 330_000,
      },
      {
        bin: "flux",
        args: ["--kubeconfig", "/k", "--context", "c", "suspend", "x"],
        timeoutMs: 60_000,
      },
    ],
  }, async (k) => {
    assertEquals(await runFlux(["reconcile", "x"], undefined, 330_000), "ok\n");
    assertEquals(
      await runFlux(["suspend", "x"], {
        kubeconfig: "/k",
        context: "c",
      }, 60_000),
      "",
    );
    // Nothing of its own in the environment, no input.
    assertEquals(k.calls.map((c) => [c.env, c.stdin]), [
      [undefined, undefined],
      [undefined, undefined],
    ]);
  });
});

Deno.test("NEG runFlux needs a time limit above zero", async () => {
  await withCli({}, async () => {
    for (const bad of [0, -1, NaN, Infinity, MAX_TIMEOUT_MS + 1]) {
      await assertRejects(
        () => runFlux(["reconcile", "x"], undefined, bad),
        Error,
        "time limit",
      );
    }
  });
});

Deno.test("NEG a failing flux says what flux said: the failure line, not the progress lines", async () => {
  const stderr = "► annotating HelmRelease x in apps namespace\n" +
    "✔ HelmRelease annotated\n" +
    "◎ waiting for HelmRelease reconciliation\n" +
    "✗ helmrelease reconciliation failed: upgrade retries exhausted\n";
  await withCli({
    calls: [
      { bin: "flux", args: ["suspend", "x"], fail: "not found" },
      { bin: "flux", args: ["reconcile", "x"], fail: stderr },
      // Nothing on standard error: what flux printed is the next best thing.
      { bin: "flux", args: ["push", "x"], code: 1, stdout: "bad target\n" },
      { bin: "flux", args: ["resume", "x"], code: 2 },
      { bin: "flux", args: ["resume", "x"], fail: "x".repeat(5000) },
    ],
  }, async () => {
    const run = (sub: string) =>
      assertRejects(() => runFlux([sub, "x"], undefined, 1000), Error);
    const first = await run("suspend");
    assertEquals(first.message, "flux suspend failed: not found");
    assert(isCliError(first, "failed"));
    assertEquals([first.code, first.bin], [1, "flux"]);
    assertEquals(
      (await run("reconcile")).message,
      "flux reconcile failed: ✗ helmrelease reconciliation failed: upgrade retries exhausted",
    );
    assertEquals((await run("push")).message, "flux push failed: bad target");
    assertEquals(
      (await run("resume")).message,
      "flux resume failed: (no error output)",
    );
    const long = (await run("resume")).message;
    assert(long.length < 450, "a long message is bounded");
  });
  for (const line of ["► a", "✔ b", "◎ c", "  ► d"]) {
    assertEquals(isFluxProgressLine(line), true, line);
  }
  for (const line of ["✗ failed", "Error: x", "", "a ► b"]) {
    assertEquals(isFluxProgressLine(line), false, line);
  }
});

Deno.test("NEG a flux that does not answer is stopped at its limit, and the error says so", async () => {
  await withCli({
    calls: [{ bin: "flux", args: ["reconcile", "x"], hang: true }],
  }, async () => {
    const e = await assertRejects(
      () => runFlux(["reconcile", "x"], undefined, FLUX_TIMEOUTS.reconcile),
      Error,
    );
    assertEquals(
      e.message,
      "flux reconcile failed: no answer within 330 seconds; the process was stopped",
    );
    assert(isCliError(e, "timeout"));
  });
});

Deno.test("NEG a cancelled run stops flux, and is named as cancelled", async () => {
  const controller = new AbortController();
  await withCli({
    calls: [{ bin: "flux", args: ["resume", "x"], hang: "until-cancelled" }],
  }, async () => {
    const pending = assertRejects(
      () =>
        runFlux(
          ["resume", "x"],
          { signal: controller.signal },
          FLUX_TIMEOUTS.resume,
        ),
      Error,
    );
    controller.abort();
    const e = await pending;
    assertEquals(e.message, "flux resume was cancelled");
    assert(isCliError(e, "cancelled"));
  });
});

Deno.test("NEG nothing shaped like a credential reaches a flux error", async () => {
  const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
  await withCli({
    calls: [{
      bin: "flux",
      args: ["push", "x"],
      fail:
        `✗ pushing failed: GET https://user:hunter2@registry.example.org/v2/: Authorization: Bearer ${TOKEN} password=hunter2`,
    }],
  }, async () => {
    const e = await assertRejects(
      () => runFlux(["push", "x"], undefined, FLUX_TIMEOUTS.push),
      Error,
    );
    assert(!e.message.includes(TOKEN));
    assert(!e.message.includes("hunter2"));
    assert(isCliError(e) && !e.stderr.includes(TOKEN));
    assertStringIncludes(e.message, "flux push failed: ✗ pushing failed");
  });
});

Deno.test("the CLI checks name a missing binary and surface a failing one", async () => {
  await withCli({
    calls: [
      { bin: "flux", args: ["--version"], notInstalled: true },
      {
        bin: "flux",
        args: ["--version"],
        out: "flux version 2.10.0",
        timeoutMs: CHECK_TIMEOUT_MS,
      },
      { bin: "kubectl", args: ["version", "--client"], fail: "boom" },
      {
        bin: "kubectl",
        args: ["version", "--client"],
        out: "v1.37",
        timeoutMs: CHECK_TIMEOUT_MS,
      },
    ],
  }, async () => {
    const missing = await fluxCliCheck.execute();
    assertEquals(missing.pass, false);
    assertEquals(
      missing.errors![0],
      "flux is not on PATH; install it or put it on the PATH this repository runs with",
    );
    assertEquals(await fluxCliCheck.execute({}), { pass: true });
    const failing = await kubectlCliCheck.execute();
    assertEquals(failing.pass, false);
    assertEquals(
      failing.errors![0],
      "kubectl version --client failed (exit 1): boom",
    );
    assertEquals(await kubectlCliCheck.execute(), { pass: true });
  });
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
