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
import { cosi, NOT_FOUND, withStub } from "./test_support.ts";

const M = "a68effa4-132f-4312-8a2c-4aebca678228";

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

Deno.test("the Link type is the one Omni accepts a delete on", () => {
  assertEquals(TYPES.link, "Links.omni.sidero.dev");
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const C = model.methods;

/** An `omnictl apply -f <file>` answer that keeps what was applied. */
function applied(seen: Record<string, unknown>[], stdout = "") {
  return async (argv: string[]) => {
    seen.push(
      JSON.parse(await Deno.readTextFile(argv[argv.indexOf("-f") + 1])),
    );
    return { stdout };
  };
}

const PATCH = "machine:\n  kubelet: {}\n";

Deno.test("applyPatch applies the patch, reads it back and stores it", async () => {
  const seen: Record<string, unknown>[] = [];
  await withStub([
    ["apply -f ", applied(seen)],
    [`get ${TYPES.configPatch} 500-x -o json`, {
      stdout: cosi("500-x", { data: PATCH }, { [LABELS.machine]: M }),
    }],
  ], async (h) => {
    await C.applyPatch.execute(
      { id: "500-x", data: PATCH, machine: M, dryRun: false },
      h.context,
    );
    assertEquals(seen[0].spec, { data: PATCH });
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.scope, w.data.machine, w.data.data], [
      "configPatch",
      "configpatch-500-x",
      "machine",
      M,
      PATCH,
    ]);
  });
});

