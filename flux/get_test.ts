import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  type ExpectedKubectl,
  HOSTILE as SHARED_HOSTILE,
  list,
  SAID,
  withKubectl,
} from "../lib/kubectl_fake.ts";
import { withCli } from "../lib/cli_fake.ts";
import { isKubectlError } from "../lib/kubectl.ts";
import { model as helmrelease, parseHelmRelease } from "./helmrelease.ts";
import { model as kustomization } from "./kustomization.ts";
import { extension as reset } from "./reset.ts";
import {
  deriveLastAction,
  detailName,
  extension,
  getArgs,
  type GetContext,
  type HelmReleaseDetail,
  HelmReleaseDetailSchema,
  jobsArgs,
  parseHelmReleaseDetail,
  parseHistoryEntry,
  parseJob,
} from "./get.ts";
import { ctx as plainCtx, HR } from "./test_support.ts";

const get = extension.methods[0].get;

/** A real object, recorded from a kind cluster with Flux 2.10.0. */
function fixture(name: string): Record<string, unknown> {
  return JSON.parse(
    Deno.readTextFileSync(new URL(`./fixtures/${name}.json`, import.meta.url)),
  );
}

function ctx(globalArgs: GetContext["globalArgs"], signal?: AbortSignal) {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];
  const context: GetContext = {
    globalArgs,
    signal,
    logger: {
      info: (m, props) => logs.push(`${m} ${JSON.stringify(props ?? {})}`),
    },
    writeResource: (spec, name, data) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { written, logs, context };
}

// The commands only: the fake checks the cluster flags, the request timeout
// and `-o json` on every call itself.
const hrCall = (name: string, ns: string) => ["get", HR, name, "-n", ns];
const jobsCall = (name: string, ns: string, releaseNs = ns) => [
  "get",
  "jobs.batch",
  "-n",
  releaseNs,
  "-l",
  `helm.toolkit.fluxcd.io/name=${name},helm.toolkit.fluxcd.io/namespace=${ns}`,
];
const NO_JOBS = list([]);

/** Run get against a scripted kubectl and return what it wrote. */
async function run(
  calls: ExpectedKubectl[],
  args: { name: string; namespace?: string },
  globalArgs: GetContext["globalArgs"] = { namespace: "" },
) {
  const c = ctx(globalArgs);
  await withKubectl({
    calls,
    kubeconfig: globalArgs.kubeconfig,
    context: globalArgs.context,
  }, async () => {
    await get.execute(args, c.context);
  });
  return c;
}

/** Run get expecting a refusal; nothing may be written. */
async function refusedWith(
  calls: ExpectedKubectl[],
  args: { name: string; namespace?: string },
  globalArgs: GetContext["globalArgs"] = { namespace: "" },
): Promise<Error> {
  const c = ctx(globalArgs);
  return await withKubectl({ calls }, async () => {
    const e = await assertRejects(() => get.execute(args, c.context), Error);
    assertEquals(c.written, [], "nothing is written on a refusal");
    return e;
  });
}

async function refused(
  calls: ExpectedKubectl[],
  args: { name: string; namespace?: string },
  globalArgs: GetContext["globalArgs"] = { namespace: "" },
): Promise<string> {
  return (await refusedWith(calls, args, globalArgs)).message;
}

// --- the happy paths, on objects recorded from a real cluster ---------------

