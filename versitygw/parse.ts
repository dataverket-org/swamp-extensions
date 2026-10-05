/**
 * `@dataverket/versitygw` — gateway answers to records, and the schemas of
 * those records.
 *
 * `/list-users` returns every account's secret key, and its session token, in
 * clear. {@link parseAccounts} copies named fields into a type that has no
 * field for either, so a secret cannot reach a record by being spread along.
 * The root account's access key is never recorded either: a bucket root owns
 * says so in `ownerIsRoot`, and an ACL naming root names {@link ROOT}.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { parseRoot } from "./transport.ts";

/** Stands in for the root account's access key wherever the gateway names it. */
export const ROOT = "<root>";

/** One account on the gateway. There is no secret in it, by construction. */
export const AccountSchema = z.object({
  access: z.string().describe("Access key id, which is the account's name"),
  role: z.string().describe("user, userplus or admin"),
  userId: z.number().int(),
  groupId: z.number().int(),
  projectId: z.number().int(),
  arn: z.string().optional().describe(
    "Set only by IAM backends whose identities have ARNs",
  ),
});

/** {@link AccountSchema} */
export type Account = z.infer<typeof AccountSchema>;

/** One bucket and the account that owns it. */
export const BucketSchema = z.object({
  name: z.string(),
  owner: z.string().describe(
    "The owning account's access key; empty when root owns the bucket",
  ),
  ownerIsRoot: z.boolean(),
});

/** {@link BucketSchema} */
export type Bucket = z.infer<typeof BucketSchema>;

/** One ACL grant. */
export const GrantSchema = z.object({
  granteeType: z.string().describe(
    "CanonicalUser, Group or AmazonCustomerByEmail",
  ),
  grantee: z.string().describe(
    `Account id, group URI or email; ${ROOT} for root`,
  ),
  permission: z.string(),
});

/** One CORS rule. */
export const CorsRuleSchema = z.object({
  allowedOrigins: z.array(z.string()),
  allowedMethods: z.array(z.string()),
  allowedHeaders: z.array(z.string()),
  exposeHeaders: z.array(z.string()),
  maxAgeSeconds: z.number().int().optional(),
});

/** Every bucket-level setting the S3 API reports, read as root. */
export const BucketSettingsSchema = z.object({
  bucket: z.string(),
  versioning: z.enum(["Off", "Enabled", "Suspended"]).describe(
    "Off when versioning has never been configured",
  ),
  mfaDelete: z.string().optional(),
  policy: z.string().nullable().describe(
    "The bucket policy as the gateway returns it (JSON text); null when none",
  ),
  acl: z.object({
    owner: z.string(),
    grants: z.array(GrantSchema),
  }),
  objectLock: z.object({
    enabled: z.boolean(),
    mode: z.string().optional(),
    days: z.number().int().optional(),
    years: z.number().int().optional(),
  }).nullable().describe(
    "null when the bucket was created without object lock",
  ),
  objectOwnership: z.string().nullable(),
  cors: z.array(CorsRuleSchema).nullable(),
  tags: z.record(z.string(), z.string()).nullable(),
});

/** {@link BucketSettingsSchema} */
export type BucketSettings = z.infer<typeof BucketSettingsSchema>;

function obj(value: unknown): Record<string, unknown> {
  return typeof value === "object" && value !== null
    ? value as Record<string, unknown>
    : {};
}

function list(value: unknown): unknown[] {
  if (value === undefined || value === null || value === "") return [];
  return Array.isArray(value) ? value : [value];
}

function text(value: unknown): string {
  if (typeof value === "string") return value;
  if (typeof value === "number") return String(value);
  const inner = obj(value)["#text"];
  return typeof inner === "string" ? inner : "";
}

/** An integer element: 0 when absent, an error when it is not a number. */
function int(value: unknown): number {
  const raw = text(value);
  if (raw === "") return 0;
  if (!/^-?\d+$/.test(raw)) {
    throw new Error("expected an integer element, got text");
  }
  return Number.parseInt(raw, 10);
}

