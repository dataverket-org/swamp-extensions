import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  backupReason,
  BackupSchema,
  newest,
  parseBackup,
  scheduledBackupOf,
} from "./_backup_record.ts";
import {
  CreateArgsSchema,
  desiredSpec,
  model,
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
import { PLANTED } from "./test_support.ts";
import { forbidden, harness, list, notFound } from "./stub_test.ts";

const PLUGIN = "barman-cloud.cloudnative-pg.io";

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

// ───── the methods, through createModelTestContext with a stub kubectl ─────

const B = "backups.postgresql.cnpg.io";
const C = "clusters.postgresql.cnpg.io";

Deno.test("list records each Backup and an inventory naming the failed one, with no credential", async () => {
  using h = harness({
    [`kubectl get ${B} -n pg`]: {
      stdout: list([backupCompleted, backupFailed]),
    },
  });
  await model.methods.list.execute({ namespace: "pg" }, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [
    ["backup", "pg--manual-1"],
    ["backup", "pg--bad-1"],
    ["inventory", "inventory_ns_pg"],
  ]);
  assertEquals([w[2].data.count, w[2].data.unhealthyCount], [2, 1]);
  noSecret(JSON.stringify([w, h.logs()]));
});

Deno.test("list of one Cluster's Backups records those and no inventory, and says so", async () => {
  using h = harness({
    [`kubectl get ${B} -n pg`]: {
      stdout: list([backupCompleted, backupFailed]),
    },
  });
  await model.methods.list.execute(
    { namespace: "pg", cluster: "one" },
    h.context,
  );
  assertEquals(h.written().map((x) => x.name), ["pg--manual-1"]);
  assert(
    h.logs().includes(
      "Recorded {count} Backups of Cluster {cluster}; no inventory for a list of one Cluster",
    ),
  );
});

Deno.test("list passes on a refused list and records nothing", async () => {
  using h = harness({ [`kubectl get ${B} -A`]: forbidden("list", B) });
  await assertRejects(
    () => model.methods.list.execute({}, h.context),
    Error,
    "forbidden",
  );
  assertEquals(h.written(), []);
});

Deno.test("get records one Backup and logs its phase", async () => {
  using h = harness({
    [`kubectl get ${B} manual-1 -n pg`]: { stdout: backupCompleted },
  });
  await model.methods.get.execute(
    { name: "manual-1", namespace: "pg" },
    h.context,
  );
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [["backup", "pg--manual-1"]]);
  assertEquals([w[0].data.phase, w[0].data.completed], ["completed", true]);
  assert(h.logs().includes("Backup {name} is {phase}"));
  noSecret(JSON.stringify(w));
});

Deno.test("get of an answer that is another object fails and records nothing", async () => {
  using h = harness({
    [`kubectl get ${B} other -n pg`]: { stdout: backupCompleted },
  });
  await assertRejects(
    () =>
      model.methods.get.execute({ name: "other", namespace: "pg" }, h.context),
    Error,
    "did not return Backup pg/other",
  );
  assertEquals(h.written(), []);
});

Deno.test("create sends the Backup on standard input and records it as created", async () => {
  using h = harness({
    [`kubectl get ${C} one -n pg`]: { stdout: clusterOne },
    [`kubectl get ${B} manual-1 -n pg`]: notFound(B, "manual-1"),
    [`kubectl create -f - -n pg`]: { stdout: backupCompleted },
  });
  await model.methods.create.execute(
    args({ name: "manual-1", namespace: "pg", cluster: "one" }),
    h.context,
  );
  assertEquals(JSON.parse(h.calls[2].stdin!), {
    apiVersion: "postgresql.cnpg.io/v1",
    kind: "Backup",
    metadata: { name: "manual-1", namespace: "pg" },
    spec: { cluster: { name: "one" }, method: "barmanObjectStore" },
  });
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [["backup", "pg--manual-1"]]);
  assertEquals([w[0].data.adopted, w[0].data.completed], [false, true]);
  assert(h.logs().includes("Backup {name} created"));
  assert(h.logs().includes("Backup {name} completed"));
});

Deno.test("create of a Backup that exists with the same request creates nothing and records it adopted", async () => {
  using h = harness({
    [`kubectl get ${C} one -n pg`]: { stdout: clusterOne },
    [`kubectl get ${B} manual-1 -n pg`]: { stdout: backupCompleted },
  });
  await model.methods.create.execute(
    args({ name: "manual-1", namespace: "pg", cluster: "one" }),
    h.context,
  );
  assertEquals(h.calls.length, 2);
  assertEquals(h.written()[0].data.adopted, true);
});

Deno.test("create refuses a Cluster without the method's configuration and sends nothing", async () => {
  using h = harness({
    [`kubectl get ${C} nobackup -n pg`]: { stdout: clusterNoBackup },
  });
  await assertRejects(
    () =>
      model.methods.create.execute(
        args({ name: "b1", namespace: "pg", cluster: "nobackup" }),
        h.context,
      ),
    Error,
    "Backup b1 was not created: the Cluster has no spec.backup.barmanObjectStore",
  );
  assertEquals([h.calls.length, h.written().length], [1, 0]);
});

Deno.test("create refuses a missing Cluster", async () => {
  using h = harness({
    [`kubectl get ${C} gone -n pg`]: notFound(C, "gone"),
  });
  await assertRejects(
    () =>
      model.methods.create.execute(
        args({ name: "b1", namespace: "pg", cluster: "gone" }),
        h.context,
      ),
    Error,
    "there is no Cluster gone in namespace pg",
  );
  assertEquals(h.written(), []);
});

Deno.test("create refuses a Backup of the same name with another request", async () => {
  using h = harness({
    [`kubectl get ${C} one -n pg`]: { stdout: clusterOne },
    [`kubectl get ${B} manual-1 -n pg`]: {
      stdout: {
        ...backupCompleted,
        spec: { cluster: { name: "one" }, method: "volumeSnapshot" },
      },
    },
  });
  await assertRejects(
    () =>
      model.methods.create.execute(
        args({ name: "manual-1", namespace: "pg", cluster: "one" }),
        h.context,
      ),
    Error,
    "already exists in namespace pg with a different request (method)",
  );
  assertEquals(h.written(), []);
});
