import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  type GlobalArgs,
  model,
  options,
  parseContexts,
  parseEtcdMembers,
  parseServices,
  serviceAccountKey,
  talosctlPathOf,
} from "./node.ts";
import { talosctlArgs } from "./talosctl.ts";
import { fail, installFake, makeContext, ok } from "./test_support.ts";
import { talosctl as runTalosctl } from "./talosctl.ts";

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

Deno.test("the live check spawns talosctl even without the schema default", async () => {
  // A check sees the definition's global arguments as written, with no schema
  // defaults applied: a definition that never names talosctlPath leaves it
  // undefined, and spawning with that is what "missing field `cmd`" was.
  const fake = installFake(() => ok("v1.14.0"));
  try {
    const result = await model.checks["talosctl-available"].execute(
      { globalArgs: {} as GlobalArgs },
    );
    assertEquals(result.pass, true);
    assertEquals(fake.calls[0].args[0], "version");
    assertEquals(talosctlPathOf({}), "talosctl");
  } finally {
    fake.restore();
  }
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

Deno.test("talos-context-exists accepts a named context the config has", async () => {
  const fake = installFake(() =>
    ok(
      "CURRENT   NAME        ENDPOINTS\n" +
        "*         fabrikk     https://omni.example.com\n" +
        "          lab         192.0.2.10\n",
    )
  );
  try {
    const result = await model.checks["talos-context-exists"].execute(
      { globalArgs: { talosContext: "lab" } as GlobalArgs },
    );
    assertEquals(result.pass, true);
    // listed without --context: the missing one would only report itself
    assertEquals(fake.calls[0].args, ["config", "contexts"]);
  } finally {
    fake.restore();
  }
});

Deno.test("talos-context-exists names the contexts there are instead", async () => {
  const fake = installFake(() =>
    ok(
      "CURRENT   NAME        ENDPOINTS\n" +
        "*         fabrikk     https://omni.example.com\n" +
        "          lab         192.0.2.10\n",
    )
  );
  try {
    const result = await model.checks["talos-context-exists"].execute(
      { globalArgs: { talosContext: "gone" } as GlobalArgs },
    );
    assertEquals(result.pass, false);
    assertStringIncludes(result.errors![0], '"gone" is not in the talosconfig');
    assertStringIncludes(result.errors![0], "fabrikk, lab");
  } finally {
    fake.restore();
  }
});

Deno.test("talos-context-exists redacts the talosconfig out of a failure", async () => {
  const secret = "SECRET-TALOSCONFIG-BODY";
  const fake = installFake(() => fail(`bad config: ${secret}`));
  try {
    const result = await model.checks["talos-context-exists"].execute({
      globalArgs: {
        talosContext: "lab",
        talosconfigContent: secret,
      } as GlobalArgs,
    });
    assertEquals(result.pass, false);
    assertEquals(result.errors![0].includes(secret), false);
    assertStringIncludes(result.errors![0], "[REDACTED]");
  } finally {
    fake.restore();
  }
});

Deno.test("talos-context-exists passes when no context is named at all", async () => {
  const fake = installFake(() => undefined);
  try {
    const result = await model.checks["talos-context-exists"].execute(
      { globalArgs: {} as GlobalArgs },
    );
    assertEquals(result.pass, true);
    assertEquals(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
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
  const { context } = makeContext({ endpoint: "192.0.2.5" });
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
      "192.0.2.5",
      "--nodes",
      "192.0.2.5",
    ]);
  } finally {
    fake.restore();
  }
});

Deno.test("a failing talosctl surfaces its stderr", async () => {
  const fake = installFake(() => fail("rpc error: permission denied"));
  const { context } = makeContext({ endpoint: "192.0.2.5" });
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

Deno.test("a key file reaches the environment and never the error", async () => {
  const dir = await Deno.makeTempDir({ prefix: "talosctl-key-" });
  const path = `${dir}/reader.key`;
  await Deno.writeTextFile(path, "KEY123\n");
  const fake = installFake(() => fail("denied for KEY123"));
  const { context } = makeContext({
    nodes: ["a"],
    serviceAccountKeyFile: path,
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
    await Deno.remove(dir, { recursive: true });
  }
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

Deno.test("talosconfigContent is materialized per call and removed afterwards", async () => {
  let seen = "";
  let path = "";
  const fake = installFake((args) => {
    path = args[args.indexOf("--talosconfig") + 1];
    seen = Deno.readTextFileSync(path);
    return "ok";
  });
  try {
    const r = await runTalosctl(
      {
        talosctlPath: "t",
        nodes: ["a"],
        talosconfigContent: "context: x\n",
        retryDelayMs: 0,
      },
      ["version"],
    );
    assertEquals(r.stdout, "ok");
    assertEquals(seen, "context: x\n");
    let exists = true;
    try {
      await Deno.stat(path);
    } catch {
      exists = false;
    }
    assertEquals(exists, false);
  } finally {
    fake.restore();
  }
});

Deno.test("talosconfigContent wins over a talosconfig path, once, and skips the path check", async () => {
  let argv: string[] = [];
  const fake = installFake((args) => {
    argv = args;
    return "ok";
  });
  try {
    await runTalosctl(
      {
        talosctlPath: "t",
        nodes: ["a"],
        talosconfig: "/nonexistent/talosconfig",
        talosconfigContent: "context: x\n",
        retryDelayMs: 0,
      },
      ["version"],
    );
    const idx = argv.indexOf("--talosconfig");
    assertEquals(argv.lastIndexOf("--talosconfig"), idx, "flag appears once");
    assertEquals(argv[idx + 1] !== "/nonexistent/talosconfig", true);
  } finally {
    fake.restore();
  }
  const g = {
    insecure: false,
    talosctlPath: "t",
    retryDelayMs: 0,
    talosconfig: "/nonexistent/talosconfig",
    talosconfigContent: "context: x\n",
  };
  assertEquals(
    (await model.checks["talosconfig-exists"].execute({ globalArgs: g })).pass,
    true,
  );
  assertEquals(
    (await model.checks["talosconfig-exists"].execute({
      globalArgs: { ...g, talosconfigContent: "" },
    })).pass,
    false,
    "empty content is unset, so the bogus path fails the check",
  );
});
