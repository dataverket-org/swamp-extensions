/**
 * `@dataverket/github`: GitHub repositories, releases and pull requests for
 * swamp over the REST API, through Octokit.
 *
 * Forked from `@goodcraft/github` 2026.06.14.1 (MIT, copyright 2026
 * GoodCraft, https://github.com/nathanworking/swamp-github-manage) and
 * merged with what used to be the `@dataverket/github` add-on. This file is
 * the base model: a read-only `sync` that lists the owner's repositories and
 * proves the token, and three idempotent mutations, `ensureRepo`,
 * `ensureRelease` and `openPr`, each of which finds existing state first and
 * defaults to `dryRun: true` so a run plans before it writes. The method
 * names are upstream's, unchanged, so a definition or workflow written for
 * `@goodcraft/github` keeps working once its `type` is changed.
 *
 * `repo_settings.ts` adds branch listing, default-branch convergence, a
 * verify-first delete and a live pre-flight check to the same type.
 *
 * The API token is supplied through `globalArguments.token`, wired to a vault
 * expression at model-creation time, never a literal token. Set `isOrg: true`
 * when `owner` is an organization (changes the repo-create endpoint).
 *
 * @module
 */
import { z } from "npm:zod@4";
import { Octokit } from "npm:@octokit/rest@22.0.1";
import {
  buildRepoCreateParams,
  findOpenPull,
  findReleaseByTag,
  qualifiedHead,
  slug,
} from "./_lib/github_plan.ts";

const GlobalArgsSchema = z.object({
  /** GitHub API token. Supply via a vault expression, never inline. */
  token: z.string().min(1).meta({ sensitive: true }),
  /** Repository owner — the user or organization login that owns the repos. */
  owner: z.string().min(1),
  /** Set true when `owner` is an organization (changes the create endpoint). */
  isOrg: z.boolean().default(false),
  /** API base URL (override only for GitHub Enterprise or testing). */
  baseUrl: z.string().default("https://api.github.com"),
});

type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Status shared by every idempotent mutation in this model. */
const MutationStatus = z.enum(["exists", "created", "would-create"]);

/** A compact summary of a repository, written by `sync`. */
const RepoSummarySchema = z.object({
  name: z.string(),
  fullName: z.string(),
  visibility: z.string(),
  defaultBranch: z.string().default(""),
  description: z.string().default(""),
  htmlUrl: z.string().default(""),
});

const ReposResourceSchema = z.object({
  count: z.number(),
  fetchedAt: z.iso.datetime(),
  owner: z.string(),
  repos: z.array(RepoSummarySchema),
});

const RepoEnsureSchema = z.object({
  fetchedAt: z.iso.datetime(),
  dryRun: z.boolean(),
  owner: z.string(),
  name: z.string(),
  status: MutationStatus,
  htmlUrl: z.string().optional(),
  visibility: z.string().optional(),
});

const ReleaseResultSchema = z.object({
  fetchedAt: z.iso.datetime(),
  dryRun: z.boolean(),
  owner: z.string(),
  repo: z.string(),
  tagName: z.string(),
  status: MutationStatus,
  releaseId: z.number().optional(),
  htmlUrl: z.string().optional(),
});

const PullResultSchema = z.object({
  fetchedAt: z.iso.datetime(),
  dryRun: z.boolean(),
  owner: z.string(),
  repo: z.string(),
  head: z.string(),
  base: z.string(),
  status: MutationStatus,
  number: z.number().optional(),
  htmlUrl: z.string().optional(),
});

/** Execution context passed to every method by the swamp runtime. */
interface MethodContext {
  globalArgs: GlobalArgs;
  signal: AbortSignal;
  logger: { info: (msg: string, props?: Record<string, unknown>) => void };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
}

type Handles = { dataHandles: Array<{ name: string }> };

/** Construct an Octokit client for the configured token + base URL. */
function client(g: GlobalArgs): Octokit {
  return new Octokit({ auth: g.token, baseUrl: g.baseUrl });
}

/** Minimal repository fields this model reads back from the API. */
interface RepoData {
  html_url?: string;
  visibility?: string;
  private?: boolean;
  default_branch?: string;
  description?: string | null;
  name?: string;
  full_name?: string;
}

/** Resolve a repository's public/private visibility from a REST payload. */
function visibilityOf(r: RepoData): string {
  return r.visibility ?? (r.private ? "private" : "public");
}

/** Look up a repository, distinguishing a real 404 from other failures. */
async function getRepo(
  c: Octokit,
  owner: string,
  repo: string,
  signal: AbortSignal,
): Promise<RepoData | undefined> {
  try {
    const { data } = await c.rest.repos.get({
      owner,
      repo,
      request: { signal },
    });
    return data as RepoData;
  } catch (e) {
    if ((e as { status?: number }).status === 404) return undefined;
    throw e;
  }
}

