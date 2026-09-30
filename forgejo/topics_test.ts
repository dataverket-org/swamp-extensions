import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  type ApiCall,
  type Caller,
  normalizeTopics,
  repoTopicsEnsure,
} from "./topics.ts";

const PATH = "/api/v1/repos/acme/tool/topics";

function fakeApi(have: string[]): { api: Caller; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const api: Caller = (c) => {
    calls.push(c);
    if (c.method === "GET" && c.path === PATH) {
      return Promise.resolve({ status: 200, body: { topics: have } });
    }
    if (c.method === "PUT" && c.path === PATH) {
      return Promise.resolve({ status: 204, body: {} });
    }
    return Promise.resolve({ status: 404, body: { message: "not found" } });
  };
  return { api, calls };
}

const args = (topics: string[], exact = false) => ({
  owner: "acme",
  name: "tool",
  topics,
  exact,
});

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

Deno.test("additive: the given topics are added and the others kept", async () => {
  const { api, calls } = fakeApi(["go"]);
  const info = await repoTopicsEnsure(api, args(["upstream-mirror"]));
  assertEquals(info.action, "updated");
  assertEquals(info.topics, ["go", "upstream-mirror"]);
  assertEquals(info.added, ["upstream-mirror"]);
  assertEquals(info.removed, []);
  assertEquals(calls[1].body, { topics: ["go", "upstream-mirror"] });
});

Deno.test("nothing is written when the topics are already there", async () => {
  const { api, calls } = fakeApi(["go", "upstream-mirror"]);
  const info = await repoTopicsEnsure(api, args(["Upstream-Mirror"]));
  assertEquals(info.action, "unchanged");
  assertEquals(calls.map((c) => c.method), ["GET"]);
});

Deno.test("exact: the list becomes the whole set", async () => {
  const { api, calls } = fakeApi(["go", "old"]);
  const info = await repoTopicsEnsure(api, args(["go", "new"], true));
  assertEquals(info.added, ["new"]);
  assertEquals(info.removed, ["old"]);
  assertEquals(calls[1].body, { topics: ["go", "new"] });
});

Deno.test("exact with an empty list clears every topic", async () => {
  const { api } = fakeApi(["go"]);
  const info = await repoTopicsEnsure(api, args([], true));
  assertEquals(info.topics, []);
  assertEquals(info.removed, ["go"]);
});

Deno.test("more than 25 topics is refused before anything is written", async () => {
  const have = Array.from({ length: 25 }, (_, i) => `t${i}`);
  const { api, calls } = fakeApi(have);
  await assertRejects(
    () => repoTopicsEnsure(api, args(["one-more"])),
    Error,
    "allows 25",
  );
  assertEquals(calls.map((c) => c.method), ["GET"]);
});
