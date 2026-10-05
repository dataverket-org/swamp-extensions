import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { DEFAULT_HTTP_TIMEOUT_MS, model, resolveTimeoutMs } from "./forgejo.ts";
import { extension as actions } from "./actions.ts";
import { extension as checks } from "./checks.ts";
import { extension as issues } from "./issues.ts";
import { extension as labels } from "./labels.ts";
import { extension as orgDelete } from "./org_delete.ts";
import { extension as prAssign } from "./pr_assign.ts";
import { extension as pullMirror } from "./pull_mirror.ts";
import { extension as pushMirror } from "./push_mirror.ts";
import { extension as repoDelete } from "./repo_delete.ts";
import { extension as topics } from "./topics.ts";
import { extension as units } from "./units.ts";

/** The upstream base, as forked: every method @thomas/forgejo 2026.09.04.2 had. */
const BASE_METHODS = [
  "health",
  "org_list",
  "repo_list",
  "user_list",
  "mirror_status",
  "webhook_audit",
  "webhook_retarget",
  "org_ensure",
  "repo_ensure",
  "collaborator_ensure",
  "branch_protection_ensure",
  "branch_protection_list",
  "mirror_ensure",
  "mirror_sync_now",
  "pr_list",
  "pr_get",
  "pr_ensure",
  "pr_merge",
  "repo_archive",
  "repo_unarchive",
];

/** The former add-ons, now methods of the same type. */
const ADDED_METHODS = [
  "actions_secret_put",
  "runner_registration_token",
  "runner_list",
  "runner_prune",
  "repo_rename",
  "pull_mirror_ensure",
  "repo_topics_ensure",
  "repo_units_ensure",
  "push_mirror_ensure",
  "push_mirror_list",
  "push_mirror_delete",
  "push_mirror_sync_now",
  "user_search",
  "pr_assign",
  "repo_delete",
  "org_delete",
  "issue_ensure",
  "issue_labels_ensure",
  "issue_list",
  "label_ensure",
  "label_list",
];

const MODULES = [
  actions,
  checks,
  issues,
  labels,
  orgDelete,
  prAssign,
  pullMirror,
  pushMirror,
  repoDelete,
  topics,
  units,
];

Deno.test("the base owns the dataverket type at the published version", () => {
  assertEquals(model.type, "@dataverket/forgejo");
  assertEquals(model.version, "2026.10.05.4");
});

Deno.test("the upgrade chain ends at the model's version and is a no-op", () => {
  const last = model.upgrades.at(-1)!;
  assertEquals(last.toVersion, model.version);
  const args = { apiUrl: "https://forge.example.com", token: "t" };
  assertEquals(last.upgradeAttributes(args), args);
});

Deno.test("every upstream method is still there, and nothing else", () => {
  assertEquals(Object.keys(model.methods).sort(), [...BASE_METHODS].sort());
});

Deno.test("every module targets the dataverket type", () => {
  for (const m of MODULES) assertEquals(m.type, "@dataverket/forgejo");
});

Deno.test("the add-on methods are all present once, and none shadows the base", () => {
  const names = MODULES.flatMap((m) =>
    (m.methods as Record<string, unknown>[]).flatMap((group) =>
      Object.keys(group)
    )
  );
  assertEquals([...names].sort(), [...ADDED_METHODS].sort());
  const clash = names.filter((n) => n in model.methods);
  assertEquals(clash, []);
});

Deno.test("upstream's reachable check is gone; the two of checks.ts remain", () => {
  assertEquals("checks" in model, false);
  const names = checks.checks.flatMap((group) => Object.keys(group));
  assertEquals(names.sort(), [
    "forgejo-api-url-shape",
    "forgejo-token-accepted",
  ]);
});

Deno.test("resolveTimeoutMs keeps a positive number and falls back otherwise", () => {
  assertEquals(resolveTimeoutMs(5000), 5000);
  assertEquals(resolveTimeoutMs("5000"), 5000);
  for (const bad of [undefined, null, 0, -1, NaN, "", "soon", {}]) {
    assertEquals(resolveTimeoutMs(bad), DEFAULT_HTTP_TIMEOUT_MS);
  }
});

/** A fetch that refuses an already-aborted request and waits a tick first. */
function fetchExpectingLiveSignal(
  answer: (url: string) => Response,
): { fetch: typeof fetch; urls: string[] } {
  const urls: string[] = [];
  const fake = async (
    input: string | URL | Request,
    init?: RequestInit,
  ): Promise<Response> => {
    const url = String(input);
    urls.push(url);
    const signal = init?.signal;
    if (signal?.aborted) throw new Error(`aborted before send: ${url}`);
    // upstream's bug: setTimeout(abort, undefined) fires on the next turn
    await new Promise((r) => setTimeout(r, 5));
    if (signal?.aborted) throw new Error(`aborted while waiting: ${url}`);
    return answer(url);
  };
  return { fetch: fake as typeof fetch, urls };
}

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

Deno.test("a method run with httpTimeoutMs absent does not abort its own request", async () => {
  const original = globalThis.fetch;
  const { fetch, urls } = fetchExpectingLiveSignal((url) =>
    url.endsWith("/api/v1/version")
      ? new Response(JSON.stringify({ version: "9.0.0" }), { status: 200 })
      : new Response("ok", { status: 200 })
  );
  globalThis.fetch = fetch;
  try {
    const args = { apiUrl: "https://forge.example.com", token: "t" };
    assertEquals(Object.hasOwn(args, "httpTimeoutMs"), false);
    const { written, context } = ctx(args);
    // deno-lint-ignore no-explicit-any
    const r = await model.methods.health.execute({}, context as any);
    assertEquals(r.dataHandles.length, 1);
    assertEquals(urls, [
      "https://forge.example.com/api/v1/version",
      "https://forge.example.com/api/healthz",
    ]);
    const data = written[0].data as Record<string, unknown>;
    assertEquals(data.version, "9.0.0");
    assertEquals(data.healthy, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("a timeout that is given is honoured: a slow forge is aborted", async () => {
  const original = globalThis.fetch;
  globalThis.fetch =
    ((_input: unknown, init?: RequestInit) =>
      new Promise<Response>((_resolve, reject) => {
        init?.signal?.addEventListener(
          "abort",
          () => reject(new DOMException("aborted", "AbortError")),
        );
      })) as typeof fetch;
  try {
    const { context } = ctx({
      apiUrl: "https://forge.example.com",
      token: "t",
      httpTimeoutMs: 10,
    });
    await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => model.methods.health.execute({}, context as any),
      DOMException,
    );
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("a token the forge echoes back is masked before it can reach an error", async () => {
  const original = globalThis.fetch;
  const token = "s3cret-token-value";
  globalThis.fetch = (() =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          message: `access token does not exist [sha: ${token}]`,
        }),
        { status: 401 },
      ),
    )) as typeof fetch;
  try {
    const { context } = ctx({ apiUrl: "https://forge.example.com", token });
    const err = await assertRejects(
      // deno-lint-ignore no-explicit-any
      () => model.methods.health.execute({}, context as any),
      Error,
      "HTTP 401",
    );
    assertStringIncludes(err.message, "[REDACTED]");
    assertEquals(err.message.includes(token), false);
  } finally {
    globalThis.fetch = original;
  }
});
