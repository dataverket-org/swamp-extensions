import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import {
  type GlobalArgs,
  model,
  type ModelContext,
  options,
  parseContexts,
  parseEtcdMembers,
  parseServices,
  serviceAccountKey,
} from "./node.ts";
import { __setRunner, type RunResult, talosctlArgs } from "./talosctl.ts";

Deno.test("options targets nodes, falls back to endpoint, refuses neither", () => {
  assertEquals(
    options({
      endpoint: "192.0.2.1",
      insecure: false,
      talosctlPath: "t",
      retryDelayMs: 0,
    }).nodes,
    ["192.0.2.1"],
  );
  const o = options({
    nodes: ["a", "b"],
    endpoint: "https://omni.example.net",
    talosconfig: "/tmp/tc",
    insecure: false,
    talosctlPath: "t",
    retryDelayMs: 0,
  });
  assertEquals(o.endpoints, undefined, "nodes given: no --endpoints");
  assertEquals(talosctlArgs(o, ["get", "disks"]), [
    "get",
    "disks",
    "--nodes",
    "a,b",
    "--talosconfig",
    "/tmp/tc",
  ]);
  let threw = false;
  try {
    options({ insecure: false, talosctlPath: "t", retryDelayMs: 0 });
  } catch {
    threw = true;
  }
  assertEquals(threw, true);
});

Deno.test("talosContext names the context instead of inheriting the current one", () => {
  const o = options({
    nodes: ["a"],
    talosconfig: "/tmp/tc",
    talosContext: "dataverket-prod",
    insecure: false,
    talosctlPath: "t",
    retryDelayMs: 0,
  });
  assertEquals(o.context, "dataverket-prod");
  assertEquals(talosctlArgs(o, ["version"]), [
    "version",
    "--nodes",
    "a",
    "--talosconfig",
    "/tmp/tc",
    "--context",
    "dataverket-prod",
  ]);
  assertEquals(
    talosctlArgs(
      options({
        nodes: ["a"],
        insecure: false,
        talosctlPath: "t",
        retryDelayMs: 0,
      }),
      ["version"],
    ).includes("--context"),
    false,
    "no context given: talosctl keeps its own lookup",
  );
});

Deno.test("parseContexts reads the names either side of the current marker", () => {
  assertEquals(
    parseContexts(
      "CURRENT   NAME        ENDPOINTS\n" +
        "*         fabrikk     https://omni.example.com\n" +
        "          lab         192.0.2.10\n",
    ),
    ["fabrikk", "lab"],
  );
  assertEquals(parseContexts("CURRENT   NAME        ENDPOINTS\n"), []);
});

