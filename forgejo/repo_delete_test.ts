import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { extension } from "./repo_delete.ts";
import { harness, writes } from "./stub_test.ts";

const m = extension.methods[0].repo_delete;
const REPO = "/api/v1/repos/acme/tool";

Deno.test("repo_delete deletes an empty repository and records what it was", async () => {
  const h = harness({
    [`GET ${REPO}`]: { status: 200, body: { empty: true, description: "d" } },
    [`DELETE ${REPO}`]: { status: 204 },
  });
  await m.execute(
    { owner: "acme", name: "tool", allowContent: false },
    h.context,
  );
  assertEquals(h.written().map((w) => [w.spec, w.name]), [[
    "repoDelete",
    "repo-delete-acme-tool",
  ]]);
  assertEquals(h.written()[0].data.action, "deleted");
  assertEquals(h.written()[0].data.wasEmpty, true);
});

Deno.test("repo_delete records a repository already gone as absent, deleting nothing", async () => {
  const h = harness({ [`GET ${REPO}`]: { status: 404, body: {} } });
  await m.execute(
    { owner: "acme", name: "tool", allowContent: false },
    h.context,
  );
  assertEquals(h.written()[0].data.action, "absent");
  assertEquals(writes(h.calls), []);
});

Deno.test("repo_delete refuses a repository with commits, writing nothing", async () => {
  const h = harness({
    [`GET ${REPO}`]: { status: 200, body: { empty: false } },
  });
  await assertRejects(
    () =>
      m.execute(
        { owner: "acme", name: "tool", allowContent: false },
        h.context,
      ),
    Error,
    "acme/tool has commits; pass allowContent=true",
  );
  assertEquals([writes(h.calls), h.written()], [[], []]);
});

Deno.test("repo_delete refuses a renamed repository's old name with the forge's redirect", async () => {
  const h = harness({
    [`GET ${REPO}`]: {
      status: 301,
      body: {
        message:
          "acme/tool was renamed; it now redirects to /api/v1/repos/acme/new",
      },
    },
  });
  await assertRejects(
    () =>
      m.execute({ owner: "acme", name: "tool", allowContent: true }, h.context),
    Error,
    "HTTP 301: acme/tool was renamed",
  );
  assertEquals(writes(h.calls), []);
});
