/**
 * `@dataverket/versitygw` — the rules `check` applies to one inventory.
 *
 * Pure functions over records: no gateway, no clock. Which rules run, which
 * account roles pass and which lock modes are acceptable are arguments; the
 * defaults describe a gateway with one `user` account per writer that owns the
 * bucket of the same name, no bucket anyone may read, versioning only where
 * object lock requires it, and GOVERNANCE as the only default retention.
 *
 * @module
 */
import { z } from "npm:zod@4";
import type { Account, Bucket, BucketSettings } from "./parse.ts";

/** Every rule `check` knows. */
export const RULES = [
  "bucket-owner-missing",
  "bucket-owner-not-same-named",
  "account-owns-nothing",
  "account-role",
  "versioning-enabled",
  "versioning-without-lock",
  "lock-without-versioning",
  "lock-mode",
  "bucket-public",
] as const;

/** A rule's name. */
export type Rule = typeof RULES[number];

/**
 * The rules a gateway is checked against by default. `versioning-enabled`
 * is not among them: a bucket created with object lock is versioned because
 * S3 requires it, and the three lock rules say what is wrong instead. A
 * gateway that is to hold no versioned bucket at all names it explicitly.
 */
export const DEFAULT_RULES = [
  "bucket-owner-missing",
  "bucket-owner-not-same-named",
  "account-owns-nothing",
  "account-role",
  "versioning-without-lock",
  "lock-without-versioning",
  "lock-mode",
  "bucket-public",
] as const satisfies readonly Rule[];

/** The retention modes object lock knows. */
export const LOCK_MODES = ["GOVERNANCE", "COMPLIANCE"] as const;

/** One thing `check` found. */
export const FindingSchema = z.object({
  rule: z.enum(RULES),
  subject: z.string().describe("The bucket or account the finding is about"),
  detail: z.string(),
});

/** {@link FindingSchema} */
export type Finding = z.infer<typeof FindingSchema>;

/** What the rules read. */
export interface Inventory {
  accounts: Account[];
  buckets: Bucket[];
  settings: BucketSettings[];
}

/** The rule set and its parameters. */
export interface RuleOptions {
  rules: readonly Rule[];
  allowedRoles: readonly string[];
  /**
   * Default retention modes the lock-mode rule accepts. COMPLIANCE retention
   * can be shortened by nobody, the root account included, until it expires,
   * so a bucket that defaults to it is a commitment a person makes on purpose.
   */
  allowedLockModes: readonly string[];
}

const ANYONE_GROUPS = [
  "http://acs.amazonaws.com/groups/global/AllUsers",
  "http://acs.amazonaws.com/groups/global/AuthenticatedUsers",
];

/** True when a policy principal is everyone: `"*"` or `{"AWS": "*"}`. */
function isAnyone(principal: unknown): boolean {
  if (principal === "*") return true;
  if (typeof principal !== "object" || principal === null) return false;
  return Object.values(principal as Record<string, unknown>).some((value) =>
    value === "*" || (Array.isArray(value) && value.includes("*"))
  );
}

/**
 * Why a bucket is readable or writable by anyone, or an empty list: a policy
 * statement that allows an anonymous principal, or an ACL grant to the
 * all-users or authenticated-users group. A policy that is not JSON is itself
 * a reason, since nobody can tell what it grants.
 */
export function publicReasons(settings: BucketSettings): string[] {
  const reasons: string[] = [];
  if (settings.policy) {
    try {
      const policy = JSON.parse(settings.policy) as { Statement?: unknown };
      const statements = Array.isArray(policy.Statement)
        ? policy.Statement
        : policy.Statement
        ? [policy.Statement]
        : [];
      for (const raw of statements) {
        const statement = raw as Record<string, unknown>;
        if (statement.Effect === "Allow" && isAnyone(statement.Principal)) {
          const actions = [statement.Action].flat().filter(Boolean).join(", ");
          reasons.push(`policy allows anyone ${actions || "every action"}`);
        }
      }
    } catch {
      reasons.push("policy is not valid JSON");
    }
  }
  for (const grant of settings.acl.grants) {
    if (
      grant.granteeType === "Group" && ANYONE_GROUPS.includes(grant.grantee)
    ) {
      reasons.push(`ACL grants ${grant.permission} to ${grant.grantee}`);
    }
  }
  return reasons;
}

