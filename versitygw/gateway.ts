/**
 * `@dataverket/versitygw/gateway` — everything a versitygw gateway holds,
 * read over its admin API and its S3 API, as data. Read-only.
 *
 * `inventory` is the method a workflow calls: one execution, one lock, every
 * record, all tagged with the id of that inventory. `check` reads the records
 * of one inventory by that tag, never older data, and records what it finds.
 *
 * Written against versitygw v1.8.0. The admin base URL may carry a path
 * prefix, which later releases add.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  type Endpoint,
  expectOk,
  readRootKey,
  type RootKey,
  S3Error,
  send,
} from "./transport.ts";
import {
  type Account,
  AccountSchema,
  type Bucket,
  BucketSchema,
  type BucketSettings,
  BucketSettingsSchema,
  parseAccounts,
  parseAcl,
  parseBuckets,
  parseCors,
  parseObjectLock,
  parseOwnership,
  parseTags,
  parseVersioning,
  ROOT,
} from "./parse.ts";
import { type Finding, findings, FindingSchema, RULES } from "./findings.ts";

/**
 * Global arguments. The root key pair is named, never carried: a key file the
 * operator's session writes, or the environment swamp runs in. One or the
 * other, never both.
 */
export const GlobalArgsSchema = z.object({
  adminUrl: z.string().describe(
    "Base URL of the admin API, e.g. http://localhost:7071. May end in a path prefix",
  ),
  s3Url: z.string().describe(
    "Base URL of the S3 API, e.g. https://s3.example.org:443",
  ),
  region: z.string().default("us-east-1").describe(
    "The region the gateway was started with; it rejects any other",
  ),
  caFile: z.string().optional().describe(
    "PEM file of the CA that signed the gateway's certificate, when it is not in the system store",
  ),
  healthPath: z.string().default("/health").describe(
    "The path given to the gateway's --health option",
  ),
  rootKeyFile: z.string().optional().describe(
    "File of NAME=value lines holding the root key pair, read at call time. " +
      "Suits a file an operator's session writes and removes",
  ),
  rootKeyEnv: z.boolean().default(false).describe(
    "Read the root key pair from swamp's environment, e.g. under a secret " +
      "manager's `run -- swamp ...`. Suits a key held only while an operator works",
  ),
  accessKeyName: z.string().default("ROOT_ACCESS_KEY").describe(
    "Variable holding the root access key, in the file or the environment",
  ),
  secretKeyName: z.string().default("ROOT_SECRET_KEY").describe(
    "Variable holding the root secret key, in the file or the environment",
  ),
  httpTimeoutMs: z.coerce.number().int().default(30000).describe(
    "Per-request timeout in milliseconds",
  ),
  concurrency: z.coerce.number().int().min(1).max(32).default(4).describe(
    "Buckets read at once by bucketSettings and inventory",
  ),
});

/** Resolved global arguments. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** Handle returned by `writeResource`. */
export interface DataHandle {
  name: string;
}

/** The subset of the swamp logger the model uses. */
export interface Logger {
  info(message: string, props?: Record<string, unknown>): void;
  warning(message: string, props?: Record<string, unknown>): void;
}

/** One data record as `queryData` returns it. */
export interface DataRecord {
  name: string;
  specName?: string;
  attributes: Record<string, unknown>;
  tags?: Record<string, string>;
}

/** The subset of the swamp method context the model uses. */
export interface ModelContext {
  globalArgs: GlobalArgs;
  logger: Logger;
  signal?: AbortSignal;
  definition?: { name: string };
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: { tags?: Record<string, string> },
  ): Promise<DataHandle>;
  readResource?(name: string): Promise<Record<string, unknown> | null>;
  queryData?(predicate: string): Promise<unknown[]>;
}

/** What every `execute` returns. */
export interface MethodResult {
  dataHandles: DataHandle[];
}

/** Result of a pre-flight check. */
export interface CheckResult {
  pass: boolean;
  errors?: string[];
}

