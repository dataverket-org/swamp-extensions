import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model } from "./project.ts";
import { assertNoPlanted, fail, harness } from "./test_support.ts";

Deno.test("project-grant methods carry the kinds a collection needs", () => {
  assertEquals(model.methods.projectGrantDelete.kind, "action");
  assertEquals(model.methods.projectGrantMemberRemove.kind, "action");
  assertEquals(model.methods.projectGrantEnsure.kind, "create");
  assertEquals(model.methods.projectGrantList.kind, "list");
});

const P = "/management/v1/projects";
const PROJECT = {
  id: "200",
  name: "fabrikk",
  state: "PROJECT_STATE_ACTIVE",
  projectRoleAssertion: true,
};
const GET_PROJECT = { [`GET ${P}/200`]: { project: PROJECT } };
const GRANT = {
  grantId: "300",
  grantedOrgId: "500",
  grantedOrgName: "tenant",
  grantedRoleKeys: ["reader"],
  state: "PROJECT_GRANT_STATE_ACTIVE",
};
const GRANTS = { [`POST ${P}/200/grants/_search`]: { result: [GRANT] } };
const MEMBERS = `POST ${P}/200/grants/300/members/_search`;

Deno.test("list stores every project", async () => {
  const h = harness({ [`POST ${P}/_search`]: { result: [PROJECT] } });
  await model.methods.list.execute({}, h.context);
  const [w] = h.written();
  assertEquals([w.spec, w.name, w.data.state], [
    "project",
    "project-fabrikk",
    "active",
  ]);
  assertNoPlanted(h);
});

Deno.test("list fails when the search fails, and writes nothing", async () => {
  const h = harness({ [`POST ${P}/_search`]: fail(403) });
  await assertRejects(
    () => model.methods.list.execute({}, h.context),
    Error,
    "HTTP 403",
  );
  assertEquals(h.written(), []);
  assertNoPlanted(h);
});

Deno.test("get resolves a name and stores the project", async () => {
  const h = harness({ [`POST ${P}/_search`]: { result: [PROJECT] } });
  await model.methods.get.execute({ project: "fabrikk" }, h.context);
  assertEquals(h.written()[0].data.id, "200");
});

Deno.test("get refuses a project that does not exist", async () => {
  const h = harness({ [`GET ${P}/201`]: fail(404, "not found") });
  await assertRejects(
    () => model.methods.get.execute({ project: "201" }, h.context),
    Error,
    'no project "201"',
  );
  assertEquals(h.written(), []);
});

Deno.test("ensure creates a missing project", async () => {
  const h = harness({
    [`POST ${P}/_search`]: { result: [] },
    [`POST ${P}`]: { id: "200" },
    ...GET_PROJECT,
  });
  await model.methods.ensure.execute({ name: "fabrikk" }, h.context);
  assertEquals(h.calls[1].body, {
    name: "fabrikk",
    projectRoleAssertion: false,
    projectRoleCheck: false,
    hasProjectCheck: false,
  });
  const [w] = h.written();
  assertEquals([w.name, w.data.action, w.data.id], [
    "project-fabrikk",
    "created",
    "200",
  ]);
});

Deno.test("ensure leaves a project as asked alone", async () => {
  const h = harness({ [`POST ${P}/_search`]: { result: [PROJECT] } });
  await model.methods.ensure.execute(
    { name: "fabrikk", roleAssertion: true },
    h.context,
  );
  assertEquals(h.written()[0].data.action, "unchanged");
  assertEquals(h.calls.length, 1);
});

Deno.test("ensure fails when the create is refused", async () => {
  const h = harness({
    [`POST ${P}/_search`]: { result: [] },
    [`POST ${P}`]: fail(409, "already exists"),
  });
  await assertRejects(
    () => model.methods.ensure.execute({ name: "fabrikk" }, h.context),
    Error,
    "HTTP 409",
  );
  assertEquals(h.written(), []);
});

Deno.test("update renames and keeps the flags it was not given", async () => {
  const h = harness({
    [`GET ${P}/200`]: [{ project: PROJECT }, {
      project: { ...PROJECT, name: "fabrikk2" },
    }],
    [`PUT ${P}/200`]: {},
  });
  await model.methods.update.execute(
    { project: "200", name: "fabrikk2" },
    h.context,
  );
  assertEquals(h.calls[1].body, {
    name: "fabrikk2",
    projectRoleAssertion: true,
    projectRoleCheck: false,
    hasProjectCheck: false,
  });
  const [w] = h.written();
  assertEquals([w.name, w.data.action], ["project-fabrikk2", "updated"]);
});