Deno.test("get records an upgraded release with both history entries", async () => {
  const c = await run(
    [
      { args: hrCall("podinfo", "apps"), out: fixture("hr-podinfo") },
      { args: jobsCall("podinfo", "apps"), out: fixture("jobs-podinfo") },
    ],
    { name: "podinfo" },
    { namespace: "apps", kubeconfig: "/k", context: "c" },
  );
  assertEquals(c.written.length, 1);
  assertEquals(c.written[0].spec, "detail");
  assertEquals(c.written[0].name, "detail.apps--podinfo");
  const d = c.written[0].data as HelmReleaseDetail;
  assertEquals(d.ready, true);
  assertEquals(d.lastAction, "upgrade");
  assertEquals(d.lastActionSource, "lastAttemptedReleaseAction");
  assertEquals(d.lastActionOutcome, "succeeded");
  assertEquals(d.releasedReason, "UpgradeSucceeded");
  assertEquals(d.history.map((h) => [h.version, h.status, h.action]), [
    [2, "deployed", "upgrade"],
    [1, "superseded", undefined],
  ]);
  assertEquals(d.history[0].chartName, "podinfo");
  assertEquals(d.history[0].chartVersion, "6.9.2+971fef0d04d5");
  assertEquals(d.history[0].appVersion, "6.9.2");
  assert(d.history[0].digest!.startsWith("sha256:"));
  assert(d.history[0].configDigest!.startsWith("sha256:"));
  assert(d.history[0].ociDigest!.startsWith("sha256:"));
  assertEquals(d.history[0].firstDeployed, d.history[1].firstDeployed);
  assert(d.history[0].lastDeployed! > d.history[1].lastDeployed!);
  assertEquals(d.history[0].tested, false);
  assertEquals(d.lastAppliedRevision, "6.9.2+971fef0d04d5");
  assertEquals(d.lastAppliedReleaseVersion, 2);
  assertEquals(d.lastAttemptedRevision, "6.9.2+971fef0d04d5");
  assertEquals(
    [d.failures, d.installFailures, d.upgradeFailures, d.stalled],
    [0, 0, 0, false],
  );
  assertEquals([d.jobsRead, d.jobsNote, d.jobs], [true, undefined, []]);
  assertEquals(d.releaseName, "podinfo");
  assertEquals(d.releaseNamespace, "apps");
  assertEquals(d.storageNamespace, "apps");
  assert(c.logs[1].includes('"action":"upgrade"'));
});

Deno.test("get records a failed upgrade, the entry it left, the counters and the hook Jobs", async () => {
  const c = await run(
    [
      { args: hrCall("hooked", "apps"), out: fixture("hr-hooked") },
      { args: jobsCall("hooked", "apps"), out: fixture("jobs-hooked") },
    ],
    { name: "hooked", namespace: "apps" },
  );
  const d = c.written[0].data as HelmReleaseDetail;
  assertEquals(d.ready, false);
  assertEquals(d.readyReason, "UpgradeFailed");
  assertEquals(d.lastAction, "upgrade");
  assertEquals(d.lastActionOutcome, "failed");
  assertEquals(d.stalled, true);
  assertEquals([d.failures, d.installFailures, d.upgradeFailures], [1, 0, 1]);
  assertEquals(d.history.map((h) => [h.version, h.status, h.action]), [
    [2, "failed", "upgrade"],
    [1, "deployed", "install"],
  ]);
  // What is attempted and what is applied differ after a failed upgrade.
  assertEquals([d.generation, d.observedGeneration], [2, 2]);
  assertEquals(d.lastAttemptedRevision, "0.2.0");
  assertEquals(d.lastAppliedRevision, "0.1.0");
  assertEquals(d.lastAppliedReleaseVersion, 1);
  assertEquals(d.history[0].tested, false);
  assertEquals(d.history[1].tested, true);
  assertEquals(d.history[1].testHooks.length, 1);
  assertEquals(d.history[1].testHooks[0].name, "hooked-test");
  assertEquals(d.history[1].testHooks[0].phase, "Succeeded");
  assertEquals(
    d.jobs.map((j) => [j.name, j.hooks, j.state, j.succeeded, j.failed]),
    [
      ["hooked-pre-install", ["pre-install"], "succeeded", 1, 0],
      ["hooked-pre-upgrade", ["pre-upgrade"], "failed", 0, 1],
    ],
  );
  assertEquals(d.jobs[1].reason, "BackoffLimitExceeded");
  assert(d.jobs[0].completionTime);
  assertEquals(d.jobs[1].completionTime, undefined);
});

Deno.test("get records a release that never installed: no history is a fact", async () => {
  const c = await run(
    [
      { args: hrCall("noversion", "apps"), out: fixture("hr-noversion") },
      { args: jobsCall("noversion", "apps"), out: NO_JOBS },
    ],
    { name: "noversion", namespace: "apps" },
  );
  const d = c.written[0].data as HelmReleaseDetail;
  assertEquals(d.ready, false);
  assertEquals(d.readyReason, "SourceNotReady");
  assertEquals(d.history, []);
  assertEquals(d.lastAction, "unknown");
  assertEquals(d.lastActionSource, "none");
  assertEquals(d.lastActionOutcome, "unknown");
  assertEquals(d.lastAppliedRevision, undefined);
  assertEquals(d.releaseName, "noversion");
});

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

