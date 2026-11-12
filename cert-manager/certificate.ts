/**
 * `@dataverket/cert-manager/certificate`: cert-manager Certificate objects,
 * read and renewed with kubectl.
 *
 * `list` and `get` record a Certificate's Ready and Issuing conditions, its
 * validity window, names, issuer, revision and failed attempts. `trace` walks
 * from one Certificate to its issuer, its current CertificateRequest and, for
 * ACME, the Order and its Challenges, and records the whole chain with the
 * level where issuance stands. `renew` does what `cmctl renew` does: it sets
 * the Issuing condition to True on the status subresource, after checking
 * that no issuance is in progress, and records what happened next.
 *
 * The Secret a Certificate writes to is named, never read.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { brief, pollBudget, redact } from "../lib/cli.ts";
import {
  arr,
  checkName,
  dataName,
  expectObject,
  isKubectlError,
  isOwnedBy,
  kubectlCliCheck,
  KubectlError,
  KubectlGlobalArgsSchema,
  nonEmpty,
  numOrNull,
  obj,
  readMeta,
  requireNamespace,
} from "../lib/kubectl.ts";
import {
  acmeSecrets,
  IssuerRefSchema,
  kubectlJson,
  type MethodContext,
  NameSchema,
  NamespaceSchema,
  RESOURCES,
  seal,
  StateInventorySchema,
} from "./_helpers.ts";
import {
  getKind,
  type KindDef,
  listKind,
  type MethodResult,
  readList,
  readOne,
} from "./_methods.ts";
import {
  type CertificateData,
  certificateItem,
  type CertificateRequestData,
  CertificateRequestSchema,
  CertificateSchema,
  type ChallengeData,
  ChallengeSchema,
  type OrderData,
  OrderSchema,
  parseCertificate,
  parseCertificateRequest,
  parseChallenge,
  parseIssuer,
  parseOrder,
  requestRevision,
} from "./_records.ts";

const KIND: KindDef<CertificateData> = {
  spec: "certificate",
  resource: RESOURCES.certificate,
  label: "Certificate",
  parse: parseCertificate,
  item: certificateItem,
};

/** The issuer a traced Certificate refers to, and whether it is ready. */
export const TraceIssuerSchema = IssuerRefSchema.extend({
  found: z.boolean().describe("The issuer object was read"),
  missing: z.boolean().describe(
    "The issuer is known not to exist, or the reference names none",
  ),
  ready: z.boolean(),
  reason: z.string(),
  message: z.string(),
  error: z.string().nullable().describe(
    "Why the issuer was not read: it does not exist, it is of another API group, or the read was refused",
  ),
});

/** The issuer part of a trace. */
export type TraceIssuer = z.infer<typeof TraceIssuerSchema>;

/** The levels a trace can name as the one where issuance stands. */
export const TRACE_STAGES = [
  "ready",
  "certificate",
  "issuer",
  "certificaterequest",
  "order",
  "challenge",
] as const;

/** One Certificate's issuance chain, read in one run. */
export const TraceSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  stage: z.enum(TRACE_STAGES).describe(
    "Where issuance stands: ready when the Certificate is Ready and nothing is in progress, else the deepest level that is not done",
  ),
  summary: z.string().describe(
    "One sentence naming the object at that level, its state and its reason",
  ),
  certificate: CertificateSchema,
  issuer: TraceIssuerSchema,
  certificateRequest: CertificateRequestSchema.nullable().describe(
    "The request of the highest revision the Certificate owns",
  ),
  order: OrderSchema.nullable().describe(
    "The ACME Order that request owns, when there is one",
  ),
  challenges: z.array(ChallengeSchema).describe(
    "The Challenges that Order owns; cert-manager deletes them once the Order is done",
  ),
  readAt: z.string(),
});

/** One stored trace. */
export type TraceData = z.infer<typeof TraceSchema>;

/** The outcomes `renew` can observe within its poll. */
export const RENEW_OUTCOMES = [
  "issued",
  "in-progress",
  "failed",
  "not-issued",
  "deleted",
] as const;

