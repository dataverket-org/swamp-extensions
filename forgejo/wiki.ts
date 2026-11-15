/**
 * Adds to `@dataverket/forgejo` a repository's wiki pages: one read back with
 * its content, and one converged to the content given. Upstream has no
 * method for the wiki, and the wiki is where a repository's working notes
 * live before they become documentation, so a rewrite of such a page from
 * a file is a method and not a `git push` to the wiki repository.
 *
 * A page is addressed by its title, as the wiki shows it. Forgejo stores a
 * page under a path made from the title (`a b` becomes `a-b`; a title that
 * holds both dashes and spaces is percent-escaped and given a `.-` suffix),
 * and its page endpoints take that path, not the title: proven 2026-11-14 on
 * Forgejo 15, `wiki/page/ceph-rdb-risc-v-dpu-card` is a 404 while the listed
 * `sub_url` `ceph-rdb+risc-v+dpu+card.-` is the page. So this module never
 * computes a path: it lists the wiki's pages, matches the title, and uses the
 * `sub_url` Forgejo lists, verbatim, in every page request.
 *
 * A wiki with no such page is told apart from a repository that is not there
 * (the forge's 404) and from a wiki unit that is off, on that path only.
 *
 * `wiki_page_ensure` is idempotent on content: a page that already holds
 * the given bytes is left alone, with no new wiki commit. Nothing is
 * deleted; a page is only created or rewritten. The record carries the
 * content's size and hash, and after `wiki_page_get` the content itself.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type ApiCall,
  type ApiResult,
  call,
  type Caller,
  callerOf,
  type ClientContext,
  isFailure,
} from "./api.ts";
import { dataName, writeRecord } from "./names.ts";

export type { ApiCall, Caller };

const enc = encodeURIComponent;
const LIST_LIMIT = 50;
/** `subUrl` is what Forgejo listed, already escaped, so it goes in as is. */
const pagePath = (owner: string, repo: string, subUrl: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}/wiki/page/${subUrl}`;
const newPath = (owner: string, repo: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}/wiki/new`;
const listPath = (owner: string, repo: string, page: number) =>
  `/api/v1/repos/${enc(owner)}/${
    enc(repo)
  }/wiki/pages?page=${page}&limit=${LIST_LIMIT}`;

/** UTF-8 text to base64, as Forgejo's `content_base64` wants it. */
export function toBase64(text: string): string {
  const bytes = new TextEncoder().encode(text);
  let bin = "";
  for (const b of bytes) bin += String.fromCharCode(b);
  return btoa(bin);
}

/** Forgejo's `content_base64` back to UTF-8 text. */
export function fromBase64(b64: string): string {
  const bin = atob(b64);
  const bytes = Uint8Array.from(bin, (c) => c.charCodeAt(0));
  return new TextDecoder().decode(bytes);
}

/** SHA-256 of the UTF-8 bytes, hex; what two versions of a page compare by. */
export async function sha256(text: string): Promise<string> {
  const digest = await crypto.subtle.digest(
    "SHA-256",
    new TextEncoder().encode(text),
  );
  return Array.from(new Uint8Array(digest))
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");
}

/** The wiki page's last commit as Forgejo reports it, when it does. */
const WikiCommitInfo = z.object({
  sha: z.string(),
  date: z.string(),
  message: z.string(),
}).nullable();

/** A wiki page after `wiki_page_get` or `wiki_page_ensure`. */
const WikiPageInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  title: z.string().describe("The title Forgejo shows"),
  subUrl: z.string().describe(
    "The path segment Forgejo stores the page under, as it lists it",
  ),
  htmlUrl: z.string(),
  action: z.enum(["observed", "created", "updated", "unchanged"]),
  bytes: z.number().int().describe("UTF-8 size of the content"),
  contentSha256: z.string().describe("SHA-256 of the content, hex"),
  previousSha256: z.string().nullable().describe(
    "After wiki_page_ensure: SHA-256 of what the page held before, null when it did not exist",
  ),
  content: z.string().nullable().describe(
    "After wiki_page_get: the page's markdown; null after wiki_page_ensure, whose input is the content",
  ),
  commitCount: z.number().int().nullable(),
  lastCommit: WikiCommitInfo,
  message: z.string().nullable().describe(
    "The wiki commit message written, when a commit was",
  ),
  timestamp: z.string(),
});
/** {@link WikiPageInfo} */
export type WikiPage = z.infer<typeof WikiPageInfo>;

const PageRef = {
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  page: z.string().min(1).describe(
    "The page's title, as the wiki shows it, e.g. 'Home' or 'Design notes'.",
  ),
};

