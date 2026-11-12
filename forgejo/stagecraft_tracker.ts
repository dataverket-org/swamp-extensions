/**
 * `@dataverket/forgejo/stagecraft-tracker`: the issues of one Forgejo (or
 * Gitea) repository as a stagecraft tracker, contract version 1 (stagecraft's
 * `TRACKERS.md`). stagecraft's publisher sits in front of it and keeps the
 * ledger, the cursor, the ticket index and the snapshots; this type answers
 * `describe` and `operate`, and reports its label scheme with `labels`; the
 * workflow `@dataverket/forgejo-stagecraft-labels` writes those labels through
 * the base type's `label_ensure`, so this type never manages labels itself.
 *
 * It shares the forge client with `@dataverket/forgejo`: the transport and
 * token masking of `api.ts`, and the label code of `labels.ts`.
 *
 * - A ticket is an issue. Its stable id is the issue's number (`34`), its
 *   display id `#34`; `fetch_issue` takes either. A pull request is not a
 *   ticket.
 * - A status is a label (`status/<name>`, exclusive) and an issue state: the
 *   label is always there, and the state follows it.
 * - A type is a label (`type/<name>`, exclusive), given at `create`.
 * - `blocked_by` is the forge's own issue dependency. `parent_of`,
 *   `related_to` and `duplicate_of` have no native form: they are kept in a
 *   block this tracker owns at the end of both issues' bodies, as lines a
 *   person reads, and the tracker enforces the contract's relation rules.
 * - `operate` never throws: every failure is an answer, and an answer that
 *   succeeded is never made again.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { type ApiResult, type Caller, fetchCaller, isFailure } from "./api.ts";
import { type Label, labelsForIssues } from "./labels.ts";

export type { Caller };

const enc = encodeURIComponent;

/** The contract version this tracker meets. */
export const CONTRACT = 1;

// ─────────────────────────── settings ───────────────────────────

const COLOR = /^#?[0-9a-fA-F]{6}$/;
/** A name; with its scope (`severity/`) it stays within the forge's 50 characters. */
const NAME = /^[a-z0-9][a-z0-9-]{0,39}$/;

const StatusSpec = z.object({
  name: z.string().regex(NAME).describe(
    "The status's name, as a publisher maps a factory's status keys to it.",
  ),
  state: z.enum(["open", "closed"]).describe(
    "The issue state that goes with it.",
  ),
  color: z.string().regex(COLOR),
  description: z.string().max(200).default("").describe(
    "The label's description; the labels workflow corrects one that differs.",
  ),
});
const LabelSpec = z.object({
  name: z.string().regex(NAME),
  color: z.string().regex(COLOR),
  description: z.string().max(200).default("").describe(
    "The label's description; the labels workflow corrects one that differs.",
  ),
});

const DEFAULT_STATUSES = [
  {
    name: "new",
    state: "open",
    color: "#bfd4f2",
    description: "A ticket nobody has started",
  },
  {
    name: "in-progress",
    state: "open",
    color: "#1d76db",
    description: "A work item is on it",
  },
  {
    name: "shipped",
    state: "closed",
    color: "#0e8a16",
    description: "Done and delivered",
  },
  {
    name: "closed",
    state: "closed",
    color: "#8b949e",
    description: "Closed without shipping",
  },
] as const;
const DEFAULT_TYPES = [
  { name: "feature", color: "#0e7490", description: "Something new" },
  { name: "bug", color: "#8250df", description: "Something that is wrong" },
  {
    name: "security",
    color: "#24292f",
    description: "A weakness or a hardening",
  },
  { name: "finding", color: "#bf8700", description: "A review finding" },
] as const;
const DEFAULT_SEVERITIES = [
  { name: "low", color: "#fef2c0", description: "A review finding: hygiene" },
  {
    name: "medium",
    color: "#fbca04",
    description: "A review finding: drift that does not ship a defect",
  },
  {
    name: "high",
    color: "#d93f0b",
    description: "A review finding: would ship a defect or break a stated rule",
  },
  {
    name: "critical",
    color: "#7f1d1d",
    description:
      "A review finding: loses data, crosses a tenant, or breaks a security rule",
  },
] as const;

const uniqueNames = (l: { name: string }[]) =>
  new Set(l.map((x) => x.name)).size === l.length;

