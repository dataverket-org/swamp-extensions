import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { administers, extension, grants, highest, sameGrants } from "./team.ts";
import { harness, writes } from "./stub_test.ts";

// The team methods' behaviour is tested live, in smoke/ (batch j); here the
// comparisons that decide between unchanged and a write, and what each method
// sends, records and refuses.

Deno.test("grants: a unit at none is no grant, and keys come sorted", () => {
  assertEquals(
    grants({ "repo.pulls": "write", "repo.wiki": "none", "repo.code": "read" }),
    { "repo.code": "read", "repo.pulls": "write" },
  );
  assertEquals(grants(undefined), {});
  assertEquals(grants(["repo.code"]), {});
});

Deno.test("sameGrants: none and absent are the same, another level is not", () => {
  assertEquals(
    sameGrants({ "repo.code": "read", "repo.wiki": "none" }, {
      "repo.code": "read",
    }),
    true,
  );
  assertEquals(
    sameGrants({ "repo.code": "read" }, { "repo.code": "write" }),
    false,
  );
  assertEquals(sameGrants({ "repo.code": "read" }, {}), false);
});

Deno.test("highest: write when any unit is written to, else read", () => {
  assertEquals(
    highest({ "repo.code": "read", "repo.pulls": "write" }),
    "write",
  );
  assertEquals(highest({ "repo.code": "read" }), "read");
});

Deno.test("administers: the Owners team and administrator or owner access, whatever the case of the name", () => {
  assertEquals(administers({ name: "Owners", permission: "owner" }), true);
  assertEquals(administers({ name: "owners", permission: "write" }), true);
  assertEquals(administers({ name: "ops", permission: "admin" }), true);
  assertEquals(administers({ name: "bots", permission: "write" }), false);
});

// ───── the methods, through createModelTestContext with a stub client ─────

const M = extension.methods[0];
const TEAMS = "/api/v1/orgs/acme/teams?limit=50&page=1";
type Level = "none" | "read" | "write";
const UNITS: Record<string, Level> = {
  "repo.code": "write",
  "repo.pulls": "write",
};
const team = (over: Record<string, unknown> = {}) => ({
  id: 7,
  name: "bots",
  description: "",
  permission: "write",
  units_map: { ...UNITS, "repo.wiki": "none" },
  includes_all_repositories: false,
  can_create_org_repo: false,
  ...over,
});
const ensure = (
  over: { name?: string; unitsMap?: Record<string, Level> } = {},
) => ({
  org: "acme",
  name: "bots",
  unitsMap: UNITS,
  includesAllRepositories: false,
  canCreateOrgRepo: false,
  ...over,
});

Deno.test("team_ensure creates a missing team with the units asked for and reads it back", async () => {
  const h = harness({
    [`GET ${TEAMS}`]: { status: 200, body: [] },
    ["POST /api/v1/orgs/acme/teams"]: { status: 201, body: team() },
    ["GET /api/v1/teams/7"]: { status: 200, body: team() },
  });
  await M.team_ensure.execute(ensure(), h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{
    name: "bots",
    permission: "write",
    units_map: UNITS,
    includes_all_repositories: false,
    can_create_org_repo: false,
  }]);
  assertEquals(
    h.written().map((w) => [w.spec, w.name, w.data.action, w.data.unitsMap]),
    [["team", "team-acme-bots", "created", UNITS]],
  );
});

Deno.test("team_ensure writes nothing when the team gives that access already", async () => {
  const h = harness({ [`GET ${TEAMS}`]: { status: 200, body: [team()] } });
  await M.team_ensure.execute(ensure(), h.context);
  assertEquals(writes(h.calls), []);
  assertEquals(h.written().map((w) => w.data.action), ["unchanged"]);
});

Deno.test("team_ensure refuses the Owners team, a team with administrator access and an empty map, sending nothing", async () => {
  const owners = harness({});
  await assertRejects(
    () => M.team_ensure.execute(ensure({ name: "Owners" }), owners.context),
    Error,
    "the Owners team is the forge's own",
  );
  assertEquals(owners.calls, []);

  const admin = harness({
    [`GET ${TEAMS}`]: {
      status: 200,
      body: [team({ permission: "admin" })],
    },
  });
  await assertRejects(
    () => M.team_ensure.execute(ensure(), admin.context),
    Error,
    "has administrator access",
  );
  assertEquals(writes(admin.calls), []);

  const empty = harness({});
  await assertRejects(
    () =>
      M.team_ensure.execute(
        ensure({ unitsMap: { "repo.code": "none" } }),
        empty.context,
      ),
    Error,
    "gives no access to any unit",
  );
  assertEquals(empty.calls, []);
});

