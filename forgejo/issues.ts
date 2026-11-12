/**
 * Adds to `@dataverket/forgejo` a repository's issues: `issue_ensure`, which
 * files the issues given unless an issue of the same title already exists,
 * `issue_labels_ensure` and `issue_list`. Upstream has no method for issues.
 *
 * The title is the identity. An issue is searched for by its title, in any
 * state, and matched on the exact title, so a rerun files nothing twice and a
 * closed issue is reported rather than reopened. Several issues go in one
 * call, so a batch takes the model's lock once. Labels are named; every name
 * must exist on the repository or its organization before anything is filed.
 * `issue_labels_ensure` labels an existing issue or pull request by number.
 *
 * `issue_state_ensure` opens or closes issues with a comment saying why, and
 * `issue_body_ensure` rewrites an issue's text; both read every issue first
 * and refuse a pull request's number before anything is written. Their names
 * and arguments are those of the local extension they were folded in from.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type ApiCall,
  call,
  type Caller,
  callerOf,
  type GlobalArgs,
} from "./api.ts";

import { labelsForIssues } from "./labels.ts";
import { dataName, legacyName, repoName, writeRecord } from "./names.ts";

export type { ApiCall, Caller };

const enc = encodeURIComponent;
const issuesPath = (owner: string, repo: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}/issues`;

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

const IssueLabelsEnsureArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  number: z.number().int().positive().describe(
    "The issue's or pull request's number; Forgejo numbers both in one sequence.",
  ),
  labels: z.array(z.string().trim().min(1)).min(1).describe(
    "Label names it must carry; each must exist on the repository or its organization.",
  ),
  exact: z.boolean().default(false).describe(
    "Make the list the whole set, removing any other label. Off: other labels are kept.",
  ),
});
/** {@link IssueLabelsEnsureArgs} */
export type IssueLabelsEnsureArgsT = z.infer<typeof IssueLabelsEnsureArgs>;

/** An issue's or pull request's labels after `issue_labels_ensure`. */
const IssueLabelsInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  number: z.number().int(),
  labels: z.array(z.string()).describe("Every label, sorted"),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  action: z.enum(["updated", "unchanged"]),
  timestamp: z.string(),
});
/** {@link IssueLabelsInfo} */
export type IssueLabels = z.infer<typeof IssueLabelsInfo>;

/** Resolve label names on the repository and its organization; refuse any that is missing. */
async function labelIds(
  api: Caller,
  owner: string,
  repo: string,
  names: string[],
): Promise<Map<string, number>> {
  const ids = new Map<string, number>();
  for (const l of await labelsForIssues(api, owner, repo)) {
    if (!ids.has(l.name)) ids.set(l.name, l.id);
  }
  const missing = names.filter((n) => !ids.has(n));
  if (missing.length > 0) {
    throw new Error(
      `label(s) ${missing.map((n) => JSON.stringify(n)).join(", ")} ` +
        `exist neither on ${owner}/${repo} nor on ${owner}; label_ensure makes them`,
    );
  }
  return ids;
}

/** Add the given labels to an issue or pull request, or with `exact` make them the whole set. */
export async function issueLabelsEnsure(
  api: Caller,
  a: IssueLabelsEnsureArgsT,
): Promise<IssueLabels> {
  const p = IssueLabelsEnsureArgs.parse(a);
  const want = [...new Set(p.labels)];
  const ids = await labelIds(api, p.owner, p.name, want);
  const path = `${issuesPath(p.owner, p.name)}/${p.number}/labels`;
  const r = await call(api, { method: "GET", path });
  const have = (Array.isArray(r.body) ? r.body as unknown[] : []).flatMap((l) =>
    l && typeof l === "object" &&
      typeof (l as Record<string, unknown>).name === "string"
      ? [(l as Record<string, unknown>).name as string]
      : []
  );
  const next = p.exact ? want : [...new Set([...have, ...want])];
  const added = next.filter((n) => !have.includes(n)).sort();
  const removed = have.filter((n) => !next.includes(n)).sort();
  const base = {
    owner: p.owner,
    repo: p.name,
    number: p.number,
    added,
    removed,
    timestamp: new Date().toISOString(),
  };
  if (added.length === 0 && removed.length === 0) {
    return { ...base, labels: [...have].sort(), action: "unchanged" };
  }
  if (p.exact) {
    await call(api, {
      method: "PUT",
      path,
      body: { labels: next.map((n) => ids.get(n)!) },
    });
  } else {
    await call(api, {
      method: "POST",
      path,
      body: { labels: added.map((n) => ids.get(n)!) },
    });
  }
  return { ...base, labels: [...next].sort(), action: "updated" };
}

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

/**
 * The repository's newest issues, one page, read without a search string.
 * Forgejo's `q` goes through its issue indexer, which catches up with a new
 * issue in the background, a second or so on a quiet forge; a listing without
 * `q` reads the database. So an issue filed moments ago, by the last run say,
 * is found here when the search does not have it yet.
 */
