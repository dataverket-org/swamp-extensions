/**
 * Adds `work_item_sync` to `@dataverket/forgejo`: mirror one
 * `@swamp/software-factory` work item into one Forgejo issue.
 *
 * A marked section of the issue body is rewritten from the factory's records
 * on every run (stage, outcome, decisions, blocking review findings, pull
 * request, merge); text outside it, such as a person's description of the
 * issue, is kept. A comment is posted only when the stage changed or a new
 * blocking finding appeared since the last run, and the issue is closed when
 * the work item is done or aborted. One direction only: nothing in the issue
 * flows back into the factory.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { call, type Caller, fetchCaller, type GlobalArgs } from "./api.ts";

const enc = encodeURIComponent;
const safeName = (s: string) => s.replace(/[\\/]/g, ":");

const SyncArgs = z.object({
  owner: z.string().min(1).describe("Owning org or user login."),
  name: z.string().min(1).describe("Repository name."),
  factory: z.string().min(1).describe(
    "The @swamp/software-factory model that runs the work item.",
  ),
  workItem: z.string().min(1).describe("The work item to mirror."),
  issue: z.coerce.number().int().nonnegative().default(0).describe(
    "Adopt this existing issue on the first sync instead of creating one (0: create one). Ignored once the work item is linked.",
  ),
});
/** {@link SyncArgs} */
export type SyncArgsT = z.infer<typeof SyncArgs>;

const Link = z.object({
  workItem: z.string(),
  repo: z.string(),
  issue: z.number().int(),
  url: z.string(),
  stage: z.string(),
  status: z.string(),
  blocking: z.array(z.string()),
  syncedAt: z.string(),
});
/** The issue a work item is mirrored into, as last synced. */
export type Link = z.infer<typeof Link>;

type Raw = Record<string, unknown>;

/** A work item's state record and its artifact or evidence payloads by name. */
export interface WorkItemRecords {
  state: Raw | undefined;
  payload: (name: string) => Raw | undefined;
}

/** The section markers in the issue body. */
export const START = "<!-- swamp-factory:start -->";
export const END = "<!-- swamp-factory:end -->";

/** Unresolved critical and high findings of the given review artifacts. */
export function blocking(...reviews: (Raw | undefined)[]): string[] {
  const out: string[] = [];
  for (const r of reviews) {
    for (const f of (r?.findings ?? []) as Raw[]) {
      const sev = String(f.severity ?? "").toLowerCase();
      if ((sev === "critical" || sev === "high") && f.resolved !== true) {
        out.push(`${f.id}: ${String(f.description ?? f.summary ?? "")}`);
      }
    }
  }
  return out;
}

/** The issue-body section for a work item. */
export function render(
  factory: string,
  wi: string,
  stage: string,
  status: string,
  p: (n: string) => Raw | undefined,
  blockers: string[],
): string {
  const plan = p("plan");
  const lines = [
    START,
    `**Work item** \`${wi}\` in the \`${factory}\` factory · **stage** \`${stage}\`${
      status === "terminal" ? " (finished)" : ""
    }`,
    "",
  ];
  if (plan?.outcome) lines.push("## Outcome", "", String(plan.outcome), "");
  const decisions = (plan?.decisions ?? []) as Raw[];
  if (decisions.length) {
    lines.push("## Decisions", "");
    for (const d of decisions) {
      lines.push(`- **${d.id}** ${d.question} → ${d.choice}`);
    }
    lines.push("");
  }
  if (blockers.length) {
    lines.push("## Blocking review findings", "");
    for (const b of blockers) lines.push(`- ${b}`);
    lines.push("");
  }
  const pr = p("pull-request"), merge = p("merge");
  const change = p("change-summary");
  const facts: string[] = [];
  if (plan?.totalEstimatedLoc !== undefined) {
    facts.push(
      `- Estimated production LOC: ${plan.totalEstimatedLoc}${
        change?.totalLoc !== undefined ? ` · actual: ${change.totalLoc}` : ""
      }`,
    );
  }
  if (pr?.url) facts.push(`- Pull request: ${pr.url}`);
  if (merge?.mergeSha) {
    facts.push(
      `- Merged as \`${
        String(merge.mergeSha).slice(0, 7)
      }\` by ${merge.mergedBy}`,
    );
  }
  if (facts.length) lines.push("## Progress", "", ...facts, "");
  lines.push(
    `_Mirrored from the \`${factory}\` factory by \`work_item_sync\`; edits inside this section are overwritten._`,
    END,
  );
  return lines.join("\n");
}

/** Replace the factory section of an issue body, or append one. */
export function mergeSection(existing: string, section: string): string {
  const i = existing.indexOf(START), j = existing.indexOf(END);
  if (i >= 0 && j > i) {
    return existing.slice(0, i) + section + existing.slice(j + END.length);
  }
  return existing.trim()
    ? `${existing.trimEnd()}\n\n---\n\n${section}`
    : section;
}