Deno.test("update fails when the write is refused", async () => {
  const h = harness({ ...GET_PROJECT, [`PUT ${P}/200`]: fail(400) });
  await assertRejects(
    () =>
      model.methods.update.execute(
        { project: "200", roleCheck: true },
        h.context,
      ),
    Error,
    "HTTP 400",
  );
  assertEquals(h.written(), []);
});

Deno.test("setState deactivates an active project", async () => {
  const h = harness({ ...GET_PROJECT, [`POST ${P}/200/_deactivate`]: {} });
  await model.methods.setState.execute(
    { project: "200", state: "inactive" },
    h.context,
  );
  const [w] = h.written();
  assertEquals([w.spec, w.name, w.data.previousState, w.data.action], [
    "state",
    "project-state-200",
    "active",
    "deactivated",
  ]);
});

Deno.test("setState fails when the project cannot be read", async () => {
  const h = harness({ [`GET ${P}/200`]: fail(500) });
  await assertRejects(
    () =>
      model.methods.setState.execute(
        { project: "200", state: "inactive" },
        h.context,
      ),
    Error,
    "HTTP 500",
  );
  assertEquals(h.written(), []);
});

Deno.test("delete removes the project and tombstones its record", async () => {
  const h = harness({ ...GET_PROJECT, [`DELETE ${P}/200`]: {} });
  await model.methods.delete.execute(
    { project: "200", confirm: "fabrikk", dryRun: false },
    h.context,
  );
  assertEquals(h.calls.map((c) => c.method), ["GET", "DELETE"]);
  assertEquals(h.forgotten, ["project-fabrikk"]);
  const [w] = h.written();
  assertEquals([w.spec, w.data.deleted, w.data.action], [
    "deletion",
    true,
    "removed",
  ]);
});

Deno.test("delete refuses a confirm that is not the live name", async () => {
  const h = harness(GET_PROJECT);
  await assertRejects(
    () =>
      model.methods.delete.execute(
        { project: "200", confirm: "other", dryRun: false },
        h.context,
      ),
    Error,
    "refusing to delete project name",
  );
  assertEquals(h.calls.length, 1);
  assertEquals(h.written(), []);
  assertEquals(h.forgotten, []);
});

Deno.test("delete with dryRun only plans", async () => {
  const h = harness(GET_PROJECT);
  await model.methods.delete.execute(
    { project: "200", confirm: "fabrikk", dryRun: true },
    h.context,
  );
  assertEquals(h.written()[0].data.action, "planned");
  assertEquals(h.calls.length, 1);
});

Deno.test("roleList stores the roles keyed by project and key", async () => {
  const h = harness({
    ...GET_PROJECT,
    [`POST ${P}/200/roles/_search`]: {
      result: [{ key: "reader", displayName: "Reader" }],
    },
  });
  await model.methods.roleList.execute({ project: "200" }, h.context);
  const [w] = h.written();
  assertEquals([w.spec, w.name, w.data.key], [
    "role",
    "role-fabrikk-reader",
    "reader",
  ]);
});

Deno.test("roleList fails when the search fails", async () => {
  const h = harness({
    ...GET_PROJECT,
    [`POST ${P}/200/roles/_search`]: fail(503),
  });
  await assertRejects(
    () => model.methods.roleList.execute({ project: "200" }, h.context),
    Error,
    "HTTP 503",
  );
  assertEquals(h.written(), []);
});

Deno.test("roleEnsure creates a missing role", async () => {
  const h = harness({
    ...GET_PROJECT,
    [`POST ${P}/200/roles/_search`]: { result: [] },
    [`POST ${P}/200/roles`]: {},
  });
  await model.methods.roleEnsure.execute(
    { project: "200", roleKey: "reader", displayName: "Reader" },
    h.context,
  );
  assertEquals(h.calls[2].body, {
    roleKey: "reader",
    displayName: "Reader",
    group: "",
  });
  assertEquals(h.written()[0].data.action, "created");
});

