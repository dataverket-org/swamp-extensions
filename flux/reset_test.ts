import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { CHECK_TIMEOUT_MS } from "../lib/cli.ts";
import { SAID, withKubectl } from "../lib/kubectl_fake.ts";
import { extension, resetArgs, resetName, summarize } from "./reset.ts";
import { HR } from "./test_support.ts";

const reset = extension.methods[0].reset;

function ctx(
  globalArgs: { namespace?: string; context?: string },
  signal = new AbortController().signal,
) {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];
  return {
    written,
    logs,
    context: {
      globalArgs,
      signal,
      logger: {
        info: (m: string, props?: Record<string, unknown>) => {
          logs.push(`${m} ${JSON.stringify(props ?? {})}`);
        },
      },
      writeResource: (spec: string, name: string, data: unknown) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

const object = (ready: boolean, handledResetAt?: string) => ({
  kind: "HelmRelease",
  metadata: { name: "cm", namespace: "apps" },
  status: {
    installFailures: ready ? 0 : 1,
    history: [{ status: ready ? "deployed" : "failed" }],
    lastHandledResetAt: handledResetAt,
    conditions: [{
      type: "Ready",
      status: ready ? "True" : "False",
      reason: ready ? "InstallSucceeded" : "InstallFailed",
      message: "m",
    }],
  },
});
const FLUX = ["reconcile", "helmrelease", "cm", "-n", "apps", "--reset"];
const READ = ["get", HR, "cm", "-n", "apps"];
const T1 = "2026-11-10T10:00:00.000000001Z";
const T2 = "2026-11-10T11:00:00.000000002Z";

Deno.test("resetArgs pins the flux invocation", () => {
  assertEquals(resetArgs({ name: "cert-manager", namespace: "cert-manager" }), [
    "reconcile",
    "helmrelease",
    "cert-manager",
    "-n",
    "cert-manager",
    "--reset",
  ]);
  assertEquals(
    resetArgs({ name: "a", namespace: "b", withSource: true }).at(-1),
    "--with-source",
  );
});

Deno.test("summarize reads readiness, history and counters", () => {
  const r = summarize(
    {
      status: {
        installFailures: 1,
        history: [{ status: "failed" }],
        conditions: [{
          type: "Ready",
          status: "False",
          reason: "InstallFailed",
          message: "timeout",
        }],
      },
    },
    "cert-manager",
    "cert-manager",
  );
  assertEquals(r.ready, false);
  assertEquals(r.readyReason, "InstallFailed");
  assertEquals(r.deployStatus, "failed");
  assertEquals(r.installFailures, 1);
  assertEquals(r.upgradeFailures, 0);
});

Deno.test("reset reads the object, runs flux with --reset under the reconcile time limit, reads it back and records the outcome under reset.<namespace>--<name>", async () => {
  const c = ctx({ namespace: "apps", context: "c" });
  await withKubectl({
    context: "c",
    calls: [
      { args: READ, out: object(false) },
      { bin: "flux", args: ["--context", "c", ...FLUX], timeoutMs: 330_000 },
      { args: READ, out: object(true, T1) },
      { args: READ, out: object(false, T1) },
      {
        bin: "flux",
        args: ["--context", "c", ...FLUX, "--with-source"],
        timeoutMs: 930_000,
      },
      { args: READ, out: object(true, T2) },
    ],
  }, async () => {
    const r = await reset.execute({ name: "cm" }, c.context);
    assertEquals(r.dataHandles.length, 1);
    await reset.execute({ name: "cm", withSource: true }, c.context);
  });
  assertEquals(c.written.map((w) => [w.spec, w.name]), [
    ["resetResult", "reset.apps--cm"],
    ["resetResult", "reset.apps--cm"],
  ]);
  assertEquals(resetName("apps", "cm"), "reset.apps--cm");
  const data = c.written[0].data as Record<string, unknown>;
  assertEquals(Object.keys(data).sort(), [
    "deployStatus",
    "installFailures",
    "name",
    "namespace",
    "ready",
    "readyMessage",
    "readyReason",
    "timestamp",
    "upgradeFailures",
  ]);
  assertEquals([data.ready, data.deployStatus, data.installFailures], [
    true,
    "deployed",
    0,
  ]);
});

Deno.test("NEG a flux that fails without the reset being handled is flux's error, whatever the object says: nothing is written", async () => {
  // A refused patch, an expired login, a flux that hung before it patched:
  // status.lastHandledResetAt is what it was, so nothing was reset. The
  // object reads Ready=True, which must not turn that into a success.
  for (
    const [before, after, answer, phrase] of [
      [
        object(true, T1),
        object(true, T1),
        { fail: '✗ helmreleases.helm.toolkit.fluxcd.io "cm" is forbidden' },
        "flux reconcile failed: ✗ helmreleases.helm.toolkit.fluxcd.io",
      ],
      [
        object(true),
        object(true),
        { fail: "✗ You must be logged in to the server (Unauthorized)" },
        "flux reconcile failed: ✗ You must be logged in",
      ],
    ] as const
  ) {
    const c = ctx({ namespace: "apps" });
    await withKubectl({
      calls: [
        { args: READ, out: before },
        { bin: "flux", args: FLUX, ...answer },
        { args: READ, out: after },
      ],
    }, async (k) => {
      const e = await assertRejects(
        () => reset.execute({ name: "cm" }, c.context),
        Error,
        phrase,
      );
      assert(e.message.includes("the reset was not handled ("));
      // A refusal is final: the method does not wait to see what happens.
      assertEquals(k.slept, []);
    });
    assertEquals(c.written, [], phrase);
  }
});

Deno.test("NEG a flux that ran out of time, or was stopped at its limit, may have left helm-controller working: the field is polled for 30 seconds before the method decides", async () => {
  // Handled on the second poll: recorded, and thrown because not ready.
  for (
    const answer of [
      { hang: true },
      { fail: "✗ context deadline exceeded" },
      { fail: "✗ timed out waiting for the condition" },
    ]
  ) {
    const c = ctx({ namespace: "apps" });
    await withKubectl({
      calls: [
        { args: READ, out: object(false, T1) },
        { bin: "flux", args: FLUX, ...answer },
        { args: READ, out: object(false, T1) },
        { args: READ, out: object(false, T1) },
        { args: READ, out: object(false, T2) },
      ],
    }, async (k) => {
      await assertRejects(
        () => reset.execute({ name: "cm" }, c.context),
        Error,
        "flux reconcile failed",
      );
      assertEquals(k.slept, [5000, 5000]);
    });
    assertEquals(c.written.map((w) => w.name), ["reset.apps--cm"]);
  }
  // Never handled: six polls, then an error that claims no more than it knows.
  const c = ctx({ namespace: "apps" });
  await withKubectl({
    calls: [
      { args: READ, out: object(true, T1) },
      { bin: "flux", args: FLUX, hang: true },
      ...Array.from(
        { length: 7 },
        () => ({ args: READ, out: object(true, T1) }),
      ),
    ],
  }, async (k) => {
    const e = await assertRejects(
      () => reset.execute({ name: "cm" }, c.context),
      Error,
      "flux reconcile failed: no answer within 330 seconds",
    );
    assert(
      e.message.includes(
        "the reset was not handled within 30 more seconds: not yet, or not at all",
      ),
      e.message,
    );
    assertEquals(k.slept, [5000, 5000, 5000, 5000, 5000, 5000]);
  });
  assertEquals(c.written, []);
  // Slow reads count against the 30 seconds: the third read takes 26 of
  // them, so one wait is all there is.
  const slow = ctx({ namespace: "apps" });
  let reads = 0;
  let advance = (_ms: number) => {};
  await withKubectl({
    calls: [
      { args: READ, out: object(true, T1) },
      { bin: "flux", args: FLUX, hang: true },
    ],
    handler: (call) => {
      if (call.verb !== "get" || call.name !== "cm") return undefined;
      if (++reads === 2) advance(26_000);
      return { out: object(true, T1) };
    },
  }, async (k) => {
    advance = k.advance;
    await assertRejects(
      () => reset.execute({ name: "cm" }, slow.context),
      Error,
      "not yet, or not at all",
    );
    assertEquals([k.slept, reads], [[5000], 2]);
  });
  assertEquals(slow.written, []);
});

Deno.test("NEG a run cancelled while the field is polled ends the wait, and nothing is written", async () => {
  const controller = new AbortController();
  const c = ctx({ namespace: "apps" }, controller.signal);
  let reads = 0;
  await withKubectl({
    calls: [
      { args: READ, out: object(true, T1) },
      { bin: "flux", args: FLUX, fail: "✗ context deadline exceeded" },
    ],
    handler: (call) => {
      if (call.verb !== "get") return undefined;
      // Cancelled just after the read after flux was answered, so it is the
      // wait that meets the cancelled run, not kubectl.
      if (++reads === 1) queueMicrotask(() => controller.abort());
      return { out: object(true, T1) };
    },
  }, async (k) => {
    await assertRejects(
      () => reset.execute({ name: "cm" }, c.context),
      Error,
      "cancelled",
    );
    assertEquals([k.slept, reads], [[], 1]);
  });
  assertEquals(c.written, []);
});

Deno.test("NEG a flux that fails after the reset was handled: recorded, then thrown when the release is not ready; logged and not thrown when it is", async () => {
  const c = ctx({ namespace: "apps" });
  await withKubectl({
    calls: [
      { args: READ, out: object(false, T1) },
      { bin: "flux", args: FLUX, fail: "✗ install retries exhausted" },
      { args: READ, out: object(false, T2) },
      { args: READ, out: object(false) },
      { bin: "flux", args: FLUX, hang: true },
      { args: READ, out: object(false, T1) },
      { args: READ, out: object(false, T1) },
      { bin: "flux", args: FLUX, fail: "✗ context deadline exceeded" },
      { args: READ, out: object(true, T2) },
    ],
  }, async () => {
    await assertRejects(
      () => reset.execute({ name: "cm" }, c.context),
      Error,
      "flux reconcile failed: ✗ install retries exhausted",
    );
    await assertRejects(
      () => reset.execute({ name: "cm" }, c.context),
      Error,
      "flux reconcile failed: no answer within 330 seconds",
    );
    assertEquals(c.logs.filter((l) => l.includes("flux reported")), []);
    await reset.execute({ name: "cm" }, c.context);
  });
  assertEquals(
    c.written.map((w) => (w.data as { ready: boolean }).ready),
    [false, false, true],
  );
  // The failure that was not thrown is in the log, with what flux said.
  const dropped = c.logs.filter((l) => l.includes("flux reported"));
  assertEquals(dropped.length, 1);
  assert(dropped[0].includes("context deadline exceeded"));
});

Deno.test("NEG a release that is not there is refused by the first read: flux never runs and nothing is written", async () => {
  const c = ctx({ namespace: "apps" });
  await withKubectl({
    calls: [{ args: READ, fail: SAID.notFound(HR, "cm") }],
  }, async () => {
    await assertRejects(
      () => reset.execute({ name: "cm" }, c.context),
      Error,
      `kubectl get ${HR} cm -n apps failed`,
    );
  });
  assertEquals(c.written, []);
});

Deno.test("NEG a read that is not JSON is a named error, not a SyntaxError", async () => {
  const c = ctx({ namespace: "apps" });
  await withKubectl({
    calls: [
      { args: READ, out: object(false) },
      { bin: "flux", args: FLUX },
      { args: READ, out: "<html>" },
    ],
  }, async () => {
    const e = await assertRejects(
      () => reset.execute({ name: "cm" }, c.context),
      Error,
      "did not print JSON",
    );
    assertEquals(e instanceof SyntaxError, false);
  });
  assertEquals(c.written, []);
});

Deno.test("NEG a cancelled run and a missing flux are not attempts: the object is not read again and nothing is written", async () => {
  const controller = new AbortController();
  const c = ctx({ namespace: "apps" }, controller.signal);
  await withKubectl({
    calls: [
      { args: READ, out: object(false) },
      { bin: "flux", args: FLUX, hang: "until-cancelled" },
    ],
  }, async (k) => {
    const pending = assertRejects(
      () => reset.execute({ name: "cm" }, c.context),
      Error,
      "flux reconcile was cancelled",
    );
    while (k.calls.length < 2) await new Promise((r) => setTimeout(r, 1));
    controller.abort();
    await pending;
  });
  const d = ctx({ namespace: "apps" });
  await withKubectl({
    calls: [
      { args: READ, out: object(false) },
      { bin: "flux", args: FLUX, notInstalled: true },
    ],
  }, async () => {
    await assertRejects(
      () => reset.execute({ name: "cm" }, d.context),
      Error,
      "flux is not on PATH",
    );
  });
  assertEquals([c.written, d.written], [[], []]);
});

Deno.test("NEG reset without a namespace, or with one that is a flag, refuses before anything runs", async () => {
  await withKubectl({}, async () => {
    await assertRejects(
      () => reset.execute({ name: "cm" }, ctx({}).context),
      Error,
      "namespace is required for reset",
    );
    await assertRejects(
      () => reset.execute({ name: "cm", namespace: "-A" }, ctx({}).context),
      Error,
      "is not a Kubernetes namespace name",
    );
  });
});

Deno.test("NEG a Ready message that quotes a credential is stored without it", () => {
  const r = summarize(
    {
      status: {
        conditions: [{
          type: "Ready",
          status: "False",
          reason: "ArtifactFailed",
          message:
            "failed to fetch https://bot:hunter2@charts.example.org/index.yaml: password=hunter2",
        }],
      },
    },
    "a",
    "b",
  );
  assertEquals(r.readyMessage.includes("hunter2"), false);
  assert(r.readyMessage.includes("https://charts.example.org/index.yaml"));
});

Deno.test("the CLI checks reset carries run each binary's version command under the check's own limit", async () => {
  const checks = extension.checks[0];
  await withKubectl({
    calls: [
      {
        bin: "flux",
        args: ["--version"],
        out: "flux version 2.10.0",
        timeoutMs: CHECK_TIMEOUT_MS,
      },
      { bin: "flux", args: ["--version"], notInstalled: true },
      { args: ["version", "--client"], fail: "boom" },
    ],
  }, async () => {
    assertEquals(await checks["flux-cli-available"].execute({}), {
      pass: true,
    });
    const missing = await checks["flux-cli-available"].execute({});
    assert(missing.errors![0].startsWith("flux is not on PATH"));
    const failing = await checks["kubectl-cli-available"].execute({});
    assertEquals(failing.errors, [
      "kubectl version --client failed (exit 1): boom",
    ]);
    // Not scripted: the fake answers a version check that has the right limit.
    assertEquals(await checks["kubectl-cli-available"].execute({}), {
      pass: true,
    });
  });
});
