import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  type ApiCall,
  branchesList,
  type Caller,
  defaultBranchEnsure,
  extension,
  repoDelete,
} from "./repo_settings.ts";

function fakeApi(
  replies: Record<string, { status: number; body?: unknown }>,
): { api: Caller; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const api: Caller = (c) => {
    calls.push(c);
    const r = replies[`${c.method} ${c.path}`];
    return Promise.resolve(
      r
        ? { status: r.status, body: r.body ?? {} }
        : { status: 404, body: { message: "Not Found" } },
    );
  };
  return { api, calls };
}

Deno.test("branchesList reports branches and the default, or nothing for an empty repository", async () => {
  const { api } = fakeApi({
    "GET /repos/acme/tool": { status: 200, body: { default_branch: "master" } },
    "GET /repos/acme/tool/branches?per_page=100&page=1": {
      status: 200,
      body: [{ name: "master" }, { name: "dev" }],
    },
    "GET /repos/acme/empty": { status: 200, body: { default_branch: "main" } },
    "GET /repos/acme/empty/branches?per_page=100&page=1": {
      status: 200,
      body: [],
    },
  });
  const tool = await branchesList(api, "acme", { name: "tool" });
  assertEquals(tool.branches, ["master", "dev"]);
  assertEquals(tool.defaultBranch, "master");
  assertEquals(tool.truncated, false);
  const empty = await branchesList(api, "acme", { name: "empty" });
  assertEquals(empty.defaultBranch, "");
});

Deno.test("branchesList follows every page, so a late branch is not missed", async () => {
  // A full page means there may be more. The old code read one page of 100 and
  // stopped, so default_branch_ensure refused a branch the repository has.
  const page1 = Array.from({ length: 100 }, (_, i) => ({ name: `b${i}` }));
  const { api, calls } = fakeApi({
    "GET /repos/acme/big": { status: 200, body: { default_branch: "b0" } },
    "GET /repos/acme/big/branches?per_page=100&page=1": {
      status: 200,
      body: page1,
    },
    "GET /repos/acme/big/branches?per_page=100&page=2": {
      status: 200,
      body: [{ name: "late" }],
    },
  });
  const big = await branchesList(api, "acme", { name: "big" });
  assertEquals(big.branches.length, 101);
  assertEquals(big.branches.includes("late"), true);
  assertEquals(big.truncated, false);
  // a short page ends it; no third request
  assertEquals(
    calls.filter((c) => c.path.includes("page=3")).length,
    0,
  );
});

Deno.test("branchesList says so when the page cap is reached with a full last page", async () => {
  // 100 full pages is the cap; the record must not pass that off as the whole list
  const replies: Record<string, { status: number; body?: unknown }> = {
    "GET /repos/acme/huge": { status: 200, body: { default_branch: "b0" } },
  };
  for (let page = 1; page <= 100; page++) {
    replies[`GET /repos/acme/huge/branches?per_page=100&page=${page}`] = {
      status: 200,
      body: Array.from({ length: 100 }, (_, i) => ({ name: `p${page}b${i}` })),
    };
  }
  const { api, calls } = fakeApi(replies);
  const huge = await branchesList(api, "acme", { name: "huge" });
  assertEquals(huge.branches.length, 10000);
  assertEquals(huge.truncated, true);
  // the cap holds: no page 101
  assertEquals(calls.some((c) => c.path.includes("page=101")), false);
});

Deno.test("defaultBranchEnsure patches only when the default differs and the branch exists", async () => {
  const { api, calls } = fakeApi({
    "GET /repos/acme/tool": { status: 200, body: { default_branch: "main" } },
    "GET /repos/acme/tool/branches?per_page=100&page=1": {
      status: 200,
      body: [{ name: "main" }, { name: "master" }],
    },
    "PATCH /repos/acme/tool": {
      status: 200,
      body: { default_branch: "master" },
    },
  });
  const updated = await defaultBranchEnsure(api, "acme", {
    name: "tool",
    defaultBranch: "master",
  });
  assertEquals(updated.action, "updated");
  assertEquals(
    (calls.at(-1)!.body as Record<string, unknown>).default_branch,
    "master",
  );
  const { api: same, calls: sameCalls } = fakeApi({
    "GET /repos/acme/tool": { status: 200, body: { default_branch: "master" } },
    "GET /repos/acme/tool/branches?per_page=100&page=1": {
      status: 200,
      body: [{ name: "master" }],
    },
  });
  assertEquals(
    (await defaultBranchEnsure(same, "acme", {
      name: "tool",
      defaultBranch: "master",
    })).action,
    "unchanged",
  );
  assertEquals(sameCalls.some((c) => c.method === "PATCH"), false);
});

