/**
 * Adds to `@thomas/forgejo` labels, of an organization or of a repository:
 * `label_ensure` and `label_list`. Upstream has no method for them.
 *
 * An organization's labels are shared by every repository in it, which is
 * where a forge-wide set belongs; a repository's labels are its own. The name
 * is the identity: a label is created when absent, patched when its color,
 * description or exclusivity differ, and left alone otherwise. Nothing is
 * deleted unless `prune` is set, and then only labels of the same scope.
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
const safeName = (s: string) => s.replace(/[\\/\s]+/g, ":");
const PAGE = 50;
const MAX_PAGES = 20;
const COLOR = /^#?[0-9a-fA-F]{6}$/;

/** Where a set of labels lives. */
export interface Scope {
  owner: string;
  /** The repository; absent for the organization's labels. */
  repo?: string;
}

function labelsPath(s: Scope): string {
  return s.repo
    ? `/api/v1/repos/${enc(s.owner)}/${enc(s.repo)}/labels`
    : `/api/v1/orgs/${enc(s.owner)}/labels`;
}

/** One label as Forgejo reports it. */
export interface Label {
  id: number;
  name: string;
  color: string;
  description: string;
  exclusive: boolean;
}

/** Lowercase, no leading `#`: the form Forgejo reports. */
export function normalizeColor(c: string): string {
  if (!COLOR.test(c)) {
    throw new Error(`invalid color ${JSON.stringify(c)}; six hex digits`);
  }
  return c.replace(/^#/, "").toLowerCase();
}

function parseLabel(x: unknown): Label | undefined {
  if (!x || typeof x !== "object") return undefined;
  const o = x as Record<string, unknown>;
  if (typeof o.id !== "number" || typeof o.name !== "string") return undefined;
  return {
    id: o.id,
    name: o.name,
    color: typeof o.color === "string"
      ? o.color.replace(/^#/, "").toLowerCase()
      : "",
    description: typeof o.description === "string" ? o.description : "",
    exclusive: o.exclusive === true,
  };
}

/** Every label of the scope, every page. */
export async function listLabels(api: Caller, s: Scope): Promise<Label[]> {
  const out: Label[] = [];
  for (let page = 1; page <= MAX_PAGES; page++) {
    const r = await call(api, {
      method: "GET",
      path: `${labelsPath(s)}?limit=${PAGE}&page=${page}`,
    });
    const items = Array.isArray(r.body) ? r.body as unknown[] : [];
    for (const it of items) {
      const l = parseLabel(it);
      if (l) out.push(l);
    }
    if (items.length < PAGE) break;
  }
  return out;
}

/**
 * The labels a repository's issues may carry: the repository's own and its
 * owning organization's. A user's repository has only its own.
 */
export async function labelsForIssues(
  api: Caller,
  owner: string,
  repo: string,
): Promise<Label[]> {
  const own = await listLabels(api, { owner, repo });
  const r = await api({ method: "GET", path: `/api/v1/orgs/${enc(owner)}` });
  if (r.status !== 200) return own;
  return [...own, ...await listLabels(api, { owner })];
}

const LabelSpec = z.object({
  name: z.string().trim().min(1).max(50).describe("The label; the identity."),
  color: z.string().regex(COLOR).describe("Six hex digits, with or without #."),
  description: z.string().max(200).default(""),
  exclusive: z.boolean().default(false).describe(
    "Forgejo's scoped label: of labels sharing a scope/ prefix an issue carries one.",
  ),
});

const LabelEnsureArgs = z.object({
  owner: z.string().min(1).describe(
    "The organization, or a repository's owner.",
  ),
  name: z.string().min(1).optional().describe(
    "Repository name. Absent: the organization's labels, shared by all its repositories.",
  ),
  labels: z.array(LabelSpec).min(1).max(100),
  prune: z.boolean().default(false).describe(
    "Delete every label of this scope that is not in the list.",
  ),
}).refine(
  (a) => new Set(a.labels.map((l) => l.name)).size === a.labels.length,
  { message: "two labels in one call carry the same name" },
);
/** {@link LabelEnsureArgs} */
export type LabelEnsureArgsT = z.infer<typeof LabelEnsureArgs>;

const LabelListArgs = z.object({
  owner: z.string().min(1).describe(
    "The organization, or a repository's owner.",
  ),
  name: z.string().min(1).optional().describe(
    "Repository name. Absent: the organization's labels.",
  ),
});
/** {@link LabelListArgs} */
export type LabelListArgsT = z.infer<typeof LabelListArgs>;

/** One label after `label_ensure` or `label_list`. */
const LabelInfo = z.object({
  owner: z.string(),
  repo: z.string().optional(),
  scope: z.enum(["org", "repo"]),
  id: z.number().int(),
  name: z.string(),
  color: z.string(),
  description: z.string(),
  exclusive: z.boolean(),
  action: z.enum(["created", "updated", "unchanged", "deleted", "listed"]),
  timestamp: z.string(),
});
/** {@link LabelInfo} */
export type LabelRecord = z.infer<typeof LabelInfo>;

function info(
  s: Scope,
  l: Label,
  action: LabelRecord["action"],
  timestamp: string,
): LabelRecord {
  return {
    owner: s.owner,
    repo: s.repo,
    scope: s.repo ? "repo" : "org",
    id: l.id,
    name: l.name,
    color: l.color,
    description: l.description,
    exclusive: l.exclusive,
    action,
    timestamp,
  };
}

/** Create, patch or keep each label given; delete the others only with `prune`. */
export async function labelEnsure(
  api: Caller,
  a: LabelEnsureArgsT,
): Promise<LabelRecord[]> {
  const p = LabelEnsureArgs.parse(a);
  const s: Scope = { owner: p.owner, repo: p.name };
  const have = await listLabels(api, s);
  const out: LabelRecord[] = [];
  const timestamp = new Date().toISOString();
  for (const want of p.labels) {
    const color = normalizeColor(want.color);
    const cur = have.find((l) => l.name === want.name);
    if (!cur) {
      const r = await call(api, {
        method: "POST",
        path: labelsPath(s),
        body: {
          name: want.name,
          color: `#${color}`,
          description: want.description,
          exclusive: want.exclusive,
        },
      });
      const made = parseLabel(r.body);
      if (!made) {
        throw new Error(
          `Forgejo answered the create of label "${want.name}" without an id`,
        );
      }
      out.push(info(s, made, "created", timestamp));
      continue;
    }
    const same = cur.color === color &&
      cur.description === want.description &&
      cur.exclusive === want.exclusive;
    if (same) {
      out.push(info(s, cur, "unchanged", timestamp));
      continue;
    }
    await call(api, {
      method: "PATCH",
      path: `${labelsPath(s)}/${cur.id}`,
      body: {
        name: want.name,
        color: `#${color}`,
        description: want.description,
        exclusive: want.exclusive,
      },
    });
    out.push(
      info(
        s,
        {
          ...cur,
          color,
          description: want.description,
          exclusive: want.exclusive,
        },
        "updated",
        timestamp,
      ),
    );
  }
  if (p.prune) {
    const keep = new Set(p.labels.map((l) => l.name));
    for (const l of have) {
      if (keep.has(l.name)) continue;
      await call(api, { method: "DELETE", path: `${labelsPath(s)}/${l.id}` });
      out.push(info(s, l, "deleted", timestamp));
    }
  }
  return out;
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

async function record(context: Ctx, labels: LabelRecord[]) {
  const handles = [];
  for (const l of labels) {
    context.logger.info("Label {name} of {where}: {action}", {
      name: l.name,
      where: l.repo ? `${l.owner}/${l.repo}` : l.owner,
      action: l.action,
    });
    handles.push(
      await context.writeResource(
        "label",
        safeName(`${l.owner}:${l.repo ?? "org"}:label:${l.name}`),
        l,
      ),
    );
  }
  return { dataHandles: handles };
}

/** Extension adding labels to @thomas/forgejo. */
export const extension = {
  type: "@thomas/forgejo",
  resources: {
    label: {
      description:
        "One label of an organization or a repository: id, name, color, description, exclusivity, and what label_ensure did to it.",
      schema: LabelInfo,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    label_ensure: {
      description:
        "Ensure the labels of an organization, or of one repository: create what is missing, patch what differs " +
        "in color, description or exclusivity, keep the rest; delete the others only with prune. One record per label.",
      arguments: LabelEnsureArgs,
      execute: async (args: LabelEnsureArgsT, context: Ctx) => {
        const labels = await labelEnsure(
          fetchCaller(context.globalArgs, context.signal),
          args,
        );
        return await record(context, labels);
      },
    },
    label_list: {
      description:
        "The labels of an organization, or of one repository, every page. Read-only.",
      arguments: LabelListArgs,
      execute: async (args: LabelListArgsT, context: Ctx) => {
        const a = LabelListArgs.parse(args);
        const s: Scope = { owner: a.owner, repo: a.name };
        const timestamp = new Date().toISOString();
        const labels = (await listLabels(
          fetchCaller(context.globalArgs, context.signal),
          s,
        )).map((l) => info(s, l, "listed", timestamp));
        return await record(context, labels);
      },
    },
  }],
};