const WikiPageGetArgs = z.object(PageRef);
/** {@link WikiPageGetArgs} */
export type WikiPageGetArgsT = z.infer<typeof WikiPageGetArgs>;

const WikiPageEnsureArgs = z.object({
  ...PageRef,
  content: z.string().describe(
    "The whole page, markdown, UTF-8. On the CLI, @<path> reads it from a file: --input content=@page.md",
  ),
  message: z.string().optional().describe(
    "The wiki commit message. Default: 'Add <title>' or 'Update <title>'.",
  ),
});
/** {@link WikiPageEnsureArgs} */
export type WikiPageEnsureArgsT = z.infer<typeof WikiPageEnsureArgs>;

interface RawPage {
  title: string;
  subUrl: string;
  htmlUrl: string;
  content: string;
  commitCount: number | null;
  lastCommit: z.infer<typeof WikiCommitInfo>;
}

function parsePage(r: ApiResult): RawPage {
  const b = r.body;
  const lc = b.last_commit as Record<string, unknown> | undefined;
  const author = lc?.author as Record<string, unknown> | undefined;
  return {
    title: String(b.title ?? ""),
    subUrl: String(b.sub_url ?? ""),
    htmlUrl: String(b.html_url ?? ""),
    content: typeof b.content_base64 === "string"
      ? fromBase64(b.content_base64)
      : "",
    commitCount: typeof b.commit_count === "number" ? b.commit_count : null,
    lastCommit: lc
      ? {
        sha: String(lc.sha ?? ""),
        date: String(author?.date ?? ""),
        message: String(lc.message ?? ""),
      }
      : null,
  };
}

/** Every page of the wiki, title and the `sub_url` Forgejo stores it under. */
export async function listPages(
  api: Caller,
  owner: string,
  repo: string,
): Promise<{ title: string; subUrl: string }[]> {
  const out: { title: string; subUrl: string }[] = [];
  for (let n = 1;; n++) {
    const c: ApiCall = { method: "GET", path: listPath(owner, repo, n) };
    const r = await api(c);
    // a repository whose wiki is off or empty answers 404 to the listing
    if (r.status === 404) return out;
    if (isFailure(r.status)) await call(api, c);
    const items = Array.isArray(r.body) ? r.body as unknown[] : [];
    for (const it of items) {
      const o = it as Record<string, unknown>;
      out.push({
        title: String(o.title ?? ""),
        subUrl: String(o.sub_url ?? ""),
      });
    }
    if (items.length < LIST_LIMIT) return out;
  }
}

/**
 * The `sub_url` of the page titled `page`: an exact title match first, else
 * the one match ignoring case; null when the wiki has no such page.
 */
export async function resolveSubUrl(
  api: Caller,
  owner: string,
  repo: string,
  page: string,
): Promise<string | null> {
  const pages = await listPages(api, owner, repo);
  const exact = pages.find((p) => p.title === page);
  if (exact) return exact.subUrl;
  const loose = pages.filter(
    (p) => p.title.toLowerCase() === page.toLowerCase(),
  );
  return loose.length === 1 ? loose[0].subUrl : null;
}

/** The page, or null when Forgejo has no page of that title. */
export async function readPage(
  api: Caller,
  owner: string,
  repo: string,
  page: string,
): Promise<RawPage | null> {
  const subUrl = await resolveSubUrl(api, owner, repo, page);
  if (subUrl === null) return null;
  const r = await call(api, {
    method: "GET",
    path: pagePath(owner, repo, subUrl),
  });
  const p = parsePage(r);
  return { ...p, subUrl: p.subUrl || subUrl };
}

/**
 * Why a wiki has no such page: the repository is not there (the forge's own
 * 404, through call), its wiki unit is off, or the page is simply absent.
 * Asked only on the not-found path, so a hit costs no extra request.
 */
export async function noPageError(
  api: Caller,
  owner: string,
  repo: string,
  page: string,
): Promise<Error> {
  const r = await call(api, {
    method: "GET",
    path: `/api/v1/repos/${enc(owner)}/${enc(repo)}`,
  });
  if (r.body.has_wiki === false) {
    return new Error(`the wiki of ${owner}/${repo} is off (has_wiki=false)`);
  }
  return new Error(
    `${owner}/${repo} has no wiki page titled ${JSON.stringify(page)}`,
  );
}