const HealthSchema = z.object({
  url: z.string(),
  reachable: z.boolean(),
  status: z.number().int().nullable(),
  tls: z.enum(["verified", "plain", "failed"]).nullable().describe(
    "verified: HTTPS against caFile or the system store; plain: HTTP; failed: the chain did not verify",
  ),
  latencyMs: z.number().int().nullable(),
  error: z.string().nullable(),
});

const InventorySchema = z.object({
  inventoryId: z.string(),
  accounts: z.number().int(),
  buckets: z.number().int(),
  healthy: z.boolean(),
});

const CheckSchema = z.object({
  inventoryId: z.string(),
  rules: z.array(z.enum(RULES)),
  allowedRoles: z.array(z.string()),
  clean: z.boolean(),
  findings: z.array(FindingSchema),
});

function endpoint(g: GlobalArgs): Endpoint {
  return g;
}

/** A data name from anything: lowercase letters, digits and dashes. */
export function slug(value: string): string {
  return value.toLowerCase().replace(/[^a-z0-9]+/g, "-").replace(
    /^-|-$/g,
    "",
  ) ||
    "empty";
}

/**
 * Names for a list of subjects, unique within the list: `account-ops`, and a
 * numbered suffix only where two subjects share a slug.
 */
function names(prefix: string, subjects: string[]): string[] {
  const seen = new Map<string, number>();
  return subjects.map((subject) => {
    const base = `${prefix}-${slug(subject)}`;
    const count = (seen.get(base) ?? 0) + 1;
    seen.set(base, count);
    return count === 1 ? base : `${base}-${count}`;
  });
}

async function readHealth(
  g: GlobalArgs,
  signal?: AbortSignal,
): Promise<z.infer<typeof HealthSchema>> {
  const url = g.s3Url.replace(/\/+$/, "") + g.healthPath;
  const https = url.startsWith("https:");
  const started = performance.now();
  try {
    const response = await send(
      endpoint(g),
      undefined,
      { api: "s3", method: "GET", path: g.healthPath, unsigned: true },
      signal,
    );
    return {
      url,
      reachable: response.status === 200,
      status: response.status,
      tls: https ? "verified" : "plain",
      latencyMs: Math.round(performance.now() - started),
      error: response.status === 200
        ? null
        : response.body.trim().slice(0, 200),
    };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    return {
      url,
      reachable: false,
      status: null,
      tls: https && /certificate|tls|handshake/i.test(message)
        ? "failed"
        : null,
      latencyMs: null,
      error: message,
    };
  }
}

async function listAccounts(
  g: GlobalArgs,
  key: RootKey,
  signal?: AbortSignal,
): Promise<Account[]> {
  const call = { api: "admin", method: "PATCH", path: "/list-users" } as const;
  const response = await send(endpoint(g), key, call, signal);
  return parseAccounts(
    expectOk(response, "PATCH /list-users", endpoint(g), key).body,
  ).filter((account) => account.access !== key.access);
}

async function listBuckets(
  g: GlobalArgs,
  key: RootKey,
  signal?: AbortSignal,
): Promise<Bucket[]> {
  const call = {
    api: "admin",
    method: "PATCH",
    path: "/list-buckets",
  } as const;
  const response = await send(endpoint(g), key, call, signal);
  return parseBuckets(
    expectOk(response, "PATCH /list-buckets", endpoint(g), key).body,
    key.access,
  );
}

/** The error codes that mean "this bucket has no such configuration". */
const ABSENT = new Set([
  "NoSuchBucketPolicy",
  "ObjectLockConfigurationNotFoundError",
  "OwnershipControlsNotFoundError",
  "NoSuchCORSConfiguration",
  "NoSuchTagSet",
  "NoSuchTagSetError",
]);

/** GET `/<bucket>?<query>`; null when the gateway says it is not configured. */
async function getSetting(
  g: GlobalArgs,
  key: RootKey,
  bucket: string,
  query: string,
  signal?: AbortSignal,
): Promise<string | null> {
  const path = `/${encodeURIComponent(bucket)}`;
  const response = await send(
    endpoint(g),
    key,
    { api: "s3", method: "GET", path, query },
    signal,
  );
  try {
    return expectOk(response, `GET ${path}?${query}`, endpoint(g), key).body;
  } catch (err) {
    if (err instanceof S3Error && ABSENT.has(err.code)) return null;
    throw err;
  }
}

