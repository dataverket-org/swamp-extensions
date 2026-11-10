import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import type { FakeTime } from "../lib/cli_fake.ts";
import {
  isCancelled,
  KUBECTL_CALL_LIMIT_MS,
  KubectlError,
} from "../lib/kubectl.ts";
import type { FakeKubectl, KubectlCall } from "../lib/kubectl_fake.ts";
import { RESOURCES } from "./_helpers.ts";
import {
  backupReason,
  BackupSchema,
  newest,
  parseBackup,
  scheduledBackupOf,
} from "./_backup_record.ts";
import {
  CREATE_LIMIT_MS,
  CreateArgsSchema,
  desiredSpec,
  MAX_WAIT_SECONDS,
  model as backup,
  OPAQUE_MIN_LENGTH,
  refusal,
  specDifferences,
} from "./backup.ts";
import {
  backupCompleted,
  backupFailed,
  backupLoaded,
  clusterNoBackup,
  clusterOne,
  clusterThree,
  scheduled,
} from "./fixtures.ts";
import {
  type Answer,
  everything,
  forbidden,
  forbiddenList,
  getArgs,
  HOSTILE,
  list,
  listCall,
  notFound,
  PLANTED,
  SAID,
  withScript,
} from "./test_support.ts";

const C = RESOURCES.cluster;
const B = RESOURCES.backup;
const CREATE = ["create", "-f", "-", "-n", "pg"];
const PLUGIN = "barman-cloud.cloudnative-pg.io";
type Fake = FakeKubectl & FakeTime;
const MISSING_CRD = "the CRDs that define it are not installed";

function noSecret(text: string): void {
  for (const v of Object.values(PLANTED)) {
    assertFalse(text.includes(v), `${v} leaked`);
  }
}

/** The arguments as swamp hands them over: parsed, so defaults are filled in. */
function args(a: Record<string, unknown>) {
  return CreateArgsSchema.parse(a);
}

function manifest(name: string, spec: Record<string, unknown>) {
  return {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: { name, namespace: "pg" },
    spec,
  };
}

/** A Backup of `one` as the API server returns it, in the given phase. */
function live(phase?: string, extra: Record<string, unknown> = {}) {
  return {
    ...manifest("b1", {
      cluster: { name: "one" },
      method: "barmanObjectStore",
    }),
    status: phase ? { phase, ...extra } : undefined,
  };
}

Deno.test("a completed Backup is read in full", () => {
  const r = parseBackup(backupCompleted);
  BackupSchema.strict().parse(r);
  assertEquals(r, {
    name: "manual-1",
    namespace: "pg",
    createdAt: "2026-11-10T09:44:00Z",
    cluster: "one",
    method: "barmanObjectStore",
    target: null,
    online: null,
    pluginName: null,
    scheduledBackup: null,
    phase: "completed",
    completed: true,
    failed: false,
    finished: true,
    error: null,
    startedAt: "2026-11-10T09:44:05Z",
    stoppedAt: "2026-11-10T09:44:12Z",
    beginWal: "000000010000000000000004",
    endWal: "000000010000000000000004",
    beginLSN: "0/4000028",
    endLSN: "0/4000158",
    backupId: "backup-20261110094405",
    backupName: "backup-20261110094405",
    destinationPath: "s3://one/",
    endpointURL: "http://s3.pg.svc:7070",
    serverName: "one",
    instance: "one-1",
    majorVersion: 18,
    timeline: 1,
    snapshots: [],
    unfinishedSeconds: null,
    adopted: null,
  });
});

Deno.test("no credential reference, command output or URL password is stored", () => {
  noSecret(JSON.stringify(parseBackup(backupCompleted)));
  noSecret(JSON.stringify(parseBackup(backupFailed)));
  // Every provider's credential references, and the CA of the endpoint.
  const loaded = JSON.stringify(parseBackup(backupLoaded));
  noSecret(loaded);
  for (const field of ["Credentials", "endpointCA", "commandOutput"]) {
    assertFalse(loaded.includes(field), field);
  }
});

Deno.test("a failed Backup is a record with the error, cleaned", () => {
  const r = parseBackup(backupFailed);
  BackupSchema.strict().parse(r);
  assertEquals([r.phase, r.completed, r.failed, r.finished], [
    "failed",
    false,
    true,
    true,
  ]);
  assertEquals(
    r.error,
    "exit status 4: could not reach https://s3.example.org with Bearer [redacted]",
  );
  assertEquals(r.timeline, null);
});

Deno.test("a plugin Backup made by a schedule names both, and its timeline", () => {
  const r = parseBackup(
    scheduled("nightly-1", "2026-11-10T03:30:00Z", "completed"),
  );
  BackupSchema.strict().parse(r);
  assertEquals(r.method, "plugin");
  assertEquals(r.pluginName, PLUGIN);
  assertEquals(r.scheduledBackup, "nightly");
  assertEquals(r.timeline, 2);
  assertEquals(r.destinationPath, null);
  assertEquals(r.instance, "three-2");
});

Deno.test("the timeline comes from the WAL name when no plugin reports it", () => {
  const t = (beginWal: unknown) =>
    parseBackup({ status: { beginWal } }).timeline;
  assertEquals(t("0000000A0000000000000004"), 10);
  assertEquals(t("000000010000000000000004.partial"), 1);
  assertEquals(t("not-a-wal-name"), null);
  assertEquals(t(7), null);
  assertEquals(
    parseBackup({ status: { pluginMetadata: { timeline: "x" } } }).timeline,
    null,
  );
});

Deno.test("the schedule is the operator's label, then the owner reference", () => {
  assertEquals(scheduledBackupOf({}), null);
  assertEquals(
    scheduledBackupOf({
      metadata: { labels: { "cnpg.io/scheduled-backup": "by-label" } },
    }),
    "by-label",
  );
  assertEquals(
    scheduledBackupOf({
      metadata: {
        ownerReferences: [
          { kind: "Cluster", name: "three" },
          { kind: "ScheduledBackup", name: "by-owner" },
        ],
      },
    }),
    "by-owner",
  );
  assertEquals(
    scheduledBackupOf({
      metadata: { ownerReferences: [{ kind: "Cluster", name: "three" }] },
    }),
    null,
  );
});

Deno.test("a Backup that has not started, and a malformed one, still parse", () => {
  const shapes: unknown[] = [
    {},
    live(),
    { metadata: null, spec: "x", status: [] },
    {
      metadata: { name: 1, labels: "x", ownerReferences: "y" },
      spec: { cluster: "one", pluginConfiguration: "p", online: "yes" },
      status: {
        phase: 3,
        error: {},
        instanceID: "pod",
        snapshotBackupStatus: { elements: [null, { name: "s1" }, { name: 2 }] },
        majorVersion: "18",
      },
    },
  ];
  for (const s of shapes) {
    const r = parseBackup(s as Record<string, unknown>);
    BackupSchema.strict().parse(r);
    assertEquals([r.completed, r.failed, r.finished], [false, false, false]);
  }
  assertEquals(
    parseBackup(shapes[3] as Record<string, unknown>).snapshots,
    ["s1"],
  );
});

Deno.test("only completed and failed are final phases", () => {
  for (
    const phase of [
      "pending",
      "started",
      "running",
      "finalizing",
      "walArchivingFailing",
      "new",
    ]
  ) {
    assertFalse(parseBackup(live(phase)).finished, phase);
  }
  assert(parseBackup(live("completed")).finished);
  assert(parseBackup(live("failed")).finished);
});

Deno.test("an error text is cut at 2000 characters", () => {
  const r = parseBackup(live("failed", { error: "e".repeat(5000) }));
  assertEquals(r.error!.length, 2000);
});

Deno.test("newest is by creation time, then by name", () => {
  assertEquals(newest([]), null);
  const b = (name: string, createdAt: string | null) =>
    parseBackup({ metadata: { name, creationTimestamp: createdAt } });
  assertEquals(
    newest([
      b("a", "2026-11-09T03:30:00Z"),
      b("c", "2026-11-10T03:30:00Z"),
      b("b", "2026-11-08T03:30:00Z"),
    ])!.name,
    "c",
  );
  assertEquals(
    newest([
      b("x-2", "2026-11-10T03:30:00Z"),
      b("x-1", "2026-11-10T03:30:00Z"),
    ])!
      .name,
    "x-2",
  );
  assertEquals(
    newest([b("no-time", null), b("timed", "2026-01-01T00:00:00Z")])!.name,
    "timed",
  );
});

