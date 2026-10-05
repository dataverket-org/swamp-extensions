/**
 * Adds to `@thomas/forgejo` a repository's issues: `issue_ensure`, which
 * files the issues given unless an issue of the same title already exists,
 * and `issue_list`. Upstream has no method for issues.
 *
 * The title is the identity. An issue is searched for by its title, in any
 * state, and matched on the exact title, so a rerun files nothing twice and a
 * closed issue is reported rather than reopened. Several issues go in one
 * call, so a batch takes the model's lock once. Labels are named; every name
 * must exist on the repository or its organization before anything is filed.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type ApiCall,
  call,
  type Caller,
  fetchCaller,
  type GlobalArgs,
} from "./api.ts";

import { labelsForIssues } from "./labels.ts";

export type { ApiCall, Caller };

const enc = encodeURIComponent;
const issuesPath = (owner: string, repo: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}/issues`;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");

const PAGE = 50;
const MAX_PAGES = 20;
const MAX_ISSUES_PER_CALL = 20;

/** One issue of a repository as recorded after `issue_ensure` or `issue_list`. */
const IssueInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  url: z.string().describe("The issue's page on the forge"),
  labels: z.array(z.string()).describe("Label names, as created or as found"),
  action: z.enum(["created", "unchanged", "listed"]),
  timestamp: z.string(),
});
/** {@link IssueInfo} */
export type Issue = z.infer<typeof IssueInfo>;

const IssueSpec = z.object({
  title: z.string().trim().min(1).max(255).describe(
    "The title; the identity a rerun matches on.",
  ),
  body: z.string().default("").describe("Markdown body."),
  labels: z.array(z.string().trim().min(1)).default([]).describe(
    "Label names the issue carries when created; each must exist on the repository or its organization.",
  ),
});

const IssueEnsureArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  issues: z.array(IssueSpec).min(1).max(MAX_ISSUES_PER_CALL).describe(
    "The issues to file. One with an existing issue's exact title, open or closed, is left as it is.",
  ),
}).refine(
  (a) => new Set(a.issues.map((i) => i.title)).size === a.issues.length,
  { message: "two issues in one call carry the same title" },
);
/** {@link IssueEnsureArgs} */
export type IssueEnsureArgsT = z.infer<typeof IssueEnsureArgs>;

const IssueListArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  state: z.enum(["open", "closed", "all"]).default("open").describe(
    "Which issues to list.",
  ),
});
/** {@link IssueListArgs} */
export type IssueListArgsT = z.infer<typeof IssueListArgs>;

interface RawIssue {
  number: number;
  title: string;
  state: "open" | "closed";
  url: string;
  labels: string[];
}

function rawIssue(x: unknown): RawIssue | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  if (
    typeof o.number !== "number" || typeof o.title !== "string" ||
    (o.state !== "open" && o.state !== "closed")
  ) return undefined;
  const labels = Array.isArray(o.labels)
    ? (o.labels as unknown[]).flatMap((l) =>
      l && typeof l === "object" &&
        typeof (l as Record<string, unknown>).name === "string"
        ? [(l as Record<string, unknown>).name as string]
        : []
    )
    : [];
  return {
    number: o.number,
    title: o.title,
    state: o.state,
    url: typeof o.html_url === "string" ? o.html_url : "",
    labels,
  };
}

/**
 * The repository's issues in the given state, every page, optionally
 * narrowed by Forgejo's search string. Pull requests are excluded.
 */
export async function listIssues(
  api: Caller,
  owner: string,
  repo: string,
  state: "open" | "closed" | "all",
  q?: string,
): Promise<RawIssue[]> {
  const out: RawIssue[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const query = `state=${state}&type=issues&limit=${PAGE}&page=${page}` +
      (q ? `&q=${enc(q)}` : "");
    const r = await call(api, {
      method: "GET",
      path: `${issuesPath(owner, repo)}?${query}`,
    });
    const items = Array.isArray(r.body) ? r.body as unknown[] : [];
    for (const it of items) {
      const i = rawIssue(it);
      if (i) out.push(i);
    }
    if (items.length < PAGE) break;
  }
  return out;
}