/** Replace the root access key where it stands as a whole JSON string. */
function maskRootInPolicy(policy: string, rootAccess: string): string {
  return policy.split(JSON.stringify(rootAccess)).join(JSON.stringify(ROOT));
}

async function readSettings(
  g: GlobalArgs,
  key: RootKey,
  bucket: string,
  signal?: AbortSignal,
): Promise<BucketSettings> {
  const get = (query: string) => getSetting(g, key, bucket, query, signal);
  const [versioning, policy, acl, lock, ownership, cors, tagging] =
    await Promise.all([
      get("versioning"),
      get("policy"),
      get("acl"),
      get("object-lock"),
      get("ownershipControls"),
      get("cors"),
      get("tagging"),
    ]);
  return {
    bucket,
    ...parseVersioning(versioning ?? ""),
    policy: policy === null ? null : maskRootInPolicy(policy, key.access),
    acl: parseAcl(acl ?? "", key.access),
    objectLock: lock === null ? null : parseObjectLock(lock),
    objectOwnership: ownership === null ? null : parseOwnership(ownership),
    cors: cors === null ? null : parseCors(cors),
    tags: tagging === null ? null : parseTags(tagging),
  };
}

/** Map with at most `limit` calls in flight, results in input order. */
async function mapLimit<T, R>(
  items: T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  const results = new Array<R>(items.length);
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const index = next++;
      results[index] = await fn(items[index]);
    }
  };
  await Promise.all(
    Array.from({ length: Math.min(limit, items.length) }, worker),
  );
  return results;
}

/** Writes records tagged with one inventory id. */
class Writer {
  readonly handles: DataHandle[] = [];
  constructor(
    private readonly context: ModelContext,
    readonly inventoryId: string,
  ) {}

  async write(spec: string, name: string, data: Record<string, unknown>) {
    this.handles.push(
      await this.context.writeResource(spec, name, data, {
        tags: { inventory: this.inventoryId },
      }),
    );
  }

  async accounts(accounts: Account[]) {
    const keys = names("account", accounts.map((a) => a.access));
    for (const [i, account] of accounts.entries()) {
      await this.write("account", keys[i], account);
    }
  }

  async buckets(buckets: Bucket[]) {
    const keys = names("bucket", buckets.map((b) => b.name));
    for (const [i, bucket] of buckets.entries()) {
      await this.write("bucket", keys[i], bucket);
    }
  }

  async settings(settings: BucketSettings[]) {
    const keys = names("settings", settings.map((s) => s.bucket));
    for (const [i, one] of settings.entries()) {
      await this.write("bucketSettings", keys[i], one);
    }
  }
}

function writer(context: ModelContext): Writer {
  return new Writer(context, crypto.randomUUID());
}

/** Check the root key's source is named once, and (live) that it signs. */
export const checks = {
  "root-key-named": {
    description:
      "Exactly one of rootKeyFile or rootKeyEnv names the root key pair",
    labels: ["policy"],
    execute: (context: { globalArgs: GlobalArgs }): Promise<CheckResult> => {
      const { rootKeyFile, rootKeyEnv } = context.globalArgs;
      if (rootKeyFile && rootKeyEnv) {
        return Promise.resolve({
          pass: false,
          errors: ["give rootKeyFile or rootKeyEnv, not both"],
        });
      }
      if (!rootKeyFile && !rootKeyEnv) {
        return Promise.resolve({
          pass: false,
          errors: ["no root key source: set rootKeyFile or rootKeyEnv"],
        });
      }
      return Promise.resolve({ pass: true });
    },
  },
  "admin-reachable": {
    description:
      "The admin API answers and accepts the root key pair's signature",
    labels: ["live"],
    execute: async (
      context: { globalArgs: GlobalArgs },
    ): Promise<CheckResult> => {
      try {
        const g = context.globalArgs;
        await listBuckets(g, readRootKey(endpoint(g)));
        return { pass: true };
      } catch (err) {
        return {
          pass: false,
          errors: [err instanceof Error ? err.message : String(err)],
        };
      }
    },
  },
};

