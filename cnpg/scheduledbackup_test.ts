import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { InventorySchema, KubectlError } from "../lib/kubectl.ts";
import { RESOURCES } from "./_helpers.ts";
import {
  model as scheduledbackup,
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

const S = RESOURCES.scheduledBackup;
const B = RESOURCES.backup;
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

Deno.test("list reads the schedules, then the Backups once", async () => {
  await withScript(
    [
      { args: listCall(S, ""), out: list([nightly]) },
      { args: listCall(B, ""), out: list(backups) },
    ],
    { namespace: "" },
    async (c) => {
      const r = await scheduledbackup.methods.list.execute({}, c.context);
      assertEquals(r.dataHandles.length, 2);
      assertEquals([c.written[1].spec, c.written[1].name], [
        "inventory",
        "inventory_all",
      ]);
      assertEquals([c.written[0].spec, c.written[0].name], [
        "scheduledbackup",
        "pg--nightly",
      ]);
      ScheduledBackupSchema.strict().parse(c.written[0].data);
      for (const v of Object.values(PLANTED)) {
        assertFalse(everything(c).includes(v));
      }
    },
  );
});

Deno.test("list with no schedules does not read the Backups", async () => {
  await withScript(
    [{ args: listCall(S, "other"), out: list([]) }],
    { namespace: "pg" },
    async (c) => {
      const r = await scheduledbackup.methods.list.execute(
        { namespace: "other" },
        c.context,
      );
      assertEquals(r.dataHandles.length, 1);
      assertEquals(c.written.map((w) => [w.spec, w.name]), [
        ["inventory", "inventory_ns_other"],
      ]);
      assertEquals((c.written[0].data as { count: number }).count, 0);
    },
  );
});

Deno.test("get reads one schedule and the Backups of its namespace", async () => {
  await withScript(
    [
      { args: getArgs(S, "nightly", "pg"), out: nightly },
      { args: listCall(B, "pg"), out: list(backups) },
    ],
    { namespace: "pg", kubeconfig: "/tmp/kc" },
    async (c) => {
      await scheduledbackup.methods.get.execute({ name: "nightly" }, c.context);
      assertEquals(c.written[0].name, "pg--nightly");
      assertStringIncludes(
        c.logs.at(-1)!,
        "3 Backups, newest nightly-3 is failed",
      );
    },
  );
});

Deno.test("a broken call fails by name and writes nothing", async () => {
  const first: Array<[Answer, string]> = [
    [{ fail: notFound(S, "nightly") }, '"nightly" not found'],
    [{ fail: forbidden("get", S, "pg") }, "(Forbidden)"],
    [{ out: "oops" }, "did not print JSON (4 characters of output)"],
    [{ hang: true }, "no answer within 35 seconds"],
    [{ fail: SAID.badToken }, "did not accept the credentials"],
    [{ fail: SAID.refused }, "could not be reached"],
  ];
  for (const [answer, text] of first) {
    await withScript(
      [{ args: getArgs(S, "nightly", "pg"), ...answer }],
      { namespace: "pg" },
      async (c) => {
        const e = await assertRejects(
          () =>
            scheduledbackup.methods.get.execute({ name: "nightly" }, c.context),
          Error,
        );
        assertStringIncludes(e.message, text);
        assertEquals(c.written, []);
      },
    );
  }
  const second: Array<[Answer, string]> = [
    [forbiddenList(B, "pg"), "(Forbidden)"],
    [{ out: { items: null } }, "did not return a list"],
    [{ out: list([nightly]) }, 'of kind "ScheduledBackup", not Backup'],
    [{ hang: true }, "no answer within 35 seconds"],
  ];
  for (const [answer, text] of second) {
    await withScript(
      [
        { args: getArgs(S, "nightly", "pg"), out: nightly },
        { args: listCall(B, "pg"), ...answer },
      ],
      { namespace: "pg" },
      async (c) => {
        const e = await assertRejects(
          () =>
            scheduledbackup.methods.get.execute({ name: "nightly" }, c.context),
          Error,
        );
        assertStringIncludes(e.message, text);
        assertEquals(c.written, []);
      },
    );
    await withScript(
      [
        { args: listCall(S, "pg"), out: list([nightly]) },
        { args: listCall(B, "pg"), ...answer },
      ],
      { namespace: "pg" },
      async (c) => {
        await assertRejects(
          () => scheduledbackup.methods.list.execute({}, c.context),
          Error,
          text,
        );
        assertEquals(c.written, []);
      },
    );
  }
  await withScript(
    [{ args: listCall(S, ""), fail: SAID.missingCrd("scheduledbackups") }],
    { namespace: "" },
    async (c) => {
      await assertRejects(
        () => scheduledbackup.methods.list.execute({}, c.context),
        Error,
        "the CRDs that define it are not installed",
      );
      assertEquals(c.written, []);
    },
  );
});

Deno.test("hostile names and namespaces are refused before anything is spawned", async () => {
  for (const bad of HOSTILE) {
    await withScript([], { namespace: "pg" }, async (c, s) => {
      await assertRejects(
        () => scheduledbackup.methods.get.execute({ name: bad }, c.context),
        Error,
        "is not a Kubernetes object name",
      );
      if (bad !== "") {
        await assertRejects(
          () =>
            scheduledbackup.methods.list.execute({ namespace: bad }, c.context),
          Error,
          "is not a Kubernetes namespace name",
        );
      }
      assertEquals(s.calls, []);
    });
  }
  await withScript([], { namespace: "" }, async (c) => {
    await assertRejects(
      () => scheduledbackup.methods.get.execute({ name: "nightly" }, c.context),
      Error,
      "namespace is required for get",
    );
  });
});

Deno.test("an answer that is not the ScheduledBackup that was asked for is an error and no record", async () => {
  const wrong: unknown[] = [
    {},
    [],
    { ...nightly, metadata: { name: "weekly", namespace: "pg" } },
    { ...nightly, metadata: { name: "nightly", namespace: "other" } },
    { ...nightly, kind: "Backup" },
    list([nightly]),
  ];
  for (const out of wrong) {
    await withScript(
      [{ args: getArgs(S, "nightly", "pg"), out }],
      { namespace: "pg" },
      async (c) => {
        await assertRejects(
          () =>
            scheduledbackup.methods.get.execute({ name: "nightly" }, c.context),
          KubectlError,
          "kubectl did not return ScheduledBackup pg/nightly",
        );
        assertEquals(c.written, [], JSON.stringify(out));
      },
    );
  }
});

Deno.test("a schedule whose newest Backup does not end is named once it is older than allowed", async () => {
  const made = "2026-11-10T03:30:00Z";
  const now = Date.parse(made) + 5_000_000;
  const parsed = (phase: string | null, older: unknown[] = []) =>
    parseScheduledBackup(nightly, [
      ...older,
      phase === null
        ? { ...scheduled("nightly-7", made, "x"), status: {} }
        : scheduled("nightly-7", made, phase),
    ] as Record<string, unknown>[], now);
  const running = parsed("running");
  assertEquals(running.lastBackupUnfinishedSeconds, 5000);
  assertEquals(running.lastBackup!.unfinishedSeconds, 5000);
  assertEquals(running.lastBackupCompleted, false);
  ScheduledBackupSchema.strict().parse(running);
  assertEquals(
    scheduleReason(running, 3600),
    "newest Backup nightly-7 is still running after 5000 s, longer than 3600 s",
  );
  assertEquals(
    scheduleReason(parsed(null), 3600),
    "newest Backup nightly-7 is without a phase after 5000 s, longer than 3600 s",
  );
  // Inside what is allowed, and exactly at it: healthy.
  assertEquals(scheduleReason(running, 7200), null);
  assertEquals(scheduleReason(running, 5000), null);
  // A Backup that ended has no age, whatever came before it.
  assertEquals(parsed("completed").lastBackupUnfinishedSeconds, null);
  assertEquals(scheduleReason(parsed("completed"), 1), null);
  // Only the newest counts: an old one that never ended does not.
  const old = scheduled("nightly-1", "2026-11-01T03:30:00Z", "running");
  assertEquals(scheduleReason(parsed("completed", [old]), 3600), null);
  assertEquals(
    parseScheduledBackup(nightly, [], now).lastBackupUnfinishedSeconds,
    null,
  );

  // Through list, with the definition's own threshold.
  const ago = new Date(Date.now() - 600_000).toISOString();
  for (
    const [globalArgs, healthy] of [
      [{}, true],
      [{ unfinishedAfterSeconds: 3600 }, true],
      [{ unfinishedAfterSeconds: 60 }, false],
    ] as Array<[Record<string, unknown>, boolean]>
  ) {
    await withScript(
      [
        { args: listCall(S, "pg"), out: list([nightly]) },
        {
          args: listCall(B, "pg"),
          out: list([scheduled("nightly-8", ago, "running")]),
        },
      ],
      { namespace: "pg", ...globalArgs },
      async (c) => {
        await scheduledbackup.methods.list.execute({}, c.context);
        const inv = InventorySchema.strict().parse(c.written.at(-1)!.data);
        assertEquals(inv.items[0].healthy, healthy);
        assertEquals(inv.unhealthyCount, healthy ? 0 : 1);
        if (healthy) {
          assertEquals(inv.items[0].reason, null);
        } else {
          assert(
            /^newest Backup nightly-8 is still running after 6\d\d s, longer than 60 s$/
              .test(inv.items[0].reason!),
            inv.items[0].reason!,
          );
        }
        const rec = c.written[0].data as {
          lastBackupUnfinishedSeconds: number;
        };
        assert(rec.lastBackupUnfinishedSeconds >= 600);
      },
    );
  }
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

Deno.test("list writes an inventory that names each suspended or failing schedule and why", async () => {
  const named = (name: string, more: Record<string, unknown> = {}) => ({
    ...nightly,
    metadata: { name, namespace: "pg" },
    ...more,
  });
  await withScript(
    [
      {
        args: listCall(S, "pg"),
        out: list([
          nightly,
          named("weekly"),
          named("paused", { spec: { ...nightly.spec, suspend: true } }),
          named("new"),
        ]),
      },
      { args: listCall(B, "pg"), out: list(backups) },
    ],
    { namespace: "pg" },
    async (c) => {
      const r = await scheduledbackup.methods.list.execute({}, c.context);
      assertEquals(r.dataHandles.length, 5);
      const last = c.written.at(-1)!;
      assertEquals([last.spec, last.name], ["inventory", "inventory_ns_pg"]);
      const inv = InventorySchema.strict().parse(last.data);
      assertEquals(
        [inv.namespace, inv.count, inv.healthyCount, inv.unhealthyCount],
        ["pg", 4, 2, 2],
      );
      assertEquals(inv.items, [
        {
          namespace: "pg",
          name: "nightly",
          dataName: "pg--nightly",
          healthy: false,
          reason: FAILED_NIGHTLY,
        },
        {
          namespace: "pg",
          name: "weekly",
          dataName: "pg--weekly",
          healthy: true,
          reason: null,
        },
        {
          namespace: "pg",
          name: "paused",
          dataName: "pg--paused",
          healthy: false,
          reason: "suspended",
        },
        // A schedule that has made no Backup yet is not called failing.
        {
          namespace: "pg",
          name: "new",
          dataName: "pg--new",
          healthy: true,
          reason: null,
        },
      ]);
      assertEquals(
        inv.items.map((i) => i.dataName),
        c.written.slice(0, 4).map((w) => w.name),
      );
      for (const v of Object.values(PLANTED)) {
        assertFalse(everything(c).includes(v));
      }
    },
  );
});

Deno.test("a list in which two schedules share a data name, or one has no name, writes nothing", async () => {
  const named = (namespace: string, name?: string) => ({
    ...nightly,
    metadata: { name, namespace },
  });
  for (
    const [items, text] of [
      [
        [named("a", "b--c"), named("a--b", "c")],
        "would both be stored as a--b--c",
      ],
      [[nightly, named("pg")], "a ScheduledBackup without a name or namespace"],
    ] as Array<[unknown[], string]>
  ) {
    await withScript(
      [{ args: listCall(S, ""), out: list(items) }],
      { namespace: "" },
      async (c) => {
        await assertRejects(
          () => scheduledbackup.methods.list.execute({}, c.context),
          Error,
          text,
        );
        assertEquals(c.written, []);
      },
    );
  }
});

Deno.test("a cancelled run fails as cancelled and writes nothing", async () => {
  const stop = new AbortController();
  await withScript(
    [{ args: listCall(S, "pg"), out: list([nightly]) }],
    { namespace: "pg" },
    async (c) => {
      const e = await assertRejects(
        () => scheduledbackup.methods.list.execute({}, c.context),
        KubectlError,
      );
      assertEquals(e.kind, "cancelled");
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
