/**
 * `@dataverket/gateway-api/httproute`: HTTPRoute objects of the Kubernetes
 * Gateway API, read with kubectl. `list` records every HTTPRoute of a
 * namespace or of the cluster and an inventory of what it saw; `get` records
 * one.
 *
 * A record holds the hostnames, the parents the route asks for, its rules
 * with matches and backends, what each controller reported per parent, and a
 * summary a workflow asserts on without parsing text. A route no Gateway
 * accepts, or whose backend does not resolve, is recorded, never thrown; only
 * a call that could not be made fails the method.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  arr,
  assertDistinctDataNames,
  checkName,
  ConditionSchema,
  conditionState,
  dataName,
  findCondition,
  inventoryName,
  kubectlCliCheck,
  KubectlGlobalArgsSchema,
  listNamespace,
  numOrNull,
  obj,
  readConditions,
  readMeta,
  requireNamespace,
  strOrNull,
} from "../lib/kubectl.ts";
import {
  conditionsCurrent,
  getObject,
  GROUP,
  listInventory,
  ListInventorySchema,
  listObjects,
  type MethodContext,
  reasonLine,
  warnOnVersions,
} from "./_helpers.ts";

/** The resource, by its full group, as kubectl is asked for it. */
export const RESOURCE = `httproutes.${GROUP}`;

const ParentRefSchema = z.object({
  group: z.string(),
  kind: z.string(),
  namespace: z.string().describe(
    "The parent's namespace; the route's own when none is written",
  ),
  name: z.string(),
  sectionName: z.string().nullable().describe(
    "The listener asked for; null attaches to every listener that allows it",
  ),
  port: z.number().nullable(),
});

type ParentRef = z.infer<typeof ParentRefSchema>;

const MatchSchema = z.object({
  path: z.object({ type: z.string(), value: z.string() }).nullable(),
  method: z.string().nullable(),
  headers: z.number().int().describe("How many header matches"),
  queryParams: z.number().int().describe("How many query parameter matches"),
  summary: z.string().describe("The match in one line, for a person"),
});

const BackendRefSchema = z.object({
  group: z.string().describe("Empty for the core group, as for a Service"),
  kind: z.string(),
  name: z.string(),
  namespace: z.string().describe(
    "The backend's namespace; the route's own when none is written",
  ),
  port: z.number().nullable(),
  weight: z.number().nullable(),
});

const RuleSchema = z.object({
  name: z.string().nullable(),
  matches: z.array(MatchSchema),
  filters: z.array(z.string()).describe("Filter types, in order"),
  backendRefs: z.array(BackendRefSchema),
});

const ParentStatusSchema = z.object({
  parentRef: ParentRefSchema,
  controllerName: z.string().nullable(),
  requested: z.boolean().describe(
    "The report is about a parent the route asks for, in the spec's form or another; false for a report on an object, a listener or a port the route does not name",
  ),
  judged: z.boolean().describe(
    "The report counts for the route's health; notJudgedBecause says why when it does not",
  ),
  notJudgedBecause: z.enum([
    "not-requested",
    "superseded",
    "another-listener-accepted",
  ]).nullable().describe(
    "not-requested: about something the route does not name. superseded: an old report beside a current one of the same controller on the same parent. another-listener-accepted: a listener that did not accept a route its parent, named without a listener, accepted on another listener. null when judged",
  ),
  accepted: z.boolean().nullable(),
  refsResolved: z.boolean().nullable(),
  partiallyInvalid: z.boolean().describe(
    "PartiallyInvalid is True: the controller dropped some of the rules",
  ),
  current: z.boolean().nullable().describe(
    "false when this report's conditions were observed at an older generation than the route has now; null when that cannot be told",
  ),
  conditions: z.array(ConditionSchema),
});

const UnhealthySchema = z.object({
  parent: z.string().describe(
    "The parent as namespace/name, with /listener and :port when named, in the form the controller reported it; the spec's form when nobody reported",
  ),
  controllerName: z.string().nullable().describe(
    "The controller whose report this is; null when no controller reported on the parent",
  ),
  condition: z.string().nullable().describe(
    "The condition that is not as it should be; null when nothing was reported or the report is old",
  ),
  status: z.string().nullable(),
  reason: z.string().nullable(),
  message: z.string().nullable(),
});

