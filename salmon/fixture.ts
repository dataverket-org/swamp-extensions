/**
 * `@dataverket/salmon/fixture` — the team, apps, trust and grants one test
 * needs, written into a Salmon stack's database.
 *
 * Salmon has no API for trusts and grants yet, only its dashboard, so `seed`
 * writes them with SQL through `psql` in the stack's Postgres container. The
 * authorization path stays Salmon's own: on every exchange Salmon re-checks
 * with LDAP that the team's group still manages each granted role.
 *
 * Ids are derived from the project, the fixture name and each entry's key, so
 * seeding again replaces the previous run's rows instead of adding to them.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type DataHandle,
  type MethodContext,
  run,
  serviceContainer,
  sleep,
} from "./common.ts";

const AppSchema = z.object({
  key: z.string().regex(/^[a-z0-9-]+$/).describe(
    "Short name grants refer to the app by",
  ),
  name: z.string().min(1),
});

/** The fixture's arguments. */
export const GlobalArgsSchema = z.object({
  project: z.string().min(1).default("salmon-e2e").describe(
    "The stack's docker compose project",
  ),
  name: z.string().regex(/^[a-z0-9-]+$/).default("e2e").describe(
    "Fixture name; ids are derived from it",
  ),
  team: z.object({
    name: z.string().min(1),
    group: z.string().min(1).default("ldap/Salmon-Registry-Administrator")
      .describe("Group whose members are the team; it must manage the roles"),
  }),
  apps: z.array(AppSchema).min(1),
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
  }),
  grants: z.array(z.object({
    app: z.string().describe("Key of an app above"),
    role: z.string().min(1).default("ldap/Registry-Push"),
  })).min(1),
}).refine(
  (g) => g.grants.every((gr) => g.apps.some((a) => a.key === gr.app)),
  { message: "every grant must name the key of an app in apps" },
);
/** The fixture's arguments, parsed. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const FixtureSchema = z.object({
  project: z.string(),
  teamId: z.string(),
  apps: z.record(z.string(), z.string()),
  trustId: z.string(),
  grants: z.array(z.object({
    id: z.string(),
    app: z.string(),
    appId: z.string(),
    role: z.string(),
    revoked: z.boolean(),
  })),
  seededAt: z.iso.datetime(),
});

/** A stable UUID (version 8) for one entry of one fixture. */
export async function stableId(
  g: Pick<GlobalArgs, "project" | "name">,
  kind: string,
  key = "",
): Promise<string> {
  const digest = new Uint8Array(
    await crypto.subtle.digest(
      "SHA-256",
      new TextEncoder().encode(`${g.project}\0${g.name}\0${kind}\0${key}`),
    ),
  ).slice(0, 16);
  digest[6] = (digest[6] & 0x0f) | 0x80;
  digest[8] = (digest[8] & 0x3f) | 0x80;
  const hex = [...digest].map((b) => b.toString(16).padStart(2, "0")).join("");
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${
    hex.slice(16, 20)
  }-${hex.slice(20)}`;
}

/** Single-quoted SQL literal. */
export function lit(s: string): string {
  return `'${s.replaceAll("'", "''")}'`;
}

/** Every id the fixture uses. */
export async function ids(g: GlobalArgs) {
  const apps: Record<string, string> = {};
  for (const a of g.apps) apps[a.key] = await stableId(g, "app", a.key);
  const grants = [];
  for (const gr of g.grants) {
    grants.push({
      id: await stableId(g, "grant", `${gr.app}\0${gr.role}`),
      app: gr.app,
      appId: apps[gr.app],
      role: gr.role,
    });
  }
  return {
    teamId: await stableId(g, "team"),
    trustId: await stableId(g, "trust"),
    apps,
    grants,
  };
}

/** One transaction that replaces the fixture's rows. */
export function seedSql(
  g: GlobalArgs,
  id: Awaited<ReturnType<typeof ids>>,
): string {
  const team = lit(id.teamId);
  return [
    "BEGIN;",
    `DELETE FROM grants WHERE team_id = ${team} OR trust_id = ${
      lit(id.trustId)
    };`,
    `DELETE FROM trusts WHERE team_id = ${team} OR id = ${lit(id.trustId)};`,
    `DELETE FROM apps WHERE team_id = ${team};`,
    `DELETE FROM teams WHERE id = ${team};`,
    `INSERT INTO teams (id, created_at, updated_at, instance, name, groups)
  VALUES (${team}, now(), now(), false, ${lit(g.team.name)}, ${
      lit(JSON.stringify([g.team.group]))
    });`,
    ...g.apps.map((a) =>
      `INSERT INTO apps (id, created_at, updated_at, team_id, name, is_default, redirect_urls)
  VALUES (${lit(id.apps[a.key])}, now(), now(), ${team}, ${
        lit(a.name)
      }, false, '[]');`
    ),
    `INSERT INTO trusts (id, created_at, team_id, issuer, subject, audience, insecure)
  VALUES (${lit(id.trustId)}, now(), ${team}, ${lit(g.trust.issuer)}, ${
      lit(g.trust.subject)
    }, ${lit(g.trust.audience)}, ${g.trust.insecure});`,
    ...id.grants.map((gr) =>
      `INSERT INTO grants (id, created_at, trust_id, role, app_id, team_id)
  VALUES (${lit(gr.id)}, now(), ${lit(id.trustId)}, ${lit(gr.role)}, ${
        lit(gr.appId)
      }, ${team});`
    ),
    "COMMIT;",
  ].join("\n");
}