/** The `@dataverket/github` model: repositories, releases and pull requests. */
export const model = {
  type: "@dataverket/github",
  version: "2026.10.05.1",
  upgrades: [
    {
      toVersion: "2026.10.05.1",
      description:
        "Forked from @goodcraft/github 2026.06.14.1 as @dataverket/github; no schema change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  resources: {
    "repos": {
      description: "Snapshot of the repositories owned by `owner`",
      schema: ReposResourceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "repoEnsure": {
      description: "Result of the last ensureRepo call",
      schema: RepoEnsureSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "release": {
      description: "Result of the last ensureRelease call",
      schema: ReleaseResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "pull": {
      description: "Result of the last openPr call",
      schema: PullResultSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    sync: {
      description:
        "List the repositories owned by `owner` (read-only; proves the token)",
      arguments: z.object({}),
      execute: async (
        _args: Record<string, never>,
        context: MethodContext,
      ): Promise<Handles> => {
        const g = context.globalArgs;
        const c = client(g);

        const repos = g.isOrg
          ? await c.paginate(c.rest.repos.listForOrg, {
            org: g.owner,
            per_page: 100,
            request: { signal: context.signal },
          })
          : await c.paginate(c.rest.repos.listForAuthenticatedUser, {
            per_page: 100,
            request: { signal: context.signal },
          });

        const summaries = repos.map((r) => ({
          name: r.name,
          fullName: r.full_name,
          visibility: visibilityOf(r as RepoData),
          defaultBranch: r.default_branch ?? "",
          description: r.description ?? "",
          htmlUrl: r.html_url ?? "",
        }));

        context.logger.info("Synced {count} repositories for {owner}", {
          count: summaries.length,
          owner: g.owner,
        });

        const handle = await context.writeResource("repos", "repos", {
          count: summaries.length,
          fetchedAt: new Date().toISOString(),
          owner: g.owner,
          repos: summaries,
        });
        return { dataHandles: [handle] };
      },
    },
    ensureRepo: {
      description:
        "Idempotently ensure a repository exists (create it if missing). dryRun=true (default) plans without creating.",
      arguments: z.object({
        name: z.string().min(1),
        description: z.string().optional(),
        private: z.boolean().default(false),
        autoInit: z.boolean().default(true),
        licenseTemplate: z.string().optional(),
        gitignoreTemplate: z.string().optional(),
        homepage: z.string().optional(),
        topics: z.array(z.string()).default([]),
        dryRun: z.boolean().default(true),
      }),
      execute: async (
        args: {
          name: string;
          description?: string;
          private: boolean;
          autoInit: boolean;
          licenseTemplate?: string;
          gitignoreTemplate?: string;
          homepage?: string;
          topics: string[];
          dryRun: boolean;
        },
        context: MethodContext,
      ): Promise<Handles> => {
        const g = context.globalArgs;
        const c = client(g);
        const existing = await getRepo(c, g.owner, args.name, context.signal);

        let status: z.infer<typeof MutationStatus>;
        let htmlUrl: string | undefined;
        let visibility: string | undefined;

        if (existing) {
          status = "exists";
          htmlUrl = existing.html_url;
          visibility = visibilityOf(existing);
        } else if (args.dryRun) {
          status = "would-create";
          visibility = args.private ? "private" : "public";
        } else {
          const payload = {
            ...buildRepoCreateParams({
              name: args.name,
              description: args.description,
              private: args.private,
              autoInit: args.autoInit,
              licenseTemplate: args.licenseTemplate,
              gitignoreTemplate: args.gitignoreTemplate,
              homepage: args.homepage,
            }),
            request: { signal: context.signal },
          };
          const created = g.isOrg
            ? await c.rest.repos.createInOrg(
              { org: g.owner, ...payload } as Parameters<
                typeof c.rest.repos.createInOrg
              >[0],
            )
            : await c.rest.repos.createForAuthenticatedUser(
              payload as Parameters<
                typeof c.rest.repos.createForAuthenticatedUser
              >[0],
            );
          const data = created.data as RepoData;
          status = "created";
          htmlUrl = data.html_url;
          visibility = visibilityOf(data);
          if (args.topics.length > 0) {
            await c.rest.repos.replaceAllTopics({
              owner: g.owner,
              repo: args.name,
              names: args.topics,
              request: { signal: context.signal },
            });
          }
        }

        context.logger.info("ensureRepo {owner}/{name}: {status}", {
          owner: g.owner,
          name: args.name,
          status,
        });

        const handle = await context.writeResource(
          "repoEnsure",
          `repo-${slug(args.name)}`,
          {
            fetchedAt: new Date().toISOString(),
            dryRun: args.dryRun,
            owner: g.owner,
            name: args.name,
            status,
            htmlUrl,
            visibility,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    ensureRelease: {
      description:
        "Idempotently ensure a release+tag exists (skip if a release with the tag is already present). dryRun=true (default) plans without creating.",
      arguments: z.object({
        repo: z.string().min(1),
        tagName: z.string().min(1),
        targetCommitish: z.string().optional(),
        name: z.string().optional(),
        body: z.string().optional(),
        draft: z.boolean().default(false),
        prerelease: z.boolean().default(false),
        dryRun: z.boolean().default(true),
      }),
      execute: async (
        args: {
          repo: string;
          tagName: string;
          targetCommitish?: string;
          name?: string;
          body?: string;
          draft: boolean;
          prerelease: boolean;
          dryRun: boolean;
        },
        context: MethodContext,
      ): Promise<Handles> => {
        const g = context.globalArgs;
        const c = client(g);

        const releases = await c.paginate(c.rest.repos.listReleases, {
          owner: g.owner,
          repo: args.repo,
          per_page: 100,
          request: { signal: context.signal },
        });
        const existing = findReleaseByTag(releases, args.tagName);

        let status: z.infer<typeof MutationStatus>;
        let releaseId: number | undefined;
        let htmlUrl: string | undefined;

        if (existing) {
          status = "exists";
          releaseId = existing.id;
          htmlUrl = existing.html_url;
        } else if (args.dryRun) {
          status = "would-create";
        } else {
          const created = await c.rest.repos.createRelease({
            owner: g.owner,
            repo: args.repo,
            tag_name: args.tagName,
            target_commitish: args.targetCommitish,
            name: args.name,
            body: args.body,
            draft: args.draft,
            prerelease: args.prerelease,
            request: { signal: context.signal },
          });
          status = "created";
          releaseId = created.data.id;
          htmlUrl = created.data.html_url;
        }

        context.logger.info("ensureRelease {repo}@{tag}: {status}", {
          repo: args.repo,
          tag: args.tagName,
          status,
        });

        const handle = await context.writeResource(
          "release",
          `release-${slug(args.repo)}-${slug(args.tagName)}`,
          {
            fetchedAt: new Date().toISOString(),
            dryRun: args.dryRun,
            owner: g.owner,
            repo: args.repo,
            tagName: args.tagName,
            status,
            releaseId,
            htmlUrl,
          },
        );
        return { dataHandles: [handle] };
      },
    },
    openPr: {
      description:
        "Idempotently open a pull request (skip if an open PR for the same head→base already exists). dryRun=true (default) plans without creating.",
      arguments: z.object({
        repo: z.string().min(1),
        head: z.string().min(1),
        base: z.string().default("main"),
        title: z.string().min(1),
        body: z.string().optional(),
        draft: z.boolean().default(false),
        dryRun: z.boolean().default(true),
      }),
      execute: async (
        args: {
          repo: string;
          head: string;
          base: string;
          title: string;
          body?: string;
          draft: boolean;
          dryRun: boolean;
        },
        context: MethodContext,
      ): Promise<Handles> => {
        const g = context.globalArgs;
        const c = client(g);

        const pulls = await c.paginate(c.rest.pulls.list, {
          owner: g.owner,
          repo: args.repo,
          state: "open",
          head: qualifiedHead(g.owner, args.head),
          base: args.base,
          per_page: 100,
          request: { signal: context.signal },
        });
        const existing = findOpenPull(pulls, args.head, args.base);

        let status: z.infer<typeof MutationStatus>;
        let number: number | undefined;
        let htmlUrl: string | undefined;

        if (existing) {
          status = "exists";
          number = existing.number;
          htmlUrl = existing.html_url;
        } else if (args.dryRun) {
          status = "would-create";
        } else {
          const created = await c.rest.pulls.create({
            owner: g.owner,
            repo: args.repo,
            head: args.head,
            base: args.base,
            title: args.title,
            body: args.body,
            draft: args.draft,
            request: { signal: context.signal },
          });
          status = "created";
          number = created.data.number;
          htmlUrl = created.data.html_url;
        }

        context.logger.info("openPr {repo} {head}->{base}: {status}", {
          repo: args.repo,
          head: args.head,
          base: args.base,
          status,
        });

        const handle = await context.writeResource(
          "pull",
          `pull-${slug(args.repo)}-${slug(args.head)}-${slug(args.base)}`,
          {
            fetchedAt: new Date().toISOString(),
            dryRun: args.dryRun,
            owner: g.owner,
            repo: args.repo,
            head: args.head,
            base: args.base,
            status,
            number,
            htmlUrl,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
