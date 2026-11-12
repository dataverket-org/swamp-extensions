/**
 * Faults the real forge does not produce on demand, injected at the client
 * seam over the real forge: every call goes to the container forge.sh started,
 * through the package's own transport, except the one call a test chooses to
 * fail or to answer differently. Nothing here stands in for the forge.
 *
 * Run with `deno task test:live` from the extension's directory, after
 * `smoke/forge.sh up`. Without the forge it fails at once, saying so.
 *
 * @module
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  type ApiCall,
  type ApiResult,
  call,
  type Caller,
  fetchCaller,
} from "../api.ts";
import { extension as checks } from "../checks.ts";
import { model } from "../forgejo.ts";
import { listIssues } from "../issues.ts";
import { labelEnsure } from "../labels.ts";
import { repoMergeSettingsEnsure } from "../merge_settings.ts";
import { orgDelete } from "../org_delete.ts";
import { prMergeState } from "../pr_merge_state.ts";
import { pullMirrorEnsure } from "../pull_mirror.ts";
import { pushMirrorEnsure } from "../push_mirror.ts";
import {
  answer,
  ForgeTracker,
  settingsOf,
  trackerLabels,
} from "../stagecraft_tracker.ts";
import { repoUnitsEnsure } from "../units.ts";

const FORGE = "http://127.0.0.1:13000";
const tokenFile = new URL("./.work/tokens/admin", import.meta.url);

async function forgeUp(): Promise<string> {
  let token: string;
  try {
    token = (await Deno.readTextFile(tokenFile)).trim();
    const r = await fetch(`${FORGE}/api/v1/version`);
    await r.body?.cancel();
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
  } catch (e) {
    throw new Error(
      `test:live needs the forge: run smoke/forge.sh up first (${
        e instanceof Error ? e.message : String(e)
      })`,
    );
  }
  return token;
}
const TOKEN = await forgeUp();
const G = { apiUrl: FORGE, token: TOKEN };
const real = fetchCaller(G);
const admin = (method: ApiCall["method"], path: string, body?: unknown) =>
  call(real, { method, path, body });

/**
 * The real transport, except for calls `match` picks: those get `fault`,
 * which may call the forge itself (through `real`) and change its answer.
 */
function inject(
  match: (c: ApiCall) => boolean,
  fault: (c: ApiCall) => Promise<ApiResult>,
  times = Infinity,
): { api: Caller; hits: () => number } {
  let hits = 0;
  const api: Caller = (c) => {
    if (hits < times && match(c)) {
      hits++;
      return fault(c);
    }
    return real(c);
  };
  return { api, hits: () => hits };
}
const is = (method: string, re: RegExp) => (c: ApiCall) =>
  c.method === method && re.test(c.path);
const status = (s: number, message: string) => () =>
  Promise.resolve({ status: s, body: { message } });

/** Replace globalThis.fetch for the URLs `match` picks; the rest is real. */
async function withFetch<T>(
  match: (url: string) => boolean,
  fault: (url: string, init?: RequestInit) => Promise<Response>,
  body: () => Promise<T>,
): Promise<T> {
  const original = globalThis.fetch;
  globalThis.fetch = ((input: string | URL | Request, init?: RequestInit) => {
    const url = String(input instanceof Request ? input.url : input);
    return match(url) ? fault(url, init) : original(input, init);
  }) as typeof fetch;
  try {
    return await body();
  } finally {
    globalThis.fetch = original;
  }
}

/** A fetch that never answers, and gives up only when aborted. */
const never = (_url: string, init?: RequestInit) =>
  new Promise<Response>((_resolve, reject) => {
    init?.signal?.addEventListener(
      "abort",
      () => reject(new DOMException("aborted", "AbortError")),
    );
  });

const suffix = () => crypto.randomUUID().slice(0, 8);

/** A throwaway repository of fxorg with one commit, removed afterwards. */
async function withRepo<T>(
  prefix: string,
  body: (name: string) => Promise<T>,
): Promise<T> {
  const name = `${prefix}-${suffix()}`;
  await admin("POST", "/api/v1/orgs/fxorg/repos", {
    name,
    auto_init: true,
    default_branch: "main",
    private: false,
  });
  try {
    return await body(name);
  } finally {
    await real({ method: "DELETE", path: `/api/v1/repos/fxorg/${name}` });
  }
}

