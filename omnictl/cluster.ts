/**
 * `@dataverket/omnictl/cluster` — the writes an Omni Operator makes when a
 * cluster's machines change, one Omni operation per method: a config patch,
 * the system extensions, a machine joining a machine set, a machine leaving
 * its cluster, and a machine deleted from Omni.
 *
 * In the order a worker swap uses them: `applyPatch` and `setExtensions`
 * before `addMachine`, so both are in place when Omni first provisions the
 * machine; `removeMachine` drains, wipes and waits; `deleteMachine` is the
 * dashboard's Delete Machine (patches and Link), after the server is gone. The sequences around
 * them, with their checks, belong in workflows. Every apply takes `dryRun`,
 * which makes `omnictl apply --dry-run` validate the resource and change
 * nothing.
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
  getResources,
} from "./omnictl.ts";
import { checks } from "./checks.ts";
import { sanitizeInstanceName } from "./schema.ts";
import { readSecretFile } from "./util.ts";

/** Omni's resource types, fully qualified so no alias lookup is involved. */
export const TYPES = {
  configPatch: "ConfigPatches.omni.sidero.dev",
  machineSet: "MachineSets.omni.sidero.dev",
  machineSetNode: "MachineSetNodes.omni.sidero.dev",
  machineStatus: "MachineStatuses.omni.sidero.dev",
  clusterMachine: "ClusterMachines.omni.sidero.dev",
  extensionsConfiguration: "ExtensionsConfigurations.omni.sidero.dev",
  link: "Links.omni.sidero.dev",
} as const;

/** Omni's label keys for patch and machine-set scoping. */
export const LABELS = {
  cluster: "omni.sidero.dev/cluster",
  machineSet: "omni.sidero.dev/machine-set",
  machine: "omni.sidero.dev/machine",
  clusterMachine: "omni.sidero.dev/cluster-machine",
} as const;

/**
 * The prefix of Omni's role labels, `omni.sidero.dev/role-worker` and
 * `omni.sidero.dev/role-controlplane`. A machine set carries one, and Omni's
 * UI copies it onto every MachineSetNode; a node made without it on 2026-10-01
 * was counted as requested and not allocated.
 */
export const ROLE_PREFIX = "omni.sidero.dev/role-";

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
  role: z.string().nullable().describe(
    "The role label copied from the machine set, e.g. omni.sidero.dev/role-worker",
  ),
  appliedAt: z.string(),
});