Deno.test("roleEnsure fails when the create is refused", async () => {
  const h = harness({
    ...GET_PROJECT,
    [`POST ${P}/200/roles/_search`]: { result: [] },
    [`POST ${P}/200/roles`]: fail(400),
  });
  await assertRejects(
    () =>
      model.methods.roleEnsure.execute(
        { project: "200", roleKey: "reader" },
        h.context,
      ),
    Error,
    "HTTP 400",
  );
  assertEquals(h.written(), []);
});

Deno.test("roleRemove deletes the role and tombstones it", async () => {
  const h = harness({
    ...GET_PROJECT,
    [`POST ${P}/200/roles/_search`]: { result: [{ key: "reader" }] },
    [`DELETE ${P}/200/roles/reader`]: {},
  });
  await model.methods.roleRemove.execute(
    { project: "200", roleKey: "reader", dryRun: false },
    h.context,
  );
  assertEquals(h.forgotten, ["role-fabrikk-reader"]);
  assertEquals(h.written()[0].data.deleted, true);
});

Deno.test("roleRemove with dryRun deletes nothing", async () => {
  const h = harness({
    ...GET_PROJECT,
    [`POST ${P}/200/roles/_search`]: { result: [{ key: "reader" }] },
  });
  await model.methods.roleRemove.execute(
    { project: "200", roleKey: "reader", dryRun: true },
    h.context,
  );
  assertEquals(h.calls.some((c) => c.method === "DELETE"), false);
  assertEquals(h.written()[0].data.action, "planned");
  assertEquals(h.forgotten, []);
});

Deno.test("projectGrantList stores each grant", async () => {
  const h = harness({ ...GET_PROJECT, ...GRANTS });
  await model.methods.projectGrantList.execute({ project: "200" }, h.context);
  const [w] = h.written();
  assertEquals([w.spec, w.name, w.data.roleKeys], [
    "project-grant",
    "project-grant-fabrikk-500",
    ["reader"],
  ]);
});

Deno.test("projectGrantList fails on an unknown project", async () => {
  const h = harness({ [`POST ${P}/_search`]: { result: [] } });
  await assertRejects(
    () =>
      model.methods.projectGrantList.execute({ project: "nope" }, h.context),
    Error,
    'no project "nope"',
  );
});

Deno.test("projectGrantEnsure converges the role set", async () => {
  const h = harness({
    ...GET_PROJECT,
    ...GRANTS,
    [`PUT ${P}/200/grants/300`]: {},
  });
  await model.methods.projectGrantEnsure.execute(
    { project: "200", grantedOrgId: "500", roleKeys: ["reader", "writer"] },
    h.context,
  );
  assertEquals(h.calls[2].body, { roleKeys: ["reader", "writer"] });
  const [w] = h.written();
  assertEquals([w.data.action, w.data.roleKeys], [
    "updated",
    ["reader", "writer"],
  ]);
});

Deno.test("projectGrantEnsure fails when the grant is refused", async () => {
  const h = harness({
    ...GET_PROJECT,
    [`POST ${P}/200/grants/_search`]: { result: [] },
    [`POST ${P}/200/grants`]: fail(404, "org not found"),
  });
  await assertRejects(
    () =>
      model.methods.projectGrantEnsure.execute(
        { project: "200", grantedOrgId: "500", roleKeys: ["reader"] },
        h.context,
      ),
    Error,
    "HTTP 404",
  );
  assertEquals(h.written(), []);
});

Deno.test("projectGrantSetState deactivates the grant", async () => {
  const h = harness({
    ...GET_PROJECT,
    ...GRANTS,
    [`POST ${P}/200/grants/300/_deactivate`]: {},
  });
  await model.methods.projectGrantSetState.execute(
    { project: "200", grantedOrgId: "500", state: "inactive" },
    h.context,
  );
  const [w] = h.written();
  assertEquals([w.name, w.data.action], [
    "project-grant-state-fabrikk-500",
    "deactivated",
  ]);
});

Deno.test("projectGrantSetState refuses a grant that does not exist", async () => {
  const h = harness({
    ...GET_PROJECT,
    [`POST ${P}/200/grants/_search`]: { result: [] },
  });
  await assertRejects(
    () =>
      model.methods.projectGrantSetState.execute(
        { project: "200", grantedOrgId: "500", state: "inactive" },
        h.context,
      ),
    Error,
    "is not granted to organization 500",
  );
  assertEquals(h.written(), []);
});

