import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
} from "jsr:@std/assert@1.0.13";
import {
  model,
  parseScheduledBackup,
  ScheduledBackupSchema,
  scheduleReason,
} from "./scheduledbackup.ts";
import {
  backupCompleted,
  backupFailed,
  nightly,
  scheduled,
} from "./fixtures.ts";
import { PLANTED } from "./test_support.ts";
import { forbidden, harness, list, notFound } from "./stub_test.ts";

const FAILED_NIGHTLY =
  "newest Backup nightly-3 failed: the operator gave no error text";

const backups = [
  backupCompleted,
  scheduled("nightly-1", "2026-11-08T03:30:00Z", "completed"),
  scheduled("nightly-3", "2026-11-10T03:30:00Z", "failed"),
  scheduled("nightly-2", "2026-11-09T03:30:00Z", "completed"),
  scheduled("weekly-9", "2026-11-11T03:30:00Z", "completed", "weekly"),
  scheduled(
    "nightly-9",
    "2026-11-12T03:30:00Z",
    "completed",
    "nightly",
    "elsewhere",
  ),
];

Deno.test("a ScheduledBackup is read with the newest Backup it made", () => {
  const r = parseScheduledBackup(nightly, backups);
  ScheduledBackupSchema.strict().parse(r);
  assertEquals({ ...r, lastBackup: r.lastBackup?.name }, {
    name: "nightly",
    namespace: "pg",
    cluster: "three",
    schedule: "0 30 3 * * *",
    suspend: false,
    immediate: true,
    backupOwnerReference: "self",
    method: "plugin",
    target: null,
    online: null,
    pluginName: "barman-cloud.cloudnative-pg.io",
    lastScheduleTime: "2026-11-10T09:50:00Z",
    nextScheduleTime: "2026-11-11T03:30:00Z",
    lastCheckTime: "2026-11-10T09:50:00Z",
    error: null,
    backupCount: 3,
    lastBackup: "nightly-3",
    lastBackupPhase: "failed",
    lastBackupCompleted: false,
    lastBackupUnfinishedSeconds: null,
  });
  assertEquals(r.lastBackup!.failed, true);
  assertEquals(r.lastBackup!.scheduledBackup, "nightly");
});

Deno.test("Backups of another schedule or another namespace are not counted", () => {
  const r = parseScheduledBackup(nightly, [
    backups[4],
    backups[5],
    backupFailed,
  ]);
  assertEquals(r.backupCount, 0);
  assertEquals(r.lastBackup, null);
  assertEquals(r.lastBackupPhase, null);
  assertEquals(r.lastBackupCompleted, false);
});

Deno.test("a Backup is matched by owner reference when it has no label", () => {
  const owned = {
    metadata: {
      name: "owned-1",
      namespace: "pg",
      creationTimestamp: "2026-11-10T03:30:00Z",
      ownerReferences: [{ kind: "ScheduledBackup", name: "nightly" }],
    },
    spec: { cluster: { name: "three" } },
    status: { phase: "completed" },
  };
  const r = parseScheduledBackup(nightly, [owned]);
  assertEquals(r.lastBackup?.name, "owned-1");
  assertEquals(r.lastBackupCompleted, true);
});

Deno.test("a suspended, empty or malformed ScheduledBackup still parses", () => {
  const shapes: unknown[] = [
    {},
    { metadata: null, spec: null, status: null },
    {
      metadata: { name: "s", namespace: "pg" },
      spec: { suspend: true, schedule: 5 },
    },
    {
      metadata: { name: "s", namespace: "pg" },
      spec: {
        cluster: "x",
        pluginConfiguration: [],
        suspend: "yes",
        immediate: 1,
      },
      status: {
        lastScheduleTime: 7,
        error: `bad schedule at https://u:${PLANTED.password}@example.org`,
      },
    },
  ];
  for (const s of shapes) {
    const r = parseScheduledBackup(
      s as Record<string, unknown>,
      [null, "x", {}] as never,
    );
    ScheduledBackupSchema.strict().parse(r);
    assertEquals(r.lastBackup, null);
    assertFalse(JSON.stringify(r).includes(PLANTED.password));
  }
  assertEquals(
    parseScheduledBackup(shapes[2] as Record<string, unknown>, []).suspend,
    true,
  );
  const last = parseScheduledBackup(shapes[3] as Record<string, unknown>, []);
  assertEquals([last.suspend, last.immediate], [false, false]);
  assertEquals(last.error, "bad schedule at https://example.org");
});

