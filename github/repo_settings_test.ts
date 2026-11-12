import {
  assertEquals,
  assertInstanceOf,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  dataName,
  extension,
  legacyDataName,
  writeRecord,
} from "./repo_settings.ts";
import { assertNoPlanted, PLANTED, withStub } from "./test_support.ts";

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

// dataverket-org/swamp-extensions#1: a data name is a directory name in a
// filesystem datastore, and Windows refuses ':' there, so the names must hold
// on every platform.
// deno-lint-ignore no-control-regex
const WINDOWS_UNSAFE = /[<>:"|?*\\/\x00-\x1f]|[. ]$/;

Deno.test("records are stored under portable names, the spec word first, the owner left out", () => {
  assertEquals(dataName("branches", "tool"), "branches-tool");
  assertEquals(dataName("defaultBranch", "tool"), "default-branch-tool");
  assertEquals(dataName("repoDelete", "tool"), "delete-tool");
  // whatever the forge hands back, nothing Windows refuses gets through
  const wild = dataName("branches", 'a<b>:c"d|e?f*g/h\\i. ');
  assertEquals(WINDOWS_UNSAFE.test(wild), false);
  assertEquals(wild, "branches-a-b-c-d-e-f-g-h-i");
  // the same repository under two specs never shares a name, and a repository
  // named like another spec's word cannot collide with upstream's repo-<slug>
  assertEquals(
    new Set(
      (["branches", "defaultBranch", "repoDelete"] as const).map((spec) =>
        dataName(spec, "tool")
      ),
    ).size,
    3,
  );
  assertEquals(dataName("repoDelete", "tool").startsWith("repo-"), false);
});

Deno.test("the pre-2026.11.08.1 name is what the old safeName produced", () => {
  assertEquals(
    legacyDataName("branches", "acme", "tool"),
    "acme:tool:branches",
  );
  assertEquals(
    legacyDataName("defaultBranch", "acme", "tool"),
    "acme:tool:default-branch",
  );
  assertEquals(
    legacyDataName("repoDelete", "acme", "tool"),
    "acme:tool:delete",
  );
  assertEquals(
    WINDOWS_UNSAFE.test(legacyDataName("branches", "acme", "tool")),
    true,
  );
});

function recordCtx(stored: Record<string, Record<string, unknown>>) {
  const writes: { spec: string; name: string }[] = [];
  const warnings: Record<string, unknown>[] = [];
  const ctx = {
    globalArgs: { token: "t", owner: "acme" },
    logger: {
      info() {},
      warn(_msg: string, props?: Record<string, unknown>) {
        warnings.push(props ?? {});
      },
    },
    writeResource(spec: string, name: string) {
      writes.push({ spec, name });
      stored[name] = { written: true };
      return Promise.resolve({ name });
    },
    readResource(name: string) {
      if (name.includes("\0")) throw new Error("os error 123");
      return Promise.resolve(stored[name] ?? null);
    },
  };
  return { ctx, writes, warnings };
}

Deno.test("writeRecord writes the portable name and says once that old data is left behind", async () => {
  const stored: Record<string, Record<string, unknown>> = {
    "acme:tool:branches": { branches: ["main"] },
  };
  const { ctx, writes, warnings } = recordCtx(stored);
  const h = await writeRecord(ctx, "branches", "acme", "tool", { n: 1 });
  assertEquals(h.name, "branches-tool");
  assertEquals(writes, [{ spec: "branches", name: "branches-tool" }]);
  assertEquals(warnings, [{
    legacy: "acme:tool:branches",
    name: "branches-tool",
  }]);
  // the old data is untouched, and the next write is quiet
  assertEquals(stored["acme:tool:branches"], { branches: ["main"] });
  await writeRecord(ctx, "branches", "acme", "tool", { n: 2 });
  assertEquals(warnings.length, 1);
});

Deno.test("writeRecord is quiet without old data, without readResource, and when the old name cannot be read", async () => {
  const fresh = recordCtx({});
  await writeRecord(fresh.ctx, "repoDelete", "acme", "tool", { n: 1 });
  assertEquals(fresh.warnings, []);
  assertEquals(fresh.writes[0].name, "delete-tool");

  const { readResource: _, ...bare } = recordCtx({}).ctx;
  const h = await writeRecord(bare, "defaultBranch", "acme", "tool", { n: 1 });
  assertEquals(h.name, "default-branch-tool");

  // on Windows the old name fails at the path; that is "no old data", not a failure
  const broken = recordCtx({});
  const unsafe = await writeRecord(broken.ctx, "branches", "acme", "tool\0", {
    n: 1,
  });
  assertEquals(unsafe.name, "branches-tool");
  assertEquals(broken.warnings, []);
});

// ---------------------------------------------------------------------------
// Methods, run through createModelTestContext with a stub answering fetch.
// ---------------------------------------------------------------------------

const methods = extension.methods[0];
const BRANCHES = "GET /repos/acme/tool/branches?per_page=100&page=1";

Deno.test("branches_list stores the branches and the default", async () => {
  const r = await withStub(
    {
      "GET /repos/acme/tool": { status: 200, body: { default_branch: "main" } },
      [BRANCHES]: { status: 200, body: [{ name: "main" }, { name: "dev" }] },
    },
    (c) => methods.branches_list.execute({ name: "tool" }, c),
  );
  assertEquals(r.error, undefined);
  assertEquals(r.seen[0].authorization, `Bearer ${PLANTED}`);
  const [w] = r.written;
  assertEquals([w.spec, w.name], ["branches", "branches-tool"]);
  assertEquals(
    [w.data.branches, w.data.defaultBranch, w.data.truncated],
    [["main", "dev"], "main", false],
  );
  assertNoPlanted(r);
});

Deno.test("branches_list fails on a missing repository, and an echoed token is masked", async () => {
  const r = await withStub(
    {
      "GET /repos/acme/tool": {
        status: 404,
        body: { message: `Not Found for ${PLANTED}` },
      },
    },
    (c) => methods.branches_list.execute({ name: "tool" }, c),
  );
  assertInstanceOf(r.error, Error);
  assertStringIncludes(r.error.message, "HTTP 404: Not Found for [REDACTED]");
  assertEquals(r.written, []);
  assertNoPlanted(r);
});

Deno.test("default_branch_ensure patches the default when the branch exists", async () => {
  const r = await withStub(
    {
      "GET /repos/acme/tool": { status: 200, body: { default_branch: "main" } },
      [BRANCHES]: { status: 200, body: [{ name: "main" }, { name: "master" }] },
      "PATCH /repos/acme/tool": { status: 200, body: {} },
    },
    (c) =>
      methods.default_branch_ensure.execute({
        name: "tool",
        defaultBranch: "master",
      }, c),
  );
  assertEquals(r.error, undefined);
  assertEquals(r.seen.at(-1)!.body, { default_branch: "master" });
  const [w] = r.written;
  assertEquals([w.spec, w.name], ["defaultBranch", "default-branch-tool"]);
  assertEquals(w.data.action, "updated");
});

Deno.test("default_branch_ensure refuses a branch the repository does not have", async () => {
  const r = await withStub(
    {
      "GET /repos/acme/tool": { status: 200, body: { default_branch: "main" } },
      [BRANCHES]: { status: 200, body: [{ name: "main" }] },
    },
    (c) =>
      methods.default_branch_ensure.execute({
        name: "tool",
        defaultBranch: "master",
      }, c),
  );
  assertInstanceOf(r.error, Error);
  assertStringIncludes(r.error.message, "has no branch master");
  assertEquals(r.seen.some((s) => s.method === "PATCH"), false);
  assertEquals(r.written, []);
});

Deno.test("repo_delete deletes a repository that mentions the expected mirror", async () => {
  const r = await withStub(
    {
      "GET /repos/acme/tool": {
        status: 200,
        body: { description: "Mirror of https://git.example.org/acme/tool" },
      },
      "DELETE /repos/acme/tool": { status: 204 },
    },
    (c) =>
      methods.repo_delete.execute({
        name: "tool",
        expectMirrorOf: "git.example.org/acme/tool",
      }, c),
  );
  assertEquals(r.error, undefined);
  const [w] = r.written;
  assertEquals([w.spec, w.name, w.data.action], [
    "repoDelete",
    "delete-tool",
    "deleted",
  ]);
});

Deno.test("repo_delete reports an absent repository without deleting", async () => {
  const r = await withStub(
    { "GET /repos/acme/tool": { status: 404, body: { message: "Not Found" } } },
    (c) => methods.repo_delete.execute({ name: "tool" }, c),
  );
  assertEquals(r.error, undefined);
  assertEquals(r.seen.map((s) => s.method), ["GET"]);
  assertEquals(r.written[0].data.action, "absent");
});

Deno.test("repo_delete refuses a repository that does not mention the expected mirror", async () => {
  const r = await withStub(
    { "GET /repos/acme/tool": { status: 200, body: { description: "mine" } } },
    (c) =>
      methods.repo_delete.execute({
        name: "tool",
        expectMirrorOf: "git.example.org/acme/tool",
      }, c),
  );
  assertInstanceOf(r.error, Error);
  assertStringIncludes(r.error.message, "refusing to delete");
  assertEquals(r.seen.map((s) => s.method), ["GET"]);
  assertEquals(r.written, []);
});