Deno.test("omni-key-readable reads the key file and never reports its value", async () => {
  const path = await Deno.makeTempFile();
  await Deno.writeTextFile(path, "the-key-value\n");
  try {
    const good = await model.checks["omni-key-readable"].execute(
      { globalArgs: { serviceAccountKeyFile: path } as GlobalArgs },
    );
    assertEquals(good.pass, true);

    await Deno.writeTextFile(path, "   \n");
    const empty = await model.checks["omni-key-readable"].execute(
      { globalArgs: { serviceAccountKeyFile: path } as GlobalArgs },
    );
    assertEquals(empty.pass, false);
    assertStringIncludes(empty.errors![0], "is empty");
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("omni-key-readable catches a missing file, both set, and neither", async () => {
  const missing = await model.checks["omni-key-readable"].execute(
    { globalArgs: { serviceAccountKeyFile: "/nope/absent.key" } as GlobalArgs },
  );
  assertEquals(missing.pass, false);
  assertStringIncludes(missing.errors![0], "does not exist");

  const both = await model.checks["omni-key-readable"].execute({
    globalArgs: {
      serviceAccountKeyFile: "/nope/absent.key",
      serviceAccountKey: "v",
    } as GlobalArgs,
  });
  assertEquals(both.pass, false);
  assertStringIncludes(both.errors![0], "not both");

  // plain talosctl: the talosconfig carries a client certificate
  const neither = await model.checks["omni-key-readable"].execute(
    { globalArgs: {} as GlobalArgs },
  );
  assertEquals(neither.pass, true);
});

Deno.test("parseServices and parseEtcdMembers read the tables", () => {
  assertEquals(
    parseServices(
      "NODE SERVICE STATE HEALTH LAST CHANGE\n192.0.2.1 apid Running OK 1m\n",
    ),
    [{ node: "192.0.2.1", id: "apid", state: "Running", health: "OK" }],
  );
  assertEquals(
    parseEtcdMembers(
      "NODE ID HOSTNAME PEER CLIENT LEARNER\n192.0.2.1 abc ctrl-1 https://p:2380 https://c:2379 false\n",
    )[0].hostname,
    "ctrl-1",
  );
});

Deno.test("the key file and the key value are mutually exclusive", () => {
  assertThrows(
    () =>
      serviceAccountKey({
        serviceAccountKeyFile: "/tmp/reader.key",
        serviceAccountKey: "KEY123",
        insecure: false,
        talosctlPath: "t",
        retryDelayMs: 0,
      }),
    Error,
    "not both",
  );
});

Deno.test("neither is no Omni key at all, which is the plain talosctl case", () => {
  assertEquals(
    options({
      nodes: ["a"],
      insecure: false,
      talosctlPath: "t",
      retryDelayMs: 0,
    }).env?.OMNI_SERVICE_ACCOUNT_KEY,
    undefined,
  );
});

// ───── the methods, through createModelTestContext with a stub runner ─────
//
// Each test lists the few answers it needs, keyed by the start of talosctl's
// arguments (the command, then `--nodes <node>` where it matters); a call it
// did not list fails. It is not a model of Talos: the live use is the proof.

const N1 = "192.0.2.1", N2 = "192.0.2.2";
const G: GlobalArgs = {
  nodes: [N1, N2],
  insecure: false,
  talosctlPath: "talosctl",
  retryDelayMs: 0,
};
const M = model.methods;

type Reply = Partial<RunResult>;
const out = (stdout: string): Reply => ({ stdout });
const fail = (stderr: string): Reply => ({ code: 1, stderr });

interface Harness {
  context: ModelContext;
  calls: string[];
  written: () => {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[];
  logs: (level: string) => string[];
}

async function withStub(
  routes: [string, Reply][],
  body: (h: Harness) => Promise<void>,
  globalArgs: GlobalArgs = G,
): Promise<void> {
  const calls: string[] = [];
  __setRunner((argv) => {
    const line = argv.slice(1).join(" ");
    calls.push(line);
    const r = routes.find(([prefix]) => line.startsWith(prefix))?.[1];
    if (!r) {
      return Promise.reject(new Error(`the stub has no answer for ${line}`));
    }
    return Promise.resolve({
      code: r.code ?? 0,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    });
  });
  const t = createModelTestContext({ globalArgs });
  try {
    await body({
      context: t.context as unknown as ModelContext,
      calls,
      written: () =>
        t.getWrittenResources().map((w) => ({
          spec: w.specName,
          name: w.name,
          data: w.data as Record<string, unknown>,
        })),
      logs: (level) => t.getLogsByLevel(level as "info").map((l) => l.message),
    });
  } finally {
    __setRunner();
  }
}

const machineType = (node: string, type: string): [string, Reply] => [
  `get machinetype -o json --nodes ${node}`,
  out(JSON.stringify({ node, metadata: { id: "machine-type" }, spec: type })),
];

Deno.test("version writes one record per node", () =>
  withStub([
    [
      "version --json",
      out(JSON.stringify({
        version: { tag: "v1.14.1", sha: "abc", arch: "amd64" },
        platform: { name: "metal" },
      })),
    ],
  ], async (h) => {
    await M.version.execute({}, h.context);
    assertEquals(h.calls, [
      `version --json --nodes ${N1}`,
      `version --json --nodes ${N2}`,
    ]);
    assertEquals(
      h.written().map((w) => [w.spec, w.name, w.data.tag, w.data.platform]),
      [
        ["version", "version-192-0-2-1", "v1.14.1", "metal"],
        ["version", "version-192-0-2-2", "v1.14.1", "metal"],
      ],
    );
  }));

Deno.test("version fails with talosctl's error and writes nothing", () =>
  withStub(
    [["version", fail("rpc error: code = PermissionDenied")]],
    async (h) => {
      await assertRejects(
        () => M.version.execute({ nodes: [N1] }, h.context),
        Error,
        "talosctl version failed (exit 1): rpc error: code = PermissionDenied",
      );
      assertEquals(h.written(), []);
    },
  ));

Deno.test("a node outside the definition's targets is refused before any call", () =>
  withStub([], async (h) => {
    await assertRejects(
      () => M.version.execute({ nodes: ["192.0.2.9"] }, h.context),
      Error,
      "not among the definition's nodes: 192.0.2.9",
    );
    assertEquals(h.calls, []);
  }));

Deno.test("services writes one record per node and service", () =>
  withStub([
    [
      "services",
      out(
        "NODE SERVICE STATE HEALTH LAST CHANGE\n" +
          `${N1} apid Running OK 1m\n${N2} etcd Running OK 2m\n`,
      ),
    ],
  ], async (h) => {
    await M.services.execute({}, h.context);
    assertEquals(h.calls, [`services --nodes ${N1},${N2}`]);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.state]), [
      ["service", "service-192-0-2-1-apid", "Running"],
      ["service", "service-192-0-2-2-etcd", "Running"],
    ]);
  }));

Deno.test("services fails when talosctl does, and writes nothing", () =>
  withStub([["services", fail("connection refused")]], async (h) => {
    await assertRejects(
      () => M.services.execute({}, h.context),
      Error,
      "talosctl services failed (exit 1): connection refused",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("etcdMembers asks a control plane and writes each member", () =>
  withStub([
    machineType(N1, "worker"),
    machineType(N2, "controlplane"),
    [
      `etcd members --nodes ${N2}`,
      out(
        "NODE ID HOSTNAME PEER CLIENT LEARNER\n" +
          `${N2} abc ctrl-1 https://p:2380 https://c:2379 false\n`,
      ),
    ],
  ], async (h) => {
    await M.etcdMembers.execute({}, h.context);
    assertEquals(
      h.calls.some((c) => c.startsWith(`etcd members --nodes ${N1}`)),
      false,
    );
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.id]), [
      ["etcdMember", "etcd-ctrl-1", "abc"],
    ]);
  }));

Deno.test("etcdMembers fails when no control plane answers, and writes nothing", () =>
  withStub([
    machineType(N1, "controlplane"),
    machineType(N2, "init"),
    ["etcd members", fail("etcd is not running")],
  ], async (h) => {
    await assertRejects(
      () => M.etcdMembers.execute({}, h.context),
      Error,
      "no control plane answered etcd members",
    );
    assertEquals(h.written(), []);
  }));

const ETCD_STATUS =
  "NODE         MEMBER             DB SIZE   IN USE           LEADER             RAFT INDEX   RAFT TERM   RAFT APPLIED INDEX   LEARNER   PROTOCOL   STORAGE   ERRORS\n" +
  "192.0.2.1    0123456789abcdef   30 MB     10 MB (35.30%)   0123456789abcdef   15427147     18          15427147             false     3.7.1      3.7.0     \n";

Deno.test("etcdStatus writes each control plane, and a target of unknown type as unreachable", () =>
  withStub([
    machineType(N1, "controlplane"),
    [`get machinetype -o json --nodes ${N2}`, fail("connection refused")],
    [`etcd status --nodes ${N1}`, out(ETCD_STATUS)],
  ], async (h) => {
    await M.etcdStatus.execute({}, h.context);
    const w = h.written();
    assertEquals(w.map((x) => [x.spec, x.name, x.data.reachable]), [
      ["etcdStatus", "etcd-status-192-0-2-1", true],
      ["etcdStatus", "etcd-status-192-0-2-2", false],
    ]);
    assertEquals(w[0].data.isLeader, true);
    assertEquals(w[0].data.dbSizeBytes, 30e6);
    assertStringIncludes(String(w[1].data.error), "machine type unknown");
    assertEquals(h.logs("warning"), ["{node}: etcd status failed: {error}"]);
    assertEquals(h.logs("info"), [
      "etcd status of {count} control planes, {down} unreachable",
    ]);
  }));

Deno.test("etcdStatus fails when no target is a control plane, and writes nothing", () =>
  withStub(
    [machineType(N1, "worker"), machineType(N2, "worker")],
    async (h) => {
      await assertRejects(
        () => M.etcdStatus.execute({}, h.context),
        Error,
        `no control plane among the targets (${N1}, ${N2})`,
      );
      assertEquals(h.written(), []);
    },
  ));

Deno.test("serviceLogs counts and keeps matching lines, and skips a node without the service", () =>
  withStub([
    [
      `logs etcd --tail 100 --nodes ${N1}`,
      out(
        `${N1}: {"level":"warn","ts":"2026-09-30T11:16:14Z","msg":"ID mismatch"}\n` +
          `${N1}: {"level":"info","ts":"2026-09-30T11:16:15Z","msg":"fine"}\n`,
      ),
    ],
    [
      `logs etcd --tail 100 --nodes ${N2}`,
      fail('rpc error: service "etcd" was not registered'),
    ],
  ], async (h) => {
    await M.serviceLogs.execute(
      { service: "etcd", tail: 100, match: "mismatch", keep: 5 },
      h.context,
    );
    const [w] = h.written();
    assertEquals(h.written().length, 1);
    assertEquals([w.spec, w.name], ["serviceLog", "log-192-0-2-1-etcd"]);
    assertEquals([w.data.read, w.data.counted, w.data.matched], [2, 2, 1]);
    assertEquals((w.data.lines as string[]).length, 1);
    assertEquals(h.logs("warning"), ["{node}: no {service} log, skipped"]);
    assertEquals(h.logs("info"), ["{service} log read on {count} nodes"]);
  }));

Deno.test("serviceLogs fails on a node's error, and writes nothing", () =>
  withStub([
    [`logs etcd --tail 500 --nodes ${N1}`, out(`${N1}: line\n`)],
    [`logs etcd --tail 500 --nodes ${N2}`, fail("permission denied")],
  ], async (h) => {
    await assertRejects(
      () =>
        M.serviceLogs.execute(
          { service: "etcd", tail: 500, keep: 20 },
          h.context,
        ),
      Error,
      `${N2}: talosctl logs failed (exit 1): permission denied`,
    );
    assertEquals(h.written(), []);
  }));

const PROCESSES =
  "NODE         PID      STATE   THREADS   CPU-TIME     VIRTMEM   RESMEM   LABEL                                   COMMAND\n" +
  "192.0.2.1    814      S       14        1748564.50   12 GB     128 MB   system_u:system_r:etcd_t:s0             /usr/local/bin/etcd --secret=x\n" +
  "192.0.2.1    1        S       1         10.00        1 MB      1 MB     system_u:system_r:init_t:s0             /sbin/init\n";

Deno.test("processes writes the top processes of each node, executables only", () =>
  withStub([["processes --sort rss", out(PROCESSES)]], async (h) => {
    await M.processes.execute({ nodes: [N1], sort: "rss", top: 1 }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name], ["processes", "processes-192-0-2-1"]);
    assertEquals([w.data.total, w.data.truncated], [2, true]);
    assertEquals(
      (w.data.processes as { executable: string }[]).map((p) => p.executable),
      ["/usr/local/bin/etcd"],
    );
    assertEquals(h.logs("info"), [
      "top {top} processes by {sort} on {count} nodes",
    ]);
  }));

Deno.test("processes fails on a node's error, and writes nothing", () =>
  withStub([
    [`processes --sort cpu --nodes ${N1}`, out(PROCESSES)],
    [`processes --sort cpu --nodes ${N2}`, fail("deadline exceeded")],
  ], async (h) => {
    await assertRejects(
      () => M.processes.execute({ sort: "cpu", top: 10 }, h.context),
      Error,
      `${N2}: talosctl processes failed`,
    );
    assertEquals(h.written(), []);
  }));

Deno.test("kubeconfig writes what talosctl prints", () =>
  withStub(
    [["kubeconfig -", out("apiVersion: v1\nkind: Config\n")]],
    async (h) => {
      await M.kubeconfig.execute({}, h.context);
      const [w] = h.written();
      assertEquals([w.spec, w.name, w.data.kubeconfig], [
        "kubeconfig",
        "main",
        "apiVersion: v1\nkind: Config\n",
      ]);
    },
  ));

Deno.test("kubeconfig fails when talosctl does, and writes nothing", () =>
  withStub([["kubeconfig", fail("not authorized")]], async (h) => {
    await assertRejects(
      () => M.kubeconfig.execute({}, h.context),
      Error,
      "talosctl kubeconfig failed (exit 1): not authorized",
    );
    assertEquals(h.written(), []);
  }));

const GiB = 2 ** 30;
const recs = (...r: unknown[]) =>
  out(r.map((x) => JSON.stringify(x)).join("\n"));

Deno.test("volumes writes a layout per usable node and skips one without disks", () =>
  withStub([
    [
      "get disks -o json",
      recs({
        node: N1,
        metadata: { id: "vda" },
        spec: { dev_path: "/dev/vda", size: 30 * GiB },
      }),
    ],
    [
      "get discoveredvolumes -o json",
      recs({
        node: N1,
        metadata: { id: "vda1" },
        spec: {
          dev_path: "/dev/vda1",
          parent_dev_path: "/dev/vda",
          partition_index: 1,
          partition_label: "STATE",
          size: 100 * 2 ** 20,
        },
      }, {
        node: N1,
        metadata: { id: "vda5" },
        spec: {
          dev_path: "/dev/vda5",
          parent_dev_path: "/dev/vda",
          partition_index: 5,
          partition_label: "EPHEMERAL",
          size: 10 * GiB,
        },
      }),
    ],
    [
      "get hostname -o json",
      recs({
        node: N1,
        metadata: { id: "hostname" },
        spec: { hostname: "wrkr-1" },
      }),
    ],
    [
      "usage -d 1 /var",
      out(`NODE SIZE NAME\n${N1} ${GiB} lib\n${N1} ${GiB} .\n`),
    ],
  ], async (h) => {
    await M.volumes.execute({}, h.context);
    const w = h.written();
    assertEquals(w.map((x) => [x.spec, x.name]), [[
      "volumeLayout",
      "volume-wrkr-1",
    ]]);
    assertEquals(w[0].data.ephemeralUsedPercent, 10);
    assertEquals(h.logs("warning"), ["{node}: skipped, {problem}"]);
    assertEquals(h.logs("info"), [
      "{host}: EPHEMERAL {used}% of {size} GiB, {free} MiB unallocated",
    ]);
  }));

Deno.test("volumes fails when no node has a usable layout", () =>
  withStub([
    ["get disks", out("")],
    ["get discoveredvolumes", out("")],
    ["get hostname", out("")],
    ["usage", out("")],
  ], async (h) => {
    await assertRejects(
      () => M.volumes.execute({}, h.context),
      Error,
      "no targeted node returned a usable disk layout",
    );
    assertEquals(h.written(), []);
  }));

/** The `result` record a lifecycle method writes. */
function result(h: Harness) {
  const w = h.written();
  assertEquals(w.length, 1);
  assertEquals(w[0].spec, "result");
  return w[0];
}

Deno.test("applyConfig applies the file and keeps talosctl's warnings", () =>
  withStub([
    [
      "apply-config --file /c.yaml --mode no-reboot --insecure",
      { stderr: "warning: one\n\nwarning: two\n" },
    ],
  ], async (h) => {
    await M.applyConfig.execute(
      { nodes: [N1], configFile: "/c.yaml", mode: "no-reboot", insecure: true },
      h.context,
    );
    const r = result(h);
    assertEquals(r.name, "applyConfig");
    assertEquals(r.data.message, `Config applied to ${N1} (mode=no-reboot)`);
    assertEquals(r.data.warnings, ["warning: one", "warning: two"]);
  }));

Deno.test("applyConfig retries a transient error and fails on a lasting one", () =>
  withStub([["apply-config", fail("connection refused")]], async (h) => {
    await assertRejects(
      () =>
        M.applyConfig.execute(
          { configFile: "/c.yaml", mode: "auto", insecure: false },
          h.context,
        ),
      Error,
      "talosctl apply-config failed (exit 1): connection refused",
    );
    assertEquals(h.calls.length, 13);
    assertEquals(h.written(), []);
  }));

Deno.test("bootstrap writes its result", () =>
  withStub([[`bootstrap --nodes ${N1}`, out("")]], async (h) => {
    await M.bootstrap.execute({ nodes: [N1] }, h.context);
    assertEquals(result(h).data.message, `Bootstrap initiated on ${N1}`);
  }));

Deno.test("bootstrap fails at once on an error that is not transient", () =>
  withStub(
    [["bootstrap", fail("etcd data directory is not empty")]],
    async (h) => {
      await assertRejects(
        () => M.bootstrap.execute({ nodes: [N1] }, h.context),
        Error,
        "etcd data directory is not empty",
      );
      assertEquals(h.calls.length, 1);
      assertEquals(h.written(), []);
    },
  ));

Deno.test("reboot in powercycle mode targets the given node", () =>
  withStub([[`reboot --mode powercycle --nodes ${N2}`, out("")]], async (h) => {
    await M.reboot.execute({ nodes: [N2], mode: "powercycle" }, h.context);
    const r = result(h);
    assertEquals([r.name, r.data.message], [
      "reboot",
      `Reboot (powercycle) initiated on ${N2}`,
    ]);
  }));

Deno.test("reboot fails when talosctl does, and writes nothing", () =>
  withStub([["reboot", fail("permission denied")]], async (h) => {
    await assertRejects(
      () => M.reboot.execute({ mode: "default" }, h.context),
      Error,
      "talosctl reboot failed (exit 1): permission denied",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("shutdown --force writes its result", () =>
  withStub([[`shutdown --force --nodes ${N1},${N2}`, out("")]], async (h) => {
    await M.shutdown.execute({ force: true }, h.context);
    assertEquals(result(h).data.message, `Shutdown initiated on ${N1},${N2}`);
  }));

Deno.test("shutdown fails when talosctl does, and writes nothing", () =>
  withStub([["shutdown", fail("permission denied")]], async (h) => {
    await assertRejects(
      () => M.shutdown.execute({ force: false }, h.context),
      Error,
      "talosctl shutdown failed",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("reset wipes only the named partitions", () =>
  withStub([
    [
      `reset --graceful=false --reboot --system-labels-to-wipe EPHEMERAL --nodes ${N1}`,
      out(""),
    ],
  ], async (h) => {
    await M.reset.execute({
      nodes: [N1],
      graceful: false,
      reboot: true,
      systemLabelsToWipe: ["EPHEMERAL"],
    }, h.context);
    assertEquals(
      result(h).data.message,
      `Reset initiated on ${N1} (graceful=false, wipe=EPHEMERAL)`,
    );
  }));

Deno.test("reset fails when talosctl does, and writes nothing", () =>
  withStub([["reset", fail("permission denied")]], async (h) => {
    await assertRejects(
      () => M.reset.execute({ graceful: true, reboot: false }, h.context),
      Error,
      "talosctl reset failed",
    );
    assertEquals(h.written(), []);
  }));

const IMAGE = "ghcr.io/siderolabs/installer:v1.14.1";

Deno.test("upgrade passes the image and --preserve", () =>
  withStub(
    [[`upgrade --image ${IMAGE} --preserve --nodes ${N1}`, out("")]],
    async (h) => {
      await M.upgrade.execute(
        { nodes: [N1], image: IMAGE, preserve: true },
        h.context,
      );
      assertEquals(
        result(h).data.message,
        `Upgrade to ${IMAGE} initiated on ${N1}`,
      );
    },
  ));

Deno.test("upgrade fails when talosctl does, and writes nothing", () =>
  withStub([["upgrade", fail("image not found")]], async (h) => {
    await assertRejects(
      () => M.upgrade.execute({ image: IMAGE, preserve: false }, h.context),
      Error,
      "talosctl upgrade failed (exit 1): image not found",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("patchConfig patches with the file and writes its result", () =>
  withStub([
    ["patch machineconfig --patch-file /p.yaml --mode auto", out("")],
  ], async (h) => {
    await M.patchConfig.execute(
      { patchFile: "/p.yaml", mode: "auto" },
      h.context,
    );
    const r = result(h);
    assertEquals([r.name, r.data.warnings], ["patchConfig", undefined]);
    assertEquals(r.data.message, `Config patched on ${N1},${N2} (mode=auto)`);
  }));

Deno.test("patchConfig fails when talosctl does, and writes nothing", () =>
  withStub([["patch", fail("invalid patch")]], async (h) => {
    await assertRejects(
      () =>
        M.patchConfig.execute(
          { patchFile: "/p.yaml", mode: "auto" },
          h.context,
        ),
      Error,
      "talosctl patch failed (exit 1): invalid patch",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("health runs from the first control plane and writes its result", () =>
  withStub([
    machineType(N1, "worker"),
    machineType(N2, "controlplane"),
    [`health --wait-timeout 30s --nodes ${N2}`, out("all checks passed\n")],
  ], async (h) => {
    await M.health.execute({ waitTimeout: "30s" }, h.context);
    const r = result(h);
    assertEquals([r.name, r.data.message], [
      "health",
      `${N2}: all checks passed`,
    ]);
  }));

Deno.test("health fails when the check does, and writes nothing", () =>
  withStub([
    [`health --wait-timeout 10s --nodes ${N1}`, fail("etcd is unhealthy")],
  ], async (h) => {
    await assertRejects(
      () => M.health.execute({ node: N1, waitTimeout: "10s" }, h.context),
      Error,
      "talosctl health failed (exit 1): etcd is unhealthy",
    );
    assertEquals(h.written(), []);
  }));

// ───── credentials: the Omni key and the talosconfig content ─────

const KEY_MARK = "omni-key-marker-7f3a9c";
const CONFIG_MARK = "talosconfig-marker-e41d06";
const SECRET_ARGS: GlobalArgs = {
  ...G,
  nodes: [N1],
  serviceAccountKey: KEY_MARK,
  talosconfigContent: CONFIG_MARK,
};

/**
 * Run `body` with a runner that answers `reply` and records, per call, the
 * talosconfig path talosctl was given, whether that file held the content,
 * and the Omni key in its environment. The real runner is put back after.
 */
async function withSecretStub(
  reply: (seen: string) => RunResult,
  body: (
    context: ModelContext,
    seen: { path: string; content: string; key: string }[],
    t: ReturnType<typeof createModelTestContext>,
  ) => Promise<void>,
): Promise<void> {
  const seen: { path: string; content: string; key: string }[] = [];
  __setRunner(async (argv, opts) => {
    const path = argv[argv.indexOf("--talosconfig") + 1];
    const content = await Deno.readTextFile(path);
    seen.push({ path, content, key: opts.env.OMNI_SERVICE_ACCOUNT_KEY });
    return reply(`${content} ${opts.env.OMNI_SERVICE_ACCOUNT_KEY}`);
  });
  const t = createModelTestContext({ globalArgs: SECRET_ARGS });
  try {
    await body(t.context as unknown as ModelContext, seen, t);
  } finally {
    __setRunner();
  }
}

function assertNoMarker(where: string, text: string): void {
  for (const m of [KEY_MARK, CONFIG_MARK]) {
    assertEquals(text.includes(m), false, `${where} holds ${m}`);
  }
}

async function gone(path: string): Promise<boolean> {
  return await Deno.stat(path).then(() => false, () => true);
}

Deno.test("a talosctl error that echoes the Omni key and the talosconfig content reaches no error, log or record", () =>
  withSecretStub(
    (both) => ({
      code: 1,
      stdout: "",
      stderr: `rpc error: code = Unauthenticated: rejected ${both}`,
    }),
    async (context, seen, t) => {
      const err = await assertRejects(
        () => M.version.execute({}, context),
        Error,
        "talosctl version failed (exit 1): rpc error: code = Unauthenticated: rejected [REDACTED] [REDACTED]",
      );
      // the stub really got both values, so the redaction had work to do
      assertEquals(seen.map((s) => [s.content, s.key]), [
        [CONFIG_MARK, KEY_MARK],
      ]);
      assertNoMarker("the error", err.message);
      assertNoMarker("the logs", JSON.stringify(t.getLogs()));
      assertNoMarker("the records", JSON.stringify(t.getWrittenResources()));
      assertEquals(t.getWrittenResources(), []);
      assertEquals(await gone(seen[0].path), true, "temporary talosconfig");
    },
  ));

Deno.test("a successful call with both secrets set records and logs neither, and removes the temporary talosconfig", () =>
  withSecretStub(
    () => ({
      code: 0,
      stdout: JSON.stringify({
        version: { tag: "v1.14.1", sha: "abc", arch: "amd64" },
        platform: { name: "metal" },
      }),
      stderr: "",
    }),
    async (context, seen, t) => {
      await M.version.execute({}, context);
      assertEquals(seen.length, 1);
      assertEquals(seen[0].path.includes("talosconfig-"), true);
      assertEquals(
        t.getWrittenResources().map((w) => w.name),
        ["version-192-0-2-1"],
      );
      assertNoMarker("the logs", JSON.stringify(t.getLogs()));
      assertNoMarker("the records", JSON.stringify(t.getWrittenResources()));
      assertEquals(await gone(seen[0].path), true, "temporary talosconfig");
    },
  ));

// ───── the pre-flight checks that run talosctl or read a file ─────

const C = model.checks;

async function withRunner<T>(
  reply: (argv: string[]) => RunResult,
  body: (calls: string[][]) => Promise<T>,
): Promise<T> {
  const calls: string[][] = [];
  __setRunner((argv) => {
    calls.push(argv);
    return Promise.resolve(reply(argv));
  });
  try {
    return await body(calls);
  } finally {
    __setRunner();
  }
}

Deno.test("talosctl-available passes when talosctl reports its client version", () =>
  withRunner(
    () => ({ code: 0, stdout: "Client:\n\tTag: v1.14.1\n", stderr: "" }),
    async (calls) => {
      const r = await C["talosctl-available"].execute({
        globalArgs: { talosctlPath: "/opt/talosctl" } as GlobalArgs,
      });
      assertEquals(r, { pass: true });
      assertEquals(calls, [["/opt/talosctl", "version", "--client"]]);
    },
  ));

Deno.test("talosctl-available fails with talosctl's error when it cannot run", () =>
  withRunner(
    () => ({ code: 126, stdout: "", stderr: "permission denied" }),
    async () => {
      const r = await C["talosctl-available"].execute({
        globalArgs: { talosctlPath: "/opt/talosctl" } as GlobalArgs,
      });
      assertEquals(r.pass, false);
      assertStringIncludes(
        r.errors![0],
        "talosctl version failed (exit 126): permission denied",
      );
    },
  ));

Deno.test("talosconfig-exists passes for a file that exists, for none named, and when content is given", async () => {
  const path = await Deno.makeTempFile();
  try {
    const ok = (g: Partial<GlobalArgs>) =>
      C["talosconfig-exists"].execute({ globalArgs: g as GlobalArgs });
    assertEquals(await ok({ talosconfig: path }), { pass: true });
    assertEquals(await ok({}), { pass: true });
    assertEquals(
      await ok({ talosconfig: "/nope/talosconfig", talosconfigContent: "x" }),
      { pass: true },
    );
  } finally {
    await Deno.remove(path);
  }
});

Deno.test("talosconfig-exists fails for a named file that is missing, also with empty content", async () => {
  for (const g of [{}, { talosconfigContent: "" }]) {
    const r = await C["talosconfig-exists"].execute({
      globalArgs: { talosconfig: "/nope/talosconfig", ...g } as GlobalArgs,
    });
    assertEquals(r, {
      pass: false,
      errors: ["talosconfig not found: /nope/talosconfig"],
    });
  }
});

const CONTEXTS = "CURRENT   NAME   ENDPOINTS\n*         prod   192.0.2.1\n" +
  "          lab    192.0.2.10\n";

Deno.test("talos-context-exists passes for a named context the talosconfig has, and without one runs nothing", () =>
  withRunner(
    () => ({ code: 0, stdout: CONTEXTS, stderr: "" }),
    async (calls) => {
      const g = {
        talosctlPath: "talosctl",
        talosconfig: "/etc/tc",
        retryDelayMs: 0,
      };
      assertEquals(
        await C["talos-context-exists"].execute({
          globalArgs: { ...g, talosContext: "lab" } as GlobalArgs,
        }),
        { pass: true },
      );
      assertEquals(calls, [[
        "talosctl",
        "config",
        "contexts",
        "--talosconfig",
        "/etc/tc",
      ]]);
      assertEquals(
        await C["talos-context-exists"].execute({
          globalArgs: g as GlobalArgs,
        }),
        { pass: true },
      );
      assertEquals(calls.length, 1);
    },
  ));

Deno.test("talos-context-exists fails for a context the talosconfig lacks and names the ones it has", () =>
  withRunner(
    () => ({ code: 0, stdout: CONTEXTS, stderr: "" }),
    async () => {
      const r = await C["talos-context-exists"].execute({
        globalArgs: {
          talosctlPath: "talosctl",
          talosContext: "staging",
          retryDelayMs: 0,
        } as GlobalArgs,
      });
      assertEquals(r, {
        pass: false,
        errors: [
          'talosContext "staging" is not in the talosconfig; it has prod, lab',
        ],
      });
    },
  ));

Deno.test("talos-context-exists fails with talosctl's error, the talosconfig content redacted", () =>
  withRunner(
    (argv) => ({
      code: 1,
      stdout: "",
      stderr: `failed to parse ${
        Deno.readTextFileSync(argv[argv.indexOf("--talosconfig") + 1])
      }`,
    }),
    async () => {
      const r = await C["talos-context-exists"].execute({
        globalArgs: {
          talosctlPath: "talosctl",
          talosContext: "prod",
          talosconfigContent: CONFIG_MARK,
          retryDelayMs: 0,
        } as GlobalArgs,
      });
      assertEquals(r, {
        pass: false,
        errors: ["talosctl config failed (exit 1): failed to parse [REDACTED]"],
      });
    },
  ));
