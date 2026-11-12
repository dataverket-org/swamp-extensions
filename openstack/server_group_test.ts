import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeServerGroup } from "./server_group.ts";
import { SERVER_GROUP_SHOW } from "./fixtures.ts";
import { fail, withStub } from "./test_support.ts";

const ID = SERVER_GROUP_SHOW.id;
const GONE = fail("No ServerGroup found for web-spread");

Deno.test("normalizeServerGroup reads policy (new) or policies (old microversion)", () => {
  const g = normalizeServerGroup(SERVER_GROUP_SHOW);
  assertEquals(g.policy, "anti-affinity");
  assertEquals(g.members, ["55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8"]);
  assertEquals(g.rules, { max_server_per_host: "1" });
  const old = normalizeServerGroup({
    ...SERVER_GROUP_SHOW,
    policy: undefined,
    policies: ["affinity"],
  });
  assertEquals(old.policy, "affinity");
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;

Deno.test("list shows each listed server group and writes one record each", () =>
  withStub([
    ["server group list -c ID", { json: [{ ID }] }],
    [`server group show ${ID}`, { json: SERVER_GROUP_SHOW }],
  ], async (h) => {
    await M.list.execute({}, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.policy]), [[
      "serverGroup",
      "servergroup-web-spread",
      "anti-affinity",
    ]]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} server groups");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([["server group list", fail("Forbidden (HTTP 403)")]], async (h) => {
    await assertRejects(
      () => M.list.execute({}, h.context),
      Error,
      "server group list failed (exit 1): Forbidden (HTTP 403)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the server group it reads", () =>
  withStub([
    ["server group show web-spread", { json: SERVER_GROUP_SHOW }],
  ], async (h) => {
    await M.get.execute({ serverGroup: "web-spread" }, h.context);
    const [w] = h.written();
    assertEquals([w.spec, w.data.id, w.data.members], [
      "serverGroup",
      ID,
      SERVER_GROUP_SHOW.members,
    ]);
  }));

Deno.test("get fails on a missing server group, and writes nothing", () =>
  withStub([["server group show web-spread", GONE]], async (h) => {
    await assertRejects(
      () => M.get.execute({ serverGroup: "web-spread" }, h.context),
      Error,
      "No ServerGroup found for web-spread",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create makes a group with its rule and writes what Nova shows", () =>
  withStub([
    ["server group show web-spread", GONE],
    [
      "server group create --policy anti-affinity --rule max_server_per_host=1 web-spread",
      { json: SERVER_GROUP_SHOW },
    ],
    [`server group show ${ID}`, { json: SERVER_GROUP_SHOW }],
  ], async (h) => {
    await M.create.execute({
      name: "web-spread",
      policy: "anti-affinity",
      maxServerPerHost: 1,
    }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name]), [[
      "serverGroup",
      "servergroup-web-spread",
    ]]);
  }));

Deno.test("create reuses a group of the same name without creating one", () =>
  withStub([
    ["server group show web-spread", { json: SERVER_GROUP_SHOW }],
  ], async (h) => {
    await M.create.execute(
      { name: "web-spread", policy: "anti-affinity" },
      h.context,
    );
    assertEquals(h.calls.some((c) => c.includes("create")), false);
    assertEquals(h.written().length, 1);
  }));

Deno.test("create fails when Nova refuses, and writes nothing", () =>
  withStub([
    ["server group show web-spread", GONE],
    [
      "server group create",
      fail("Quota exceeded for server groups (HTTP 403)"),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        M.create.execute(
          { name: "web-spread", policy: "affinity" },
          h.context,
        ),
      Error,
      "Quota exceeded for server groups",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("delete deletes the group by id and drops its record", () =>
  withStub([
    ["server group show web-spread", { json: SERVER_GROUP_SHOW }],
    [`server group delete ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.delete.execute({ serverGroup: "web-spread" }, h.context);
    assertEquals(h.calls.at(-1), `server group delete ${ID}`);
    assertEquals(h.deleted(), ["servergroup-web-spread"]);
  }));

Deno.test("delete fails when the CLI does, and drops nothing", () =>
  withStub([
    ["server group show web-spread", { json: SERVER_GROUP_SHOW }],
    ["server group delete", fail("Internal Server Error (HTTP 500)")],
  ], async (h) => {
    await assertRejects(
      () => M.delete.execute({ serverGroup: "web-spread" }, h.context),
      Error,
      `server group delete ${ID} failed (exit 1)`,
    );
    assertEquals(h.deleted(), []);
  }));