/** What a forced renewal did and what was seen afterwards. */
export const RenewalSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  triggeredAt: z.string(),
  outcome: z.enum(RENEW_OUTCOMES).describe(
    "issued: the revision rose and Issuing is gone. in-progress: Issuing is still True when the poll ended. failed: cert-manager set Issuing to False without a new revision. not-issued: Issuing is gone without a new revision. deleted: the Certificate no longer existed at a read after the trigger; the other fields are those of the last read that found it.",
  ),
  revisionBefore: z.number().nullable(),
  revisionAfter: z.number().nullable(),
  notAfterBefore: z.string().nullable(),
  notAfterAfter: z.string().nullable(),
  issuing: z.boolean().describe("Issuing was still True at the last read"),
  issuingReason: z.string(),
  issuingMessage: z.string(),
  ready: z.boolean(),
  failedIssuanceAttempts: z.number(),
  waitedSeconds: z.number().describe(
    "Seconds spent waiting and reading after the trigger, rounded",
  ),
  pollError: z.string().nullable().describe(
    "Why the poll ended early: a read after the trigger failed, or the Certificate was gone. The trigger itself was applied.",
  ),
  readAt: z.string(),
});

/** One stored renewal. */
export type RenewalData = z.infer<typeof RenewalSchema>;

/** The data name of a Certificate's trace. */
export function traceName(namespace: string, name: string): string {
  return `trace_${dataName(namespace, name)}`;
}

/** The data name of a Certificate's last renewal. */
export function renewalName(namespace: string, name: string): string {
  return `renewal_${dataName(namespace, name)}`;
}

/**
 * Of the CertificateRequests in a namespace, the one a Certificate is
 * working with: owned by it, of the highest revision, the newest on a tie.
 */
export function currentRequest(
  requests: Record<string, unknown>[],
  certificate: { uid: string; name: string },
): Record<string, unknown> | undefined {
  return newest(
    requests.filter((r) => isOwnedBy(r, "Certificate", certificate)),
    (r) => requestRevision(r) ?? -1,
  );
}

/** The item with the highest rank; the newest creation time breaks a tie. */
function newest(
  items: Record<string, unknown>[],
  rank: (item: Record<string, unknown>) => number,
): Record<string, unknown> | undefined {
  let best: Record<string, unknown> | undefined;
  for (const item of items) {
    if (!best) {
      best = item;
      continue;
    }
    const a = rank(item);
    const b = rank(best);
    const created = (i: Record<string, unknown>) =>
      nonEmpty(obj(i.metadata).creationTimestamp) ?? "";
    if (a > b || (a === b && created(item) > created(best))) best = item;
  }
  return best;
}

/** Name the level where issuance stands and say why in one sentence. */
export function diagnose(
  t: {
    certificate: CertificateData;
    issuer: TraceIssuer;
    certificateRequest: CertificateRequestData | null;
    order: OrderData | null;
    challenges: ChallengeData[];
  },
): { stage: typeof TRACE_STAGES[number]; summary: string } {
  const c = t.certificate;
  if (c.ready && !c.issuing && !c.expired) {
    return {
      stage: "ready",
      summary: `Certificate ${c.name} is Ready${
        c.notAfter ? ` and valid until ${c.notAfter}` : ""
      }`,
    };
  }
  // cert-manager works on one challenge for a name at a time; the others of
  // the order have no state yet. The one being worked on says why it hangs,
  // so it is named before one that has not started, whatever the list order.
  const unfinished = t.challenges.filter((ch) => ch.state !== "valid");
  const open = unfinished.find((ch) => ch.state !== "") ?? unfinished[0];
  if (open) {
    return {
      stage: "challenge",
      summary: `Challenge ${open.name} (${open.type || "unknown type"} for ${
        open.wildcard ? "*." : ""
      }${open.dnsName}, solver ${open.solverKind}) is ${
        open.state || "not started"
      }, ${open.presented ? "presented" : "not presented"}${
        open.reason ? `: ${open.reason}` : ""
      }`,
    };
  }
  if (t.order && t.order.state !== "valid") {
    return {
      stage: "order",
      summary: `Order ${t.order.name} is ${t.order.state || "not started"}${
        t.order.reason ? `: ${t.order.reason}` : ""
      }`,
    };
  }
  // An issuer that was read and is not Ready, or that is not there, is where
  // issuance stands. One that could not be read, for lack of access or
  // because another API group serves it, is unknown and is not blamed.
  if (t.issuer.found ? !t.issuer.ready : t.issuer.missing) {
    return {
      stage: "issuer",
      summary: `${t.issuer.kind} ${t.issuer.name} ${
        t.issuer.error ??
          `is not Ready${
            t.issuer.message || t.issuer.reason
              ? `: ${t.issuer.message || t.issuer.reason}`
              : ""
          }`
      }`,
    };
  }
  const r = t.certificateRequest;
  if (r && !r.ready) {
    return {
      stage: "certificaterequest",
      summary: `CertificateRequest ${r.name} is ${r.state}${
        r.readyMessage || r.readyReason
          ? `: ${r.readyMessage || r.readyReason}`
          : ""
      }`,
    };
  }
  const why = c.issuing
    ? c.issuingMessage || c.issuingReason
    : c.readyMessage || c.readyReason;
  return {
    stage: "certificate",
    summary: `Certificate ${c.name} is ${
      c.expired
        ? "expired"
        : c.issuing
        ? "issuing"
        : c.ready
        ? "Ready"
        : "not Ready"
    }${why ? `: ${why}` : ""}`,
  };
}