Deno.test("projectGrantDelete takes the grant back", async () => {
  const h = harness({
    ...GET_PROJECT,
    ...GRANTS,
    [`DELETE ${P}/200/grants/300`]: {},
  });
  await model.methods.projectGrantDelete.execute(
    { project: "200", grantedOrgId: "500", confirm: "tenant", dryRun: false },
    h.context,
  );
  assertEquals(h.forgotten, ["project-grant-fabrikk-500"]);
  assertEquals(h.written()[0].data.action, "removed");
});

Deno.test("projectGrantDelete refuses a confirm that is not the org name", async () => {
  const h = harness({ ...GET_PROJECT, ...GRANTS });
  await assertRejects(
    () =>
      model.methods.projectGrantDelete.execute(
        { project: "200", grantedOrgId: "500", confirm: "500", dryRun: false },
        h.context,
      ),
    Error,
    "refusing to delete granted organization name",
  );
  assertEquals(h.calls.some((c) => c.method === "DELETE"), false);
  assertEquals(h.written(), []);
});

Deno.test("projectGrantMemberList stores the grant's members", async () => {
  const h = harness({
    ...GET_PROJECT,
    ...GRANTS,
    [MEMBERS]: { result: [{ userId: "600", roles: ["PROJECT_GRANT_OWNER"] }] },
  });
  await model.methods.projectGrantMemberList.execute(
    { project: "200", grantedOrgId: "500" },
    h.context,
  );
  const [w] = h.written();
  assertEquals([w.spec, w.name], [
    "project-grant-member",
    "project-grant-member-fabrikk-600",
  ]);
});

Deno.test("projectGrantMemberList refuses a grant that does not exist", async () => {
  const h = harness({
    ...GET_PROJECT,
    [`POST ${P}/200/grants/_search`]: { result: [] },
  });
  await assertRejects(
    () =>
      model.methods.projectGrantMemberList.execute(
        { project: "200", grantedOrgId: "500" },
        h.context,
      ),
    Error,
    "is not granted",
  );
});

Deno.test("projectGrantMemberEnsure adds a missing member", async () => {
  const h = harness({
    ...GET_PROJECT,
    ...GRANTS,
    [MEMBERS]: { result: [] },
    [`POST ${P}/200/grants/300/members`]: {},
  });
  await model.methods.projectGrantMemberEnsure.execute(
    {
      project: "200",
      grantedOrgId: "500",
      userId: "600",
      roles: ["PROJECT_GRANT_OWNER"],
    },
    h.context,
  );
  assertEquals(h.calls[3].body, {
    userId: "600",
    roles: ["PROJECT_GRANT_OWNER"],
  });
  assertEquals(h.written()[0].data.action, "created");
});

Deno.test("projectGrantMemberEnsure fails when the add is refused", async () => {
  const h = harness({
    ...GET_PROJECT,
    ...GRANTS,
    [MEMBERS]: { result: [] },
    [`POST ${P}/200/grants/300/members`]: fail(400, "user not in org"),
  });
  await assertRejects(
    () =>
      model.methods.projectGrantMemberEnsure.execute(
        { project: "200", grantedOrgId: "500", userId: "600", roles: ["X"] },
        h.context,
      ),
    Error,
    "user not in org",
  );
  assertEquals(h.written(), []);
});

Deno.test("projectGrantMemberRemove removes a member", async () => {
  const h = harness({
    ...GET_PROJECT,
    ...GRANTS,
    [MEMBERS]: { result: [{ userId: "600" }] },
    [`DELETE ${P}/200/grants/300/members/600`]: {},
  });
  await model.methods.projectGrantMemberRemove.execute(
    { project: "200", grantedOrgId: "500", userId: "600", dryRun: false },
    h.context,
  );
  assertEquals(h.forgotten, ["project-grant-member-fabrikk-600"]);
  assertEquals(h.written()[0].data.deleted, true);
});

Deno.test("projectGrantMemberRemove leaves a non-member alone", async () => {
  const h = harness({
    ...GET_PROJECT,
    ...GRANTS,
    [MEMBERS]: { result: [] },
  });
  await model.methods.projectGrantMemberRemove.execute(
    { project: "200", grantedOrgId: "500", userId: "600", dryRun: false },
    h.context,
  );
  assertEquals(h.calls.some((c) => c.method === "DELETE"), false);
  assertEquals(h.written()[0].data.action, "unchanged");
  assert(h.logs().some((l) => l.startsWith("warning:")));
});
