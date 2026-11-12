import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./grant.ts";
import type { ModelContext } from "./common.ts";
import { assertNoPlanted, fail, harness, type Reply } from "./test_support.ts";

Deno.test("every type carries an upgrade to the version it declares", async () => {
  for (
    const file of [
      "action",
      "app",
      "grant",
      "org",
      "project",
      "settings",
      "user",
    ]
  ) {
    const loaded = (await import(`./${file}.ts`)).model as {
      version: string;
      upgrades: {
        toVersion: string;
        upgradeAttributes: (
          old: Record<string, unknown>,
        ) => Record<string, unknown>;
      }[];
    };
    const last = loaded.upgrades[loaded.upgrades.length - 1];
    assertEquals(last.toVersion, loaded.version, file);
    const args = { apiUrl: "https://zitadel.example.org", keyJsonFile: "~/k" };
    assertEquals(last.upgradeAttributes(args), args, file);
  }
});

// ---------------------------------------------------------------------------
// Methods, with a stub caller answering only the calls each test names.
// ---------------------------------------------------------------------------

type H = ReturnType<typeof harness>;
interface Method {
  arguments: { parse(value: unknown): unknown };
  // deno-lint-ignore no-explicit-any
  execute(args: any, context: ModelContext): Promise<unknown>;
}

/** Run a method with its arguments parsed as the CLI parses them. */
function run(method: Method, args: Record<string, unknown>, h: H) {
  return method.execute(method.arguments.parse(args), h.context);
}

const SEARCH = "POST /management/v1/users/grants/_search";
const GRANT = {
  id: "500",
  userId: "200",
  projectId: "300",
  roleKeys: ["reader"],
  state: "USER_GRANT_STATE_ACTIVE",
  displayName: "Ada",
  userName: "ada",
  projectName: "fabrikk",
};

/** The user and the project every test resolves by id. */
function routes(extra: Record<string, Reply | Reply[]>) {
  return {
    "GET /v2/users/200": { user: { userId: "200", username: "ada" } },
    "GET /management/v1/projects/300": {
      project: { id: "300", name: "fabrikk" },
    },
    ...extra,
  };
}

const ids = { user: "200", project: "300" };
const m = model.methods;

Deno.test("grant list stores each grant under username and project name", async () => {
  using h = harness({ [SEARCH]: { result: [GRANT] } });
  await run(m.list, {}, h);
  const [w] = h.written();
  assertEquals([w.spec, w.name, w.data.roleKeys], [
    "grant",
    "grant-ada-fabrikk",
    ["reader"],
  ]);
  assertEquals(h.forgotten, ["grant-200-300"]);
  assertNoPlanted(h);
});

Deno.test("grant list fails when the search is refused", async () => {
  using h = harness({ [SEARCH]: fail(403, "denied") });
  await assertRejects(() => run(m.list, {}, h), Error, "HTTP 403");
  assertEquals(h.written(), []);
});

Deno.test("grant ensure converges the role set of an existing grant", async () => {
  using h = harness(routes({
    [SEARCH]: { result: [GRANT] },
    "PUT /management/v1/users/200/grants/500": {},
  }));
  await run(m.ensure, { ...ids, roleKeys: '["admin","reader"]' }, h);
  assertEquals(h.calls.at(-1)?.body, { roleKeys: ["admin", "reader"] });
  const [w] = h.written();
  assertEquals([w.name, w.data.action], ["grant-ada-fabrikk", "updated"]);
});

Deno.test("grant ensure creates a missing grant", async () => {
  using h = harness(routes({
    [SEARCH]: { result: [] },
    "POST /management/v1/users/200/grants": { userGrantId: "501" },
  }));
  await run(m.ensure, { ...ids, roleKeys: ["reader"] }, h);
  assertEquals(h.calls.at(-1)?.body, {
    projectId: "300",
    roleKeys: ["reader"],
  });
  assertEquals(h.written()[0].data.action, "created");
});

Deno.test("grant ensure fails on a user that does not exist", async () => {
  using h = harness({ "GET /v2/users/200": fail(404, "User not found") });
  await assertRejects(
    () => run(m.ensure, { ...ids, roleKeys: ["reader"] }, h),
    Error,
    "no user",
  );
  assertEquals(h.written(), []);
});

Deno.test("grant setState deactivates an active grant", async () => {
  using h = harness(routes({
    [SEARCH]: { result: [GRANT] },
    "POST /management/v1/users/200/grants/500/_deactivate": {},
  }));
  await run(m.setState, { ...ids, state: "inactive" }, h);
  const [w] = h.written();
  assertEquals([w.spec, w.data.action, w.data.state], [
    "state",
    "deactivated",
    "inactive",
  ]);
});

Deno.test("grant setState fails when the user has no grant on the project", async () => {
  using h = harness(routes({ [SEARCH]: { result: [] } }));
  await assertRejects(
    () => run(m.setState, { ...ids, state: "inactive" }, h),
    Error,
    "has no grant",
  );
  assertEquals(h.written(), []);
});

Deno.test("grant delete removes the grant", async () => {
  using h = harness(routes({
    [SEARCH]: { result: [GRANT] },
    "DELETE /management/v1/users/200/grants/500": {},
  }));
  await run(m.delete, ids, h);
  const [w] = h.written();
  assertEquals([w.spec, w.data.deleted, w.data.action], [
    "deletion",
    true,
    "removed",
  ]);
  assert(h.logs().some((l) => l.startsWith("warning: deleted grant")));
});

Deno.test("grant delete with dryRun plans and calls no delete", async () => {
  using h = harness(routes({ [SEARCH]: { result: [GRANT] } }));
  await run(m.delete, { ...ids, dryRun: true }, h);
  assertEquals(h.calls.filter((c) => c.method === "DELETE"), []);
  assertEquals(h.written()[0].data.action, "planned");
  assertEquals(h.forgotten, []);
});

Deno.test("grant delete fails when the instance refuses the delete", async () => {
  using h = harness(routes({
    [SEARCH]: { result: [GRANT] },
    "DELETE /management/v1/users/200/grants/500": fail(403, "denied"),
  }));
  await assertRejects(() => run(m.delete, ids, h), Error, "HTTP 403");
  assertEquals(h.written(), []);
});
