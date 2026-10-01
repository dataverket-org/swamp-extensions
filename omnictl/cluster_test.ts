import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  configPatchFromResource,
  extensionsScope,
  LABELS,
  model,
  patchData,
  patchScope,
  ROLE_PREFIX,
  roleLabel,
  TYPES,
} from "./cluster.ts";
import { __setRunner, type RunResult } from "./omnictl.ts";

const g = {
  endpoint: "https://omni.example.net",
  serviceAccountKey: "s3cret-key",
  insecureSkipTlsVerify: false,
  omnictlPath: "omnictl",
};
const M = "a68effa4-132f-4312-8a2c-4aebca678228";

function makeContext() {
  const written: {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  const deleted: string[] = [];
  return {
    written,
    deleted,
    context: {
      globalArgs: g,
      logger: { info() {}, warning() {} },
      writeResource(spec: string, name: string, data: Record<string, unknown>) {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
      deleteResource(name: string) {
        deleted.push(name);
        return Promise.resolve();
      },
    },
  };
}

const ok = (stdout = ""): RunResult => ({ code: 0, stdout, stderr: "" });
const gone = (): RunResult => ({
  code: 1,
  stdout: "",
  stderr: "resource doesn't exist",
});
const json = (r: unknown) => JSON.stringify(r);
const WORKER = `${ROLE_PREFIX}worker`;
const workers = (labels: Record<string, string> = {
  [LABELS.cluster]: "prod",
  [WORKER]: "",
}) => ({ metadata: { id: "prod-workers", labels }, spec: {} });

Deno.test("patchScope picks machine, machineSet+cluster or cluster and rejects mixes", () => {
  assertEquals(patchScope({ machine: M }), {
    scope: "machine",
    labels: { [LABELS.machine]: M },
  });
  assertEquals(patchScope({ machineSet: "prod-workers", cluster: "prod" }), {
    scope: "machineSet",
    labels: { [LABELS.cluster]: "prod", [LABELS.machineSet]: "prod-workers" },
  });
  assertEquals(patchScope({ cluster: "prod" }).scope, "cluster");
  let threw = 0;
  for (
    const bad of [{}, { machineSet: "x" }, { machine: M, machineSet: "x" }]
  ) {
    try {
      patchScope(bad);
    } catch {
      threw++;
    }
  }
  assertEquals(threw, 3);
});

Deno.test("applyPatch writes the resource as a file, applies it, reads it back and stores it", async () => {
  const calls: string[][] = [];
  let applied: Record<string, unknown> | undefined;
  __setRunner(async (argv) => {
    calls.push(argv);
    if (argv[1] === "apply") {
      applied = JSON.parse(await Deno.readTextFile(argv[3]));
      return ok("created");
    }
    if (argv[1] === "get") {
      return ok(json({
        metadata: {
          id: "500-wrkr-4-storage",
          labels: { [LABELS.machine]: M },
        },
        spec: { data: "machine:\n  kubelet: {}\n" },
      }));
    }
    return gone();
  });
  const { context, written } = makeContext();
  try {
    const r = await model.methods.applyPatch.execute({
      id: "500-wrkr-4-storage",
      data: "machine:\n  kubelet: {}\n",
      machine: M,
      dryRun: false,
    }, context);
    assertEquals(r.dataHandles.length, 1);
    assertEquals(calls[0].slice(0, 3), ["omnictl", "apply", "-f"]);
    assertEquals(applied?.metadata, {
      namespace: "default",
      type: TYPES.configPatch,
      id: "500-wrkr-4-storage",
      labels: { [LABELS.machine]: M },
    });
    assertEquals(calls[1].slice(0, 4), [
      "omnictl",
      "get",
      TYPES.configPatch,
      "500-wrkr-4-storage",
    ]);
    assertEquals(written[0].name, "configpatch-500-wrkr-4-storage");
    assertEquals(written[0].data.scope, "machine");
    assertEquals(written[0].data.machine, M);
  } finally {
    __setRunner();
  }
});

Deno.test("dryRun passes --dry-run and stores nothing", async () => {
  const calls: string[][] = [];
  __setRunner((argv) => {
    calls.push(argv);
    if (argv[1] === "get" && argv[2] === TYPES.machineSet) {
      return Promise.resolve(ok(json(workers())));
    }
    return Promise.resolve(ok("would create"));
  });
  const { context, written } = makeContext();
  try {
    const r = await model.methods.addMachine.execute({
      machine: M,
      cluster: "prod",
      machineSet: "prod-workers",
      dryRun: true,
    }, context);
    assertEquals(r.dataHandles.length, 0);
    assertEquals(written.length, 0);
    assertEquals(calls.length, 2);
    assertEquals(calls[0].slice(1, 4), [
      "get",
      TYPES.machineSet,
      "prod-workers",
    ]);
    assertEquals(calls[1].includes("--dry-run"), true);
  } finally {
    __setRunner();
  }
});

Deno.test("addMachine applies a MachineSetNode with cluster, machine-set and the set's role label and stores it", async () => {
  let applied: Record<string, unknown> | undefined;
  __setRunner(async (argv) => {
    if (argv[1] === "apply") {
      applied = JSON.parse(await Deno.readTextFile(argv[3]));
      return ok();
    }
    if (argv[1] === "get" && argv[2] === TYPES.machineSet) {
      return ok(json(workers()));
    }
    if (argv[1] === "get" && argv[2] === TYPES.machineSetNode) {
      return ok(json({
        metadata: {
          id: M,
          labels: {
            [LABELS.cluster]: "prod",
            [LABELS.machineSet]: "prod-workers",
            [WORKER]: "",
          },
        },
        spec: {},
      }));
    }
    throw new Error(`unexpected omnictl call: ${argv.join(" ")}`);
  });
  const { context, written } = makeContext();
  try {
    await model.methods.addMachine.execute({
      machine: M,
      cluster: "prod",
      machineSet: "prod-workers",
      dryRun: false,
    }, context);
    assertEquals(applied?.metadata, {
      namespace: "default",
      type: TYPES.machineSetNode,
      id: M,
      labels: {
        [LABELS.cluster]: "prod",
        [LABELS.machineSet]: "prod-workers",
        [WORKER]: "",
      },
    });
    assertEquals(applied?.spec, {});
    assertEquals(written[0].name, `machinesetnode-${M}`);
    assertEquals(written[0].data.machineSet, "prod-workers");
    assertEquals(written[0].data.role, WORKER);
  } finally {
    __setRunner();
  }
});

Deno.test("addMachine refuses a missing machine set, one of another cluster, or one without a single role, and applies nothing", async () => {
  const cases: [string, unknown, string][] = [
    ["missing", null, "does not exist"],
    [
      "other cluster",
      workers({ [LABELS.cluster]: "staging", [WORKER]: "" }),
      "belongs to cluster staging, not prod",
    ],
    [
      "no cluster label",
      workers({ [WORKER]: "" }),
      "belongs to cluster (none), not prod",
    ],
    ["no role", workers({ [LABELS.cluster]: "prod" }), "has 0 role labels"],
    [
      "two roles",
      workers({
        [LABELS.cluster]: "prod",
        [WORKER]: "",
        [`${ROLE_PREFIX}controlplane`]: "",
      }),
      "has 2 role labels",
    ],
  ];
  for (const [name, set, message] of cases) {
    for (const dryRun of [false, true]) {
      const calls: string[][] = [];
      __setRunner((argv) => {
        calls.push(argv);
        if (argv[1] === "get" && argv[2] === TYPES.machineSet) {
          return Promise.resolve(set === null ? gone() : ok(json(set)));
        }
        throw new Error(`unexpected omnictl call (${name}): ${argv.join(" ")}`);
      });
      const { context, written } = makeContext();
      try {
        await assertRejects(
          () =>
            model.methods.addMachine.execute({
              machine: M,
              cluster: "prod",
              machineSet: "prod-workers",
              dryRun,
            }, context),
          Error,
          message,
        );
        assertEquals(calls.length, 1, `${name}: only the machine set is read`);
        assertEquals(written.length, 0, `${name}: nothing is stored`);
      } finally {
        __setRunner();
      }
    }
  }
});

Deno.test("roleLabel returns the machine set's one role label", () => {
  assertEquals(roleLabel(workers() as never, "prod-workers", "prod"), WORKER);
  assertEquals(
    roleLabel(
      workers({
        [LABELS.cluster]: "prod",
        [`${ROLE_PREFIX}controlplane`]: "",
      }) as never,
      "prod-control-planes",
      "prod",
    ),
    `${ROLE_PREFIX}controlplane`,
  );
});

Deno.test("removeMachine refuses an unassigned machine, otherwise deletes with a timeout and drops the record", async () => {
  const calls: string[][] = [];
  let assigned = false;
  __setRunner((argv) => {
    calls.push(argv);
    if (argv[1] === "get") {
      return Promise.resolve(
        assigned ? ok(json({ metadata: { id: M }, spec: {} })) : gone(),
      );
    }
    return Promise.resolve(ok());
  });
  const { context, deleted } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.removeMachine.execute(
          { machine: M, timeout: "15m" },
          context,
        ),
      Error,
      "no machine set",
    );
    assigned = true;
    await model.methods.removeMachine.execute(
      { machine: M, timeout: "20m" },
      context,
    );
    const del = calls.find((c) => c[1] === "cluster");
    assertEquals(del, [
      "omnictl",
      "cluster",
      "machine",
      "delete",
      M,
      "--timeout",
      "20m",
    ]);
    assertEquals(deleted, [`machinesetnode-${M}`]);
  } finally {
    __setRunner();
  }
});