/** Create or update the work item's issue, comment on changes, return the link. */
export async function syncIssue(
  api: Caller,
  a: SyncArgsT,
  recs: WorkItemRecords,
  last: Link | undefined,
): Promise<Link> {
  if (!recs.state) {
    throw new Error(
      `${a.factory} has no work item ${a.workItem}; start it before syncing`,
    );
  }
  const repo = `${a.owner}/${a.name}`;
  const base = `/api/v1/repos/${enc(a.owner)}/${enc(a.name)}/issues`;
  const stage = String(recs.state.stageId);
  const status = String(recs.state.status);
  const blockers = blocking(
    recs.payload("plan-review"),
    recs.payload("code-review"),
  );
  const section = render(
    a.factory,
    a.workItem,
    stage,
    status,
    recs.payload,
    blockers,
  );
  // The title is the work item and the first sentence of its outcome; a
  // title that is still the bare work item gets it once a plan exists.
  const plan = recs.payload("plan");
  const title = plan?.outcome
    ? `${a.workItem}: ${
      String(plan.outcome).split(/(?<=\.)\s/)[0].slice(0, 200)
    }`
    : a.workItem;

  let issue = last?.issue ?? (a.issue || undefined);
  let url: string;
  if (issue === undefined) {
    const created = await call(api, {
      method: "POST",
      path: base,
      body: { title, body: section },
    });
    issue = Number(created.body.number);
    url = String(created.body.html_url);
    if (status === "terminal") {
      await call(api, {
        method: "PATCH",
        path: `${base}/${issue}`,
        body: { state: "closed" },
      });
    }
  } else {
    const current = await call(api, {
      method: "GET",
      path: `${base}/${issue}`,
    });
    const updated = await call(api, {
      method: "PATCH",
      path: `${base}/${issue}`,
      body: {
        ...(current.body.title === a.workItem && title !== a.workItem
          ? { title }
          : {}),
        body: mergeSection(String(current.body.body ?? ""), section),
        state: status === "terminal" ? "closed" : "open",
      },
    });
    url = String(updated.body.html_url);
  }

  const notes: string[] = [];
  if (last && last.stage !== stage) {
    notes.push(`Stage: \`${last.stage}\` → \`${stage}\``);
  }
  const fresh = blockers.filter((b) => !(last?.blocking ?? []).includes(b));
  if (fresh.length) {
    notes.push("New blocking findings:", ...fresh.map((b) => `- ${b}`));
  }
  if (notes.length) {
    await call(api, {
      method: "POST",
      path: `${base}/${issue}/comments`,
      body: { body: notes.join("\n") },
    });
  }

  return {
    workItem: a.workItem,
    repo,
    issue,
    url,
    stage,
    status,
    blocking: blockers,
    syncedAt: new Date().toISOString(),
  };
}

interface Ctx {
  globalArgs: GlobalArgs;
  signal?: AbortSignal;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  readResource(name: string): Promise<Record<string, unknown> | null>;
  readModelData(
    model: string,
    spec?: string,
  ): Promise<{ name: string; attributes: unknown }[]>;
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<{ name: string }>;
}

/** The work item's records in the factory, by record name. */
async function records(
  ctx: Ctx,
  factory: string,
  wi: string,
): Promise<WorkItemRecords> {
  const byName = new Map<string, Raw>();
  for (const r of await ctx.readModelData(factory)) {
    byName.set(r.name, r.attributes as Raw);
  }
  // An artifact (plan, reviews, change-summary) or evidence (pull-request,
  // merge) record of the work item, by its name in the factory definition.
  const payload = (n: string) =>
    ((byName.get(`artifact-${wi}-${n}`) ?? byName.get(`evidence-${wi}-${n}`))
      ?.payload ?? undefined) as Raw | undefined;
  return { state: byName.get(`state-${wi}`), payload };
}

/** Extension mirroring software-factory work items into Forgejo issues. */
export const extension = {
  type: "@dataverket/forgejo",
  resources: {
    workItemIssue: {
      description: "The Forgejo issue a factory work item is mirrored into.",
      schema: Link,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: [{
    work_item_sync: {
      description:
        "Mirror a software-factory work item into its Forgejo issue: create or adopt the issue, rewrite its body from the factory's records, comment on stage changes and new blocking findings, and close it when the work item is done or aborted. Idempotent apart from those comments.",
      arguments: SyncArgs,
      execute: async (args: SyncArgsT, context: Ctx) => {
        const a = SyncArgs.parse(args);
        context.logger.info("Syncing {workItem} from {factory}", {
          workItem: a.workItem,
          factory: a.factory,
        });
        const linkName = safeName(
          `${a.owner}/${a.name}:workitem:${a.workItem}`,
        );
        const prev = Link.safeParse(await context.readResource(linkName));
        const link = await syncIssue(
          fetchCaller(context.globalArgs, context.signal),
          a,
          await records(context, a.factory, a.workItem),
          prev.success ? prev.data : undefined,
        );
        context.logger.info("{workItem} -> {repo}#{issue} at {stage}", {
          workItem: link.workItem,
          repo: link.repo,
          issue: link.issue,
          stage: link.stage,
        });
        const handle = await context.writeResource(
          "workItemIssue",
          linkName,
          link,
        );
        return { dataHandles: [handle] };
      },
    },
  }],
};
