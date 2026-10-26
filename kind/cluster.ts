/**
 * `@dataverket/kind/cluster` — a single named kind (Kubernetes in Docker)
 * cluster, created on demand.
 *
 * `ensure` is idempotent: it creates the cluster from a kind config file only
 * when `kind get clusters` does not list it, then (re)applies a set of
 * manifests and records the cluster's kube context and API server URL so
 * other behaviors can target it.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The cluster's arguments. */
export const GlobalArgsSchema = z.object({
  clusterName: z.string().min(1).describe("kind cluster name"),
  configPath: z.string().min(1).describe(
    "kind cluster config, absolute or relative to the repository root",
  ),
  manifests: z.array(z.string()).default([]).describe(
    "Manifests applied with kubectl after the cluster is up, relative to the repository root",
  ),
  waitTimeout: z.string().default("120s").describe(
    "How long kind waits for the control plane to become ready",
  ),
  kindBinary: z.string().default("kind"),
  kubectlBinary: z.string().default("kubectl"),
});

/** The cluster's arguments, parsed. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const ClusterSchema = z.object({
  name: z.string(),
  exists: z.boolean(),
  created: z.boolean(),
  context: z.string(),
  apiServer: z.string(),
  manifestsApplied: z.array(z.string()),
  checkedAt: z.iso.datetime(),
});

type Cluster = z.infer<typeof ClusterSchema>;

/** The parts of swamp's method context the cluster uses. */
export type Context = {
  globalArgs: GlobalArgs;
  repoDir: string;
  signal?: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** A command's outcome. */
export type CommandResult = { code: number; stdout: string; stderr: string };

/** Runs one command in the repository root. Replaced in tests. */
export type Exec = (
  bin: string,
  args: string[],
  ctx: Context,
) => Promise<CommandResult>;

async function denoExec(
  bin: string,
  args: string[],
  ctx: Context,
): Promise<CommandResult> {
  // kind and kubectl are the interfaces being driven; see README "Commands".
  // swamp-quality-ignore deno-command
  const out = await new Deno.Command(bin, {
    args,
    cwd: ctx.repoDir,
    stdout: "piped",
    stderr: "piped",
    signal: ctx.signal,
  }).output();
  const decoder = new TextDecoder();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

let exec: Exec = denoExec;

/** Swaps the command runner; returns a function that restores it. */
export function __setExec(fake: Exec): () => void {
  const prev = exec;
  exec = fake;
  return () => {
    exec = prev;
  };
}

async function mustExec(
  bin: string,
  args: string[],
  ctx: Context,
): Promise<string> {
  const res = await exec(bin, args, ctx);
  if (res.code !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} exited ${res.code}: ${res.stderr.trim()}`,
    );
  }
  return res.stdout;
}

async function clusterExists(ctx: Context): Promise<boolean> {
  const { kindBinary, clusterName } = ctx.globalArgs;
  const stdout = await mustExec(kindBinary, ["get", "clusters"], ctx);
  return stdout.split("\n").map((l) => l.trim()).includes(clusterName);
}

function kubeContext(args: GlobalArgs): string {
  return `kind-${args.clusterName}`;
}

async function apiServer(ctx: Context): Promise<string> {
  const { kubectlBinary } = ctx.globalArgs;
  const out = await mustExec(kubectlBinary, [
    "config",
    "view",
    "--minify",
    "--context",
    kubeContext(ctx.globalArgs),
    "-o",
    "jsonpath={.clusters[0].cluster.server}",
  ], ctx);
  return out.trim();
}

async function assertReachable(ctx: Context): Promise<void> {
  const { kubectlBinary, clusterName } = ctx.globalArgs;
  const res = await exec(kubectlBinary, [
    "--context",
    kubeContext(ctx.globalArgs),
    "get",
    "--raw",
    "/readyz",
  ], ctx);
  if (res.code !== 0) {
    throw new Error(
      `kind cluster ${clusterName} exists but its API server is not reachable ` +
        `(is the ${clusterName}-control-plane container stopped? try ` +
        `'docker start ${clusterName}-control-plane'): ${res.stderr.trim()}`,
    );
  }
}

async function write(ctx: Context, cluster: Cluster) {
  return await ctx.writeResource("cluster", "cluster", cluster);
}

/** Model definition for a single on-demand kind cluster. */
export const model = {
  type: "@dataverket/kind/cluster",
  version: "2026.10.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    "cluster": {
      description: "Observed state of the kind cluster",
      schema: ClusterSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    ensure: {
      description:
        "Create the kind cluster if it does not exist, then apply the configured manifests",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const g = ctx.globalArgs;
        let created = false;

        if (await clusterExists(ctx)) {
          ctx.logger.info("kind cluster {name} already exists", {
            name: g.clusterName,
          });
        } else {
          ctx.logger.info("Creating kind cluster {name} from {config}", {
            name: g.clusterName,
            config: g.configPath,
          });
          await mustExec(g.kindBinary, [
            "create",
            "cluster",
            "--name",
            g.clusterName,
            "--config",
            g.configPath,
            "--wait",
            g.waitTimeout,
          ], ctx);
          created = true;
        }

        await assertReachable(ctx);

        for (const manifest of g.manifests) {
          ctx.logger.info("Applying {manifest}", { manifest });
          await mustExec(g.kubectlBinary, [
            "--context",
            kubeContext(g),
            "apply",
            "-f",
            manifest,
          ], ctx);
        }

        const handle = await write(ctx, {
          name: g.clusterName,
          exists: true,
          created,
          context: kubeContext(g),
          apiServer: await apiServer(ctx),
          manifestsApplied: g.manifests,
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    get: {
      description:
        "Record whether the kind cluster exists, without creating it",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const g = ctx.globalArgs;
        ctx.logger.info("Looking up kind cluster {name}", {
          name: g.clusterName,
        });
        const exists = await clusterExists(ctx);
        const handle = await write(ctx, {
          name: g.clusterName,
          exists,
          created: false,
          context: kubeContext(g),
          apiServer: exists ? await apiServer(ctx) : "",
          manifestsApplied: [],
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
    delete: {
      description: "Delete the kind cluster if it exists",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const g = ctx.globalArgs;
        if (await clusterExists(ctx)) {
          ctx.logger.info("Deleting kind cluster {name}", {
            name: g.clusterName,
          });
          await mustExec(g.kindBinary, [
            "delete",
            "cluster",
            "--name",
            g.clusterName,
          ], ctx);
        } else {
          ctx.logger.info("kind cluster {name} is already gone", {
            name: g.clusterName,
          });
        }
        const handle = await write(ctx, {
          name: g.clusterName,
          exists: false,
          created: false,
          context: kubeContext(g),
          apiServer: "",
          manifestsApplied: [],
          checkedAt: new Date().toISOString(),
        });
        return { dataHandles: [handle] };
      },
    },
  },
};