/** Apply the chosen rules; findings come back sorted by rule, then subject. */
export function findings(
  inventory: Inventory,
  options: RuleOptions,
): Finding[] {
  const on = new Set(options.rules);
  const out: Finding[] = [];
  const accounts = new Map(inventory.accounts.map((a) => [a.access, a]));
  const owners = new Set(inventory.buckets.map((b) => b.owner));

  for (const bucket of inventory.buckets) {
    if (bucket.ownerIsRoot) {
      if (on.has("bucket-owner-not-same-named")) {
        out.push({
          rule: "bucket-owner-not-same-named",
          subject: bucket.name,
          detail: "owned by the root account",
        });
      }
      continue;
    }
    if (!accounts.has(bucket.owner)) {
      if (on.has("bucket-owner-missing")) {
        out.push({
          rule: "bucket-owner-missing",
          subject: bucket.name,
          detail: `owner ${bucket.owner || "(none)"} is not an account`,
        });
      }
    } else if (
      bucket.owner !== bucket.name && on.has("bucket-owner-not-same-named")
    ) {
      out.push({
        rule: "bucket-owner-not-same-named",
        subject: bucket.name,
        detail: `owned by ${bucket.owner}`,
      });
    }
  }

  for (const account of inventory.accounts) {
    if (on.has("account-owns-nothing") && !owners.has(account.access)) {
      out.push({
        rule: "account-owns-nothing",
        subject: account.access,
        detail: "owns no bucket",
      });
    }
    if (
      on.has("account-role") && !options.allowedRoles.includes(account.role)
    ) {
      out.push({
        rule: "account-role",
        subject: account.access,
        detail: `role ${account.role}, allowed: ${
          options.allowedRoles.join(", ")
        }`,
      });
    }
  }

  for (const settings of inventory.settings) {
    const locked = settings.objectLock?.enabled === true;
    const versioned = settings.versioning !== "Off";
    if (on.has("versioning-enabled") && settings.versioning === "Enabled") {
      out.push({
        rule: "versioning-enabled",
        subject: settings.bucket,
        detail: locked
          ? "versioning enabled, as object lock requires"
          : "versioning enabled",
      });
    }
    if (on.has("versioning-without-lock") && versioned && !locked) {
      out.push({
        rule: "versioning-without-lock",
        subject: settings.bucket,
        detail: `versioning ${settings.versioning.toLowerCase()} ` +
          "on a bucket without object lock: every non-current version stays until a client deletes it by id",
      });
    }
    if (on.has("lock-without-versioning") && locked && !versioned) {
      out.push({
        rule: "lock-without-versioning",
        subject: settings.bucket,
        detail:
          "object lock on an unversioned bucket: a locked object cannot be overwritten at all, " +
          "which S3 never allows and versitygw permits",
      });
    }
    if (
      on.has("lock-mode") && locked && settings.objectLock?.mode &&
      !options.allowedLockModes.includes(settings.objectLock.mode)
    ) {
      out.push({
        rule: "lock-mode",
        subject: settings.bucket,
        detail: `default retention ${settings.objectLock.mode}` +
          `${
            settings.objectLock.days
              ? ` for ${settings.objectLock.days} days`
              : ""
          }` +
          `${
            settings.objectLock.years
              ? ` for ${settings.objectLock.years} years`
              : ""
          }` +
          `, allowed: ${options.allowedLockModes.join(", ")}`,
      });
    }
    if (on.has("bucket-public")) {
      for (const reason of publicReasons(settings)) {
        out.push({
          rule: "bucket-public",
          subject: settings.bucket,
          detail: reason,
        });
      }
    }
  }

  return out.sort((a, b) =>
    a.rule.localeCompare(b.rule) || a.subject.localeCompare(b.subject) ||
    a.detail.localeCompare(b.detail)
  );
}
