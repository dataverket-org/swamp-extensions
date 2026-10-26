/**
 * `@dataverket/salmon/stack` — a throwaway Salmon for end-to-end tests: the
 * published image, a Postgres for it, and an OpenLDAP seeded with Salmon's
 * reference layout, as one docker compose project.
 *
 * `ensure` hands docker compose a project generated here, on stdin, so nothing
 * is written to disk, and waits until Salmon's discovery document answers:
 * Salmon exits 0 when it fails to start, so a running container proves
 * nothing. Only Salmon's port is published; Postgres and LDAP are reached over
 * the project's network, and the fixture type reaches Postgres with docker
 * exec. `stop` removes the project and its volumes.
 *
 * Salmon reads `salmon.yaml` from its working directory and writes its
 * signing keys beside it, so it runs in `/tmp` with the file mounted there.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type DataHandle,
  exec,
  type MethodContext,
  run,
  sleep,
} from "./common.ts";

/** The LDAP domain the seed below lives under. */
export const LDAP_DOMAIN = "dc=salmon,dc=local";

/** Salmon's administrators, a group of the seeded LDAP. */
export const ADMIN_GROUP = "ldap/Salmon-Administrator";

/**
 * Salmon's reference directory (hacks/ldap/bootstrap in Salmon): alice is an
 * administrator, bob administers the Registry team and carol views it, dave
 * is in no group, and Registry-Push is a role Salmon-Registry-Administrator
 * manages, so that team may grant it to a trust. Every password is
 * `password`.
 */
export const LDIF: Record<string, string> = {
  "01-ou.ldif": `dn: ou=people,${LDAP_DOMAIN}
objectClass: organizationalUnit
ou: people

dn: ou=groups,${LDAP_DOMAIN}
objectClass: organizationalUnit
ou: groups
`,
  "02-people.ldif": [
    ["alice", "Alice Administrator", "Administrator", "Alice"],
    ["bob", "Bob Registry", "Registry", "Bob"],
    ["carol", "Carol Viewer", "Viewer", "Carol"],
    ["dave", "Dave Nogroup", "Nogroup", "Dave"],
  ].map(([uid, cn, sn, given]) =>
    `dn: uid=${uid},ou=people,${LDAP_DOMAIN}
objectClass: inetOrgPerson
uid: ${uid}
cn: ${cn}
sn: ${sn}
givenName: ${given}
mail: ${uid}@salmon.local
userPassword: password
`
  ).join("\n"),
  "03-groups.ldif": [
    ["Salmon-Administrator", ["alice"], ""],
    ["Salmon-Registry-Administrator", ["bob"], ""],
    ["Salmon-Registry-Viewer", ["carol"], ""],
    ["frank-viewer", ["carol"], ""],
    ["Registry-Push", ["bob"], "Salmon-Registry-Administrator"],
  ].map(([cn, members, owner]) =>
    `dn: cn=${cn},ou=groups,${LDAP_DOMAIN}
objectClass: groupOfNames
cn: ${cn}
${owner ? `owner: cn=${owner},ou=groups,${LDAP_DOMAIN}\n` : ""}${
      (members as string[]).map((m) =>
        `member: uid=${m},ou=people,${LDAP_DOMAIN}\n`
      ).join("")
    }`
  ).join("\n"),
};

const LDIF_DIR = "/container/service/slapd/assets/config/bootstrap/ldif/custom";

/** The stack's arguments. */
export const GlobalArgsSchema = z.object({
  project: z.string().regex(/^[a-z0-9][a-z0-9_-]*$/).default("salmon-e2e")
    .describe("docker compose project name; one stack per name"),
  image: z.string().min(1).default(
    "registry.dataverket.org/tools/salmon:latest",
  ).describe("Salmon image; pin a sha-<short> tag for reproducible runs"),
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
});
/** The stack's arguments, parsed. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const StackSchema = z.object({
  project: z.string(),
  image: z.string(),
  issuerUrl: z.string(),
  port: z.number(),
  localIssuerUrl: z.string(),
  running: z.boolean(),
  checkedAt: z.iso.datetime(),
});

/** salmon.yaml for the stack's Salmon. */
export function salmonYaml(g: GlobalArgs): string {
  return `issuer_url: ${g.issuerUrl}
externalidp:
  - type: ldap
    id: ldap
    name: LDAP
    data:
      host: ldap://ldap:389
      username: admin
      password: admin
      domain: "${LDAP_DOMAIN}"
admins:
  - ${ADMIN_GROUP}
`;
}