Deno.test("a schedule is unhealthy when suspended, in error, or when its newest Backup failed", () => {
  const reason = (item: unknown, made: unknown[] = []) =>
    scheduleReason(
      parseScheduledBackup(
        item as Record<string, unknown>,
        made as Record<string, unknown>[],
      ),
      3600,
    );
  assertEquals(reason(nightly), null);
  assertEquals(
    reason(nightly, [
      scheduled("nightly-1", "2026-11-08T03:30:00Z", "failed"),
      scheduled("nightly-2", "2026-11-09T03:30:00Z", "completed"),
    ]),
    null,
  );
  assertEquals(reason(nightly, backups), FAILED_NIGHTLY);
  assertEquals(
    reason({ ...nightly, spec: { ...nightly.spec, suspend: true } }),
    "suspended",
  );
  const all = reason({
    ...nightly,
    spec: { ...nightly.spec, suspend: true },
    status: {
      error: `cannot parse the schedule\nsee https://u:${PLANTED.password}@x`,
    },
  }, [{
    ...scheduled("nightly-4", "2026-11-13T03:30:00Z", "failed"),
    status: {
      phase: "failed",
      error: `exit status 4 with Bearer ${PLANTED.token} ` + "x".repeat(400),
    },
  }])!;
  assert(
    all.startsWith(
      "suspended; schedule error: cannot parse the schedule see https://x; newest Backup nightly-4 failed: exit status 4 with Bearer [redacted]",
    ),
    all,
  );
  assert(all.length <= 203, String(all.length));
  assertFalse(all.includes("\n"));
  for (const v of Object.values(PLANTED)) assertFalse(all.includes(v));
});

// ───── the methods, through createModelTestContext with a stub kubectl ─────

const SB = "scheduledbackups.postgresql.cnpg.io";
const B = "backups.postgresql.cnpg.io";
const inPg = backups.slice(0, 5);

Deno.test("list records each ScheduledBackup with its newest Backup, and an inventory naming the failing one", async () => {
  using h = harness({
    [`kubectl get ${SB} -n pg`]: { stdout: list([nightly]) },
    [`kubectl get ${B} -n pg`]: { stdout: list(inPg) },
  }, { globalArgs: { namespace: "pg" } });
  await model.methods.list.execute({}, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [
    ["scheduledbackup", "pg--nightly"],
    ["inventory", "inventory_ns_pg"],
  ]);
  assertEquals(w[0].data.lastBackupPhase, "failed");
  const inv = w[1].data as {
    unhealthyCount: number;
    items: { reason: string | null }[];
  };
  assertEquals(inv.unhealthyCount, 1);
  assertEquals(inv.items[0].reason, FAILED_NIGHTLY);
  assert(h.logs().some((l) => l.startsWith("Recorded {count}")));
});

Deno.test("list of no ScheduledBackups reads no Backups and records an empty inventory", async () => {
  using h = harness({ [`kubectl get ${SB} -A`]: { stdout: list([]) } });
  await model.methods.list.execute({}, h.context);
  assertEquals(h.calls.length, 1);
  assertEquals(h.written().map((x) => [x.name, x.data.count]), [
    ["inventory_all", 0],
  ]);
});

Deno.test("list passes on a refused Backup list and records nothing", async () => {
  using h = harness({
    [`kubectl get ${SB} -n pg`]: { stdout: list([nightly]) },
    [`kubectl get ${B} -n pg`]: forbidden("list", B),
  });
  await assertRejects(
    () => model.methods.list.execute({ namespace: "pg" }, h.context),
    Error,
    "forbidden",
  );
  assertEquals(h.written(), []);
});

Deno.test("get records one ScheduledBackup and logs its newest Backup", async () => {
  using h = harness({
    [`kubectl get ${SB} nightly -n pg`]: { stdout: nightly },
    [`kubectl get ${B} -n pg`]: { stdout: list(inPg) },
  });
  await model.methods.get.execute(
    { name: "nightly", namespace: "pg" },
    h.context,
  );
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [[
    "scheduledbackup",
    "pg--nightly",
  ]]);
  assertEquals([w[0].data.backupCount, w[0].data.schedule], [
    3,
    "0 30 3 * * *",
  ]);
  assert(
    h.logs().includes(
      "ScheduledBackup {name}: {count} Backups, newest {backup} is {phase}",
    ),
  );
});

Deno.test("get of a missing ScheduledBackup fails and records nothing", async () => {
  using h = harness({
    [`kubectl get ${SB} gone -n pg`]: notFound(SB, "gone"),
  });
  await assertRejects(
    () =>
      model.methods.get.execute({ name: "gone", namespace: "pg" }, h.context),
    Error,
    "not found",
  );
  assertEquals(h.written(), []);
});