const GlobalArgs = z.object({
  apiUrl: z.string().describe(
    "Forgejo base URL, e.g. https://git.example.com (no trailing /api/v1).",
  ),
  token: z.string().meta({ sensitive: true }).describe(
    "A token that may read and write the repository's issues. Supply via vault: " +
      "${{ vault.get(<vault>, <key>) }}",
  ),
  httpTimeoutMs: z.coerce.number().int().positive().default(30000).describe(
    "Per-request timeout (ms) for API calls.",
  ),
  owner: z.string().min(1).describe("The repository's owner."),
  repo: z.string().min(1).describe("The repository whose issues are tickets."),
  tracker: z.string().regex(/^[a-z][a-z0-9-]*$/).default("forgejo").describe(
    "The tracker's name: the tracker.kind a factory definition names and the " +
      "key work items keep ticket ids under. builtin, linear and swamp-club are taken.",
  ),
  statuses: z.array(StatusSpec).min(2).refine(uniqueNames, {
    message: "two statuses share a name",
  }).refine((l) => l.some((s) => s.state === "open"), {
    message: "a status with state open is needed",
  }).default([...DEFAULT_STATUSES]).describe(
    "Each status is a label status/<name> and an issue state. The first is " +
      "the status a new ticket is filed in, and must be open.",
  ),
  types: z.array(LabelSpec).min(1).refine(uniqueNames, {
    message: "two types share a name",
  }).default([...DEFAULT_TYPES]).describe(
    "The ticket types create takes, each a label type/<name>.",
  ),
  severities: z.array(LabelSpec).refine(uniqueNames, {
    message: "two severities share a name",
  }).default([...DEFAULT_SEVERITIES]).describe(
    "Severity labels severity/<name> in the scheme labels reports, mildest first.",
  ),
}).refine(
  (g) => g.statuses.length + g.types.length + g.severities.length <= 100,
  { message: "at most 100 statuses, types and severities together" },
).refine((g) => g.statuses[0].state === "open", {
  message: "the first status is the one a new ticket gets, and must be open",
});
/** The resolved global arguments. */
export type TrackerArgs = z.infer<typeof GlobalArgs>;

/** The settings, with every default applied; what the class below needs. */
export function settingsOf(raw: unknown): TrackerArgs {
  return GlobalArgs.parse(raw);
}

const statusLabel = (name: string) => `status/${name}`;
const typeLabel = (name: string) => `type/${name}`;
const severityLabel = (name: string) => `severity/${name}`;

// ─────────────────────────── contract shapes ───────────────────────────

/** The relation types of the contract. */
export const RELATION_TYPES = [
  "parent_of",
  "blocked_by",
  "related_to",
  "duplicate_of",
] as const;
/** One of {@link RELATION_TYPES}. */
export type RelationType = (typeof RELATION_TYPES)[number];
type Direction = "outgoing" | "incoming";

/** A relation as a ticket reports it: the other ticket, and which way it points. */
export interface Relation {
  type: RelationType;
  direction: Direction;
  issue: string;
  display: string;
}

/** A ticket as `fetch_issue` and `create` return it. */
export interface Ticket {
  id: string;
  display: string;
  title: string;
  url?: string;
  status: { id: string; name: string };
  relations: Relation[];
  description?: string;
  labels?: string[];
  assignees?: string[];
  createdAt?: string;
  updatedAt?: string;
  activity?: {
    kind: "comment";
    id: string;
    author?: string;
    body: string;
    at: string;
  }[];
}

/** The failure kinds of the contract. */
export const FAILURE_KINDS = [
  "auth",
  "not_found",
  "rate_limited",
  "invalid",
  "upstream",
] as const;
/** One of {@link FAILURE_KINDS}. */
export type FailureKind = (typeof FAILURE_KINDS)[number];

/** A failure as the contract states it; `operate` writes it as the answer. */
export class TrackerFailure extends Error {
  constructor(
    readonly kind: FailureKind,
    readonly detail: string,
    readonly reason?: "unreachable",
  ) {
    super(detail);
  }
}

const Id = z.string().min(1);
const REQUESTS = {
  fetch_issue: z.object({ issue: Id }),
  create: z.object({ title: Id, body: z.string(), type: Id }),
  comment: z.object({ issue: Id, body: z.string() }),
  set_status: z.object({ issue: Id, status: z.string() }),
  relate: z.object({ issue: Id, type: z.enum(RELATION_TYPES), to: Id }),
  unrelate: z.object({ issue: Id, type: z.enum(RELATION_TYPES), to: Id }),
} as const;
/** An operation this tracker offers. */
export type Operation = keyof typeof REQUESTS;
/** The six operations every tracker offers, and the only ones this one does. */
export const OPERATIONS = Object.keys(REQUESTS) as Operation[];

// ─────────────────────────── the relation block ───────────────────────────

const BLOCK_START = "<!-- stagecraft-relations: kept by the tracker -->";
const BLOCK_END = "<!-- /stagecraft-relations -->";

/** How each relation kept in the body reads, by direction. */
const BODY_LINES: Record<
  Exclude<RelationType, "blocked_by">,
  Record<Direction, string>
> = {
  parent_of: { outgoing: "Parent of", incoming: "Child of" },
  related_to: { outgoing: "Related to", incoming: "Related from" },
  duplicate_of: { outgoing: "Duplicate of", incoming: "Duplicated by" },
};
type BodyRelation = { type: Exclude<RelationType, "blocked_by"> } & {
  direction: Direction;
  issue: number;
};

