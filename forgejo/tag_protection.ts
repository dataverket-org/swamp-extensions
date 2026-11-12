/**
 * Adds to `@dataverket/forgejo` a repository's tag protection rules: who may
 * create or delete the tags a glob matches (`attestation/*`, `v*`). Upstream
 * has none. Find-or-create on the pattern, both whitelists converged as exact
 * sets, and never a delete: a rule this method did not name is left alone,
 * and an empty whitelist is a rule nobody may push through, not a removal.
 * Forgejo stores a whitelisted login that cannot write to the repository but
 * leaves it out of the rule's answer, and of its effect, without an error; so
 * the answer to each write is checked, and a login it does not count is an
 * error that names it.
 *
 * The method name and its arguments are those of the local extension it was
 * folded in from, so existing definitions keep working.
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
import { repoName, writeRecord } from "./names.ts";

export type { ApiCall, Caller };

const enc = encodeURIComponent;
const tagsPath = (owner: string, repo: string) =>
  `/api/v1/repos/${enc(owner)}/${enc(repo)}/tag_protections`;
const strings = (v: unknown): string[] =>
  Array.isArray(v) ? v.filter((x): x is string => typeof x === "string") : [];
/** Whether two lists hold the same names, in any order and duplicates aside. */
export const sameSet = (a: string[], b: string[]): boolean => {
  const x = [...new Set(a)].sort();
  const y = [...new Set(b)].sort();
  return x.length === y.length && x.every((v, i) => v === y[i]);
};

const TagProtectionEnsureArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  namePattern: z.string().min(1).describe(
    "Tag glob the rule applies to (find-or-create key), e.g. attestation/*.",
  ),
  whitelistUsernames: z.array(z.string().min(1)).default([]).describe(
    "Logins allowed to create or delete matching tags. Converged as an exact set; empty means nobody.",
  ),
  whitelistTeams: z.array(z.string().min(1)).default([]).describe(
    "Org teams allowed to create or delete matching tags. Converged as an exact set.",
  ),
});
/** {@link TagProtectionEnsureArgs} */
export type TagProtectionEnsureArgsT = z.infer<typeof TagProtectionEnsureArgs>;

const TagProtectionInfo = z.object({
  repo: z.string(),
  id: z.number().int(),
  namePattern: z.string(),
  whitelistUsernames: z.array(z.string()),
  whitelistTeams: z.array(z.string()),
  action: z.enum(["created", "updated", "unchanged"]),
  timestamp: z.string(),
});
/** {@link TagProtectionInfo} */
export type TagProtection = z.infer<typeof TagProtectionInfo>;

/** Find-or-create a tag protection rule and converge its whitelists. */
export async function tagProtectionEnsure(
  api: Caller,
  a: TagProtectionEnsureArgsT,
): Promise<TagProtection> {
  const base = tagsPath(a.owner, a.name);
  const existing = (await call(api, { method: "GET", path: base })).body;
  const rules = Array.isArray(existing)
    ? existing as Record<string, unknown>[]
    : [];
  const found = rules.find((r) => r.name_pattern === a.namePattern);
  const body = {
    name_pattern: a.namePattern,
    whitelist_usernames: a.whitelistUsernames,
    whitelist_teams: a.whitelistTeams,
  };
  let rule: Record<string, unknown>;
  let action: TagProtection["action"];
  if (!found) {
    rule = (await call(api, { method: "POST", path: base, body })).body;
    action = "created";
  } else if (
    sameSet(strings(found.whitelist_usernames), a.whitelistUsernames) &&
    sameSet(strings(found.whitelist_teams), a.whitelistTeams)
  ) {
    rule = found;
    action = "unchanged";
  } else {
    rule = (await call(api, {
      method: "PATCH",
      path: `${base}/${Number(found.id)}`,
      body,
    })).body;
    action = "updated";
  }
  if (action !== "unchanged") {
    // Forgejo stores every login given but counts, and reports, only those
    // that may write to the repository, without an error for the rest. What
    // it counts is in its answer; anything asked for and not counted would
    // read as "updated" on every run, and push nothing.
    const users = strings(rule.whitelist_usernames);
    const teams = strings(rule.whitelist_teams);
    const lost = [
      ...a.whitelistUsernames.filter((u) => !users.includes(u)),
      ...a.whitelistTeams.filter((t) => !teams.includes(t)),
    ];
    if (lost.length > 0) {
      throw new Error(
        `${a.owner}/${a.name}: the forge does not count ${
          lost.map((x) => JSON.stringify(x)).join(", ")
        } in the tag protection ${a.namePattern} (the rule was ${action}). ` +
          "A login counts only with write access to the repository; give it " +
          "that (collaborator_ensure) and run again.",
      );
    }
  }
  return {
    repo: `${a.owner}/${a.name}`,
    id: Number(rule.id),
    namePattern: String(rule.name_pattern),
    whitelistUsernames: strings(rule.whitelist_usernames),
    whitelistTeams: strings(rule.whitelist_teams),
    action,
    timestamp: new Date().toISOString(),
  };
}

interface Ctx {
  globalArgs: GlobalArgs;
  forgejoClient?: Caller;
  signal?: AbortSignal;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/** Extension adding tag protection rules. */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    tagProtection: {
      description:
        "A tag protection rule: the pattern and who may push matching tags.",
      schema: TagProtectionInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    tag_protection_ensure: {
      description:
        "Find-or-create a tag protection rule for a tag glob and converge who may push matching tags, " +
        "both whitelists as exact sets. Reports created, updated or unchanged. Never deletes a rule.",
      arguments: TagProtectionEnsureArgs,
      execute: async (args: TagProtectionEnsureArgsT, context: Ctx) => {
        const a = TagProtectionEnsureArgs.parse(args);
        context.logger.info("Ensuring tag protection {pattern} on {repo}", {
          pattern: a.namePattern,
          repo: `${a.owner}/${a.name}`,
        });
        const info = await tagProtectionEnsure(
          callerOf(context),
          a,
        );
        context.logger.info("Tag protection {pattern}: {action}", {
          pattern: info.namePattern,
          action: info.action,
        });
        const name = repoName("tag-protection", info.repo, info.namePattern);
        const handle = await writeRecord(context, "tagProtection", name, name, {
          ...info,
        });
        return { dataHandles: [handle] };
      },
    },
  }],
};