Deno.test("team_ensure refuses an update the forge did not take", async () => {
  const h = harness({
    [`GET ${TEAMS}`]: {
      status: 200,
      body: [team({ units_map: { "repo.code": "read" } })],
    },
    ["PATCH /api/v1/teams/7"]: { status: 200, body: team() },
    ["GET /api/v1/teams/7"]: {
      status: 200,
      body: team({ units_map: { "repo.code": "read" } }),
    },
  });
  await assertRejects(
    () => M.team_ensure.execute(ensure(), h.context),
    Error,
    "the forge did not take the access asked for (the team was updated)",
  );
  assertEquals(h.written(), []);
});

Deno.test("team_member_ensure adds a user who is not a member and reads it back", async () => {
  let member = false;
  const h = harness({
    [`GET ${TEAMS}`]: { status: 200, body: [team()] },
    ["GET /api/v1/teams/7/members/ann"]: () => ({
      status: member ? 200 : 404,
      body: {},
    }),
    ["GET /api/v1/users/ann"]: { status: 200, body: { login: "ann" } },
    ["PUT /api/v1/teams/7/members/ann"]: () => {
      member = true;
      return { status: 204, body: {} };
    },
  });
  await M.team_member_ensure.execute(
    { org: "acme", team: "bots", username: "ann" },
    h.context,
  );
  assertEquals(writes(h.calls).map((c) => c.path), [
    "/api/v1/teams/7/members/ann",
  ]);
  assertEquals(h.written().map((w) => [w.name, w.data.action]), [[
    "teammember-acme-bots-ann",
    "added",
  ]]);
});

Deno.test("team_member_ensure refuses a user that does not exist and a team that does not, sending nothing", async () => {
  const noUser = harness({
    [`GET ${TEAMS}`]: { status: 200, body: [team()] },
    ["GET /api/v1/teams/7/members/ghost"]: { status: 404 },
    ["GET /api/v1/users/ghost"]: { status: 404 },
  });
  await assertRejects(
    () =>
      M.team_member_ensure.execute({
        org: "acme",
        team: "bots",
        username: "ghost",
      }, noUser.context),
    Error,
    'there is no user "ghost". Nothing was sent.',
  );
  assertEquals(writes(noUser.calls), []);

  const noTeam = harness({ [`GET ${TEAMS}`]: { status: 200, body: [] } });
  await assertRejects(
    () =>
      M.team_member_ensure.execute({
        org: "acme",
        team: "bots",
        username: "ann",
      }, noTeam.context),
    Error,
    'there is no team named "bots"',
  );
  assertEquals(writes(noTeam.calls), []);
});

Deno.test("team_repo_ensure adds a repository the team does not have", async () => {
  let has = false;
  const h = harness({
    [`GET ${TEAMS}`]: { status: 200, body: [team()] },
    ["GET /api/v1/repos/acme/tool"]: { status: 200, body: {} },
    ["GET /api/v1/teams/7/repos/acme/tool"]: () => ({
      status: has ? 200 : 404,
      body: {},
    }),
    ["PUT /api/v1/teams/7/repos/acme/tool"]: () => {
      has = true;
      return { status: 204, body: {} };
    },
  });
  await M.team_repo_ensure.execute(
    { org: "acme", team: "bots", name: "tool" },
    h.context,
  );
  assertEquals(h.written().map((w) => [w.name, w.data.action, w.data.repo]), [[
    "teamrepo-acme-bots-tool",
    "added",
    "acme/tool",
  ]]);
});

Deno.test("team_repo_ensure writes nothing for a team with every repository, and refuses a repository that is not there", async () => {
  const all = harness({
    [`GET ${TEAMS}`]: {
      status: 200,
      body: [team({ includes_all_repositories: true })],
    },
    ["GET /api/v1/repos/acme/tool"]: { status: 200, body: {} },
  });
  await M.team_repo_ensure.execute(
    { org: "acme", team: "bots", name: "tool" },
    all.context,
  );
  assertEquals(writes(all.calls), []);
  assertEquals(
    all.written().map((w) => [w.data.action, w.data.includedByAll]),
    [["unchanged", true]],
  );

  const gone = harness({
    [`GET ${TEAMS}`]: { status: 200, body: [team()] },
    ["GET /api/v1/repos/acme/nope"]: { status: 404 },
  });
  await assertRejects(
    () =>
      M.team_repo_ensure.execute(
        { org: "acme", team: "bots", name: "nope" },
        gone.context,
      ),
    Error,
    "repository acme/nope does not exist",
  );
  assertEquals(writes(gone.calls), []);
});