const Empty = z.object({});

const BucketSettingsArgs = z.object({
  buckets: z.array(z.string()).optional().describe(
    "Buckets to read; every bucket on the gateway when omitted",
  ),
});

const CheckArgs = z.object({
  inventoryId: z.string().optional().describe(
    "The inventory to check; the latest inventory record's id when omitted",
  ),
  rules: z.array(z.enum(RULES)).default([...RULES]).describe(
    "Rules to apply; all of them by default",
  ),
  allowedRoles: z.array(z.string()).default(["user"]).describe(
    "Account roles the account-role rule accepts",
  ),
  failOnFindings: z.boolean().default(false).describe(
    "Fail the method, after recording the result, when anything is found",
  ),
});

function records(
  rows: unknown[],
  spec: string,
): Record<string, unknown>[] {
  return (rows as DataRecord[])
    .filter((row) => row.specName === spec)
    .map((row) => row.attributes);
}

/** A versitygw gateway, read through its admin API and its S3 API. */
export const model = {
  type: "@dataverket/versitygw/gateway",
  version: "2026.09.30.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    health: {
      description:
        "Whether the S3 endpoint answers, over a verified chain, and how fast",
      schema: HealthSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    account: {
      description:
        "One account: access key, role and POSIX ids. Never its secret",
      schema: AccountSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    bucket: {
      description: "One bucket and the account that owns it",
      schema: BucketSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    bucketSettings: {
      description:
        "One bucket's versioning, policy, ACL, object lock, ownership controls, CORS and tags",
      schema: BucketSettingsSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    inventory: {
      description:
        "One inventory: its id, which tags every record it wrote, and counts",
      schema: InventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    check: {
      description: "What check found in one inventory",
      schema: CheckSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    health: {
      kind: "list" as const,
      description:
        "GET the health path on the S3 port, unsigned: reachable, TLS verified, latency. Read-only.",
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading the health path of {url}", {
          url: context.globalArgs.s3Url,
        });
        const out = writer(context);
        const health = await readHealth(context.globalArgs, context.signal);
        context.logger.info("health {url}: {status}", {
          url: health.url,
          status: health.status ?? health.error,
        });
        await out.write("health", "health", health);
        return { dataHandles: out.handles };
      },
    },
    accounts: {
      kind: "list" as const,
      description:
        "List every account but root over the admin API; each record drops the secret key. Read-only.",
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const g = context.globalArgs;
        const key = readRootKey(endpoint(g));
        context.logger.info("listing accounts on {url}", { url: g.adminUrl });
        const accounts = await listAccounts(g, key, context.signal);
        const out = writer(context);
        await out.accounts(accounts);
        context.logger.info("stored {count} accounts", {
          count: accounts.length,
        });
        return { dataHandles: out.handles };
      },
    },
    buckets: {
      kind: "list" as const,
      description:
        "List every bucket and its owner over the admin API. Read-only.",
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const g = context.globalArgs;
        const key = readRootKey(endpoint(g));
        context.logger.info("listing buckets on {url}", { url: g.adminUrl });
        const buckets = await listBuckets(g, key, context.signal);
        const out = writer(context);
        await out.buckets(buckets);
        context.logger.info("stored {count} buckets", {
          count: buckets.length,
        });
        return { dataHandles: out.handles };
      },
    },
    bucketSettings: {
      kind: "list" as const,
      description:
        "Read each bucket's settings over the S3 API as root: versioning, policy, ACL, object lock, ownership controls, CORS, tags. Read-only.",
      arguments: BucketSettingsArgs,
      execute: async (
        args: z.infer<typeof BucketSettingsArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const g = context.globalArgs;
        const key = readRootKey(endpoint(g));
        context.logger.info("reading bucket settings on {url}", {
          url: g.s3Url,
        });
        const names = args.buckets ??
          (await listBuckets(g, key, context.signal)).map((b) => b.name);
        const settings = await mapLimit(
          names,
          g.concurrency,
          (bucket) => readSettings(g, key, bucket, context.signal),
        );
        const out = writer(context);
        await out.settings(settings);
        context.logger.info("stored settings of {count} buckets", {
          count: settings.length,
        });
        return { dataHandles: out.handles };
      },
    },
    inventory: {
      kind: "list" as const,
      description:
        "Health, accounts, buckets and every bucket's settings in one execution, each record tagged with this inventory's id. Read-only.",
      arguments: Empty,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const g = context.globalArgs;
        const key = readRootKey(endpoint(g));
        context.logger.info("taking an inventory of {url}", {
          url: g.adminUrl,
        });
        const health = await readHealth(g, context.signal);
        const accounts = await listAccounts(g, key, context.signal);
        const buckets = await listBuckets(g, key, context.signal);
        const settings = await mapLimit(
          buckets,
          g.concurrency,
          (bucket) => readSettings(g, key, bucket.name, context.signal),
        );
        const out = writer(context);
        await out.write("health", "health", health);
        await out.accounts(accounts);
        await out.buckets(buckets);
        await out.settings(settings);
        await out.write("inventory", "inventory", {
          inventoryId: out.inventoryId,
          accounts: accounts.length,
          buckets: buckets.length,
          healthy: health.reachable,
        });
        context.logger.info(
          "inventory {id}: {accounts} accounts, {buckets} buckets",
          {
            id: out.inventoryId,
            accounts: accounts.length,
            buckets: buckets.length,
          },
        );
        return { dataHandles: out.handles };
      },
    },
    check: {
      kind: "list" as const,
      description:
        "Apply the rules to the records of one inventory and record the findings. Reads only that inventory's records; calls no API.",
      arguments: CheckArgs,
      execute: async (
        raw: z.input<typeof CheckArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        // Parsed here too, so a caller that skips swamp's validation gets the
        // defaults rather than an empty rule set that finds nothing.
        const args = CheckArgs.parse(raw);
        context.logger.info("checking inventory {id}", {
          id: args.inventoryId ?? "(latest)",
        });
        let inventoryId = args.inventoryId;
        if (!inventoryId) {
          const latest = await context.readResource?.("inventory");
          inventoryId = typeof latest?.inventoryId === "string"
            ? latest.inventoryId
            : undefined;
        }
        if (!inventoryId) {
          throw new Error("no inventory to check: run inventory first");
        }
        if (!/^[0-9a-f-]{36}$/.test(inventoryId)) {
          throw new Error(`not an inventory id: ${inventoryId}`);
        }
        if (!context.queryData || !context.definition) {
          throw new Error("this swamp cannot query data from a method");
        }
        // Mentioning `version` makes the query see every version, not only
        // the latest, so an inventory that a later one superseded still
        // checks whole.
        const rows = await context.queryData(
          `modelType == ${JSON.stringify(model.type)} && modelName == ${
            JSON.stringify(context.definition.name)
          } && tags.inventory == "${inventoryId}" && version > 0`,
        );
        const inventory = records(rows, "inventory");
        if (inventory.length === 0) {
          throw new Error(`inventory ${inventoryId} has no inventory record`);
        }
        const found: Finding[] = findings({
          accounts: records(rows, "account") as Account[],
          buckets: records(rows, "bucket") as Bucket[],
          settings: records(rows, "bucketSettings") as BucketSettings[],
        }, args);
        const result = {
          inventoryId,
          rules: args.rules,
          allowedRoles: args.allowedRoles,
          clean: found.length === 0,
          findings: found,
        };
        const handle = await context.writeResource("check", "check", result, {
          tags: { inventory: inventoryId },
        });
        for (const finding of found) {
          context.logger.warning("{rule} {subject}: {detail}", { ...finding });
        }
        context.logger.info("inventory {id}: {count} findings", {
          id: inventoryId,
          count: found.length,
        });
        if (args.failOnFindings && found.length > 0) {
          throw new Error(
            `${found.length} findings in inventory ${inventoryId}; see the check record`,
          );
        }
        return { dataHandles: [handle] };
      },
    },
  },
};
