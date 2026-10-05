import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  type ApiCall,
  type Caller,
  issueEnsure,
  listIssues,
} from "./issues.ts";

const PATH = "/api/v1/repos/acme/tool/issues";

interface Existing {
  number: number;
  title: string;
  state: "open" | "closed";
}

/**
 * A forge with the given issues. A search answers with every issue whose
 * title contains the query, the way Forgejo's `q` does; pages are 50 long.
 * A create answers with the next number, or with `createStatus` when set.
 */
function fakeApi(
  existing: Existing[],
  createStatus = 201,
): { api: Caller; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  let next = existing.reduce((m, i) => Math.max(m, i.number), 0) + 1;
  const api: Caller = (c) => {
    calls.push(c);
    const [path, query = ""] = c.path.split("?");
    if (c.method === "GET" && path === "/api/v1/orgs/acme") {
      return Promise.resolve({ status: 200, body: { username: "acme" } });
    }
    if (c.method === "GET" && path === "/api/v1/orgs/acme/labels") {
      return Promise.resolve({
        status: 200,
        body: [{
          id: 11,
          name: "llm-generated",
          color: "6f42c1",
        }] as unknown as Record<string, unknown>,
      });
    }
    if (c.method === "GET" && path === "/api/v1/repos/acme/tool/labels") {
      return Promise.resolve({
        status: 200,
        body: [{ id: 3, name: "bug", color: "ee0701" }] as unknown as Record<
          string,
          unknown
        >,
      });
    }
    if (path !== PATH) {
      return Promise.resolve({ status: 404, body: { message: "not found" } });
    }
    if (c.method === "GET") {
      const p = new URLSearchParams(query);
      const q = p.get("q") ?? "";
      const page = Number(p.get("page") ?? "1");
      const state = p.get("state") ?? "open";
      const hits = existing
        .filter((i) => state === "all" || i.state === state)
        .filter((i) => i.title.includes(q))
        .map((i) => ({
          ...i,
          html_url: `https://forge.example/acme/tool/issues/${i.number}`,
        }));
      const body = hits.slice((page - 1) * 50, page * 50);
      return Promise.resolve({
        status: 200,
        body: body as unknown as Record<string, unknown>,
      });
    }
    if (c.method === "POST") {
      if (createStatus >= 400) {
        return Promise.resolve({
          status: createStatus,
          body: { message: "issues are disabled" },
        });
      }
      const b = c.body as { title: string; labels?: number[] };
      const number = next++;
      existing.push({ number, title: b.title, state: "open" });
      const names: Record<number, string> = { 3: "bug", 11: "llm-generated" };
      return Promise.resolve({
        status: createStatus,
        body: {
          number,
          title: b.title,
          state: "open",
          html_url: `https://forge.example/acme/tool/issues/${number}`,
          labels: (b.labels ?? []).map((id) => ({ id, name: names[id] })),
        },
      });
    }
    return Promise.resolve({ status: 405, body: {} });
  };
  return { api, calls };
}

const args = (
  issues: { title: string; body?: string; labels?: string[] }[],
) => ({
  owner: "acme",
  name: "tool",
  issues: issues.map((i) => ({
    title: i.title,
    body: i.body ?? "",
    labels: i.labels ?? [],
  })),
});

Deno.test("an issue with a new title is created with its body", async () => {
  const { api, calls } = fakeApi([]);
  const out = await issueEnsure(
    api,
    args([{ title: "Log every call", body: "Because." }]),
  );
  assertEquals(out.length, 1);
  assertEquals(out[0].action, "created");
  assertEquals(out[0].number, 1);
  assertEquals(out[0].url, "https://forge.example/acme/tool/issues/1");
  const post = calls.find((c) => c.method === "POST");
  assertEquals(post?.body, {
    title: "Log every call",
    body: "Because.",
    labels: [],
  });
});

Deno.test("an existing issue of the exact title is left alone, even when closed", async () => {
  const { api, calls } = fakeApi([{
    number: 7,
    title: "Log every call",
    state: "closed",
  }]);
  const out = await issueEnsure(api, args([{ title: "Log every call" }]));
  assertEquals(out[0].action, "unchanged");
  assertEquals(out[0].number, 7);
  assertEquals(out[0].state, "closed");
  assertEquals(calls.map((c) => c.method), ["GET"]);
});