Deno.test("the Jobs are read where the release is installed, and the selector names the HelmRelease", async () => {
  const item = fixture("hr-podinfo");
  (item.spec as Record<string, unknown>).targetNamespace = "elsewhere";
  const status = item.status as { history: Array<Record<string, unknown>> };
  status.history = [];
  const c = await run(
    [
      { args: hrCall("podinfo", "apps"), out: item },
      { args: jobsCall("podinfo", "apps", "elsewhere"), out: NO_JOBS },
    ],
    { name: "podinfo", namespace: "apps" },
  );
  assertEquals(
    (c.written[0].data as HelmReleaseDetail).releaseNamespace,
    "elsewhere",
  );
});

// --- the negative suite ------------------------------------------------------

Deno.test("NEG a release that does not exist is an error naming it, and nothing is written", async () => {
  const e = await refusedWith(
    [{ args: hrCall("nope", "apps"), fail: SAID.notFound(HR, "nope") }],
    { name: "nope", namespace: "apps" },
  );
  assertStringIncludes(e.message, '"nope" not found');
  assertStringIncludes(e.message, `kubectl get ${HR} nope -n apps failed`);
  assert(isKubectlError(e, "not-found"));
});

Deno.test("NEG a namespace that does not exist is an error naming it", async () => {
  const m = await refused(
    [{
      args: hrCall("podinfo", "nonesuch"),
      fail: 'Error from server (NotFound): namespaces "nonesuch" not found',
    }],
    { name: "podinfo", namespace: "nonesuch" },
  );
  assertStringIncludes(m, 'namespaces "nonesuch" not found');
});

Deno.test("NEG no namespace at all refuses before kubectl runs", async () => {
  assertStringIncludes(
    await refused([], { name: "podinfo" }),
    "namespace is required for get",
  );
});

Deno.test("NEG a HelmRelease the reader may not get is an error, not an empty record", async () => {
  const e = await refusedWith(
    [{
      args: hrCall("podinfo", "apps"),
      fail:
        `Error from server (Forbidden): ${HR} "podinfo" is forbidden: User "reader" cannot get resource "helmreleases" in API group "helm.toolkit.fluxcd.io" in the namespace "apps"`,
    }],
    { name: "podinfo", namespace: "apps" },
  );
  assertStringIncludes(e.message, "Forbidden");
  assert(isKubectlError(e, "forbidden"));
});

Deno.test("NEG Jobs the reader may not list are recorded as unread, with the reason, and the history is still stored", async () => {
  const c = await run(
    [
      { args: hrCall("hooked", "apps"), out: fixture("hr-hooked") },
      {
        args: jobsCall("hooked", "apps"),
        // kubectl prints an empty List for a refused list, and exits 1.
        stdout: JSON.stringify(NO_JOBS),
        fail:
          'Error from server (Forbidden): jobs.batch is forbidden: User "reader" cannot list resource "jobs" in API group "batch" in the namespace "apps"\nsecond line',
      },
    ],
    { name: "hooked", namespace: "apps" },
  );
  const d = c.written[0].data as HelmReleaseDetail;
  assertEquals(d.jobsRead, false);
  assertEquals(d.jobs, []);
  assertStringIncludes(d.jobsNote!, "jobs.batch is forbidden");
  assert(!d.jobsNote!.includes("second line"));
  assertEquals(d.history.length, 2);
  assert(c.logs[1].includes('"jobs":"unread"'));
});

Deno.test("NEG a Job list that fails for any other reason is a broken call: thrown, nothing written", async () => {
  for (
    const fail of [
      "Unable to connect to the server: context deadline exceeded (Client.Timeout exceeded while awaiting headers)",
      "error: You must be logged in to the server (Unauthorized)",
      "Error from server (InternalError): an error on the server",
      // Forbidden somewhere in the text, but not what the server answered.
      'error: unknown flag "Error from server (Forbidden)"',
    ]
  ) {
    const m = await refused(
      [
        { args: hrCall("hooked", "apps"), out: fixture("hr-hooked") },
        { args: jobsCall("hooked", "apps"), fail },
      ],
      { name: "hooked", namespace: "apps" },
    );
    assertStringIncludes(m, "kubectl get jobs.batch");
  }
});

