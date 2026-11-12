import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model as helmrelease, parseHelmRelease } from "./helmrelease.ts";
import {
  deriveLastAction,
  detailName,
  extension,
  getArgs,
  HelmReleaseDetailSchema,
  jobsArgs,
  parseHelmReleaseDetail,
  parseHistoryEntry,
  parseJob,
} from "./get.ts";
import { HR } from "./test_support.ts";
import { forbidden, harness, list, notFound } from "./stub_test.ts";

/** A real object, recorded from a kind cluster with Flux 2.10.0. */
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    Deno.readTextFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)),
  );
}

// The commands only: the shared layer adds the cluster flags, the request
// timeout and `-o json` to every call.
const hrCall = (name: string, ns: string) => ["get", HR, name, "-n", ns];

const jobsCall = (name: string, ns: string, releaseNs = ns) => [
  "get",
  "jobs.batch",
  "-n",
  releaseNs,
  "-l",
  `helm.toolkit.fluxcd.io/name=${name},helm.toolkit.fluxcd.io/namespace=${ns}`,
];

Deno.test("the detail record keeps every field of the list record, with the same values", () => {
  for (const name of ["hr-podinfo", "hr-hooked", "hr-noversion"]) {
    const item = fixture(name);
    const listed = parseHelmRelease(item);
    const d = parseHelmReleaseDetail(
      item,
      "x",
      "y",
      { jobsRead: true, jobs: [] },
      "2026-01-01T00:00:00.000Z",
    ) as Record<string, unknown>;
    for (const [k, v] of Object.entries(listed)) {
      assertEquals(d[k], v, `${name}: ${k}`);
    }
    HelmReleaseDetailSchema.parse(d);
  }
});

Deno.test("list still stores exactly the fields it stored before get existed", () => {
  assertEquals(Object.keys(parseHelmRelease(fixture("hr-podinfo"))).sort(), [
    "appVersion",
    "appliedVersion",
    "chartName",
    "conditions",
    "deployStatus",
    "lastAttemptedRevision",
    "lastHandledReconcileAt",
    "name",
    "namespace",
    "observedGeneration",
    "ready",
    "readyMessage",
    "readyReason",
    "requestedVersion",
    "sourceRef",
    "suspended",
  ]);
  assertEquals(
    Object.keys(helmrelease.resources.helmrelease.schema.shape).length,
    16,
  );
});

Deno.test("deriveLastAction reads the most direct statement first and never a message", () => {
  const h = (version: number, action?: string) =>
    parseHistoryEntry({ version, action, status: "deployed" });
  const lying = {
    type: "Ready",
    status: "True",
    reason: "Whatever",
    message: "Helm install succeeded",
  };
  assertEquals(
    deriveLastAction({ lastAttemptedReleaseAction: "upgrade" }, [
      h(1, "install"),
    ], []),
    { lastAction: "upgrade", lastActionSource: "lastAttemptedReleaseAction" },
  );
  assertEquals(deriveLastAction({}, [h(3, "upgrade"), h(2)], []), {
    lastAction: "upgrade",
    lastActionSource: "historyAction",
  });
  assertEquals(
    deriveLastAction({}, [h(2)], [{
      type: "Released",
      status: "False",
      reason: "InstallFailed",
    }]),
    { lastAction: "install", lastActionSource: "conditionReason" },
  );
  assertEquals(
    deriveLastAction({}, [], [
      { type: "Released", status: "True", reason: "Other" },
      { type: "Ready", status: "True", reason: "UpgradeSucceeded" },
    ]),
    { lastAction: "upgrade", lastActionSource: "conditionReason" },
  );
  assertEquals(deriveLastAction({}, [h(1)], [lying]), {
    lastAction: "install",
    lastActionSource: "historyVersion",
  });
  assertEquals(deriveLastAction({}, [h(4)], [lying]), {
    lastAction: "upgrade",
    lastActionSource: "historyVersion",
  });
  assertEquals(deriveLastAction({ upgradeFailures: 2 }, [], [lying]), {
    lastAction: "upgrade",
    lastActionSource: "failureCounters",
  });
  assertEquals(deriveLastAction({ installFailures: 1 }, [], []), {
    lastAction: "install",
    lastActionSource: "failureCounters",
  });
  // A message that names an action is not evidence, and an action that is
  // neither install nor upgrade is not passed on as one.
  assertEquals(
    deriveLastAction({ lastAttemptedReleaseAction: "rollback" }, [], [lying]),
    { lastAction: "unknown", lastActionSource: "none" },
  );
});