Deno.test("configPatchFromResource reads scope from labels", () => {
  const p = configPatchFromResource({
    metadata: {
      id: "100-x",
      labels: { [LABELS.cluster]: "prod", [LABELS.machineSet]: "prod-workers" },
    },
    spec: { data: "x" },
  }, "t");
  assertEquals(p.scope, "machineSet");
  assertEquals(p.cluster, "prod");
  assertEquals(p.machine, null);
});

Deno.test("extensionsScope labels and names a machine, a machine set or a cluster configuration, and rejects both", () => {
  assertEquals(
    extensionsScope({ cluster: "prod", machine: M }),
    {
      scope: "machine",
      id: `schematic-${M}`,
      labels: { [LABELS.cluster]: "prod", [LABELS.clusterMachine]: M },
    },
  );
  assertEquals(
    extensionsScope({ cluster: "prod", machineSet: "prod-workers" }),
    {
      scope: "machineSet",
      id: "schematic-prod-workers",
      labels: { [LABELS.cluster]: "prod", [LABELS.machineSet]: "prod-workers" },
    },
  );
  assertEquals(extensionsScope({ cluster: "prod", id: "kata" }).id, "kata");
  assertEquals(extensionsScope({ cluster: "prod" }).scope, "cluster");
  let threw = false;
  try {
    extensionsScope({
      cluster: "prod",
      machine: M,
      machineSet: "prod-workers",
    });
  } catch (e) {
    threw = (e as Error).message.includes("one of machine or machineSet");
  }
  assertEquals(threw, true);
});

