import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  canonicalAddress,
  extension,
  staleMirrorRecords,
} from "./push_mirror.ts";
import { harness, writes } from "./stub_test.ts";

Deno.test("canonicalAddress ignores credentials, case, trailing slashes and .git", () => {
  assertEquals(
    canonicalAddress("https://user:pw@GitHub.com/Org/Repo.git/"),
    "https://github.com/org/repo",
  );
  assertEquals(canonicalAddress("not a url "), "not a url");
});
Deno.test("staleMirrorRecords picks the stored pushMirror records of the owner or repo the audit no longer sees, by attribute", () => {
  const rec = (name: string, owner: string, repo: string) => ({
    name,
    attributes: { owner, repo },
  });
  const stored = [
    rec("push-mirror-acme-tool-remote_mirror_1", "acme", "tool"),
    rec("push-mirror-acme-gone-remote_mirror_2", "acme", "gone"),
    rec("push-mirror-other-x-remote_mirror_3", "other", "x"),
    // another owner whose login starts with this one's
    rec("push-mirror-acme-corp-x-remote_mirror_4", "acme-corp", "x"),
    // a record under the pre-2026.11.09.1 name is left alone, like every old record
    rec("acme:gone:push-mirror:remote_mirror_0", "acme", "gone"),
  ];
  const observed = new Set(["push-mirror-acme-tool-remote_mirror_1"]);
  assertEquals(staleMirrorRecords(stored, "acme", undefined, observed), [
    "push-mirror-acme-gone-remote_mirror_2",
  ]);
  assertEquals(staleMirrorRecords(stored, "acme", "tool", observed), []);
  assertEquals(staleMirrorRecords(stored, "acme", "gone", new Set()), [
    "push-mirror-acme-gone-remote_mirror_2",
  ]);
  assertEquals(staleMirrorRecords(stored, "ac", undefined, new Set()), []);
});

// ───── the methods, through createModelTestContext with a stub client ─────

const PM = "/api/v1/repos/acme/tool/push_mirrors";
const P = extension.methods[0];
const MIRROR = {
  remote_name: "remote_mirror_1",
  remote_address: "https://git.example.com/acme/tool.git",
  interval: "8h0m0s",
  sync_on_commit: true,
  branch_filter: "",
  last_update: null,
  last_error: "",
};
const ensure = {
  owner: "acme",
  name: "tool",
  remoteAddress: "https://git.example.com/acme/tool",
  remoteUsername: "x",
  remotePassword: "REMOTE-PASSWORD-1",
  interval: "8h0m0s",
  syncOnCommit: true,
  syncNow: true,
};

Deno.test("push_mirror_ensure creates a mirror, queues a push, and never records the password", async () => {
  const h = harness({
    [`GET ${PM}?limit=50&page=1`]: { status: 200, body: [] },
    [`POST ${PM}`]: { status: 201, body: MIRROR },
    [`POST ${PM}-sync`]: { status: 200 },
  });
  await P.push_mirror_ensure.execute(ensure, h.context);
  assertEquals(
    h.written().map((w) => [w.name, w.data.action, w.data.syncQueued]),
    [
      ["push-mirror-acme-tool-remote_mirror_1", "created", true],
    ],
  );
  assertEquals(
    JSON.stringify([h.written(), h.logs()]).includes("REMOTE-PASSWORD-1"),
    false,
  );
});

Deno.test("push_mirror_ensure takes .../tool and .../tool.git for one remote, creating nothing", async () => {
  const h = harness({
    [`GET ${PM}?limit=50&page=1`]: { status: 200, body: [MIRROR] },
  });
  await P.push_mirror_ensure.execute(ensure, h.context);
  assertEquals([writes(h.calls), h.written()[0].data.action], [
    [],
    "unchanged",
  ]);
});

Deno.test("push_mirror_ensure passes on the forge's refusal", async () => {
  const h = harness({
    [`GET ${PM}?limit=50&page=1`]: {
      status: 404,
      body: { message: "repo not found" },
    },
  });
  await assertRejects(
    () => P.push_mirror_ensure.execute(ensure, h.context),
    Error,
    "HTTP 404: repo not found",
  );
  assertEquals(h.written(), []);
});

Deno.test("push_mirror_list records a repository's mirrors", async () => {
  const h = harness({
    [`GET ${PM}?limit=50&page=1`]: {
      status: 200,
      body: [{ ...MIRROR, last_error: "denied" }],
    },
  });
  await P.push_mirror_list.execute({ owner: "acme", name: "tool" }, h.context);
  assertEquals(h.written().map((w) => [w.name, w.data.lastError]), [[
    "push-mirror-acme-tool-remote_mirror_1",
    "denied",
  ]]);
});

Deno.test("push_mirror_list passes on the forge's refusal", async () => {
  const h = harness({
    [`GET ${PM}?limit=50&page=1`]: { status: 403, body: { message: "no" } },
  });
  await assertRejects(
    () =>
      P.push_mirror_list.execute({ owner: "acme", name: "tool" }, h.context),
    Error,
    "HTTP 403: no",
  );
});

Deno.test("push_mirror_delete removes the mirror to an address and records it; a missing one is absent", async () => {
  const h = harness({
    [`GET ${PM}?limit=50&page=1`]: { status: 200, body: [MIRROR] },
    [`DELETE ${PM}/remote_mirror_1`]: { status: 204 },
  });
  await P.push_mirror_delete.execute({
    owner: "acme",
    name: "tool",
    remoteAddress: "https://git.example.com/acme/tool.git",
  }, h.context);
  assertEquals(
    h.written().map((w) => [w.spec, w.data.action, w.data.remoteName]),
    [["pushMirrorDelete", "deleted", "remote_mirror_1"]],
  );
  const g = harness({
    [`GET ${PM}?limit=50&page=1`]: { status: 200, body: [] },
  });
  await P.push_mirror_delete.execute({
    owner: "acme",
    name: "tool",
    remoteAddress: "https://git.example.com/acme/tool.git",
  }, g.context);
  assertEquals([writes(g.calls), g.written()[0].data.action], [[], "absent"]);
});

Deno.test("push_mirror_delete passes on a refused delete", async () => {
  const h = harness({
    [`GET ${PM}?limit=50&page=1`]: { status: 200, body: [MIRROR] },
    [`DELETE ${PM}/remote_mirror_1`]: { status: 403, body: { message: "no" } },
  });
  await assertRejects(
    () =>
      P.push_mirror_delete.execute({
        owner: "acme",
        name: "tool",
        remoteAddress: MIRROR.remote_address,
      }, h.context),
    Error,
    "HTTP 403: no",
  );
  assertEquals(h.written(), []);
});

Deno.test("push_mirror_sync_now queues a push and records nothing", async () => {
  const h = harness({ [`POST ${PM}-sync`]: { status: 200 } });
  const out = await P.push_mirror_sync_now.execute({
    owner: "acme",
    name: "tool",
  }, h.context);
  assertEquals([out.dataHandles, h.calls.length], [[], 1]);
});

Deno.test("push_mirror_sync_now passes on the forge's 500", async () => {
  const h = harness({
    [`POST ${PM}-sync`]: {
      status: 500,
      body: { message: "error occurred when syncing push mirror" },
    },
  });
  await assertRejects(
    () =>
      P.push_mirror_sync_now.execute(
        { owner: "acme", name: "tool" },
        h.context,
      ),
    Error,
    "HTTP 500: error occurred when syncing push mirror",
  );
});