Deno.test("parseJob reads hooks, delete policies and the state from the Job's conditions", () => {
  const j = parseJob({
    metadata: {
      name: "j",
      namespace: "n",
      annotations: {
        "helm.sh/hook": "post-install, post-upgrade",
        "helm.sh/hook-delete-policy": "before-hook-creation,hook-succeeded",
      },
    },
    status: { active: 1, startTime: "2026-01-01T00:00:00Z" },
  });
  assertEquals(j.hooks, ["post-install", "post-upgrade"]);
  assertEquals(j.hookDeletePolicies, [
    "before-hook-creation",
    "hook-succeeded",
  ]);
  assertEquals([j.state, j.active, j.succeeded, j.failed], [
    "running",
    1,
    0,
    0,
  ]);
  const plain = parseJob({ metadata: { name: "p", namespace: "n" } });
  assertEquals([plain.hooks, plain.state], [[], "pending"]);
  // A condition that is present but not True decides nothing.
  assertEquals(
    parseJob({
      metadata: { name: "p" },
      status: { conditions: [{ type: "Failed", status: "False" }] },
    }).state,
    "pending",
  );
});

Deno.test("the argument lists and the data name are pinned", () => {
  assertEquals(getArgs("a", "b"), hrCall("a", "b"));
  assertEquals(jobsArgs("a", "b", "c"), jobsCall("a", "b", "c"));
  assertEquals(detailName("apps", "podinfo"), "detail.apps--podinfo");
  // No list record, named <namespace>--<name>, can be the same name: a
  // namespace holds no dot.
  assert(!/^[a-z0-9-]+--/.test(detailName("a", "b")));
});

Deno.test("NEG a malformed or partial status is recorded as what is there, and fits the schema", () => {
  const jobs = { jobsRead: true, jobs: [] };
  const at = "2026-01-01T00:00:00.000Z";
  const statuses: unknown[] = [
    undefined,
    null,
    "broken",
    [],
    { history: "not a list", conditions: "nor this" },
    { history: [null, 7, "x", []], conditions: [null, 7, {}] },
    {
      history: [{ version: "2", status: 5, testHooks: [], chartVersion: 1 }],
      conditions: [{ type: "Ready" }, { status: "True" }, {
        type: "Ready",
        status: "True",
        reason: 9,
        message: {},
        observedGeneration: "1",
      }],
      failures: "3",
      installFailures: null,
      upgradeFailures: NaN,
      lastAttemptedRevision: 12,
      lastAttemptedReleaseAction: {},
      observedGeneration: "x",
      storageNamespace: [],
    },
    {
      history: [{
        version: 1,
        testHooks: { b: null, a: { phase: "Failed" }, c: "x" },
      }],
    },
  ];
  for (const status of statuses) {
    const d = HelmReleaseDetailSchema.parse(
      parseHelmReleaseDetail(
        { kind: "HelmRelease", status },
        "rel",
        "ns",
        jobs,
        at,
      ),
    );
    assertEquals([d.name, d.namespace], ["rel", "ns"]);
    assertEquals([d.releaseName, d.releaseNamespace], ["rel", "ns"]);
    assertEquals([d.failures, d.installFailures, d.upgradeFailures], [0, 0, 0]);
  }
  const partial = parseHelmReleaseDetail(
    { status: statuses[6] },
    "rel",
    "ns",
    jobs,
    at,
  );
  // A revision number that is a string is not a number; nothing is guessed.
  assertEquals(partial.history[0].version, 0);
  assertEquals(partial.history[0].status, "unknown");
  assertEquals(partial.history[0].tested, false);
  assertEquals(partial.conditions.length, 1);
  assertEquals(partial.ready, true);
  assertEquals(partial.readyReason, "Unknown");
  assertEquals(partial.lastAction, "unknown");
  assertEquals(partial.lastAttemptedRevision, undefined);
  const hooks = parseHelmReleaseDetail(
    { status: statuses[7] },
    "rel",
    "ns",
    jobs,
    at,
  ).history[0];
  assertEquals(hooks.tested, true);
  assertEquals(hooks.testHooks.map((t) => [t.name, t.phase]), [
    ["a", "Failed"],
    ["b", undefined],
    ["c", undefined],
  ]);
  // Wrong types in spec and metadata do not reach the record either.
  const odd = HelmReleaseDetailSchema.parse(
    parseHelmReleaseDetail(
      {
        metadata: { name: 5, namespace: {} },
        spec: {
          suspend: "yes",
          chart: { spec: { chart: 1, version: 2, sourceRef: "x" } },
          chartRef: { kind: 3 },
          releaseName: 4,
          targetNamespace: [],
          kubeConfig: "x",
        },
      },
      "rel",
      "ns",
      jobs,
      at,
    ),
  );
  assertEquals(odd.suspended, false);
  assertEquals(odd.chartName, "");
  assertEquals(odd.sourceRef, { kind: "", name: "", namespace: undefined });
});

