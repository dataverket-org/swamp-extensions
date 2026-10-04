import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  type ApiCall,
  type Caller,
  repoUnitsEnsure,
  type RepoUnitsEnsureArgsT,
} from "./units.ts";

const PATH = "/api/v1/repos/acme/tool";

interface Repo {
  has_actions: boolean;
  has_packages: boolean;
  has_projects: boolean;
}

/**
 * A forge as strict as Forgejo: it answers GET with the repository, applies a
 * PATCH to the fields sent and returns the whole repository, and knows no
 * other path. `applies` false models an instance where the unit is disabled:
 * the PATCH is accepted and the field stays as it was.
 */
function fakeApi(
  repo: Repo | undefined,
  opts: { applies?: boolean; patchStatus?: number } = {},
): { api: Caller; calls: ApiCall[] } {
  const calls: ApiCall[] = [];
  const state = repo ? { ...repo } : undefined;
  const api: Caller = (c) => {
    calls.push(c);
    if (c.path !== PATH || !state) {
      return Promise.resolve({ status: 404, body: { message: "not found" } });
    }
    if (c.method === "GET") {
      return Promise.resolve({ status: 200, body: { ...state } });
    }
    if (c.method === "PATCH") {
      if (opts.patchStatus) {
        return Promise.resolve({
          status: opts.patchStatus,
          body: { message: "user does not have write access" },
        });
      }
      if (opts.applies !== false) Object.assign(state, c.body);
      return Promise.resolve({ status: 200, body: { ...state } });
    }
    return Promise.resolve({ status: 405, body: { message: "method" } });
  };
  return { api, calls };
}

const off: Repo = {
  has_actions: false,
  has_packages: true,
  has_projects: false,
};
const args = (
  u: Partial<
    Pick<RepoUnitsEnsureArgsT, "hasActions" | "hasPackages" | "hasProjects">
  >,
): RepoUnitsEnsureArgsT => ({ owner: "acme", name: "tool", ...u });

Deno.test("a unit that is off is switched on, and only that field is sent", async () => {
  const { api, calls } = fakeApi(off);
  const info = await repoUnitsEnsure(api, args({ hasActions: true }));
  assertEquals(info.action, "updated");
  assertEquals(info.changed, ["hasActions"]);
  assertEquals(info.hasActions, true);
  assertEquals(info.hasPackages, true);
  assertEquals(calls.map((c) => c.method), ["GET", "PATCH"]);
  assertEquals(calls[1].body, { has_actions: true });
});

Deno.test("nothing is written when every given unit already matches", async () => {
  const { api, calls } = fakeApi(off);
  const info = await repoUnitsEnsure(
    api,
    args({ hasActions: false, hasPackages: true }),
  );
  assertEquals(info.action, "unchanged");
  assertEquals(info.changed, []);
  assertEquals(calls.map((c) => c.method), ["GET"]);
});

Deno.test("a unit not named is not sent, even when it differs from a default", async () => {
  const { api, calls } = fakeApi(off);
  await repoUnitsEnsure(api, args({ hasProjects: true }));
  assertEquals(calls[1].body, { has_projects: true });
});

Deno.test("switching off works the same way", async () => {
  const { api, calls } = fakeApi(off);
  const info = await repoUnitsEnsure(api, args({ hasPackages: false }));
  assertEquals(info.hasPackages, false);
  assertEquals(calls[1].body, { has_packages: false });
});

Deno.test("a missing repository is named, and nothing is written", async () => {
  const { api, calls } = fakeApi(undefined);
  await assertRejects(
    () => repoUnitsEnsure(api, args({ hasActions: true })),
    Error,
    "acme/tool does not exist",
  );
  assertEquals(calls.map((c) => c.method), ["GET"]);
});

Deno.test("a change the forge accepts but does not apply is an error", async () => {
  const { api } = fakeApi(off, { applies: false });
  await assertRejects(
    () => repoUnitsEnsure(api, args({ hasActions: true })),
    Error,
    "did not apply hasActions",
  );
});

Deno.test("a refused PATCH carries the forge's message", async () => {
  const { api } = fakeApi(off, { patchStatus: 403 });
  await assertRejects(
    () => repoUnitsEnsure(api, args({ hasActions: true })),
    Error,
    "HTTP 403: user does not have write access",
  );
});

Deno.test("owner and name are URL-encoded in the path", async () => {
  const calls: ApiCall[] = [];
  const api: Caller = (c) => {
    calls.push(c);
    return Promise.resolve({ status: 200, body: { has_actions: true } });
  };
  await repoUnitsEnsure(api, { owner: "a b", name: "t/ool", hasActions: true });
  assertEquals(calls[0].path, "/api/v1/repos/a%20b/t%2Fool");
});