Deno.test("NEG a server that does not answer is an error; an expired login is too", async () => {
  for (
    const fail of [
      "Unable to connect to the server: net/http: request canceled (Client.Timeout exceeded while awaiting headers)",
      "error: You must be logged in to the server (Unauthorized)",
    ]
  ) {
    const m = await refused(
      [{ args: hrCall("podinfo", "apps"), fail }],
      { name: "podinfo", namespace: "apps" },
    );
    assertStringIncludes(m, fail);
  }
});

Deno.test("NEG a kubectl that hangs is stopped at its limit; a cancelled run stops it at once; neither writes", async () => {
  const e = await refusedWith(
    [{ args: hrCall("podinfo", "apps"), hang: true }],
    { name: "podinfo", namespace: "apps" },
  );
  assertStringIncludes(e.message, "no answer within 35 seconds");
  assert(isKubectlError(e, "timeout"));
  // Cancelled during the first read, and during the Job read after it.
  for (
    const calls of [
      [{ args: hrCall("podinfo", "apps"), hang: "until-cancelled" }],
      [
        { args: hrCall("podinfo", "apps"), out: fixture("hr-podinfo") },
        { args: jobsCall("podinfo", "apps"), hang: "until-cancelled" },
      ],
    ] as ExpectedKubectl[][]
  ) {
    const controller = new AbortController();
    const c = ctx({ namespace: "apps" }, controller.signal);
    await withKubectl({ calls }, async () => {
      const pending = assertRejects(
        () => get.execute({ name: "podinfo" }, c.context),
        Error,
        "was cancelled",
      );
      await new Promise((r) => setTimeout(r, 0));
      controller.abort();
      assert(isKubectlError(await pending, "cancelled"));
    });
    assertEquals(c.written, []);
  }
});

Deno.test("NEG output that is not JSON, or not the HelmRelease that was asked for, is a named error", async () => {
  const one = (out: string) =>
    refused(
      [{ args: hrCall("podinfo", "apps"), out }],
      { name: "podinfo", namespace: "apps" },
    );
  const html = await one("<html>proxy error token=abc123</html>");
  assertStringIncludes(html, `kubectl get ${HR} podinfo -n apps did not print`);
  assertStringIncludes(html, "JSON (37 characters of output)");
  assert(!html.includes("abc123"), "the output is not repeated");
  assertStringIncludes(await one(""), "(no output)");
  const other = fixture("hr-hooked");
  const elsewhere = fixture("hr-podinfo");
  (elsewhere.metadata as Record<string, unknown>).namespace = "other";
  for (
    const out of [
      "null",
      "[]",
      '"text"',
      "42",
      "{}",
      JSON.stringify(NO_JOBS),
      '{"kind":"Status","status":"Failure"}',
      // A HelmRelease, but another one, or the right name in another namespace.
      JSON.stringify(other),
      JSON.stringify(elsewhere),
    ]
  ) {
    assertStringIncludes(
      await one(out),
      "kubectl did not return HelmRelease apps/podinfo",
    );
  }
  const m = await refused(
    [
      { args: hrCall("podinfo", "apps"), out: fixture("hr-podinfo") },
      { args: jobsCall("podinfo", "apps"), out: "garbage" },
    ],
    { name: "podinfo", namespace: "apps" },
  );
  assertStringIncludes(m, "did not print JSON");
});

