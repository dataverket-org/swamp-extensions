import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { model } from "./node.ts";
import { fail, installFake, makeContext, type Script } from "./test_support.ts";

/** The node a fan-out-free call addresses, from `--nodes`. */
function nodeOf(args: string[]): string {
  return args[args.indexOf("--nodes") + 1];
}

/**
 * A fake cluster of two control planes and a worker, answering the way
 * talosctl does: a worker refuses etcd, and a node in `down` does not answer
 * at all. `extra` answers whatever the test is about.
 */
function cluster(down: string[] = [], extra: Script = () => undefined) {
  const types: Record<string, string> = {
    cp1: "controlplane",
    cp2: "controlplane",
    w1: "worker",
  };
  return installFake((args) => {
    const node = nodeOf(args);
    if (down.includes(node)) {
      return fail(`rpc error: code = Unavailable desc = connection refused`);
    }
    const l = args.join(" ");
    if (l.startsWith("get machinetype")) {
      return JSON.stringify({
        metadata: { id: "machine-type" },
        node,
        spec: types[node],
      });
    }
    if (l.startsWith("etcd") && types[node] === "worker") {
      return fail(
        `error from node ${node}: rpc error: code = Unimplemented desc = member list is only available on control plane nodes`,
      );
    }
    return extra(args);
  });
}

const ALL = { nodes: ["w1", "cp1", "cp2"] };

Deno.test("etcdMembers asks one control plane, never the worker listed first", async () => {
  const fake = cluster(
    [],
    (args) =>
      args[0] === "etcd"
        ? "NODE ID HOSTNAME PEER CLIENT LEARNER\n" +
          `${nodeOf(args)} aa one https://cp1:2380 https://cp1:2379 false\n`
        : undefined,
  );
  const { context, written } = makeContext(ALL);
  try {
    await model.methods.etcdMembers.execute({}, context);
    const etcdCalls = fake.calls.filter((c) => c.args[0] === "etcd");
    assertEquals(etcdCalls.map((c) => nodeOf(c.args)), ["cp1"]);
    assertEquals(written.map((w) => w.name), ["etcd-one"]);
  } finally {
    fake.restore();
  }
});

Deno.test("etcdMembers falls through to the next control plane when one is down", async () => {
  const fake = cluster(
    ["cp1"],
    (args) =>
      args[0] === "etcd"
        ? "NODE ID HOSTNAME PEER CLIENT LEARNER\ncp2 bb two p c false\n"
        : undefined,
  );
  const { context, written } = makeContext(ALL);
  try {
    await model.methods.etcdMembers.execute({}, context);
    assertEquals(written.map((w) => w.name), ["etcd-two"]);
  } finally {
    fake.restore();
  }
});

