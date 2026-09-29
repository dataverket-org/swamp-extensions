import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  type ApiCall,
  type Caller,
  canonicalAddress,
  pushMirrorDelete,
  pushMirrorEnsure,
  pushMirrorList,
  staleMirrorRecords,
} from "./push_mirror.ts";

/** A fake API: replies per `method path`, records every call. */
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

const MIRROR = {
  remote_name: "remote_mirror_1",
  remote_address: "https://github.com/example-org/tool.git",
  interval: "8h0m0s",
  sync_on_commit: true,
  branch_filter: "",
  last_update: null,
  last_error: "",
  created: "2026-09-18T10:00:00Z",
};
const ensureArgs = {
  owner: "acme",
  name: "tool",
  remoteAddress: "https://github.com/example-org/tool.git",
  remoteUsername: "x-access-token",
  remotePassword: "s3cret",
  interval: "8h0m0s",
  syncOnCommit: true,
  syncNow: true,
};

Deno.test("canonicalAddress ignores credentials, case and trailing slashes", () => {
  assertEquals(
    canonicalAddress("https://user:pw@GitHub.com/Org/Repo.git/"),
    "https://github.com/org/repo.git",
  );
  assertEquals(canonicalAddress("not a url "), "not a url");
});

Deno.test("pushMirrorEnsure creates a mirror, sends the token once, and queues a push", async () => {
  const { api, calls } = fakeApi({
    "GET /api/v1/repos/acme/tool/push_mirrors?limit=50&page=1": {
      status: 200,
      body: [],
    },
    "POST /api/v1/repos/acme/tool/push_mirrors": { status: 201, body: MIRROR },
    "POST /api/v1/repos/acme/tool/push_mirrors-sync": { status: 200 },
  });
  const info = await pushMirrorEnsure(api, ensureArgs);
  assertEquals(info.action, "created");
  assertEquals(info.remoteName, "remote_mirror_1");
  assertEquals(info.lastUpdate, "");
  const post = calls.find((c) =>
    c.method === "POST" && c.path.endsWith("/push_mirrors")
  )!;
  assertEquals(
    (post.body as Record<string, unknown>).remote_password,
    "s3cret",
  );
  assertEquals((post.body as Record<string, unknown>).sync_on_commit, true);
  assertEquals(JSON.stringify(info).includes("s3cret"), false);
  assertEquals(calls.map((c) => c.method), ["GET", "POST", "POST"]);
  assertEquals(info.syncQueued, true);
});

Deno.test("pushMirrorEnsure finds a mirror on a later page instead of duplicating it", async () => {
  // find-or-create reads this list. Reading only the first page made an
  // existing mirror invisible, and Forgejo would have been given a second
  // mirror to the same remote.
  const filler = Array.from({ length: 50 }, (_, i) => ({
    ...MIRROR,
    remote_name: `remote_mirror_${i + 10}`,
    remote_address: `https://github.com/example-org/other${i}.git`,
  }));
  const { api, calls } = fakeApi({
    "GET /api/v1/repos/acme/tool/push_mirrors?limit=50&page=1": {
      status: 200,
      body: filler,
    },
    "GET /api/v1/repos/acme/tool/push_mirrors?limit=50&page=2": {
      status: 200,
      body: [MIRROR],
    },
    "POST /api/v1/repos/acme/tool/push_mirrors-sync": { status: 200 },
  });
  const info = await pushMirrorEnsure(api, ensureArgs);
  assertEquals(info.action, "unchanged");
  assertEquals(info.remoteName, "remote_mirror_1");
  // nothing was created
  assertEquals(
    calls.filter((c) => c.method === "POST" && c.path.endsWith("/push_mirrors"))
      .length,
    0,
  );
});

Deno.test("pushMirrorEnsure reports a mirror as created even when queueing the first push fails", async () => {
  const { api } = fakeApi({
    "GET /api/v1/repos/acme/tool/push_mirrors?limit=50&page=1": {
      status: 200,
      body: [],
    },
    "POST /api/v1/repos/acme/tool/push_mirrors": { status: 201, body: MIRROR },
    "POST /api/v1/repos/acme/tool/push_mirrors-sync": { status: 500, body: {} },
  });
  const warnings: string[] = [];
  const info = await pushMirrorEnsure(api, ensureArgs, (m) => warnings.push(m));
  assertEquals(info.action, "created");
  assertEquals(info.syncQueued, false);
  assertEquals(warnings.length, 1);
});

