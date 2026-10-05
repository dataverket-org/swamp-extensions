/**
 * Adds to `@dataverket/forgejo` a repository's topics, the labels Forgejo shows
 * on a repository and searches by (`upstream-mirror`, say). Upstream has no
 * method for them. Additive by default: the topics given are added and any
 * others are kept; `exact` makes the given list the whole set.
 *
 * Forgejo lowercases topics and allows letters, digits, `-` and `.`,
 * starting with a letter or digit, 35 characters at most and 25 per
 * repository. They are checked here first, so a bad topic is named in the
 * error rather than refused as a whole list.
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

export type { ApiCall, Caller };

const enc = encodeURIComponent;
const topicsPath = (owner: string, repo: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}/topics`;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");

const TOPIC = /^[a-z0-9][-.a-z0-9]{0,34}$/;
const MAX_TOPICS = 25;

/** A repository's topics after the call, and what changed. */
const RepoTopicsInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  topics: z.array(z.string()).describe("Every topic, sorted"),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  action: z.enum(["updated", "unchanged"]),
  timestamp: z.string(),
});
/** {@link RepoTopicsInfo} */
export type RepoTopics = z.infer<typeof RepoTopicsInfo>;

const RepoTopicsEnsureArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  topics: z.array(z.string()).describe(
    'Topics the repository must have, e.g. ["upstream-mirror"]. Lowercased before use.',
  ),
  exact: z.boolean().default(false).describe(
    "Make the list the whole set, removing any other topic. Off: other topics are kept.",
  ),
});
/** {@link RepoTopicsEnsureArgs} */
export type RepoTopicsEnsureArgsT = z.infer<typeof RepoTopicsEnsureArgs>;

/** Lowercased, trimmed and de-duplicated; throws naming every invalid topic. */
export function normalizeTopics(topics: string[]): string[] {
  const out = [...new Set(topics.map((t) => t.trim().toLowerCase()))];
  const bad = out.filter((t) => !TOPIC.test(t));
  if (bad.length > 0) {
    throw new Error(
      `invalid topic(s): ${bad.map((t) => JSON.stringify(t)).join(", ")}; ` +
        "letters, digits, - and . only, starting with a letter or digit, at most 35 characters",
    );
  }
  return out;
}

/** Add the given topics, or with `exact` set the whole list; write only on change. */
export async function repoTopicsEnsure(
  api: Caller,
  a: RepoTopicsEnsureArgsT,
): Promise<RepoTopics> {
  const want = normalizeTopics(a.topics);
  const path = topicsPath(a.owner, a.name);
  const r = await call(api, { method: "GET", path });
  const have = Array.isArray(r.body.topics)
    ? (r.body.topics as unknown[]).map(String)
    : [];
  const next = a.exact ? want : [...new Set([...have, ...want])];
  if (next.length > MAX_TOPICS) {
    throw new Error(
      `${a.owner}/${a.name} would have ${next.length} topics; Forgejo allows ${MAX_TOPICS}`,
    );
  }
  const added = next.filter((t) => !have.includes(t)).sort();
  const removed = have.filter((t) => !next.includes(t)).sort();
  const base = {
    owner: a.owner,
    repo: a.name,
    topics: [...next].sort(),
    added,
    removed,
    timestamp: new Date().toISOString(),
  };
  if (added.length === 0 && removed.length === 0) {
    return { ...base, topics: [...have].sort(), action: "unchanged" };
  }
  await call(api, { method: "PUT", path, body: { topics: next } });
  return { ...base, action: "updated" };
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

/** Extension adding repository topics. */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    repoTopics: {
      description:
        "A repository's topics after repo_topics_ensure, and which were added or removed.",
      schema: RepoTopicsInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    repo_topics_ensure: {
      description:
        "Ensure a repository has the given topics (Forgejo's repository labels). Additive by default; exact=true " +
        "makes the list the whole set. Writes only when something changes.",
      arguments: RepoTopicsEnsureArgs,
      execute: async (args: RepoTopicsEnsureArgsT, context: Ctx) => {
        const a = RepoTopicsEnsureArgs.parse(args);
        const info = await repoTopicsEnsure(
          fetchCaller(context.globalArgs, context.signal),
          a,
        );
        context.logger.info(
          "Topics of {repo}: {action} (+{added} -{removed})",
          {
            repo: `${info.owner}/${info.repo}`,
            action: info.action,
            added: info.added.join(","),
            removed: info.removed.join(","),
          },
        );
        const handle = await context.writeResource(
          "repoTopics",
          safeName(`${info.owner}:${info.repo}:topics`),
          info,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