/**
 * Read the issuer a Certificate refers to. The issuer is context for a
 * trace, not its subject, so a failure to read it is recorded and the trace
 * goes on.
 */
async function traceIssuer(
  ref: z.infer<typeof IssuerRefSchema>,
  namespace: string,
  context: MethodContext,
): Promise<TraceIssuer> {
  const blank = {
    ...ref,
    found: false,
    missing: false,
    ready: false,
    reason: "",
    message: "",
  };
  if (ref.group !== "cert-manager.io") {
    return {
      ...blank,
      error: `is of API group ${ref.group}, which this type does not read`,
    };
  }
  if (ref.kind !== "Issuer" && ref.kind !== "ClusterIssuer") {
    return { ...blank, error: `is of kind ${ref.kind}, which is not read` };
  }
  let name: string;
  try {
    name = checkName(ref.name, `${ref.kind} name`);
  } catch {
    return {
      ...blank,
      missing: true,
      error: "has no valid name in the issuerRef",
    };
  }
  try {
    const item = await readOne(
      ref.kind === "ClusterIssuer" ? RESOURCES.clusterIssuer : RESOURCES.issuer,
      ref.kind,
      name,
      ref.kind === "ClusterIssuer" ? null : namespace,
      context,
    );
    const issuer = parseIssuer(item, ref.kind, new Date());
    return {
      ...ref,
      found: true,
      missing: false,
      ready: issuer.ready,
      reason: issuer.readyReason,
      message: issuer.readyMessage,
      error: null,
    };
  } catch (err) {
    if (isKubectlError(err, "forbidden")) {
      return { ...blank, error: "could not be read: access was refused" };
    }
    if (isKubectlError(err, "not-found")) {
      return { ...blank, missing: true, error: "does not exist" };
    }
    throw err;
  }
}

/**
 * The conditions of a Certificate with Issuing set to True, as cmctl sets
 * it. `raw` is `status.conditions` as kubectl printed it: a merge patch
 * replaces the whole array, so every other condition goes back exactly as
 * it was read, with every field it had. Only what is not a condition (no
 * type) is left out.
 */
export function withIssuingTrue(
  raw: unknown,
  generation: number | null,
  now: Date,
): Record<string, unknown>[] {
  const issuing = {
    type: "Issuing",
    status: "True",
    reason: "ManuallyTriggered",
    message: "Certificate re-issuance manually triggered",
    // cert-manager compares a failed request's time with this one to decide
    // whether to try again, so it is the time of the trigger, in whole seconds.
    lastTransitionTime: now.toISOString().replace(/\.\d{3}Z$/, "Z"),
    ...(generation === null ? {} : { observedGeneration: generation }),
  };
  const kept = arr(raw).filter((c): c is Record<string, unknown> =>
    c === obj(c) && nonEmpty(obj(c).type) !== null
  ).filter((c) => c.type !== "Issuing");
  return [...kept, issuing];
}

/**
 * Failures of the patch call after which nobody knows whether the server
 * applied it: no answer in time, a run cancelled while it was out, a
 * connection that broke, an answer that is not JSON.
 */
const UNKNOWN_OUTCOME: string[] = [
  "timeout",
  "cancelled",
  "unreachable",
  "not-json",
];

/**
 * What a patch body holds that must not come back in an error when a server
 * repeats the body: the body itself, as sent and as a quoted string, and
 * every text in it that is long enough not to be an ordinary word.
 */
function patchSecrets(patch: string): string[] {
  const out = [patch, JSON.stringify(patch).slice(1, -1)];
  const walk = (v: unknown) => {
    if (typeof v === "string") {
      if (v.length >= 8) out.push(v, JSON.stringify(v).slice(1, -1), redact(v));
    } else if (Array.isArray(v)) v.forEach(walk);
    else if (v !== null && typeof v === "object") {
      Object.values(v).forEach(walk);
    }
  };
  walk(JSON.parse(patch));
  return out;
}