/** The compose project, as JSON (which compose reads as YAML). */
export function composeProject(g: GlobalArgs): string {
  const ldifConfigs = Object.keys(LDIF).map((file) => ({
    source: `ldif-${file.replace(".ldif", "")}`,
    target: `${LDIF_DIR}/${file}`,
  }));
  const configs: Record<string, { content: string }> = {
    "salmon-yaml": { content: salmonYaml(g) },
  };
  for (const [file, content] of Object.entries(LDIF)) {
    configs[`ldif-${file.replace(".ldif", "")}`] = { content };
  }
  return JSON.stringify(
    {
      name: g.project,
      services: {
        postgres: {
          image: "postgres:16",
          environment: {
            POSTGRES_USER: "salmon",
            POSTGRES_PASSWORD: "salmon",
            POSTGRES_DB: "salmon",
          },
          // Over TCP: on first start the image runs a temporary server on
          // the Unix socket only, which a socket check reports as ready.
          healthcheck: {
            test: ["CMD-SHELL", "pg_isready -h 127.0.0.1 -U salmon -d salmon"],
            interval: "2s",
            retries: 30,
          },
        },
        ldap: {
          image: "osixia/openldap:1.5.0",
          // The entrypoint rewrites the seed files in place; --copy-service
          // copies them out of the read-only config mounts first.
          command: ["--copy-service"],
          environment: {
            LDAP_ORGANISATION: "Salmon",
            LDAP_DOMAIN: "salmon.local",
            LDAP_ADMIN_PASSWORD: "admin",
          },
          configs: ldifConfigs,
          healthcheck: {
            test: [
              "CMD",
              "ldapwhoami",
              "-x",
              "-H",
              "ldap://localhost",
              "-D",
              `cn=admin,${LDAP_DOMAIN}`,
              "-w",
              "admin",
            ],
            interval: "2s",
            retries: 30,
          },
        },
        salmon: {
          image: g.image,
          working_dir: "/tmp",
          environment: {
            DATABASE_HOST: "postgres",
            DATABASE_PORT: "5432",
            DATABASE_USER: "salmon",
            DATABASE_PASSWORD: "salmon",
            DATABASE_NAME: "salmon",
            DATABASE_SSL_MODE: "disable",
            DATABASE_TIMEZONE: "UTC",
          },
          configs: [{ source: "salmon-yaml", target: "/tmp/salmon.yaml" }],
          ports: [`${g.port}:8080`],
          networks: ["default", ...g.networks],
          depends_on: {
            postgres: { condition: "service_healthy" },
            ldap: { condition: "service_healthy" },
          },
        },
      },
      configs,
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

async function record(ctx: Context, running: boolean): Promise<DataHandle> {
  const g = ctx.globalArgs;
  return await ctx.writeResource("stack", "stack", {
    project: g.project,
    image: g.image,
    issuerUrl: g.issuerUrl,
    port: g.port,
    localIssuerUrl: localIssuerUrl(g),
    running,
    checkedAt: new Date().toISOString(),
  });
}

/** Model definition for the Salmon stack. */
export const model = {
  type: "@dataverket/salmon/stack",
  version: "2026.10.26.1",
  globalArguments: GlobalArgsSchema,
  resources: {
    stack: {
      description: "The stack's project, image and issuer URLs",
      schema: StackSchema,
      lifetime: "infinite",
      garbageCollection: 10,
    },
  },
  methods: {
    ensure: {
      description:
        "Start Salmon, Postgres and the seeded LDAP, or leave them running, and wait for discovery",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const g = ctx.globalArgs;
        ctx.logger.info("Starting stack {project} with {image}", {
          project: g.project,
          image: g.image,
        });
        await run("docker", [
          "compose",
          "-f",
          "-",
          "up",
          "-d",
          "--wait",
          "--remove-orphans",
        ], { stdin: composeProject(g), signal: ctx.signal });

        const local = localIssuerUrl(g);
        const deadline = Date.now() + g.startTimeoutSeconds * 1000;
        while (!(await discoveryAnswers(local, ctx.signal))) {
          if (Date.now() > deadline) {
            const logs = await exec("docker", [
              "compose",
              "-p",
              g.project,
              "logs",
              "--tail",
              "20",
              "salmon",
            ], { signal: ctx.signal });
            throw new Error(
              `Salmon did not answer ${local}.well-known/openid-configuration within ${g.startTimeoutSeconds}s:\n${logs.stdout}${logs.stderr}`,
            );
          }
          await sleep(1000);
        }
        ctx.logger.info("Salmon {image} answers at {url}", {
          image: g.image,
          url: g.issuerUrl,
        });
        return { dataHandles: [await record(ctx, true)] };
      },
    },
    stop: {
      description: "Remove the stack's containers, network and volumes",
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
        return { dataHandles: [await record(ctx, false)] };
      },
    },
  },
};
