import { assertEquals, assertStrictEquals } from "jsr:@std/assert@1.0.13";
import { model } from "./github.ts";
import { extension } from "./repo_settings.ts";
import {
  buildRepoCreateParams,
  findOpenPull,
  findReleaseByTag,
  qualifiedHead,
  slug,
} from "./_lib/github_plan.ts";

Deno.test("the forked base owns the @dataverket/github type at this package's version", () => {
  assertEquals(model.type, "@dataverket/github");
  assertEquals(model.version, "2026.10.05.1");
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