/** Zod schema for a stored HTTPRoute. */
export const HttpRouteSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  apiVersion: z.string(),
  generation: z.number().nullable(),
  hostnames: z.array(z.string()).describe("Empty matches every hostname"),
  parentRefs: z.array(ParentRefSchema),
  rules: z.array(RuleSchema),
  parents: z.array(ParentStatusSchema).describe(
    "What each controller reported per parent, from status.parents",
  ),
  summary: z.object({
    parentCount: z.number().int().describe("Parents the route asks for"),
    reportedParentCount: z.number().int().describe(
      "Parents asked for that at least one controller reported on",
    ),
    leftoverParentReports: z.number().int().describe(
      "Reports that are not-requested or superseded; recorded, never judged",
    ),
    refusedListenerReports: z.number().int().describe(
      "Reports of listeners that did not accept the route while another listener of the same parent, named without a listener, did; recorded, not findings",
    ),
    backendCount: z.number().int(),
    statusCurrent: z.boolean().nullable().describe(
      "false when a judged report was observed at an older generation than the object has now",
    ),
    partiallyInvalid: z.boolean().describe(
      "A judged report has PartiallyInvalid True",
    ),
    allParentsAccepted: z.boolean().describe(
      "Every parent asked for is reported, and every judged report has Accepted True",
    ),
    allRefsResolved: z.boolean().describe(
      "Every parent asked for is reported, and every judged report has ResolvedRefs True",
    ),
    healthy: z.boolean().describe(
      "allParentsAccepted and allRefsResolved, nothing partially invalid, and every judged report current",
    ),
    unhealthy: z.array(UnhealthySchema).describe(
      "Every finding that keeps healthy false, with the controller's reason",
    ),
  }),
  observedAt: z.iso.datetime(),
});

/** One stored HTTPRoute record. */
export type HttpRouteData = z.infer<typeof HttpRouteSchema>;

type Unhealthy = z.infer<typeof UnhealthySchema>;
type ParentStatus = z.infer<typeof ParentStatusSchema>;

function readParentRef(raw: unknown, routeNamespace: string): ParentRef {
  const r = obj(raw);
  return {
    group: strOrNull(r.group) ?? GROUP,
    kind: strOrNull(r.kind) ?? "Gateway",
    namespace: strOrNull(r.namespace) ?? routeNamespace,
    name: strOrNull(r.name) ?? "",
    sectionName: strOrNull(r.sectionName),
    port: numOrNull(r.port),
  };
}

/**
 * Whether a report is about a parent the route asks for. The object must be
 * the same (group, kind, namespace, name). The listener and the port must
 * not contradict: each is the same on both sides, or left out on one. A spec
 * parent without a listener covers a report on any listener of that object,
 * and a report that left the listener or the port out is still about the
 * parent that names them. A report that names another listener or port than
 * the spec does is about something the route does not ask for.
 */
export function reportsOn(spec: ParentRef, report: ParentRef): boolean {
  const agree = <T>(a: T | null, b: T | null) =>
    a === null || b === null || a === b;
  return spec.group === report.group && spec.kind === report.kind &&
    spec.namespace === report.namespace && spec.name === report.name &&
    agree(spec.sectionName, report.sectionName) &&
    agree(spec.port, report.port);
}

/** A parent in words: `namespace/name`, `/listener` and `:port` when named. */
export function parentLabel(p: ParentRef): string {
  return `${p.namespace}/${p.name}${p.sectionName ? `/${p.sectionName}` : ""}${
    p.port !== null ? `:${p.port}` : ""
  }`;
}

/** Reduce one HTTPRouteMatch to counts and a line a person reads. */
export function readMatch(raw: unknown): z.infer<typeof MatchSchema> {
  const m = obj(raw);
  const p = m.path === undefined || m.path === null ? null : obj(m.path);
  const path = p === null ? null : {
    type: strOrNull(p.type) ?? "PathPrefix",
    value: strOrNull(p.value) ?? "/",
  };
  const method = strOrNull(m.method);
  const headers = arr(m.headers).length;
  const queryParams = arr(m.queryParams).length;
  const parts: string[] = [];
  if (method) parts.push(method);
  if (path) parts.push(`${path.type} ${path.value}`);
  if (headers > 0) parts.push(`headers:${headers}`);
  if (queryParams > 0) parts.push(`query:${queryParams}`);
  return {
    path,
    method,
    headers,
    queryParams,
    summary: parts.length > 0 ? parts.join(" ") : "(everything)",
  };
}