/** Read one wiki page with its content. */
export async function wikiPageGet(
  api: Caller,
  a: WikiPageGetArgsT,
): Promise<WikiPage> {
  const p = await readPage(api, a.owner, a.name, a.page);
  if (p === null) throw await noPageError(api, a.owner, a.name, a.page);
  return {
    owner: a.owner,
    repo: a.name,
    title: p.title,
    subUrl: p.subUrl,
    htmlUrl: p.htmlUrl,
    action: "observed",
    bytes: new TextEncoder().encode(p.content).length,
    contentSha256: await sha256(p.content),
    previousSha256: null,
    content: p.content,
    commitCount: p.commitCount,
    lastCommit: p.lastCommit,
    message: null,
    timestamp: new Date().toISOString(),
  };
}

/** Create the page, or rewrite it when its content differs; else leave it. */
export async function wikiPageEnsure(
  api: Caller,
  a: WikiPageEnsureArgsT,
): Promise<WikiPage> {
  const have = await readPage(api, a.owner, a.name, a.page);
  const wantSha = await sha256(a.content);
  const base = {
    owner: a.owner,
    repo: a.name,
    bytes: new TextEncoder().encode(a.content).length,
    contentSha256: wantSha,
    content: null,
    timestamp: new Date().toISOString(),
  };
  if (have === null) {
    // a missing repository or a wiki that is off is named before any write
    const why = await noPageError(api, a.owner, a.name, a.page);
    if (!why.message.includes("has no wiki page")) throw why;
    const message = a.message ?? `Add ${a.page}`;
    const r = await call(api, {
      method: "POST",
      path: newPath(a.owner, a.name),
      body: { title: a.page, content_base64: toBase64(a.content), message },
    });
    const p = parsePage(r);
    return {
      ...base,
      title: p.title || a.page,
      subUrl: p.subUrl,
      htmlUrl: p.htmlUrl,
      action: "created",
      previousSha256: null,
      commitCount: p.commitCount,
      lastCommit: p.lastCommit,
      message,
    };
  }
  const haveSha = await sha256(have.content);
  if (haveSha === wantSha) {
    return {
      ...base,
      title: have.title,
      subUrl: have.subUrl,
      htmlUrl: have.htmlUrl,
      action: "unchanged",
      previousSha256: haveSha,
      commitCount: have.commitCount,
      lastCommit: have.lastCommit,
      message: null,
    };
  }
  const message = a.message ?? `Update ${have.title || a.page}`;
  const r = await call(api, {
    method: "PATCH",
    path: pagePath(a.owner, a.name, have.subUrl),
    body: { title: a.page, content_base64: toBase64(a.content), message },
  });
  const p = parsePage(r);
  return {
    ...base,
    title: p.title || have.title,
    subUrl: p.subUrl || have.subUrl,
    htmlUrl: p.htmlUrl || have.htmlUrl,
    action: "updated",
    previousSha256: haveSha,
    commitCount: p.commitCount,
    lastCommit: p.lastCommit,
    message,
  };
}

interface Ctx extends ClientContext {
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

async function record(context: Ctx, info: WikiPage) {
  const name = dataName("wiki", info.owner, info.repo, info.title);
  return await writeRecord(context, "wikiPage", name, name, info);
}

/** Extension adding wiki pages. */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    wikiPage: {
      description:
        "A wiki page after wiki_page_get (with its content) or wiki_page_ensure (what changed).",
      schema: WikiPageInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    wiki_page_get: {
      description:
        "Read one wiki page of a repository by its title, with its markdown content and last commit. Read-only.",
      arguments: WikiPageGetArgs,
      execute: async (args: WikiPageGetArgsT, context: Ctx) => {
        const a = WikiPageGetArgs.parse(args);
        const info = await wikiPageGet(callerOf(context), a);
        context.logger.info(
          "Wiki page {page} of {repo}: {bytes} bytes, {commits} commits",
          {
            page: info.title,
            repo: `${info.owner}/${info.repo}`,
            bytes: info.bytes,
            commits: info.commitCount ?? "?",
          },
        );
        const handle = await record(context, info);
        return { dataHandles: [handle] };
      },
    },
    wiki_page_ensure: {
      description:
        "Create a wiki page or rewrite it to the content given; a page already holding that content is left alone. " +
        "Idempotent on content; never deletes a page.",
      arguments: WikiPageEnsureArgs,
      execute: async (args: WikiPageEnsureArgsT, context: Ctx) => {
        const a = WikiPageEnsureArgs.parse(args);
        const info = await wikiPageEnsure(callerOf(context), a);
        context.logger.info(
          "Wiki page {page} of {repo}: {action} ({bytes} bytes)",
          {
            page: info.title,
            repo: `${info.owner}/${info.repo}`,
            action: info.action,
            bytes: info.bytes,
          },
        );
        const handle = await record(context, info);
        return { dataHandles: [handle] };
      },
    },
  }],
};
