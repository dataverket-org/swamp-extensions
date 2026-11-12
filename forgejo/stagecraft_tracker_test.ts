import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { harness, writes } from "./stub_test.ts";
import {
  description,
  joinBody,
  kindOf,
  model,
  settingsOf,
  splitBody,
  trackerLabels,
} from "./stagecraft_tracker.ts";

const OWNER = "acme";
const REPO = "work";

const settings = (extra: Record<string, unknown> = {}) =>
  settingsOf({
    apiUrl: "https://forge.example",
    token: "t0ken-planted-xyz",
    owner: OWNER,
    repo: REPO,
    ...extra,
  });

// ───── settings and describe ─────

Deno.test("the defaults are the four statuses, four types and four severities", () => {
  const s = settings();
  assertEquals(s.tracker, "forgejo");
  assertEquals(s.statuses.map((x) => x.name), [
    "new",
    "in-progress",
    "shipped",
    "closed",
  ]);
  assertEquals(s.types.map((x) => x.name), [
    "feature",
    "bug",
    "security",
    "finding",
  ]);
  assertEquals(s.severities.map((x) => x.name), [
    "low",
    "medium",
    "high",
    "critical",
  ]);
});
Deno.test("settings whose first status is closed, or with a duplicate, are refused", () => {
  assertEquals(
    model.globalArguments.safeParse({
      apiUrl: "x",
      token: "y",
      owner: "o",
      repo: "r",
      statuses: [
        { name: "done", state: "closed", color: "#000000" },
        { name: "open", state: "open", color: "#000000" },
      ],
    }).success,
    false,
  );
  assertEquals(
    model.globalArguments.safeParse({
      apiUrl: "x",
      token: "y",
      owner: "o",
      repo: "r",
      types: [{ name: "bug", color: "#000000" }, {
        name: "bug",
        color: "#111111",
      }],
    }).success,
    false,
  );
});
Deno.test("describe says contract 1, origin snapshot, no capabilities", () => {
  assertEquals(description(settings({ tracker: "forge-x" })), {
    tracker: "forge-x",
    contract: 1,
    origin: "snapshot",
    capabilities: { history: false, assign: false, pullRequests: false },
    closesDuplicates: false,
  });
});
Deno.test("the tracker's labels are exclusive and scoped", () => {
  const ls = trackerLabels(settings());
  assertEquals(ls.length, 12);
  assert(
    ls.every((l) => l.exclusive && /^(status|type|severity)\//.test(l.name)),
  );
  assertEquals(ls[0], {
    name: "status/new",
    color: "#bfd4f2",
    description: "A ticket nobody has started",
    exclusive: true,
  });
});

// ───── fetch_issue ─────

// ───── create ─────

// ───── comment ─────

// ───── set_status ─────

// ───── relations ─────
Deno.test("the block survives a person's edit above it and holds several relations", () => {
  const body = joinBody("Text", [
    { type: "related_to", direction: "outgoing", issue: 9 },
    { type: "parent_of", direction: "incoming", issue: 3 },
  ]);
  const edited = body.replace("Text", "Text, edited\n\nmore");
  assertEquals(splitBody(edited).text, "Text, edited\n\nmore");
  assertEquals(splitBody(edited).relations.length, 2);
  assertEquals(joinBody("Text", []), "Text");
  assertEquals(splitBody("no block").relations, []);
});

// ───── operate's answers ─────
Deno.test("HTTP refusals map to the contract's kinds", () => {
  assertEquals(
    [401, 403, 404, 429, 400, 409, 422, 500, 502].map(kindOf),
    [
      "auth",
      "auth",
      "not_found",
      "rate_limited",
      "invalid",
      "invalid",
      "invalid",
      "upstream",
      "upstream",
    ],
  );
});

// ───── the methods as swamp runs them ─────

function ctx(
  globalArgs: Record<string, unknown>,
  prior?: Record<string, unknown>,
) {
  const written: {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  const logged: unknown[] = [];
  return {
    written,
    logged,
    context: {
      globalArgs,
      logger: {
        info: (m: string, p?: Record<string, unknown>) => logged.push([m, p]),
      },
      writeResource: (
        spec: string,
        name: string,
        data: Record<string, unknown>,
      ) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
      readResource: (_name: string) => Promise.resolve(prior ?? null),
    },
  };
}

const GLOBALS = {
  apiUrl: "https://forge.example",
  token: "t0ken-planted-xyz",
  owner: OWNER,
  repo: REPO,
};
Deno.test("operate answers settings that do not parse, rather than throwing", async () => {
  const c = ctx({ apiUrl: "x" });
  await model.methods.operate.execute({
    operation: "fetch_issue",
    request: { issue: "1" },
    answer: "answer-s",
  }, c.context);
  assertEquals(c.written[0].data.ok, false);
  assertEquals(c.written[0].data.kind, "invalid");
});
Deno.test("describe writes the description record", async () => {
  const c = ctx(GLOBALS);
  await model.methods.describe.execute({}, c.context);
  assertEquals(c.written[0].spec, "description");
  assertEquals(c.written[0].name, "description");
  assertEquals(c.written[0].data.tracker, "forgejo");
});

// ───── what the first review found ─────

Deno.test("text that quotes the block's start marker above the block is kept as text", () => {
  const quoted =
    "Notes: `<!-- stagecraft-relations: kept by the tracker -->` is ours.";
  const body = joinBody(quoted, [
    { type: "related_to", direction: "outgoing", issue: 4 },
  ]);
  const { text, relations } = splitBody(body);
  assertEquals(text, quoted);
  assertEquals(relations.length, 1);
});
Deno.test("operate refuses to run without readResource rather than skip the first rule", async () => {
  const c = ctx(GLOBALS);
  const context = { ...c.context, readResource: undefined };
  await assertRejects(
    () =>
      model.methods.operate.execute({
        operation: "fetch_issue",
        request: { issue: "1" },
        answer: "answer-r",
      }, context),
    Error,
    "no readResource",
  );
  assertEquals(c.written, []);
});
Deno.test("a status name too long for the forge's label is refused in the settings", () => {
  const long = "a".repeat(41);
  assertEquals(
    model.globalArguments.safeParse({
      ...GLOBALS,
      types: [{ name: long, color: "#000000" }],
    }).success,
    false,
  );
});

// ───── the methods, through createModelTestContext with a stub client ─────

const B = `/api/v1/repos/${OWNER}/${REPO}`;
const TG = { ...GLOBALS, httpTimeoutMs: 1000 };
const labelsOf = (names: string[]) =>
  names.map((name, i) => ({ id: i + 1, name, color: "000000" }));

Deno.test("describe refuses settings that do not parse, writing nothing", async () => {
  const h = harness({}, { globalArgs: { apiUrl: "x" } });
  await assertRejects(() => model.methods.describe.execute({}, h.context));
  assertEquals(h.written(), []);
});

Deno.test("operate files an issue in the first status and writes the answer under the name given", async () => {
  const h = harness({
    [`GET ${B}/labels?limit=50&page=1`]: {
      status: 200,
      body: labelsOf(["status/new", "type/bug"]),
    },
    [`GET /api/v1/orgs/${OWNER}`]: { status: 404 },
    [`POST ${B}/issues`]: {
      status: 201,
      body: {
        number: 5,
        title: "x",
        body: "",
        state: "open",
        labels: [{ id: 1, name: "status/new" }],
      },
    },
  }, { globalArgs: TG });
  await model.methods.operate.execute({
    operation: "create",
    request: { title: "x", body: "", type: "bug" },
    answer: "answer-c1",
    run: "r1",
  }, h.context);
  assertEquals(writes(h.calls).map((c) => c.body), [{
    title: "x",
    body: "",
    labels: [1, 2],
  }]);
  const w = h.written()[0];
  assertEquals([w.spec, w.name, w.data.ok, w.data.run], [
    "answer",
    "answer-c1",
    true,
    "r1",
  ]);
  assertEquals((w.data.result as { id: string }).id, "5");
});

Deno.test("operate writes a refusal as an answer of its kind, never a throw", async () => {
  const h = harness({
    [`GET ${B}/issues/9`]: {
      status: 404,
      body: { message: "issue does not exist" },
    },
  }, { globalArgs: TG });
  await model.methods.operate.execute({
    operation: "fetch_issue",
    request: { issue: "9" },
    answer: "answer-f1",
  }, h.context);
  const d = h.written()[0].data;
  assertEquals([d.ok, d.kind], [false, "not_found"]);
});

Deno.test("labels records the scheme in label_ensure's form and calls no forge", async () => {
  const h = harness({}, { globalArgs: TG });
  await model.methods.labels.execute({}, h.context);
  assertEquals(h.calls, []);
  const w = h.written()[0];
  assertEquals([w.spec, w.name], ["trackerLabels", "tracker-labels"]);
  assertEquals([w.data.owner, w.data.repo], [OWNER, REPO]);
  const labels = w.data.labels as {
    name: string;
    color: string;
    description: string;
    exclusive: boolean;
  }[];
  assertEquals(labels.length, 12);
  assert(labels.every((l) => l.exclusive && /^#[0-9a-f]{6}$/i.test(l.color)));
  assertEquals(labels[0].name, "status/new");
});

Deno.test("labels refuses settings that do not parse, writing nothing", async () => {
  const h = harness({}, { globalArgs: { apiUrl: "x" } });
  await assertRejects(() => model.methods.labels.execute({}, h.context));
  assertEquals(h.written(), []);
});

/** The reads one ticket takes: the issue, its dependency lists and comments. */
function ticketRoutes(
  n: number,
  body: string,
  opts: { depsOff?: boolean } = {},
) {
  const list = opts.depsOff
    ? { status: 404, body: { message: "dependencies are disabled" } }
    : { status: 200, body: [] };
  return {
    [`GET ${B}/issues/${n}`]: {
      status: 200,
      body: {
        number: n,
        title: `t${n}`,
        body,
        state: "open",
        labels: [],
        assignees: [],
        pull_request: null,
      },
    },
    [`GET ${B}/issues/${n}/dependencies?limit=50&page=1`]: list,
    [`GET ${B}/issues/${n}/blocks?limit=50&page=1`]: list,
    [`GET ${B}/issues/${n}/comments`]: { status: 200, body: [] },
  };
}

const block = (line: string) =>
  `x\n\n<!-- stagecraft-relations: kept by the tracker -->\n${line}\n<!-- /stagecraft-relations -->`;

Deno.test("repairing a half-written parent_of checks the rules first: a child that got another parent meanwhile is refused", async () => {
  // #2 holds "Parent of: #3" from a relate that failed on #3; meanwhile #4
  // became #3's parent.
  const h = harness({
    ...ticketRoutes(2, block("Parent of: #3")),
    ...ticketRoutes(3, block("Child of: #4")),
    ...ticketRoutes(4, block("Parent of: #3")),
  }, { globalArgs: TG });
  await model.methods.operate.execute({
    operation: "relate",
    request: { issue: "2", type: "parent_of", to: "3" },
    answer: "answer-r1",
  }, h.context);
  const d = h.written()[0].data;
  assertEquals([d.ok, d.kind], [false, "invalid"]);
  assert(String(d.detail).includes("has a parent already"), String(d.detail));
  assertEquals(writes(h.calls), []);
});

Deno.test("blocked_by on a repository with issue dependencies off is invalid, not not_found", async () => {
  const h = harness({
    ...ticketRoutes(2, "", { depsOff: true }),
    ...ticketRoutes(3, "", { depsOff: true }),
    [`POST ${B}/issues/2/dependencies`]: {
      status: 404,
      body: { message: "dependencies are disabled" },
    },
  }, { globalArgs: TG });
  await model.methods.operate.execute({
    operation: "relate",
    request: { issue: "2", type: "blocked_by", to: "3" },
    answer: "answer-r2",
  }, h.context);
  const d = h.written()[0].data;
  assertEquals([d.ok, d.kind], [false, "invalid"]);
  assert(
    String(d.detail).includes("dependencies switched off"),
    String(d.detail),
  );
});

Deno.test("repairing a half-written parent_of never completes a loop: an inverse relation written meanwhile is refused", async () => {
  // #2 holds "Parent of: #3" from a relate that failed on #3; meanwhile
  // "#3 parent_of #2" was written in full.
  const h = harness({
    ...ticketRoutes(2, block("Parent of: #3\nChild of: #3")),
    ...ticketRoutes(3, block("Parent of: #2")),
  }, { globalArgs: TG });
  await model.methods.operate.execute({
    operation: "relate",
    request: { issue: "2", type: "parent_of", to: "3" },
    answer: "answer-r3",
  }, h.context);
  const d = h.written()[0].data;
  assertEquals([d.ok, d.kind], [false, "invalid"]);
  assertEquals(writes(h.calls), []);
});

Deno.test("repairing a half-written duplicate_of never makes two tickets duplicates of each other", async () => {
  const h = harness({
    ...ticketRoutes(2, block("Duplicate of: #3\nDuplicated by: #3")),
    ...ticketRoutes(3, block("Duplicate of: #2")),
  }, { globalArgs: TG });
  await model.methods.operate.execute({
    operation: "relate",
    request: { issue: "2", type: "duplicate_of", to: "3" },
    answer: "answer-r4",
  }, h.context);
  const d = h.written()[0].data;
  assertEquals([d.ok, d.kind], [false, "invalid"]);
  assertEquals(writes(h.calls), []);
});