function readRule(
  raw: unknown,
  routeNamespace: string,
): z.infer<typeof RuleSchema> {
  const r = obj(raw);
  return {
    name: strOrNull(r.name),
    matches: arr(r.matches).map(readMatch),
    filters: arr(r.filters).map((f) => strOrNull(obj(f).type) ?? "").filter((
      t,
    ) => t !== ""),
    backendRefs: arr(r.backendRefs).map((b) => ({
      group: strOrNull(obj(b).group) ?? "",
      kind: strOrNull(obj(b).kind) ?? "Service",
      name: strOrNull(obj(b).name) ?? "",
      namespace: strOrNull(obj(b).namespace) ?? routeNamespace,
      port: numOrNull(obj(b).port),
      weight: numOrNull(obj(b).weight),
    })),
  };
}

/** The finding for a condition that must be True and is not. */
function conditionFinding(parent: ParentStatus, type: string): Unhealthy[] {
  const c = findCondition(parent.conditions, type);
  if (c?.status === "True") return [];
  return [{
    parent: parentLabel(parent.parentRef),
    controllerName: parent.controllerName,
    condition: type,
    status: c?.status ?? null,
    reason: c?.reason ?? "NotReported",
    message: c ? c.message : `no ${type} condition is reported`,
  }];
}

/** Everything one controller's report on one requested parent says is wrong. */
function reportFindings(
  parent: ParentStatus,
  generation: number | null,
): Unhealthy[] {
  const out = [
    ...conditionFinding(parent, "Accepted"),
    ...conditionFinding(parent, "ResolvedRefs"),
  ];
  // Set only when True: the route is accepted, and some rules were dropped.
  const partial = findCondition(parent.conditions, "PartiallyInvalid");
  if (partial?.status === "True") {
    out.push({
      parent: parentLabel(parent.parentRef),
      controllerName: parent.controllerName,
      condition: "PartiallyInvalid",
      status: partial.status,
      reason: partial.reason,
      message: partial.message,
    });
  }
  if (parent.current === false) {
    const seen = parent.conditions
      .map((c) => c.observedGeneration)
      .filter((g): g is number => g !== null);
    out.push({
      parent: parentLabel(parent.parentRef),
      controllerName: parent.controllerName,
      condition: null,
      status: null,
      reason: "StaleStatus",
      message: `this controller's report is for generation ${
        Math.min(...seen)
      } of the route, which is now at generation ${generation}`,
    });
  }
  return out;
}