const ApplyPatchArgs = z.object({
  id: Name.describe(
    "Patch id, e.g. 500-dataverket-wrkr-4-storage; an existing id is updated",
  ),
  data: z.string().min(1).optional().describe(
    "Talos machine config patch, YAML text; or name it with dataFile",
  ),
  dataFile: z.string().min(1).optional().describe(
    "Path of a YAML file holding the patch, read at call time; relative to the repository",
  ),
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
const DeleteMachineArgs = z.object({ machine: Machine });
const Extension = z.string().regex(/^[a-z0-9-]+\/[a-z0-9._-]+$/).describe(
  "System extension, e.g. siderolabs/kata-containers",
);
const SetExtensionsArgs = z.object({
  cluster: z.string().min(1).describe("Cluster name"),
  machineSet: z.string().min(1).optional().describe(
    "Scope to a machine set: every machine in it without a configuration of its own",
  ),
  machine: Machine.optional().describe("Scope to one machine of the cluster"),
  extensions: z.array(Extension).describe(
    "The complete list for the scope; it replaces what was there, and [] removes them all",
  ),
  id: Name.optional().describe(
    "Resource id; default schematic-<machine>, schematic-<machineSet> or schematic-<cluster>, as Omni's UI names them",
  ),
  dryRun: z.boolean().default(false).describe(
    "Validate with omnictl and change nothing",
  ),
});

/** An extensions configuration as stored after `setExtensions`. */
export const ExtensionsConfigurationSchema = z.object({
  id: z.string(),
  scope: z.enum(["machine", "machineSet", "cluster"]),
  cluster: z.string(),
  machineSet: z.string().nullable(),
  machine: z.string().nullable(),
  extensions: z.array(z.string()),
  appliedAt: z.string(),
});

/**
 * The labels and default id of an extensions configuration. Omni picks the
 * most specific one for a machine: its own, then its machine set's, then its
 * cluster's; they do not merge.
 */
export function extensionsScope(
  args: Pick<
    z.infer<typeof SetExtensionsArgs>,
    "cluster" | "machineSet" | "machine" | "id"
  >,
): {
  scope: "machine" | "machineSet" | "cluster";
  id: string;
  labels: Record<string, string>;
} {
  if (args.machine && args.machineSet) {
    throw new Error("setExtensions takes one of machine or machineSet");
  }
  const labels: Record<string, string> = { [LABELS.cluster]: args.cluster };
  if (args.machine) {
    labels[LABELS.clusterMachine] = args.machine;
    return {
      scope: "machine",
      id: args.id ?? `schematic-${args.machine}`,
      labels,
    };
  }
  if (args.machineSet) {
    labels[LABELS.machineSet] = args.machineSet;
    return {
      scope: "machineSet",
      id: args.id ?? `schematic-${args.machineSet}`,
      labels,
    };
  }
  return {
    scope: "cluster",
    id: args.id ?? `schematic-${args.cluster}`,
    labels,
  };
}

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

/**
 * The role label a machine set's nodes must carry, read from the machine set:
 * Omni's UI copies it onto every MachineSetNode it creates. Refuses a machine
 * set that does not exist, belongs to another cluster, or has no single role.
 */
export function roleLabel(
  machineSet: CosiResource | null,
  id: string,
  cluster: string,
): string {
  if (!machineSet) {
    throw new Error(`machine set ${id} does not exist`);
  }
  const labels = (machineSet.metadata.labels ?? {}) as Record<string, unknown>;
  const owner = labels[LABELS.cluster];
  if (owner !== cluster) {
    throw new Error(
      `machine set ${id} belongs to cluster ${
        typeof owner === "string" ? owner : "(none)"
      }, not ${cluster}`,
    );
  }
  const roles = Object.keys(labels).filter((k) => k.startsWith(ROLE_PREFIX));
  if (roles.length !== 1) {
    throw new Error(
      `machine set ${id} has ${roles.length} role labels; expected one ${ROLE_PREFIX}*`,
    );
  }
  return roles[0];
}

/**
 * The patch text: `data` as given, or the file `dataFile` names, read now and
 * resolved against the repository when relative, so a definition or workflow
 * names the file in git rather than carrying its contents. Exactly one.
 */
export function patchData(
  args: { data?: string; dataFile?: string },
  repoDir?: string,
): string {
  if (args.data && args.dataFile) {
    throw new Error("applyPatch takes data or dataFile, not both");
  }
  if (args.data) return args.data;
  if (!args.dataFile) {
    throw new Error("applyPatch needs data or dataFile");
  }
  const path = args.dataFile.startsWith("/") || args.dataFile.startsWith("~") ||
      !repoDir
    ? args.dataFile
    : `${repoDir.replace(/\/+$/, "")}/${args.dataFile}`;
  return readSecretFile(path, "dataFile");
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
 * delete`, and deleting a machine from Omni as the dashboard does. Operator role.
 */
export const model = {
  type: "@dataverket/omnictl/cluster",
  version: "2026.10.01.3",
  upgrades: [
    {
      toVersion: "2026.09.29.1",
      description:
        "serviceAccountKeyFile added; serviceAccountKey unchanged where set",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.1",
      description:
        "addMachine copies the machine set's role label, and pre-flight checks: the key resolves and Omni accepts it; global arguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.2",
      description:
        "setExtensions added, applyPatch takes dataFile, forgetMachine replaced by deleteMachine (the dashboard's Delete Machine); global arguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.01.3",
      description:
        "deleteMachine deletes the Link, not the read-only Machine; the Link type is Links.omni.sidero.dev; global arguments unchanged",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgs,
  checks,
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
    extensionsConfiguration: {
      description:
        "The system extensions Omni installs on a machine, a machine set's machines or a cluster's",
      schema: ExtensionsConfigurationSchema,
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
        const data = patchData(args, context.repoDir);
        const resource: CosiResource = {
          metadata: {
            namespace: "default",
            type: TYPES.configPatch,
            id: args.id,
            labels,
          },
          spec: { data },
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
        "Add a machine to a machine set by creating its MachineSetNode, which is what the Omni UI does, with the set's role label copied onto it; Omni then installs Talos with every patch in scope. Refuses a machine set that is missing, of another cluster, or without one role. An existing node is updated. dryRun validates only.",
      arguments: AddMachineArgs,
      execute: async (
        args: z.infer<typeof AddMachineArgs>,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        const role = roleLabel(
          await getResource(
            TYPES.machineSet,
            args.machineSet,
            opts,
            context.signal,
          ),
          args.machineSet,
          args.cluster,
        );
        const resource: CosiResource = {
          metadata: {
            namespace: "default",
            type: TYPES.machineSetNode,
            id: args.machine,
            labels: {
              [LABELS.cluster]: args.cluster,
              [LABELS.machineSet]: args.machineSet,
              [role]: "",
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
            role: role in labels ? role : null,
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
    deleteMachine: {
      description:
        "What Omni's dashboard does with Delete Machine: delete the machine's own config patches and its SideroLink Link; Omni then tears down the Machine and its labels (Machines themselves are read-only to every role). Refuses while the machine is in a machine set (removeMachine first), and is a no-op when Omni has no such machine. Delete the server first, or a running machine re-registers. Works whether or not removeMachine's wipe finished, so it also clears a machine whose server is gone and whose removal hangs.",
      arguments: DeleteMachineArgs,
      execute: async (
        args: z.infer<typeof DeleteMachineArgs>,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        const node = await getResource(
          TYPES.machineSetNode,
          args.machine,
          opts,
          context.signal,
        );
        if (node) {
          const labels = (node.metadata.labels ?? {}) as Record<
            string,
            unknown
          >;
          throw new Error(
            `machine ${args.machine} is still in machine set ${
              String(labels[LABELS.machineSet] ?? "(unknown)")
            }; removeMachine first`,
          );
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
        const patches = await getResources(
          TYPES.configPatch,
          opts,
          context.signal,
        );
        const own = patches.filter((p) =>
          ((p.metadata.labels ?? {}) as Record<string, unknown>)[
            LABELS.machine
          ] === args.machine
        );
        context.logger.info(
          "omnictl: deleting machine {machine}: its {count} config patch(es) and its Link",
          { machine: args.machine, count: own.length },
        );
        for (const p of own) {
          await deleteResource(
            TYPES.configPatch,
            p.metadata.id,
            opts,
            context.signal,
          );
        }
        await deleteResource(TYPES.link, args.machine, opts, context.signal);
        return { dataHandles: [] };
      },
    },
    setExtensions: {
      description:
        "Create or replace the ExtensionsConfiguration for a machine, a machine set or a cluster, as Omni's UI does; Omni installs the most specific one a machine has, which reboots it into a new schematic. dryRun validates only.",
      arguments: SetExtensionsArgs,
      execute: async (
        args: z.infer<typeof SetExtensionsArgs>,
        context: MethodContext,
      ): Promise<MethodResult> => {
        const opts = optionsOf(context.globalArgs);
        const { scope, id, labels } = extensionsScope(args);
        const resource: CosiResource = {
          metadata: {
            namespace: "default",
            type: TYPES.extensionsConfiguration,
            id,
            labels,
          },
          spec: { extensions: args.extensions },
        };
        context.logger.info(
          "omnictl: {verb} extensions {id} ({scope}): {extensions}",
          {
            verb: args.dryRun ? "validating" : "setting",
            id,
            scope,
            extensions: args.extensions.join(", ") || "(none)",
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
          TYPES.extensionsConfiguration,
          id,
          opts,
          context.signal,
        );
        if (!back) {
          throw new Error(
            `extensions ${id} were applied but Omni returns no ExtensionsConfiguration`,
          );
        }
        const stored = Array.isArray(back.spec.extensions)
          ? back.spec.extensions.filter((e): e is string =>
            typeof e === "string"
          )
          : [];
        const handle = await context.writeResource(
          "extensionsConfiguration",
          sanitizeInstanceName(id),
          {
            id,
            scope,
            cluster: args.cluster,
            machineSet: args.machineSet ?? null,
            machine: args.machine ?? null,
            extensions: stored,
            appliedAt: new Date().toISOString(),
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