Deno.test("a search hit whose title merely contains the new one does not count", async () => {
  const { api } = fakeApi([{
    number: 3,
    title: "Log every call and more",
    state: "open",
  }]);
  const out = await issueEnsure(api, args([{ title: "Log every call" }]));
  assertEquals(out[0].action, "created");
  assertEquals(out[0].number, 4);
});

Deno.test("several issues in one call: each created or found on its own", async () => {
  const { api, calls } = fakeApi([{ number: 1, title: "B", state: "open" }]);
  const out = await issueEnsure(
    api,
    args([{ title: "A" }, { title: "B" }, { title: "C" }]),
  );
  assertEquals(out.map((i) => i.action), ["created", "unchanged", "created"]);
  assertEquals(calls.filter((c) => c.method === "POST").length, 2);
});

Deno.test("the same title twice in one call is refused before any call", async () => {
  const { api, calls } = fakeApi([]);
  await assertRejects(
    () => issueEnsure(api, args([{ title: "A" }, { title: "A" }])),
    Error,
    "same title",
  );
  assertEquals(calls.length, 0);
});

Deno.test("a blank title is refused before any call", async () => {
  const { api, calls } = fakeApi([]);
  await assertRejects(() => issueEnsure(api, args([{ title: "   " }])));
  assertEquals(calls.length, 0);
});

Deno.test("an empty list is refused", async () => {
  const { api } = fakeApi([]);
  await assertRejects(() => issueEnsure(api, args([])));
});

Deno.test("the forge's refusal of a create is the error, with its message", async () => {
  const { api } = fakeApi([], 403);
  await assertRejects(
    () => issueEnsure(api, args([{ title: "A" }])),
    Error,
    "HTTP 403: issues are disabled",
  );
});

Deno.test("a match past the first page of search results is still found", async () => {
  const existing: Existing[] = Array.from({ length: 50 }, (_, i) => ({
    number: i + 1,
    title: `Needle ${i}`,
    state: "open" as const,
  }));
  existing.push({ number: 99, title: "Needle", state: "open" });
  const { api, calls } = fakeApi(existing);
  const out = await issueEnsure(api, args([{ title: "Needle" }]));
  assertEquals(out[0].action, "unchanged");
  assertEquals(out[0].number, 99);
  assertEquals(calls.filter((c) => c.method === "GET").length, 2);
});

Deno.test("listIssues follows pages and filters by state", async () => {
  const existing: Existing[] = Array.from({ length: 60 }, (_, i) => ({
    number: i + 1,
    title: `Issue ${i}`,
    state: i % 2 === 0 ? "open" as const : "closed" as const,
  }));
  const { api } = fakeApi(existing);
  assertEquals((await listIssues(api, "acme", "tool", "all")).length, 60);
  assertEquals((await listIssues(api, "acme", "tool", "open")).length, 30);
});

Deno.test("an answer that is not a list of issues yields nothing rather than failing", async () => {
  const api: Caller = () =>
    Promise.resolve({ status: 200, body: { message: "odd" } });
  assertEquals(await listIssues(api, "acme", "tool", "open"), []);
});

Deno.test("labels are resolved by name across the repository and its org, and sent as ids", async () => {
  const { api, calls } = fakeApi([]);
  const out = await issueEnsure(
    api,
    args([{ title: "A", labels: ["llm-generated", "bug"] }]),
  );
  assertEquals(out[0].labels, ["llm-generated", "bug"]);
  const post = calls.find((c) => c.method === "POST");
  assertEquals((post?.body as { labels: number[] }).labels, [11, 3]);
});

Deno.test("an unknown label name is refused before any issue is filed", async () => {
  const { api, calls } = fakeApi([]);
  await assertRejects(
    () => issueEnsure(api, args([{ title: "A", labels: ["nope"] }])),
    Error,
    '"nope"',
  );
  assertEquals(calls.filter((c) => c.method === "POST").length, 0);
});