/** File each issue whose exact title no issue of the repository has yet. */
export async function issueEnsure(
  api: Caller,
  a: IssueEnsureArgsT,
): Promise<Issue[]> {
  const parsed = IssueEnsureArgs.parse(a);
  const wanted = [...new Set(parsed.issues.flatMap((i) => i.labels))];
  const ids = new Map<string, number>();
  if (wanted.length > 0) {
    for (const l of await labelsForIssues(api, parsed.owner, parsed.name)) {
      if (!ids.has(l.name)) ids.set(l.name, l.id);
    }
    const missing = wanted.filter((n) => !ids.has(n));
    if (missing.length > 0) {
      throw new Error(
        `label(s) ${missing.map((n) => JSON.stringify(n)).join(", ")} ` +
          `exist neither on ${parsed.owner}/${parsed.name} nor on ${parsed.owner}; ` +
          "label_ensure makes them",
      );
    }
  }
  const results: Issue[] = [];
  for (const spec of parsed.issues) {
    const timestamp = new Date().toISOString();
    const found =
      (await listIssues(api, parsed.owner, parsed.name, "all", spec.title))
        .find((i) => i.title === spec.title);
    if (found) {
      results.push({
        owner: parsed.owner,
        repo: parsed.name,
        number: found.number,
        title: found.title,
        state: found.state,
        url: found.url,
        labels: found.labels,
        action: "unchanged",
        timestamp,
      });
      continue;
    }
    const r = await call(api, {
      method: "POST",
      path: issuesPath(parsed.owner, parsed.name),
      body: {
        title: spec.title,
        body: spec.body,
        labels: spec.labels.map((n) => ids.get(n)!),
      },
    });
    const made = rawIssue(r.body);
    if (!made) {
      throw new Error(
        `Forgejo answered the create of "${spec.title}" without an issue number`,
      );
    }
    results.push({
      owner: parsed.owner,
      repo: parsed.name,
      number: made.number,
      title: made.title,
      state: made.state,
      url: made.url,
      labels: made.labels,
      action: "created",
      timestamp,
    });
  }
  return results;
}

interface Ctx {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

async function record(context: Ctx, issues: Issue[]) {
  const handles = [];
  for (const i of issues) {
    context.logger.info("Issue #{number} of {repo}: {action}: {title}", {
      number: i.number,
      repo: `${i.owner}/${i.repo}`,
      action: i.action,
      title: i.title,
    });
    handles.push(
      await context.writeResource(
        "issue",
        safeName(`${i.owner}:${i.repo}:issue:${i.number}`),
        i,
      ),
    );
  }
  return { dataHandles: handles };
}

/** Extension adding issues to @thomas/forgejo. */
export const extension = {
  type: "@thomas/forgejo",
  resources: {
    issue: {
      description:
        "One issue of a repository: number, title, state and page, and whether issue_ensure created it or found it.",
      schema: IssueInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    issue_ensure: {
      description:
        "File the issues given, each unless an issue of the same exact title exists, open or closed. " +
        "Several in one call; one record per issue saying whether it was created or already there.",
      arguments: IssueEnsureArgs,
      execute: async (args: IssueEnsureArgsT, context: Ctx) => {
        const issues = await issueEnsure(
          fetchCaller(context.globalArgs, context.signal),
          args,
        );
        return await record(context, issues);
      },
    },
    issue_list: {
      description:
        "The issues of a repository in the given state, every page, pull requests excluded. Read-only.",
      arguments: IssueListArgs,
      execute: async (args: IssueListArgsT, context: Ctx) => {
        const a = IssueListArgs.parse(args);
        const timestamp = new Date().toISOString();
        const issues = (await listIssues(
          fetchCaller(context.globalArgs, context.signal),
          a.owner,
          a.name,
          a.state,
        )).map((i): Issue => ({
          owner: a.owner,
          repo: a.name,
          number: i.number,
          title: i.title,
          state: i.state,
          url: i.url,
          labels: i.labels,
          action: "listed",
          timestamp,
        }));
        return await record(context, issues);
      },
    },
  }],
};
