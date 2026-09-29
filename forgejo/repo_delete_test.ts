import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { type ApiCall, type Caller, repoDelete } from "./repo_delete.ts";

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

const REPO = "/api/v1/repos/example-org/hov1-infra";
const args = { owner: "example-org", name: "hov1-infra", allowContent: false };

Deno.test("repo_delete reads the repository, deletes an empty one and records it", async () => {
  const { api, calls } = fakeApi({
    [`GET ${REPO}`]: { status: 200, body: { empty: true, description: "d" } },
    [`DELETE ${REPO}`]: { status: 204 },
  });
  const r = await repoDelete(api, args);
  assertEquals(r.action, "deleted");
  assertEquals(r.wasEmpty, true);
  assertEquals(r.description, "d");
  assertEquals(calls.map((c) => c.method), ["GET", "DELETE"]);
});

Deno.test("repo_delete is a no-op for a repository that is already gone", async () => {
  const { api, calls } = fakeApi({});
  const r = await repoDelete(api, args);
  assertEquals(r.action, "absent");
  assertEquals(calls.length, 1);
});

Deno.test("repo_delete refuses a repository with commits unless allowContent", async () => {
  const { api, calls } = fakeApi({
    [`GET ${REPO}`]: { status: 200, body: { empty: false } },
    [`DELETE ${REPO}`]: { status: 204 },
  });
  await assertRejects(() => repoDelete(api, args), Error, "has commits");
  assertEquals(calls.length, 1);
  const r = await repoDelete(api, { ...args, allowContent: true });
  assertEquals(r.action, "deleted");
  assertEquals(r.wasEmpty, false);
});
