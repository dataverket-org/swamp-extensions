import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  type ApiCall,
  type Caller,
  prAssign,
  userSearch,
} from "./pr_assign.ts";

function fakeApi(
  replies: Record<string, { status: number; body?: unknown }>,
): { api: Caller; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const api: Caller = (c) => {
    calls.push(c);
    const r = replies[`${c.method} ${c.path}`];
    if (!r) {
      return Promise.resolve({
        status: 404,
        body: { message: `no reply for ${c.method} ${c.path}` },
      });
    }
    return Promise.resolve({
      status: r.status,
      body: (r.body ?? {}) as Record<string, unknown>,
    });
  };
  return { api, calls };
}

const PR = "/api/v1/repos/example-org/example-repo-infra/pulls/15";
const args = {
  owner: "example-org",
  name: "example-repo-infra",
  index: 15,
  assignees: ["linus"],
};

Deno.test("pr_assign checks the login, reads the PR, patches assignees and records what Forgejo returns", async () => {
  const { api, calls } = fakeApi({
    "GET /api/v1/users/linus": { status: 200, body: { login: "linus" } },
    [`GET ${PR}`]: {
      status: 200,
      body: { state: "open", title: "t", assignees: [] },
    },
    [`PATCH ${PR}`]: {
      status: 201,
      body: { state: "open", title: "t", assignees: [{ login: "linus" }] },
    },
  });
  const r = await prAssign(api, args);
  assertEquals(r.action, "assigned");
  assertEquals(r.assignees, ["linus"]);
  assertEquals(calls.map((c) => c.method), ["GET", "GET", "PATCH"]);
  assertEquals(calls[2].body, { assignees: ["linus"] });
});

Deno.test("pr_assign is unchanged when the assignees already match", async () => {
  const { api, calls } = fakeApi({
    "GET /api/v1/users/linus": { status: 200, body: { login: "linus" } },
    [`GET ${PR}`]: {
      status: 200,
      body: { state: "open", title: "t", assignees: [{ login: "linus" }] },
    },
  });
  const r = await prAssign(api, args);
  assertEquals(r.action, "unchanged");
  assertEquals(calls.length, 2);
});

Deno.test("pr_assign refuses an unknown login and a PR that is not open", async () => {
  const { api } = fakeApi({});
  await assertRejects(() => prAssign(api, args), Error, 'No user "linus"');
  const closed = fakeApi({
    "GET /api/v1/users/linus": { status: 200, body: { login: "linus" } },
    [`GET ${PR}`]: { status: 200, body: { state: "closed", assignees: [] } },
  });
  await assertRejects(() => prAssign(closed.api, args), Error, "not open");
});

Deno.test("user_search maps the search endpoint's data to logins and names", async () => {
  const { api } = fakeApi({
    "GET /api/v1/users/search?q=linus&limit=50": {
      status: 200,
      body: { data: [{ login: "ljohansen", full_name: "Linus Johansen" }, {}] },
    },
  });
  assertEquals(await userSearch(api, "linus"), [
    { login: "ljohansen", fullName: "Linus Johansen" },
  ]);
});