Deno.test("the desired spec holds exactly what the request sets", () => {
  assertEquals(desiredSpec(args({ name: "b", cluster: "one" })), {
    cluster: { name: "one" },
    method: "barmanObjectStore",
  });
  assertEquals(
    desiredSpec(args({
      name: "b",
      cluster: "three",
      method: "plugin",
      target: "primary",
      online: true,
      onlineConfiguration: { immediateCheckpoint: true },
      pluginConfiguration: { name: PLUGIN, parameters: { a: "b" } },
    })),
    {
      cluster: { name: "three" },
      method: "plugin",
      target: "primary",
      online: true,
      onlineConfiguration: { immediateCheckpoint: true },
      pluginConfiguration: { name: PLUGIN, parameters: { a: "b" } },
    },
  );
});

Deno.test("the create arguments refuse what the CRD refuses", () => {
  for (
    const bad of [
      { name: "b" },
      { cluster: "one" },
      { name: "", cluster: "one" },
      { name: "b", cluster: "one", method: "pg_dump" },
      { name: "b", cluster: "one", target: "standby" },
      { name: "b", cluster: "one", waitSeconds: 121 },
      { name: "b", cluster: "one", waitSeconds: -1 },
      { name: "b", cluster: "one", pollSeconds: 0 },
      { name: "b", cluster: "one", pluginConfiguration: {} },
      {
        name: "b",
        cluster: "one",
        pluginConfiguration: { name: "p", parameters: { a: 1 } },
      },
    ]
  ) {
    assertFalse(CreateArgsSchema.safeParse(bad).success, JSON.stringify(bad));
  }
});

Deno.test("an existing Backup is the same request only when every set field is equal", () => {
  const same = (
    existing: Record<string, unknown>,
    a: Record<string, unknown>,
  ) => specDifferences(existing, desiredSpec(args({ name: "b", ...a })));
  assertEquals(same({ cluster: { name: "one" } }, { cluster: "one" }), []);
  assertEquals(
    same({
      cluster: { name: "one" },
      method: "barmanObjectStore",
      target: "primary",
    }, {
      cluster: "one",
    }),
    [],
  );
  assertEquals(
    same({ cluster: { name: "two" }, method: "plugin" }, { cluster: "one" }),
    ["cluster", "method"],
  );
  assertEquals(
    same({ cluster: { name: "one" } }, { cluster: "one", target: "primary" }),
    ["target"],
  );
  assertEquals(
    same(
      {
        cluster: { name: "one" },
        method: "plugin",
        pluginConfiguration: { parameters: { b: "2", a: "1" }, name: "p" },
      },
      {
        cluster: "one",
        method: "plugin",
        pluginConfiguration: { name: "p", parameters: { a: "1", b: "2" } },
      },
    ),
    [],
  );
  assertEquals(
    same(
      {
        cluster: { name: "one" },
        method: "plugin",
        pluginConfiguration: { name: "p" },
      },
      { cluster: "one", method: "plugin", pluginConfiguration: { name: "q" } },
    ),
    ["pluginConfiguration"],
  );
});

Deno.test("a Cluster is refused for a method it is not configured for", () => {
  const r = (cluster: unknown, a: Record<string, unknown>) =>
    refusal(
      cluster as Record<string, unknown>,
      args({ name: "b", cluster: "x", ...a }),
    );
  assertEquals(r(clusterOne, {}), null);
  assertEquals(
    r(clusterThree, {
      method: "plugin",
      pluginConfiguration: { name: PLUGIN },
    }),
    null,
  );
  assertStringIncludes(
    r(clusterNoBackup, {})!,
    "no spec.backup.barmanObjectStore",
  );
  assertStringIncludes(
    r(clusterThree, {})!,
    "no spec.backup.barmanObjectStore",
  );
  assertStringIncludes(
    r(clusterOne, { method: "volumeSnapshot" })!,
    "no spec.backup.volumeSnapshot",
  );
  assertStringIncludes(
    r(clusterThree, { method: "plugin" })!,
    "needs pluginConfiguration.name",
  );
  assertStringIncludes(
    r(clusterOne, { method: "plugin", pluginConfiguration: { name: PLUGIN } })!,
    "does not list the plugin",
  );
  assertStringIncludes(
    r(clusterThree, {
      method: "plugin",
      pluginConfiguration: { name: "other.example.org" },
    })!,
    "disabled",
  );
  assertStringIncludes(
    r(clusterOne, { pluginConfiguration: { name: PLUGIN } })!,
    "only for method plugin",
  );
  assertEquals(
    r({ spec: { backup: { volumeSnapshot: { className: "c" } } } }, {
      method: "volumeSnapshot",
    }),
    null,
  );
});

Deno.test("list records every Backup, or the ones of one Cluster", async () => {
  const all = list([
    backupCompleted,
    backupFailed,
    scheduled("n-1", "2026-11-10T03:30:00Z", "completed"),
  ]);
  await withScript(
    [{ args: listCall(B, ""), out: all }],
    { namespace: "" },
    async (c) => {
      const r = await backup.methods.list.execute({}, c.context);
      assertEquals(r.dataHandles.length, 4);
      assertEquals(c.written.map((w) => [w.spec, w.name]), [
        ["backup", "pg--manual-1"],
        ["backup", "pg--bad-1"],
        ["backup", "pg--n-1"],
        ["inventory", "inventory_all"],
      ]);
      for (const w of c.written.slice(0, 3)) {
        BackupSchema.strict().parse(w.data);
      }
      noSecret(everything(c));
    },
  );
  await withScript(
    [{ args: listCall(B, "pg"), out: all }],
    { namespace: "pg" },
    async (c) => {
      await backup.methods.list.execute({ cluster: "bad" }, c.context);
      assertEquals(c.written.map((w) => w.name), ["pg--bad-1"]);
    },
  );
});

Deno.test("list and get fail by name on a broken call and write nothing", async () => {
  const broken: Array<[Answer, string]> = [
    [forbiddenList(B, "pg"), "(Forbidden)"],
    [{ fail: SAID.missingCrd("backups") }, MISSING_CRD],
    [{ out: "not json" }, "did not print JSON (8 characters of output)"],
    [{ out: { items: "x" } }, "did not return a list"],
    [{ out: { kind: "Status", items: [] } }, "did not return a list"],
    [{ out: list([null]) }, "item 0 is not an object"],
    [{ out: list([clusterOne]) }, 'item 0 is of kind "Cluster", not Backup'],
    [
      { out: list([{ kind: "Backup", metadata: { namespace: "pg" } }]) },
      "a Backup without a name or namespace",
    ],
    [{ hang: true }, "no answer within 35 seconds"],
    [{ fail: SAID.unauthorized }, "did not accept the credentials"],
    [{ fail: SAID.badToken }, "did not accept the credentials"],
    [{ fail: SAID.refused }, "could not be reached"],
    [{ fail: SAID.requestTimeout }, "no answer in time"],
    [{ notInstalled: true }, "kubectl is not on PATH"],
  ];
  for (const [answer, text] of broken) {
    await withScript([{ args: listCall(B, "pg"), ...answer }], {
      namespace: "pg",
    }, async (c) => {
      const e = await assertRejects(
        () => backup.methods.list.execute({}, c.context),
        Error,
      );
      assertStringIncludes(e.message, text);
      assertEquals(c.written, []);
    });
  }
  for (
    const [answer, text] of [
      [{ fail: notFound(B, "gone") }, '"gone" not found'],
      [{ fail: forbidden("get", B, "pg") }, "(Forbidden)"],
      [{ out: "" }, "did not print JSON (no output)"],
      [{ hang: true }, "no answer within 35 seconds"],
      [{ fail: SAID.unauthorized }, "did not accept the credentials"],
    ] as Array<[Answer, string]>
  ) {
    await withScript([{ args: getArgs(B, "gone", "pg"), ...answer }], {
      namespace: "pg",
    }, async (c) => {
      const e = await assertRejects(
        () => backup.methods.get.execute({ name: "gone" }, c.context),
        Error,
      );
      assertStringIncludes(e.message, text);
      assertEquals(c.written, []);
    });
  }
});

Deno.test("get records a failed Backup without failing", async () => {
  await withScript(
    [{ args: getArgs(B, "bad-1", "pg"), out: backupFailed }],
    { namespace: "pg" },
    async (c) => {
      const r = await backup.methods.get.execute({ name: "bad-1" }, c.context);
      assertEquals(r.dataHandles.length, 1);
      assertEquals((c.written[0].data as { failed: boolean }).failed, true);
      noSecret(everything(c));
    },
  );
});

