/**
 * Adds `pr_merge_state` to `@dataverket/forgejo`: a pull request's head and,
 * once merged, the merge commit, time and merger, which `pr_get` leaves out.
 * A software factory records its merge evidence from this. Note that Forgejo
 * reports the head branch's current commit, not the commit that was merged:
 * compare the merge commit's tree when that matters.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { call, type Caller, fetchCaller, type GlobalArgs } from "./api.ts";

const enc = encodeURIComponent;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");

const PrMergeStateArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  index: z.coerce.number().int().positive().describe(
    "PR number within the repo.",
  ),
});
/** {@link PrMergeStateArgs} */
export type PrMergeStateArgsT = z.infer<typeof PrMergeStateArgs>;

const PrMergeStateInfo = z.object({
  repo: z.string(),
  index: z.number().int(),
  url: z.string(),
  state: z.string(),
  merged: z.boolean(),
  headSha: z.string().describe(
    "The head branch's commit now, which is not necessarily what was merged.",
  ),
  base: z.string(),
  mergeSha: z.string().optional().describe(
    "The commit on the base branch; present only once merged.",
  ),
  mergedAt: z.string().optional(),
  mergedBy: z.string().optional(),
  action: z.literal("observed"),
  timestamp: z.string(),
});
/** {@link PrMergeStateInfo} */
export type PrMergeState = z.infer<typeof PrMergeStateInfo>;

type Raw = Record<string, unknown>;

/** Read the PR and, once merged, its merge commit, time and merger. */
export async function prMergeState(
  api: Caller,
  a: PrMergeStateArgsT,
): Promise<PrMergeState> {
  const r = await call(api, {
    method: "GET",
    path: `/api/v1/repos/${enc(a.owner)}/${enc(a.name)}/pulls/${a.index}`,
  });
  const pr = r.body;
  const head = (pr.head ?? {}) as Raw;
  const base = (pr.base ?? {}) as Raw;
  const mergedBy = (pr.merged_by ?? {}) as Raw;
  const merged = pr.merged === true;
  const mergeSha =
    typeof pr.merge_commit_sha === "string" && pr.merge_commit_sha
      ? pr.merge_commit_sha
      : undefined;
  if (merged && !mergeSha) {
    throw new Error(
      `${a.owner}/${a.name}#${a.index} is merged but reports no merge commit`,
    );
  }
  return {
    repo: `${a.owner}/${a.name}`,
    index: a.index,
    url: String(pr.html_url ?? ""),
    state: String(pr.state ?? ""),
    merged,
    headSha: String(head.sha ?? ""),
    base: String(base.ref ?? ""),
    mergeSha: merged ? mergeSha : undefined,
    mergedAt: merged && typeof pr.merged_at === "string"
      ? pr.merged_at
      : undefined,
    mergedBy: merged && typeof mergedBy.login === "string"
      ? mergedBy.login
      : undefined,
    action: "observed",
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

/** Extension adding a pull request's merge state. */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    prMergeState: {
      description:
        "A pull request's head and, once merged, its merge commit, time, and merger.",
      schema: PrMergeStateInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    pr_merge_state: {
      description:
        "Read a pull request's merge state from the server: its head, and once merged the merge commit, time and merger. Read-only.",
      arguments: PrMergeStateArgs,
      execute: async (args: PrMergeStateArgsT, context: Ctx) => {
        const a = PrMergeStateArgs.parse(args);
        context.logger.info("Reading the merge state of {repo}#{index}", {
          repo: `${a.owner}/${a.name}`,
          index: a.index,
        });
        const info = await prMergeState(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info("{repo}#{index}: {state}, merged {merged}", {
          repo: info.repo,
          index: info.index,
          state: info.state,
          merged: info.merged,
        });
        const handle = await context.writeResource(
          "prMergeState",
          safeName(`${info.repo}#${info.index}:merge`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