async function newestIssues(
  api: Caller,
  owner: string,
  repo: string,
): Promise<RawIssue[]> {
  const r = await call(api, {
    method: "GET",
    path: `${
      issuesPath(owner, repo)
    }?state=all&type=issues&sort=newest&limit=${PAGE}&page=1`,
  });
  const items = Array.isArray(r.body) ? r.body as unknown[] : [];
  return items.flatMap((it) => {
    const i = rawIssue(it);
    return i ? [i] : [];
  });
}

/** File each issue whose exact title no issue of the repository has yet. */
export async function issueEnsure(
  api: Caller,
  a: IssueEnsureArgsT,
): Promise<Issue[]> {
  const parsed = IssueEnsureArgs.parse(a);
  const wanted = [...new Set(parsed.issues.flatMap((i) => i.labels))];
  const ids = wanted.length > 0
    ? await labelIds(api, parsed.owner, parsed.name, wanted)
    : new Map<string, number>();
  const results: Issue[] = [];
  for (const spec of parsed.issues) {
    const timestamp = new Date().toISOString();
    const found =
      (await listIssues(api, parsed.owner, parsed.name, "all", spec.title))
        .find((i) => i.title === spec.title) ??
        (await newestIssues(api, parsed.owner, parsed.name))
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

// ─────────────────────── issue state and issue text ───────────────────────

const IssueStateEnsureArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  issues: z.array(z.object({
    number: z.number().int().positive().describe("The issue's number."),
    state: z.enum(["open", "closed"]).describe("The state it is to have."),
    comment: z.string().default("").describe(
      "Markdown posted on the issue before its state changes, saying why. Not posted when the state is already right.",
    ),
  })).min(1).max(MAX_ISSUES_PER_CALL).describe(
    "The issues and the state each is to have. Several in one call.",
  ),
});
/** {@link IssueStateEnsureArgs} */
export type IssueStateEnsureArgsT = z.infer<typeof IssueStateEnsureArgs>;

/** An issue's state after `issue_state_ensure`. */
const IssueStateInfo = z.object({
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  state: z.enum(["open", "closed"]),
  action: z.enum(["updated", "unchanged"]),
  timestamp: z.string(),
});
/** {@link IssueStateInfo} */
export type IssueState = z.infer<typeof IssueStateInfo>;

const IssueBodyEnsureArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  number: z.number().int().positive().describe("The issue's number."),
  body: z.string().min(1).describe(
    "The issue's whole text, in Markdown. It replaces the text that is there.",
  ),
});
/** {@link IssueBodyEnsureArgs} */
export type IssueBodyEnsureArgsT = z.infer<typeof IssueBodyEnsureArgs>;

/** Whether `issue_body_ensure` rewrote an issue's text; never the text. */
const IssueBodyInfo = z.object({
  repo: z.string(),
  number: z.number().int(),
  title: z.string(),
  action: z.enum(["updated", "unchanged"]),
  timestamp: z.string(),
});
/** {@link IssueBodyInfo} */
export type IssueBody = z.infer<typeof IssueBodyInfo>;

/** Read one issue, and refuse a number that is a pull request. */
async function readIssue(
  api: Caller,
  owner: string,
  repo: string,
  number: number,
): Promise<Record<string, unknown>> {
  const issue = (await call(api, {
    method: "GET",
    path: `${issuesPath(owner, repo)}/${number}`,
  })).body;
  if (issue.pull_request) {
    throw new Error(
      `#${number} of ${owner}/${repo} is a pull request, not an issue`,
    );
  }
  return issue;
}

/**
 * Open or close issues, each with a comment saying why. Every issue is read
 * before anything is written, so a pull request's number or a missing issue
 * anywhere in the list stops the call with nothing changed. One whose state
 * differs gets its comment, when there is one, and then the state; one that
 * already has the state is left alone and gets no comment.
 */
export async function issueStateEnsure(
  api: Caller,
  a: IssueStateEnsureArgsT,
): Promise<IssueState[]> {
  const p = IssueStateEnsureArgs.parse(a);
  const base = issuesPath(p.owner, p.name);
  const found: Record<string, unknown>[] = [];
  for (const want of p.issues) {
    found.push(await readIssue(api, p.owner, p.name, want.number));
  }
  const results: IssueState[] = [];
  for (const [i, want] of p.issues.entries()) {
    const changes = found[i].state !== want.state;
    if (changes) {
      if (want.comment !== "") {
        await call(api, {
          method: "POST",
          path: `${base}/${want.number}/comments`,
          body: { body: want.comment },
        });
      }
      await call(api, {
        method: "PATCH",
        path: `${base}/${want.number}`,
        body: { state: want.state },
      });
    }
    results.push({
      repo: `${p.owner}/${p.name}`,
      number: want.number,
      title: String(found[i].title ?? ""),
      state: want.state,
      action: changes ? "updated" : "unchanged",
      timestamp: new Date().toISOString(),
    });
  }
  return results;
}

