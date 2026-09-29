import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { type ApiCall, type Caller } from "./api.ts";
import {
  actionsSecretPut,
  repoRename,
  runnerList,
  runnerPrune,
  runnerRegistrationToken,
} from "./actions.ts";

/** A fake API: replies per `method path`, records every call. */
function fakeApi(
  replies: Record<
    string,
    { status: number; body?: Record<string, unknown> | unknown[] }
  >,
): { api: Caller; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const api: Caller = (c) => {
    calls.push(c);
    const r = replies[`${c.method} ${c.path}`];
    if (!r) {
      return Promise.resolve({
        status: 404,
        body: { message: `no reply for ${c.method} ${c.path}` },
      });
    }
    return Promise.resolve({
      status: r.status,
      body: (r.body ?? {}) as Record<string, unknown>,
    });
  };
  return { api, calls };
}

Deno.test("actionsSecretPut targets the repo or the org and reports created vs updated", async () => {
  const repo = fakeApi({
    ["PUT /api/v1/repos/example-org/example-repo/actions/secrets/COSIGN_PASSWORD"]:
      {
        status: 201,
      },
  });
  const created = await actionsSecretPut(repo.api, {
    owner: "example-org",
    repo: "example-repo",
    name: "COSIGN_PASSWORD",
    value: "hunter2",
  });
  assertEquals(created, {
    ...created,
    scope: "repo",
    target: "example-org/example-repo",
    action: "created",
  });
  assertEquals(repo.calls[0].body, { data: "hunter2" });

  const org = fakeApi({
    ["PUT /api/v1/orgs/example-org/actions/secrets/REGISTRY_PASSWORD"]: {
      status: 204,
    },
  });
  const updated = await actionsSecretPut(org.api, {
    owner: "example-org",
    name: "REGISTRY_PASSWORD",
    value: "x",
  });
  assertEquals(updated.scope, "org");
  assertEquals(updated.action, "updated");
});

Deno.test("runnerRegistrationToken returns the token and refuses an empty one", async () => {
  const ok = fakeApi({
    ["GET /api/v1/orgs/example-org/actions/runners/registration-token"]: {
      status: 200,
      body: { token: "reg-123" },
    },
  });
  const info = await runnerRegistrationToken(ok.api, { owner: "example-org" });
  assertEquals(info.token, "reg-123");
  assertEquals(info.scope, "org");

  const empty = fakeApi({
    ["GET /api/v1/repos/example-org/example-repo/actions/runners/registration-token"]:
      { status: 200, body: {} },
  });
  await assertRejects(
    () =>
      runnerRegistrationToken(empty.api, {
        owner: "example-org",
        repo: "example-repo",
      }),
    Error,
    "no registration token",
  );
});

Deno.test("runnerList reads both response shapes and classifies scope from ids", async () => {
  const runner = (id: number, extra: Record<string, unknown>) => ({
    id,
    uuid: `u${id}`,
    name: `r${id}`,
    status: "online",
    labels: ["example-repo-release"],
    ephemeral: false,
    version: "6.3.0",
    owner_id: 0,
    repo_id: 0,
    ...extra,
  });
  const wrapped = fakeApi({
    ["GET /api/v1/orgs/example-org/actions/runners?visible=true&limit=100&page=1"]:
      {
        status: 200,
        body: {
          runners: [
            runner(1, { owner_id: 5 }),
            runner(2, { repo_id: 9, labels: [{ name: "docker" }] }),
          ],
        },
      },
  });
  const list = await runnerList(wrapped.api, { owner: "example-org" });
  assertEquals(list.map((r) => [r.name, r.level, r.labels]), [
    ["r1", "org", ["example-repo-release"]],
    ["r2", "repo", ["docker"]],
  ]);

  const bare = fakeApi({
    ["GET /api/v1/repos/example-org/example-repo/actions/runners?visible=true&limit=100&page=1"]:
      {
        status: 200,
        body: [runner(3, {})],
      },
  });
  const one = await runnerList(bare.api, {
    owner: "example-org",
    repo: "example-repo",
  });
  assertEquals(one.length, 1);
  assertEquals(one[0].level, "instance");
  assertEquals(one[0].target, "example-org/example-repo");
});