Deno.test("team_get records the team with its members and repositories, sorted", async () => {
  const h = harness({
    [`GET ${TEAMS}`]: { status: 200, body: [team()] },
    ["GET /api/v1/teams/7/members?limit=50&page=1"]: {
      status: 200,
      body: [{ login: "bo" }, { login: "ann" }],
    },
    ["GET /api/v1/teams/7/repos?limit=50&page=1"]: {
      status: 200,
      body: [{ full_name: "acme/tool" }, { full_name: "acme/app" }],
    },
  });
  await M.team_get.execute({ org: "acme", name: "bots" }, h.context);
  assertEquals(
    h.written().map((
      w,
    ) => [w.name, w.data.action, w.data.members, w.data.repositories]),
    [["team-acme-bots", "observed", ["ann", "bo"], ["acme/app", "acme/tool"]]],
  );
});

Deno.test("team_get passes on a refused read", async () => {
  const h = harness({
    [`GET ${TEAMS}`]: { status: 403, body: { message: "no scope" } },
  });
  await assertRejects(
    () => M.team_get.execute({ org: "acme", name: "bots" }, h.context),
    Error,
    "HTTP 403: no scope",
  );
  assertEquals(h.written(), []);
});

Deno.test("team_ensure updates a team whose access differs, sending the whole map", async () => {
  const h = harness({
    [`GET ${TEAMS}`]: {
      status: 200,
      body: [
        team({ units_map: { "repo.code": "read", "repo.wiki": "write" } }),
      ],
    },
    ["PATCH /api/v1/teams/7"]: { status: 200, body: team() },
    ["GET /api/v1/teams/7"]: { status: 200, body: team() },
  });
  await M.team_ensure.execute(ensure(), h.context);
  assertEquals(
    writes(h.calls).map((c) => (c.body as Record<string, unknown>).units_map),
    [UNITS],
  );
  assertEquals(h.written().map((w) => w.data.action), ["updated"]);
});

Deno.test("a team name in another case is refused by every method, with the forge's spelling", async () => {
  const routes = {
    [`GET ${TEAMS}`]: { status: 200, body: [team({ name: "Bots" })] },
  };
  const said =
    'the team is named "Bots", not "bots". Use the forge\'s spelling';
  const a = harness(routes);
  await assertRejects(
    () => M.team_ensure.execute(ensure(), a.context),
    Error,
    said,
  );
  const b = harness(routes);
  await assertRejects(
    () =>
      M.team_member_ensure.execute(
        { org: "acme", team: "bots", username: "ann" },
        b.context,
      ),
    Error,
    said,
  );
  const c = harness(routes);
  await assertRejects(
    () =>
      M.team_repo_ensure.execute(
        { org: "acme", team: "bots", name: "tool" },
        c.context,
      ),
    Error,
    said,
  );
  const d = harness(routes);
  await assertRejects(
    () => M.team_get.execute({ org: "acme", name: "bots" }, d.context),
    Error,
    said,
  );
  for (const h of [a, b, c, d]) {
    assertEquals(writes(h.calls), []);
    assertEquals(h.written(), []);
  }
});

Deno.test("team_member_ensure writes nothing for a member", async () => {
  const h = harness({
    [`GET ${TEAMS}`]: { status: 200, body: [team()] },
    ["GET /api/v1/teams/7/members/ann"]: { status: 200, body: {} },
  });
  await M.team_member_ensure.execute(
    { org: "acme", team: "bots", username: "ann" },
    h.context,
  );
  assertEquals(writes(h.calls), []);
  assertEquals(h.written().map((w) => w.data.action), ["unchanged"]);
});

Deno.test("team_member_ensure and team_repo_ensure add nothing to the Owners team or an administrator team", async () => {
  const owners = team({ id: 1, name: "Owners", permission: "owner" });
  const admins = team({ id: 9, name: "ops", permission: "admin" });
  for (
    const [t, name] of [[owners, "Owners"], [admins, "ops"]] as [
      Record<string, unknown>,
      string,
    ][]
  ) {
    const h = harness({ [`GET ${TEAMS}`]: { status: 200, body: [t] } });
    await assertRejects(
      () =>
        M.team_member_ensure.execute(
          { org: "acme", team: name, username: "ann" },
          h.context,
        ),
      Error,
      "nothing is added to it here. Nothing was sent.",
    );
    await assertRejects(
      () =>
        M.team_repo_ensure.execute(
          { org: "acme", team: name, name: "tool" },
          h.context,
        ),
      Error,
      "nothing is added to it here. Nothing was sent.",
    );
    assertEquals(writes(h.calls), []);
    assertEquals(h.written(), []);
  }
});