/** Reduce an HTTPRoute object as kubectl prints it to the stored record. */
export function parseHttpRoute(
  item: Record<string, unknown>,
  observedAt: string,
): HttpRouteData {
  const meta = readMeta(item, true, "HTTPRoute");
  const spec = obj(item.spec);
  const status = obj(item.status);

  const parentRefs = arr(spec.parentRefs).map((p) =>
    readParentRef(p, meta.namespace)
  );
  const rules = arr(spec.rules).map((r) => readRule(r, meta.namespace));
  const read = arr(status.parents).map((entry) => {
    const e = obj(entry);
    const conditions = readConditions(e.conditions);
    const parentRef = readParentRef(e.parentRef, meta.namespace);
    return {
      parentRef,
      controllerName: strOrNull(e.controllerName),
      // The spec parents this report is about.
      about: parentRefs.filter((ref) => reportsOn(ref, parentRef)),
      accepted: conditionState(conditions, "Accepted"),
      refsResolved: conditionState(conditions, "ResolvedRefs"),
      partiallyInvalid: conditionState(conditions, "PartiallyInvalid") === true,
      current: conditionsCurrent(meta.generation, conditions),
      conditions,
    };
  });
  type Report = typeof read[number];
  const sameController = (a: Report, b: Report) =>
    a.controllerName === b.controllerName;

  // An old report beside a current one of the same controller on the same
  // parent is what the controller kept from before the route was edited. It
  // is superseded when that holds for every parent it is about.
  const superseded = (r: Report) =>
    r.current === false && r.about.length > 0 &&
    r.about.every((ref) =>
      read.some((q) =>
        q !== r && sameController(q, r) && q.current === true &&
        q.about.includes(ref)
      )
    );
  const live = read.filter((r) => r.about.length > 0 && !superseded(r));

  // A parent named without a listener is attached when one listener accepts
  // (the API's rule for sectionName and port). So a listener report that
  // does not accept is no finding when, for every parent it is about, the
  // route names no listener and the same controller reports an accepting
  // listener. Old reports take no part on either side.
  const forListener = (r: Report) =>
    r.parentRef.sectionName !== null && r.current !== false;
  const refusedListener = (r: Report) =>
    live.includes(r) && forListener(r) && r.accepted !== true &&
    r.about.every((ref) =>
      ref.sectionName === null &&
      live.some((q) =>
        sameController(q, r) && forListener(q) && q.accepted === true &&
        q.about.includes(ref)
      )
    );

  const parents: ParentStatus[] = read.map((r) => {
    const why = r.about.length === 0
      ? "not-requested" as const
      : superseded(r)
      ? "superseded" as const
      : refusedListener(r)
      ? "another-listener-accepted" as const
      : null;
    return {
      parentRef: r.parentRef,
      controllerName: r.controllerName,
      requested: r.about.length > 0,
      judged: why === null,
      notJudgedBecause: why,
      accepted: r.accepted,
      refsResolved: r.refsResolved,
      partiallyInvalid: r.partiallyInvalid,
      current: r.current,
      conditions: r.conditions,
    };
  });

  const unhealthy: Unhealthy[] = [];
  if (parentRefs.length === 0) {
    unhealthy.push({
      parent: "(none)",
      controllerName: null,
      condition: null,
      status: null,
      reason: "NoParentRefs",
      message: "the route names no parent, so nothing serves it",
    });
  }
  let reported = 0;
  for (const ref of parentRefs) {
    if (live.some((r) => r.about.includes(ref))) {
      reported++;
    } else {
      unhealthy.push({
        parent: parentLabel(ref),
        controllerName: null,
        condition: null,
        status: null,
        reason: "NotReported",
        message:
          "no controller has reported on this parent; it may not exist, or no controller manages it",
      });
    }
  }
  // Every judged report is judged on its own, in whatever form the
  // controller wrote the parent and whichever controller wrote it: one
  // refusal is a finding even beside an acceptance, with the one exception
  // above. A report that is not judged says nothing about the route as it
  // is now; controllers do leave such entries behind.
  const judged = parents.filter((p) => p.judged);
  for (const p of judged) unhealthy.push(...reportFindings(p, meta.generation));
  const statusCurrent = judged.some((p) => p.current === false)
    ? false
    : judged.some((p) => p.current === true)
    ? true
    : null;
  const because = (why: ParentStatus["notJudgedBecause"]) =>
    parents.filter((p) => p.notJudgedBecause === why).length;

  const allReported = parentRefs.length > 0 && reported === parentRefs.length;
  return {
    name: meta.name,
    namespace: meta.namespace,
    apiVersion: meta.apiVersion,
    generation: meta.generation,
    hostnames: arr(spec.hostnames).map(strOrNull).filter((h): h is string =>
      h !== null
    ),
    parentRefs,
    rules,
    parents,
    summary: {
      parentCount: parentRefs.length,
      reportedParentCount: reported,
      leftoverParentReports: because("not-requested") + because("superseded"),
      refusedListenerReports: because("another-listener-accepted"),
      backendCount: rules.reduce((sum, r) => sum + r.backendRefs.length, 0),
      statusCurrent,
      partiallyInvalid: judged.some((p) => p.partiallyInvalid),
      allParentsAccepted: allReported &&
        judged.every((p) => p.accepted === true),
      allRefsResolved: allReported &&
        judged.every((p) => p.refsResolved === true),
      healthy: unhealthy.length === 0,
      unhealthy,
    },
    observedAt,
  };
}

