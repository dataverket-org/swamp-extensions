/**
 * `@dataverket/omnictl/cluster` — the writes an Omni Operator makes when a
 * cluster's machines change: a config patch, a machine joining a machine set,
 * a machine leaving its cluster, and a machine forgotten by Omni.
 *
 * Four methods, one `omnictl` call each, in the order a worker swap uses them:
 * `applyPatch` before `addMachine`, so the patch is in place when Omni first
 * provisions the machine; `removeMachine` drains, wipes and waits;
 * `forgetMachine` deletes the SideroLink `Link`, and refuses while the machine
 * is still in a cluster. Every write takes `dryRun`, which makes `omnictl
 * apply --dry-run` validate the resource and change nothing.
 *
 * Needs a service account with the Operator role. Keep it on its own model
 * instance with its own vault key, apart from the Reader key `inventory` uses.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  GlobalArgs,
  type MethodContext,
  type MethodResult,
  optionsOf,
} from "./common.ts";
import {
  applyResource,
  clusterMachineDelete,
  type CosiResource,
  deleteResource,
  getResource,
} from "./omnictl.ts";
import { sanitizeInstanceName } from "./schema.ts";

/** Omni's resource types, fully qualified so no alias lookup is involved. */
export const TYPES = {
  configPatch: "ConfigPatches.omni.sidero.dev",
  machineSetNode: "MachineSetNodes.omni.sidero.dev",
  machineStatus: "MachineStatuses.omni.sidero.dev",
  link: "Links.siderolink.omni.sidero.dev",
} as const;

/** Omni's label keys for patch and machine-set scoping. */
export const LABELS = {
  cluster: "omni.sidero.dev/cluster",
  machineSet: "omni.sidero.dev/machine-set",
  machine: "omni.sidero.dev/machine",
} as const;

const UUID = /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;
const Machine = z.string().regex(UUID).describe("Omni machine UUID");
const Name = z.string().min(1).regex(/^[A-Za-z0-9][A-Za-z0-9._-]*$/).describe(
  "Omni resource id: letters, digits, dot, dash, underscore",
);

/** A config patch as stored after `applyPatch`. */
export const ConfigPatchSchema = z.object({
  id: z.string().describe("Patch id; Omni applies patches in id order"),
  scope: z.enum(["machine", "machineSet", "cluster"]),
  machine: z.string().nullable(),
  machineSet: z.string().nullable(),
  cluster: z.string().nullable(),
  data: z.string().describe("The Talos machine config patch, YAML"),
  appliedAt: z.string(),
});

/** A machine's membership of a machine set as stored after `addMachine`. */
export const MachineSetNodeSchema = z.object({
  machine: z.string().describe("Omni machine UUID"),
  cluster: z.string(),
  machineSet: z.string(),
  appliedAt: z.string(),
});

const ApplyPatchArgs = z.object({
  id: Name.describe(
    "Patch id, e.g. 500-dataverket-wrkr-4-storage; an existing id is updated",
  ),
  data: z.string().min(1).describe("Talos machine config patch, YAML text"),
  machine: Machine.optional().describe(
    "Scope the patch to one machine, before or after it joins a cluster",
  ),
  machineSet: z.string().min(1).optional().describe(
    "Scope the patch to a machine set; needs cluster",
  ),
  cluster: z.string().min(1).optional().describe(
    "Scope the patch to a cluster, or name the machine set's cluster",
  ),
  dryRun: z.boolean().default(false).describe(
    "Validate with omnictl and change nothing",
  ),
});
const AddMachineArgs = z.object({
  machine: Machine,
  cluster: z.string().min(1).describe("Cluster name"),
  machineSet: z.string().min(1).describe(
    "Machine set id, e.g. <cluster>-workers",
  ),
  dryRun: z.boolean().default(false).describe(
    "Validate with omnictl and change nothing",
  ),
});
const RemoveMachineArgs = z.object({
  machine: Machine,
  timeout: z.string().regex(/^\d+(ms|s|m|h)$/).default("15m").describe(
    "How long omnictl waits for the drain and wipe",
  ),
});
const ForgetMachineArgs = z.object({ machine: Machine });

