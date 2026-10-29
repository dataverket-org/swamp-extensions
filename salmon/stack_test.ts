import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.13";
import {
  ADMIN_GROUP,
  composeProject,
  GlobalArgsSchema,
  ids,
  keyEncryptionKey,
  localIssuerUrl,
  MANAGERS,
  salmonConfig,
  seedFile,
  stableId,
  USERS,
} from "./stack.ts";

const fixture = {
  project: "t",
  port: 18090,
  name: "orders",
  apps: [{ key: "db", name: "orders database" }, {
    key: "other",
    name: "Bob's app",
  }],
  trust: { issuer: "https://kind:6443", subject: "system:serviceaccount:a:b" },
  grants: [{ app: "db" }, { app: "other", role: "users/Other" }],
};

const args = (over: Record<string, unknown> = {}) =>
  GlobalArgsSchema.parse({ ...fixture, ...over });

async function project(
  over: Record<string, unknown> = {},
  revoked: string[] = [],
) {
  const g = args(over);
  const seed = seedFile(g, await ids(g), revoked);
  return { g, seed, p: JSON.parse(await composeProject(g, seed)) };
}

Deno.test("one container: Salmon on in-memory SQLite, seeded, its port alone published", async () => {
  const { p } = await project();
  assertEquals(Object.keys(p.services), ["salmon"]);
  const s = p.services.salmon;
  assertEquals(s.ports, ["18090:8080"]);
  assertEquals(s.command, ["--seed", "/tmp/seed.yaml"]);
  assertEquals(s.environment.DATABASE_DRIVER, "sqlite");
  assertEquals(atob(s.environment.SALMON_KEY_ENCRYPTION_KEY).length, 32);
  assertEquals(s.working_dir, "/tmp");
  assertEquals(s.configs, [
    { source: "salmon-yaml", target: "/tmp/salmon.yaml" },
    { source: "seed", target: "/tmp/seed.yaml" },
  ]);
});

Deno.test("the generated project is the same between runs and changes with the seed", async () => {
  const a = await project();
  assertEquals(
    await composeProject(a.g, a.seed),
    await composeProject(a.g, a.seed),
  );
  assertEquals(await keyEncryptionKey(a.g), await keyEncryptionKey(args()));
  const revoked = await project({}, ["db"]);
  const label = "org.dataverket.salmon.seed-sha256";
  assert(
    a.p.services.salmon.labels[label] !==
      revoked.p.services.salmon.labels[label],
  );
});

Deno.test("salmon.yaml: the issuer, the userdb people, who manages Registry-Push, the admins", () => {
  const c = JSON.parse(
    salmonConfig(args({ issuerUrl: "http://10.0.0.1:18090/issuer/" })),
  );
  assertEquals(c.issuer_url, "http://10.0.0.1:18090/issuer/");
  assertEquals(c.externalidp, [{
    type: "userdb",
    id: "users",
    name: "Test users",
    data: { users: USERS, managers: MANAGERS },
  }]);
  assertEquals(c.admins, [ADMIN_GROUP]);
  assertEquals(MANAGERS["Registry-Push"], "Salmon-Registry-Administrator");
  assert(
    USERS.find((u) => u.email === "bob@salmon.local")?.groups.includes(
      "Salmon-Registry-Administrator",
    ),
  );
});

Deno.test("the seed has the apps and trust under stable ids, and their grants", async () => {
  const g = args();
  const id = await ids(g);
  const s = JSON.parse(seedFile(g, id));
  assertEquals(s.apps, [
    {
      id: id.apps.db,
      name: "orders database",
      owners: ["users/Salmon-Registry-Administrator"],
    },
    {
      id: id.apps.other,
      name: "Bob's app",
      owners: ["users/Salmon-Registry-Administrator"],
    },
  ]);
  assertEquals(s.trusts, [{
    id: id.trustId,
    owners: ["users/Salmon-Registry-Administrator"],
    issuer: "https://kind:6443",
    subject: "system:serviceaccount:a:b",
    audience: "",
    insecure: false,
  }]);
  assertEquals(s.grants, [
    { trust: id.trustId, app: id.apps.db, role: "users/Registry-Push" },
    { trust: id.trustId, app: id.apps.other, role: "users/Other" },
  ]);
  assertEquals(id, await ids(args()));
});

Deno.test("a revoked app's grants are left out of the seed", async () => {
  const g = args();
  const id = await ids(g);
  assertEquals(JSON.parse(seedFile(g, id, ["db"])).grants, [
    { trust: id.trustId, app: id.apps.other, role: "users/Other" },
  ]);
});

Deno.test("without a fixture the seed is empty", async () => {
  const g = GlobalArgsSchema.parse({ project: "t" });
  assertEquals(JSON.parse(seedFile(g, await ids(g))), {
    apps: [],
    trusts: [],
    grants: [],
  });
  assertEquals((await ids(g)).trustId, "");
});

Deno.test("refused: a grant at no app, grants without a trust, duplicate keys, unqualified groups", () => {
  for (
    const over of [
      { grants: [{ app: "missing" }] },
      { trust: undefined },
      { apps: [...fixture.apps, { key: "db", name: "again" }] },
      { owners: ["Salmon-Registry-Administrator"] },
      { grants: [{ app: "db", role: "Registry-Push" }] },
      { issuerUrl: "http://localhost:8080/other/" },
    ]
  ) {
    assert(
      !GlobalArgsSchema.safeParse({ ...fixture, ...over }).success,
      JSON.stringify(over),
    );
  }
});

Deno.test("ids are stable UUIDs and differ per project, fixture and entry", async () => {
  const a = await stableId({ project: "p", name: "n" }, "app", "db");
  assertMatch(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const others = await Promise.all([
    stableId({ project: "q", name: "n" }, "app", "db"),
    stableId({ project: "p", name: "m" }, "app", "db"),
    stableId({ project: "p", name: "n" }, "app", "other"),
    stableId({ project: "p", name: "n" }, "trust"),
  ]);
  assertEquals(new Set([a, ...others]).size, 5);
});

Deno.test("extra networks are joined as external ones", async () => {
  const { p } = await project({ networks: ["kind"] });
  assertEquals(p.services.salmon.networks, ["default", "kind"]);
  assertEquals(p.networks, { kind: { name: "kind", external: true } });
  assertEquals(localIssuerUrl(args()), "http://127.0.0.1:18090/issuer/");
});