/** A string element that must be present and not empty. */
function required(value: unknown, what: string): string {
  const raw = text(value);
  if (raw === "") throw new Error(`${what} is missing`);
  return raw;
}

function strings(value: unknown): string[] {
  return list(value).map(text).filter((s) => s !== "");
}

/** `/list-users` to accounts, sorted by access key, secrets left behind. */
export function parseAccounts(body: string): Account[] {
  const root = parseRoot(body, "ListUserAccountsResult");
  return list(root.Accounts).map((raw) => {
    const row = obj(raw);
    const account: Account = {
      access: required(row.Access, "an account's Access"),
      role: text(row.Role),
      userId: int(row.UserID),
      groupId: int(row.GroupID),
      projectId: int(row.ProjectID),
    };
    const arn = text(row.Arn);
    if (arn) account.arn = arn;
    return account;
  }).sort((a, b) => a.access.localeCompare(b.access));
}

/** `/list-buckets` to buckets, sorted by name, the root owner masked. */
export function parseBuckets(body: string, rootAccess: string): Bucket[] {
  const root = parseRoot(body, "ListBucketsResult");
  return list(root.Buckets).map((raw) => {
    const row = obj(raw);
    const owner = text(row.Owner);
    const ownerIsRoot = owner === rootAccess;
    return {
      name: required(row.Name, "a bucket's Name"),
      owner: ownerIsRoot ? "" : owner,
      ownerIsRoot,
    };
  }).sort((a, b) => a.name.localeCompare(b.name));
}

/** `?versioning` to its status and MFA delete. */
export function parseVersioning(
  body: string,
): Pick<BucketSettings, "versioning" | "mfaDelete"> {
  const root = parseRoot(body, "VersioningConfiguration");
  const status = text(root.Status);
  if (status !== "" && status !== "Enabled" && status !== "Suspended") {
    throw new Error(`unknown versioning status ${JSON.stringify(status)}`);
  }
  const result: Pick<BucketSettings, "versioning" | "mfaDelete"> = {
    versioning: status === "" ? "Off" : status,
  };
  const mfa = text(root.MfaDelete);
  if (mfa) result.mfaDelete = mfa;
  return result;
}

/** `?acl` to the owner and the grants, root masked. */
export function parseAcl(
  body: string,
  rootAccess: string,
): BucketSettings["acl"] {
  const mask = (id: string) => id === rootAccess ? ROOT : id;
  const root = parseRoot(body, "AccessControlPolicy");
  const grants = list(obj(root.AccessControlList).Grant).map((raw) => {
    const grant = obj(raw);
    const grantee = obj(grant.Grantee);
    const type = text(grantee["@type"]);
    const who = text(grantee.ID) || text(grantee.URI) ||
      text(grantee.EmailAddress);
    return {
      granteeType: type,
      grantee: type === "CanonicalUser" ? mask(who) : who,
      permission: text(grant.Permission),
    };
  });
  return { owner: mask(text(obj(root.Owner).ID)), grants };
}

/** `?object-lock` to whether it is on and its default retention. */
export function parseObjectLock(
  body: string,
): NonNullable<BucketSettings["objectLock"]> {
  const root = parseRoot(body, "ObjectLockConfiguration");
  const retention = obj(obj(root.Rule).DefaultRetention);
  const lock: NonNullable<BucketSettings["objectLock"]> = {
    enabled: text(root.ObjectLockEnabled) === "Enabled",
  };
  const mode = text(retention.Mode);
  if (mode) lock.mode = mode;
  if (text(retention.Days)) lock.days = int(retention.Days);
  if (text(retention.Years)) lock.years = int(retention.Years);
  return lock;
}

/** `?ownershipControls` to the object ownership setting. */
export function parseOwnership(body: string): string | null {
  const rule = obj(parseRoot(body, "OwnershipControls").Rule);
  return text(rule.ObjectOwnership) || null;
}

