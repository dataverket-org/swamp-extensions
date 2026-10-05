/**
 * Pure planning helpers for the `@dataverket/github` model (forked from
 * `@goodcraft/github`, MIT, copyright 2026 GoodCraft).
 *
 * These functions hold the zod-free, side-effect-free logic the model's methods
 * depend on: mapping user-facing arguments to GitHub REST payloads and matching
 * existing releases / pull requests so mutations stay idempotent. They are unit
 * tested in isolation so the model methods can remain thin API wrappers.
 *
 * @module
 */

/** User-facing arguments accepted by the model's `ensureRepo` method. */
export interface RepoCreateArgs {
  name: string;
  description?: string;
  private: boolean;
  autoInit: boolean;
  licenseTemplate?: string;
  gitignoreTemplate?: string;
  homepage?: string;
}

/** GitHub REST payload for repository creation (snake_case keys). */
export type RepoCreateParams = Record<string, unknown>;

/**
 * Map user-facing `ensureRepo` args to the GitHub REST create payload,
 * converting to snake_case and omitting any optional field left undefined.
 */
export function buildRepoCreateParams(args: RepoCreateArgs): RepoCreateParams {
  const params: RepoCreateParams = {
    name: args.name,
    private: args.private,
    auto_init: args.autoInit,
  };
  if (args.description !== undefined) params.description = args.description;
  if (args.licenseTemplate !== undefined) {
    params.license_template = args.licenseTemplate;
  }
  if (args.gitignoreTemplate !== undefined) {
    params.gitignore_template = args.gitignoreTemplate;
  }
  if (args.homepage !== undefined) params.homepage = args.homepage;
  return params;
}

/** Minimal shape of a GitHub release needed to match one by tag. */
export interface ReleaseLike {
  tag_name: string;
}

/** Find an existing release by exact tag name, or `undefined` if absent. */
export function findReleaseByTag<T extends ReleaseLike>(
  releases: T[],
  tag: string,
): T | undefined {
  return releases.find((r) => r.tag_name === tag);
}

/** Minimal shape of a GitHub pull request needed to match an open PR. */
export interface PullLike {
  head: { ref: string };
  base: { ref: string };
}

/** Find an open PR whose head and base branch refs both match. */
export function findOpenPull<T extends PullLike>(
  pulls: T[],
  head: string,
  base: string,
): T | undefined {
  return pulls.find((p) => p.head.ref === head && p.base.ref === base);
}

/** Build the `owner:branch` head filter the pulls-list endpoint expects. */
export function qualifiedHead(owner: string, head: string): string {
  return `${owner}:${head}`;
}

/** Sanitize an arbitrary string into a safe datastore instance name. */
export function slug(value: string): string {
  return value.replace(/[^a-zA-Z0-9._-]+/g, "-").replace(/^-+|-+$/g, "");
}
