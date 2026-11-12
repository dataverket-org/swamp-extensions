import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { extension, resetArgs, summarize } from "./reset.ts";
import { harness } from "./stub_test.ts";
import { HR, hrItem } from "./test_support.ts";

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

// ───── the method, through createModelTestContext with a stub spawn ─────

const reset = extension.methods[0].reset;
const G = { namespace: "monitoring" };
const GET = `kubectl get ${HR} kps -n monitoring`;
const FLUX = "flux reconcile helmrelease kps -n monitoring --reset";

/** The release before the reset, then as helm-controller left it. */
function readTwice(after: Record<string, unknown>) {
  let n = 0;
  return () => ({ stdout: n++ === 0 ? hrItem : after });
}

Deno.test("reset runs flux reconcile --reset and records the release as it is afterwards", async () => {
  using h = harness({
    [GET]: readTwice({
      ...hrItem,
      status: { ...hrItem.status, lastHandledResetAt: "2026-11-12T10:00:00Z" },
    }),
    [FLUX]: { stdout: "" },
  }, { globalArgs: G });
  await reset.execute({ name: "kps" }, h.context);
  assertEquals(h.calls.map((c) => c.key), [GET, FLUX, GET]);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [[
    "resetResult",
    "reset.monitoring--kps",
  ]]);
  assertEquals(w[0].data.ready, true);
  assertEquals(w[0].data.installFailures, 0);
  assertEquals(
    h.logs().includes("HelmRelease {name}: ready={ready} {reason}"),
    true,
  );
});

Deno.test("reset throws flux's failure and records nothing when helm-controller did not handle the reset", async () => {
  using h = harness({
    [GET]: { stdout: hrItem },
    [FLUX]: {
      code: 1,
      stderr: '✗ helmreleases "kps" is forbidden: cannot patch',
    },
  }, { globalArgs: G });
  await assertRejects(
    () => reset.execute({ name: "kps" }, h.context),
    Error,
    "the reset was not handled (status.lastHandledResetAt did not change), so nothing was recorded",
  );
  assertEquals(h.written(), []);
});
