import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { harness, writes } from "./stub_test.ts";
import { extension } from "./actions.ts";

Deno.test("the registration token's resource names no vault: swamp uses the repository's default", () => {
  const spec = extension.resources.runnerRegistration as Record<
    string,
    unknown
  >;
  assertEquals("vaultName" in spec, false);
});

// ───── the methods, through createModelTestContext with a stub client ─────

const M = extension.methods[0];
const A = "/api/v1/repos/acme/tool/actions";
const O = "/api/v1/orgs/acme/actions";
const runner = (id: number, name: string, extra: Record<string, unknown>) => ({
  id,
  uuid: `u${id}`,
  name,
  status: "offline",
  labels: ["x"],
  ...extra,
});

Deno.test("actions_secret_put sends the value once and records only name and scope", async () => {
  const h = harness({ [`PUT ${A}/secrets/DEPLOY_KEY`]: { status: 201 } });
  await M.actions_secret_put.execute(
    {
      owner: "acme",
      repo: "tool",
      name: "DEPLOY_KEY",
      value: "SECRET-VALUE-1",
    },
    h.context,
  );
  assertEquals(h.calls[0].body, { data: "SECRET-VALUE-1" });
  const w = h.written()[0];
  assertEquals([w.spec, w.name, w.data.action, w.data.scope], [
    "actionsSecret",
    "actions-secret-acme-tool-DEPLOY_KEY",
    "created",
    "repo",
  ]);
  assertEquals(
    JSON.stringify([h.written(), h.logs()]).includes("SECRET-VALUE-1"),
    false,
  );
});

Deno.test("actions_secret_put passes on the forge's refusal and records nothing", async () => {
  const h = harness({
    [`PUT ${O}/secrets/X`]: { status: 404, body: { message: "org not found" } },
  });
  await assertRejects(
    () =>
      M.actions_secret_put.execute(
        { owner: "acme", name: "X", value: "v" },
        h.context,
      ),
    Error,
    "HTTP 404: org not found",
  );
  assertEquals(h.written(), []);
});

Deno.test("runner_registration_token records the token for the vault, under the target", async () => {
  const h = harness({
    [`GET ${O}/runners/registration-token`]: {
      status: 200,
      body: { token: "REG-TOKEN-1" },
    },
  });
  await M.runner_registration_token.execute({ owner: "acme" }, h.context);
  const w = h.written()[0];
  assertEquals([w.spec, w.name, w.data.scope, w.data.target], [
    "runnerRegistration",
    "runner-registration-acme",
    "org",
    "acme",
  ]);
});

Deno.test("runner_registration_token refuses an answer without a token", async () => {
  const h = harness({
    [`GET ${O}/runners/registration-token`]: { status: 200, body: {} },
  });
  await assertRejects(
    () => M.runner_registration_token.execute({ owner: "acme" }, h.context),
    Error,
    "Forgejo returned no registration token",
  );
  assertEquals(h.written(), []);
});

Deno.test("runner_list records each runner with its level; two of a name by id", async () => {
  const h = harness({
    [`GET ${O}/runners?visible=true&limit=100&page=1`]: {
      status: 200,
      body: [
        runner(1, "b", { owner_id: 5 }),
        runner(2, "b", { owner_id: 5 }),
        runner(3, "c", {}),
      ],
    },
  });
  await M.runner_list.execute({ owner: "acme" }, h.context);
  assertEquals(h.written().map((w) => [w.name, w.data.level]), [
    ["runner-acme-b-1", "org"],
    ["runner-acme-b-2", "org"],
    ["runner-acme-c", "instance"],
  ]);
});

Deno.test("runner_list passes on the forge's refusal", async () => {
  const h = harness({
    [`GET ${O}/runners?visible=true&limit=100&page=1`]: {
      status: 404,
      body: { message: "not found" },
    },
  });
  await assertRejects(
    () => M.runner_list.execute({ owner: "acme" }, h.context),
    Error,
    "HTTP 404",
  );
});

Deno.test("runner_prune deletes the offline runners of its scope and keeps the rest, saying why", async () => {
  const h = harness({
    [`GET ${A}/runners?visible=true&limit=100&page=1`]: {
      status: 200,
      body: [
        runner(1, "b", { repo_id: 9 }),
        runner(2, "b", { repo_id: 9, status: "idle" }),
        runner(3, "b", { owner_id: 5 }),
      ],
    },
    [`DELETE ${A}/runners/1`]: { status: 204 },
  });
  await M.runner_prune.execute(
    { owner: "acme", repo: "tool", name: "b" },
    h.context,
  );
  const d = h.written()[0].data;
  assertEquals(h.written()[0].name, "runner-prune-acme-tool-b");
  assertEquals(d.deleted, [{ id: 1, uuid: "u1" }]);
  assertEquals(
    (d.kept as { id: number; reason: string }[]).map((k) => [k.id, k.reason]),
    [
      [2, "not offline"],
      [3, "an org runner; prune it at its own scope"],
    ],
  );
});

Deno.test("runner_prune passes on a refused delete", async () => {
  const h = harness({
    [`GET ${O}/runners?visible=true&limit=100&page=1`]: {
      status: 200,
      body: [runner(1, "b", { owner_id: 5 })],
    },
    [`DELETE ${O}/runners/1`]: { status: 403, body: { message: "no" } },
  });
  await assertRejects(
    () => M.runner_prune.execute({ owner: "acme", name: "b" }, h.context),
    Error,
    "HTTP 403: no",
  );
  assertEquals(h.written(), []);
});

Deno.test("repo_rename renames, verify-first, and records the new URLs", async () => {
  const R = "/api/v1/repos/acme";
  const h = harness({
    [`GET ${R}/old`]: { status: 200, body: { name: "old" } },
    [`GET ${R}/new`]: { status: 404 },
    [`PATCH ${R}/old`]: {
      status: 200,
      body: {
        name: "new",
        html_url: "h/new",
        clone_url: "c/new",
        ssh_url: "s/new",
      },
    },
  });
  await M.repo_rename.execute(
    { owner: "acme", name: "old", newName: "new" },
    h.context,
  );
  const w = h.written()[0];
  assertEquals([w.name, w.data.action, w.data.htmlUrl], [
    "repo-rename-acme-new",
    "renamed",
    "h/new",
  ]);
  assertEquals(writes(h.calls).map((c) => c.body), [{ name: "new" }]);
});

Deno.test("repo_rename refuses a name that is taken, writing nothing", async () => {
  const R = "/api/v1/repos/acme";
  const h = harness({
    [`GET ${R}/old`]: { status: 200, body: { name: "old" } },
    [`GET ${R}/new`]: { status: 200, body: { name: "new" } },
  });
  await assertRejects(
    () =>
      M.repo_rename.execute(
        { owner: "acme", name: "old", newName: "new" },
        h.context,
      ),
    Error,
    "acme/new already exists; refusing to rename onto it",
  );
  assertEquals([writes(h.calls), h.written()], [[], []]);
});