/** `?cors` to its rules. */
export function parseCors(body: string): NonNullable<BucketSettings["cors"]> {
  const root = parseRoot(body, "CORSConfiguration");
  return list(root.CORSRule).map((raw) => {
    const rule = obj(raw);
    const parsed: z.infer<typeof CorsRuleSchema> = {
      allowedOrigins: strings(rule.AllowedOrigin),
      allowedMethods: strings(rule.AllowedMethod),
      allowedHeaders: strings(rule.AllowedHeader),
      exposeHeaders: strings(rule.ExposeHeader),
    };
    if (text(rule.MaxAgeSeconds)) {
      parsed.maxAgeSeconds = int(rule.MaxAgeSeconds);
    }
    return parsed;
  });
}

/** `?tagging` to a key-value map. */
export function parseTags(body: string): Record<string, string> {
  const tagSet = obj(parseRoot(body, "Tagging").TagSet);
  const tags: Record<string, string> = {};
  for (const raw of list(tagSet.Tag)) {
    const tag = obj(raw);
    tags[text(tag.Key)] = text(tag.Value);
  }
  return tags;
}

// ---- Other backends: radosgw's admin ops API answers JSON, and any S3
// endpoint lists the key's own buckets as XML. The same records come out.

function json(body: string, what: string): unknown {
  try {
    return JSON.parse(body);
  } catch {
    throw new Error(`${what}: expected JSON`);
  }
}

/** radosgw `GET /admin/user?list` to user ids, sorted. */
export function parseRgwUserIds(body: string): string[] {
  const doc = obj(json(body, "user list"));
  return list(doc.keys).map(text).filter(Boolean).sort();
}

/**
 * radosgw `GET /admin/user?uid=` to an account: the uid is the name, a user
 * with the system or admin flag is role `admin`, any other `user`. The
 * answer carries every S3 and Swift secret of the user; only named fields
 * are copied, so none can reach a record. The access key ids are returned
 * beside, for telling which user the root key pair belongs to.
 */
export function parseRgwUser(
  body: string,
): { account: Account; accessKeys: string[] } {
  const doc = obj(json(body, "user info"));
  const uid = required(doc.user_id, "a user's user_id");
  // system and admin are flags; a user whose caps let it manage users or
  // buckets is an administrator in all but name.
  const caps = list(doc.caps).map((c) => {
    const cap = obj(c);
    return `${text(cap.type)}=${text(cap.perm)}`;
  });
  const admin = doc.system === true || doc.system === "true" ||
    doc.admin === true || doc.admin === "true" ||
    caps.some((c) => /^(users|buckets)=(\*|write|read, write)$/.test(c));
  const accessKeys = list(doc.keys).map((k) => text(obj(k).access_key))
    .filter(Boolean);
  return {
    account: {
      access: uid,
      role: admin ? "admin" : "user",
      userId: 0,
      groupId: 0,
      projectId: 0,
    },
    accessKeys,
  };
}

/** radosgw `GET /admin/bucket` to bucket names, sorted. */
export function parseRgwBucketNames(body: string): string[] {
  const doc = json(body, "bucket list");
  return list(doc).map(text).filter(Boolean).sort();
}

/** radosgw `GET /admin/bucket?bucket=` to the owning user id. */
export function parseRgwBucketOwner(body: string): string {
  return required(obj(json(body, "bucket info")).owner, "a bucket's owner");
}

/**
 * S3 `GET /` (ListAllMyBuckets) to buckets: every one is the caller's own,
 * so each is marked as root-owned; a plain S3 endpoint has no other owner
 * to report.
 */
export function parseListAllMyBuckets(body: string): Bucket[] {
  const root = parseRoot(body, "ListAllMyBucketsResult");
  const names: string[] = [];
  for (const container of list(root.Buckets)) {
    for (const raw of list(obj(container).Bucket)) {
      names.push(required(obj(raw).Name, "a bucket's Name"));
    }
  }
  return names.sort().map((name) => ({ name, owner: "", ownerIsRoot: true }));
}