/** Which scope an `applyPatch` call asked for, and the labels it implies. */
export function patchScope(
  args: Pick<
    z.infer<typeof ApplyPatchArgs>,
    "machine" | "machineSet" | "cluster"
  >,
): {
  scope: "machine" | "machineSet" | "cluster";
  labels: Record<string, string>;
} {
  const given = [args.machine, args.machineSet].filter((v) => v).length;
  if (given > 1) {
    throw new Error("applyPatch takes one of machine or machineSet");
  }
  if (args.machine) {
    return { scope: "machine", labels: { [LABELS.machine]: args.machine } };
  }
  if (args.machineSet) {
    if (!args.cluster) {
      throw new Error("a machineSet patch needs its cluster");
    }
    return {
      scope: "machineSet",
      labels: {
        [LABELS.cluster]: args.cluster,
        [LABELS.machineSet]: args.machineSet,
      },
    };
  }
  if (args.cluster) {
    return { scope: "cluster", labels: { [LABELS.cluster]: args.cluster } };
  }
  throw new Error("applyPatch needs a machine, a machineSet or a cluster");
}

/** Fold a `ConfigPatch` resource read back from Omni into the stored shape. */
export function configPatchFromResource(
  r: CosiResource,
  appliedAt: string,
): z.infer<typeof ConfigPatchSchema> {
  const labels = (r.metadata.labels ?? {}) as Record<string, unknown>;
  const s = (k: string) => typeof labels[k] === "string" ? labels[k] : null;
  const machine = s(LABELS.machine);
  const machineSet = s(LABELS.machineSet);
  return {
    id: r.metadata.id,
    scope: machine ? "machine" : machineSet ? "machineSet" : "cluster",
    machine,
    machineSet,
    cluster: s(LABELS.cluster),
    data: typeof r.spec.data === "string" ? r.spec.data : "",
    appliedAt,
  };
}

const nodeName = (machine: string) =>
  `machinesetnode-${sanitizeInstanceName(machine)}`;

/**
 * `@dataverket/omnictl/cluster` — config patches and machine-set membership
 * through `omnictl apply`, machine removal through `omnictl cluster machine
 * delete`, and forgetting a machine through deleting its `Link`. Operator role.
 */
