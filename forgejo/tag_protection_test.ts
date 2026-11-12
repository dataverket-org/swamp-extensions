import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { extension, sameSet } from "./tag_protection.ts";
import { harness, writes } from "./stub_test.ts";

// tag_protection_ensure's behaviour is tested live, in smoke/ (batch b);
// here only the comparison that decides between unchanged and a write.

Deno.test("sameSet: the same logins in any order, duplicates aside, are one set", () => {
  assertEquals(sameSet(["b", "a"], ["a", "b"]), true);
  assertEquals(sameSet(["a", "a", "b"], ["b", "a"]), true);
  assertEquals(sameSet([], []), true);
});

Deno.test("sameSet: a subset, a superset or another name is not the same set", () => {
  assertEquals(sameSet(["a"], ["a", "b"]), false);
  assertEquals(sameSet(["a", "b"], ["a"]), false);
  assertEquals(sameSet(["a"], ["A"]), false);
  assertEquals(sameSet(["a"], []), false);
});

// ───── the methods, through createModelTestContext with a stub client ─────

const TAGS = "/api/v1/repos/acme/tool/tag_protections";
const tp = extension.methods[0].tag_protection_ensure;
const rule = (users: string[]) => ({
  id: 3,
  name_pattern: "attestation/*",
  whitelist_usernames: users,
  whitelist_teams: [],
});
const args = (users: string[]) => ({
  owner: "acme",
  name: "tool",
  namePattern: "attestation/*",
  whitelistUsernames: users,
  whitelistTeams: [],
});

Deno.test("tag_protection_ensure creates a missing rule and records it by pattern", async () => {
  const h = harness({
    [`GET ${TAGS}`]: { status: 200, body: [] },
    [`POST ${TAGS}`]: { status: 201, body: rule(["a"]) },
  });
  await tp.execute(args(["a"]), h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{
    name_pattern: "attestation/*",
    whitelist_usernames: ["a"],
    whitelist_teams: [],
  }]);
  assertEquals(h.written().map((w) => [w.name, w.data.action]), [[
    "tag-protection-acme-tool-attestation",
    "created",
  ]]);
});

Deno.test("tag_protection_ensure refuses a login the forge does not count", async () => {
  const h = harness({
    [`GET ${TAGS}`]: { status: 200, body: [rule(["a"])] },
    [`PATCH ${TAGS}/3`]: { status: 200, body: rule(["a"]) },
  });
  await assertRejects(
    () => tp.execute(args(["a", "reader"]), h.context),
    Error,
    'the forge does not count "reader" in the tag protection attestation/*',
  );
  assertEquals(h.written(), []);
});