Deno.test("pushMirrorEnsure leaves an existing mirror to the same address unchanged", async () => {
  const { api, calls } = fakeApi({
    "GET /api/v1/repos/acme/tool/push_mirrors?limit=50&page=1": {
      status: 200,
      body: [{
        ...MIRROR,
        remote_address: "https://GITHUB.com/example-org/tool.git/",
        last_error: "auth failed",
      }],
    },
  });
  const info = await pushMirrorEnsure(api, ensureArgs);
  assertEquals(info.action, "unchanged");
  assertEquals(info.lastError, "auth failed");
  assertEquals(calls.length, 1);
});

Deno.test("pushMirrorEnsure surfaces Forgejo's error message on failure", async () => {
  const { api } = fakeApi({
    "GET /api/v1/repos/acme/tool/push_mirrors?limit=50&page=1": {
      status: 200,
      body: [],
    },
    "POST /api/v1/repos/acme/tool/push_mirrors": {
      status: 403,
      body: { message: "token does not have write:repository" },
    },
  });
  await assertRejects(
    () => pushMirrorEnsure(api, ensureArgs),
    Error,
    "HTTP 403: token does not have write:repository",
  );
});

Deno.test("pushMirrorList walks the org's repositories and reports every mirror", async () => {
  const { api } = fakeApi({
    "GET /api/v1/orgs/acme/repos?limit=50&page=1": {
      status: 200,
      body: [{ name: "tool" }, { name: "plain" }],
    },
    "GET /api/v1/repos/acme/tool/push_mirrors?limit=50&page=1": {
      status: 200,
      body: [MIRROR],
    },
    "GET /api/v1/repos/acme/plain/push_mirrors?limit=50&page=1": {
      status: 200,
      body: [],
    },
  });
  const mirrors = await pushMirrorList(api, { owner: "acme" });
  assertEquals(mirrors.map((m) => `${m.repo}:${m.action}`), ["tool:observed"]);
});

Deno.test("pushMirrorList falls back to the user endpoint when the owner is not an org", async () => {
  const { api } = fakeApi({
    "GET /api/v1/users/jane/repos?limit=50&page=1": {
      status: 200,
      body: [{ name: "dots" }],
    },
    "GET /api/v1/repos/jane/dots/push_mirrors?limit=50&page=1": {
      status: 200,
      body: [MIRROR],
    },
  });
  const mirrors = await pushMirrorList(api, { owner: "jane" });
  assertEquals(mirrors.length, 1);
  assertEquals(mirrors[0].owner, "jane");
});

Deno.test("pushMirrorDelete removes the mirror to one address and tolerates a missing one", async () => {
  const { api, calls } = fakeApi({
    "GET /api/v1/repos/acme/tool/push_mirrors?limit=50&page=1": {
      status: 200,
      body: [MIRROR],
    },
    "DELETE /api/v1/repos/acme/tool/push_mirrors/remote_mirror_1": {
      status: 204,
    },
  });
  const gone = await pushMirrorDelete(api, {
    owner: "acme",
    name: "tool",
    remoteAddress: MIRROR.remote_address,
  });
  assertEquals(gone.action, "deleted");
  assertEquals(calls.at(-1)!.method, "DELETE");
  const absent = await pushMirrorDelete(api, {
    owner: "acme",
    name: "tool",
    remoteAddress: "https://github.com/other/x.git",
  });
  assertEquals(absent.action, "absent");
});

Deno.test("staleMirrorRecords names stored pushMirror records the audit no longer sees, scoped to the owner or repo", () => {
  const stored = [
    {
      name: "acme:tool:push-mirror:remote_mirror_1",
      tags: { specName: "pushMirror" },
    },
    {
      name: "acme:gone:push-mirror:remote_mirror_2",
      tags: { specName: "pushMirror" },
    },
    {
      name: "other:x:push-mirror:remote_mirror_3",
      tags: { specName: "pushMirror" },
    },
    {
      name: "acme:tool:push-mirror-delete:remote_mirror_9",
      tags: { specName: "pushMirrorDelete" },
    },
    { name: "acme:tool:runner:r1", tags: { specName: "runner" } },
  ];
  const observed = new Set(["acme:tool:push-mirror:remote_mirror_1"]);
  assertEquals(staleMirrorRecords(stored, "acme", undefined, observed), [
    "acme:gone:push-mirror:remote_mirror_2",
  ]);
  assertEquals(staleMirrorRecords(stored, "acme", "tool", observed), []);
  assertEquals(staleMirrorRecords(stored, "acme", "gone", new Set()), [
    "acme:gone:push-mirror:remote_mirror_2",
  ]);
});