Deno.test("get is added to the helmrelease type, with its own record", () => {
  assertEquals(extension.type, helmrelease.type);
  assertEquals(Object.keys(extension.methods[0]), ["get"]);
  assertEquals(Object.keys(extension.resources), ["detail"]);
  assertEquals(helmrelease.version, "2026.11.12.1");
  assertEquals(helmrelease.upgrades.at(-1)!.toVersion, helmrelease.version);
});

// ───── the method, through createModelTestContext with a stub spawn ─────

const get = extension.methods[0].get;
const GET = `kubectl get ${HR} podinfo -n apps`;
const JOBS = "kubectl get jobs.batch -n apps -l " +
  "helm.toolkit.fluxcd.io/name=podinfo,helm.toolkit.fluxcd.io/namespace=apps";
const job = {
  apiVersion: "batch/v1",
  kind: "Job",
  metadata: {
    name: "podinfo-test",
    namespace: "apps",
    annotations: { "helm.sh/hook": "test" },
  },
  status: {
    succeeded: 1,
    conditions: [{ type: "Complete", status: "True" }],
  },
};

Deno.test("get records the release in full under detail.<namespace>--<name>, with its Jobs, and logs the outcome", async () => {
  using h = harness({
    [GET]: { stdout: fixture("hr-podinfo") },
    [JOBS]: { stdout: list([job]) },
  }, { globalArgs: { namespace: "apps" } });
  await get.execute({ name: "podinfo" }, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [[
    "detail",
    "detail.apps--podinfo",
  ]]);
  assertEquals(w[0].data.jobsRead, true);
  assertEquals(
    (w[0].data.jobs as Array<{ name: string }>).map((j) => j.name),
    ["podinfo-test"],
  );
  assertEquals((w[0].data.history as unknown[]).length, 2);
  assert(
    h.logs().some((l) => l.startsWith("HelmRelease {name}: ready={ready}")),
  );
});

Deno.test("get records a refused Job read as a note, not a failure", async () => {
  using h = harness({
    [GET]: { stdout: fixture("hr-podinfo") },
    [JOBS]: forbidden("list", "jobs"),
  }, { globalArgs: { namespace: "apps" } });
  await get.execute({ name: "podinfo" }, h.context);
  const d = h.written()[0].data;
  assertEquals(d.jobsRead, false);
  assert(String(d.jobsNote).startsWith("Error from server (Forbidden)"));
});

Deno.test("get passes on a release that does not exist and records nothing", async () => {
  using h = harness({
    [GET]: notFound(HR, "podinfo"),
  }, { globalArgs: { namespace: "apps" } });
  await assertRejects(
    () => get.execute({ name: "podinfo" }, h.context),
    Error,
    "not found",
  );
  assertEquals(h.calls.length, 1);
  assertEquals(h.written(), []);
});