Deno.test("setExtensions applies the configuration, reads it back and stores it; dryRun stores nothing", async () => {
  let applied: Record<string, unknown> | undefined;
  const calls: string[][] = [];
  __setRunner(async (argv) => {
    calls.push(argv);
    if (argv[1] === "apply") {
      applied = JSON.parse(await Deno.readTextFile(argv[3]));
      return ok("ok");
    }
    if (argv[1] === "get" && argv[2] === TYPES.extensionsConfiguration) {
      return ok(json({
        metadata: { id: "schematic-prod-workers" },
        spec: { extensions: ["siderolabs/kata-containers"] },
      }));
    }
    throw new Error(`unexpected omnictl call: ${argv.join(" ")}`);
  });
  const { context, written } = makeContext();
  try {
    await model.methods.setExtensions.execute({
      cluster: "prod",
      machineSet: "prod-workers",
      extensions: ["siderolabs/kata-containers"],
      dryRun: false,
    }, context);
    assertEquals(applied?.metadata, {
      namespace: "default",
      type: TYPES.extensionsConfiguration,
      id: "schematic-prod-workers",
      labels: { [LABELS.cluster]: "prod", [LABELS.machineSet]: "prod-workers" },
    });
    assertEquals(applied?.spec, { extensions: ["siderolabs/kata-containers"] });
    assertEquals(written[0].data.extensions, ["siderolabs/kata-containers"]);
    assertEquals(written[0].data.scope, "machineSet");
    const before = calls.length;
    const r = await model.methods.setExtensions.execute({
      cluster: "prod",
      machine: M,
      extensions: [],
      dryRun: true,
    }, context);
    assertEquals(r.dataHandles.length, 0);
    assertEquals(written.length, 1);
    assertEquals(calls.length, before + 1);
    assertEquals(calls.at(-1)!.includes("--dry-run"), true);
  } finally {
    __setRunner();
  }
});

