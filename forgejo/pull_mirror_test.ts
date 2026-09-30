import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  type ApiCall,
  type Caller,
  goDurationSeconds,
  pullMirrorEnsure,
} from "./pull_mirror.ts";

/** A fake API: replies per `method path`, records every call. */
function fakeApi(
  replies: Record<string, { status: number; body?: unknown }>,
): { api: Caller; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const api: Caller = (c) => {
    calls.push(c);
    const r = replies[`${c.method} ${c.path}`] ??
      { status: 404, body: { message: `no reply for ${c.method} ${c.path}` } };
    return Promise.resolve({
      status: r.status,
      body: (r.body ?? {}) as Record<string, unknown>,
    });
  };
  return { api, calls };
}

const REPO = "/api/v1/repos/acme/tool";
const MIRROR = {
  full_name: "acme/tool",
  mirror: true,
  empty: false,
  private: false,
  original_url: "https://github.com/upstream/tool.git",
  mirror_interval: "8h0m0s",
  mirror_updated: "2026-09-30T08:00:00Z",
  description: "upstream tool",
};
const base = {
  owner: "acme",
  name: "tool",
  cloneAddr: "https://github.com/upstream/tool.git",
};

Deno.test("goDurationSeconds reads Go durations and rejects the rest", () => {
  assertEquals(goDurationSeconds("8h0m0s"), 28800);
  assertEquals(goDurationSeconds("8h"), 28800);
  assertEquals(goDurationSeconds("10m"), 600);
  assertEquals(goDurationSeconds("0s"), 0);
  assertEquals(goDurationSeconds(""), null);
  assertEquals(goDurationSeconds("eight hours"), null);
});

Deno.test("create sends only the settings given, so the forge decides the rest", async () => {
  const { api, calls } = fakeApi({
    "POST /api/v1/repos/migrate": { status: 201, body: MIRROR },
  });
  const info = await pullMirrorEnsure(api, base);
  assertEquals(info.action, "created");
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.body, {
    clone_addr: base.cloneAddr,
    repo_owner: "acme",
    repo_name: "tool",
    mirror: true,
  });
});

Deno.test("create passes every setting that is given, the token included", async () => {
  const { api, calls } = fakeApi({
    "POST /api/v1/repos/migrate": { status: 201, body: MIRROR },
  });
  await pullMirrorEnsure(api, {
    ...base,
    private: false,
    interval: "1h",
    description: "d",
    lfs: false,
    service: "git",
    authToken: "s3cret-token",
  });
  const post = calls.find((c) => c.method === "POST")!;
  assertEquals(post.body, {
    clone_addr: base.cloneAddr,
    repo_owner: "acme",
    repo_name: "tool",
    mirror: true,
    private: false,
    mirror_interval: "1h",
    description: "d",
    lfs: false,
    service: "git",
    auth_token: "s3cret-token",
  });
});

Deno.test("an existing mirror with nothing named is left alone, whatever its visibility", async () => {
  const { api, calls } = fakeApi({
    [`GET ${REPO}`]: { status: 200, body: { ...MIRROR, private: true } },
  });
  const info = await pullMirrorEnsure(api, base);
  assertEquals(info.action, "unchanged");
  assertEquals(info.private, true);
  assertEquals(calls.map((c) => c.method), ["GET"]);
});

Deno.test("an existing mirror is patched only in the named settings that differ", async () => {
  const { api, calls } = fakeApi({
    [`GET ${REPO}`]: { status: 200, body: { ...MIRROR, private: true } },
    [`PATCH ${REPO}`]: { status: 200, body: MIRROR },
  });
  const info = await pullMirrorEnsure(api, {
    ...base,
    private: false,
    interval: "8h",
    description: "upstream tool",
  });
  assertEquals(info.action, "updated");
  assertEquals(info.changed, ["private"]);
  assertEquals(calls[1].body, { private: false });
});

Deno.test("the source is compared without case, credentials or trailing slashes", async () => {
  const { api } = fakeApi({ [`GET ${REPO}`]: { status: 200, body: MIRROR } });
  const info = await pullMirrorEnsure(api, {
    ...base,
    cloneAddr: "https://u:p@GitHub.com/Upstream/tool.git/",
  });
  assertEquals(info.action, "unchanged");
});

Deno.test("a mirror of another source is refused", async () => {
  const { api } = fakeApi({ [`GET ${REPO}`]: { status: 200, body: MIRROR } });
  await assertRejects(
    () =>
      pullMirrorEnsure(api, {
        ...base,
        cloneAddr: "https://github.com/other/tool.git",
      }),
    Error,
    "cannot be changed",
  );
});

Deno.test("a repository that is not a mirror is refused, an empty one named as a failed migration", async () => {
  const plain = fakeApi({
    [`GET ${REPO}`]: { status: 200, body: { mirror: false, empty: false } },
  });
  await assertRejects(
    () => pullMirrorEnsure(plain.api, base),
    Error,
    "is not a mirror",
  );
  const shell = fakeApi({
    [`GET ${REPO}`]: { status: 200, body: { mirror: false, empty: true } },
  });
  await assertRejects(
    () => pullMirrorEnsure(shell.api, base),
    Error,
    "still running",
  );
});

Deno.test("a never-synced mirror reports an empty lastSynced", async () => {
  const { api } = fakeApi({
    "POST /api/v1/repos/migrate": {
      status: 201,
      body: { ...MIRROR, mirror_updated: "0001-01-01T00:00:00Z" },
    },
  });
  assertEquals((await pullMirrorEnsure(api, base)).lastSynced, "");
});

Deno.test("the token appears in no record", async () => {
  const { api } = fakeApi({
    "POST /api/v1/repos/migrate": { status: 201, body: MIRROR },
  });
  const info = await pullMirrorEnsure(api, {
    ...base,
    authToken: "s3cret-token",
  });
  assertEquals(JSON.stringify(info).includes("s3cret-token"), false);
});

Deno.test("a failed migration's error never carries the source token", async () => {
  const { api } = fakeApi({
    "POST /api/v1/repos/migrate": {
      status: 422,
      body: {
        message:
          "clone https://x:s3cret-token@github.com/upstream/tool.git failed",
      },
    },
  });
  const err = await assertRejects(
    () => pullMirrorEnsure(api, { ...base, authToken: "s3cret-token" }),
    Error,
  );
  assertEquals(err.message.includes("s3cret-token"), false);
  assertEquals(err.message.includes("[REDACTED]"), true);
});
