import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { extension, normalizeTopics } from "./topics.ts";
import { harness, writes } from "./stub_test.ts";

Deno.test("normalizeTopics lowercases, trims and de-duplicates", () => {
  assertEquals(normalizeTopics([" Upstream-Mirror", "upstream-mirror", "s3"]), [
    "upstream-mirror",
    "s3",
  ]);
});
Deno.test("normalizeTopics names every invalid topic", () => {
  assertThrows(
    () => normalizeTopics(["ok", "not ok", "-dash", "x".repeat(36)]),
    Error,
    '"not ok", "-dash"',
  );
});

// ───── the methods, through createModelTestContext with a stub client ─────

const T = "/api/v1/repos/acme/tool/topics";
const topics = extension.methods[0].repo_topics_ensure;

Deno.test("repo_topics_ensure adds topics, keeping the others, and records the set", async () => {
  const h = harness({
    [`GET ${T}`]: { status: 200, body: { topics: ["old"] } },
    [`PUT ${T}`]: { status: 204 },
  });
  await topics.execute({
    owner: "acme",
    name: "tool",
    topics: ["New"],
    exact: false,
  }, h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{
    topics: ["old", "new"],
  }]);
  const w = h.written()[0];
  assertEquals([w.name, w.data.action, w.data.topics, w.data.added], [
    "repo-topics-acme-tool",
    "updated",
    ["new", "old"],
    ["new"],
  ]);
});

Deno.test("repo_topics_ensure refuses more than 25 topics before writing", async () => {
  const h = harness({ [`GET ${T}`]: { status: 200, body: { topics: [] } } });
  await assertRejects(
    () =>
      topics.execute({
        owner: "acme",
        name: "tool",
        topics: Array.from({ length: 26 }, (_, i) => `t${i}`),
        exact: false,
      }, h.context),
    Error,
    "Forgejo allows 25",
  );
  assertEquals([writes(h.calls), h.written()], [[], []]);
});