Deno.test("with no control plane among the targets, etcd calls say so", async () => {
  const fake = cluster();
  const { context } = makeContext({ nodes: ["w1"] });
  try {
    await assertRejects(
      () => model.methods.etcdStatus.execute({}, context),
      Error,
      "no control plane among the reachable targets",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("etcdStatus records every control plane, an unreachable one as such", async () => {
  const header =
    "NODE   MEMBER   DB SIZE   IN USE          LEADER   RAFT INDEX   RAFT TERM   RAFT APPLIED INDEX   LEARNER   PROTOCOL   STORAGE   ERRORS\n";
  const fake = cluster([], (args) => {
    if (args[0] !== "etcd") return undefined;
    if (nodeOf(args) === "cp2") return fail("deadline exceeded");
    return header +
      "cp1    aa       30 MB     10 MB (35.30%)  aa       100          18          100                  false     3.7.1      3.7.0     \n";
  });
  const { context, written } = makeContext(ALL);
  try {
    await model.methods.etcdStatus.execute({}, context);
    assertEquals(written.map((w) => w.name), [
      "etcd-status-cp1",
      "etcd-status-cp2",
    ]);
    const [one, two] = written.map((w) => w.data);
    assertEquals(one.reachable, true);
    assertEquals(one.isLeader, true);
    assertEquals(one.dbSizeBytes, 30e6);
    assertEquals(one.dbInUsePercent, 35.3);
    assertEquals(one.raftIndex, 100);
    assertEquals(one.errors, "");
    assertEquals(two.reachable, false);
    assertStringIncludes(String(two.error), "deadline exceeded");
  } finally {
    fake.restore();
  }
});

Deno.test("nodes narrows a reboot to one machine, and refuses one outside the targets", async () => {
  const fake = cluster([], (args) => args[0] === "reboot" ? "" : undefined);
  const { context } = makeContext(ALL);
  try {
    await model.methods.reboot.execute(
      { nodes: ["cp1"], mode: "default" },
      context,
    );
    const reboot = fake.calls.filter((c) => c.args[0] === "reboot");
    assertEquals(reboot.map((c) => nodeOf(c.args)), ["cp1"]);
    await assertRejects(
      () =>
        model.methods.reboot.execute(
          { nodes: ["cp9"], mode: "default" },
          context,
        ),
      Error,
      "not among the definition's nodes: cp9",
    );
    assertEquals(
      fake.calls.filter((c) => c.args[0] === "reboot").length,
      1,
      "the refused call never reached talosctl",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("health runs from the first control plane, or from the one named", async () => {
  const fake = cluster([], (args) => args[0] === "health" ? "" : undefined);
  const { context, written } = makeContext(ALL);
  try {
    await model.methods.health.execute({ waitTimeout: "5s" }, context);
    await model.methods.health.execute(
      { node: "cp2", waitTimeout: "5s" },
      context,
    );
    const health = fake.calls.filter((c) => c.args[0] === "health");
    assertEquals(health.map((c) => nodeOf(c.args)), ["cp1", "cp2"]);
    assertStringIncludes(String(written[1].data.message), "cp2");
  } finally {
    fake.restore();
  }
});

Deno.test("serviceLogs counts matches inside the window and skips a node without the service", async () => {
  const now = Date.now();
  const iso = (ms: number) => new Date(now - ms).toISOString();
  const fake = cluster([], (args) => {
    if (args[0] !== "logs") return undefined;
    const node = nodeOf(args);
    if (node === "w1") return fail(`log "etcd" was not registered`);
    return [
      `${node}: {"ts":"${
        iso(3600_000)
      }","msg":"ignored streaming request; ID mismatch"}`,
      `${node}: {"ts":"${
        iso(5_000)
      }","msg":"ignored streaming request; ID mismatch"}`,
      `${node}: {"ts":"${iso(4_000)}","msg":"apply request took too long"}`,
      `${node}: not json, no time`,
    ].join("\n");
  });
  const { context, written } = makeContext(ALL);
  try {
    await model.methods.serviceLogs.execute({
      service: "etcd",
      tail: 100,
      match: "ID mismatch",
      sinceSeconds: 600,
      keep: 5,
    }, context);
    assertEquals(written.map((w) => w.name), [
      "log-cp1-etcd",
      "log-cp2-etcd",
    ]);
    const d = written[0].data;
    assertEquals(d.read, 4);
    assertEquals(d.counted, 3, "the hour-old line is outside the window");
    assertEquals(d.matched, 1);
    assertEquals((d.lines as string[]).length, 1);
    const tailArg = fake.calls.find((c) => c.args[0] === "logs")!.args;
    assertEquals(tailArg.slice(0, 3), ["logs", "etcd", "--tail"]);
  } finally {
    fake.restore();
  }
});

Deno.test("processes keeps the executable and drops every argument", async () => {
  const fake = cluster(
    [],
    (args) =>
      args[0] === "processes"
        ? "NODE   PID   STATE   THREADS   CPU-TIME   VIRTMEM   RESMEM   LABEL        COMMAND\n" +
          `${
            nodeOf(args)
          }    7     S       3         12.50      1 GB      2 MB     x:etcd_t:s0  /bin/app --password=hunter2\n`
        : undefined,
  );
  const { context, written } = makeContext({ nodes: ["cp1"] });
  try {
    await model.methods.processes.execute({ sort: "cpu", top: 5 }, context);
    const procs = written[0].data.processes as Record<string, unknown>[];
    assertEquals(procs[0].executable, "/bin/app");
    assertEquals(procs[0].cpuSeconds, 12.5);
    assertEquals(procs[0].residentBytes, 2e6);
    assertEquals(JSON.stringify(written).includes("hunter2"), false);
  } finally {
    fake.restore();
  }
});
