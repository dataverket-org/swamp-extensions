import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  configPatchFromResource,
  LABELS,
  model,
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

Deno.test("forgetMachine refuses a machine still in a cluster, is a no-op without a link, else deletes the link", async () => {
  const calls: string[][] = [];
  let cluster = "prod";
  let linked = true;
  __setRunner((argv) => {
    calls.push(argv);
    if (argv[1] === "get" && argv[2] === TYPES.machineStatus) {
      return Promise.resolve(
        ok(json({ metadata: { id: M }, spec: { cluster } })),
      );
    }
    if (argv[1] === "get" && argv[2] === TYPES.link) {
      return Promise.resolve(
        linked ? ok(json({ metadata: { id: M }, spec: {} })) : gone(),
      );
    }
    return Promise.resolve(ok());
  });
  const { context } = makeContext();
  try {
    await assertRejects(
      () => model.methods.forgetMachine.execute({ machine: M }, context),
      Error,
      "still in cluster prod",
    );
    cluster = "";
    linked = false;
    await model.methods.forgetMachine.execute({ machine: M }, context);
    assertEquals(calls.some((c) => c[1] === "delete"), false);
    linked = true;
    await model.methods.forgetMachine.execute({ machine: M }, context);
    assertEquals(calls.at(-1), ["omnictl", "delete", TYPES.link, M]);
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
