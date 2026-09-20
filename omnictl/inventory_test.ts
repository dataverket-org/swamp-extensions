import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  clusterMembers,
  decodeJoinTokenState,
  fingerprint,
  model,
} from "./inventory.ts";
import { __setRunner, parseOmnictlJson } from "./omnictl.ts";
import { mergeInventory } from "./transform.ts";

const g = {
  endpoint: "https://omni.example.net",
  serviceAccountKey: "s3cret-key",
  insecureSkipTlsVerify: false,
  omnictlPath: "omnictl",
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
      logger: { info() {}, warning() {} },
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

Deno.test("talosconfig mints into a private temp file, stores the content, removes the file", async () => {
  let cfgPath = "";
  __setRunner(async (argv, env) => {
    if (argv[1] === "get") {
      return {
        code: 0,
        stderr: "",
        stdout: identity("m1", "prod", "ctrl-1", "10.0.0.2") +
          identity("m2", "prod", "wrkr-1", "10.0.0.3"),
      };
    }
    if (argv[1] !== "talosconfig") {
      return { code: 1, stdout: "", stderr: "unexpected" };
    }
    cfgPath = argv[6];
    assertEquals(env.OMNI_SERVICE_ACCOUNT_KEY, g.serviceAccountKey);
    await Deno.writeTextFile(cfgPath, "context: prod\ncontexts: {}\n");
    return { code: 0, stdout: "", stderr: "" };
  });
  const { context, written } = makeContext();
  try {
    await model.methods.talosconfig.execute({ cluster: "prod" }, context);
    assertEquals(written.map((w) => [w.spec, w.name]), [[
      "talosconfig",
      "talosconfig-prod",
    ]]);
    assertEquals(written[0].data.content, "context: prod\ncontexts: {}\n");
    assertEquals(written[0].data.endpoint, g.endpoint);
    assertEquals(written[0].data.nodes, ["10.0.0.2", "10.0.0.3"]);
    assertEquals(written[0].data.hostnames, ["ctrl-1", "wrkr-1"]);
    let exists = true;
    try {
      await Deno.stat(cfgPath);
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "temp file removed");
    exists = true;
    try {
      await Deno.stat(cfgPath.replace(/\/talosconfig$/, ""));
    } catch {
      exists = false;
    }
    assertEquals(exists, false, "temp dir removed");
  } finally {
    __setRunner();
  }
});

Deno.test("talosconfig removes the temp file when omnictl fails", async () => {
  let cfgPath = "";
  __setRunner((argv) => {
    if (argv[1] === "get") {
      return Promise.resolve({ code: 0, stdout: "", stderr: "" });
    }
    cfgPath = argv[6];
    return Promise.resolve({ code: 1, stdout: "", stderr: "no such cluster" });
  });
  const { context } = makeContext();
  try {
    await assertRejects(
      () => model.methods.talosconfig.execute({ cluster: "nope" }, context),
      Error,
      "no such cluster",
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

Deno.test("joinTokens stores name, state and default flag and never the token", async () => {
  const token = "v2:Zm9vYmFy-the-secret-token";
  __setRunner((argv) => {
    if (argv[1] === "get" && argv[2] === "jointokenstatus") {
      return Promise.resolve({
        code: 0,
        stderr: "",
        stdout: JSON.stringify({
          metadata: { id: token, namespace: "default" },
          spec: {
            name: "initial",
            state: 1,
            isdefault: true,
            usecount: 6,
            expirationtime: "",
          },
        }) + JSON.stringify({
          metadata: { id: "old-token", namespace: "default" },
          spec: { name: "old", state: "REVOKED", usecount: 0 },
        }),
      });
    }
    return Promise.resolve({ code: 1, stdout: "", stderr: "unexpected" });
  });
  const { context, written } = makeContext();
  try {
    const r = await model.methods.joinTokens.execute({}, context);
    assertEquals(r.dataHandles.length, 2);
    assertEquals(written.map((w) => w.name), [
      "jointoken-initial",
      "jointoken-old",
    ]);
    assertEquals(written[0].data.state, "active");
    assertEquals(written[0].data.isDefault, true);
    assertEquals(written[0].data.useCount, 6);
    assertEquals(written[0].data.expirationTime, null);
    assertEquals(written[0].data.fingerprint, await fingerprint(token));
    assertEquals(written[1].data.state, "revoked");
    assertEquals(JSON.stringify(written).includes(token), false);
  } finally {
    __setRunner();
  }
});

Deno.test("decodeJoinTokenState maps integers and names", () => {
  assertEquals(decodeJoinTokenState(2), "revoked");
  assertEquals(decodeJoinTokenState("EXPIRED"), "expired");
  assertEquals(decodeJoinTokenState(undefined), "unknown");
});