/**
 * The findings of a record as lines for the inventory, each with the
 * controller whose report it is, when a controller reported.
 */
export function routeReasons(r: HttpRouteData): string[] {
  return r.summary.unhealthy.map((u) =>
    reasonLine(
      `parent ${u.parent}${u.controllerName ? ` (${u.controllerName})` : ""}`,
      u.condition,
      u.status,
      u.reason,
    )
  );
}

/** Swamp model for HTTPRoute objects of the Kubernetes Gateway API. */
export const model = {
  type: "@dataverket/gateway-api/httproute",
  version: "2026.11.10.1",
  globalArguments: KubectlGlobalArgsSchema,
  checks: { "kubectl-cli-available": kubectlCliCheck },
  resources: {
    httproute: {
      description:
        "One HTTPRoute: hostnames, parents, rules with backends, what each controller reported per parent, and a summary to assert on",
      schema: HttpRouteSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    inventory: {
      description:
        "What one list saw: every HTTPRoute by name, and the unhealthy ones with the reasons",
      schema: ListInventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "Read every HTTPRoute of one namespace, or of every namespace, and record each with its parents, rules and per-parent conditions, plus an inventory of the list",
      arguments: z.object({
        namespace: z.string().optional().describe(
          "The namespace to list instead of the definition's. Left out or empty, the definition's namespace is read, and every namespace when that is empty too",
        ),
      }),
      execute: async (
        args: { namespace?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = listNamespace(args.namespace, context.globalArgs.namespace);
        context.logger.info("Listing HTTPRoutes in {namespace}", {
          namespace: ns || "every namespace",
        });
        const items = await listObjects(context, RESOURCE, "HTTPRoute", ns);
        const observedAt = new Date().toISOString();
        const records = items.map((item) => parseHttpRoute(item, observedAt));
        assertDistinctDataNames("HTTPRoute", records);
        warnOnVersions(
          context.logger,
          "HTTPRoutes",
          records.map((r) => r.apiVersion),
        );

        const handles: unknown[] = [];
        for (const r of records) {
          handles.push(
            await context.writeResource(
              "httproute",
              dataName(r.namespace, r.name),
              r,
            ),
          );
        }
        const inventory = listInventory(
          ns || null,
          records.map((r) => ({
            namespace: r.namespace,
            name: r.name,
            apiVersion: r.apiVersion,
            healthy: r.summary.healthy,
            reasons: routeReasons(r),
          })),
          observedAt,
        );
        handles.push(
          await context.writeResource(
            "inventory",
            inventoryName(ns || null),
            inventory,
          ),
        );
        context.logger.info(
          "Recorded {count} HTTPRoutes, {unhealthy} not healthy",
          { count: inventory.count, unhealthy: inventory.unhealthyCount },
        );
        return { dataHandles: handles };
      },
    },

    get: {
      description:
        "Read one HTTPRoute by name and record it with its parents, rules and per-parent conditions",
      arguments: z.object({
        name: z.string().min(1).describe("The HTTPRoute's name"),
        namespace: z.string().optional().describe(
          "The HTTPRoute's namespace. Left out or empty, the definition's namespace is used",
        ),
      }),
      execute: async (
        args: { name: string; namespace?: string },
        context: MethodContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const ns = requireNamespace(
          "get",
          args.namespace,
          context.globalArgs.namespace,
        );
        const name = checkName(args.name);
        context.logger.info("Reading HTTPRoute {name} in {namespace}", {
          name,
          namespace: ns,
        });
        const item = await getObject(context, RESOURCE, "HTTPRoute", name, ns);
        const record = parseHttpRoute(item, new Date().toISOString());
        warnOnVersions(context.logger, "HTTPRoute", [record.apiVersion]);
        const handle = await context.writeResource(
          "httproute",
          dataName(record.namespace, record.name),
          record,
        );
        context.logger.info(
          "HTTPRoute {name}: healthy={healthy}, {findings} findings",
          {
            name,
            healthy: record.summary.healthy,
            findings: record.summary.unhealthy.length,
          },
        );
        return { dataHandles: [handle] };
      },
    },
  },
};