/**
 * Give an issue the text given. One that already has it is left alone, and a
 * number that is a pull request is refused before anything is written. The
 * text is sent, never recorded.
 */
export async function issueBodyEnsure(
  api: Caller,
  a: IssueBodyEnsureArgsT,
): Promise<IssueBody> {
  const p = IssueBodyEnsureArgs.parse(a);
  const issue = await readIssue(api, p.owner, p.name, p.number);
  const changes = issue.body !== p.body;
  if (changes) {
    await call(api, {
      method: "PATCH",
      path: `${issuesPath(p.owner, p.name)}/${p.number}`,
      body: { body: p.body },
    });
  }
  return {
    repo: `${p.owner}/${p.name}`,
    number: p.number,
    title: String(issue.title ?? ""),
    action: changes ? "updated" : "unchanged",
    timestamp: new Date().toISOString(),
  };
}

interface Ctx {
  globalArgs: GlobalArgs;
  forgejoClient?: Caller;
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
      await writeRecord(
        context,
        "issue",
        dataName("issue", i.owner, i.repo, i.number),
        legacyName(`${i.owner}:${i.repo}:issue:${i.number}`),
        i,
      ),
    );
  }
  return { dataHandles: handles };
}

/** Extension adding issues. */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    issueState: {
      description:
        "An issue's state as issue_state_ensure last set or found it.",
      schema: IssueStateInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    issueBody: {
      description:
        "Whether issue_body_ensure last rewrote an issue's text or found it as given. The text is not kept.",
      schema: IssueBodyInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    issue: {
      description:
        "One issue of a repository: number, title, state and page, and whether issue_ensure created it or found it.",
      schema: IssueInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    issueLabels: {
      description:
        "An issue's or pull request's labels after issue_labels_ensure, and which were added or removed.",
      schema: IssueLabelsInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    issue_state_ensure: {
      description:
        "Open or close the issues given, each with a comment saying why. Several in one call. " +
        "An issue already in that state is left alone and gets no comment; a pull request's number is refused " +
        "before anything is written.",
      arguments: IssueStateEnsureArgs,
      execute: async (args: IssueStateEnsureArgsT, context: Ctx) => {
        const infos = await issueStateEnsure(
          callerOf(context),
          args,
        );
        const dataHandles = [];
        for (const info of infos) {
          context.logger.info("Issue #{number} of {repo}: {state}, {action}", {
            number: info.number,
            repo: info.repo,
            state: info.state,
            action: info.action,
          });
          const name = repoName("issue-state", info.repo, info.number);
          dataHandles.push(
            await writeRecord(context, "issueState", name, name, { ...info }),
          );
        }
        return { dataHandles };
      },
    },
    issue_body_ensure: {
      description:
        "Give one issue the text given, replacing what is there. An issue that already has it is left alone; " +
        "a pull request's number is refused before anything is written. The text is not recorded.",
      arguments: IssueBodyEnsureArgs,
      execute: async (args: IssueBodyEnsureArgsT, context: Ctx) => {
        const info = await issueBodyEnsure(
          callerOf(context),
          args,
        );
        context.logger.info("Issue #{number} of {repo}: text {action}", {
          number: info.number,
          repo: info.repo,
          action: info.action,
        });
        const name = repoName("issue-body", info.repo, info.number);
        const handle = await writeRecord(context, "issueBody", name, name, {
          ...info,
        });
        return { dataHandles: [handle] };
      },
    },
    issue_ensure: {
      description:
        "File the issues given, each unless an issue of the same exact title exists, open or closed. " +
        "Several in one call; one record per issue saying whether it was created or already there.",
      arguments: IssueEnsureArgs,
      execute: async (args: IssueEnsureArgsT, context: Ctx) => {
        const issues = await issueEnsure(
          callerOf(context),
          args,
        );
        return await record(context, issues);
      },
    },
    issue_labels_ensure: {
      description:
        "Ensure an issue or pull request carries the given labels, by name; additive unless exact. " +
        "Pull requests are issues to Forgejo, so this labels either by its number.",
      arguments: IssueLabelsEnsureArgs,
      execute: async (args: IssueLabelsEnsureArgsT, context: Ctx) => {
        const info = await issueLabelsEnsure(
          callerOf(context),
          args,
        );
        context.logger.info(
          "Labels of {repo}#{number}: {action} (+{added} -{removed})",
          {
            repo: `${info.owner}/${info.repo}`,
            number: info.number,
            action: info.action,
            added: info.added.join(","),
            removed: info.removed.join(","),
          },
        );
        const handle = await writeRecord(
          context,
          "issueLabels",
          dataName("issue-labels", info.owner, info.repo, info.number),
          legacyName(`${info.owner}:${info.repo}:issue:${info.number}:labels`),
          info,
        );
        return { dataHandles: [handle] };
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
          callerOf(context),
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
