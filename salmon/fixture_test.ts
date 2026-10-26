import { assert, assertEquals, assertMatch } from "jsr:@std/assert@1.0.13";
import { GlobalArgsSchema, ids, lit, seedSql, stableId } from "./fixture.ts";

const base = {
  project: "p",
  name: "orders",
  team: { name: "orders e2e" },
  apps: [{ key: "db", name: "orders database" }, {
    key: "other",
    name: "Bob's app",
  }],
  trust: { issuer: "https://kind:6443", subject: "system:serviceaccount:a:b" },
  grants: [{ app: "db" }, { app: "other", role: "ldap/Other" }],
};

Deno.test("ids are stable and differ per project, fixture and entry", async () => {
  const a = await stableId({ project: "p", name: "n" }, "app", "db");
  assertEquals(a, await stableId({ project: "p", name: "n" }, "app", "db"));
  assertMatch(
    a,
    /^[0-9a-f]{8}-[0-9a-f]{4}-8[0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/,
  );
  const others = await Promise.all([
    stableId({ project: "q", name: "n" }, "app", "db"),
    stableId({ project: "p", name: "m" }, "app", "db"),
    stableId({ project: "p", name: "n" }, "app", "other"),
    stableId({ project: "p", name: "n" }, "grant", "db"),
  ]);
  assertEquals(new Set([a, ...others]).size, 5);
});

Deno.test("a grant must name an app of the fixture", () => {
  const bad = { ...base, grants: [{ app: "missing" }] };
  assert(!GlobalArgsSchema.safeParse(bad).success);
  assert(GlobalArgsSchema.safeParse(base).success);
});

Deno.test("defaults: the registry team's group, Registry-Push, a secure trust", () => {
  const g = GlobalArgsSchema.parse(base);
  assertEquals(g.team.group, "ldap/Salmon-Registry-Administrator");
  assertEquals(g.grants[0].role, "ldap/Registry-Push");
  assertEquals(g.trust.insecure, false);
  assertEquals(g.trust.audience, "");
});

Deno.test("seeding replaces the fixture's rows in one transaction", async () => {
  const g = GlobalArgsSchema.parse(base);
  const id = await ids(g);
  const sql = seedSql(g, id);
  assert(sql.startsWith("BEGIN;\nDELETE FROM grants"));
  assert(sql.endsWith("COMMIT;"));
  assert(sql.indexOf("DELETE FROM teams") < sql.indexOf("INSERT INTO teams"));
  assertEquals(sql.match(/INSERT INTO apps/g)?.length, 2);
  assertEquals(sql.match(/INSERT INTO grants/g)?.length, 2);
  assert(sql.includes(`'["ldap/Salmon-Registry-Administrator"]'`));
  assert(sql.includes(`'ldap/Other', ${lit(id.apps.other)}`));
});

Deno.test("values are quoted as SQL literals", async () => {
  assertEquals(lit("Bob's app"), "'Bob''s app'");
  const g = GlobalArgsSchema.parse(base);
  assert(seedSql(g, await ids(g)).includes("'Bob''s app'"));
});
