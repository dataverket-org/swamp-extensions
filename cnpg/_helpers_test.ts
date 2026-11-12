import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { InventorySchema, kubectlCliCheck } from "../lib/kubectl.ts";
import {
  inventoryResource,
  reasonLine,
  RESOURCES,
  text,
  url,
  VERSION,
  writeInventory,
} from "./_helpers.ts";
import { model as backup } from "./backup.ts";
import { model as cluster } from "./cluster.ts";
import { model as scheduledbackup } from "./scheduledbackup.ts";
import { ctx, PLANTED } from "./test_support.ts";

const MODELS = [cluster, scheduledbackup, backup];

Deno.test("the three types carry the extension's name and one version", () => {
  assertEquals(cluster.type, "@dataverket/cnpg/cluster");
  assertEquals(scheduledbackup.type, "@dataverket/cnpg/scheduledbackup");
  assertEquals(backup.type, "@dataverket/cnpg/backup");
  for (const m of MODELS) {
    assertEquals(m.version, VERSION);
    assertEquals(Object.keys(m.checks), ["kubectl-cli-available"]);
    assertEquals(m.checks["kubectl-cli-available"], kubectlCliCheck);
  }
});

Deno.test("the global arguments are the shared three, and the age limit where Backups are judged", () => {
  assertEquals(cluster.globalArguments.parse({}), { namespace: "" });
  assertEquals(
    Object.keys(cluster.globalArguments.shape).sort(),
    ["context", "kubeconfig", "namespace"],
  );
  for (const m of [backup, scheduledbackup]) {
    assertEquals(m.globalArguments.parse({}), {
      namespace: "",
      unfinishedAfterSeconds: 3600,
    });
    assertEquals(
      Object.keys(m.globalArguments.shape).sort(),
      ["context", "kubeconfig", "namespace", "unfinishedAfterSeconds"],
    );
    for (const bad of [0, -1, 1.5, "60"]) {
      assertFalse(
        m.globalArguments.safeParse({ unfinishedAfterSeconds: bad }).success,
        String(bad),
      );
    }
    assertEquals(
      m.globalArguments.parse({ unfinishedAfterSeconds: 60 })
        .unfinishedAfterSeconds,
      60,
    );
  }
});

Deno.test("the methods, and only create is an action", () => {
  assertEquals(Object.keys(cluster.methods), ["list", "get"]);
  assertEquals(Object.keys(scheduledbackup.methods), ["list", "get"]);
  assertEquals(Object.keys(backup.methods), ["list", "get", "create"]);
  assertEquals(backup.methods.create.kind, "action");
  for (const m of MODELS) {
    for (const name of ["list", "get"] as const) {
      assertFalse("kind" in m.methods[name], `${m.type} ${name}`);
    }
  }
});

Deno.test("every type has its record and an inventory, kept forever with ten versions", () => {
  assertEquals(Object.keys(cluster.resources), ["cluster", "inventory"]);
  assertEquals(Object.keys(scheduledbackup.resources), [
    "scheduledbackup",
    "inventory",
  ]);
  assertEquals(Object.keys(backup.resources), ["backup", "inventory"]);
  for (const m of MODELS) {
    for (const spec of Object.values(m.resources)) {
      assertEquals(spec.lifetime, "infinite");
      assertEquals(spec.garbageCollection, 10);
    }
  }
});

Deno.test("the inventory resource is the shared schema unless a type extends it", () => {
  const plain = inventoryResource("Thing");
  assertEquals(plain.schema, InventorySchema);
  assertStringIncludes(plain.description, "every Thing");
  assertStringIncludes(plain.description, "inventory_ns_<namespace>");
  assertEquals(scheduledbackup.resources.inventory.schema, InventorySchema);
  assert(cluster.resources.inventory.schema !== InventorySchema);
  assert(backup.resources.inventory.schema !== InventorySchema);
});

Deno.test("the resources are named by their full group", () => {
  for (const r of Object.values(RESOURCES)) {
    assert(/^[a-z]+\.(postgresql|barmancloud)\.cnpg\.io$/.test(r), r);
  }
});

Deno.test("a stored URL loses its user and password, and nothing else", () => {
  assertEquals(url("s3://bucket/path"), "s3://bucket/path");
  assertEquals(url("http://s3.pg.svc:7070"), "http://s3.pg.svc:7070");
  assertEquals(
    url(`https://key:${PLANTED.password}@s3.example.org/x`),
    "https://s3.example.org/x",
  );
  for (const v of ["", null, undefined, 7, {}, []]) assertEquals(url(v), null);
});

Deno.test("a reason is one bounded line without a credential", () => {
  assertEquals(reasonLine(["a", "b\n  c"]), "a; b c");
  const long = reasonLine([
    `failed against https://k:${PLANTED.password}@s3.example.org`,
    `Authorization: Bearer ${PLANTED.token}`,
    "x".repeat(500),
  ]);
  assert(long.length <= 203, String(long.length));
  assertFalse(long.includes(PLANTED.password));
  assertFalse(long.includes(PLANTED.token));
  assertFalse(long.includes("\n"));
});

Deno.test("an inventory is written under the spec inventory with the shared names", async () => {
  const items = [
    {
      namespace: "pg",
      name: "a",
      dataName: "pg--a",
      healthy: true,
      reason: null,
    },
    {
      namespace: "pg",
      name: "b",
      dataName: "pg--b",
      healthy: false,
      reason: "broken",
    },
  ];
  for (
    const [ns, name, stored] of [
      ["", "inventory_all", null],
      ["pg", "inventory_ns_pg", "pg"],
    ] as const
  ) {
    const c = ctx({ namespace: "" });
    const before = Date.now();
    await writeInventory(c.context, "Thing", ns, items);
    assertEquals(c.written.length, 1);
    assertEquals([c.written[0].spec, c.written[0].name], ["inventory", name]);
    const d = InventorySchema.strict().parse(c.written[0].data);
    assertEquals(
      [d.namespace, d.count, d.healthyCount, d.unhealthyCount],
      [stored, 2, 1, 1],
    );
    assertEquals(d.items, items);
    assert(Date.parse(d.observedAt) >= before);
    assertStringIncludes(c.logs[0], "Recorded 2 Thing objects");
    assertStringIncludes(c.logs[0], "1 not healthy");
  }
});

Deno.test("stored free text is one bounded line without a credential, or null", () => {
  assertEquals(text("a\n  b"), "a b");
  assertEquals(text("x".repeat(500))!.length, 403);
  assertEquals(text("x".repeat(500), 10), "x".repeat(10) + "...");
  assertEquals(
    text(
      `failed at https://u:${PLANTED.password}@h with Bearer ${PLANTED.token}`,
    ),
    "failed at https://h with Bearer [redacted]",
  );
  for (const v of ["", null, undefined, 7, {}, []]) assertEquals(text(v), null);
});