Deno.test("setExtensions rejects a malformed extension name before calling omnictl", () => {
  __setRunner((argv) => {
    throw new Error(`unexpected omnictl call: ${argv.join(" ")}`);
  });
  try {
    const parsed = model.methods.setExtensions.arguments.safeParse({
      cluster: "prod",
      machine: M,
      extensions: ["kata-containers; rm -rf /"],
    });
    assertEquals(parsed.success, false);
  } finally {
    __setRunner();
  }
});

function deleteRunner(
  calls: string[][],
  state: { node: boolean; machine: boolean },
) {
  return (argv: string[]) => {
    calls.push(argv);
    if (argv[1] === "get" && argv[2] === TYPES.machineSetNode) {
      return Promise.resolve(
        state.node
          ? ok(json({
            metadata: {
              id: M,
              labels: { [LABELS.machineSet]: "prod-workers" },
            },
            spec: {},
          }))
          : gone(),
      );
    }
    if (argv[1] === "get" && argv[2] === TYPES.link) {
      return Promise.resolve(
        state.machine ? ok(json({ metadata: { id: M }, spec: {} })) : gone(),
      );
    }
    if (argv[1] === "get" && argv[2] === TYPES.configPatch) {
      return Promise.resolve(ok(
        json({
          metadata: { id: "500-mine", labels: { [LABELS.machine]: M } },
          spec: {},
        }) +
          json({
            metadata: {
              id: "500-other",
              labels: {
                [LABELS.machine]: "b02c2eaa-edec-4668-bceb-2fe63517836b",
              },
            },
            spec: {},
          }) +
          json({
            metadata: {
              id: "400-set",
              labels: { [LABELS.machineSet]: "prod-workers" },
            },
            spec: {},
          }),
      ));
    }
    if (argv[1] === "delete") return Promise.resolve(ok());
    throw new Error(`unexpected omnictl call: ${argv.join(" ")}`);
  };
}

Deno.test("deleteMachine deletes the machine's own config patches, then its Link, never the read-only Machine", async () => {
  const calls: string[][] = [];
  __setRunner(deleteRunner(calls, { node: false, machine: true }));
  const { context, written } = makeContext();
  try {
    await model.methods.deleteMachine.execute({ machine: M }, context);
    assertEquals(
      calls.filter((c) => c[1] === "delete").map((c) => c.slice(2, 4)),
      [[TYPES.configPatch, "500-mine"], [TYPES.link, M]],
    );
    assertEquals(written.length, 0);
  } finally {
    __setRunner();
  }
});

