import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, options, parseEtcdMembers, parseServices } from "./node.ts";
import { talosctlArgs } from "./talosctl.ts";
import { fail, installFake, makeContext } from "./test_support.ts";
import { talosctl as runTalosctl } from "./talosctl.ts";

Deno.test("options targets nodes, falls back to endpoint, refuses neither", () => {
  assertEquals(
    options({
      endpoint: "10.0.0.1",
      insecure: false,
      talosctlPath: "t",
      retryDelayMs: 0,
    }).nodes,
    ["10.0.0.1"],
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

Deno.test("parseServices and parseEtcdMembers read the tables", () => {
  assertEquals(
    parseServices(
      "NODE SERVICE STATE HEALTH LAST CHANGE\n10.0.0.1 apid Running OK 1m\n",
    ),
    [{ node: "10.0.0.1", id: "apid", state: "Running", health: "OK" }],
  );
  assertEquals(
    parseEtcdMembers(
      "NODE ID HOSTNAME PEER CLIENT LEARNER\n10.0.0.1 abc ctrl-1 https://p:2380 https://c:2379 false\n",
    )[0].hostname,
    "ctrl-1",
  );
});

Deno.test("volumes writes one layout per node from four reads", async () => {
  const rec = (node: string, spec: Record<string, unknown>) =>
    JSON.stringify({ metadata: { id: "x" }, node, spec });
  const fake = installFake((args) => {
    const l = args.join(" ");
    if (l.startsWith("get disks")) {
      return rec("n1", { dev_path: "/dev/vda", size: 100 }) +
        rec("n2", { dev_path: "/dev/vda", size: 200 });
    }
    if (l.startsWith("get discoveredvolumes")) {
      return rec("n1", {
        dev_path: "/dev/vda1",
        parent_dev_path: "/dev/vda",
        partition_index: 1,
        partition_label: "STATE",
        size: 10,
      }) + rec("n1", {
        dev_path: "/dev/vda2",
        parent_dev_path: "/dev/vda",
        partition_index: 2,
        partition_label: "EPHEMERAL",
        size: 80,
      }) + rec("n2", {
        dev_path: "/dev/vda1",
        parent_dev_path: "/dev/vda",
        partition_index: 1,
        partition_label: "STATE",
        size: 200,
      });
    }
    if (l.startsWith("get hostname")) {
      return rec("n1", { hostname: "one" }) + rec("n2", { hostname: "two" });
    }
    if (l.startsWith("usage")) {
      return "NODE SIZE NAME\nn1 30 lib\nn1 10 log\nn1 40 .\n";
    }
    return undefined;
  });
  const { context, written } = makeContext({ nodes: ["n1", "n2"] });
  try {
    await model.methods.volumes.execute({}, context);
    assertEquals(written.map((w) => [w.spec, w.name]), [
      ["volumeLayout", "volume-one"],
    ], "n2 has no usage row and is skipped");
    assertEquals(written[0].data.systemDiskUnallocatedBytes, 10);
    assertEquals(written[0].data.ephemeralUsedPercent, 50);
    assertEquals(fake.calls.every((c) => c.args.includes("n1,n2")), true);
  } finally {
    fake.restore();
  }
});

Deno.test("reset passes graceful, reboot and the labels to wipe", async () => {
  const fake = installFake(() => "");
  const { context } = makeContext({ endpoint: "10.0.0.5" });
  try {
    await model.methods.reset.execute(
      { graceful: true, reboot: true, systemLabelsToWipe: ["EPHEMERAL"] },
      context,
    );
    assertEquals(fake.calls[0].args, [
      "reset",
      "--reboot",
      "--system-labels-to-wipe",
      "EPHEMERAL",
      "--endpoints",
      "10.0.0.5",
      "--nodes",
      "10.0.0.5",
    ]);
  } finally {
    fake.restore();
  }
});

Deno.test("a failing talosctl surfaces its stderr", async () => {
  const fake = installFake(() => fail("rpc error: permission denied"));
  const { context } = makeContext({ endpoint: "10.0.0.5" });
  try {
    await assertRejects(
      () => model.methods.version.execute({}, context),
      Error,
      "permission denied",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("transient errors are retried the requested number of times", async () => {
  let n = 0;
  const fake = installFake(() => {
    n++;
    return n < 3 ? fail("rpc error: connection refused") : "ok";
  });
  try {
    const r = await runTalosctl(
      { talosctlPath: "t", nodes: ["a"], retryDelayMs: 0 },
      ["version"],
      { retries: 5 },
    );
    assertEquals(r.stdout, "ok");
    assertEquals(n, 3);
    n = 0;
    await assertRejects(
      () =>
        runTalosctl({ talosctlPath: "t", nodes: ["a"], retryDelayMs: 0 }, [
          "version",
        ], { retries: 1 }),
      Error,
      "connection refused",
    );
    assertEquals(n, 2, "gives up after retries");
  } finally {
    fake.restore();
  }
});

Deno.test("the service-account key reaches the environment and never the error", async () => {
  const fake = installFake(() => fail("denied for KEY123"));
  const { context } = makeContext({
    nodes: ["a"],
    serviceAccountKey: "KEY123",
    retryDelayMs: 0,
  });
  try {
    await assertRejects(
      () => model.methods.version.execute({}, context),
      Error,
      "[REDACTED]",
    );
    assertEquals(fake.calls[0].env.OMNI_SERVICE_ACCOUNT_KEY, "KEY123");
  } finally {
    fake.restore();
  }
});