type Context = MethodContext<GlobalArgs>;

async function psql(sql: string, ctx: Context): Promise<string> {
  const project = ctx.globalArgs.project;
  const container = await serviceContainer(project, "postgres", ctx.signal);
  if (!container) {
    throw new Error(
      `no running postgres in compose project ${project}; run the stack's ensure first`,
    );
  }
  return await run("docker", [
    "exec",
    "-i",
    container,
    "psql",
    "-U",
    "salmon",
    "-d",
    "salmon",
    "-v",
    "ON_ERROR_STOP=1",
    "-qtA",
  ], { stdin: sql, signal: ctx.signal });
}

/** Records the fixture, reading which of its grants still exist. */
async function record(ctx: Context): Promise<DataHandle> {
  const g = ctx.globalArgs;
  const id = await ids(g);
  const present = new Set(
    (await psql(
      `SELECT id FROM grants WHERE id IN (${
        id.grants.map((gr) => lit(gr.id)).join(", ")
      });`,
      ctx,
    )).split("\n").map((l) => l.trim()).filter(Boolean),
  );
  return await ctx.writeResource("fixture", "fixture", {
    project: g.project,
    teamId: id.teamId,
    apps: id.apps,
    trustId: id.trustId,
    grants: id.grants.map((gr) => ({ ...gr, revoked: !present.has(gr.id) })),
    seededAt: new Date().toISOString(),
  });
}

/** Model definition for a Salmon test fixture. */
export const model = {
  type: "@dataverket/salmon/fixture",
  version: "2026.10.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    fixture: {
      description: "Ids of the seeded team, apps, trust and grants",
      schema: FixtureSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    seed: {
      description:
        "Replace the fixture's team, apps, trust and grants in the stack's database",
      arguments: z.object({
        timeoutSeconds: z.number().int().positive().default(60).describe(
          "How long to wait for Salmon to have migrated its schema",
        ),
      }),
      execute: async (args: { timeoutSeconds: number }, ctx: Context) => {
        const g = ctx.globalArgs;
        ctx.logger.info("Seeding fixture {name} into {project}", {
          name: g.name,
          project: g.project,
        });
        const deadline = Date.now() + args.timeoutSeconds * 1000;
        while (
          (await psql("SELECT to_regclass('public.grants') IS NOT NULL", ctx))
            .trim() !== "t"
        ) {
          if (Date.now() > deadline) {
            throw new Error(
              `Salmon's schema did not appear within ${args.timeoutSeconds}s`,
            );
          }
          await sleep(1000);
        }
        const id = await ids(g);
        await psql(seedSql(g, id), ctx);
        ctx.logger.info("Seeded trust {trust} with {count} grant(s)", {
          trust: id.trustId,
          count: id.grants.length,
        });
        return { dataHandles: [await record(ctx)] };
      },
    },
    revoke: {
      description: "Delete the trust's grants at one app",
      arguments: z.object({
        app: z.string().describe("Key of the app whose grants to delete"),
      }),
      execute: async (args: { app: string }, ctx: Context) => {
        ctx.logger.info("Revoking the grants at {app}", { app: args.app });
        const id = await ids(ctx.globalArgs);
        const grantIds = id.grants.filter((gr) => gr.app === args.app).map((
          gr,
        ) => lit(gr.id));
        if (grantIds.length === 0) {
          throw new Error(`the fixture grants nothing at app ${args.app}`);
        }
        const deleted = await psql(
          `DELETE FROM grants WHERE id IN (${
            grantIds.join(", ")
          }) RETURNING id;`,
          ctx,
        );
        if (deleted.trim() === "") {
          throw new Error(
            `no grant at app ${args.app} was there to delete; run seed first`,
          );
        }
        ctx.logger.info("Revoked the grants at {app}", { app: args.app });
        return { dataHandles: [await record(ctx)] };
      },
    },
  },
};