Deno.test("applyPatch fails when omnictl apply does, and writes nothing", () =>
  withStub([
    ["apply -f ", { code: 1, stderr: "validation failed: bad patch" }],
  ], async (h) => {
    await assertRejects(
      () =>
        C.applyPatch.execute(
          { id: "500-x", data: PATCH, cluster: "prod", dryRun: false },
          h.context,
        ),
      Error,
      "omnictl apply failed (exit 1): validation failed: bad patch",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("addMachine creates the node with the set's role label and stores it", async () => {
  const seen: Record<string, unknown>[] = [];
  await withStub([
    [`get ${TYPES.machineSet} prod-workers `, {
      stdout: JSON.stringify(workers()),
    }],
    ["apply -f ", applied(seen)],
    [`get ${TYPES.machineSetNode} ${M} `, {
      stdout: cosi(M, {}, {
        [LABELS.cluster]: "prod",
        [LABELS.machineSet]: "prod-workers",
        [WORKER]: "",
      }),
    }],
  ], async (h) => {
    await C.addMachine.execute(
      {
        machine: M,
        cluster: "prod",
        machineSet: "prod-workers",
        dryRun: false,
      },
      h.context,
    );
    const meta = seen[0].metadata as { id: string; labels: object };
    assertEquals([meta.id, WORKER in meta.labels], [M, true]);
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.machineSet, w.data.role], [
      "machineSetNode",
      `machinesetnode-${M}`,
      "prod-workers",
      WORKER,
    ]);
  });
});

Deno.test("addMachine refuses a machine set of another cluster and applies nothing", () =>
  withStub([
    [`get ${TYPES.machineSet} prod-workers `, {
      stdout: JSON.stringify(
        workers({ [LABELS.cluster]: "lab", [WORKER]: "" }),
      ),
    }],
  ], async (h) => {
    await assertRejects(
      () =>
        C.addMachine.execute(
          {
            machine: M,
            cluster: "prod",
            machineSet: "prod-workers",
            dryRun: false,
          },
          h.context,
        ),
      Error,
      "machine set prod-workers belongs to cluster lab, not prod",
    );
    assertEquals(h.calls.some((c) => c.startsWith("apply")), false);
    assertEquals(h.written(), []);
  }));

Deno.test("removeMachine deletes the machine from its cluster and drops its record", () =>
  withStub([
    [`get ${TYPES.machineSetNode} ${M} `, { stdout: cosi(M) }],
    [`cluster machine delete ${M} --timeout 15m`, { stdout: "" }],
  ], async (h) => {
    await C.removeMachine.execute({ machine: M, timeout: "15m" }, h.context);
    assertEquals(h.deleted, [`machinesetnode-${M}`]);
    assertEquals(
      h.logs().at(-1)?.message,
      "omnictl: machine {machine} removed and wiped",
    );
  }));

Deno.test("removeMachine refuses a machine in no machine set and deletes nothing", () =>
  withStub([[`get ${TYPES.machineSetNode} ${M} `, NOT_FOUND]], async (h) => {
    await assertRejects(
      () => C.removeMachine.execute({ machine: M, timeout: "15m" }, h.context),
      Error,
      `machine ${M} is in no machine set; nothing to remove`,
    );
    assertEquals(h.calls.some((c) => c.startsWith("cluster")), false);
    assertEquals(h.deleted, []);
  }));

Deno.test("deleteMachine deletes the machine's own patches and its Link", () =>
  withStub([
    [`get ${TYPES.machineSetNode} ${M} `, NOT_FOUND],
    [`get ${TYPES.link} ${M} `, { stdout: cosi(M) }],
    [`get ${TYPES.configPatch} -o json`, {
      stdout: cosi("400-mine", {}, { [LABELS.machine]: M }) +
        cosi("400-other", {}, { [LABELS.machine]: "other" }),
    }],
    [`delete ${TYPES.configPatch} 400-mine`, { stdout: "" }],
    [`delete ${TYPES.link} ${M}`, { stdout: "" }],
  ], async (h) => {
    await C.deleteMachine.execute({ machine: M }, h.context);
    assertEquals(h.calls.filter((c) => c.startsWith("delete")), [
      `delete ${TYPES.configPatch} 400-mine`,
      `delete ${TYPES.link} ${M}`,
    ]);
    assertEquals(h.written(), []);
  }));

Deno.test("deleteMachine refuses a machine still in a machine set and deletes nothing", () =>
  withStub([
    [`get ${TYPES.machineSetNode} ${M} `, {
      stdout: cosi(M, {}, { [LABELS.machineSet]: "prod-workers" }),
    }],
  ], async (h) => {
    await assertRejects(
      () => C.deleteMachine.execute({ machine: M }, h.context),
      Error,
      `machine ${M} is still in machine set prod-workers; removeMachine first`,
    );
    assertEquals(h.calls.some((c) => c.startsWith("delete")), false);
  }));

const KATA = "siderolabs/kata-containers";

Deno.test("setExtensions applies the configuration and stores what Omni returns", async () => {
  const seen: Record<string, unknown>[] = [];
  await withStub([
    ["apply -f ", applied(seen)],
    [`get ${TYPES.extensionsConfiguration} schematic-prod-workers `, {
      stdout: cosi("schematic-prod-workers", { extensions: [KATA] }),
    }],
  ], async (h) => {
    await C.setExtensions.execute(
      {
        cluster: "prod",
        machineSet: "prod-workers",
        extensions: [KATA],
        dryRun: false,
      },
      h.context,
    );
    assertEquals(seen[0].spec, { extensions: [KATA] });
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.scope, w.data.extensions], [
      "extensionsConfiguration",
      "schematic-prod-workers",
      "machineSet",
      [KATA],
    ]);
  });
});

Deno.test("setExtensions fails when Omni does not return what was applied, and writes nothing", () =>
  withStub([
    ["apply -f ", { stdout: "" }],
    [`get ${TYPES.extensionsConfiguration} schematic-prod `, NOT_FOUND],
  ], async (h) => {
    await assertRejects(
      () =>
        C.setExtensions.execute(
          { cluster: "prod", extensions: [KATA], dryRun: false },
          h.context,
        ),
      Error,
      "extensions schematic-prod were applied but Omni returns no ExtensionsConfiguration",
    );
    assertEquals(h.written(), []);
  }));
