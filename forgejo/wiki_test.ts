import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { extension, fromBase64, sha256, toBase64 } from "./wiki.ts";
import { harness, writes } from "./stub_test.ts";

const TITLE = "ceph-rdb risc-v dpu card";
/** What Forgejo lists for that title; seen on a Forgejo 15 forge. */
const SUB = "ceph-rdb+risc-v+dpu+card.-";
const PAGE = `/api/v1/repos/acme/tool/wiki/page/${SUB}`;
const LIST = "/api/v1/repos/acme/tool/wiki/pages?page=1&limit=50";
const NEW = "/api/v1/repos/acme/tool/wiki/new";
const REPO = "/api/v1/repos/acme/tool";
const RECORD = "wiki-acme-tool-ceph-rdb-risc-v-dpu-card";

const get = extension.methods[0].wiki_page_get;
const ensure = extension.methods[0].wiki_page_ensure;
const ref = { owner: "acme", name: "tool", page: TITLE };

/** Forgejo's page body for `content`. */
function page(content: string) {
  return {
    title: TITLE,
    sub_url: SUB,
    html_url: `https://forge.example.com/acme/tool/wiki/${SUB}`,
    content_base64: toBase64(content),
    commit_count: 3,
    last_commit: {
      sha: "7545eaaf",
      message: "Update ceph-rdb risc-v dpu card\n",
      author: { name: "someone", date: "2026-11-14T10:43:13Z" },
    },
  };
}
const listed = [{ title: "Home", sub_url: "Home" }, {
  title: TITLE,
  sub_url: SUB,
}];

Deno.test("base64 round-trips UTF-8, letters outside ASCII included", () => {
  const text = "# Notes\n\nKunnskap, åpen kildekode, suverenitet.\n";
  assertEquals(fromBase64(toBase64(text)), text);
});

Deno.test("wiki_page_get resolves the title through the listing and records the content", async () => {
  const h = harness({
    [`GET ${LIST}`]: { status: 200, body: listed },
    [`GET ${PAGE}`]: { status: 200, body: page("# old\n") },
  });
  await get.execute(ref, h.context);
  assertEquals(h.calls.map((c) => c.path), [LIST, PAGE]);
  assertEquals(
    h.calls.some((c) => c.path.includes(encodeURIComponent(TITLE))),
    false,
  );
  const w = h.written()[0];
  assertEquals(w.spec, "wikiPage");
  assertEquals(w.name, RECORD);
  assertEquals(
    [w.data.action, w.data.content, w.data.bytes, w.data.subUrl],
    ["observed", "# old\n", 6, SUB],
  );
  assertEquals(w.data.contentSha256, await sha256("# old\n"));
  assertEquals((w.data.lastCommit as { sha: string }).sha, "7545eaaf");
});

Deno.test("wiki_page_get names a page the wiki does not have and writes nothing", async () => {
  const h = harness({
    [`GET ${LIST}`]: {
      status: 200,
      body: [{ title: "Home", sub_url: "Home" }],
    },
    [`GET ${REPO}`]: { status: 200, body: { has_wiki: true } },
  });
  await assertRejects(() => get.execute(ref, h.context), Error, TITLE);
  assertEquals(h.written(), []);
});

Deno.test("wiki_page_get on a repository that is not there carries the forge's 404", async () => {
  const h = harness({
    [`GET ${LIST}`]: { status: 404, body: { message: "not found" } },
    [`GET ${REPO}`]: {
      status: 404,
      body: { message: "The target couldn't be found." },
    },
  });
  await assertRejects(() => get.execute(ref, h.context), Error, "HTTP 404");
  assertEquals(h.written(), []);
});

Deno.test("wiki_page_ensure names a wiki that is off before writing anything", async () => {
  const h = harness({
    [`GET ${LIST}`]: { status: 404, body: { message: "not found" } },
    [`GET ${REPO}`]: { status: 200, body: { has_wiki: false } },
  });
  await assertRejects(
    () => ensure.execute({ ...ref, content: "# new\n" }, h.context),
    Error,
    "wiki of acme/tool is off",
  );
  assertEquals([writes(h.calls), h.written()], [[], []]);
});

Deno.test("wiki_page_ensure creates a missing page, also when the wiki is empty (404 listing)", async () => {
  const h = harness({
    [`GET ${LIST}`]: { status: 404, body: { message: "not found" } },
    [`GET ${REPO}`]: { status: 200, body: { has_wiki: true } },
    [`POST ${NEW}`]: { status: 201, body: page("# new\n") },
  });
  await ensure.execute({ ...ref, content: "# new\n" }, h.context);
  assertEquals(writes(h.calls).map((c) => [c.method, c.path, c.body]), [[
    "POST",
    NEW,
    {
      title: TITLE,
      content_base64: toBase64("# new\n"),
      message: `Add ${TITLE}`,
    },
  ]]);
  const w = h.written()[0];
  assertEquals(
    [
      w.name,
      w.data.action,
      w.data.previousSha256,
      w.data.content,
      w.data.message,
    ],
    [RECORD, "created", null, null, `Add ${TITLE}`],
  );
});

Deno.test("wiki_page_ensure rewrites a page whose content differs, at the listed sub_url", async () => {
  const h = harness({
    [`GET ${LIST}`]: { status: 200, body: listed },
    [`GET ${PAGE}`]: { status: 200, body: page("# old\n") },
    [`PATCH ${PAGE}`]: { status: 200, body: page("# new\n") },
  });
  await ensure.execute(
    { ...ref, content: "# new\n", message: "Rework after review" },
    h.context,
  );
  assertEquals(writes(h.calls).map((c) => [c.method, c.path, c.body]), [[
    "PATCH",
    PAGE,
    {
      title: TITLE,
      content_base64: toBase64("# new\n"),
      message: "Rework after review",
    },
  ]]);
  const w = h.written()[0];
  assertEquals([w.data.action, w.data.message], [
    "updated",
    "Rework after review",
  ]);
  assertEquals(w.data.previousSha256, await sha256("# old\n"));
  assertEquals(w.data.contentSha256, await sha256("# new\n"));
});

Deno.test("wiki_page_ensure writes nothing when the page already holds the content", async () => {
  const h = harness({
    [`GET ${LIST}`]: { status: 200, body: listed },
    [`GET ${PAGE}`]: { status: 200, body: page("# same\n") },
  });
  await ensure.execute({ ...ref, content: "# same\n" }, h.context);
  assertEquals(writes(h.calls), []);
  const w = h.written()[0];
  assertEquals([w.data.action, w.data.message], ["unchanged", null]);
  assertEquals(w.data.previousSha256, w.data.contentSha256);
});

Deno.test("wiki_page_ensure carries a refused write as the forge's message, with no record", async () => {
  const h = harness({
    [`GET ${LIST}`]: { status: 200, body: listed },
    [`GET ${PAGE}`]: { status: 200, body: page("# old\n") },
    [`PATCH ${PAGE}`]: {
      status: 403,
      body: {
        message: "token does not have at least one of required scope(s)",
      },
    },
  });
  await assertRejects(
    () => ensure.execute({ ...ref, content: "# new\n" }, h.context),
    Error,
    "required scope",
  );
  assertEquals(h.written(), []);
});