Deno.test("hostile names, clusters and namespaces are refused before anything is spawned", async () => {
  for (const bad of HOSTILE) {
    await withScript([], { namespace: "pg" }, async (c, s) => {
      await assertRejects(
        () => backup.methods.get.execute({ name: bad }, c.context),
        Error,
      );
      await assertRejects(
        () => backup.methods.list.execute({ cluster: bad }, c.context),
        Error,
        "is not a Kubernetes object name",
      );
      await assertRejects(
        () =>
          backup.methods.create.execute(
            args({ name: bad || "-", cluster: "one" }),
            c.context,
          ),
        Error,
        "is not a Kubernetes object name",
      );
      await assertRejects(
        () =>
          backup.methods.create.execute(
            args({ name: "b1", cluster: bad || "-" }),
            c.context,
          ),
        Error,
        "is not a Kubernetes object name",
      );
      if (bad !== "") {
        await assertRejects(
          () =>
            backup.methods.create.execute(
              args({ name: "b1", cluster: "one", namespace: bad }),
              c.context,
            ),
          Error,
          "is not a Kubernetes namespace name",
        );
      }
      assertEquals(s.calls, []);
      assertEquals(c.written, []);
    });
  }
});

Deno.test("create needs a namespace", async () => {
  await withScript([], { namespace: "" }, async (c) => {
    await assertRejects(
      () =>
        backup.methods.create.execute(
          args({ name: "b1", cluster: "one" }),
          c.context,
        ),
      Error,
      "namespace is required for create",
    );
  });
});