/**
 * What kubectl said about a failed patch, safe to repeat: everything the
 * patch sent is blanked by value, and the text ends where a JSON body
 * begins, because a server that calls a patch invalid repeats it, and that
 * copy may be cut or already altered so that no value matches it.
 */
function patchSaid(err: Error, patch: string): string {
  const text = redact(err.message, patchSecrets(patch));
  const at = text.indexOf("{");
  return brief(
    at < 0
      ? text
      : `${text.slice(0, at)}(the rest is left out: it may repeat the patch)`,
    300,
  );
}

/** Milliseconds between two reads while `renew` waits. */
const POLL_MS = 2000;

/** Swamp model for cert-manager Certificate objects. */
export const model = {
  type: "@dataverket/cert-manager/certificate",
  version: "2026.11.12.1",
  globalArguments: KubectlGlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.12.1",
      description:
        "unit tests in the swamp skill's pattern; the bundled lib/ adds a 64 MiB output limit per command (a larger output is refused as too-large); global arguments unchanged",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  checks: {
    "kubectl-cli-available": kubectlCliCheck,
  },
  resources: {
    certificate: {
      description:
        "Certificate state: the Ready and Issuing conditions, the validity window, names, issuer, revision and failed issuance attempts",
      schema: CertificateSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    inventory: {
      description:
        "What one list run saw: every Certificate in scope with its state, and how many are not healthy",
      schema: StateInventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    trace: {
      description:
        "One Certificate's issuance chain: the issuer, the current CertificateRequest, the Order and its Challenges, and the level where issuance stands",
      schema: TraceSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
    renewal: {
      description:
        "A forced renewal: the revision and expiry before, and what was seen after the trigger",
      schema: RenewalSchema,
      lifetime: "infinite" as const,
      garbageCollection: 20,
    },
  },
  methods: {
    /** List every Certificate in one namespace or all. */
    list: {
      description:
        "List cert-manager Certificate objects and record each with readiness, expiry and revision, plus one inventory of the run",
      arguments: z.object({
        namespace: NamespaceSchema.optional().describe(
          "Namespace to list. Defaults to the definition's; empty there means all namespaces.",
        ),
      }),
      execute: (
        args: { namespace?: string },
        context: MethodContext,
      ): Promise<MethodResult> => listKind(KIND, args, context),
    },

    /** Read one Certificate. */
    get: {
      description:
        "Read one cert-manager Certificate and record readiness, expiry and revision",
      arguments: z.object({
        name: NameSchema.describe("Certificate name"),
        namespace: NamespaceSchema.optional().describe(
          "Namespace of the Certificate. Defaults to the definition's.",
        ),
      }),
      execute: (
        args: { name: string; namespace?: string },
        context: MethodContext,
      ): Promise<MethodResult> => getKind(KIND, args, context),
    },

    /** Walk one Certificate's issuance chain. */
    trace: {
      description:
        "Walk from one Certificate to its issuer, current CertificateRequest, ACME Order and Challenges, and record the chain with the level where issuance stands",
      kind: "read" as const,
      arguments: z.object({
        name: NameSchema.describe("Certificate name"),
        namespace: NamespaceSchema.optional().describe(
          "Namespace of the Certificate. Defaults to the definition's.",
        ),
      }),
      execute: async (
        args: { name: string; namespace?: string },
        context: MethodContext,
      ): Promise<MethodResult> => {
        const name = checkName(args.name, "Certificate name");
        const ns = requireNamespace(
          "trace",
          args.namespace,
          context.globalArgs.namespace,
        );
        context.logger.info("Tracing Certificate {name} in {namespace}", {
          name,
          namespace: ns,
        });
        const now = new Date();
        const raw = await readOne(
          RESOURCES.certificate,
          "Certificate",
          name,
          ns,
          context,
        );
        const readIssuer = await traceIssuer(
          parseCertificate(raw, now).issuerRef,
          ns,
          context,
        );

        const rawRequest = currentRequest(
          await readList(
            RESOURCES.certificateRequest,
            "CertificateRequest",
            ns,
            context,
          ),
          { uid: readMeta(raw, true, "Certificate").uid, name },
        );
        let rawOrder: Record<string, unknown> | undefined;
        let rawChallenges: Record<string, unknown>[] = [];
        if (rawRequest) {
          const owner = readMeta(rawRequest, true, "CertificateRequest");
          rawOrder = newest(
            (await readList(RESOURCES.order, "Order", ns, context)).filter((
              o,
            ) => isOwnedBy(o, "CertificateRequest", owner)),
            () => 0,
          );
        }
        if (rawOrder) {
          const owner = readMeta(rawOrder, true, "Order");
          rawChallenges =
            (await readList(RESOURCES.challenge, "Challenge", ns, context))
              .filter((ch) => isOwnedBy(ch, "Order", owner));
        }

        // The tokens and keys of this chain's Order and Challenges are named
        // for every level: a message higher up can quote what a level below
        // holds. The summary is built from the sealed levels, and the whole
        // trace is sealed once more.
        const secrets = acmeSecrets(rawOrder, ...rawChallenges);
        const certificate = parseCertificate(raw, now, secrets);
        const chain = {
          certificate,
          issuer: readIssuer,
          certificateRequest: rawRequest
            ? parseCertificateRequest(rawRequest, now, secrets)
            : null,
          order: rawOrder ? parseOrder(rawOrder, now, secrets) : null,
          challenges: rawChallenges.map((ch) =>
            parseChallenge(ch, now, secrets)
          ),
        };
        const trace: TraceData = seal({
          name,
          namespace: ns,
          ...diagnose(chain),
          ...chain,
          readAt: now.toISOString(),
        }, secrets);
        const handles = [
          await context.writeResource(
            "certificate",
            dataName(ns, name),
            certificate,
          ),
          await context.writeResource("trace", traceName(ns, name), trace),
        ];
        context.logger.info("Trace of {name}: {stage}: {summary}", {
          name,
          stage: trace.stage,
          summary: trace.summary,
        });
        return { dataHandles: handles };
      },
    },

    /** Force a renewal of one Certificate. */
    renew: {
      description:
        "Force a renewal of one Certificate as cmctl renew does: set the Issuing condition to True on the status subresource, refuse when an issuance is already in progress, then poll briefly and record the revision before and the state after",
      kind: "action" as const,
      arguments: z.object({
        name: NameSchema.describe("Certificate name"),
        namespace: NamespaceSchema.optional().describe(
          "Namespace of the Certificate. Defaults to the definition's.",
        ),
        waitSeconds: z.number().int().min(0).max(120).default(20).describe(
          "How long to poll for the new revision after the trigger. The renewal goes on in the cluster when the poll ends; 0 records the state right after the trigger.",
        ),
      }),
      execute: async (
        args: { name: string; namespace?: string; waitSeconds?: number },
        context: MethodContext,
      ): Promise<MethodResult> => {
        const name = checkName(args.name, "Certificate name");
        const ns = requireNamespace(
          "renew",
          args.namespace,
          context.globalArgs.namespace,
        );
        const waitSeconds = Math.min(Math.max(args.waitSeconds ?? 20, 0), 120);
        context.logger.info("Renewing Certificate {name} in {namespace}", {
          name,
          namespace: ns,
        });

        const read = () =>
          readOne(RESOURCES.certificate, "Certificate", name, ns, context);
        const raw = await read();
        const before = parseCertificate(raw, new Date());
        if (before.issuing) {
          throw new Error(
            `Certificate ${ns}/${name} is already issuing${
              before.issuingSince ? ` since ${before.issuingSince}` : ""
            } (${
              before.issuingReason || "no reason"
            }); renew is refused while an issuance is in progress. Run trace to see where it stands.`,
          );
        }
        const resourceVersion = obj(raw.metadata).resourceVersion;
        if (typeof resourceVersion !== "string" || resourceVersion === "") {
          throw new Error(
            `Certificate ${ns}/${name} was read without a resourceVersion; renew needs it to change only what it read`,
          );
        }

        const triggeredAt = new Date();
        const patch = JSON.stringify({
          metadata: { resourceVersion },
          status: {
            conditions: withIssuingTrue(
              obj(raw.status).conditions,
              numOrNull(obj(raw.metadata).generation),
              triggeredAt,
            ),
          },
        });
        let patched: unknown;
        try {
          // The body goes to kubectl on standard input: it is in no
          // argument list, no process table and no error message.
          patched = await kubectlJson(
            [
              "patch",
              RESOURCES.certificate,
              name,
              "-n",
              ns,
              "--subresource=status",
              "--type=merge",
              "--patch-file=/dev/stdin",
            ],
            context,
            patch,
          );
        } catch (err) {
          if (isKubectlError(err, "conflict")) {
            throw new Error(
              `Certificate ${ns}/${name} changed between the read and the renewal; nothing was changed. Run renew again.`,
            );
          }
          if (!(err instanceof KubectlError)) throw err;
          // What kubectl said, with everything the patch sent blanked: a
          // server that repeats the body must not put it into an error.
          const said = patchSaid(err, patch);
          if (err.kind === "forbidden") {
            throw new Error(
              `renew of Certificate ${ns}/${name} was refused: it needs the patch verb on certificates/status in API group cert-manager.io. Nothing was changed. (${said})`,
            );
          }
          if (UNKNOWN_OUTCOME.includes(err.kind)) {
            throw new Error(
              `renew of Certificate ${ns}/${name}: the patch was sent and its answer did not arrive or could not be read, so the renewal may have been triggered. Read the Certificate with get: an Issuing condition with reason ManuallyTriggered means it was. (${said})`,
            );
          }
          throw new KubectlError(err.kind, said);
        }
        let answered: Record<string, unknown>;
        try {
          answered = expectObject(patched, {
            kind: "Certificate",
            name,
            namespace: ns,
          });
        } catch (err) {
          throw new Error(
            `renew of Certificate ${ns}/${name}: the patch was sent and its answer is not the Certificate, so the renewal may have been triggered. Read the Certificate with get: an Issuing condition with reason ManuallyTriggered means it was. (${
              patchSaid(
                err instanceof Error ? err : new Error(String(err)),
                patch,
              )
            })`,
          );
        }
        const applied = parseCertificate(answered, triggeredAt);
        if (!applied.issuing || applied.issuingReason !== "ManuallyTriggered") {
          throw new Error(
            `renew of Certificate ${ns}/${name} was not applied: after the patch the Issuing condition is ${
              applied.issuing ? "True" : "not True"
            } with reason ${JSON.stringify(applied.issuingReason)}`,
          );
        }
        context.logger.info(
          "Triggered issuance of {name} at revision {revision}",
          { name, revision: String(before.revision ?? "none") },
        );

        // The trigger is applied from here on. A read that fails while
        // polling ends the poll and is recorded; it does not undo or hide
        // the trigger.
        // The time a read takes counts against the budget, so slow answers
        // cannot stretch the poll far past waitSeconds. A cancelled run is
        // not a failed read: it ends the method.
        let after = applied;
        let pollError: string | null = null;
        let deleted = false;
        const budget = pollBudget(waitSeconds * 1000);
        while (after.issuing && await budget.wait(POLL_MS, context.signal)) {
          try {
            after = parseCertificate(await read(), new Date());
          } catch (err) {
            if (isKubectlError(err, "cancelled")) throw err;
            if (!(err instanceof KubectlError)) throw err;
            pollError = brief(err.message, 300);
            deleted = err.kind === "not-found";
            break;
          }
        }
        const waited = Math.round(budget.usedMs() / 1000);

        const rose = (after.revision ?? 0) > (before.revision ?? 0);
        const outcome: RenewalData["outcome"] = deleted
          ? "deleted"
          : after.issuing
          ? "in-progress"
          : rose
          ? "issued"
          : after.conditions.some((c) => c.type === "Issuing")
          ? "failed"
          : "not-issued";
        const renewal: RenewalData = {
          name,
          namespace: ns,
          triggeredAt: triggeredAt.toISOString(),
          outcome,
          revisionBefore: before.revision,
          revisionAfter: after.revision,
          notAfterBefore: before.notAfter,
          notAfterAfter: after.notAfter,
          issuing: after.issuing,
          issuingReason: after.issuingReason,
          issuingMessage: after.issuingMessage,
          ready: after.ready,
          failedIssuanceAttempts: after.failedIssuanceAttempts,
          waitedSeconds: waited,
          pollError,
          readAt: after.readAt,
        };
        // A Certificate that is gone gets no record of its own: the last
        // read of it is not its state now.
        const handles = [
          ...(deleted ? [] : [
            await context.writeResource(
              "certificate",
              dataName(ns, name),
              after,
            ),
          ]),
          await context.writeResource(
            "renewal",
            renewalName(ns, name),
            renewal,
          ),
        ];
        context.logger.info(
          "Renewal of {name}: {outcome}, revision {before} to {after}",
          {
            name,
            outcome,
            before: String(before.revision ?? "none"),
            after: String(after.revision ?? "none"),
          },
        );
        return { dataHandles: handles };
      },
    },
  },
};