export const model = {
  type: "@dataverket/omnictl/cluster",
  version: "2026.09.20.1",
  globalArguments: GlobalArgs,
  resources: {
    configPatch: {
      description:
        "A Talos config patch in Omni, scoped to a machine, a machine set or a cluster",
      schema: ConfigPatchSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    machineSetNode: {
      description: "A machine's membership of an Omni machine set",
      schema: MachineSetNodeSchema,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
  },
  methods: {
    applyPatch: {
      description:
        "Create or update a ConfigPatch scoped to one machine (before or after it joins), a machine set, or a cluster; read it back and store it. dryRun validates only.",
      arguments: ApplyPatchArgs,
      execute: async (
        args: z.infer<typeof ApplyPatchArgs>,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        const { scope, labels } = patchScope(args);
        const resource: CosiResource = {
          metadata: {
            namespace: "default",
            type: TYPES.configPatch,
            id: args.id,
            labels,
          },
          spec: { data: args.data },
        };
        context.logger.info(
          "omnictl: {verb} config patch {id} ({scope})",
          { verb: args.dryRun ? "validating" : "applying", id: args.id, scope },
        );
        const out = await applyResource(
          resource,
          opts,
          context.signal,
          args.dryRun,
        );
        if (args.dryRun) {
          context.logger.info("omnictl: dry run\n{out}", { out: out.trim() });
          return { dataHandles: [] };
        }
        const back = await getResource(
          TYPES.configPatch,
          args.id,
          opts,
          context.signal,
        );
        if (!back) {
          throw new Error(
            `config patch ${args.id} was applied but Omni does not return it`,
          );
        }
        const handle = await context.writeResource(
          "configPatch",
          `configpatch-${sanitizeInstanceName(args.id)}`,
          configPatchFromResource(back, new Date().toISOString()),
        );
        return { dataHandles: [handle] };
      },
    },
    addMachine: {
      description:
        "Add a machine to a machine set by creating its MachineSetNode, which is what the Omni UI does; Omni then installs Talos with every patch in scope. dryRun validates only.",
      arguments: AddMachineArgs,
      execute: async (
        args: z.infer<typeof AddMachineArgs>,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        const resource: CosiResource = {
          metadata: {
            namespace: "default",
            type: TYPES.machineSetNode,
            id: args.machine,
            labels: {
              [LABELS.cluster]: args.cluster,
              [LABELS.machineSet]: args.machineSet,
            },
          },
          spec: {},
        };
        context.logger.info(
          "omnictl: {verb} machine {machine} into {machineSet}",
          {
            verb: args.dryRun ? "validating" : "adding",
            machine: args.machine,
            machineSet: args.machineSet,
          },
        );
        const out = await applyResource(
          resource,
          opts,
          context.signal,
          args.dryRun,
        );
        if (args.dryRun) {
          context.logger.info("omnictl: dry run\n{out}", { out: out.trim() });
          return { dataHandles: [] };
        }
        const back = await getResource(
          TYPES.machineSetNode,
          args.machine,
          opts,
          context.signal,
        );
        if (!back) {
          throw new Error(
            `machine ${args.machine} was added but Omni returns no MachineSetNode`,
          );
        }
        const labels = (back.metadata.labels ?? {}) as Record<string, unknown>;
        const handle = await context.writeResource(
          "machineSetNode",
          nodeName(args.machine),
          {
            machine: args.machine,
            cluster: typeof labels[LABELS.cluster] === "string"
              ? labels[LABELS.cluster]
              : args.cluster,
            machineSet: typeof labels[LABELS.machineSet] === "string"
              ? labels[LABELS.machineSet]
              : args.machineSet,
            appliedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
    removeMachine: {
      description:
        "Remove a machine from its cluster with omnictl cluster machine delete: Omni drains it, wipes it and returns it to the pool; waits up to timeout. Refuses a machine that is in no machine set. Never forces.",
      arguments: RemoveMachineArgs,
      execute: async (
        args: z.infer<typeof RemoveMachineArgs>,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        const node = await getResource(
          TYPES.machineSetNode,
          args.machine,
          opts,
          context.signal,
        );
        if (!node) {
          throw new Error(
            `machine ${args.machine} is in no machine set; nothing to remove`,
          );
        }
        context.logger.info(
          "omnictl: removing machine {machine} from its cluster (timeout {timeout})",
          { machine: args.machine, timeout: args.timeout },
        );
        await clusterMachineDelete(
          args.machine,
          args.timeout,
          opts,
          context.signal,
        );
        if (context.deleteResource) {
          await context.deleteResource(nodeName(args.machine));
        }
        context.logger.info("omnictl: machine {machine} removed and wiped", {
          machine: args.machine,
        });
        return { dataHandles: [] };
      },
    },
    forgetMachine: {
      description:
        "Delete a machine's SideroLink Link so Omni forgets it. Refuses while the machine is still in a cluster, and is a no-op when Omni already has no such machine. Do this after the machine itself is gone, or a running machine re-registers.",
      arguments: ForgetMachineArgs,
      execute: async (
        args: z.infer<typeof ForgetMachineArgs>,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        const status = await getResource(
          TYPES.machineStatus,
          args.machine,
          opts,
          context.signal,
        );
        if (status) {
          const cluster = typeof status.spec.cluster === "string"
            ? status.spec.cluster
            : "";
          if (cluster !== "") {
            throw new Error(
              `machine ${args.machine} is still in cluster ${cluster}; removeMachine first`,
            );
          }
        }
        const link = await getResource(
          TYPES.link,
          args.machine,
          opts,
          context.signal,
        );
        if (!link) {
          context.logger.info(
            "omnictl: Omni already has no machine {machine}",
            {
              machine: args.machine,
            },
          );
          return { dataHandles: [] };
        }
        context.logger.info("omnictl: forgetting machine {machine}", {
          machine: args.machine,
        });
        await deleteResource(TYPES.link, args.machine, opts, context.signal);
        return { dataHandles: [] };
      },
    },
  },
};