Deno.test("create checks the Cluster, creates the Backup, waits and records it completed", async () => {
  const spec = { cluster: { name: "one" }, method: "barmanObjectStore" };
  await withScript(
    [
      { args: getArgs(C, "one", "pg"), out: clusterOne },
      { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
      { args: CREATE, stdin: manifest("b1", spec), out: live() },
      { args: getArgs(B, "b1", "pg"), out: live("running") },
      {
        args: getArgs(B, "b1", "pg"),
        out: live("completed", { backupId: "id1" }),
      },
    ],
    { namespace: "pg", kubeconfig: "/tmp/kc", context: "kind-x" },
    async (c, s) => {
      const r = await backup.methods.create.execute(
        args({ name: "b1", cluster: "one" }),
        c.context,
      );
      assertEquals(r.dataHandles.length, 1);
      assertEquals(c.written.length, 1);
      assertEquals([c.written[0].spec, c.written[0].name], [
        "backup",
        "pg--b1",
      ]);
      const d = c.written[0].data as ReturnType<typeof parseBackup>;
      BackupSchema.strict().parse(d);
      assertEquals([d.completed, d.backupId], [true, "id1"]);
      assertEquals(s.slept, [5000, 5000]);
      assertStringIncludes(c.logs.at(-1)!, "Backup b1 completed");
      noSecret(everything(c));
    },
  );
});

Deno.test("create sends the plugin request as the CRD spells it", async () => {
  const spec = {
    cluster: { name: "three" },
    method: "plugin",
    target: "primary",
    pluginConfiguration: { name: PLUGIN },
  };
  await withScript(
    [
      { args: getArgs(C, "three", "pg"), out: clusterThree },
      { args: getArgs(B, "p1", "pg"), fail: notFound(B, "p1") },
      {
        args: CREATE,
        stdin: manifest("p1", spec),
        out: { ...manifest("p1", spec), status: { phase: "completed" } },
      },
    ],
    { namespace: "pg" },
    async (c, s) => {
      await backup.methods.create.execute(
        args({
          name: "p1",
          cluster: "three",
          method: "plugin",
          target: "primary",
          pluginConfiguration: { name: PLUGIN },
        }),
        c.context,
      );
      assertEquals(s.slept, []);
      assertEquals(
        (c.written[0].data as { pluginName: string }).pluginName,
        PLUGIN,
      );
    },
  );
});

Deno.test("create twice with the same name and request creates once", async () => {
  await withScript(
    [
      { args: getArgs(C, "one", "pg"), out: clusterOne },
      { args: getArgs(B, "b1", "pg"), out: live("completed") },
    ],
    { namespace: "pg" },
    async (c, s) => {
      await backup.methods.create.execute(
        args({ name: "b1", cluster: "one" }),
        c.context,
      );
      assertEquals(c.written.length, 1);
      assertEquals(s.slept, []);
      assert(
        c.logs.some((l) => l.includes("already exists with the same request")),
      );
      assertFalse(s.kubectl.some((call) => call.verb === "create"));
    },
  );
});

Deno.test("create refuses a name that is taken by a different request", async () => {
  await withScript(
    [
      { args: getArgs(C, "three", "pg"), out: clusterThree },
      { args: getArgs(B, "b1", "pg"), out: live("completed") },
    ],
    { namespace: "pg" },
    async (c, s) => {
      const e = await assertRejects(
        () =>
          backup.methods.create.execute(
            args({
              name: "b1",
              cluster: "three",
              method: "plugin",
              pluginConfiguration: { name: PLUGIN },
            }),
            c.context,
          ),
        Error,
      );
      assertStringIncludes(
        e.message,
        "already exists in namespace pg with a different request",
      );
      assertStringIncludes(e.message, "(cluster, method, pluginConfiguration)");
      assertEquals(c.written, []);
      assertFalse(s.kubectl.some((call) => call.verb === "create"));
    },
  );
});

Deno.test("create refuses a missing Cluster and one without the method, and creates nothing", async () => {
  await withScript(
    [{ args: getArgs(C, "gone", "pg"), fail: notFound(C, "gone") }],
    { namespace: "pg" },
    async (c) => {
      const e = await assertRejects(
        () =>
          backup.methods.create.execute(
            args({ name: "b1", cluster: "gone" }),
            c.context,
          ),
        Error,
      );
      assertStringIncludes(
        e.message,
        "was not created: there is no Cluster gone in namespace pg",
      );
      assertEquals(c.written, []);
    },
  );
  await withScript(
    [{ args: getArgs(C, "nobackup", "pg"), out: clusterNoBackup }],
    { namespace: "pg" },
    async (c) => {
      const e = await assertRejects(
        () =>
          backup.methods.create.execute(
            args({ name: "b1", cluster: "nobackup" }),
            c.context,
          ),
        Error,
      );
      assertStringIncludes(
        e.message,
        "was not created: the Cluster has no spec.backup.barmanObjectStore",
      );
      assertEquals(c.written, []);
    },
  );
});

Deno.test("create fails before creating when a check cannot be made", async () => {
  const cases: Array<[Array<{ args: string[] } & Answer>, string]> = [
    [
      [{ args: getArgs(C, "one", "pg"), fail: forbidden("get", C, "pg") }],
      "(Forbidden)",
    ],
    [[{ args: getArgs(C, "one", "pg"), out: "garbage" }], "did not print JSON"],
    [
      [{ args: getArgs(C, "one", "pg"), fail: SAID.missingCrd("clusters") }],
      MISSING_CRD,
    ],
    [
      // No object is named: the path is not served, so it is not "no Cluster".
      [{
        args: getArgs(C, "one", "pg"),
        fail:
          "Error from server (NotFound): the server could not find the requested resource\n",
      }],
      MISSING_CRD,
    ],
    [
      [{ args: getArgs(C, "one", "pg"), fail: SAID.badToken }],
      "did not accept the credentials",
    ],
    [
      [{ args: getArgs(C, "one", "pg"), hang: true }],
      "no answer within 35 seconds",
    ],
    [
      [
        { args: getArgs(C, "one", "pg"), out: clusterOne },
        { args: getArgs(B, "b1", "pg"), fail: forbidden("get", B, "pg") },
      ],
      "(Forbidden)",
    ],
    [
      [
        { args: getArgs(C, "one", "pg"), out: clusterOne },
        { args: getArgs(B, "b1", "pg"), hang: true },
      ],
      "no answer within 35 seconds",
    ],
  ];
  for (const [calls, text] of cases) {
    await withScript(calls, { namespace: "pg" }, async (c, s) => {
      const e = await assertRejects(
        () =>
          backup.methods.create.execute(
            args({ name: "b1", cluster: "one" }),
            c.context,
          ),
        Error,
      );
      assertStringIncludes(e.message, text);
      assertEquals(c.written, []);
      assertFalse(s.kubectl.some((call) => call.verb === "create"));
    });
  }
});

Deno.test("a create the API server refuses by name is an error at once, and nothing is recorded", async () => {
  const spec = { cluster: { name: "one" }, method: "barmanObjectStore" };
  for (
    const [answer, text] of [
      [{ fail: forbidden("create", B, "pg") }, "cannot create resource"],
      [{ fail: SAID.noKind("Backup", "postgresql.cnpg.io/v1") }, MISSING_CRD],
      [{ fail: SAID.badToken }, "did not accept the credentials"],
      [{ fail: SAID.refused }, "could not be reached"],
      [{ notInstalled: true }, "kubectl is not on PATH"],
    ] as Array<[Answer, string]>
  ) {
    await withScript(
      [
        { args: getArgs(C, "one", "pg"), out: clusterOne },
        { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
        { args: CREATE, stdin: manifest("b1", spec), ...answer },
      ],
      { namespace: "pg" },
      async (c, s) => {
        const e = await assertRejects(
          () =>
            backup.methods.create.execute(
              args({ name: "b1", cluster: "one" }),
              c.context,
            ),
          Error,
        );
        assertStringIncludes(e.message, text);
        assertEquals(c.written, []);
        assertEquals(s.slept, []);
        // No read after the refusal: the script holds none.
        assertEquals(s.kubectl.length, 3);
      },
    );
  }
});

/** The ways a create can end without saying whether it was applied. */
const UNCONFIRMED: Array<[string, Answer, string]> = [
  ["an answer that is not JSON", { out: "created" }, "did not print JSON"],
  ["no answer in time", { hang: true }, "no answer within 35 seconds"],
  [
    "a Backup made by another run",
    { fail: SAID.alreadyExists(B, "b1") },
    "(AlreadyExists)",
  ],
  ["an answer that is not the Backup", { out: {} }, "did not return Backup"],
  [
    "an answer that is another Backup",
    { out: { ...live(), metadata: { name: "b2", namespace: "pg" } } },
    "did not return Backup pg/b1",
  ],
  [
    "a refusal kubectl gives no name to",
    {
      fail:
        'Error from server (BadRequest): admission webhook "vbackup.cnpg.io" denied the request',
    },
    "denied the request",
  ],
];

Deno.test("an unconfirmed create is read back once: the Backup is there, so it was created", async () => {
  const spec = { cluster: { name: "one" }, method: "barmanObjectStore" };
  for (const [what, answer, text] of UNCONFIRMED) {
    await withScript(
      [
        { args: getArgs(C, "one", "pg"), out: clusterOne },
        { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
        { args: CREATE, stdin: manifest("b1", spec), ...answer },
        { args: getArgs(B, "b1", "pg"), out: live("running") },
        { args: getArgs(B, "b1", "pg"), out: live("completed") },
      ],
      { namespace: "pg" },
      async (c, s) => {
        const r = await backup.methods.create.execute(
          args({ name: "b1", cluster: "one" }),
          c.context,
        );
        assertEquals(r.dataHandles.length, 1, what);
        assertEquals(c.written.map((w) => w.name), ["pg--b1"], what);
        const d = c.written[0].data as ReturnType<typeof parseBackup>;
        assertEquals([d.name, d.namespace, d.completed], ["b1", "pg", true]);
        assertEquals(s.slept, [5000], what);
        const warning = c.logs.find((l) => l.includes("was not confirmed"))!;
        assertStringIncludes(warning, text);
        assertStringIncludes(warning, "is taken as created");
        assertFalse(c.logs.some((l) => l === "Backup b1 created"), what);
      },
    );
  }
});

Deno.test("an unconfirmed create whose Backup is not there is the error it was", async () => {
  const spec = { cluster: { name: "one" }, method: "barmanObjectStore" };
  for (const [what, answer, text] of UNCONFIRMED) {
    await withScript(
      [
        { args: getArgs(C, "one", "pg"), out: clusterOne },
        { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
        { args: CREATE, stdin: manifest("b1", spec), ...answer },
        { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
      ],
      { namespace: "pg" },
      async (c, s) => {
        const e = await assertRejects(
          () =>
            backup.methods.create.execute(
              args({ name: "b1", cluster: "one" }),
              c.context,
            ),
          KubectlError,
        );
        assertStringIncludes(e.message, text, what);
        assertEquals(c.written, [], what);
        assertEquals(s.slept, [], what);
      },
    );
  }
});

Deno.test("an unconfirmed create whose Backup asks for something else is refused", async () => {
  const spec = { cluster: { name: "one" }, method: "barmanObjectStore" };
  const other = {
    ...manifest("b1", { cluster: { name: "three" }, method: "plugin" }),
    status: { phase: "running" },
  };
  for (const [what, answer] of UNCONFIRMED) {
    await withScript(
      [
        { args: getArgs(C, "one", "pg"), out: clusterOne },
        { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
        { args: CREATE, stdin: manifest("b1", spec), ...answer },
        { args: getArgs(B, "b1", "pg"), out: other },
      ],
      { namespace: "pg" },
      async (c) => {
        await assertRejects(
          () =>
            backup.methods.create.execute(
              args({ name: "b1", cluster: "one" }),
              c.context,
            ),
          Error,
          "already exists in namespace pg with a different request (cluster, method)",
        );
        assertEquals(c.written, [], what);
      },
    );
  }
});

Deno.test("an unconfirmed create that cannot be read back says both, and a cancelled read ends the run", async () => {
  const spec = { cluster: { name: "one" }, method: "barmanObjectStore" };
  for (
    const [answer, text] of [
      [{ fail: forbidden("get", B, "pg") }, "(Forbidden)"],
      [{ hang: true }, "no answer within 35 seconds"],
      [{ out: {} }, "did not return Backup pg/b1"],
    ] as Array<[Answer, string]>
  ) {
    await withScript(
      [
        { args: getArgs(C, "one", "pg"), out: clusterOne },
        { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
        { args: CREATE, stdin: manifest("b1", spec), out: "created" },
        { args: getArgs(B, "b1", "pg"), ...answer },
      ],
      { namespace: "pg" },
      async (c) => {
        const e = await assertRejects(
          () =>
            backup.methods.create.execute(
              args({ name: "b1", cluster: "one" }),
              c.context,
            ),
          Error,
        );
        assertStringIncludes(e.message, "the create was not confirmed");
        assertStringIncludes(e.message, "did not print JSON");
        assertStringIncludes(e.message, "could not be read back");
        assertStringIncludes(e.message, text);
        assertStringIncludes(e.message, "run get to see whether it exists");
        assertEquals(c.written, []);
      },
    );
  }
  const stop = new AbortController();
  await withScript(
    [
      { args: getArgs(C, "one", "pg"), out: clusterOne },
      { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
      { args: CREATE, stdin: manifest("b1", spec), out: "created" },
    ],
    { namespace: "pg" },
    async (c) => {
      const e = await assertRejects(
        () =>
          backup.methods.create.execute(
            args({ name: "b1", cluster: "one" }),
            c.context,
          ),
        Error,
      );
      assert(isCancelled(e), e.message);
      assertEquals(c.written, []);
    },
    {
      signal: stop.signal,
      handler: () => {
        stop.abort();
        return {};
      },
    },
  );
});

Deno.test("a parameter value is blanked in the error of the create call, a short one is not", async () => {
  const opaque = "zq8Lw0pXv7Rt2KyM";
  const parameters = { opaqueThing: opaque, mode: "on" };
  const spec = {
    cluster: { name: "three" },
    method: "plugin",
    pluginConfiguration: { name: PLUGIN, parameters },
  };
  assert(opaque.length >= OPAQUE_MIN_LENGTH && "on".length < OPAQUE_MIN_LENGTH);
  await withScript(
    [
      { args: getArgs(C, "three", "pg"), out: clusterThree },
      { args: getArgs(B, "p1", "pg"), fail: notFound(B, "p1") },
      {
        args: CREATE,
        stdin: manifest("p1", spec),
        fail:
          `Error from server (Forbidden): admission webhook "vbackup.cnpg.io" denied the request: opaqueThing ${opaque} is not allowed in mode on\n`,
      },
    ],
    { namespace: "pg" },
    async (c) => {
      const e = await assertRejects(
        () =>
          backup.methods.create.execute(
            args({
              name: "p1",
              cluster: "three",
              method: "plugin",
              pluginConfiguration: { name: PLUGIN, parameters },
            }),
            c.context,
          ),
        Error,
      );
      assertFalse(everything(c, e).includes(opaque));
      assertStringIncludes(
        e.message,
        "opaqueThing [redacted] is not allowed in mode on",
      );
      assertStringIncludes(e.message, "denied the request");
    },
  );
});

Deno.test("a Backup that fails is recorded as failed and the method succeeds", async () => {
  const spec = { cluster: { name: "one" }, method: "barmanObjectStore" };
  await withScript(
    [
      { args: getArgs(C, "one", "pg"), out: clusterOne },
      { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
      { args: CREATE, stdin: manifest("b1", spec), out: live() },
      {
        args: getArgs(B, "b1", "pg"),
        out: live("failed", {
          error: `no bucket at https://k:${PLANTED.password}@s3.example.org`,
        }),
      },
    ],
    { namespace: "pg" },
    async (c, s) => {
      const r = await backup.methods.create.execute(
        args({ name: "b1", cluster: "one" }),
        c.context,
      );
      assertEquals(r.dataHandles.length, 1);
      const d = c.written[0].data as ReturnType<typeof parseBackup>;
      assertEquals([d.failed, d.finished, d.completed], [true, true, false]);
      assertEquals(d.error, "no bucket at https://s3.example.org");
      assertEquals(s.slept, [5000]);
      assertStringIncludes(c.logs.at(-1)!, "Backup b1 failed: no bucket");
      noSecret(everything(c));
    },
  );
});

Deno.test("a Backup still running after the wait is recorded as it stands", async () => {
  const spec = { cluster: { name: "one" }, method: "barmanObjectStore" };
  const polls = Array.from({ length: 4 }, () => ({
    args: getArgs(B, "b1", "pg"),
    out: live("running"),
  }));
  await withScript(
    [
      { args: getArgs(C, "one", "pg"), out: clusterOne },
      { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
      { args: CREATE, stdin: manifest("b1", spec), out: live() },
      ...polls,
    ],
    { namespace: "pg" },
    async (c, s) => {
      await backup.methods.create.execute(
        args({ name: "b1", cluster: "one", waitSeconds: 10, pollSeconds: 3 }),
        c.context,
      );
      const d = c.written[0].data as ReturnType<typeof parseBackup>;
      assertEquals([d.phase, d.finished], ["running", false]);
      assertEquals(s.slept, [3000, 3000, 3000, 1000]);
      assertStringIncludes(
        c.logs.at(-1)!,
        "is running after 10 s; run get for the result",
      );
    },
  );
});

Deno.test("waitSeconds 0 records the Backup without reading it again", async () => {
  const spec = { cluster: { name: "one" }, method: "barmanObjectStore" };
  await withScript(
    [
      { args: getArgs(C, "one", "pg"), out: clusterOne },
      { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
      { args: CREATE, stdin: manifest("b1", spec), out: live() },
    ],
    { namespace: "pg" },
    async (c, s) => {
      await backup.methods.create.execute(
        args({ name: "b1", cluster: "one", waitSeconds: 0 }),
        c.context,
      );
      const d = c.written[0].data as ReturnType<typeof parseBackup>;
      assertEquals([d.name, d.phase, d.finished], ["b1", null, false]);
      assertEquals(s.slept, []);
    },
  );
});

Deno.test("a read that fails while waiting does not fail a create that was applied", async () => {
  const spec = { cluster: { name: "one" }, method: "barmanObjectStore" };
  await withScript(
    [
      { args: getArgs(C, "one", "pg"), out: clusterOne },
      { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
      { args: CREATE, stdin: manifest("b1", spec), out: live() },
      { args: getArgs(B, "b1", "pg"), out: live("running") },
      { args: getArgs(B, "b1", "pg"), fail: "Unable to connect to the server" },
    ],
    { namespace: "pg" },
    async (c, s) => {
      const r = await backup.methods.create.execute(
        args({ name: "b1", cluster: "one" }),
        c.context,
      );
      assertEquals(r.dataHandles.length, 1);
      const d = c.written[0].data as ReturnType<typeof parseBackup>;
      assertEquals([d.phase, d.finished], ["running", false]);
      assertEquals(s.slept, [5000, 5000]);
      assert(c.logs.some((l) => l.includes("could not be read while waiting")));
    },
  );
});

Deno.test("a re-run with onlineConfiguration is the same request although the API server filled in a default", async () => {
  // As stored by the API server: the CRD defaults waitForArchive to true.
  const stored = {
    cluster: { name: "one" },
    method: "barmanObjectStore",
    online: true,
    onlineConfiguration: { immediateCheckpoint: true, waitForArchive: true },
  };
  const request = {
    name: "b1",
    cluster: "one",
    online: true,
    onlineConfiguration: { immediateCheckpoint: true },
  };
  assertEquals(specDifferences(stored, desiredSpec(args(request))), []);
  await withScript(
    [
      { args: getArgs(C, "one", "pg"), out: clusterOne },
      {
        args: getArgs(B, "b1", "pg"),
        out: { ...manifest("b1", stored), status: { phase: "completed" } },
      },
    ],
    { namespace: "pg" },
    async (c, s) => {
      await backup.methods.create.execute(args(request), c.context);
      assertEquals(c.written.map((w) => w.name), ["pg--b1"]);
      assertFalse(s.kubectl.some((call) => call.verb === "create"));
    },
  );
});

Deno.test("a nested field is compared only where the request sets it, and a list as a whole", () => {
  const same = (existing: unknown, desired: unknown) =>
    specDifferences(
      existing as Record<string, unknown>,
      desired as Record<string, unknown>,
    );
  const defaulted = {
    cluster: { name: "one" },
    onlineConfiguration: { immediateCheckpoint: true, waitForArchive: true },
  };
  // What the request sets must be equal, at any depth.
  assertEquals(
    same(defaulted, { onlineConfiguration: { waitForArchive: true } }),
    [],
  );
  assertEquals(
    same(defaulted, { onlineConfiguration: { immediateCheckpoint: false } }),
    ["onlineConfiguration"],
  );
  assertEquals(
    same(defaulted, { onlineConfiguration: { waitForArchive: false } }),
    ["onlineConfiguration"],
  );
  assertEquals(
    same({ cluster: { name: "one" } }, {
      onlineConfiguration: { immediateCheckpoint: true },
    }),
    ["onlineConfiguration"],
  );
  assertEquals(
    same({ onlineConfiguration: "yes" }, {
      onlineConfiguration: { immediateCheckpoint: true },
    }),
    ["onlineConfiguration"],
  );
  // Deeper than one level.
  assertEquals(
    same({ x: { y: { z: 1, more: 2 } } }, { x: { y: { z: 1 } } }),
    [],
  );
  assertEquals(same({ x: { y: { z: 1 } } }, { x: { y: { z: 2 } } }), ["x"]);
  // A list is one value: a part of it is not the same request.
  assertEquals(same({ x: { list: [1, 2] } }, { x: { list: [1, 2] } }), []);
  assertEquals(same({ x: { list: [1, 2] } }, { x: { list: [1] } }), ["x"]);
  assertEquals(
    same({ x: { list: [{ a: 1, b: 2 }] } }, {
      x: { list: [{ a: 1 }] },
    }),
    ["x"],
  );
  // A scalar the request sets is never satisfied by an object, or the reverse.
  assertEquals(same({ online: { a: 1 } }, { online: true }), ["online"]);
  assertEquals(same({ online: true }, { online: {} }), ["online"]);
});

Deno.test("an answer that is not the Backup that was asked for is an error and no record", async () => {
  const wrong: unknown[] = [
    [],
    {},
    { kind: "Backup" },
    { ...live("completed"), metadata: { name: "b2", namespace: "pg" } },
    { ...live("completed"), metadata: { name: "b1", namespace: "other" } },
    { ...live("completed"), kind: "Cluster" },
    { kind: "Status", status: "Failure", metadata: {} },
    list([live("completed")]),
  ];
  for (const out of wrong) {
    await withScript(
      [{ args: getArgs(B, "b1", "pg"), out }],
      { namespace: "pg" },
      async (c) => {
        await assertRejects(
          () => backup.methods.get.execute({ name: "b1" }, c.context),
          KubectlError,
          "kubectl did not return Backup pg/b1",
        );
        assertEquals(c.written, [], JSON.stringify(out));
      },
    );
    // create: the Cluster that is checked, and the Backup that may exist.
    await withScript(
      [{ args: getArgs(C, "one", "pg"), out }],
      { namespace: "pg" },
      async (c, s) => {
        await assertRejects(
          () =>
            backup.methods.create.execute(
              args({ name: "b1", cluster: "one" }),
              c.context,
            ),
          KubectlError,
          "kubectl did not return Cluster pg/one",
        );
        assertEquals(c.written, []);
        assertFalse(s.kubectl.some((call) => call.verb === "create"));
      },
    );
    await withScript(
      [
        { args: getArgs(C, "one", "pg"), out: clusterOne },
        { args: getArgs(B, "b1", "pg"), out },
      ],
      { namespace: "pg" },
      async (c, s) => {
        await assertRejects(
          () =>
            backup.methods.create.execute(
              args({ name: "b1", cluster: "one" }),
              c.context,
            ),
          KubectlError,
          "kubectl did not return Backup pg/b1",
        );
        assertEquals(c.written, []);
        assertFalse(s.kubectl.some((call) => call.verb === "create"));
      },
    );
  }
});

Deno.test("an answer that is not the Backup while waiting is a warning, and the last good read stands", async () => {
  await withScript([], { namespace: "pg" }, async (c, k) => {
    await backup.methods.create.execute(
      args({ name: "b1", cluster: "one" }),
      c.context,
    );
    assertEquals(k.slept, [5000, 5000]);
    const d = c.written[0].data as ReturnType<typeof parseBackup>;
    assertEquals([d.name, d.namespace, d.phase], ["b1", "pg", "running"]);
    assert(
      c.logs.some((l) =>
        l.includes("could not be read while waiting") &&
        l.includes("did not return Backup pg/b1")
      ),
    );
  }, {
    handler: flow((n) => n === 1 ? { out: live("running") } : { out: {} }),
  });
});

Deno.test("a Backup has a reason when it failed, or has not ended for too long", () => {
  const HOUR = 3600;
  assertEquals(backupReason(parseBackup(backupCompleted), HOUR), null);
  assertEquals(backupReason(parseBackup(live("running")), HOUR), null);
  assertEquals(backupReason(parseBackup(live()), HOUR), null);
  assertEquals(
    backupReason(parseBackup(backupFailed), HOUR),
    "failed: exit status 4: could not reach https://s3.example.org with Bearer [redacted]",
  );
  assertEquals(
    backupReason(parseBackup(live("failed")), HOUR),
    "failed: the operator gave no error text",
  );
  const long = backupReason(
    parseBackup(
      live("failed", { error: "line one\nline two " + "e".repeat(900) }),
    ),
    HOUR,
  )!;
  assert(long.length <= 203, String(long.length));
  assertFalse(long.includes("\n"));

  // Age: read 7400 s after the object was made.
  const made = "2026-11-10T08:00:00Z";
  const now = Date.parse(made) + 7_400_000;
  const aged = (phase?: string) =>
    parseBackup({
      ...live(phase),
      metadata: { name: "b1", namespace: "pg", creationTimestamp: made },
    }, now);
  assertEquals(aged("running").unfinishedSeconds, 7400);
  assertEquals(aged().unfinishedSeconds, 7400);
  assertEquals(aged("completed").unfinishedSeconds, null);
  assertEquals(aged("failed").unfinishedSeconds, null);
  assertEquals(
    backupReason(aged("running"), HOUR),
    "still running after 7400 s, longer than 3600 s",
  );
  assertEquals(
    backupReason(aged("started"), HOUR),
    "still started after 7400 s, longer than 3600 s",
  );
  assertEquals(
    backupReason(aged(), HOUR),
    "without a phase after 7400 s, longer than 3600 s",
  );
  // Exactly at the threshold is not over it; one second more is.
  assertEquals(backupReason(aged("running"), 7400), null);
  assertEquals(
    backupReason(aged("running"), 7399),
    "still running after 7400 s, longer than 7399 s",
  );
  assertEquals(backupReason(aged("completed"), 1), null);
  // A failed Backup is named as failed however old it is.
  assertStringIncludes(backupReason(aged("failed"), 1)!, "failed: ");
  // No creation time, a broken one, or a clock behind the object: no age.
  assertEquals(parseBackup(live("running"), now).unfinishedSeconds, null);
  assertEquals(
    parseBackup({
      ...live("running"),
      metadata: { name: "b1", creationTimestamp: "yesterday" },
    }, now).unfinishedSeconds,
    null,
  );
  assertEquals(
    parseBackup({
      ...live("running"),
      metadata: { name: "b1", creationTimestamp: made },
    }, Date.parse(made) - 5000).unfinishedSeconds,
    0,
  );
});

Deno.test("list names a Backup that has not ended for longer than the definition allows", async () => {
  const ago = (seconds: number) =>
    new Date(Date.now() - seconds * 1000).toISOString();
  const items = list([
    scheduled("fresh", ago(30), "running"),
    scheduled("stuck", ago(7200), "running"),
    { ...scheduled("mute", ago(7200), "x"), status: {} },
    scheduled("done", ago(7200), "completed"),
  ]);
  const lines = async (globalArgs: Record<string, unknown>) => {
    let found: Array<Record<string, unknown>> = [];
    await withScript(
      [{ args: listCall(B, "pg"), out: items }],
      { namespace: "pg", ...globalArgs },
      async (c) => {
        await backup.methods.list.execute({}, c.context);
        const inv = backup.resources.inventory.schema.strict().parse(
          c.written.at(-1)!.data,
        );
        assertEquals(
          inv.unhealthyCount,
          inv.items.filter((i) => !i.healthy).length,
        );
        found = inv.items;
        // The age is in the record too.
        const stuck = c.written.find((w) => w.name === "pg--stuck")!
          .data as ReturnType<typeof parseBackup>;
        assert(
          stuck.unfinishedSeconds! >= 7200 && stuck.unfinishedSeconds! < 7260,
        );
      },
    );
    return Object.fromEntries(
      found.map((i) => [String(i.name), [i.healthy, i.reason]]),
    ) as Record<string, [unknown, unknown]>;
  };
  // The default is an hour.
  const byDefault = await lines({});
  assertEquals(byDefault.fresh, [true, null]);
  assertEquals(byDefault.done, [true, null]);
  assertEquals(byDefault.stuck[0], false);
  assert(
    /^still running after 72\d\d s, longer than 3600 s$/.test(
      String(byDefault.stuck[1]),
    ),
    String(byDefault.stuck[1]),
  );
  assertEquals(byDefault.mute[0], false);
  assert(
    /^without a phase after 72\d\d s, longer than 3600 s$/.test(
      String(byDefault.mute[1]),
    ),
    String(byDefault.mute[1]),
  );
  // A definition that allows three hours names none; ten seconds names three.
  const patient = await lines({ unfinishedAfterSeconds: 10800 });
  assertEquals(Object.values(patient).map((v) => v[0]), [
    true,
    true,
    true,
    true,
  ]);
  const strict = await lines({ unfinishedAfterSeconds: 10 });
  assertEquals(
    [strict.fresh[0], strict.stuck[0], strict.mute[0], strict.done[0]],
    [false, false, false, true],
  );
});

Deno.test("list writes an inventory that names each failed Backup and why", async () => {
  // Made a minute ago: far younger than the hour after which it is named.
  const running = scheduled(
    "n-2",
    new Date(Date.now() - 60_000).toISOString(),
    "running",
  );
  await withScript(
    [{
      args: listCall(B, "pg"),
      out: list([backupCompleted, backupFailed, running]),
    }],
    { namespace: "pg" },
    async (c) => {
      const r = await backup.methods.list.execute({}, c.context);
      assertEquals(r.dataHandles.length, 4);
      const last = c.written.at(-1)!;
      assertEquals([last.spec, last.name], ["inventory", "inventory_ns_pg"]);
      const inv = backup.resources.inventory.schema.strict().parse(last.data);
      assertEquals(
        [inv.namespace, inv.count, inv.healthyCount, inv.unhealthyCount],
        ["pg", 3, 2, 1],
      );
      assertEquals(inv.items, [
        {
          namespace: "pg",
          name: "manual-1",
          dataName: "pg--manual-1",
          healthy: true,
          reason: null,
          phase: "completed",
        },
        {
          namespace: "pg",
          name: "bad-1",
          dataName: "pg--bad-1",
          healthy: false,
          reason:
            "failed: exit status 4: could not reach https://s3.example.org with Bearer [redacted]",
          phase: "failed",
        },
        // A Backup that still runs has not failed.
        {
          namespace: "pg",
          name: "n-2",
          dataName: "pg--n-2",
          healthy: true,
          reason: null,
          phase: "running",
        },
      ]);
      assertEquals(
        inv.items.map((i) => i.dataName),
        c.written.slice(0, 3).map((w) => w.name),
      );
      noSecret(everything(c));
    },
  );
});

Deno.test("a list of one Cluster's Backups writes no inventory, an empty list writes an empty one", async () => {
  await withScript(
    [{ args: listCall(B, "pg"), out: list([backupCompleted, backupFailed]) }],
    { namespace: "pg" },
    async (c) => {
      const r = await backup.methods.list.execute(
        { cluster: "one" },
        c.context,
      );
      assertEquals(r.dataHandles.length, 1);
      assertEquals(c.written.map((w) => [w.spec, w.name]), [
        ["backup", "pg--manual-1"],
      ]);
      assertStringIncludes(c.logs.at(-1)!, "no inventory");
    },
  );
  await withScript(
    [{ args: listCall(B, ""), out: list([]) }],
    { namespace: "" },
    async (c) => {
      const r = await backup.methods.list.execute({ namespace: "" }, c.context);
      assertEquals(r.dataHandles.length, 1);
      assertEquals(c.written.map((w) => [w.spec, w.name]), [
        ["inventory", "inventory_all"],
      ]);
      const inv = c.written[0].data as Record<string, unknown>;
      assertEquals([inv.namespace, inv.count, inv.items], [null, 0, []]);
    },
  );
});

Deno.test("a list in which two Backups share a data name writes nothing", async () => {
  const named = (namespace: string, name: string) => ({
    ...backupCompleted,
    metadata: { name, namespace },
  });
  await withScript(
    [{
      args: listCall(B, ""),
      out: list([backupCompleted, named("a", "b--c"), named("a--b", "c")]),
    }],
    { namespace: "" },
    async (c) => {
      await assertRejects(
        () => backup.methods.list.execute({}, c.context),
        Error,
        "Backup a/b--c and a--b/c would both be stored as a--b--c",
      );
      assertEquals(c.written, []);
    },
  );
});

/**
 * A fake cluster for `create`: the Cluster exists, the Backup does not, the
 * create is accepted, and `read(n)` answers the nth read of the Backup while
 * waiting. `slow` is how long each call takes on the fake clock.
 */
function flow(
  read: (n: number, k: Fake) => Answer,
  slow: { before?: number; read?: number } = {},
) {
  let reads = 0;
  let created = false;
  return (call: KubectlCall, k: Fake): Answer | undefined => {
    if (!created) k.advance(slow.before ?? 0);
    if (call.verb === "create") {
      created = true;
      return { out: live() };
    }
    if (call.verb !== "get") return undefined;
    if (call.resource === C) return { out: clusterOne };
    if (!created) return { fail: notFound(B, "b1") };
    k.advance(slow.read ?? 0);
    return read(++reads, k);
  };
}

Deno.test("the time the reads take counts as waited", async () => {
  // 20 s asked for, a read every 5 s, each read takes 6 s: two reads fit.
  await withScript([], { namespace: "pg" }, async (c, k) => {
    await backup.methods.create.execute(
      args({ name: "b1", cluster: "one", waitSeconds: 20 }),
      c.context,
    );
    assertEquals(k.slept, [5000, 5000]);
    assertEquals(k.kubectl.filter((x) => x.verb === "get").length, 4);
    assertStringIncludes(
      c.logs.at(-1)!,
      "is running after 22 s; run get for the result",
    );
    assertEquals((c.written[0].data as { finished: boolean }).finished, false);
  }, { handler: flow(() => ({ out: live("running") }), { read: 6000 }) });
});

Deno.test("the longest wait is kept in full when the cluster answers at once", async () => {
  assertFalse(
    CreateArgsSchema.safeParse({
      name: "b",
      cluster: "one",
      waitSeconds: MAX_WAIT_SECONDS + 1,
    }).success,
  );
  await withScript([], { namespace: "pg" }, async (c, k) => {
    await backup.methods.create.execute(
      args({
        name: "b1",
        cluster: "one",
        waitSeconds: MAX_WAIT_SECONDS,
        pollSeconds: 30,
      }),
      c.context,
    );
    assertEquals(k.slept, [30000, 30000, 30000, 30000]);
    assertStringIncludes(c.logs.at(-1)!, "is running after 120 s");
  }, { handler: flow(() => ({ out: live("running") })) });
});

Deno.test("with the longest wait and the slowest cluster, create ends inside its limit", async () => {
  // The limit itself leaves room under 180 s for what swamp does around it.
  assert(CREATE_LIMIT_MS <= 170_000);
  assert(MAX_WAIT_SECONDS * 1000 + KUBECTL_CALL_LIMIT_MS < CREATE_LIMIT_MS);
  // Every call takes as long as a call can: its limit, then being stopped.
  for (const pollSeconds of [1, 5, 30]) {
    let clock = 0;
    const slowest = flow(() => ({ out: live("running") }));
    await withScript([], { namespace: "pg" }, async (c, k) => {
      await backup.methods.create.execute(
        args({
          name: "b1",
          cluster: "one",
          waitSeconds: MAX_WAIT_SECONDS,
          pollSeconds,
        }),
        c.context,
      );
      const total = clock + k.slept.reduce((a, b) => a + b, 0);
      assert(total <= CREATE_LIMIT_MS, `${pollSeconds}: ${total} ms`);
      // Three calls before the wait, then exactly one read fits.
      assertEquals(k.kubectl.length, 4, String(pollSeconds));
      assertEquals(k.slept, [Math.min(pollSeconds * 1000, 14000)]);
      assertEquals(c.written.length, 1);
    }, {
      handler: (call, k) => {
        clock += KUBECTL_CALL_LIMIT_MS;
        k.advance(KUBECTL_CALL_LIMIT_MS);
        return slowest(call, k);
      },
    });
  }
});

Deno.test("when the calls before the wait used the whole limit, the Backup is recorded unread", async () => {
  await withScript([], { namespace: "pg" }, async (c, k) => {
    await backup.methods.create.execute(
      args({ name: "b1", cluster: "one", waitSeconds: MAX_WAIT_SECONDS }),
      c.context,
    );
    assertEquals(k.slept, []);
    assertEquals(k.kubectl.length, 3);
    assertStringIncludes(c.logs.at(-1)!, "after 0 s; run get for the result");
    assertEquals(c.written.length, 1);
  }, {
    handler: flow(() => ({ out: live("completed") }), { before: 60_000 }),
  });
});

Deno.test("a run cancelled while the Backup is read is thrown on, not taken for a slow cluster", async () => {
  const stop = new AbortController();
  await withScript([], { namespace: "pg" }, async (c, k) => {
    const e = await assertRejects(
      () =>
        backup.methods.create.execute(
          args({ name: "b1", cluster: "one" }),
          c.context,
        ),
      KubectlError,
    );
    assertEquals(e.kind, "cancelled");
    assertStringIncludes(e.message, "was cancelled");
    assertEquals(k.slept, [5000, 5000]);
    assertEquals(c.written, []);
    assertFalse(c.logs.some((l) => l.includes("could not be read")));
  }, {
    signal: stop.signal,
    handler: flow((n) => {
      if (n === 2) stop.abort();
      return { out: live("running") };
    }),
  });
});

Deno.test("a run cancelled between two reads ends at the wait", async () => {
  const stop = new AbortController();
  await withScript([], { namespace: "pg" }, async (c, k) => {
    const e = await assertRejects(
      () =>
        backup.methods.create.execute(
          args({ name: "b1", cluster: "one" }),
          c.context,
        ),
      Error,
      "cancelled",
    );
    assert(isCancelled(e), "a cancelled wait is a cancelled run");
    assertEquals(k.slept, [5000]);
    assertEquals(k.kubectl.filter((x) => x.verb === "get").length, 3);
    assertEquals(c.written, []);
  }, {
    signal: stop.signal,
    handler: flow(() => {
      // After this read has been answered, before the next wait begins.
      queueMicrotask(() => stop.abort());
      return { out: live("running") };
    }),
  });
});

Deno.test("a run cancelled before the create makes no Backup", async () => {
  const stop = new AbortController();
  await withScript(
    [{ args: getArgs(C, "one", "pg"), out: clusterOne }],
    { namespace: "pg" },
    async (c, k) => {
      const e = await assertRejects(
        () =>
          backup.methods.create.execute(
            args({ name: "b1", cluster: "one" }),
            c.context,
          ),
        KubectlError,
      );
      assertEquals(e.kind, "cancelled");
      assertFalse(k.kubectl.some((x) => x.verb === "create"));
      assertEquals(c.written, []);
    },
    {
      signal: stop.signal,
      handler: () => {
        stop.abort();
        return {};
      },
    },
  );
});

Deno.test("every other failed read while waiting is a warning with its reason, and the record stands", async () => {
  for (
    const [answer, text] of [
      [{ fail: SAID.badToken }, "did not accept the credentials"],
      [{ fail: SAID.refused }, "could not be reached"],
      [{ hang: true }, "no answer within 35 seconds"],
      [{ fail: notFound(B, "b1") }, '"b1" not found'],
      [{ out: "<html>" }, "did not print JSON"],
    ] as Array<[Answer, string]>
  ) {
    await withScript([], { namespace: "pg" }, async (c, k) => {
      const r = await backup.methods.create.execute(
        args({ name: "b1", cluster: "one" }),
        c.context,
      );
      assertEquals(r.dataHandles.length, 1);
      assertEquals(k.slept, [5000, 5000]);
      const d = c.written[0].data as ReturnType<typeof parseBackup>;
      assertEquals([d.name, d.phase, d.finished], ["b1", "running", false]);
      const warning = c.logs.find((l) =>
        l.includes("could not be read while waiting")
      )!;
      assertStringIncludes(warning, text);
      assertFalse(warning.includes("E1110"));
    }, {
      handler: flow((n) => n === 1 ? { out: live("running") } : answer),
    });
  }
});

Deno.test("plugin parameters are compared as a whole map: fewer or none is another request", () => {
  const same = (existing: unknown, desired: unknown) =>
    specDifferences(
      existing as Record<string, unknown>,
      desired as Record<string, unknown>,
    );
  const plugin = (parameters?: Record<string, string>) => ({
    cluster: { name: "three" },
    method: "plugin",
    pluginConfiguration: parameters === undefined
      ? { name: "p" }
      : { name: "p", parameters },
  });
  const P = ["pluginConfiguration"];
  // Equal maps, whatever the order of the keys.
  assertEquals(
    same(plugin({ a: "1", b: "2" }), plugin({ b: "2", a: "1" })),
    [],
  );
  // None is the same as empty, on either side.
  assertEquals(same(plugin(), plugin()), []);
  assertEquals(same(plugin({}), plugin()), []);
  assertEquals(same(plugin(), plugin({})), []);
  // Fewer, none, more, another value, another key: each is another request.
  assertEquals(same(plugin({ a: "1", b: "2" }), plugin({ a: "1" })), P);
  assertEquals(
    same(plugin({ serverName: "other-server", a: "1" }), plugin()),
    P,
  );
  assertEquals(same(plugin({ a: "1" }), plugin({ a: "1", b: "2" })), P);
  assertEquals(same(plugin({ a: "1" }), plugin({ a: "2" })), P);
  assertEquals(same(plugin({ a: "1" }), plugin({ b: "1" })), P);
  assertEquals(same(plugin(), plugin({ a: "1" })), P);
  // An existing Backup with parameters against a request without any plugin
  // configuration at all is not the same request either.
  assertEquals(
    same(plugin({ a: "1" }), { cluster: { name: "three" }, method: "plugin" }),
    P,
  );
  // The name is still compared, and reported once.
  assertEquals(
    same(plugin({ a: "1" }), {
      ...plugin({ b: "2" }),
      pluginConfiguration: { name: "q", parameters: { b: "2" } },
    }),
    P,
  );
  // What the API server defaults is still compared only where it is set.
  assertEquals(
    same({
      ...plugin({ a: "1" }),
      onlineConfiguration: { immediateCheckpoint: true, waitForArchive: true },
    }, {
      ...plugin({ a: "1" }),
      onlineConfiguration: { immediateCheckpoint: true },
    }),
    [],
  );
});

Deno.test("create does not take over a Backup another caller made with more plugin parameters", async () => {
  const theirs = {
    ...manifest("p1", {
      cluster: { name: "three" },
      method: "plugin",
      pluginConfiguration: {
        name: PLUGIN,
        parameters: { serverName: "other-server" },
      },
    }),
    status: { phase: "completed" },
  };
  const mine = {
    name: "p1",
    cluster: "three",
    method: "plugin",
    pluginConfiguration: { name: PLUGIN },
  };
  const spec = {
    cluster: { name: "three" },
    method: "plugin",
    pluginConfiguration: { name: PLUGIN },
  };
  // Found before the create.
  await withScript(
    [
      { args: getArgs(C, "three", "pg"), out: clusterThree },
      { args: getArgs(B, "p1", "pg"), out: theirs },
    ],
    { namespace: "pg" },
    async (c, s) => {
      await assertRejects(
        () => backup.methods.create.execute(args(mine), c.context),
        Error,
        "already exists in namespace pg with a different request (pluginConfiguration)",
      );
      assertEquals(c.written, []);
      assertFalse(s.kubectl.some((call) => call.verb === "create"));
    },
  );
  // Made by another run between the check and the create.
  await withScript(
    [
      { args: getArgs(C, "three", "pg"), out: clusterThree },
      { args: getArgs(B, "p1", "pg"), fail: notFound(B, "p1") },
      {
        args: CREATE,
        stdin: manifest("p1", spec),
        fail: SAID.alreadyExists(B, "p1"),
      },
      { args: getArgs(B, "p1", "pg"), out: theirs },
    ],
    { namespace: "pg" },
    async (c) => {
      await assertRejects(
        () => backup.methods.create.execute(args(mine), c.context),
        Error,
        "different request (pluginConfiguration)",
      );
      assertEquals(c.written, []);
    },
  );
});

Deno.test("the record of create says whether this run made the Backup or found it", async () => {
  const spec = { cluster: { name: "one" }, method: "barmanObjectStore" };
  const adopted = (c: { written: Array<{ data: unknown }> }) =>
    (c.written[0].data as ReturnType<typeof parseBackup>).adopted;
  // Created and confirmed, read again while waiting: not adopted.
  await withScript(
    [
      { args: getArgs(C, "one", "pg"), out: clusterOne },
      { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
      { args: CREATE, stdin: manifest("b1", spec), out: live() },
      { args: getArgs(B, "b1", "pg"), out: live("completed") },
    ],
    { namespace: "pg" },
    async (c) => {
      await backup.methods.create.execute(
        args({ name: "b1", cluster: "one" }),
        c.context,
      );
      assertEquals(adopted(c), false);
      BackupSchema.strict().parse(c.written[0].data);
    },
  );
  // Already there with the same request: adopted, also after a read.
  for (const first of ["completed", "running"]) {
    await withScript(
      [
        { args: getArgs(C, "one", "pg"), out: clusterOne },
        { args: getArgs(B, "b1", "pg"), out: live(first) },
        ...(first === "running"
          ? [{ args: getArgs(B, "b1", "pg"), out: live("completed") }]
          : []),
      ],
      { namespace: "pg" },
      async (c) => {
        await backup.methods.create.execute(
          args({ name: "b1", cluster: "one" }),
          c.context,
        );
        assertEquals(adopted(c), true, first);
      },
    );
  }
  // Not confirmed and read back, whoever made it: adopted.
  for (const [what, answer] of UNCONFIRMED) {
    await withScript(
      [
        { args: getArgs(C, "one", "pg"), out: clusterOne },
        { args: getArgs(B, "b1", "pg"), fail: notFound(B, "b1") },
        { args: CREATE, stdin: manifest("b1", spec), ...answer },
        { args: getArgs(B, "b1", "pg"), out: live("completed") },
      ],
      { namespace: "pg" },
      async (c) => {
        await backup.methods.create.execute(
          args({ name: "b1", cluster: "one" }),
          c.context,
        );
        assertEquals(adopted(c), true, what);
      },
    );
  }
  // list and get do not know, and say so.
  assertEquals(parseBackup(backupCompleted).adopted, null);
  await withScript(
    [{ args: getArgs(B, "b1", "pg"), out: live("completed") }],
    { namespace: "pg" },
    async (c) => {
      await backup.methods.get.execute({ name: "b1" }, c.context);
      assertEquals(adopted(c), null);
    },
  );
});

Deno.test("the slowest create with a read-back: four calls at their limit, no wait, inside the limit", async () => {
  assert(4 * KUBECTL_CALL_LIMIT_MS <= CREATE_LIMIT_MS);
  for (const pollSeconds of [1, 5, 30]) {
    let clock = 0;
    let reads = 0;
    await withScript([], { namespace: "pg" }, async (c, k) => {
      await backup.methods.create.execute(
        args({
          name: "b1",
          cluster: "one",
          waitSeconds: MAX_WAIT_SECONDS,
          pollSeconds,
        }),
        c.context,
      );
      // The Cluster, the Backup, the create, the read-back: nothing after.
      assertEquals(k.kubectl.map((x) => x.verb), [
        "get",
        "get",
        "create",
        "get",
      ]);
      assertEquals(k.slept, []);
      const total = clock + k.slept.reduce((a, b) => a + b, 0);
      assertEquals(total, 4 * KUBECTL_CALL_LIMIT_MS);
      assert(total <= CREATE_LIMIT_MS, `${total} ms`);
      const d = c.written[0].data as ReturnType<typeof parseBackup>;
      assertEquals([d.name, d.phase, d.finished, d.adopted], [
        "b1",
        "running",
        false,
        true,
      ]);
      assertStringIncludes(c.logs.at(-1)!, "after 0 s; run get for the result");
    }, {
      handler: (call, k) => {
        clock += KUBECTL_CALL_LIMIT_MS;
        k.advance(KUBECTL_CALL_LIMIT_MS);
        // The create is stopped at its limit; the Backup is there all the same.
        if (call.verb === "create") return { hang: true };
        if (call.resource === C) return { out: clusterOne };
        return ++reads === 1
          ? { fail: notFound(B, "b1") }
          : { out: live("running") };
      },
    });
  }
});
