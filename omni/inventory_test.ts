import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { clusterMembers, model } from "./inventory.ts";
import { __setRunner, parseOmnictlJson } from "./omnictl.ts";
import { mergeInventory } from "./transform.ts";

const g = {
  endpoint: "https://omni.example.net",
  serviceAccountKey: "s3cret-key",
  insecureSkipTlsVerify: false,
  omnictlPath: "omnictl",
  talosctlPath: "talosctl",
};

function makeContext() {
  const written: {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  return {
    written,
    context: {
      globalArgs: g,
      logger: { info() {}, warn() {} },
      writeResource(spec: string, name: string, data: Record<string, unknown>) {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

const identity = (id: string, cluster: string, name: string, ip: string) =>
  JSON.stringify({
    metadata: { id, labels: { "omni.sidero.dev/cluster": cluster } },
    spec: { nodename: name, nodeips: [ip] },
  });
const rec = (node: string, spec: Record<string, unknown>) =>
  JSON.stringify({ metadata: { id: "x" }, node, spec });

Deno.test("parseOmnictlJson splits concatenated objects", () => {
  const rs = parseOmnictlJson(
    `{"metadata": {"id": "a"}, "spec": {}}\n{"metadata": {"id": "b"}, "spec": {"s": "}"}}`,
  );
  assertEquals(rs.map((r) => r.metadata.id), ["a", "b"]);
});

Deno.test("clusterMembers filters by cluster and sorts by hostname", () => {
  const ids = parseOmnictlJson(
    identity("m2", "prod", "wrkr-1", "10.0.0.3") +
      identity("m1", "prod", "ctrl-1", "10.0.0.2") +
      identity("m3", "lab", "x", "10.0.0.9"),
  );
  assertEquals(clusterMembers(ids, "prod").map((m) => m.hostname), [
    "ctrl-1",
    "wrkr-1",
  ]);
});

Deno.test("mergeInventory still folds machines into nodes and clusters", () => {
  const merged = mergeInventory({
    endpoint: g.endpoint,
    machineStatuses: [{
      metadata: { id: "m1", labels: {} },
      spec: {
        cluster: "prod",
        connected: true,
        network: { hostname: "ctrl-1" },
      },
    }],
    clusterMachineStatuses: [{
      metadata: {
        id: "m1",
        labels: { "omni.sidero.dev/role-controlplane": null },
      },
      spec: { stage: 4, ready: true },
    }],
    clusterMachineIdentities: [],
    clusters: [{ metadata: { id: "prod" }, spec: {} }],
  }, "t");
  assertEquals(merged.nodes[0].role, "controlplane");
  assertEquals(merged.clusters[0].controlPlaneCount, 1);
});

Deno.test("volumes mints a talosconfig, reads all nodes, and removes the file", async () => {
  const calls: { argv: string[]; env: Record<string, string> }[] = [];
  let cfgPath = "";
  __setRunner((argv, env) => {
    calls.push({ argv, env });
    const l = argv.join(" ");
    if (l.includes(" get clustermachineidentity ")) {
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: identity("m1", "prod", "ctrl-1", "10.0.0.2") +
          identity("m2", "prod", "wrkr-1", "10.0.0.3"),
      });
    }
    if (argv[1] === "talosconfig") {
      cfgPath = argv[6];
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    if (l.includes("get disks")) {
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: rec("10.0.0.2", { dev_path: "/dev/vda", size: 100 }) +
          rec("10.0.0.3", { dev_path: "/dev/vda", size: 100 }),
      });
    }
    if (l.includes("get discoveredvolumes")) {
      const p = (node: string, label: string, i: number, size: number) =>
        rec(node, {
          dev_path: `/dev/vda${i}`,
          parent_dev_path: "/dev/vda",
          partition_index: i,
          partition_label: label,
          size,
        });
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: p("10.0.0.2", "STATE", 1, 10) +
          p("10.0.0.2", "EPHEMERAL", 2, 80) +
          p("10.0.0.3", "STATE", 1, 10) + p("10.0.0.3", "EPHEMERAL", 2, 90),
      });
    }
    if (l.includes("usage")) {
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: "NODE SIZE NAME\n10.0.0.2 40 .\n10.0.0.3 45 .\n",
      });
    }
    return Promise.reject(new Error(`unexpected ${l}`));
  });
  const { context, written } = makeContext();
  try {
    await model.methods.volumes.execute({ cluster: "prod" }, context);
    assertEquals(written.map((w) => w.name), [
      "volume-ctrl-1",
      "volume-wrkr-1",
    ]);
    assertEquals(written[0].data.systemDiskUnallocatedBytes, 10);
    assertEquals(written[1].data.ephemeralUsedPercent, 50);
    assertEquals(
      calls.every((c) =>
        c.env.OMNI_SERVICE_ACCOUNT_KEY === g.serviceAccountKey
      ),
      true,
    );
    assertEquals(
      calls.filter((c) => c.argv[0] === "talosctl").every((c) =>
        c.argv.includes("10.0.0.2,10.0.0.3")
      ),
      true,
    );
    let exists = true;
    try {
      await Deno.stat(cfgPath);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    __setRunner();
  }
});

Deno.test("a failing omnictl redacts the key from the error", async () => {
  __setRunner(() =>
    Promise.resolve({
      code: 1,
      stdout: "",
      stderr: `auth failed for key ${g.serviceAccountKey}`,
    })
  );
  const { context } = makeContext();
  try {
    await assertRejects(
      () => model.methods.discover.execute({}, context),
      Error,
      "[REDACTED]",
    );
  } finally {
    __setRunner();
  }
});
