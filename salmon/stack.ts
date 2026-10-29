/**
 * `@dataverket/salmon/stack` — a throwaway Salmon for end-to-end tests, one
 * container of the published image: an in-memory SQLite database, a `userdb`
 * identity provider with Salmon's reference people, and the apps, trust and
 * grants a test needs, loaded with Salmon's `--seed` before it serves.
 *
 * `ensure` hands docker compose a project generated here, on stdin, so nothing
 * is written to disk, and waits until Salmon's discovery document answers.
 * Salmon refuses a bad seed and exits, so the wait fails as soon as the
 * container is gone. Everything lives in Salmon's memory: a restart loses it,
 * signing keys included, and the seed is loaded again. Ids are derived from the
 * project, the fixture name and each app's key, so they are the same on every
 * run. `revoke` restarts Salmon with the grants at one app left out, to test a
 * refusal. `stop` removes the project.
 *
 * Salmon reads `salmon.yaml` from its working directory, so it runs in `/tmp`
 * with the file and the seed mounted there.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type DataHandle,
  exec,
  type MethodContext,
  run,
  serviceContainer,
  sleep,
} from "./common.ts";

/** The id of the userdb provider: groups and roles are `users/<group>`. */
export const PROVIDER = "users";

/** Salmon's administrators, a group of the reference people. */
export const ADMIN_GROUP = `${PROVIDER}/Salmon-Administrator`;

/**
 * Salmon's reference people: alice is an administrator, bob administers the
 * Registry team and carol views it, dave is in no group, and Registry-Push is
 * a role Salmon-Registry-Administrator manages, so that group may grant it to
 * a trust. Every password is `password`.
 */
export const USERS = [
  ["alice", "Alice Administrator", ["Salmon-Administrator"]],
  ["bob", "Bob Registry", ["Salmon-Registry-Administrator", "Registry-Push"]],
  ["carol", "Carol Viewer", ["Salmon-Registry-Viewer", "frank-viewer"]],
  ["dave", "Dave Nogroup", []],
].map(([uid, name, groups]) => ({
  email: `${uid}@salmon.local`,
  password: "password",
  name: name as string,
  preferred_username: uid as string,
  groups: groups as string[],
}));

/** Which group manages a group, unqualified, as userdb reads it. */
export const MANAGERS = { "Registry-Push": "Salmon-Registry-Administrator" };

const qualified = z.string().regex(/^[^/]+\/.+$/, "write <provider>/<group>");

const AppSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/).describe(
    "Short name grants refer to the app by",
  ),
  name: z.string().min(1),
});

