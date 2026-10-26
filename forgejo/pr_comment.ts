/**
 * Adds to `@dataverket/forgejo` a pull request's discussion: `pr_comment`
 * posts a comment (Forgejo treats PR comments as issue comments), and
 * `pr_feedback` reads back the comments, the reviews with their state, and
 * each review's inline comments, so feedback given in the forge reaches a
 * workflow from the forge's API rather than from someone's memory.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { call, type Caller, fetchCaller, type GlobalArgs } from "./api.ts";

const enc = encodeURIComponent;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");
const repoPath = (owner: string, repo: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}`;

const PrArgs = {
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  index: z.coerce.number().int().positive().describe(
    "PR number within the repo.",
  ),
};

const PrCommentArgs = z.object({
  ...PrArgs,
  body: z.string().min(1).describe("Comment text (Markdown)."),
});
/** {@link PrCommentArgs} */
export type PrCommentArgsT = z.infer<typeof PrCommentArgs>;

const PrCommentInfo = z.object({
  repo: z.string(),
  index: z.number().int(),
  commentId: z.number().int(),
  url: z.string(),
  action: z.literal("created"),
  timestamp: z.string(),
});
/** {@link PrCommentInfo} */
export type PrComment = z.infer<typeof PrCommentInfo>;

const PrFeedbackArgs = z.object(PrArgs);
/** {@link PrFeedbackArgs} */
export type PrFeedbackArgsT = z.infer<typeof PrFeedbackArgs>;

const Note = z.object({
  kind: z.enum(["comment", "review", "inline"]),
  author: z.string(),
  body: z.string(),
  state: z.string().optional().describe(
    "Review state, e.g. APPROVED or REQUEST_CHANGES",
  ),
  path: z.string().optional(),
  line: z.number().int().optional(),
  createdAt: z.string(),
});

const PrFeedbackInfo = z.object({
  repo: z.string(),
  index: z.number().int(),
  notes: z.array(Note),
  timestamp: z.string(),
});
/** {@link PrFeedbackInfo} */
export type PrFeedback = z.infer<typeof PrFeedbackInfo>;

type Raw = Record<string, unknown>;
const login = (r: Raw) =>
  String(((r.user ?? r.poster ?? {}) as Raw).login ?? "");

async function list(api: Caller, path: string): Promise<Raw[]> {
  const r = await call(api, { method: "GET", path });
  const body: unknown = r.body;
  return Array.isArray(body)
    ? body.filter((x): x is Raw => !!x && typeof x === "object")
    : [];
}

/** Read the PR's comments, reviews and inline review comments. */
export async function prFeedback(
  api: Caller,
  a: PrFeedbackArgsT,
): Promise<PrFeedback> {
  const base = repoPath(a.owner, a.name);
  const notes: z.infer<typeof Note>[] = [];
  for (const c of await list(api, `${base}/issues/${a.index}/comments`)) {
    notes.push({
      kind: "comment",
      author: login(c),
      body: String(c.body ?? ""),
      createdAt: String(c.created_at ?? ""),
    });
  }
  for (const r of await list(api, `${base}/pulls/${a.index}/reviews`)) {
    notes.push({
      kind: "review",
      author: login(r),
      body: String(r.body ?? ""),
      state: String(r.state ?? ""),
      createdAt: String(r.submitted_at ?? ""),
    });
    const path = `${base}/pulls/${a.index}/reviews/${r.id}/comments`;
    for (const c of await list(api, path)) {
      notes.push({
        kind: "inline",
        author: login(c),
        body: String(c.body ?? ""),
        path: String(c.path ?? ""),
        line: Number(c.position ?? c.original_position ?? 0) || undefined,
        createdAt: String(c.created_at ?? ""),
      });
    }
  }
  return {
    repo: `${a.owner}/${a.name}`,
    index: a.index,
    notes,
    timestamp: new Date().toISOString(),
  };
}

/** Post one comment on the PR; every call posts a new one. */
export async function prComment(
  api: Caller,
  a: PrCommentArgsT,
): Promise<PrComment> {
  const r = await call(api, {
    method: "POST",
    path: `${repoPath(a.owner, a.name)}/issues/${a.index}/comments`,
    body: { body: a.body },
  });
  return {
    repo: `${a.owner}/${a.name}`,
    index: a.index,
    commentId: Number(r.body.id ?? 0),
    url: String(r.body.html_url ?? ""),
    action: "created",
    timestamp: new Date().toISOString(),
  };
}

interface Ctx {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/** Extension adding a pull request's comments and feedback. */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    prFeedback: {
      description:
        "Comments, reviews and inline review comments on a pull request.",
      schema: PrFeedbackInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    prComment: {
      description: "A comment posted on a pull request.",
      schema: PrCommentInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    pr_feedback: {
      description:
        "Read a pull request's discussion from the server: comments, reviews (with state) and inline review comments. Read-only.",
      arguments: PrFeedbackArgs,
      execute: async (args: PrFeedbackArgsT, context: Ctx) => {
        const a = PrFeedbackArgs.parse(args);
        context.logger.info("Reading the discussion on {repo}#{index}", {
          repo: `${a.owner}/${a.name}`,
          index: a.index,
        });
        const info = await prFeedback(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info("{repo}#{index}: {count} notes", {
          repo: info.repo,
          index: info.index,
          count: info.notes.length,
        });
        const handle = await context.writeResource(
          "prFeedback",
          safeName(`${info.repo}#${info.index}:feedback`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
    pr_comment: {
      description:
        "Post a comment on a pull request. Not idempotent: every call posts a new comment.",
      arguments: PrCommentArgs,
      execute: async (args: PrCommentArgsT, context: Ctx) => {
        const a = PrCommentArgs.parse(args);
        context.logger.info("Commenting on {repo}#{index}", {
          repo: `${a.owner}/${a.name}`,
          index: a.index,
        });
        const info = await prComment(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info("Commented on {repo}#{index}: {url}", {
          repo: info.repo,
          index: info.index,
          url: info.url,
        });
        const handle = await context.writeResource(
          "prComment",
          safeName(`${info.repo}#${info.index}:comment:${info.commentId}`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
