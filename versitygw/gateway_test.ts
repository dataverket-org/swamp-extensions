import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { model } from "./gateway.ts";
import {
  assertNoSecret,
  harness,
  recorded,
  type Reply,
  s3Error,
} from "./test_support.ts";

const m = model.methods;
const ID = "11111111-2222-4333-8444-555555555555";

const xml = (body: string): Reply => ({
  status: 200,
  body: `<?xml version="1.0" encoding="UTF-8"?>\n${body}`,
});

/** The seven settings of one bucket: versioning on, lock on, nothing else. */
function settingsOf(bucket: string): Record<string, Reply> {
  const q = (query: string) => `s3 GET /${bucket}?${query}`;
  return {
    [q("versioning")]: xml(
      "<VersioningConfiguration><Status>Enabled</Status></VersioningConfiguration>",
    ),
    [q("policy")]: s3Error(404, "NoSuchBucketPolicy"),
    [q("acl")]: recorded("bucket-locked-acl"),
    [q("object-lock")]: recorded("bucket-locked-object-lock"),
    [q("ownershipControls")]: s3Error(404, "OwnershipControlsNotFoundError"),
    [q("cors")]: s3Error(404, "NoSuchCORSConfiguration"),
    [q("tagging")]: s3Error(404, "NoSuchTagSet"),
  };
}

// ---------------------------------------------------------------------------
// health
// ---------------------------------------------------------------------------

Deno.test("health records a gateway that answers, unsigned", async () => {
  const h = harness({ "s3 GET /health": { status: 200, body: "OK" } });
  try {
    await m.health.execute({}, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name], ["health", "health"]);
    assertEquals(
      [w.data.reachable, w.data.status, w.data.tls, w.data.error],
      [true, 200, "plain", null],
    );
  } finally {
    h.restore();
  }
});

