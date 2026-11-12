import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  clusterMembers,
  decodeJoinTokenState,
  fingerprint,
  model,
} from "./inventory.ts";
import { cosi, KEY, withStub } from "./test_support.ts";
import { parseOmnictlJson } from "./omnictl.ts";
import { mergeInventory } from "./transform.ts";

const g = {
  endpoint: "https://omni.example.net",
  serviceAccountKey: "s3cret-key",
  insecureSkipTlsVerify: false,
  omnictlPath: "omnictl",
};

const identity = (id: string, cluster: string, name: string, ip: string) =>
  JSON.stringify({
    metadata: { id, labels: { "omni.sidero.dev/cluster": cluster } },
    spec: { nodename: name, nodeips: [ip] },
  });

Deno.test("clusterMembers filters by cluster and sorts by hostname", () => {
  const ids = parseOmnictlJson(
    identity("m2", "prod", "wrkr-1", "10.0.0.3") +
      identity("m1", "prod", "ctrl-1", "10.0.0.2") +
      identity("m3", "lab", "x", "10.0.0.9"),
  );
  assertEquals(clusterMembers(ids, "prod").map((m) => [m.hostname, m.nodeIp]), [
    ["ctrl-1", "10.0.0.2"],
    ["wrkr-1", "10.0.0.3"],
  ]);
});

Deno.test("parseOmnictlJson splits concatenated objects", () => {
  const rs = parseOmnictlJson(
    `{"metadata": {"id": "a"}, "spec": {}}\n{"metadata": {"id": "b"}, "spec": {"s": "}"}}`,
  );
  assertEquals(rs.map((r) => r.metadata.id), ["a", "b"]);
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

Deno.test("decodeJoinTokenState maps integers and names", () => {
  assertEquals(decodeJoinTokenState(2), "revoked");
  assertEquals(decodeJoinTokenState("EXPIRED"), "expired");
  assertEquals(decodeJoinTokenState(undefined), "unknown");
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const TOKEN = "TEST-JOIN-TOKEN-abcdef";
const DENIED = {
  code: 1,
  stderr: `rpc error: code = PermissionDenied desc = key ${KEY} is not valid`,
};

Deno.test("joinTokens writes each token by name with a fingerprint, never the token", () =>
  withStub([
    ["get jointokenstatus -o json", {
      stdout: cosi(TOKEN, {
        name: "default",
        state: 1,
        isdefault: true,
        usecount: 3,
      }),
    }],
  ], async (h) => {
    await model.methods.joinTokens.execute({}, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.state, w.data.isDefault], [
      "joinToken",
      "jointoken-default",
      "active",
      true,
    ]);
    assertEquals(w.data.fingerprint, await fingerprint(TOKEN));
    assertEquals(JSON.stringify(h.written()).includes(TOKEN), false);
    assertEquals(h.logs().some((l) => l.text.includes(TOKEN)), false);
    assertEquals(h.logs().at(-1)?.message, "omni: {count} join tokens");
  }));

Deno.test("joinTokens fails when omnictl does, with the key redacted, and writes nothing", () =>
  withStub([["get jointokenstatus", DENIED]], async (h) => {
    const err = await assertRejects(
      () => model.methods.joinTokens.execute({}, h.context),
      Error,
      "omnictl get failed (exit 1): rpc error: code = PermissionDenied",
    );
    assertStringIncludes(err.message, "[REDACTED]");
    assertEquals(err.message.includes(KEY), false);
    assertEquals(h.written(), []);
  }));

const machine = cosi("m1", {
  cluster: "prod",
  connected: true,
  network: { hostname: "ctrl-1" },
});

Deno.test("discover writes a node, a cluster and a summary", () =>
  withStub([
    ["get machinestatus ", { stdout: machine }],
    ["get clustermachinestatus ", {
      stdout: cosi("m1", { stage: 4, ready: true }, {
        "omni.sidero.dev/role-controlplane": null,
      }),
    }],
    ["get clustermachineidentity ", { stdout: "" }],
    ["get cluster ", { stdout: cosi("prod") }],
  ], async (h) => {
    await model.methods.discover.execute({}, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name]), [
      ["node", "node-m1"],
      ["cluster", "cluster-prod"],
      ["summary", "summary"],
    ]);
    assertEquals(h.written()[2].data.totalNodes, 1);
    assertEquals(
      h.logs().some((l) => l.message.startsWith("omni: discovered")),
      true,
    );
  }));

Deno.test("discover writes nothing when one of its reads fails", () =>
  withStub([
    ["get machinestatus ", { stdout: machine }],
    ["get clustermachinestatus ", { stdout: "" }],
    ["get clustermachineidentity ", DENIED],
    ["get cluster ", { stdout: cosi("prod") }],
  ], async (h) => {
    await assertRejects(
      () => model.methods.discover.execute({}, h.context),
      Error,
      "omnictl get failed (exit 1)",
    );
    assertEquals(h.written(), []);
  }));

const CONFIG = "context: prod\ncontexts:\n  prod:\n    endpoints: [x]\n";
const identityOf = (id: string, name: string, ip: string) =>
  cosi(id, { nodename: name, nodeips: [ip] }, {
    "omni.sidero.dev/cluster": "prod",
  });

Deno.test("talosconfig stores the minted config with the cluster's nodes, and logs no config", () =>
  withStub([
    ["talosconfig -c prod --merge=false --force ", async (argv) => {
      await Deno.writeTextFile(argv[argv.indexOf("--force") + 1], CONFIG);
      return {};
    }],
    ["get clustermachineidentity ", {
      stdout: identityOf("m2", "wrkr-1", "10.0.0.3") +
        identityOf("m1", "ctrl-1", "10.0.0.2"),
    }],
  ], async (h) => {
    await model.methods.talosconfig.execute({ cluster: "prod" }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.nodes, w.data.hostnames], [
      "talosconfig",
      "talosconfig-prod",
      ["10.0.0.2", "10.0.0.3"],
      ["ctrl-1", "wrkr-1"],
    ]);
    assertEquals(w.data.content, CONFIG);
    assertEquals(JSON.stringify(w.data).includes(KEY), false);
    assertEquals(h.logs().some((l) => l.text.includes("contexts")), false);
  }));

Deno.test("talosconfig refuses a cluster with no machines, and writes nothing", () =>
  withStub([
    ["talosconfig -c lab ", async (argv) => {
      await Deno.writeTextFile(argv[argv.indexOf("--force") + 1], CONFIG);
      return {};
    }],
    ["get clustermachineidentity ", {
      stdout: identityOf("m1", "c", "10.0.0.2"),
    }],
  ], async (h) => {
    await assertRejects(
      () => model.methods.talosconfig.execute({ cluster: "lab" }, h.context),
      Error,
      "cluster lab has no machines with node IPs in Omni",
    );
    assertEquals(h.written(), []);
  }));