/** The stack's arguments. */
export const GlobalArgsSchema = z.object({
  project: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).default("salmon-e2e")
    .describe("docker compose project name; one stack per name"),
  image: z.string().min(1).default(
    "registry.dataverket.org/tools/salmon:latest",
  ).describe(
    "Salmon image, with --seed; pin a sha-<short> tag for reproducible runs",
  ),
  issuerUrl: z.string().url().default("http://localhost:8080/issuer/")
    .refine((u) => new URL(u).pathname === "/issuer/", {
      message: "Salmon serves its issuer at /issuer/",
    })
    .describe("Salmon's issuer URL as its clients will reach it"),
  port: z.number().int().min(1).max(65535).default(8080).describe(
    "Host port Salmon is published on",
  ),
  networks: z.array(z.string().min(1)).default([]).describe(
    "Existing docker networks Salmon also joins, e.g. kind, so it can fetch a cluster's ServiceAccount keys",
  ),
  startTimeoutSeconds: z.number().int().positive().default(120),
  name: z.string().regex(/^[a-z0-9-]+$/).default("e2e").describe(
    "Fixture name; ids are derived from the project, it and each app's key",
  ),
  owners: z.array(qualified).min(1).default([
    `${PROVIDER}/Salmon-Registry-Administrator`,
  ]).describe("Groups that own the seeded apps and trust"),
  apps: z.array(AppSchema).default([]),
  trust: z.object({
    issuer: z.string().url().describe("Issuer of the workload's own token"),
    subject: z.string().min(1).describe(
      "sub of the workload's token, e.g. system:serviceaccount:<ns>:<sa>",
    ),
    audience: z.string().default("").describe(
      "aud the workload's token must carry; empty means Salmon's issuer URL",
    ),
    insecure: z.boolean().default(false).describe(
      "Skip TLS verification fetching the issuer's keys (dev clusters only)",
    ),
  }).optional(),
  grants: z.array(z.object({
    app: z.string().describe("Key of an app above"),
    role: qualified.default(`${PROVIDER}/Registry-Push`).describe(
      "A role whose manager the provider names",
    ),
  })).default([]),
}).refine(
  (g) => new Set(g.apps.map((a) => a.key)).size === g.apps.length,
  { message: "app keys must be unique" },
).refine(
  (g) => g.grants.every((gr) => g.apps.some((a) => a.key === gr.app)),
  { message: "every grant must name the key of an app in apps" },
).refine(
  (g) => g.grants.length === 0 || g.trust !== undefined,
  { message: "grants need a trust" },
);
/** The stack's arguments, parsed. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StackSchema = z.object({
  project: z.string(),
  image: z.string(),
  issuerUrl: z.string(),
  port: z.number(),
  localIssuerUrl: z.string(),
  running: z.boolean(),
  apps: z.record(z.string(), z.string()),
  trustId: z.string(),
  grants: z.array(z.object({
    app: z.string(),
    appId: z.string(),
    role: z.string(),
    revoked: z.boolean(),
  })),
  checkedAt: z.iso.datetime(),
});

/** A stable UUID (version 8) for one entry of one fixture. */
export async function stableId(
  g: Pick<GlobalArgs, "project" | "name">,
  kind: string,
  key = "",
): Promise<string> {
  const digest = new Uint8Array(
    await sha256(
      `${g.project}\0${g.name}\0${kind}\0${key}`,
    ),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

async function sha256(s: string): Promise<ArrayBuffer> {
  return await crypto.subtle.digest("SHA-256", new TextEncoder().encode(s));
}

/** The ids of the seeded apps, by key, and of the trust. */
export async function ids(g: GlobalArgs) {
  const apps: Record<string, string> = {};
  for (const a of g.apps) apps[a.key] = await stableId(g, "app", a.key);
  return { apps, trustId: g.trust ? await stableId(g, "trust") : "" };
}

/** salmon.yaml for the stack's Salmon, as JSON (which Salmon reads as YAML). */
export function salmonConfig(g: GlobalArgs): string {
  return JSON.stringify(
    {
      issuer_url: g.issuerUrl,
      externalidp: [{
        type: "userdb",
        id: PROVIDER,
        name: "Test users",
        data: { users: USERS, managers: MANAGERS },
      }],
      admins: [ADMIN_GROUP],
    },
    null,
    2,
  );
}

/** Salmon's seed file, as JSON, without the grants at the revoked apps. */
export function seedFile(
  g: GlobalArgs,
  id: Awaited<ReturnType<typeof ids>>,
  revoked: string[] = [],
): string {
  return JSON.stringify(
    {
      apps: g.apps.map((a) => ({
        id: id.apps[a.key],
        name: a.name,
        owners: g.owners,
      })),
      trusts: g.trust ? [{ id: id.trustId, owners: g.owners, ...g.trust }] : [],
      grants: g.grants.filter((gr) => !revoked.includes(gr.app)).map((gr) => ({
        trust: id.trustId,
        app: id.apps[gr.app],
        role: gr.role,
      })),
    },
    null,
    2,
  );
}

/**
 * The key that seals Salmon's signing keys in its database. It guards nothing
 * here, the database is in Salmon's memory, so it is derived from the project
 * to keep the generated project the same between runs.
 */
export async function keyEncryptionKey(g: GlobalArgs): Promise<string> {
  return btoa(String.fromCharCode(
    ...new Uint8Array(await sha256(`salmon-e2e-kek\0${g.project}`)),
  ));
}

/**
 * The compose project, as JSON (which compose reads as YAML). The seed's
 * digest is a label, so compose recreates Salmon whenever the seed changes.
 */
export async function composeProject(
  g: GlobalArgs,
  seed: string,
): Promise<string> {
  const digest = [...new Uint8Array(await sha256(seed))]
    .map((b) => b.toString(16).padStart(2, "0")).join("");
  return JSON.stringify(
    {
      name: g.project,
      services: {
        salmon: {
          image: g.image,
          working_dir: "/tmp",
          command: ["--seed", "/tmp/seed.yaml"],
          environment: {
            DATABASE_DRIVER: "sqlite",
            DATABASE_NAME: "salmon",
            SALMON_KEY_ENCRYPTION_KEY: await keyEncryptionKey(g),
          },
          labels: { "org.dataverket.salmon.seed-sha256": digest },
          configs: [
            { source: "salmon-yaml", target: "/tmp/salmon.yaml" },
            { source: "seed", target: "/tmp/seed.yaml" },
          ],
          ports: [`${g.port}:8080`],
          networks: ["default", ...g.networks],
        },
      },
      configs: {
        "salmon-yaml": { content: salmonConfig(g) },
        seed: { content: seed },
      },
      networks: Object.fromEntries(
        g.networks.map((n) => [n, { name: n, external: true }]),
      ),
    },
    null,
    2,
  );
}

/** Where the discovery document answers from the host. */
export function localIssuerUrl(g: GlobalArgs): string {
  return `http://127.0.0.1:${g.port}/issuer/`;
}

type Context = MethodContext<GlobalArgs>;

async function discoveryAnswers(url: string, signal?: AbortSignal) {
  try {
    const res = await fetch(`${url}.well-known/openid-configuration`, {
      signal,
    });
    await res.body?.cancel();
    return res.ok;
  } catch {
    return false;
  }
}

/** Salmon's last log lines: why it refused a seed or did not start. */
async function salmonLogs(ctx: Context): Promise<string> {
  const logs = await exec("docker", [
    "compose",
    "-p",
    ctx.globalArgs.project,
    "logs",
    "--tail",
    "20",
    "salmon",
  ], { signal: ctx.signal });
  return `${logs.stdout}${logs.stderr}`;
}

/** Starts Salmon with the seed, or leaves it running, and waits for it. */
async function up(ctx: Context, revoked: string[]) {
  const g = ctx.globalArgs;
  const seed = seedFile(g, await ids(g), revoked);
  const started = await exec("docker", [
    "compose",
    "-f",
    "-",
    "up",
    "-d",
    "--wait",
    "--remove-orphans",
  ], { stdin: await composeProject(g, seed), signal: ctx.signal });
  if (started.code !== 0) {
    throw new Error(
      `docker compose up exited ${started.code}: ${started.stderr.trim()}\n${await salmonLogs(
        ctx,
      )}`,
    );
  }

  const local = localIssuerUrl(g);
  const deadline = Date.now() + g.startTimeoutSeconds * 1000;
  while (!(await discoveryAnswers(local, ctx.signal))) {
    const gone = !(await serviceContainer(g.project, "salmon", ctx.signal));
    if (gone || Date.now() > deadline) {
      throw new Error(
        `Salmon ${
          gone ? "exited" : `did not answer within ${g.startTimeoutSeconds}s`
        } at ${local}.well-known/openid-configuration:\n${await salmonLogs(
          ctx,
        )}`,
      );
    }
    await sleep(1000);
  }
}

async function record(
  ctx: Context,
  running: boolean,
  revoked: string[],
): Promise<DataHandle> {
  const g = ctx.globalArgs;
  const id = await ids(g);
  return await ctx.writeResource("stack", "stack", {
    project: g.project,
    image: g.image,
    issuerUrl: g.issuerUrl,
    port: g.port,
    localIssuerUrl: localIssuerUrl(g),
    running,
    apps: id.apps,
    trustId: id.trustId,
    grants: g.grants.map((gr) => ({
      app: gr.app,
      appId: id.apps[gr.app],
      role: gr.role,
      revoked: revoked.includes(gr.app),
    })),
    checkedAt: new Date().toISOString(),
  });
}

/** Model definition for the Salmon stack. */
export const model = {
  type: "@dataverket/salmon/stack",
  version: "2026.10.29.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.29.1",
      description:
        "Salmon on in-memory SQLite with userdb and --seed; the fixture's apps, trust and grants are new optional arguments",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    stack: {
      description:
        "The stack's project, image, issuer URLs and the ids of the seeded apps, trust and grants",
      schema: StackSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    ensure: {
      description:
        "Start Salmon with the seeded apps, trust and grants, or leave it running, and wait for discovery",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const g = ctx.globalArgs;
        ctx.logger.info("Starting stack {project} with {image}", {
          project: g.project,
          image: g.image,
        });
        await up(ctx, []);
        ctx.logger.info("Salmon {image} answers at {url}", {
          image: g.image,
          url: g.issuerUrl,
        });
        return { dataHandles: [await record(ctx, true, [])] };
      },
    },
    revoke: {
      description:
        "Restart Salmon without the trust's grants at one app; the next ensure restores them",
      arguments: z.object({
        app: z.string().describe("Key of the app whose grants to leave out"),
      }),
      execute: async (args: { app: string }, ctx: Context) => {
        if (!ctx.globalArgs.grants.some((gr) => gr.app === args.app)) {
          throw new Error(`the fixture grants nothing at app ${args.app}`);
        }
        ctx.logger.info("Restarting Salmon without the grants at {app}", {
          app: args.app,
        });
        await up(ctx, [args.app]);
        return { dataHandles: [await record(ctx, true, [args.app])] };
      },
    },
    stop: {
      description: "Remove the stack's container and network",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        ctx.logger.info("Removing stack {project}", {
          project: ctx.globalArgs.project,
        });
        await run("docker", [
          "compose",
          "-p",
          ctx.globalArgs.project,
          "down",
          "--volumes",
          "--remove-orphans",
        ], { signal: ctx.signal });
        return { dataHandles: [await record(ctx, false, [])] };
      },
    },
  },
};
