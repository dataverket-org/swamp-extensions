import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { HOSTILE } from "../lib/test_inputs.ts";
import { harness } from "./stub_test.ts";
import {
  ADMIN_GROUP,
  composeProject,
  GlobalArgsSchema,
  ids,
  keyEncryptionKey,
  localIssuerUrl,
  MANAGERS,
  model,
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

Deno.test("the image is pulled as pullPolicy says, only when missing by default", async () => {
  assertEquals((await project()).p.services.salmon.pull_policy, "missing");
  assertEquals(
    (await project({ pullPolicy: "always" })).p.services.salmon.pull_policy,
    "always",
  );
  assert(
    !GlobalArgsSchema.safeParse({ ...fixture, pullPolicy: "daily" }).success,
  );
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

Deno.test("a project name shaped like a flag, a path or shell text never parses", () => {
  for (const project of [...HOSTILE, "-p", "--project-directory=/", "A"]) {
    if (/^[a-z0-9][a-z0-9_-]*$/.test(project)) continue;
    assert(
      !GlobalArgsSchema.safeParse({ ...fixture, project }).success,
      JSON.stringify(project),
    );
  }
  for (const over of [{ upTimeoutSeconds: 0 }, { startTimeoutSeconds: -1 }]) {
    assert(!GlobalArgsSchema.safeParse({ ...fixture, ...over }).success);
  }
});

Deno.test("every method that changes something says so", () => {
  for (const method of Object.values(model.methods)) {
    assertEquals(method.kind, "action");
  }
});

// ───── the methods, through createModelTestContext with a stub spawn ─────

const M = model.methods;
const UP = "docker compose -f - up -d --wait --remove-orphans";
const PS =
  "docker ps -q --filter label=com.docker.compose.project=t --filter label=com.docker.compose.service=salmon";
const LOGS = "docker compose -p t logs --tail 20 salmon";
const DOWN = "docker compose -p t down --volumes --remove-orphans";
const DISCOVERY =
  "GET http://127.0.0.1:18090/issuer/.well-known/openid-configuration";

Deno.test("ensure starts the project from stdin, waits for discovery and records the stack running", async () => {
  const g = args();
  using h = harness({ [UP]: {} }, {
    globalArgs: g,
    http: { [DISCOVERY]: { status: 200, body: {} } },
  });
  await M.ensure.execute({}, h.context);
  assertEquals(h.calls.map((c) => c.key), [UP]);
  assertEquals(JSON.parse(h.calls[0].stdin ?? "").name, "t");
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [["stack", "stack"]]);
  const id = await ids(g);
  assertEquals(
    [w[0].data.running, w[0].data.error, w[0].data.apps, w[0].data.trustId],
    [true, "", id.apps, id.trustId],
  );
  assertEquals(
    (w[0].data.grants as { revoked: boolean }[]).map((x) => x.revoked),
    [false, false],
  );
  assertEquals(
    h.logs().at(-1),
    "Salmon registry.dataverket.org/tools/salmon:latest answers at http://localhost:8080/issuer/",
  );
});

Deno.test("ensure: a refused compose up fails with Salmon's log, records the error and keeps the key out", async () => {
  const g = args();
  const kek = await keyEncryptionKey(g);
  using h = harness({
    [UP]: { code: 1, stderr: `seed refused; key ${kek}` },
    [LOGS]: { stdout: "salmon: bad seed: unknown app" },
    [PS]: { stdout: "" },
  }, { globalArgs: g });
  const err = await assertRejects(() => M.ensure.execute({}, h.context));
  assertStringIncludes(String(err), "docker compose up failed (exit 1)");
  assertStringIncludes(String(err), "bad seed: unknown app");
  const w = h.written();
  assertEquals(w.length, 1);
  assertEquals(w[0].data.running, false);
  assertStringIncludes(String(w[0].data.error), "docker compose up failed");
  assertEquals(JSON.stringify([w, h.logs(), String(err)]).includes(kek), false);
});

Deno.test("revoke restarts Salmon without the app's grants and records them revoked", async () => {
  const g = args();
  using h = harness({ [UP]: {} }, {
    globalArgs: g,
    http: { [DISCOVERY]: { status: 200, body: {} } },
  });
  await M.revoke.execute({ app: "db" }, h.context);
  const seed = JSON.parse(
    JSON.parse(h.calls[0].stdin ?? "").configs.seed.content,
  );
  const id = await ids(g);
  assertEquals(seed.grants.map((x: { app: string }) => x.app), [
    id.apps.other,
  ]);
  const w = h.written();
  assertEquals(
    (w[0].data.grants as { app: string; revoked: boolean }[]).map((
      x,
    ) => [x.app, x.revoked]),
    [["db", true], ["other", false]],
  );
  assertEquals(w[0].data.running, true);
});

Deno.test("revoke refuses an app the fixture grants nothing at, before docker runs", async () => {
  using h = harness({}, { globalArgs: args() });
  await assertRejects(
    () => M.revoke.execute({ app: "nope" }, h.context),
    Error,
    "the fixture grants nothing at app nope",
  );
  assertEquals([h.calls, h.written()], [[], []]);
});

Deno.test("stop removes the project and records the stack not running", async () => {
  using h = harness({ [DOWN]: {} }, { globalArgs: args() });
  await M.stop.execute({}, h.context);
  assertEquals(h.calls.map((c) => c.key), [DOWN]);
  const w = h.written();
  assertEquals([w[0].data.running, w[0].data.error], [false, ""]);
  assertEquals(h.logs(), ["Removing stack t"]);
});

Deno.test("stop: a failed compose down fails and records the error, with the container still running", async () => {
  using h = harness({
    [DOWN]: { code: 1, stderr: "network t_default has active endpoints" },
    [PS]: { stdout: "abc123\n" },
  }, { globalArgs: args() });
  await assertRejects(
    () => M.stop.execute({}, h.context),
    Error,
    "docker compose down failed (exit 1): network t_default has active endpoints",
  );
  const w = h.written();
  assertEquals(w[0].data.running, true);
  assertStringIncludes(String(w[0].data.error), "has active endpoints");
});
