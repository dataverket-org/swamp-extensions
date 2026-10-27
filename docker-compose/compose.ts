/**
 * Adds `ensure` and `teardown` to `@smith/docker-compose`.
 *
 * `ensure` starts the given services with `docker compose up -d --wait` only
 * when one of them is not already running (and healthy, where the service has
 * a healthcheck). `teardown` is `docker compose down` with orphans and, by
 * default, volumes, failing when docker compose does.
 *
 * The upstream methods write a resource named `latest`, which current swamp
 * reserves, so they fail after doing their work; these write only the `state`
 * resource.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The upstream type's arguments these methods read. */
export type GlobalArgs = {
  composeFile: string;
  profiles: string[];
  projectDirectory?: string;
};

/** The parts of swamp's method context these methods use. */
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

/** One service as `docker compose ps --format json` lists it. */
export type ComposeService = {
  name: string;
  service: string;
  status: string;
  state: string;
  health?: string;
};

/** A command's outcome. */
export type CommandResult = { code: number; stdout: string; stderr: string };

/** Runs docker in a directory. Replaced in tests. */
export type Exec = (
  args: string[],
  cwd: string,
  signal?: AbortSignal,
) => Promise<CommandResult>;

async function denoExec(
  args: string[],
  cwd: string,
  signal?: AbortSignal,
): Promise<CommandResult> {
  // docker compose is the interface being driven; see README "Commands".
  // swamp-quality-ignore deno-command
  const out = await new Deno.Command("docker", {
    args,
    cwd,
    stdout: "piped",
    stderr: "piped",
    signal,
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

/** The docker argv for one compose subcommand. */
export function composeArgs(g: GlobalArgs, dir: string, sub: string[]) {
  const args = ["compose", "-f", g.composeFile, "--project-directory", dir];
  for (const profile of g.profiles) args.push("--profile", profile);
  return [...args, ...sub];
}

async function compose(sub: string[], ctx: Context): Promise<string> {
  const dir = ctx.globalArgs.projectDirectory || ctx.repoDir;
  const args = composeArgs(ctx.globalArgs, dir, sub);
  ctx.logger.info("Running: docker {args}", { args: args.join(" ") });
  const out = await exec(args, dir, ctx.signal);
  if (out.code !== 0) {
    throw new Error(
      `docker compose ${
        sub.join(" ")
      } failed (exit ${out.code}): ${out.stderr.trim()}`,
    );
  }
  return out.stdout;
}

/**
 * Parses `docker compose ps --format json`: one object per line since Compose
 * v2.21, one JSON array before that.
 */
export function parsePs(stdout: string): ComposeService[] {
  const text = stdout.trim();
  const objects: Record<string, unknown>[] = text.startsWith("[")
    ? JSON.parse(text)
    : text.split("\n").filter(Boolean).map((line) => JSON.parse(line));
  return objects.map((o) => ({
    name: String(o.Name ?? ""),
    service: String(o.Service ?? ""),
    status: String(o.Status ?? ""),
    state: String(o.State ?? ""),
    health: o.Health ? String(o.Health) : undefined,
  }));
}

/** Running, and healthy when the service has a healthcheck. */
export function ready(s: ComposeService | undefined): boolean {
  return s?.state === "running" && (!s.health || s.health === "healthy");
}

const EnsureArgsSchema = z.object({
  services: z.array(z.string()).min(1).describe("Services that must be up"),
});

const TeardownArgsSchema = z.object({
  volumes: z.boolean().default(true).describe(
    "Remove the named volumes declared in compose",
  ),
});

/** Extension adding `ensure` and `teardown` to @smith/docker-compose. */
export const extension = {
  type: "@smith/docker-compose",
  methods: [
    {
      ensure: {
        description:
          "Start the given services only if one of them is not already running and healthy",
        arguments: EnsureArgsSchema,
        execute: async (
          args: z.infer<typeof EnsureArgsSchema>,
          ctx: Context,
        ) => {
          let services = parsePs(
            await compose(["ps", "--format", "json"], ctx),
          );
          const pending = args.services.filter((name) =>
            !ready(services.find((s) => s.service === name))
          );

          if (pending.length === 0) {
            ctx.logger.info("Already up: {services}", {
              services: args.services.join(", "),
            });
          } else {
            ctx.logger.info("Starting {services}", {
              services: pending.join(", "),
            });
            await compose(["up", "-d", "--wait", ...pending], ctx);
            services = parsePs(await compose(["ps", "--format", "json"], ctx));
          }

          const handle = await ctx.writeResource("state", "current", {
            services: services.map((s) => ({
              name: s.name,
              status: s.status,
              health: s.health,
            })),
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        },
      },
      teardown: {
        description:
          "Stop and remove the stack, its orphans and (by default) its volumes",
        arguments: TeardownArgsSchema,
        execute: async (
          args: z.infer<typeof TeardownArgsSchema>,
          ctx: Context,
        ) => {
          const sub = ["down", "--remove-orphans"];
          if (args.volumes) sub.push("--volumes");
          await compose(sub, ctx);
          ctx.logger.info("Removed the stack in {dir}", {
            dir: ctx.globalArgs.projectDirectory || ctx.repoDir,
          });

          const handle = await ctx.writeResource("state", "current", {
            services: [],
            timestamp: new Date().toISOString(),
          });
          return { dataHandles: [handle] };
        },
      },
    },
  ],
};
