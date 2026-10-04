import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { type ApiCall, type Caller, orgDelete } from "./org_delete.ts";

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

const ORG = "/api/v1/orgs/example-org";
const REPOS = `${ORG}/repos?limit=10&page=1`;
const args = { name: "example-org" };

Deno.test("org_delete reads the org, checks it is empty, deletes it and records it", async () => {
  const { api, calls } = fakeApi({
    [`GET ${ORG}`]: { status: 200, body: { id: 74, description: "d" } },
    [`GET ${REPOS}`]: { status: 200, body: [] },
    [`DELETE ${ORG}`]: { status: 204 },
  });
  const r = await orgDelete(api, args);
  assertEquals(r.action, "deleted");
  assertEquals(r.id, 74);
  assertEquals(r.description, "d");
  assertEquals(calls.map((c) => c.method), ["GET", "GET", "DELETE"]);
});

Deno.test("org_delete is a no-op for an organization that is already gone", async () => {
  const { api, calls } = fakeApi({});
  const r = await orgDelete(api, args);
  assertEquals(r.action, "absent");
  assertEquals(r.id, 0);
  assertEquals(calls.length, 1);
});

Deno.test("org_delete refuses an organization that still holds repositories", async () => {
  const { api, calls } = fakeApi({
    [`GET ${ORG}`]: { status: 200, body: { id: 74 } },
    [`GET ${REPOS}`]: { status: 200, body: [{ name: "a" }, { name: "b" }] },
    [`DELETE ${ORG}`]: { status: 204 },
  });
  await assertRejects(
    () => orgDelete(api, args),
    Error,
    "still holds repositories (a, b)",
  );
  assertEquals(calls.map((c) => c.method), ["GET", "GET"]);
});

Deno.test("org_delete surfaces a forbidden read instead of deleting", async () => {
  const { api, calls } = fakeApi({
    [`GET ${ORG}`]: { status: 403, body: { message: "forbidden" } },
    [`DELETE ${ORG}`]: { status: 204 },
  });
  await assertRejects(() => orgDelete(api, args), Error, "HTTP 403");
  assertEquals(calls.length, 1);
});

Deno.test("org_delete surfaces a failed repository listing instead of deleting", async () => {
  const { api, calls } = fakeApi({
    [`GET ${ORG}`]: { status: 200, body: { id: 74 } },
    [`GET ${REPOS}`]: { status: 500, body: { message: "boom" } },
    [`DELETE ${ORG}`]: { status: 204 },
  });
  await assertRejects(() => orgDelete(api, args), Error, "HTTP 500: boom");
  assertEquals(calls.length, 2);
});

Deno.test("org_delete surfaces Forgejo's refusal of the delete itself", async () => {
  const { api } = fakeApi({
    [`GET ${ORG}`]: { status: 200, body: { id: 74 } },
    [`GET ${REPOS}`]: { status: 200, body: [] },
    [`DELETE ${ORG}`]: {
      status: 500,
      body: { message: "org still has repos" },
    },
  });
  await assertRejects(() => orgDelete(api, args), Error, "HTTP 500");
});

Deno.test("org_delete escapes the login in the path", async () => {
  const { api, calls } = fakeApi({});
  await orgDelete(api, { name: "a/b" });
  assertEquals(calls[0].path, "/api/v1/orgs/a%2Fb");
});