Deno.test("deleteMachine refuses a machine still in a machine set and deletes nothing", async () => {
  const calls: string[][] = [];
  __setRunner(deleteRunner(calls, { node: true, machine: true }));
  const { context } = makeContext();
  try {
    await assertRejects(
      () => model.methods.deleteMachine.execute({ machine: M }, context),
      Error,
      "still in machine set prod-workers; removeMachine first",
    );
    assertEquals(calls.some((c) => c[1] === "delete"), false);
  } finally {
    __setRunner();
  }
});

Deno.test("deleteMachine is a no-op when Omni has no such machine", async () => {
  const calls: string[][] = [];
  __setRunner(deleteRunner(calls, { node: false, machine: false }));
  const { context } = makeContext();
  try {
    await model.methods.deleteMachine.execute({ machine: M }, context);
    assertEquals(calls.some((c) => c[1] === "delete"), false);
    assertEquals(calls.some((c) => c[2] === TYPES.configPatch), false);
  } finally {
    __setRunner();
  }
});

Deno.test("patchData takes data as given, or reads dataFile relative to the repository, and refuses both or neither", async () => {
  const repo = await Deno.makeTempDir({ prefix: "omnictl-repo-" });
  try {
    await Deno.mkdir(`${repo}/talos`);
    await Deno.writeTextFile(`${repo}/talos/p.yaml`, "machine: {}\n");
    assertEquals(patchData({ data: "a: 1" }), "a: 1");
    assertEquals(patchData({ dataFile: "talos/p.yaml" }, repo), "machine: {}");
    assertEquals(
      patchData({ dataFile: `${repo}/talos/p.yaml` }, "/elsewhere"),
      "machine: {}",
    );
    let errors: string[] = [];
    for (
      const a of [{ data: "x", dataFile: "talos/p.yaml" }, {}, {
        dataFile: "talos/missing.yaml",
      }]
    ) {
      try {
        patchData(a, repo);
      } catch (e) {
        errors.push((e as Error).message);
      }
    }
    assertEquals(errors.length, 3);
    assertEquals(errors[0], "applyPatch takes data or dataFile, not both");
    assertEquals(errors[1], "applyPatch needs data or dataFile");
    assertEquals(errors[2].includes(`${repo}/talos/missing.yaml`), true);
    errors = [];
  } finally {
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("applyPatch with dataFile sends the file's contents to Omni", async () => {
  const repo = await Deno.makeTempDir({ prefix: "omnictl-repo-" });
  let applied: Record<string, unknown> | undefined;
  __setRunner(async (argv) => {
    if (argv[1] === "apply") {
      applied = JSON.parse(await Deno.readTextFile(argv[3]));
      return ok("ok");
    }
    if (argv[1] === "get" && argv[2] === TYPES.configPatch) {
      return ok(json({
        metadata: { id: "500-x", labels: { [LABELS.machine]: M } },
        spec: { data: "machine: {}" },
      }));
    }
    throw new Error(`unexpected omnictl call: ${argv.join(" ")}`);
  });
  const { context } = makeContext();
  try {
    await Deno.writeTextFile(`${repo}/p.yaml`, "machine: {}\n");
    await model.methods.applyPatch.execute({
      id: "500-x",
      dataFile: "p.yaml",
      machine: M,
      dryRun: false,
    }, { ...context, repoDir: repo });
    assertEquals(
      (applied?.spec as Record<string, unknown>).data,
      "machine: {}",
    );
  } finally {
    __setRunner();
    await Deno.remove(repo, { recursive: true });
  }
});

Deno.test("the Link type is the one Omni accepts a delete on", () => {
  assertEquals(TYPES.link, "Links.omni.sidero.dev");
});
