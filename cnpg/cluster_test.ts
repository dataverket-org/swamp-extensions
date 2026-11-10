import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { KubectlError } from "../lib/kubectl.ts";
import { RESOURCES } from "./_helpers.ts";
import {
  clusterReason,
  ClusterSchema,
  missingObjectStore,
  model as cluster,
  objectStoreRef,
  parseCluster,
  parseObjectStore,
} from "./cluster.ts";
import {
  clusterFailingOver,
  clusterFenced,
  clusterHibernated,
  clusterLoaded,
  clusterMoved,
  clusterNoBackup,
  clusterOne,
  clusterThree,
  objectStore,
  objectStoreLoaded,
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

const MISSING_CRD = "the CRDs that define it are not installed";

const C = RESOURCES.cluster;
const O = RESOURCES.objectStore;

function noSecret(text: string): void {
  for (const v of Object.values(PLANTED)) {
    assertFalse(text.includes(v), `${v} leaked`);
  }
}

Deno.test("a healthy Cluster with the in-tree method is read in full", () => {
  const r = parseCluster(clusterOne);
  ClusterSchema.strict().parse(r);
  assertEquals(r.name, "one");
  assertEquals(r.namespace, "pg");
  assertEquals(r.phase, "Cluster in healthy state");
  assertEquals(r.phaseReason, null);
  assertEquals([r.instances, r.readyInstances], [1, 1]);
  assertEquals([r.currentPrimary, r.targetPrimary], ["one-1", "one-1"]);
  assertEquals(r.timelineId, 1);
  assertEquals(r.instanceStates, [
    { name: "one-1", status: "healthy", isPrimary: true, timelineId: 1 },
  ]);
  assertEquals(
    r.image,
    "ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie",
  );
  assertEquals([r.postgresMajor, r.postgresVersion], [18, "18.6"]);
  assertEquals([r.storageSize, r.storageClass], ["1Gi", "standard"]);
  assertEquals([r.walStorageSize, r.walStorageClass], ["512Mi", null]);
  assertEquals(r.conditions.map((c) => `${c.type}=${c.status}`), [
    "Ready=True",
    "ContinuousArchiving=True",
    "LastBackupSucceeded=True",
  ]);
  assertEquals(r.archive, {
    firstRecoverabilityPoint: "2026-11-10T09:44:10Z",
    lastSuccessfulBackup: "2026-11-10T09:44:12Z",
    lastFailedBackup: null,
    source: "clusterStatus",
  });
  assertEquals(r.backup, {
    configured: true,
    methods: ["barmanObjectStore"],
    walArchiver: "barmanObjectStore",
    retentionPolicy: "7d",
    target: "prefer-standby",
    barmanObjectStore: {
      destinationPath: "s3://one/",
      endpointURL: "http://s3.pg.svc:7070",
      serverName: "one-v2",
    },
    volumeSnapshot: null,
    plugins: [],
    objectStore: null,
  });
  assertEquals(r.summary, {
    healthy: true,
    archiving: true,
    primaryChanging: false,
    instancesReady: true,
  });
});

Deno.test("no credential reference, URL password or plugin parameter value is stored", () => {
  for (
    const r of [
      parseCluster(clusterOne),
      parseCluster(clusterThree, parseObjectStore(objectStore, "three")),
    ]
  ) {
    noSecret(JSON.stringify(r));
  }
  const p = parseCluster(clusterThree).backup.plugins[0];
  assertEquals(p.parameterNames, ["barmanObjectName", "somethingElse"]);
});

Deno.test("a marker in every credential-bearing field of a Cluster and its ObjectStore reaches no record", () => {
  // The fixture is only a test when the markers are really in it.
  const raw = JSON.stringify([clusterLoaded, objectStoreLoaded]);
  for (
    const field of [
      "superuserSecret",
      "postInitSQL",
      "postInitApplicationSQL",
      "externalClusters",
      "connectionParameters",
      "sslKey",
      "env",
      "envFrom",
      "passwordSecret",
      "endpointCA",
      "azureCredentials",
      "googleCredentials",
      "s3Credentials",
      "serverTLSSecret",
      "last-applied-configuration",
      "phaseReason",
      "pluginStatus",
    ]
  ) {
    assertStringIncludes(raw, field);
  }
  for (const v of Object.values(PLANTED)) {
    if (v !== PLANTED.commandOutput) assertStringIncludes(raw, v);
  }
  const records = [
    parseCluster(clusterLoaded),
    parseCluster(clusterLoaded, parseObjectStore(objectStoreLoaded, "one")),
    parseObjectStore(objectStoreLoaded, "three"),
  ];
  for (const r of records) {
    const stored = JSON.stringify(r);
    noSecret(stored);
    for (
      const field of [
        "Secret",
        "Credentials",
        "endpointCA",
        "postInit",
        "connectionParameters",
        "sslKey",
        "last-applied",
        "streaming_replica",
        "ALTER ROLE",
      ]
    ) {
      assertFalse(stored.includes(field), field);
    }
  }
  const r = parseCluster(clusterLoaded);
  ClusterSchema.strict().parse(r);
  // What is kept of the free text: cleaned, on one line.
  assertEquals(
    r.phaseReason,
    "could not reach https://db.example.org Authorization: [redacted]",
  );
  assertEquals(
    r.backup.plugins[0].status,
    "rpc error: token=[redacted] at https://s3.example.org",
  );
  assertEquals(r.backup.plugins[0].parameterNames, [
    "apiKey",
    "barmanObjectName",
  ]);
  assertEquals(r.backup.plugins[0].barmanObjectName, "store");
  const why = clusterReason({
    ...r,
    phase: "broken",
    summary: { ...r.summary, healthy: false },
  })!;
  assertStringIncludes(why, "phase broken (could not reach");
  noSecret(why);
});

Deno.test("free text from the operator and the plugin is stored on one bounded line", () => {
  const item = structuredClone(clusterThree) as Record<string, unknown>;
  const status = item.status as Record<string, unknown>;
  status.phase = "Waiting\nfor  the instances";
  status.phaseReason = "r".repeat(2000);
  status.pluginStatus = [{
    name: "barman-cloud.cloudnative-pg.io",
    status: "line one\nline two " + "s".repeat(2000),
  }];
  const r = parseCluster(item);
  assertEquals(r.phase, "Waiting for the instances");
  assertEquals(r.phaseReason!.length, 403);
  assertEquals(r.backup.plugins[0].status!.length, 403);
  assertFalse(r.backup.plugins[0].status!.includes("\n"));
  // The healthy phase still reads as healthy, and an empty status stays empty.
  assertEquals(parseCluster(clusterOne).summary.healthy, true);
  status.pluginStatus = [{
    name: "barman-cloud.cloudnative-pg.io",
    status: "",
  }];
  assertEquals(parseCluster(item).backup.plugins[0].status, "");
});

Deno.test("a plugin Cluster takes its archive times from the ObjectStore", () => {
  const ref = objectStoreRef(clusterThree);
  assertEquals(ref, { name: "store", serverName: "three" });
  const r = parseCluster(clusterThree, parseObjectStore(objectStore, "three"));
  ClusterSchema.strict().parse(r);
  assertEquals(r.archive, {
    firstRecoverabilityPoint: "2026-11-10T09:50:00Z",
    lastSuccessfulBackup: "2026-11-10T09:50:05Z",
    lastFailedBackup: null,
    source: "objectStore",
  });
  assertEquals(r.backup.methods, ["plugin"]);
  assertEquals(r.backup.walArchiver, "barman-cloud.cloudnative-pg.io");
  assertEquals(r.backup.retentionPolicy, "14d");
  assertEquals(r.backup.barmanObjectStore, null);
  assertEquals(r.backup.objectStore, {
    name: "store",
    found: true,
    error: null,
    destinationPath: "s3://three/",
    endpointURL: "http://s3.pg.svc:7070",
    retentionPolicy: "14d",
    serverName: "three",
  });
  assertEquals(r.backup.plugins, [
    {
      name: "barman-cloud.cloudnative-pg.io",
      enabled: true,
      isWALArchiver: true,
      barmanObjectName: "store",
      serverName: null,
      parameterNames: ["barmanObjectName", "somethingElse"],
      version: "0.15.1",
      status: null,
    },
    {
      name: "other.example.org",
      enabled: false,
      isWALArchiver: false,
      barmanObjectName: null,
      serverName: null,
      parameterNames: [],
      version: null,
      status: null,
    },
  ]);
  assertEquals(r.instanceStates.map((i) => [i.name, i.isPrimary]), [
    ["three-1", true],
    ["three-2", false],
    ["three-3", false],
  ]);
  assertEquals(r.summary.healthy, true);
  assertEquals(r.summary.archiving, true);
});

Deno.test("the recovery window is the one of the plugin's serverName", () => {
  const item = structuredClone(clusterThree);
  (item.spec.plugins[0].parameters as Record<string, string>).serverName =
    "another";
  assertEquals(objectStoreRef(item), { name: "store", serverName: "another" });
  const r = parseCluster(item, parseObjectStore(objectStore, "another"));
  assertEquals(r.archive, {
    firstRecoverabilityPoint: null,
    lastSuccessfulBackup: null,
    lastFailedBackup: "2026-11-01T00:00:00Z",
    source: "objectStore",
  });
  assertEquals(r.backup.plugins[0].serverName, "another");
});

Deno.test("an ObjectStore without a window for the server leaves the times null", () => {
  const r = parseCluster(
    clusterThree,
    parseObjectStore(objectStore, "unknown-server"),
  );
  assertEquals(r.archive.source, "none");
  assertEquals(r.archive.lastSuccessfulBackup, null);
  assertEquals(r.backup.objectStore?.found, true);
});

Deno.test("a disabled plugin is not a backup method and names no ObjectStore", () => {
  const item = structuredClone(clusterThree);
  (item.spec.plugins[0] as Record<string, unknown>).enabled = false;
  assertEquals(objectStoreRef(item), null);
  const r = parseCluster(item);
  assertEquals(r.backup.configured, false);
  assertEquals(r.backup.methods, []);
  assertEquals(r.backup.walArchiver, null);
  assertEquals(r.summary.archiving, false);
});

Deno.test("a failover is a record: primary changing, not healthy, not ready", () => {
  const r = parseCluster(clusterFailingOver);
  ClusterSchema.strict().parse(r);
  assertEquals(r.phase, "Failing over");
  assertEquals(r.phaseReason, "Failing over from three-1 to three-2");
  assertEquals([r.currentPrimary, r.targetPrimary], ["three-1", "three-2"]);
  assertEquals(r.currentPrimaryFailingSince, "2026-11-10T10:00:00Z");
  assertEquals(r.instanceStates, [
    { name: "three-1", status: "failed", isPrimary: null, timelineId: null },
    { name: "three-2", status: "healthy", isPrimary: false, timelineId: 1 },
    { name: "three-3", status: "healthy", isPrimary: false, timelineId: 1 },
  ]);
  assertEquals(r.summary, {
    healthy: false,
    archiving: false,
    primaryChanging: true,
    instancesReady: false,
  });
});

Deno.test("a target primary of 'pending' is a primary change too", () => {
  const item = structuredClone(clusterOne);
  item.status.targetPrimary = "pending";
  const r = parseCluster(item);
  assertEquals(r.summary.primaryChanging, true);
  assertEquals(r.summary.healthy, false);
});

Deno.test("archiving needs an archiver: the condition alone is not enough", () => {
  const item = structuredClone(clusterNoBackup) as Record<string, unknown>;
  (item.status as { conditions: unknown[] }).conditions.push({
    type: "ContinuousArchiving",
    status: "True",
  });
  const r = parseCluster(item);
  assertEquals(r.backup.configured, false);
  assertEquals(r.summary.archiving, false);
  assertEquals(r.summary.healthy, true);
});

Deno.test("a failing archiver is healthy but not archiving", () => {
  const item = structuredClone(clusterOne);
  item.status.conditions[1].status = "False";
  const r = parseCluster(item);
  assertEquals(r.summary.healthy, true);
  assertEquals(r.summary.archiving, false);
});

Deno.test("healthy needs the phase, Ready, every instance and a settled primary", () => {
  const variants: Array<(s: typeof clusterOne.status) => void> = [
    (s) => s.phase = "Upgrading cluster",
    (s) => s.conditions[0].status = "False",
    (s) => s.readyInstances = 0,
    (s) => s.targetPrimary = "one-2",
  ];
  for (const change of variants) {
    const item = structuredClone(clusterOne);
    change(item.status);
    assertEquals(parseCluster(item).summary.healthy, false);
  }
  const zero = structuredClone(clusterOne);
  zero.spec.instances = 0;
  zero.status.readyInstances = 0;
  assertEquals(parseCluster(zero).summary.instancesReady, false);
});

Deno.test("volumeSnapshot configuration and an image catalog are read", () => {
  const r = parseCluster({
    metadata: { name: "snap", namespace: "pg" },
    spec: {
      instances: 2,
      imageCatalogRef: { kind: "ClusterImageCatalog", name: "pg", major: 17 },
      backup: {
        volumeSnapshot: { className: "csi-snap", walClassName: "csi-wal" },
      },
    },
  });
  assertEquals(r.imageCatalog, "ClusterImageCatalog/pg");
  assertEquals(r.postgresMajor, 17);
  assertEquals(r.image, null);
  assertEquals(r.postgresVersion, null);
  assertEquals(r.backup.methods, ["volumeSnapshot"]);
  assertEquals(r.backup.volumeSnapshot, {
    className: "csi-snap",
    walClassName: "csi-wal",
  });
  assertEquals(r.backup.walArchiver, null);
});

Deno.test("the PostgreSQL version comes from the tag, never from a digest or a port", () => {
  const v = (imageName: string) =>
    parseCluster({ spec: { imageName } }).postgresVersion;
  assertEquals(
    v("ghcr.io/cloudnative-pg/postgresql:18.6-system-trixie"),
    "18.6",
  );
  assertEquals(v("ghcr.io/cloudnative-pg/postgresql:17"), "17");
  assertEquals(v("registry.example.org:5000/pg/postgresql:16.4-1"), "16.4");
  assertEquals(
    v(`registry.example.org/postgresql:17.2@sha256:${"a".repeat(64)}`),
    "17.2",
  );
  assertEquals(v(`registry.example.org/pg@sha256:${"a".repeat(64)}`), null);
  assertEquals(v(`registry.example.org/pg@sha256:${"12".repeat(32)}`), null);
  assertEquals(v("registry.example.org:5000/pg/postgresql"), null);
  assertEquals(v("postgresql:latest"), null);
});

Deno.test("an empty, partial or malformed object still parses to a valid record", () => {
  const shapes: unknown[] = [
    {},
    { metadata: null, spec: null, status: null },
    { metadata: { name: "x", namespace: "pg" } },
    { metadata: "x", spec: [], status: "broken" },
    {
      metadata: { name: 5, namespace: {} },
      spec: {
        instances: "3",
        storage: "1Gi",
        backup: "yes",
        plugins: [null, "x", {}, { name: 7 }, { name: "p", parameters: [] }],
      },
      status: {
        readyInstances: "2",
        conditions: { type: "Ready" },
        instanceNames: [1, null, "ok-1"],
        instancesStatus: { healthy: "ok-1", failed: [2, "ok-2"] },
        instancesReportedState: ["x"],
        pluginStatus: "none",
        timelineID: "1",
        pgDataImageInfo: 18,
      },
    },
  ];
  for (const s of shapes) {
    const r = parseCluster(s as Record<string, unknown>);
    ClusterSchema.strict().parse(r);
    assertEquals(r.summary.healthy, false);
  }
  const last = parseCluster(shapes[4] as Record<string, unknown>);
  assertEquals(last.name, "");
  assertEquals(last.instances, null);
  assertEquals(last.readyInstances, 0);
  assertEquals(last.instanceNames, ["ok-1"]);
  assertEquals(last.backup.plugins.map((p) => p.name), ["p"]);
  assertEquals(last.backup.plugins[0].parameterNames, []);
});

Deno.test("list records every Cluster of every namespace with one call", async () => {
  await withScript(
    [{ args: listCall(C, ""), out: list([clusterOne, clusterNoBackup]) }],
    { namespace: "" },
    async (c) => {
      const r = await cluster.methods.list.execute({}, c.context);
      assertEquals(r.dataHandles.length, 3);
      assertEquals(c.written.map((w) => [w.spec, w.name]), [
        ["cluster", "pg--one"],
        ["cluster", "pg--nobackup"],
        ["inventory", "inventory_all"],
      ]);
      for (const w of c.written.slice(0, 2)) {
        ClusterSchema.strict().parse(w.data);
      }
      noSecret(everything(c));
    },
  );
});

Deno.test("list reads the ObjectStores once when a Cluster names one", async () => {
  await withScript(
    [
      { args: listCall(C, "pg"), out: list([clusterOne, clusterThree]) },
      { args: listCall(O, "pg"), out: list([objectStore]) },
    ],
    { namespace: "pg", kubeconfig: "/tmp/kc", context: "kind-x" },
    async (c) => {
      await cluster.methods.list.execute({}, c.context);
      const three = c.written[1].data as ReturnType<typeof parseCluster>;
      assertEquals(three.archive.source, "objectStore");
      assertEquals(three.backup.objectStore?.found, true);
      noSecret(everything(c));
    },
  );
});

Deno.test("list still records the Clusters when the ObjectStores cannot be read", async () => {
  const failures: Array<[Answer, string]> = [
    [forbiddenList(O, "pg"), "reading it is forbidden for this user"],
    [
      { fail: SAID.missingCrd("objectstores") },
      "the cluster has no objectstores.barmancloud.cnpg.io resource type",
    ],
    [{ hang: true }, "no answer within 35 seconds"],
    [{ out: { kind: "Status" } }, "did not return a list"],
    [{ fail: SAID.badToken }, "did not accept the credentials"],
  ];
  for (const [answer, error] of failures) {
    await withScript(
      [
        { args: listCall(C, "pg"), out: list([clusterThree]) },
        { args: listCall(O, "pg"), ...answer },
      ],
      { namespace: "pg" },
      async (c) => {
        await cluster.methods.list.execute({}, c.context);
        const r = c.written[0].data as ReturnType<typeof parseCluster>;
        assertEquals(r.backup.objectStore, {
          ...missingObjectStore("store", "three", r.backup.objectStore!.error!)
            .store,
        });
        assertStringIncludes(r.backup.objectStore!.error!, error);
        assertFalse(r.backup.objectStore!.error!.includes("E1110"));
        assertEquals(r.archive.source, "none");
        assertEquals(r.summary.healthy, true);
        assert(c.logs.some((l) => l.includes("could not be read")));
      },
    );
  }
});

Deno.test("list marks an ObjectStore that is not in the answer as not found", async () => {
  await withScript(
    [
      { args: listCall(C, ""), out: list([clusterThree]) },
      {
        args: listCall(O, ""),
        out: list([{
          ...objectStore,
          metadata: { name: "store", namespace: "x" },
        }]),
      },
    ],
    { namespace: "" },
    async (c) => {
      await cluster.methods.list.execute({}, c.context);
      const r = c.written[0].data as ReturnType<typeof parseCluster>;
      assertEquals(r.backup.objectStore?.found, false);
      assertEquals(r.backup.objectStore?.error, "not found");
    },
  );
});

Deno.test("list takes the namespace argument over the model's, and an empty list is fine", async () => {
  await withScript(
    [{ args: listCall(C, "other"), out: list([]) }],
    { namespace: "pg" },
    async (c) => {
      const r = await cluster.methods.list.execute(
        { namespace: "other" },
        c.context,
      );
      assertEquals(r.dataHandles.length, 1);
      assertEquals(c.written.map((w) => [w.spec, w.name]), [
        ["inventory", "inventory_ns_other"],
      ]);
      const inv = c.written[0].data as Record<string, unknown>;
      assertEquals(
        [inv.namespace, inv.count, inv.healthyCount, inv.unhealthyCount],
        ["other", 0, 0, 0],
      );
      assertEquals(inv.items, []);
    },
  );
});

Deno.test("list fails by name and writes nothing when the call is broken", async () => {
  const broken: Array<[Answer, string]> = [
    [forbiddenList(C, "pg"), "(Forbidden)"],
    [{ fail: SAID.missingCrd("clusters") }, MISSING_CRD],
    [{ out: "Unable to connect to the server" }, "did not print JSON"],
    [{ out: "" }, "did not print JSON (no output)"],
    [{ out: { kind: "Status", status: "Failure" } }, "did not return a list"],
    [{ out: { items: [] } }, "did not return a list"],
    [{ out: list(["x"]) }, "item 0 is not an object"],
    [{ out: list([objectStore]) }, 'of kind "ObjectStore", not Cluster'],
    [
      { out: list([{ kind: "Cluster", metadata: { name: "x" } }]) },
      "a Cluster without a name or namespace",
    ],
    [{ hang: true }, "no answer within 35 seconds"],
    [
      { fail: "Unable to connect to the server: net/http: request canceled" },
      "request canceled",
    ],
    [{ fail: SAID.unauthorized }, "did not accept the credentials"],
    [{ fail: SAID.refused }, "could not be reached"],
    [{ notInstalled: true }, "kubectl is not on PATH"],
  ];
  for (const [answer, text] of broken) {
    await withScript(
      [{ args: listCall(C, "pg"), ...answer }],
      { namespace: "pg" },
      async (c) => {
        const e = await assertRejects(
          () => cluster.methods.list.execute({}, c.context),
          Error,
        );
        assertStringIncludes(e.message, text);
        assertEquals(c.written, []);
      },
    );
  }
});

Deno.test("a hostile namespace is refused before anything is spawned", async () => {
  for (const ns of HOSTILE.filter((n) => n !== "")) {
    await withScript([], { namespace: "" }, async (c, s) => {
      await assertRejects(
        () => cluster.methods.list.execute({ namespace: ns }, c.context),
        Error,
        "is not a Kubernetes namespace name",
      );
      await assertRejects(
        () =>
          cluster.methods.get.execute(
            { name: "one", namespace: ns },
            c.context,
          ),
        Error,
        "is not a Kubernetes namespace name",
      );
      assertEquals(s.calls, []);
    });
    await withScript([], { namespace: ns }, async (c, s) => {
      await assertRejects(
        () => cluster.methods.list.execute({}, c.context),
        Error,
        "is not a Kubernetes namespace name",
      );
      assertEquals(s.calls, []);
    });
  }
});

Deno.test("a hostile name is refused before anything is spawned", async () => {
  for (const name of HOSTILE) {
    await withScript([], { namespace: "pg" }, async (c, s) => {
      await assertRejects(
        () => cluster.methods.get.execute({ name }, c.context),
        Error,
        "is not a Kubernetes object name",
      );
      assertEquals(s.calls, []);
      assertEquals(c.written, []);
    });
  }
});

Deno.test("get needs a namespace", async () => {
  await withScript([], { namespace: "" }, async (c) => {
    await assertRejects(
      () => cluster.methods.get.execute({ name: "one" }, c.context),
      Error,
      "namespace is required for get",
    );
  });
});

Deno.test("get records one Cluster, and reads its ObjectStore when it names one", async () => {
  await withScript(
    [{ args: getArgs(C, "one", "pg"), out: clusterOne }],
    { namespace: "pg" },
    async (c) => {
      const r = await cluster.methods.get.execute({ name: "one" }, c.context);
      assertEquals(r.dataHandles.length, 1);
      assertEquals(c.written[0].name, "pg--one");
      noSecret(everything(c));
    },
  );
  await withScript(
    [
      {
        args: getArgs(C, "three", "other"),
        out: {
          ...clusterThree,
          metadata: { name: "three", namespace: "other" },
        },
      },
      {
        args: getArgs(O, "store", "other"),
        out: {
          ...objectStore,
          metadata: { name: "store", namespace: "other" },
        },
      },
    ],
    { namespace: "pg", context: "ctx" },
    async (c) => {
      await cluster.methods.get.execute(
        { name: "three", namespace: "other" },
        c.context,
      );
      const r = c.written[0].data as ReturnType<typeof parseCluster>;
      assertEquals(r.archive.source, "objectStore");
      assertStringIncludes(c.logs.at(-1)!, "3/3 ready, primary three-1");
      noSecret(everything(c));
    },
  );
});

Deno.test("get records the Cluster when its ObjectStore is missing or refused", async () => {
  const failures: Array<[Answer, string]> = [
    [{ fail: notFound(O, "store") }, "not found"],
    [
      { fail: forbidden("get", O, "pg") },
      "reading it is forbidden for this user",
    ],
    [
      { fail: SAID.missingCrd("objectstores") },
      "the cluster has no objectstores.barmancloud.cnpg.io resource type",
    ],
    [{ hang: true }, "no answer within 35 seconds"],
    [{ out: "<html>" }, "did not print JSON"],
    [{ out: {} }, "kubectl did not return ObjectStore pg/store"],
    [
      { out: { ...objectStore, metadata: { name: "other", namespace: "pg" } } },
      "kubectl did not return ObjectStore pg/store",
    ],
    [{ out: clusterThree }, "kubectl did not return ObjectStore pg/store"],
  ];
  for (const [answer, error] of failures) {
    await withScript(
      [
        { args: getArgs(C, "three", "pg"), out: clusterThree },
        { args: getArgs(O, "store", "pg"), ...answer },
      ],
      { namespace: "pg" },
      async (c) => {
        await cluster.methods.get.execute({ name: "three" }, c.context);
        const r = c.written[0].data as ReturnType<typeof parseCluster>;
        assertEquals(r.backup.objectStore?.found, false);
        assertStringIncludes(r.backup.objectStore!.error!, error);
        assertEquals(r.backup.methods, ["plugin"]);
      },
    );
  }
});

Deno.test("get does not hand a hostile ObjectStore name to kubectl", async () => {
  const item = structuredClone(clusterThree);
  (item.spec.plugins[0].parameters as Record<string, string>)
    .barmanObjectName = "--all-namespaces";
  await withScript(
    [{ args: getArgs(C, "three", "pg"), out: item }],
    { namespace: "pg" },
    async (c) => {
      await cluster.methods.get.execute({ name: "three" }, c.context);
      const r = c.written[0].data as ReturnType<typeof parseCluster>;
      assertEquals(r.backup.objectStore?.found, false);
      assertStringIncludes(
        r.backup.objectStore!.error!,
        "is not a Kubernetes object name",
      );
    },
  );
});

Deno.test("get fails by name for a missing Cluster, a refusal and a broken answer", async () => {
  const broken: Array<[Answer, string]> = [
    [{ fail: notFound(C, "gone") }, '"gone" not found'],
    [{ fail: forbidden("get", C, "pg") }, "(Forbidden)"],
    [{ out: "<html>proxy error</html>" }, "did not print JSON"],
    [{ hang: true }, "no answer within 35 seconds"],
    [{ fail: SAID.missingCrd("clusters") }, MISSING_CRD],
    [{ fail: SAID.badToken }, "did not accept the credentials"],
  ];
  for (const [answer, text] of broken) {
    await withScript(
      [{ args: getArgs(C, "gone", "pg"), ...answer }],
      { namespace: "pg" },
      async (c) => {
        const e = await assertRejects(
          () => cluster.methods.get.execute({ name: "gone" }, c.context),
          Error,
        );
        assertStringIncludes(e.message, text);
        assertEquals(c.written, []);
      },
    );
  }
});

Deno.test("an answer that is not the Cluster that was asked for is an error and no record", async () => {
  const wrong: unknown[] = [
    {},
    [],
    { kind: "Cluster", metadata: {} },
    { ...clusterOne, metadata: { name: "two", namespace: "pg" } },
    { ...clusterOne, metadata: { name: "one", namespace: "other" } },
    { ...clusterOne, kind: "Backup" },
    list([clusterOne]),
  ];
  for (const out of wrong) {
    await withScript(
      [{ args: getArgs(C, "one", "pg"), out }],
      { namespace: "pg" },
      async (c) => {
        await assertRejects(
          () => cluster.methods.get.execute({ name: "one" }, c.context),
          KubectlError,
          "kubectl did not return Cluster pg/one",
        );
        assertEquals(c.written, [], JSON.stringify(out));
      },
    );
  }
});

Deno.test("a hibernated Cluster is not healthy and not archiving, and is named as hibernated", () => {
  const r = parseCluster(clusterHibernated);
  ClusterSchema.strict().parse(r);
  assertEquals([r.hibernated, r.fenced, r.fencedInstances], [true, false, []]);
  // The conditions of the running Cluster are still on the object.
  assertEquals(
    r.conditions.filter((c) => c.status === "True").map((c) => c.type),
    [
      "Ready",
      "ContinuousArchiving",
      "LastBackupSucceeded",
      "cnpg.io/hibernation",
    ],
  );
  assertEquals(r.backup.walArchiver, "barmanObjectStore");
  assertEquals(r.summary, {
    healthy: false,
    archiving: false,
    primaryChanging: false,
    instancesReady: false,
  });
  assertEquals(
    clusterReason(r),
    "hibernated on purpose (annotation cnpg.io/hibernation); 0 of 1 instances ready",
  );
  // Hibernation alone is enough, whatever the status still says.
  const awake = structuredClone(clusterOne) as Record<string, unknown>;
  (awake.metadata as Record<string, unknown>).annotations = {
    "cnpg.io/hibernation": "on",
  };
  const s = parseCluster(awake);
  assertEquals([s.summary.healthy, s.summary.archiving], [false, false]);
  assertEquals(
    clusterReason(s),
    "hibernation asked for and not reached (annotation cnpg.io/hibernation; the operator has set no condition for it)",
  );
  // Only the value "on" hibernates.
  for (const value of ["off", "", "true", 1]) {
    (awake.metadata as Record<string, unknown>).annotations = {
      "cnpg.io/hibernation": value,
    };
    const t = parseCluster(awake);
    assertEquals([t.hibernated, t.summary.healthy], [false, true]);
  }
});

Deno.test("a fenced Cluster is not healthy, and not archiving when its primary is fenced", () => {
  const r = parseCluster(clusterFenced);
  ClusterSchema.strict().parse(r);
  assertEquals([r.fenced, r.fencedInstances, r.hibernated], [
    true,
    ["one-1"],
    false,
  ]);
  // Everything else on the object still says healthy.
  assertEquals(r.phase, "Cluster in healthy state");
  assertEquals(r.summary, {
    healthy: false,
    archiving: false,
    primaryChanging: false,
    instancesReady: true,
  });
  assertEquals(
    clusterReason(r),
    "fenced: one-1 (annotation cnpg.io/fencedInstances)",
  );
  const fence = (value: unknown, base: unknown = clusterThree) => {
    const item = structuredClone(base) as Record<string, unknown>;
    (item.metadata as Record<string, unknown>).annotations = {
      "cnpg.io/fencedInstances": value,
    };
    return parseCluster(item);
  };
  // A fenced replica: not healthy, and the primary still archives.
  const replica = fence('["three-3","three-2"]');
  assertEquals(replica.fencedInstances, ["three-2", "three-3"]);
  assertEquals([replica.summary.healthy, replica.summary.archiving], [
    false,
    true,
  ]);
  assertEquals(
    clusterReason(replica),
    "fenced: three-2, three-3 (annotation cnpg.io/fencedInstances)",
  );
  // The primary, or every instance.
  assertEquals(fence('["three-1"]').summary.archiving, false);
  const all = fence('["*"]');
  assertEquals([all.fenced, all.summary.healthy, all.summary.archiving], [
    true,
    false,
    false,
  ]);
  assertEquals(
    clusterReason(all),
    "fenced: every instance (annotation cnpg.io/fencedInstances)",
  );
  // Nothing fenced.
  for (const value of ["[]", "", "  ", undefined, 7, " [ ] "]) {
    const none = fence(value);
    assertEquals([none.fenced, none.fencedInstances], [false, []]);
    assertEquals([none.summary.healthy, none.summary.archiving], [true, true]);
  }
  // An annotation that is no list still fences, as far as a reader can tell.
  for (
    const value of [
      "three-1",
      '{"a":1}',
      '"*"',
      "[1,2",
      "[1,2]",
      '["three-2",5]',
      "[null]",
      '[["three-1"]]',
      "true",
      "0",
    ]
  ) {
    const odd = fence(value);
    assertEquals([odd.fenced, odd.fencedInstances], [true, []], value);
    assertEquals([odd.summary.healthy, odd.summary.archiving], [false, false]);
    assertEquals(
      clusterReason(odd),
      "fenced: the annotation cannot be read (annotation cnpg.io/fencedInstances)",
    );
  }
  // A hostile name is cut and cleaned before it is stored.
  const hostile = fence(JSON.stringify(["a\nb", "x".repeat(300)]));
  assertEquals(hostile.fencedInstances.length, 2);
  assert(
    hostile.fencedInstances.every((n) => n.length <= 83 && !n.includes("\n")),
  );
});

Deno.test("list counts a hibernated Cluster as healthy and names a fenced one", async () => {
  await withScript(
    [{
      args: listCall(C, "pg"),
      out: list([clusterHibernated, clusterFenced, clusterOne]),
    }],
    { namespace: "pg" },
    async (c) => {
      await cluster.methods.list.execute({}, c.context);
      const inv = cluster.resources.inventory.schema.strict().parse(
        c.written.at(-1)!.data,
      );
      assertEquals([inv.count, inv.healthyCount, inv.unhealthyCount], [
        3,
        2,
        1,
      ]);
      assertEquals(inv.items, [
        {
          namespace: "pg",
          name: "asleep",
          dataName: "pg--asleep",
          healthy: true,
          reason: null,
          archiveFailing: false,
          hibernated: true,
        },
        {
          namespace: "pg",
          name: "fenced",
          dataName: "pg--fenced",
          healthy: false,
          reason: "fenced: one-1 (annotation cnpg.io/fencedInstances)",
          archiveFailing: true,
          hibernated: false,
        },
        {
          namespace: "pg",
          name: "one",
          dataName: "pg--one",
          healthy: true,
          reason: null,
          archiveFailing: false,
          hibernated: false,
        },
      ]);
      // The record itself does not call a hibernated Cluster healthy.
      const asleep = c.written[0].data as ReturnType<typeof parseCluster>;
      assertEquals([asleep.hibernated, asleep.summary.healthy], [true, false]);
    },
  );
});

Deno.test("a Cluster whose plugin archives WAL never shows the times left in its own status", () => {
  // Leftover status, a readable ObjectStore: the ObjectStore's times.
  const withStore = parseCluster(
    clusterMoved,
    parseObjectStore(objectStore, "three"),
  );
  assertEquals(withStore.archive, {
    firstRecoverabilityPoint: "2026-11-10T09:50:00Z",
    lastSuccessfulBackup: "2026-11-10T09:50:05Z",
    lastFailedBackup: null,
    source: "objectStore",
  });
  // No ObjectStore, one without a window, one that could not be read: no
  // times at all, never the stale ones.
  for (
    const read of [
      null,
      parseObjectStore(objectStore, "unknown-server"),
      missingObjectStore("store", "three", "not found"),
    ]
  ) {
    assertEquals(parseCluster(clusterMoved, read).archive, {
      firstRecoverabilityPoint: null,
      lastSuccessfulBackup: null,
      lastFailedBackup: null,
      source: "none",
    });
  }
  // Without a plugin that archives, the Cluster status is the source, as
  // before: no plugin, a disabled one, and one that only takes backups.
  const variants: Array<(plugins: Array<Record<string, unknown>>) => void> = [
    (p) => p.splice(0),
    (p) => p[0].enabled = false,
    (p) => p[0].isWALArchiver = false,
  ];
  for (const change of variants) {
    const item = structuredClone(clusterMoved);
    change(item.spec.plugins as Array<Record<string, unknown>>);
    assertEquals(parseCluster(item).archive, {
      firstRecoverabilityPoint: "2026-01-01T00:00:00Z",
      lastSuccessfulBackup: "2026-01-02T00:00:00Z",
      lastFailedBackup: "2026-01-03T00:00:00Z",
      source: "clusterStatus",
    });
  }
});

Deno.test("each part of an unhealthy Cluster is named in its reason", () => {
  assertEquals(clusterReason(parseCluster(clusterOne)), null);
  assertEquals(
    clusterReason(parseCluster(clusterFailingOver)),
    "phase Failing over (Failing over from three-1 to three-2); 2 of 3 instances ready; primary changing from three-1 to three-2; Ready is False (ClusterIsNotReady)",
  );
  assertEquals(
    clusterReason(parseCluster({ spec: { instances: 2 } })),
    "no phase yet; 0 of 2 instances ready; no Ready condition",
  );
  const upgrading = structuredClone(clusterOne);
  upgrading.status.phase = "Upgrading cluster";
  assertEquals(
    clusterReason(parseCluster(upgrading)),
    "phase Upgrading cluster",
  );
  const pending = structuredClone(clusterOne);
  pending.status.targetPrimary = "pending";
  assertEquals(
    clusterReason(parseCluster(pending)),
    "primary changing from one-1 to pending",
  );
  const hostile = structuredClone(clusterOne) as Record<string, unknown>;
  (hostile.status as Record<string, unknown>).phase =
    `broken\nat https://u:${PLANTED.password}@db.example.org ` +
    "x".repeat(500);
  const line = clusterReason(parseCluster(hostile))!;
  assert(line.length <= 203, String(line.length));
  assertFalse(line.includes("\n"));
  assertFalse(line.includes(PLANTED.password));
});

Deno.test("list writes an inventory that names each unhealthy Cluster and why", async () => {
  const archiveDown = structuredClone(clusterOne);
  archiveDown.metadata.name = "arch";
  archiveDown.status.conditions[1].status = "False";
  await withScript(
    [
      {
        args: listCall(C, "pg"),
        out: list([
          clusterOne,
          clusterFailingOver,
          clusterNoBackup,
          archiveDown,
        ]),
      },
      { args: listCall(O, "pg"), out: list([objectStore]) },
    ],
    { namespace: "pg" },
    async (c) => {
      const r = await cluster.methods.list.execute({}, c.context);
      assertEquals(r.dataHandles.length, 5);
      const last = c.written.at(-1)!;
      assertEquals([last.spec, last.name], ["inventory", "inventory_ns_pg"]);
      const inv = cluster.resources.inventory.schema.strict().parse(last.data);
      assertEquals(
        [inv.namespace, inv.count, inv.healthyCount, inv.unhealthyCount],
        ["pg", 4, 3, 1],
      );
      assertEquals(inv.items, [
        {
          namespace: "pg",
          name: "one",
          dataName: "pg--one",
          healthy: true,
          reason: null,
          archiveFailing: false,
          hibernated: false,
        },
        {
          namespace: "pg",
          name: "three",
          dataName: "pg--three",
          healthy: false,
          reason:
            "phase Failing over (Failing over from three-1 to three-2); 2 of 3 instances ready; primary changing from three-1 to three-2; Ready is False (ClusterIsNotReady)",
          archiveFailing: true,
          hibernated: false,
        },
        {
          namespace: "pg",
          name: "nobackup",
          dataName: "pg--nobackup",
          healthy: true,
          reason: null,
          archiveFailing: false,
          hibernated: false,
        },
        {
          namespace: "pg",
          name: "arch",
          dataName: "pg--arch",
          healthy: true,
          reason: null,
          archiveFailing: true,
          hibernated: false,
        },
      ]);
      // Every line points at a record that was written in the same run.
      assertEquals(
        inv.items.map((i) => i.dataName),
        c.written.slice(0, 4).map((w) => w.name),
      );
      assert(!Number.isNaN(Date.parse(inv.observedAt)));
      assertStringIncludes(c.logs.at(-1)!, "Recorded 4 Cluster objects");
      assertStringIncludes(c.logs.at(-1)!, "1 not healthy");
      noSecret(everything(c));
    },
  );
});

Deno.test("an empty namespace argument lists the definition's namespace", async () => {
  await withScript(
    [{ args: listCall(C, "pg"), out: list([]) }],
    { namespace: "pg" },
    async (c) => {
      await cluster.methods.list.execute({ namespace: "" }, c.context);
      assertEquals(c.written.map((w) => w.name), ["inventory_ns_pg"]);
    },
  );
});

Deno.test("a list in which two Clusters share a data name writes nothing", async () => {
  const named = (namespace: string, name: string) => ({
    ...clusterNoBackup,
    metadata: { name, namespace },
  });
  await withScript(
    [{
      args: listCall(C, ""),
      out: list([clusterOne, named("a", "b--c"), named("a--b", "c")]),
    }],
    { namespace: "" },
    async (c) => {
      await assertRejects(
        () => cluster.methods.list.execute({}, c.context),
        Error,
        "Cluster a/b--c and a--b/c would both be stored as a--b--c",
      );
      assertEquals(c.written, []);
    },
  );
});

Deno.test("a cancelled run is thrown on, never recorded as an unreadable ObjectStore", async () => {
  // list: cancelled while the ObjectStores are read.
  const stop = new AbortController();
  await withScript(
    [{ args: listCall(C, "pg"), out: list([clusterThree]) }],
    { namespace: "pg" },
    async (c) => {
      const e = await assertRejects(
        () => cluster.methods.list.execute({}, c.context),
        KubectlError,
      );
      assertEquals(e.kind, "cancelled");
      assertStringIncludes(e.message, "was cancelled");
      assertEquals(c.written, []);
      assertFalse(c.logs.some((l) => l.includes("could not be read")));
    },
    {
      signal: stop.signal,
      handler: (call) => {
        assertEquals(call.resource, O);
        stop.abort();
        return {};
      },
    },
  );
  // get: cancelled while the ObjectStore is read.
  const stop2 = new AbortController();
  await withScript(
    [{ args: getArgs(C, "three", "pg"), out: clusterThree }],
    { namespace: "pg" },
    async (c) => {
      const e = await assertRejects(
        () => cluster.methods.get.execute({ name: "three" }, c.context),
        KubectlError,
      );
      assertEquals(e.kind, "cancelled");
      assertEquals(c.written, []);
    },
    {
      signal: stop2.signal,
      handler: () => {
        stop2.abort();
        return {};
      },
    },
  );
  // A run that is cancelled before it starts makes no record either.
  const stop3 = new AbortController();
  stop3.abort();
  await withScript([], { namespace: "pg" }, async (c) => {
    const e = await assertRejects(
      () => cluster.methods.list.execute({}, c.context),
      KubectlError,
    );
    assertEquals(e.kind, "cancelled");
    assertEquals(c.written, []);
  }, { signal: stop3.signal, handler: () => ({}) });
});

Deno.test("a hibernation counts in the inventory only once the operator has acted, and not when fenced too", async () => {
  const hibernate = (
    conditions: unknown[],
    more: Record<string, string> = {},
  ) => ({
    ...clusterHibernated,
    metadata: {
      name: "asleep",
      namespace: "pg",
      annotations: { "cnpg.io/hibernation": "on", ...more },
    },
    status: { ...clusterHibernated.status, conditions },
  });
  const done = {
    type: "cnpg.io/hibernation",
    status: "True",
    reason: "Hibernated",
  };
  const running = clusterOne.status.conditions;
  const line = async (item: unknown) => {
    let found: Record<string, unknown> = {};
    await withScript(
      [{ args: listCall(C, "pg"), out: list([item]) }],
      { namespace: "pg" },
      async (c) => {
        await cluster.methods.list.execute({}, c.context);
        const inv = cluster.resources.inventory.schema.strict().parse(
          c.written.at(-1)!.data,
        );
        assertEquals(inv.unhealthyCount, inv.items[0].healthy ? 0 : 1);
        found = inv.items[0];
        const record = c.written[0].data as ReturnType<typeof parseCluster>;
        // The record never calls a hibernated Cluster healthy or archiving.
        assertEquals([
          record.hibernated,
          record.summary.healthy,
          record.summary.archiving,
        ], [true, false, false]);
        found.reached = record.hibernationReached;
      },
    );
    return found;
  };
  // The operator has acted: healthy here, no reason.
  const reached = await line(hibernate([...running, done]));
  assertEquals(
    [reached.reached, reached.healthy, reached.hibernated, reached.reason],
    [true, true, true, null],
  );
  assertEquals(reached.archiveFailing, false);
  // The annotation alone, with every pod still running: judged as any other.
  const asked = await line(hibernate(running));
  assertEquals([asked.reached, asked.healthy, asked.hibernated], [
    false,
    false,
    false,
  ]);
  assertEquals(
    asked.reason,
    "hibernation asked for and not reached (annotation cnpg.io/hibernation; the operator has set no condition for it); 0 of 1 instances ready",
  );
  // The pods are stopping: the condition is there and not True.
  const stopping = await line(
    hibernate([...running, {
      type: "cnpg.io/hibernation",
      status: "False",
      reason: "WaitingPodsDeletion",
    }]),
  );
  assertEquals([stopping.healthy, stopping.hibernated], [false, false]);
  assertEquals(
    stopping.reason,
    "hibernation asked for and not reached (annotation cnpg.io/hibernation; the condition is False (WaitingPodsDeletion)); 0 of 1 instances ready",
  );
  // Reached and fenced too: the fence is someone's to end.
  const both = await line(
    hibernate([...running, done], {
      "cnpg.io/fencedInstances": '["one-1"]',
    }),
  );
  assertEquals([both.reached, both.healthy, both.hibernated], [
    true,
    false,
    false,
  ]);
  assertEquals(
    both.reason,
    "hibernated on purpose (annotation cnpg.io/hibernation); fenced: one-1 (annotation cnpg.io/fencedInstances); 0 of 1 instances ready",
  );
  // A condition left True on a Cluster that is no longer asked to sleep.
  const woken = structuredClone(hibernate([...running, done]));
  woken.metadata.annotations["cnpg.io/hibernation"] = "off";
  const r = parseCluster(woken);
  assertEquals([r.hibernated, r.hibernationReached], [false, false]);
  assertEquals(parseCluster(clusterOne).hibernationReached, false);
});

Deno.test("the snapshot times of the Cluster status stand beside the plugin's archive times", () => {
  const item = structuredClone(clusterMoved) as Record<string, unknown>;
  Object.assign(item.status as Record<string, unknown>, {
    firstRecoverabilityPointByMethod: {
      volumeSnapshot: "2026-11-09T01:00:00Z",
      barmanObjectStore: "2026-01-01T00:00:00Z",
    },
    lastSuccessfulBackupByMethod: {
      volumeSnapshot: "2026-11-10T01:00:00Z",
      barmanObjectStore: "2026-01-02T00:00:00Z",
    },
  });
  const r = parseCluster(item, parseObjectStore(objectStore, "three"));
  ClusterSchema.strict().parse(r);
  // The plugin's window is the archive, untouched by the snapshot times.
  assertEquals(r.archive, {
    firstRecoverabilityPoint: "2026-11-10T09:50:00Z",
    lastSuccessfulBackup: "2026-11-10T09:50:05Z",
    lastFailedBackup: null,
    source: "objectStore",
  });
  assertEquals(r.volumeSnapshotTimes, {
    firstRecoverabilityPoint: "2026-11-09T01:00:00Z",
    lastSuccessfulBackup: "2026-11-10T01:00:00Z",
  });
  // Kept also when the ObjectStore cannot be read and the archive is "none".
  const unread = parseCluster(item, missingObjectStore("store", "three", "x"));
  assertEquals(unread.archive.source, "none");
  assertEquals(unread.archive.lastSuccessfulBackup, null);
  assertEquals(
    unread.volumeSnapshotTimes.lastSuccessfulBackup,
    "2026-11-10T01:00:00Z",
  );
  // None, a map without snapshots, and a map that is no map.
  for (
    const by of [
      undefined,
      {},
      { barmanObjectStore: "2026-01-02T00:00:00Z" },
      "x",
      [
        "2026-01-01T00:00:00Z",
      ],
      { volumeSnapshot: 5 },
    ]
  ) {
    const plain = structuredClone(clusterOne) as Record<string, unknown>;
    Object.assign(plain.status as Record<string, unknown>, {
      firstRecoverabilityPointByMethod: by,
      lastSuccessfulBackupByMethod: by,
    });
    assertEquals(parseCluster(plain).volumeSnapshotTimes, {
      firstRecoverabilityPoint: null,
      lastSuccessfulBackup: null,
    });
    assertEquals(parseCluster(plain).archive.source, "clusterStatus");
  }
});