const REPO = (n: string) => `/api/v1/repos/example-org/${n}`;
const repo = (n: string) => ({
  name: n,
  html_url: `https://forge/example-org/${n}`,
  clone_url: `https://forge/example-org/${n}.git`,
  ssh_url: `git@forge:example-org/${n}.git`,
});

Deno.test("repoRename verifies source and target, then patches the name", async () => {
  const { api, calls } = fakeApi({
    [`GET ${REPO("flux-bootstrap")}`]: {
      status: 200,
      body: repo("flux-bootstrap"),
    },
    [`PATCH ${REPO("flux-bootstrap")}`]: {
      status: 200,
      body: repo("example-repo-infra"),
    },
  });
  const info = await repoRename(api, {
    owner: "example-org",
    name: "flux-bootstrap",
    newName: "example-repo-infra",
  });
  assertEquals(info.action, "renamed");
  assertEquals(info.to, "example-repo-infra");
  assertEquals(
    info.cloneUrl,
    "https://forge/example-org/example-repo-infra.git",
  );
  assertEquals(calls.map((c) => `${c.method} ${c.path}`), [
    `GET ${REPO("flux-bootstrap")}`,
    `GET ${REPO("example-repo-infra")}`,
    `PATCH ${REPO("flux-bootstrap")}`,
  ]);
  assertEquals(calls[2].body, { name: "example-repo-infra" });
});

Deno.test("repoRename refuses a missing source and an occupied target; a redirect does not count", async () => {
  await assertRejects(
    () =>
      repoRename(fakeApi({}).api, {
        owner: "example-org",
        name: "nope",
        newName: "x",
      }),
    Error,
    "does not exist",
  );
  const occupied = fakeApi({
    [`GET ${REPO("a")}`]: { status: 200, body: repo("a") },
    [`GET ${REPO("b")}`]: { status: 200, body: repo("b") },
  });
  await assertRejects(
    () =>
      repoRename(occupied.api, {
        owner: "example-org",
        name: "a",
        newName: "b",
      }),
    Error,
    "already exists",
  );
  // A GET of the target that answers with the *source* repo is Forgejo following a stale redirect: not occupied.
  const redirect = fakeApi({
    [`GET ${REPO("a")}`]: { status: 200, body: repo("a") },
    [`GET ${REPO("old")}`]: { status: 200, body: repo("a") },
    [`PATCH ${REPO("a")}`]: { status: 200, body: repo("old") },
  });
  const info = await repoRename(redirect.api, {
    owner: "example-org",
    name: "a",
    newName: "old",
  });
  assertEquals(info.action, "renamed");
});

Deno.test("repoRename reports unchanged when the name is already the target", async () => {
  const { api, calls } = fakeApi({
    [`GET ${REPO("same")}`]: { status: 200, body: repo("same") },
  });
  const info = await repoRename(api, {
    owner: "example-org",
    name: "same",
    newName: "same",
  });
  assertEquals(info.action, "unchanged");
  assertEquals(calls.length, 1);
});

Deno.test("runnerPrune deletes only offline runners of the given name", async () => {
  const runner = (id: number, name: string, status: string) => ({
    id,
    uuid: `u${id}`,
    name,
    status,
    labels: ["example-repo-release"],
    ephemeral: false,
    version: "12.7.3",
    owner_id: 0,
    repo_id: 9,
  });
  const R = "/api/v1/repos/example-org/example-repo/actions/runners";
  const { api, calls } = fakeApi({
    [`GET ${R}?visible=true&limit=100&page=1`]: {
      status: 200,
      body: [
        runner(1, "example-repo-release", "offline"),
        runner(2, "example-repo-release", "idle"),
        runner(3, "other", "offline"),
        runner(4, "example-repo-release", "offline"),
      ],
    },
    [`DELETE ${R}/1`]: { status: 204 },
    [`DELETE ${R}/4`]: { status: 204 },
  });
  const info = await runnerPrune(api, {
    owner: "example-org",
    repo: "example-repo",
    name: "example-repo-release",
  });
  assertEquals(info.deleted.map((d) => d.id), [1, 4]);
  assertEquals(info.kept, [{ id: 2, uuid: "u2", status: "idle" }]);
  assertEquals(calls.filter((c) => c.method === "DELETE").map((c) => c.path), [
    `${R}/1`,
    `${R}/4`,
  ]);
});