Deno.test("defaultBranchEnsure refuses a branch the repository does not have", async () => {
  const { api } = fakeApi({
    "GET /repos/acme/tool": { status: 200, body: { default_branch: "main" } },
    "GET /repos/acme/tool/branches?per_page=100&page=1": {
      status: 200,
      body: [{ name: "main" }],
    },
  });
  await assertRejects(
    () =>
      defaultBranchEnsure(api, "acme", {
        name: "tool",
        defaultBranch: "master",
      }),
    Error,
    "has no branch master (has: main)",
  );
});

Deno.test("API errors carry GitHub's message", async () => {
  const { api } = fakeApi({
    "GET /repos/acme/tool": {
      status: 403,
      body: { message: "Resource not accessible by personal access token" },
    },
  });
  await assertRejects(
    () => branchesList(api, "acme", { name: "tool" }),
    Error,
    "HTTP 403: Resource not accessible",
  );
});

Deno.test("repoDelete deletes an existing repository, reports an absent one, and refuses a mismatch", async () => {
  const { api, calls } = fakeApi({
    "GET /repos/acme/old": {
      status: 200,
      body: { description: "mirror of https://forge.example.net/acme/old" },
    },
    "DELETE /repos/acme/old": { status: 204 },
  });
  assertEquals(
    (await repoDelete(api, "acme", {
      name: "old",
      expectMirrorOf: "forge.example.net",
    })).action,
    "deleted",
  );
  assertEquals(calls.at(-1)!.method, "DELETE");
  assertEquals(
    (await repoDelete(api, "acme", { name: "missing" })).action,
    "absent",
  );
  await assertRejects(
    () =>
      repoDelete(api, "acme", {
        name: "old",
        expectMirrorOf: "somewhere-else",
      }),
    Error,
    "refusing to delete",
  );
});

const ghChecks = extension.checks[0];
const ctx = (o: Record<string, unknown>) => ({ globalArgs: o as never });

Deno.test("github-token-accepted needs a token and an owner before reaching out", async () => {
  // no fetch installed: a network call here would throw rather than return
  const noToken = await ghChecks["github-token-accepted"].execute(
    ctx({ owner: "acme" }),
  );
  assertEquals(noToken.pass, false);
  assertStringIncludes(noToken.errors![0], "token is not set");
  const noOwner = await ghChecks["github-token-accepted"].execute(
    ctx({ token: "t" }),
  );
  assertEquals(noOwner.pass, false);
  assertStringIncludes(noOwner.errors![0], "owner is not set");
});

Deno.test("github-token-accepted checks the owner too, without the schema's baseUrl default", async () => {
  const seen: string[] = [];
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) => {
    const url = String(input);
    seen.push(url);
    return Promise.resolve(
      new Response(JSON.stringify({ login: "someone" }), { status: 200 }),
    );
  };
  try {
    // baseUrl absent, as a check receives it; fetchCaller supplies the default
    const args = { token: "t", owner: "acme" };
    assertEquals(Object.hasOwn(args, "baseUrl"), false);
    const r = await ghChecks["github-token-accepted"].execute(ctx(args));
    assertEquals(r.pass, true);
    assertEquals(seen[0], "https://api.github.com/user");
    assertEquals(seen[1], "https://api.github.com/users/acme");
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("github-token-accepted fails with GitHub's message when the owner is unreachable", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = (input: string | URL | Request) =>
    Promise.resolve(
      String(input).includes("/users/")
        ? new Response(JSON.stringify({ message: "Not Found" }), {
          status: 404,
        })
        : new Response(JSON.stringify({ login: "someone" }), { status: 200 }),
    );
  try {
    const r = await ghChecks["github-token-accepted"].execute(
      ctx({ token: "t", owner: "ghost" }),
    );
    assertEquals(r.pass, false);
    assertStringIncludes(r.errors![0], "Not Found");
  } finally {
    globalThis.fetch = original;
  }
});
