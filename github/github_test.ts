import {
  assertEquals,
  assertInstanceOf,
  assertStrictEquals,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { model } from "./github.ts";
import { extension } from "./repo_settings.ts";
import {
  buildRepoCreateParams,
  findOpenPull,
  findReleaseByTag,
  qualifiedHead,
  slug,
} from "./_lib/github_plan.ts";
import { assertNoPlanted, PLANTED, withStub } from "./test_support.ts";

Deno.test("the forked base owns the @dataverket/github type at this package's version", () => {
  assertEquals(model.type, "@dataverket/github");
  assertEquals(model.version, "2026.11.08.1");
  // the add-on lands on the same type, not on another collective's
  assertEquals(extension.type, model.type);
});

Deno.test("the upgrade chain ends at the model's version and is a no-op on the arguments", () => {
  const last = model.upgrades.at(-1)!;
  assertEquals(last.toVersion, model.version);
  const args = { token: "t", owner: "acme", isOrg: true };
  assertStrictEquals(last.upgradeAttributes(args), args);
  // chronological, so the registry accepts it
  const versions = model.upgrades.map((u) => u.toVersion);
  assertEquals(versions, [...versions].sort());
});

Deno.test("upstream's four method names are kept, so a definition migrates by its type line", () => {
  assertEquals(
    Object.keys(model.methods).sort(),
    ["ensureRelease", "ensureRepo", "openPr", "sync"],
  );
  // and the add-on's names do not collide with them
  for (const group of extension.methods) {
    for (const name of Object.keys(group)) {
      assertEquals(name in model.methods, false, `${name} collides`);
    }
  }
});

Deno.test("the mutations default to a dry run and the repos schema is strict", () => {
  for (const m of ["ensureRepo", "ensureRelease", "openPr"] as const) {
    const parsed = model.methods[m].arguments.safeParse(
      m === "ensureRepo"
        ? { name: "x" }
        : m === "ensureRelease"
        ? { repo: "x", tagName: "v1" }
        : { repo: "x", head: "h", title: "t" },
    );
    assertEquals(parsed.success, true, m);
    assertEquals((parsed.data as { dryRun: boolean }).dryRun, true, m);
  }
  const repos = model.resources.repos.schema.safeParse({
    count: 1,
    fetchedAt: new Date().toISOString(),
    owner: "acme",
    repos: [{
      name: "a",
      fullName: "acme/a",
      visibility: "public",
      defaultBranch: "main",
      description: "",
      htmlUrl: "",
      extra: "not declared",
    }],
  });
  assertEquals(repos.success, true);
  // strict, not passthrough: an undeclared field is dropped, not kept
  assertEquals("extra" in repos.data!.repos[0], false);
});

Deno.test("buildRepoCreateParams maps to snake_case and omits what was not given", () => {
  assertEquals(
    buildRepoCreateParams({ name: "a", private: true, autoInit: false }),
    { name: "a", private: true, auto_init: false },
  );
  assertEquals(
    buildRepoCreateParams({
      name: "a",
      private: false,
      autoInit: true,
      description: "d",
      licenseTemplate: "mit",
      gitignoreTemplate: "Node",
      homepage: "https://example.com",
    }),
    {
      name: "a",
      private: false,
      auto_init: true,
      description: "d",
      license_template: "mit",
      gitignore_template: "Node",
      homepage: "https://example.com",
    },
  );
});

Deno.test("findReleaseByTag and findOpenPull match exactly, or not at all", () => {
  const releases = [{ tag_name: "v1", id: 1 }, { tag_name: "v1.0", id: 2 }];
  assertEquals(findReleaseByTag(releases, "v1")?.id, 1);
  assertEquals(findReleaseByTag(releases, "v1.0")?.id, 2);
  // a prefix is not a match
  assertEquals(findReleaseByTag(releases, "v"), undefined);
  assertEquals(findReleaseByTag([], "v1"), undefined);

  const pulls = [
    { head: { ref: "feature" }, base: { ref: "main" }, number: 7 },
    { head: { ref: "feature" }, base: { ref: "dev" }, number: 8 },
  ];
  assertEquals(findOpenPull(pulls, "feature", "main")?.number, 7);
  assertEquals(findOpenPull(pulls, "feature", "dev")?.number, 8);
  // same head, another base: not the same pull request
  assertEquals(findOpenPull(pulls, "feature", "release"), undefined);
  assertEquals(findOpenPull(pulls, "other", "main"), undefined);
});

Deno.test("qualifiedHead and slug", () => {
  assertEquals(qualifiedHead("acme", "feature"), "acme:feature");
  assertEquals(slug("a/b c"), "a-b-c");
  assertEquals(slug("--x--"), "x");
  assertEquals(slug("v1.0_rc-2"), "v1.0_rc-2");
  // nothing safe left: an empty name, which a caller must not accept blindly
  assertEquals(slug("///"), "");
});

// ---------------------------------------------------------------------------
// Methods, run through createModelTestContext with a stub answering fetch.
// ---------------------------------------------------------------------------

const REPO = {
  name: "tool",
  full_name: "acme/tool",
  private: true,
  default_branch: "main",
  description: null,
  html_url: "https://github.test/acme/tool",
};

Deno.test("sync stores the owner's repositories and sends the token only as the credential", async () => {
  const r = await withStub(
    { "GET /user/repos?per_page=100": { status: 200, body: [REPO] } },
    (c) => model.methods.sync.execute({}, c),
  );
  assertEquals(r.error, undefined);
  assertEquals(r.seen[0].authorization, `token ${PLANTED}`);
  const [w] = r.written;
  assertEquals([w.spec, w.name, w.data.count], ["repos", "repos", 1]);
  assertEquals((w.data.repos as Record<string, unknown>[])[0], {
    name: "tool",
    fullName: "acme/tool",
    visibility: "private",
    defaultBranch: "main",
    description: "",
    htmlUrl: "https://github.test/acme/tool",
  });
  assertNoPlanted(r);
});

Deno.test("sync of an organization lists the org's repositories", async () => {
  const r = await withStub(
    { "GET /orgs/acme/repos?per_page=100": { status: 200, body: [] } },
    (c) => model.methods.sync.execute({}, c),
    { isOrg: true },
  );
  assertEquals(r.error, undefined);
  assertEquals(r.written[0].data.count, 0);
});

Deno.test("sync fails on a refused token and writes nothing", async () => {
  const r = await withStub(
    {
      "GET /user/repos?per_page=100": {
        status: 401,
        body: { message: "Bad credentials" },
      },
    },
    (c) => model.methods.sync.execute({}, c),
  );
  assertInstanceOf(r.error, Error);
  assertStringIncludes(r.error.message, "Bad credentials");
  assertEquals(r.written, []);
  assertNoPlanted(r);
});

const ensureArgs = (o: Record<string, unknown> = {}) =>
  model.methods.ensureRepo.arguments.parse({ name: "tool", ...o });

Deno.test("ensureRepo reports an existing repository and creates nothing", async () => {
  const r = await withStub(
    { "GET /repos/acme/tool": { status: 200, body: REPO } },
    (c) => model.methods.ensureRepo.execute(ensureArgs({ dryRun: false }), c),
  );
  assertEquals(r.error, undefined);
  assertEquals(r.seen.map((s) => s.method), ["GET"]);
  assertEquals(r.written[0].name, "repo-tool");
  assertEquals(r.written[0].data.status, "exists");
  assertEquals(r.written[0].data.visibility, "private");
});

Deno.test("ensureRepo in a dry run plans the create and posts nothing", async () => {
  const r = await withStub(
    { "GET /repos/acme/tool": { status: 404, body: { message: "Not Found" } } },
    (c) => model.methods.ensureRepo.execute(ensureArgs(), c),
  );
  assertEquals(r.error, undefined);
  assertEquals(r.seen.map((s) => s.method), ["GET"]);
  assertEquals(r.written[0].data.status, "would-create");
});

Deno.test("ensureRepo creates a missing repository and sets its topics", async () => {
  const r = await withStub(
    {
      "GET /repos/acme/tool": { status: 404, body: { message: "Not Found" } },
      "POST /user/repos": { status: 201, body: { ...REPO, private: false } },
      "PUT /repos/acme/tool/topics": { status: 200, body: { names: ["s3"] } },
    },
    (c) =>
      model.methods.ensureRepo.execute(
        ensureArgs({ dryRun: false, topics: ["s3"] }),
        c,
      ),
  );
  assertEquals(r.error, undefined);
  assertEquals(r.seen[1].body, {
    name: "tool",
    private: false,
    auto_init: true,
  });
  assertEquals(r.seen[2].body, { names: ["s3"] });
  assertEquals(r.written[0].data.status, "created");
  assertEquals(r.written[0].data.visibility, "public");
});

Deno.test("ensureRepo fails on a lookup error other than 404 and writes nothing", async () => {
  const r = await withStub(
    { "GET /repos/acme/tool": { status: 403, body: { message: "Forbidden" } } },
    (c) => model.methods.ensureRepo.execute(ensureArgs({ dryRun: false }), c),
  );
  assertInstanceOf(r.error, Error);
  assertEquals(r.seen.length, 1);
  assertEquals(r.written, []);
});

const releaseArgs = (o: Record<string, unknown> = {}) =>
  model.methods.ensureRelease.arguments.parse({
    repo: "tool",
    tagName: "v1.0.0",
    ...o,
  });
const RELEASES = "GET /repos/acme/tool/releases?per_page=100";

Deno.test("ensureRelease creates a release whose tag is missing", async () => {
  const r = await withStub(
    {
      [RELEASES]: { status: 200, body: [{ id: 1, tag_name: "v0.9.0" }] },
      "POST /repos/acme/tool/releases": {
        status: 201,
        body: { id: 2, html_url: "https://github.test/r/2" },
      },
    },
    (c) =>
      model.methods.ensureRelease.execute(releaseArgs({ dryRun: false }), c),
  );
  assertEquals(r.error, undefined);
  assertEquals((r.seen[1].body as Record<string, unknown>).tag_name, "v1.0.0");
  assertEquals(r.written[0].name, "release-tool-v1.0.0");
  assertEquals([r.written[0].data.status, r.written[0].data.releaseId], [
    "created",
    2,
  ]);
});

Deno.test("ensureRelease leaves an existing release alone", async () => {
  const r = await withStub(
    { [RELEASES]: { status: 200, body: [{ id: 7, tag_name: "v1.0.0" }] } },
    (c) =>
      model.methods.ensureRelease.execute(releaseArgs({ dryRun: false }), c),
  );
  assertEquals(r.seen.length, 1);
  assertEquals(r.written[0].data.status, "exists");
  assertEquals(r.written[0].data.releaseId, 7);
});

Deno.test("ensureRelease fails when the repository is not there", async () => {
  const r = await withStub(
    { [RELEASES]: { status: 404, body: { message: "Not Found" } } },
    (c) => model.methods.ensureRelease.execute(releaseArgs(), c),
  );
  assertInstanceOf(r.error, Error);
  assertEquals(r.written, []);
});

const prArgs = (o: Record<string, unknown> = {}) =>
  model.methods.openPr.arguments.parse({
    repo: "tool",
    head: "feat",
    title: "A change",
    ...o,
  });
const PULLS =
  "GET /repos/acme/tool/pulls?state=open&head=acme%3Afeat&base=main&per_page=100";

Deno.test("openPr opens a pull request when none is open for head and base", async () => {
  const r = await withStub(
    {
      [PULLS]: { status: 200, body: [] },
      "POST /repos/acme/tool/pulls": {
        status: 201,
        body: { number: 12, html_url: "https://github.test/p/12" },
      },
    },
    (c) => model.methods.openPr.execute(prArgs({ dryRun: false }), c),
  );
  assertEquals(r.error, undefined);
  assertEquals(r.written[0].name, "pull-tool-feat-main");
  assertEquals([r.written[0].data.status, r.written[0].data.number], [
    "created",
    12,
  ]);
});

Deno.test("openPr in a dry run plans and posts nothing", async () => {
  const r = await withStub(
    { [PULLS]: { status: 200, body: [] } },
    (c) => model.methods.openPr.execute(prArgs(), c),
  );
  assertEquals(r.seen.length, 1);
  assertEquals(r.written[0].data.status, "would-create");
});

Deno.test("openPr fails when the pull request create is refused", async () => {
  const r = await withStub(
    {
      [PULLS]: { status: 200, body: [] },
      "POST /repos/acme/tool/pulls": {
        status: 422,
        body: { message: "Validation Failed" },
      },
    },
    (c) => model.methods.openPr.execute(prArgs({ dryRun: false }), c),
  );
  assertInstanceOf(r.error, Error);
  assertStringIncludes(r.error.message, "Validation Failed");
  assertEquals(r.written, []);
  assertNoPlanted(r);
});
