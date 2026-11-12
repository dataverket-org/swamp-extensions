import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { extension, goDurationSeconds } from "./pull_mirror.ts";
import { harness, writes } from "./stub_test.ts";

Deno.test("goDurationSeconds reads Go durations and rejects the rest", () => {
  assertEquals(goDurationSeconds("8h0m0s"), 28800);
  assertEquals(goDurationSeconds("8h"), 28800);
  assertEquals(goDurationSeconds("10m"), 600);
  assertEquals(goDurationSeconds("0s"), 0);
  assertEquals(goDurationSeconds(""), null);
  assertEquals(goDurationSeconds("eight hours"), null);
});

// ───── the methods, through createModelTestContext with a stub client ─────

const REPO = "/api/v1/repos/acme/tool";
const pm = extension.methods[0].pull_mirror_ensure;
const mirror = {
  mirror: true,
  empty: false,
  private: false,
  original_url: "https://git.example.com/up/tool.git",
  mirror_interval: "8h0m0s",
  mirror_updated: "2026-11-12T08:00:00Z",
  description: "",
};

Deno.test("pull_mirror_ensure creates a mirror with only the settings given, the token never recorded", async () => {
  const h = harness({
    [`GET ${REPO}`]: { status: 404 },
    ["POST /api/v1/repos/migrate"]: { status: 201, body: mirror },
  });
  await pm.execute({
    owner: "acme",
    name: "tool",
    cloneAddr: mirror.original_url,
    authToken: "SOURCE-TOKEN-1",
  }, h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{
    clone_addr: mirror.original_url,
    repo_owner: "acme",
    repo_name: "tool",
    mirror: true,
    auth_token: "SOURCE-TOKEN-1",
  }]);
  assertEquals(h.written().map((w) => [w.name, w.data.action]), [[
    "pull-mirror-acme-tool",
    "created",
  ]]);
  assertEquals(
    JSON.stringify([h.written(), h.logs()]).includes("SOURCE-TOKEN-1"),
    false,
  );
});

Deno.test("pull_mirror_ensure refuses a failed migration's leftover, to be deleted first", async () => {
  const h = harness({
    [`GET ${REPO}`]: {
      status: 200,
      body: {
        ...mirror,
        empty: true,
        mirror_interval: "",
        mirror_updated: "0001-01-01T00:00:00Z",
      },
    },
  });
  await assertRejects(
    () =>
      pm.execute({
        owner: "acme",
        name: "tool",
        cloneAddr: mirror.original_url,
      }, h.context),
    Error,
    "acme/tool is a pull mirror whose migration failed",
  );
  assertEquals([writes(h.calls), h.written()], [[], []]);
});