Deno.test("health records a gateway that does not answer, not a throw", async () => {
  const h = harness({
    "s3 GET /health": new TypeError(
      "error sending request: connection refused",
    ),
  });
  try {
    await m.health.execute({}, h.context);
    const [w] = h.written();
    assertEquals([w.data.reachable, w.data.status], [false, null]);
    assertStringIncludes(String(w.data.error), "connection refused");
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// accounts
// ---------------------------------------------------------------------------

Deno.test("accounts stores each account without its secret", async () => {
  const h = harness({
    "admin PATCH /list-users": recorded("admin-list-users"),
  });
  try {
    await m.accounts.execute({}, h.context);
    const w = h.written();
    assertEquals(w.map((r) => r.name), [
      "account-cnpg-forgejo",
      "account-idle",
      "account-ops",
      "account-restic-zitadel",
    ]);
    assertEquals(w[3].data, {
      access: "restic-zitadel",
      role: "user",
      userId: 1001,
      groupId: 1001,
      projectId: 7,
    });
    assertNoSecret(h);
  } finally {
    h.restore();
  }
});

Deno.test("accounts fails on a refused signature, masks the key and writes nothing", async () => {
  const h = harness({
    "admin PATCH /list-users": recorded("admin-wrong-secret"),
  });
  try {
    const err = await assertRejects(
      () => m.accounts.execute({}, h.context),
      Error,
      "SignatureDoesNotMatch",
    );
    assertEquals(h.written(), []);
    assertNoSecret(h, err);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// buckets
// ---------------------------------------------------------------------------

Deno.test("buckets stores each bucket and its owner, root as root", async () => {
  const h = harness({
    "admin PATCH /list-buckets": recorded("admin-list-buckets"),
  });
  try {
    await m.buckets.execute({}, h.context);
    const w = h.written();
    assertEquals(w.length, 6);
    assertEquals(w[1].name, "bucket-locked");
    assertEquals(w[1].data, { name: "locked", owner: "", ownerIsRoot: true });
    assertEquals(w[2].data, { name: "ops", owner: "ops", ownerIsRoot: false });
    assertNoSecret(h);
  } finally {
    h.restore();
  }
});

Deno.test("buckets fails without a root key and asks for nothing", async () => {
  const h = harness({}, { rootAccessKey: undefined, rootSecretKey: undefined });
  try {
    await assertRejects(() => m.buckets.execute({}, h.context));
    assertEquals(h.seen, []);
    assertEquals(h.written(), []);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// bucketSettings
// ---------------------------------------------------------------------------

Deno.test("bucketSettings reads the named bucket's settings, absent ones as null", async () => {
  const h = harness(settingsOf("locked"));
  try {
    await m.bucketSettings.execute({ buckets: ["locked"] }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name], ["bucketSettings", "settings-locked"]);
    assertEquals(w.data.versioning, "Enabled");
    assertEquals(w.data.objectLock, { enabled: true });
    assertEquals(
      [w.data.policy, w.data.objectOwnership, w.data.cors, w.data.tags],
      [null, null, null, null],
    );
    assertEquals((w.data.acl as { owner: string }).owner, "<root>");
    // the bucket list was given, so the admin API was not asked
    assertEquals(h.seen.some((s) => s.startsWith("admin ")), false);
  } finally {
    h.restore();
  }
});

Deno.test("bucketSettings fails on an error that is not an absent setting, writing nothing", async () => {
  const h = harness({
    ...settingsOf("locked"),
    "s3 GET /locked?policy": s3Error(403, "AccessDenied"),
  });
  try {
    const err = await assertRejects(
      () => m.bucketSettings.execute({ buckets: ["locked"] }, h.context),
      Error,
      "AccessDenied",
    );
    assertEquals(h.written(), []);
    assertNoSecret(h, err);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// inventory
// ---------------------------------------------------------------------------

const INVENTORY_ROUTES: Record<string, Reply> = {
  "s3 GET /health": { status: 200, body: "OK" },
  "admin PATCH /list-users": recorded("admin-list-users"),
  "admin PATCH /list-buckets": xml(
    "<ListBucketsResult><Buckets><Name>locked</Name><Owner>fixtureroot</Owner></Buckets></ListBucketsResult>",
  ),
  ...settingsOf("locked"),
};

Deno.test("inventory writes every record tagged with one inventory id", async () => {
  const h = harness(INVENTORY_ROUTES);
  try {
    await m.inventory.execute({}, h.context);
    const w = h.written();
    assertEquals(w.map((r) => r.spec), [
      "health",
      "account",
      "account",
      "account",
      "account",
      "bucket",
      "bucketSettings",
      "inventory",
    ]);
    const inv = w.at(-1)!.data;
    assertEquals(
      [inv.backend, inv.accounts, inv.buckets, inv.healthy],
      ["versitygw", 4, 1, true],
    );
    assert(/^[0-9a-f-]{36}$/.test(String(inv.inventoryId)));
    assertEquals(
      new Set(w.map((r) => r.tags.inventory)),
      new Set([inv.inventoryId]),
    );
    assertNoSecret(h);
  } finally {
    h.restore();
  }
});

Deno.test("inventory fails as a whole when a bucket list is refused, writing nothing", async () => {
  const h = harness({
    ...INVENTORY_ROUTES,
    "admin PATCH /list-buckets": recorded("admin-not-admin"),
  });
  try {
    const err = await assertRejects(() => m.inventory.execute({}, h.context));
    assertEquals(h.written(), []);
    assertNoSecret(h, err);
  } finally {
    h.restore();
  }
});

// ---------------------------------------------------------------------------
// check: reads records through queryData, which the test stubs; no API call
// ---------------------------------------------------------------------------

function rows(settings: Record<string, unknown>) {
  return [
    {
      name: "inventory",
      specName: "inventory",
      attributes: { inventoryId: ID, accounts: 1, buckets: 1 },
    },
    {
      name: "account-locked",
      specName: "account",
      attributes: {
        access: "locked",
        role: "user",
        userId: 0,
        groupId: 0,
        projectId: 0,
      },
    },
    {
      name: "bucket-locked",
      specName: "bucket",
      attributes: { name: "locked", owner: "locked", ownerIsRoot: false },
    },
    {
      name: "settings-locked",
      specName: "bucketSettings",
      attributes: {
        bucket: "locked",
        policy: null,
        acl: { owner: "<root>", grants: [] },
        objectOwnership: null,
        cors: null,
        tags: null,
        ...settings,
      },
    },
  ];
}

function checkHarness(found: unknown[]) {
  const predicates: string[] = [];
  const h = harness({}, {}, {
    queryData: (predicate: string) => {
      predicates.push(predicate);
      return Promise.resolve(found);
    },
  });
  return { h, predicates };
}

Deno.test("check records a clean inventory and asks for only that inventory", async () => {
  const { h, predicates } = checkHarness(
    rows({
      versioning: "Enabled",
      objectLock: { enabled: true, mode: "GOVERNANCE", days: 1 },
    }),
  );
  try {
    await m.check.execute({ inventoryId: ID }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.tags.inventory], ["check", "check", ID]);
    assertEquals([w.data.clean, w.data.findings], [true, []]);
    assertStringIncludes(predicates[0], `tags.inventory == "${ID}"`);
    assertStringIncludes(predicates[0], 'modelName == "vgw"');
    assertEquals(h.seen, []);
  } finally {
    h.restore();
  }
});

Deno.test("check records a finding, warns, and fails on it when asked to", async () => {
  const { h } = checkHarness(
    rows({ versioning: "Enabled", objectLock: null }),
  );
  try {
    await assertRejects(
      () =>
        m.check.execute({ inventoryId: ID, failOnFindings: true }, h.context),
      Error,
      "findings in inventory",
    );
    const [w] = h.written();
    assertEquals(w.data.clean, false);
    const rules = (w.data.findings as { rule: string }[]).map((f) => f.rule);
    assert(rules.includes("versioning-without-lock"), rules.join(","));
    assert(h.logs().some((l) => l.startsWith("warning: {rule}")));
  } finally {
    h.restore();
  }
});