/** The body split into what a person wrote and the relations the block holds. */
export function splitBody(
  body: string,
): { text: string; relations: BodyRelation[] } {
  const start = body.lastIndexOf(BLOCK_START);
  if (start === -1) return { text: body, relations: [] };
  const end = body.indexOf(BLOCK_END, start);
  const inner = body.slice(
    start + BLOCK_START.length,
    end === -1 ? undefined : end,
  );
  const tail = end === -1 ? "" : body.slice(end + BLOCK_END.length);
  const relations: BodyRelation[] = [];
  for (const raw of inner.split("\n")) {
    const m = raw.trim().match(/^(.+?):\s*#(\d+)$/);
    if (!m) continue;
    for (const [type, dirs] of Object.entries(BODY_LINES)) {
      for (const [direction, word] of Object.entries(dirs)) {
        if (word === m[1]) {
          relations.push({
            type: type as BodyRelation["type"],
            direction: direction as Direction,
            issue: Number(m[2]),
          });
        }
      }
    }
  }
  return {
    text: (body.slice(0, start) + tail).replace(/\s+$/, ""),
    relations,
  };
}

/** The body with the block rewritten to hold exactly these relations. */
export function joinBody(text: string, relations: BodyRelation[]): string {
  if (relations.length === 0) return text;
  const lines = [...relations]
    .sort((a, b) =>
      a.type.localeCompare(b.type) || a.direction.localeCompare(b.direction) ||
      a.issue - b.issue
    )
    .map((r) => `${BODY_LINES[r.type][r.direction]}: #${r.issue}`);
  return `${text.replace(/\s+$/, "")}\n\n${BLOCK_START}\n${
    lines.join("\n")
  }\n${BLOCK_END}`;
}

// ─────────────────────────── the forge ───────────────────────────

/** A failure kind for an HTTP status the forge answered with. */
export function kindOf(status: number): FailureKind {
  if (status === 401 || status === 403) return "auth";
  if (status === 404) return "not_found";
  if (status === 429) return "rate_limited";
  if (status === 400 || status === 409 || status === 422) return "invalid";
  return "upstream";
}

function messageOf(r: ApiResult): string {
  const b = r.body;
  return typeof b.message === "string"
    ? b.message
    : typeof b.raw === "string"
    ? b.raw
    : JSON.stringify(b);
}

interface RawIssue {
  number: number;
  title: string;
  body: string;
  state: string;
  url?: string;
  labels: string[];
  /** The issue's own labels by name, with the ids the forge gave them. */
  labelIds: Map<string, number>;
  assignees: string[];
  createdAt?: string;
  updatedAt?: string;
}

/** The longest parent chain walked for a loop, as stagecraft's own trackers do. */
const MAX_PARENT_DEPTH = 10;
const LIST_PAGE = 50;
const MAX_LIST_PAGES = 40;

/** An issue as the forge answers it, read into what the tracker needs. */
function rawOf(n: number, b: Record<string, unknown>): RawIssue {
  const objects = (v: unknown) =>
    (Array.isArray(v) ? v : []).filter((x): x is Record<string, unknown> =>
      !!x && typeof x === "object"
    );
  const labels = objects(b.labels).filter((l) => typeof l.name === "string");
  return {
    number: n,
    title: typeof b.title === "string" ? b.title : "",
    body: typeof b.body === "string" ? b.body : "",
    state: b.state === "closed" ? "closed" : "open",
    url: typeof b.html_url === "string" ? b.html_url : undefined,
    labels: labels.map((l) => l.name as string),
    labelIds: new Map(
      labels.filter((l) => typeof l.id === "number").map((
        l,
      ) => [l.name as string, l.id as number]),
    ),
    assignees: objects(b.assignees).flatMap((a) =>
      typeof a.login === "string" ? [a.login] : []
    ),
    createdAt: typeof b.created_at === "string" ? b.created_at : undefined,
    updatedAt: typeof b.updated_at === "string" ? b.updated_at : undefined,
  };
}

/** The tracker over one repository's issues. */
export class ForgeTracker {
  private labelCache?: Map<string, number>;

  constructor(private api: Caller, private s: TrackerArgs) {}

  private get base(): string {
    return `/api/v1/repos/${enc(this.s.owner)}/${enc(this.s.repo)}`;
  }

  /** One call; a 4xx/5xx becomes the failure of its kind, never a throw of another sort. */
  private async req(
    method: "GET" | "POST" | "PATCH" | "PUT" | "DELETE",
    path: string,
    body?: unknown,
    what = "the request",
  ): Promise<ApiResult> {
    let r: ApiResult;
    try {
      r = await this.api({ method, path: `${this.base}${path}`, body });
    } catch (e) {
      throw new TrackerFailure(
        "upstream",
        `${what}: the forge did not answer: ${
          e instanceof Error ? e.message : String(e)
        }`,
      );
    }
    if (isFailure(r.status)) {
      throw new TrackerFailure(
        kindOf(r.status),
        `${what}: HTTP ${r.status}: ${messageOf(r)}`,
      );
    }
    return r;
  }

  /** The issue number a stable id (`34`) or display id (`#34`) names. */
  numberOf(ref: string): number {
    const m = ref.trim().match(/^#?([1-9][0-9]{0,17})$/);
    if (!m) {
      throw new TrackerFailure(
        "invalid",
        `'${ref}' is not an issue of ${this.s.owner}/${this.s.repo}: ` +
          `a number (34) or #34`,
      );
    }
    return Number(m[1]);
  }

  private async rawIssue(n: number): Promise<RawIssue> {
    const r = await this.req("GET", `/issues/${n}`, undefined, `issue #${n}`)
      .catch((e) => {
        if (e instanceof TrackerFailure && e.kind === "not_found") {
          throw new TrackerFailure(
            "not_found",
            `no issue #${n} in ${this.s.owner}/${this.s.repo}`,
          );
        }
        throw e;
      });
    const b = r.body;
    if (b.pull_request !== undefined && b.pull_request !== null) {
      throw new TrackerFailure(
        "not_found",
        `#${n} in ${this.s.owner}/${this.s.repo} is a pull request, not an issue`,
      );
    }
    return rawOf(n, b);
  }

  /** The issue numbers a dependency list holds, of this repository only, every page. */
  private async linked(n: number, which: "dependencies" | "blocks") {
    const out: number[] = [];
    const same = (a: unknown, b: string) =>
      typeof a === "string" && a.toLowerCase() === b.toLowerCase();
    for (let page = 1; page <= MAX_LIST_PAGES; page++) {
      let r: ApiResult;
      try {
        r = await this.req(
          "GET",
          `/issues/${n}/${which}?limit=${LIST_PAGE}&page=${page}`,
          undefined,
          `the ${which} of #${n}`,
        );
      } catch (e) {
        // The issue exists (it was read first): a 404 here means the
        // repository has issue dependencies switched off, so it has none.
        if (e instanceof TrackerFailure && e.kind === "not_found") return out;
        throw e;
      }
      const items = Array.isArray(r.body) ? r.body as unknown[] : [];
      for (const x of items) {
        if (!x || typeof x !== "object") continue;
        const o = x as Record<string, unknown>;
        const repo = o.repository as Record<string, unknown> | undefined;
        const sameRepo = repo === undefined ||
          (same(repo.owner, this.s.owner) && same(repo.name, this.s.repo)) ||
          same(repo.full_name, `${this.s.owner}/${this.s.repo}`);
        if (typeof o.number === "number" && sameRepo) out.push(o.number);
      }
      if (items.length < LIST_PAGE) break;
    }
    return out;
  }

  private statusOf(raw: RawIssue): { id: string; name: string } {
    const named = this.s.statuses.find((s) =>
      raw.labels.includes(statusLabel(s.name))
    );
    // A status label is always there when this tracker made the issue; an
    // issue filed by hand falls back to the first status of its state.
    const s = named ??
      this.s.statuses.find((x) => x.state === raw.state) ??
      this.s.statuses[0];
    return { id: s.name, name: s.name };
  }

  private async relationsOf(raw: RawIssue): Promise<Relation[]> {
    const out: Relation[] = [];
    const push = (type: RelationType, direction: Direction, n: number) =>
      out.push({ type, direction, issue: String(n), display: `#${n}` });
    for (const n of await this.linked(raw.number, "dependencies")) {
      push("blocked_by", "outgoing", n);
    }
    for (const n of await this.linked(raw.number, "blocks")) {
      push("blocked_by", "incoming", n);
    }
    for (const r of splitBody(raw.body).relations) {
      push(r.type, r.direction, r.issue);
    }
    return out;
  }

  private async activityOf(
    n: number,
  ): Promise<NonNullable<Ticket["activity"]>> {
    // The forge answers every comment at once: this endpoint takes no page.
    const r = await this.req(
      "GET",
      `/issues/${n}/comments`,
      undefined,
      `the comments of #${n}`,
    );
    const out: NonNullable<Ticket["activity"]> = [];
    const seen = new Set<string>();
    for (const x of Array.isArray(r.body) ? r.body as unknown[] : []) {
      if (!x || typeof x !== "object") continue;
      const c = x as Record<string, unknown>;
      if (typeof c.id !== "number" || seen.has(String(c.id))) continue;
      seen.add(String(c.id));
      const user = c.user as Record<string, unknown> | undefined;
      out.push({
        kind: "comment",
        id: String(c.id),
        ...(typeof user?.login === "string" ? { author: user.login } : {}),
        body: typeof c.body === "string" ? c.body : "",
        at: typeof c.created_at === "string" ? c.created_at : "",
      });
    }
    return out;
  }

  private async ticket(n: number): Promise<Ticket> {
    const raw = await this.rawIssue(n);
    return this.view(
      raw,
      await this.relationsOf(raw),
      await this.activityOf(n),
    );
  }

  private view(
    raw: RawIssue,
    relations: Relation[],
    activity: NonNullable<Ticket["activity"]>,
  ): Ticket {
    const n = raw.number;
    const { text } = splitBody(raw.body);
    return {
      id: String(n),
      display: `#${n}`,
      title: raw.title,
      ...(raw.url ? { url: raw.url } : {}),
      status: this.statusOf(raw),
      relations,
      description: text,
      labels: raw.labels,
      assignees: raw.assignees,
      ...(raw.createdAt ? { createdAt: raw.createdAt } : {}),
      ...(raw.updatedAt ? { updatedAt: raw.updatedAt } : {}),
      activity,
    };
  }

  /** Label ids by name, from the repository and its organization. */
  private async labelIds(names: string[]): Promise<number[]> {
    if (!this.labelCache) {
      let all: Label[];
      try {
        all = await labelsForIssues(this.api, this.s.owner, this.s.repo);
      } catch (e) {
        const m = e instanceof Error ? e.message : String(e);
        const status = Number(m.match(/HTTP (\d{3})/)?.[1] ?? 0);
        throw new TrackerFailure(
          status ? kindOf(status) : "upstream",
          `the labels: ${m}`,
        );
      }
      this.labelCache = new Map();
      for (const l of all) {
        if (!this.labelCache.has(l.name)) this.labelCache.set(l.name, l.id);
      }
    }
    const missing = names.filter((x) => !this.labelCache!.has(x));
    if (missing.length > 0) {
      throw new TrackerFailure(
        "invalid",
        `label(s) ${
          missing.join(", ")
        } do not exist on ${this.s.owner}/${this.s.repo}; ` +
          `the labels workflow @dataverket/forgejo-stagecraft-labels makes them`,
      );
    }
    return names.map((x) => this.labelCache!.get(x)!);
  }

  // ───── the operations ─────

  async fetchIssue(ref: string): Promise<Ticket> {
    return await this.ticket(this.numberOf(ref));
  }

  async create(title: string, body: string, type: string): Promise<Ticket> {
    if (!this.s.types.some((t) => t.name === type)) {
      throw new TrackerFailure(
        "invalid",
        `no type '${type}': ${this.s.types.map((t) => t.name).join(", ")}`,
      );
    }
    const first = this.s.statuses[0];
    const labels = await this.labelIds([
      statusLabel(first.name),
      typeLabel(type),
    ]);
    const r = await this.req(
      "POST",
      "/issues",
      { title, body, labels },
      "create",
    );
    const n = r.body.number;
    if (typeof n !== "number") {
      throw new TrackerFailure(
        "upstream",
        "the forge answered the create without an issue number",
      );
    }
    // From the forge's answer, not a second read: once the issue is filed,
    // nothing after it may turn the create into a failure, which a retry
    // would file again. A new issue has no comments, and its relations are
    // the ones its body holds.
    const raw = rawOf(n, r.body);
    return this.view(
      raw,
      splitBody(raw.body).relations.map((x) => ({
        type: x.type,
        direction: x.direction,
        issue: String(x.issue),
        display: `#${x.issue}`,
      })),
      [],
    );
  }

  async comment(
    ref: string,
    body: string,
  ): Promise<{ id: string; url?: string }> {
    const n = this.numberOf(ref);
    await this.rawIssue(n);
    const r = await this.req(
      "POST",
      `/issues/${n}/comments`,
      { body },
      `a comment on #${n}`,
    );
    if (typeof r.body.id !== "number") {
      throw new TrackerFailure(
        "upstream",
        "the forge answered the comment without an id",
      );
    }
    return {
      id: String(r.body.id),
      ...(typeof r.body.html_url === "string" ? { url: r.body.html_url } : {}),
    };
  }

  async setStatus(
    ref: string,
    name: string,
  ): Promise<{ changed: boolean; status: { id: string; name: string } }> {
    const want = this.s.statuses.find((s) => s.name === name);
    if (!want) {
      throw new TrackerFailure(
        "invalid",
        `no status '${name}': ${this.s.statuses.map((s) => s.name).join(", ")}`,
      );
    }
    const n = this.numberOf(ref);
    const raw = await this.rawIssue(n);
    const label = statusLabel(want.name);
    const others = this.s.statuses
      .map((s) => statusLabel(s.name))
      .filter((l) => l !== label && raw.labels.includes(l));
    const needLabel = !raw.labels.includes(label);
    const needState = raw.state !== want.state;
    const status = { id: want.name, name: want.name };
    if (!needLabel && others.length === 0 && !needState) {
      return { changed: false, status };
    }
    if (needLabel) {
      const [id] = await this.labelIds([label]);
      await this.req(
        "POST",
        `/issues/${n}/labels`,
        { labels: [id] },
        `the status label of #${n}`,
      );
    }
    for (const id of others.map((l) => raw.labelIds.get(l)!)) {
      await this.req(
        "DELETE",
        `/issues/${n}/labels/${id}`,
        undefined,
        `the old status label of #${n}`,
      );
    }
    if (needState) {
      await this.req(
        "PATCH",
        `/issues/${n}`,
        { state: want.state },
        `the state of #${n}`,
      );
    }
    return { changed: true, status };
  }

  /** Whether `from type to` is there, read from either side. */
  private has(
    from: Ticket,
    type: RelationType,
    to: Ticket,
  ): boolean {
    return from.relations.some((r) =>
      r.type === type && r.direction === "outgoing" && r.issue === to.id
    ) ||
      to.relations.some((r) =>
        r.type === type && r.direction === "incoming" && r.issue === from.id
      );
  }

  /** Refuse, as invalid, a new relation that breaks one of the contract's rules. */
  private async checkRules(from: Ticket, type: RelationType, to: Ticket) {
    const refuse = (why: string): never => {
      throw new TrackerFailure(
        "invalid",
        `${from.display} ${type} ${to.display}: ${why}`,
      );
    };
    if (from.id === to.id) refuse("a ticket is not related to itself");
    const out = (t: Ticket, ty: RelationType) =>
      t.relations.filter((r) => r.type === ty && r.direction === "outgoing");
    const inc = (t: Ticket, ty: RelationType) =>
      t.relations.filter((r) => r.type === ty && r.direction === "incoming");
    if (type === "parent_of") {
      if (inc(to, "parent_of").length > 0) {
        refuse(`${to.display} has a parent already`);
      }
      // Walk up from the new parent: reaching the child is a loop.
      let cur: Ticket = from;
      for (let depth = 0; depth < MAX_PARENT_DEPTH; depth++) {
        const up = inc(cur, "parent_of")[0];
        if (!up) break;
        if (up.issue === to.id) refuse("the parent chain would loop");
        cur = await this.ticket(Number(up.issue));
      }
    }
    if (type === "duplicate_of") {
      if (out(from, "duplicate_of").length > 0) {
        refuse(`${from.display} is a duplicate of another ticket already`);
      }
      if (out(to, "duplicate_of").length > 0) {
        refuse(`${to.display} is itself a duplicate`);
      }
      if (inc(from, "duplicate_of").length > 0) {
        refuse(`${from.display} has duplicates, so it cannot become one`);
      }
    }
  }

  private async rewriteBlock(
    n: number,
    change: (rels: BodyRelation[]) => BodyRelation[],
  ) {
    const raw = await this.rawIssue(n);
    const { text, relations } = splitBody(raw.body);
    const body = joinBody(text, change(relations));
    if (body === raw.body) return;
    await this.req(
      "PATCH",
      `/issues/${n}`,
      { body },
      `the relations of #${n}`,
    );
  }

  async relate(
    fromRef: string,
    type: RelationType,
    toRef: string,
  ): Promise<{ changed: boolean }> {
    const from = await this.ticket(this.numberOf(fromRef));
    const to = await this.ticket(this.numberOf(toRef));
    const onFrom = from.relations.some((r) =>
      r.type === type && r.direction === "outgoing" && r.issue === to.id
    );
    const onTo = to.relations.some((r) =>
      r.type === type && r.direction === "incoming" && r.issue === from.id
    );
    const f = Number(from.id), t = Number(to.id);
    if (from.id !== to.id && (onFrom || onTo)) {
      if (type === "blocked_by" || (onFrom && onTo)) return { changed: false };
      // Half written: an earlier relate wrote one body and failed on the
      // other. Check the rules as if the relation were new, since the other
      // side may have changed meanwhile, then write the side that is missing.
      // Only this relation's own lines are set aside; an inverse relation
      // between the two stays, so a loop or a mutual duplicate is refused.
      const without = (
        t: Ticket,
        direction: Direction,
        other: string,
      ): Ticket => ({
        ...t,
        relations: t.relations.filter((r) =>
          !(r.type === type && r.direction === direction && r.issue === other)
        ),
      });
      await this.checkRules(
        without(from, "outgoing", to.id),
        type,
        without(to, "incoming", from.id),
      );
      if (!onFrom) await this.addLine(f, type, "outgoing", t);
      if (!onTo) await this.addLine(t, type, "incoming", f);
      return { changed: true };
    }
    await this.checkRules(from, type, to);
    if (type === "blocked_by") {
      try {
        await this.req(
          "POST",
          `/issues/${f}/dependencies`,
          { owner: this.s.owner, repo: this.s.repo, index: t },
          `#${f} blocked by #${t}`,
        );
      } catch (e) {
        // Both issues were read just now: a 404 here means the repository
        // has issue dependencies switched off, not that a ticket is missing.
        if (e instanceof TrackerFailure && e.kind === "not_found") {
          throw new TrackerFailure(
            "invalid",
            `${this.s.owner}/${this.s.repo} has issue dependencies switched off, so blocked_by cannot be kept`,
          );
        }
        throw e;
      }
      return { changed: true };
    }
    await this.addLine(f, type, "outgoing", t);
    await this.addLine(t, type, "incoming", f);
    return { changed: true };
  }

  private async addLine(
    n: number,
    type: Exclude<RelationType, "blocked_by">,
    direction: Direction,
    other: number,
  ) {
    await this.rewriteBlock(
      n,
      (rels) =>
        rels.some((r) =>
            r.type === type && r.direction === direction && r.issue === other
          )
          ? rels
          : [...rels, { type, direction, issue: other }],
    );
  }

  async unrelate(
    fromRef: string,
    type: RelationType,
    toRef: string,
  ): Promise<{ changed: boolean }> {
    const from = await this.ticket(this.numberOf(fromRef));
    const to = await this.ticket(this.numberOf(toRef));
    if (!this.has(from, type, to)) return { changed: false };
    const f = Number(from.id), t = Number(to.id);
    if (type === "blocked_by") {
      await this.req(
        "DELETE",
        `/issues/${f}/dependencies`,
        { owner: this.s.owner, repo: this.s.repo, index: t },
        `#${f} no longer blocked by #${t}`,
      );
      return { changed: true };
    }
    const drop = (n: number, direction: Direction, other: number) =>
      this.rewriteBlock(
        n,
        (rels) =>
          rels.filter((r) =>
            !(r.type === type && r.direction === direction && r.issue === other)
          ),
      );
    await drop(f, "outgoing", t);
    await drop(t, "incoming", f);
    return { changed: true };
  }

  /** One operation with its request already checked. */
  async perform(op: Operation, req: Record<string, unknown>) {
    const s = (k: string) => req[k] as string;
    switch (op) {
      case "fetch_issue":
        return await this.fetchIssue(s("issue"));
      case "create":
        return await this.create(s("title"), s("body"), s("type"));
      case "comment":
        return await this.comment(s("issue"), s("body"));
      case "set_status":
        return await this.setStatus(s("issue"), s("status"));
      case "relate":
        return await this.relate(s("issue"), req.type as RelationType, s("to"));
      case "unrelate":
        return await this.unrelate(
          s("issue"),
          req.type as RelationType,
          s("to"),
        );
    }
  }
}

// ─────────────────────────── operate ───────────────────────────

/** What `operate` writes: the result, or the failure. */
export type Answer =
  & { operation: string; run?: string }
  & (
    | { ok: true; result: Record<string, unknown> }
    | { ok: false; kind: FailureKind; reason?: "unreachable"; detail: string }
  );

/**
 * One operation, made and answered. Never throws: a request that does not
 * parse, an operation this tracker does not offer and every forge failure
 * are answers too.
 */
export async function answer(
  tracker: ForgeTracker,
  operation: string,
  request: unknown,
  run?: string,
): Promise<Answer> {
  const head = { operation, ...(run === undefined ? {} : { run }) };
  try {
    if (!(OPERATIONS as string[]).includes(operation)) {
      throw new TrackerFailure(
        "invalid",
        `this tracker does not offer '${operation}': ${OPERATIONS.join(", ")}`,
      );
    }
    let raw: unknown = request;
    if (typeof request === "string") {
      try {
        raw = JSON.parse(request);
      } catch {
        throw new TrackerFailure("invalid", "the request is not a JSON object");
      }
    }
    const parsed = REQUESTS[operation as Operation].safeParse(raw);
    if (!parsed.success) {
      throw new TrackerFailure(
        "invalid",
        `a ${operation} request does not take this: ${
          z.prettifyError(parsed.error)
        }`,
      );
    }
    const result = await tracker.perform(
      operation as Operation,
      parsed.data as Record<string, unknown>,
    );
    return {
      ...head,
      ok: true,
      result: result as unknown as Record<string, unknown>,
    };
  } catch (e) {
    const f = e instanceof TrackerFailure ? e : new TrackerFailure(
      "upstream",
      e instanceof Error ? e.message : String(e),
    );
    return {
      ...head,
      ok: false,
      kind: f.kind,
      ...(f.reason ? { reason: f.reason } : {}),
      detail: f.detail,
    };
  }
}

/** What `describe` writes. */
export function description(s: TrackerArgs) {
  return {
    tracker: s.tracker,
    contract: CONTRACT,
    origin: "snapshot" as const,
    capabilities: { history: false, assign: false, pullRequests: false },
    closesDuplicates: false,
  };
}

/** The labels this tracker needs, as `label_ensure` takes them. */
export function trackerLabels(s: TrackerArgs) {
  return [
    ...s.statuses.map((x) => ({
      name: statusLabel(x.name),
      color: x.color,
      description: x.description,
      exclusive: true,
    })),
    ...s.types.map((x) => ({
      name: typeLabel(x.name),
      color: x.color,
      description: x.description,
      exclusive: true,
    })),
    ...s.severities.map((x) => ({
      name: severityLabel(x.name),
      color: x.color,
      description: x.description,
      exclusive: true,
    })),
  ];
}

// ─────────────────────────── the model ───────────────────────────

const ANSWER_NAME = /^answer-[A-Za-z0-9._-]+$/;

const OperateArgs = z.object({
  operation: z.string().min(1).describe(
    "The operation: fetch_issue, create, comment, set_status, relate or unrelate",
  ),
  request: z.union([z.record(z.string(), z.unknown()), z.string()]).describe(
    "The operation's request: an object, or a JSON object as a string",
  ),
  answer: z.string().regex(ANSWER_NAME).describe(
    "The record to write the answer under (answer-...)",
  ),
  run: z.string().optional().describe(
    "The run asking, recorded with the answer",
  ),
});

const AnswerInfo = z.object({
  operation: z.string(),
  run: z.string().optional(),
  ok: z.boolean(),
  result: z.record(z.string(), z.unknown()).optional(),
  kind: z.enum(FAILURE_KINDS).optional(),
  reason: z.literal("unreachable").optional(),
  detail: z.string().optional(),
});

const DescriptionInfo = z.object({
  tracker: z.string(),
  contract: z.number(),
  origin: z.literal("snapshot"),
  capabilities: z.object({
    history: z.boolean(),
    assign: z.boolean(),
    pullRequests: z.boolean(),
  }),
  closesDuplicates: z.boolean(),
});

const TrackerLabelsInfo = z.object({
  owner: z.string(),
  repo: z.string(),
  labels: z.array(z.object({
    name: z.string(),
    color: z.string(),
    description: z.string(),
    exclusive: z.boolean(),
  })).describe("The scheme, in the form label_ensure takes"),
  timestamp: z.string(),
});

interface Ctx {
  globalArgs: unknown;
  signal?: AbortSignal;
  /** The injectable client of swamp's testing guide; swamp never sets it. */
  forgejoClient?: Caller;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
  readResource?(name: string): Promise<Record<string, unknown> | null>;
}

/** The client for these settings: the injected one in a unit test, else the forge. */
function clientOf(context: Ctx, s: TrackerArgs): Caller {
  return context.forgejoClient ?? fetchCaller(
    { apiUrl: s.apiUrl, token: s.token, httpTimeoutMs: s.httpTimeoutMs },
    context.signal,
  );
}

function trackerOf(context: Ctx, s: TrackerArgs): ForgeTracker {
  return new ForgeTracker(clientOf(context, s), s);
}

/** `@dataverket/forgejo/stagecraft-tracker`. */
export const model = {
  type: "@dataverket/forgejo/stagecraft-tracker",
  version: "2026.11.12.2",
  globalArguments: GlobalArgs,
  upgrades: [
    {
      toVersion: "2026.11.12.1",
      description:
        "The type's first published version; global arguments as they are",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.11.12.2",
      description:
        "README: the merge settings a stagecraft repository needs; no code change",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  resources: {
    answer: {
      description:
        "operate's answers: each operation's result or failure, under the name the caller gave",
      schema: AnswerInfo,
      lifetime: "infinite" as const,
      garbageCollection: "30d",
    },
    description: {
      description:
        "What the tracker says of itself: its name, contract version and capabilities",
      schema: DescriptionInfo,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    trackerLabels: {
      description:
        "The tracker's label scheme from its settings, in the form the base type's label_ensure takes",
      schema: TrackerLabelsInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    describe: {
      description:
        "Say what this tracker is: its name, contract 1, origin snapshot, no optional capabilities. " +
        "Run once after creating the instance and after changing what it reports.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const s = settingsOf(context.globalArgs);
        const d = description(s);
        context.logger.info("{tracker} tracker, contract {contract}", {
          tracker: d.tracker,
          contract: d.contract,
        });
        const h = await context.writeResource("description", "description", d);
        return { dataHandles: [h] };
      },
    },
    operate: {
      description:
        "Make one tracker operation on the repository's issues and write its answer (the result, or the failure) " +
        "under the given name; an answer already there that succeeded is kept and nothing is made again.",
      arguments: OperateArgs,
      execute: async (args: z.infer<typeof OperateArgs>, context: Ctx) => {
        if (context.readResource === undefined) {
          throw new Error(
            "this method context has no readResource, so an answer already made cannot be found",
          );
        }
        const prior = await context.readResource(args.answer);
        if (prior !== null && prior.ok === true) {
          context.logger.info("{answer} already answered; made nothing", {
            answer: args.answer,
          });
          return { dataHandles: [] };
        }
        let a: Answer;
        try {
          const s = settingsOf(context.globalArgs);
          a = await answer(
            trackerOf(context, s),
            args.operation,
            args.request,
            args.run,
          );
        } catch (e) {
          // settings that do not parse are a failure too, written as one
          a = {
            operation: args.operation,
            ...(args.run === undefined ? {} : { run: args.run }),
            ok: false,
            kind: "invalid",
            detail: `the tracker's settings: ${
              e instanceof Error ? e.message : String(e)
            }`,
          };
        }
        if (!a.ok) {
          context.logger.info("{operation} failed: {kind}: {detail}", {
            operation: a.operation,
            kind: a.kind,
            detail: a.detail,
          });
        }
        const h = await context.writeResource("answer", args.answer, a);
        return { dataHandles: [h] };
      },
    },
    labels: {
      description:
        "Record the tracker's label scheme (status/, type/ and severity/ labels, exclusive) from its settings, " +
        "in the form the base type's label_ensure takes. Calls no forge; the workflow " +
        "@dataverket/forgejo-stagecraft-labels writes the labels.",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, context: Ctx) => {
        const s = settingsOf(context.globalArgs);
        const labels = trackerLabels(s);
        context.logger.info("Label scheme of {repo}: {count} labels", {
          repo: `${s.owner}/${s.repo}`,
          count: labels.length,
        });
        const h = await context.writeResource(
          "trackerLabels",
          "tracker-labels",
          {
            owner: s.owner,
            repo: s.repo,
            labels,
            timestamp: new Date().toISOString(),
          },
        );
        return { dataHandles: [h] };
      },
    },
  },
};