Deno.test("NEG a Job list that is JSON of the wrong shape is a broken call, never 'no Jobs': thrown, nothing written", async () => {
  for (
    const [out, phrase] of [
      ["null", "did not return a list"],
      ["[]", "did not return a list"],
      ["{}", "did not return a list"],
      ['{"items":[]}', "did not return a list"],
      ['{"kind":"Status","status":"Failure"}', "did not return a list"],
      ['{"kind":"List","items":"x"}', "did not return a list"],
      ['{"kind":"List","items":[1,null]}', "item 0 is not an object"],
      ['{"kind":"List","items":[{"kind":"Pod"}]}', "not Job"],
    ]
  ) {
    const m = await refused(
      [
        { args: hrCall("podinfo", "apps"), out: fixture("hr-podinfo") },
        { args: jobsCall("podinfo", "apps"), out },
      ],
      { name: "podinfo", namespace: "apps" },
    );
    assertStringIncludes(m, "kubectl get jobs.batch");
    assertStringIncludes(m, phrase);
  }
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

const HOSTILE = [
  ...SHARED_HOSTILE,
  "--all",
  "-A",
  "-o=yaml",
  "--kubeconfig=/etc/passwd",
  "--",
  "-",
  "",
  " ",
  "a b",
  " podinfo",
  "podinfo ",
  "a;rm -rf /",
  "$(id)",
  "`id`",
  "a|b",
  "a&b",
  "a>b",
  "a/b",
  "../x",
  "a\nb",
  "a\tb",
  "a\u0000b",
  "Podinfo",
  "a_b",
  "a,helm.toolkit.fluxcd.io/name=other",
  "a=b",
  "a*",
  "a'b",
  'a"b',
  ".a",
  "a.",
  "-a",
  "a-",
  "a".repeat(254),
];

Deno.test("NEG a name shaped as a flag, a selector or shell text is refused before kubectl runs", async () => {
  for (const name of HOSTILE) {
    const m = await refused([], { name, namespace: "apps" });
    assertStringIncludes(m, "is not a Kubernetes object name");
    assert(m.length < 400, "a long name does not flood the error");
    assertEquals(get.arguments.safeParse({ name }).success, false, name);
  }
  assertEquals(get.arguments.safeParse({ name: "a.b-c1" }).success, true);
  assertEquals(
    get.arguments.safeParse({ name: "a".repeat(253) }).success,
    true,
  );
});

Deno.test("NEG a namespace shaped the same way is refused, from the argument or from the model", async () => {
  for (const namespace of [...HOSTILE, "a.b", "a".repeat(64)]) {
    if (namespace !== "") {
      assertStringIncludes(
        await refused([], { name: "podinfo", namespace }),
        "is not a Kubernetes namespace name",
      );
      assertStringIncludes(
        await refused([], { name: "podinfo" }, { namespace }),
        "is not a Kubernetes namespace name",
      );
    }
  }
  // The schema lets an empty namespace through, because swamp fills the
  // argument from the model; the method then says that one is required.
  assertEquals(
    get.arguments.safeParse({ name: "podinfo", namespace: "" }).success,
    true,
  );
  assertStringIncludes(
    await refused([], { name: "podinfo", namespace: "" }),
    "namespace is required for get",
  );
});

Deno.test("NEG the methods that change something refuse the same names: --all never reaches flux", async () => {
  // Every spawn that is tried is recorded here before the fake refuses it, so
  // a method that swallows the fake's refusal is still caught.
  const tried: string[] = [];
  await withCli({
    handler: (call) => {
      tried.push(`${call.bin} ${call.args.join(" ")}`);
      return undefined;
    },
  }, async () => {
    for (const name of HOSTILE) {
      const hr = plainCtx({ namespace: "apps" });
      const ks = plainCtx({ namespace: "apps" });
      for (const method of ["reconcile", "suspend", "resume"] as const) {
        await assertRejects(
          () => helmrelease.methods[method].execute({ name }, hr.context),
          Error,
          "is not a Kubernetes object name",
        );
        await assertRejects(
          () => kustomization.methods[method].execute({ name }, ks.context),
          Error,
          "is not a Kubernetes object name",
        );
        await assertRejects(
          () =>
            helmrelease.methods[method].execute(
              { name: "ok", namespace: name || "-A" },
              hr.context,
            ),
          Error,
          "is not a Kubernetes namespace name",
        );
      }
      const written: unknown[] = [];
      await assertRejects(
        () =>
          reset.methods[0].reset.execute({ name }, {
            globalArgs: { namespace: "apps" },
            signal: new AbortController().signal,
            logger: { info: () => {} },
            writeResource: (_s, n, d) => {
              written.push(d);
              return Promise.resolve({ name: n });
            },
          }),
        Error,
        "is not a Kubernetes object name",
      );
      assertEquals([hr.written, ks.written, written], [[], [], []]);
    }
  });
  assertEquals(tried, [], "nothing was spawned");
});

Deno.test("NEG a release on another cluster, a namespace the object should not hold, a name too long for a label: the Jobs are recorded as unread and kubectl is not asked", async () => {
  const cases: Array<[string, (i: Record<string, unknown>) => void, string]> = [
    ["podinfo", (i) => {
      (i.spec as Record<string, unknown>).kubeConfig = {
        secretRef: { name: "remote" },
      };
    }, "another cluster"],
    ["podinfo", (i) => {
      (i.status as { history: Array<Record<string, unknown>> }).history[0]
        .namespace = "--all-namespaces";
    }, "not a namespace name"],
    ["a".repeat(64), () => {}, "longer than a label value"],
  ];
  for (const [name, change, note] of cases) {
    const item = fixture("hr-podinfo");
    (item.metadata as Record<string, unknown>).name = name;
    change(item);
    const c = await run(
      [{ args: hrCall(name, "apps"), out: item }],
      { name, namespace: "apps" },
    );
    const d = c.written[0].data as HelmReleaseDetail;
    assertEquals([d.jobsRead, d.jobs], [false, []]);
    assertStringIncludes(d.jobsNote!, note);
  }
});

Deno.test("NEG nothing secret reaches the record, the log or an error: values and secret references stay in the cluster", async () => {
  const SECRET = "hunter2-s3cret-value";
  const item = fixture("hr-hooked");
  const spec = item.spec as Record<string, unknown>;
  spec.values = { password: SECRET, nested: { token: SECRET } };
  spec.valuesFrom = [{ kind: "Secret", name: "db-credentials-name" }];
  spec.postRenderers = [{ kustomize: { patches: [{ patch: SECRET }] } }];
  (item.metadata as Record<string, unknown>).annotations = { note: SECRET };
  const jobs = fixture("jobs-hooked") as {
    items: Array<Record<string, Record<string, unknown>>>;
  };
  jobs.items[0].spec = {
    template: {
      spec: { containers: [{ env: [{ name: "PW", value: SECRET }] }] },
    },
  };
  const calls: ExpectedKubectl[] = [
    { args: hrCall("hooked", "apps"), out: item },
    { args: jobsCall("hooked", "apps"), out: jobs },
  ];
  // A controller message that quotes a URL with a password in it.
  (item.status as { conditions: Array<Record<string, unknown>> }).conditions[0]
    .message = `fetch https://bot:${SECRET}@charts.example.org/x failed`;
  const c = await run(calls, { name: "hooked", namespace: "apps" });
  const everything = JSON.stringify(c.written) + c.logs.join("\n");
  assertStringIncludes(everything, "https://charts.example.org/x failed");
  assert(!everything.includes(SECRET));
  assert(!everything.includes("db-credentials-name"));
  // A broken Job read after a good release read: the error names the command only.
  calls[1] = { args: calls[1].args, fail: "error: boom" };
  const m = await refused(calls, { name: "hooked", namespace: "apps" });
  assert(!m.includes(SECRET));
  // Output that is not JSON is not repeated, so a truncated object that
  // holds the secret cannot reach the error; nor can a token kubectl prints.
  calls[1] = {
    args: calls[1].args,
    out: JSON.stringify(jobs).slice(0, -1),
  };
  const cut = await refused(calls, { name: "hooked", namespace: "apps" });
  assertStringIncludes(cut, "did not print JSON");
  assert(!cut.includes(SECRET));
  calls[0] = {
    args: calls[0].args,
    fail:
      `error: bad login for token=${SECRET} Authorization: Bearer ${SECRET}`,
  };
  const said = await refused([calls[0]], { name: "hooked", namespace: "apps" });
  assert(!said.includes(SECRET));
});

Deno.test("get is added to the helmrelease type, with its own record", () => {
  assertEquals(extension.type, helmrelease.type);
  assertEquals(Object.keys(extension.methods[0]), ["get"]);
  assertEquals(Object.keys(extension.resources), ["detail"]);
  assertEquals(helmrelease.version, "2026.11.10.1");
  assertEquals(helmrelease.upgrades.at(-1)!.toVersion, helmrelease.version);
});