/** A minimal swamp method context; the methods' output is read back from it. */
function ctx(globalArgs: Record<string, unknown>) {
  const written: { spec: string; name: string; data: unknown }[] = [];
  return {
    written,
    context: {
      globalArgs,
      logger: { info: () => {} },
      writeResource: (spec: string, name: string, data: unknown) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}

// ───── the transport ─────

Deno.test("a request the forge never answers is aborted at httpTimeoutMs, in both transports", async () => {
  await withFetch((u) => u.endsWith("/api/v1/version"), never, async () => {
    const t0 = Date.now();
    await assertRejects(
      () =>
        fetchCaller({ ...G, httpTimeoutMs: 300 })({
          method: "GET",
          path: "/api/v1/version",
        }),
      DOMException,
    );
    const { context } = ctx({ ...G, httpTimeoutMs: 300 });
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => model.methods.health.execute({}, context as any),
      DOMException,
    );
    assert(Date.now() - t0 < 3000, "the timeout did not cut the wait");
    // every other call still reaches the forge
    const me = await real({ method: "GET", path: "/api/v1/user" });
    assertEquals(me.body.login, "fxadmin");
  });
});

Deno.test("a forge that does not answer is an upstream answer from the tracker, never a throw", async () => {
  await withFetch((u) => u.includes("/issues/"), never, async () => {
    const s = settingsOf({
      ...G,
      httpTimeoutMs: 300,
      owner: "fxorg",
      repo: "tickets",
    });
    const a = await answer(
      new ForgeTracker(fetchCaller({ ...G, httpTimeoutMs: 300 }), s),
      "fetch_issue",
      { issue: "1" },
    );
    assertEquals(a.ok ? "ok" : a.kind, "upstream");
  });
});

Deno.test("a redirect elsewhere is named, and a token in its Location is masked", async () => {
  await withFetch(
    (u) => u.endsWith("/api/v1/user"),
    () =>
      Promise.resolve(
        new Response(null, {
          status: 302,
          headers: { location: `https://login.example.com/?t=${TOKEN}` },
        }),
      ),
    async () => {
      const r = await real({ method: "GET", path: "/api/v1/user" });
      assertEquals(r.status, 302);
      assertEquals(
        r.body.message,
        "the forge redirects /api/v1/user to https://login.example.com/?t=[REDACTED]; " +
          "apiUrl must be the address the forge answers on, redirects are not followed",
      );
      const check = await checks.checks[0]["forgejo-token-accepted"].execute({
        globalArgs: G,
      });
      assertEquals(check.pass, false);
      assertEquals(JSON.stringify(check).includes(TOKEN), false);
    },
  );
});

Deno.test("the token check fails a 403 that names no scope, and names the forge's answer", async () => {
  await withFetch(
    (u) => u.endsWith("/api/v1/user"),
    () =>
      Promise.resolve(
        new Response(JSON.stringify({ message: "forbidden by policy" }), {
          status: 403,
        }),
      ),
    async () => {
      const r = await checks.checks[0]["forgejo-token-accepted"].execute({
        globalArgs: G,
      });
      assertEquals(r.pass, false);
      assertStringIncludes(JSON.stringify(r), "HTTP 403: forbidden by policy");
    },
  );
});

// ───── the tracker ─────

async function tracker(repo: string, api: Caller) {
  const s = settingsOf({ ...G, owner: "fxorg", repo });
  await labelEnsure(real, {
    owner: "fxorg",
    name: repo,
    labels: trackerLabels(s),
    prune: false,
  });
  return new ForgeTracker(api, s);
}

Deno.test("the tracker answers a 429 as rate_limited", async () => {
  await withRepo("fault-tk", async (repo) => {
    const n = (await admin("POST", `/api/v1/repos/fxorg/${repo}/issues`, {
      title: "x",
    })).body.number;
    const f = inject(
      is("GET", new RegExp(`/issues/${n}$`)),
      status(429, "slow down"),
    );
    const a = await answer(await tracker(repo, f.api), "fetch_issue", {
      issue: String(n),
    });
    assertEquals(a.ok ? "ok" : a.kind, "rate_limited");
    assertEquals(f.hits(), 1);
  });
});

Deno.test("a relate that wrote one body and failed on the other is repaired on the retry", async () => {
  await withRepo("fault-tk", async (repo) => {
    const plain = await tracker(repo, real);
    const c1 = await answer(plain, "create", {
      title: "parent",
      body: "",
      type: "bug",
    });
    const c2 = await answer(plain, "create", {
      title: "child",
      body: "",
      type: "bug",
    });
    assert(c1.ok && c2.ok);
    const [p, c] = [String(c1.result.id), String(c2.result.id)];
    // the write of the second body fails once, with the forge's 500
    const f = inject(
      is("PATCH", new RegExp(`/issues/${c}$`)),
      status(500, "the database went away"),
      1,
    );
    const t = await tracker(repo, f.api);
    const first = await answer(t, "relate", {
      issue: p,
      type: "parent_of",
      to: c,
    });
    assertEquals(first.ok ? "ok" : first.kind, "upstream");
    const body = async (n: string) =>
      String(
        (await admin("GET", `/api/v1/repos/fxorg/${repo}/issues/${n}`)).body
          .body,
      );
    assertStringIncludes(await body(p), `Parent of: #${c}`);
    assertEquals((await body(c)).includes("Child of"), false);
    const retry = await answer(t, "relate", {
      issue: p,
      type: "parent_of",
      to: c,
    });
    assertEquals(retry.ok, true);
    assertStringIncludes(await body(c), `Child of: #${p}`);
    assertEquals((await body(p)).split(`Parent of: #${c}`).length, 2);
  });
});

Deno.test("create answers from the forge's reply, so a failing read after it files nothing twice", async () => {
  await withRepo("fault-tk", async (repo) => {
    const f = inject(
      is("GET", /\/issues\/\d+(\/.*)?$/),
      status(500, "read failed"),
    );
    const a = await answer(await tracker(repo, f.api), "create", {
      title: "once",
      body: "",
      type: "bug",
    });
    assertEquals(a.ok, true);
    const all = (await admin(
      "GET",
      `/api/v1/repos/fxorg/${repo}/issues?state=all&type=issues`,
    )).body as unknown as unknown[];
    assertEquals(all.length, 1);
  });
});

// ───── answers the forge gives only when it misbehaves ─────

Deno.test("merge settings: a change accepted and not applied, another moved, pull requests turned off, a setting not reported", async () => {
  await withRepo("fault-ms", async (repo) => {
    const path = `/api/v1/repos/fxorg/${repo}`;
    const a = { owner: "fxorg", name: repo };
    const current = async () =>
      (await admin("GET", path)).body as Record<string, unknown>;
    const reply =
      (change: (b: Record<string, unknown>) => void) => async () => {
        const b = await current();
        change(b);
        return { status: 200, body: b };
      };
    const patch = (c: ApiCall) => c.method === "PATCH" && c.path === path;
    // the PATCH is answered, never sent: the forge stays as it is
    const before = await current();
    await assertRejects(
      () =>
        repoMergeSettingsEnsure(inject(patch, reply(() => {})).api, {
          ...a,
          allowSquashMerge: !before.allow_squash_merge,
        }),
      Error,
      "the forge accepted the change but did not apply allowSquashMerge",
    );
    await assertRejects(
      () =>
        repoMergeSettingsEnsure(
          inject(
            patch,
            reply((b) => {
              b.allow_squash_merge = !before.allow_squash_merge;
              b.allow_rebase = !before.allow_rebase;
            }),
          ).api,
          { ...a, allowSquashMerge: !before.allow_squash_merge },
        ),
      Error,
      "the forge also changed allowRebase",
    );
    await assertRejects(
      () =>
        repoMergeSettingsEnsure(
          inject(
            patch,
            reply((b) => {
              b.allow_squash_merge = !before.allow_squash_merge;
              b.has_pull_requests = false;
            }),
          ).api,
          { ...a, allowSquashMerge: !before.allow_squash_merge },
        ),
      Error,
      "the forge turned pull requests off",
    );
    const unreported = inject(
      (c) => c.path === path,
      async (c) => {
        const r = c.method === "GET" ? await real(c) : await real({
          method: "GET",
          path,
        });
        delete r.body.ignore_whitespace_conflicts;
        return r;
      },
    );
    const read = await repoMergeSettingsEnsure(unreported.api, a);
    assertEquals(read.ignoreWhitespaceConflicts, null);
    await assertRejects(
      () =>
        repoMergeSettingsEnsure(unreported.api, {
          ...a,
          ignoreWhitespaceConflicts: true,
        }),
      Error,
      "did not apply ignoreWhitespaceConflicts",
    );
    assertEquals(
      (await current()).allow_squash_merge,
      before.allow_squash_merge,
    );
  });
});

Deno.test("units: a change the forge accepts but does not apply is an error", async () => {
  await withRepo("fault-units", async (repo) => {
    const path = `/api/v1/repos/fxorg/${repo}`;
    const f = inject(
      (c) => c.method === "PATCH" && c.path === path,
      () => real({ method: "GET", path }),
    );
    const before = (await admin("GET", path)).body.has_projects;
    await assertRejects(
      () =>
        repoUnitsEnsure(f.api, {
          owner: "fxorg",
          name: repo,
          hasProjects: !before,
        }),
      Error,
      "the forge accepted the change but did not apply hasProjects",
    );
  });
});

Deno.test("pr_merge_state: a merged pull request without a merge commit is an error", async () => {
  await withRepo("fault-pr", async (repo) => {
    const r = `/api/v1/repos/fxorg/${repo}`;
    await admin("POST", `${r}/contents/x.txt`, {
      content: btoa("x"),
      message: "x",
      branch: "main",
      new_branch: "feat/x",
    });
    const n = (await admin("POST", `${r}/pulls`, {
      head: "feat/x",
      base: "main",
      title: "x",
    })).body.number as number;
    for (let i = 0; i < 20; i++) {
      const res = await real({
        method: "POST",
        path: `${r}/pulls/${n}/merge`,
        body: { Do: "merge" },
      });
      if (res.status < 300) break;
      await new Promise((ok) => setTimeout(ok, 500));
    }
    const a = { owner: "fxorg", name: repo, index: n };
    const merged = await prMergeState(real, a);
    assertEquals(merged.merged, true);
    const f = inject(is("GET", new RegExp(`/pulls/${n}$`)), async (c) => {
      const res = await real(c);
      delete res.body.merge_commit_sha;
      return res;
    });
    await assertRejects(
      () => prMergeState(f.api, a),
      Error,
      `#${n} is merged but reports no merge commit`,
    );
  });
});

Deno.test("org_delete: a failed listing and a refused delete leave the organization", async () => {
  const org = `fault-org-${suffix()}`;
  await admin("POST", "/api/v1/orgs", { username: org });
  try {
    const listing = inject(
      is("GET", new RegExp(`/orgs/${org}/repos`)),
      status(500, "listing failed"),
    );
    await assertRejects(
      () => orgDelete(listing.api, { name: org }),
      Error,
      "HTTP 500: listing failed",
    );
    const refused = inject(
      is("DELETE", new RegExp(`/orgs/${org}$`)),
      status(403, "not yours to delete"),
    );
    await assertRejects(
      () => orgDelete(refused.api, { name: org }),
      Error,
      "HTTP 403: not yours to delete",
    );
    assertEquals(
      (await real({ method: "GET", path: `/api/v1/orgs/${org}` })).status,
      200,
    );
  } finally {
    await real({ method: "DELETE", path: `/api/v1/orgs/${org}` });
  }
});

Deno.test("push_mirror_ensure: a 500 on queueing the first push still records the mirror, created", async () => {
  await withRepo("fault-push", async (repo) => {
    const f = inject(
      is("POST", /\/push_mirrors-sync$/),
      status(500, "error occurred when syncing push mirror"),
    );
    const warnings: string[] = [];
    const m = await pushMirrorEnsure(f.api, {
      owner: "fxorg",
      name: repo,
      remoteAddress: "http://localhost:3000/fxorg/nowhere.git",
      remoteUsername: "x",
      remotePassword: "FIXTURE-SECRET-push-fault",
      interval: "0s",
      syncOnCommit: false,
      syncNow: true,
    }, (w) => warnings.push(w));
    assertEquals([m.action, m.syncQueued], ["created", false]);
    assertEquals(warnings.length, 1);
    assertEquals(f.hits(), 1);
    const listed = (await admin(
      "GET",
      `/api/v1/repos/fxorg/${repo}/push_mirrors`,
    )).body as unknown as unknown[];
    assertEquals(listed.length, 1);
  });
});

Deno.test("pull_mirror_ensure: a migration error that quotes the source token is masked", async () => {
  const secret = `FIXTURE-SECRET-migrate-${suffix()}`;
  const f = inject(
    is("POST", /\/repos\/migrate$/),
    status(422, `clone of http://x:${secret}@localhost/a.git failed`),
  );
  const e = await assertRejects(
    () =>
      pullMirrorEnsure(f.api, {
        owner: "fxorg",
        name: `fault-pm-${suffix()}`,
        cloneAddr: "http://localhost:3000/fxorg/app.git",
        authToken: secret,
      }),
    Error,
    "HTTP 422",
  );
  assertEquals(e.message.includes(secret), false);
  assertStringIncludes(e.message, "[REDACTED]");
});

Deno.test("listIssues: an answer that is not a list yields nothing rather than failing", async () => {
  const f = inject(
    is("GET", /\/repos\/fxorg\/app\/issues\?/),
    () => Promise.resolve({ status: 200, body: { message: "odd" } }),
  );
  await admin("POST", "/api/v1/repos/fxorg/app/issues", { title: "listed" });
  assertEquals(await listIssues(f.api, "fxorg", "app", "all"), []);
  // and the same call, not injected, reads the forge's issues
  assert((await listIssues(real, "fxorg", "app", "all")).length > 0);
});
