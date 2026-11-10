/**
 * The stored records of the cert-manager types and the functions that reduce
 * an object as kubectl prints it to one. Each function reads defensively: a
 * missing or malformed status becomes a record that says so, never an
 * exception; only an answer without a name (or, for a namespaced kind, a
 * namespace) is refused, because it is not an object.
 *
 * Every record is sealed before it is returned: its text fields are blanked
 * of the token and key the object holds, of the `secrets` the caller names
 * (a trace names those of the whole chain), and of every key authorization
 * a message quotes. No function copies a CSR, a certificate body, an ACME token or
 * an ACME key.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  annotation,
  arr,
  ConditionSchema,
  conditionTrue,
  dataName,
  findCondition,
  nonEmpty,
  numOrNull,
  obj,
  ownerName,
  readConditions,
  readMeta,
  str,
  strings,
} from "../lib/kubectl.ts";
import {
  acmeSecrets,
  IssuerRefSchema,
  readIssuerRef,
  seal,
  type StateItem,
  stateItem,
} from "./_helpers.ts";

/** A Certificate as stored. */
export const CertificateSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  ready: z.boolean().describe("The Ready condition is True"),
  readyReason: z.string(),
  readyMessage: z.string(),
  issuing: z.boolean().describe(
    "The Issuing condition is True: an issuance is in progress",
  ),
  issuingReason: z.string(),
  issuingMessage: z.string(),
  issuingSince: z.string().nullable().describe(
    "When the Issuing condition last changed",
  ),
  notBefore: z.string().nullable(),
  notAfter: z.string().nullable(),
  renewalTime: z.string().nullable(),
  secondsUntilExpiry: z.number().nullable().describe(
    "notAfter minus readAt, in whole seconds; negative when expired",
  ),
  expired: z.boolean(),
  renewalDue: z.boolean().describe("renewalTime is at or before readAt"),
  dnsNames: z.array(z.string()),
  commonName: z.string().nullable(),
  ipAddresses: z.array(z.string()),
  issuerRef: IssuerRefSchema,
  secretName: z.string().describe(
    "Name of the Secret that holds the certificate; the Secret is never read",
  ),
  duration: z.string().nullable(),
  renewBefore: z.string().nullable(),
  revision: z.number().nullable().describe(
    "Issuance counter; rises by one with every issued certificate",
  ),
  failedIssuanceAttempts: z.number(),
  lastFailureTime: z.string().nullable(),
  nextPrivateKeySecretNamePresent: z.boolean().describe(
    "A next private key is staged, which happens during an issuance",
  ),
  conditions: z.array(ConditionSchema),
  readAt: z.string(),
});

/** One stored Certificate record. */
export type CertificateData = z.infer<typeof CertificateSchema>;

/** Seconds from `now` to an RFC 3339 time, or null when it does not parse. */
function secondsUntil(time: string | null, now: Date): number | null {
  if (!time) return null;
  const t = Date.parse(time);
  return Number.isNaN(t) ? null : Math.floor((t - now.getTime()) / 1000);
}

/** Reduce a Certificate object to the stored record. */
export function parseCertificate(
  item: Record<string, unknown>,
  now: Date,
  secrets: string[] = [],
): CertificateData {
  const meta = readMeta(item, true, "Certificate");
  const spec = obj(item.spec);
  const status = obj(item.status);
  const conditions = readConditions(status.conditions);
  const ready = findCondition(conditions, "Ready");
  const issuing = findCondition(conditions, "Issuing");
  const notAfter = nonEmpty(status.notAfter);
  const renewalTime = nonEmpty(status.renewalTime);
  const untilExpiry = secondsUntil(notAfter, now);
  const untilRenewal = secondsUntil(renewalTime, now);
  return seal({
    name: meta.name,
    namespace: meta.namespace,
    ready: ready?.status === "True",
    readyReason: ready?.reason ?? "",
    readyMessage: ready?.message ?? "",
    issuing: issuing?.status === "True",
    issuingReason: issuing?.reason ?? "",
    issuingMessage: issuing?.message ?? "",
    issuingSince: issuing?.lastTransitionTime ?? null,
    notBefore: nonEmpty(status.notBefore),
    notAfter,
    renewalTime,
    secondsUntilExpiry: untilExpiry,
    expired: untilExpiry !== null && untilExpiry <= 0,
    renewalDue: untilRenewal !== null && untilRenewal <= 0,
    dnsNames: strings(spec.dnsNames),
    commonName: nonEmpty(spec.commonName),
    ipAddresses: strings(spec.ipAddresses),
    issuerRef: readIssuerRef(spec.issuerRef),
    secretName: str(spec.secretName),
    duration: nonEmpty(spec.duration),
    renewBefore: nonEmpty(spec.renewBefore),
    revision: numOrNull(status.revision),
    failedIssuanceAttempts: numOrNull(status.failedIssuanceAttempts) ?? 0,
    lastFailureTime: nonEmpty(status.lastFailureTime),
    nextPrivateKeySecretNamePresent:
      nonEmpty(status.nextPrivateKeySecretName) !== null,
    conditions,
    readAt: now.toISOString(),
  }, [...secrets]);
}

/**
 * The inventory line of a Certificate: healthy when it is Ready and not
 * expired.
 */
export function certificateItem(c: CertificateData): StateItem {
  return stateItem({
    namespace: c.namespace,
    name: c.name,
    dataName: dataName(c.namespace, c.name),
    healthy: c.ready && !c.expired,
    state: c.expired
      ? "Expired"
      : c.issuing
      ? "Issuing"
      : c.ready
      ? "Ready"
      : "NotReady",
    why: c.expired
      ? `expired at ${c.notAfter}`
      : c.readyMessage || c.readyReason || c.issuingMessage ||
        c.issuingReason,
  });
}

/** A CertificateRequest as stored. */
export const CertificateRequestSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  certificateName: z.string().nullable().describe(
    "The Certificate this request belongs to, when one made it",
  ),
  certificateRevision: z.number().nullable().describe(
    "The Certificate revision this request is for",
  ),
  issuerRef: IssuerRefSchema,
  state: z.string().describe(
    "Issued, Denied, InvalidRequest, Failed or Pending",
  ),
  approved: z.boolean(),
  denied: z.boolean(),
  ready: z.boolean(),
  invalidRequest: z.boolean(),
  readyReason: z.string(),
  readyMessage: z.string(),
  failureTime: z.string().nullable(),
  certificateIssued: z.boolean().describe(
    "The status holds a certificate; its body is never stored",
  ),
  duration: z.string().nullable(),
  createdAt: z.string().nullable(),
  conditions: z.array(ConditionSchema),
  readAt: z.string(),
});

/** One stored CertificateRequest record. */
export type CertificateRequestData = z.infer<typeof CertificateRequestSchema>;

/** The Certificate revision a CertificateRequest is annotated with. */
export function requestRevision(item: Record<string, unknown>): number | null {
  const raw = annotation(item, "cert-manager.io/certificate-revision");
  if (raw === null || !/^\d+$/.test(raw)) return null;
  return Number(raw);
}

/** Reduce a CertificateRequest object to the stored record. */
export function parseCertificateRequest(
  item: Record<string, unknown>,
  now: Date,
  secrets: string[] = [],
): CertificateRequestData {
  const meta = readMeta(item, true, "CertificateRequest");
  const spec = obj(item.spec);
  const status = obj(item.status);
  const conditions = readConditions(status.conditions);
  const readyCond = findCondition(conditions, "Ready");
  const ready = readyCond?.status === "True";
  const denied = conditionTrue(conditions, "Denied");
  const invalidRequest = conditionTrue(conditions, "InvalidRequest");
  const state = ready
    ? "Issued"
    : denied
    ? "Denied"
    : invalidRequest
    ? "InvalidRequest"
    : readyCond?.reason === "Failed"
    ? "Failed"
    : "Pending";
  return seal({
    name: meta.name,
    namespace: meta.namespace,
    certificateName:
      nonEmpty(annotation(item, "cert-manager.io/certificate-name")) ??
        ownerName(item, "Certificate"),
    certificateRevision: requestRevision(item),
    issuerRef: readIssuerRef(spec.issuerRef),
    state,
    approved: conditionTrue(conditions, "Approved"),
    denied,
    ready,
    invalidRequest,
    readyReason: readyCond?.reason ?? "",
    readyMessage: readyCond?.message ?? "",
    failureTime: nonEmpty(status.failureTime),
    certificateIssued: nonEmpty(status.certificate) !== null,
    duration: nonEmpty(spec.duration),
    createdAt: meta.createdAt,
    conditions,
    readAt: now.toISOString(),
  }, [...secrets]);
}

/** The inventory line of a CertificateRequest: healthy when it is Ready. */
export function certificateRequestItem(r: CertificateRequestData): StateItem {
  return stateItem({
    namespace: r.namespace,
    name: r.name,
    dataName: dataName(r.namespace, r.name),
    healthy: r.ready,
    state: r.state,
    why: r.readyMessage || r.readyReason,
  });
}

/** One ACME authorization of an Order, without its URLs and tokens. */
export const AuthorizationSchema = z.object({
  identifier: z.string(),
  wildcard: z.boolean(),
  initialState: z.string(),
  challengeTypes: z.array(z.string()),
});

/** An ACME Order as stored. */
export const OrderSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  certificateRequestName: z.string().nullable().describe(
    "The CertificateRequest that owns this order",
  ),
  issuerRef: IssuerRefSchema,
  state: z.string().describe(
    "valid, ready, pending, processing, invalid, expired or errored; empty before the ACME server has answered",
  ),
  reason: z.string(),
  failureTime: z.string().nullable(),
  dnsNames: z.array(z.string()),
  commonName: z.string().nullable(),
  ipAddresses: z.array(z.string()),
  authorizations: z.array(AuthorizationSchema),
  certificateIssued: z.boolean().describe(
    "The status holds a certificate; its body is never stored",
  ),
  createdAt: z.string().nullable(),
  readAt: z.string(),
});

/** One stored Order record. */
export type OrderData = z.infer<typeof OrderSchema>;

/** Reduce an Order object to the stored record. */
export function parseOrder(
  item: Record<string, unknown>,
  now: Date,
  secrets: string[] = [],
): OrderData {
  const meta = readMeta(item, true, "Order");
  const spec = obj(item.spec);
  const status = obj(item.status);
  return seal({
    name: meta.name,
    namespace: meta.namespace,
    certificateRequestName: ownerName(item, "CertificateRequest"),
    issuerRef: readIssuerRef(spec.issuerRef),
    state: str(status.state),
    reason: str(status.reason),
    failureTime: nonEmpty(status.failureTime),
    dnsNames: strings(spec.dnsNames),
    commonName: nonEmpty(spec.commonName),
    ipAddresses: strings(spec.ipAddresses),
    authorizations: arr(status.authorizations).map(obj).map((a) => ({
      identifier: str(a.identifier),
      wildcard: a.wildcard === true,
      initialState: str(a.initialState),
      challengeTypes: arr(a.challenges).map(obj).map((c) => str(c.type))
        .filter((t) => t !== ""),
    })),
    certificateIssued: nonEmpty(status.certificate) !== null,
    createdAt: meta.createdAt,
    readAt: now.toISOString(),
  }, [...secrets, ...acmeSecrets(item)]);
}

/** The inventory line of an Order: healthy when its state is valid. */
export function orderItem(o: OrderData): StateItem {
  return stateItem({
    namespace: o.namespace,
    name: o.name,
    dataName: dataName(o.namespace, o.name),
    healthy: o.state === "valid",
    state: o.state,
    why: o.reason,
  });
}

/** An ACME Challenge as stored. */
export const ChallengeSchema = z.object({
  name: z.string(),
  namespace: z.string(),
  orderName: z.string().nullable().describe(
    "The Order that owns this challenge",
  ),
  issuerRef: IssuerRefSchema,
  type: z.string().describe("HTTP-01 or DNS-01"),
  dnsName: z.string(),
  wildcard: z.boolean(),
  state: z.string().describe(
    "valid, ready, pending, processing, invalid, expired or errored; empty before the first sync",
  ),
  reason: z.string(),
  presented: z.boolean().describe(
    "The solver has put the challenge answer in place",
  ),
  processing: z.boolean(),
  solverKind: z.string().describe(
    "The configured solver, such as dns01/webhook, dns01/cloudflare or http01/ingress",
  ),
  solverName: z.string().nullable().describe(
    "For a webhook solver, its solverName",
  ),
  createdAt: z.string().nullable(),
  readAt: z.string(),
});

/** One stored Challenge record. */
export type ChallengeData = z.infer<typeof ChallengeSchema>;

/**
 * The kind of solver a Challenge is configured with, by key name only. The
 * solver's configuration is never copied: a webhook's `config` is free-form
 * and may hold anything.
 */
export function solverKind(
  solver: unknown,
): { kind: string; name: string | null } {
  const s = obj(solver);
  for (const family of ["dns01", "http01"]) {
    const conf = obj(s[family]);
    const provider = Object.keys(conf).find((k) =>
      conf[k] !== null && typeof conf[k] === "object"
    );
    if (provider) {
      return {
        kind: `${family}/${provider}`,
        name: provider === "webhook"
          ? nonEmpty(obj(conf.webhook).solverName)
          : null,
      };
    }
    if (family in s) return { kind: family, name: null };
  }
  return { kind: "unknown", name: null };
}

/** Reduce a Challenge object to the stored record. */
export function parseChallenge(
  item: Record<string, unknown>,
  now: Date,
  secrets: string[] = [],
): ChallengeData {
  const meta = readMeta(item, true, "Challenge");
  const spec = obj(item.spec);
  const status = obj(item.status);
  const solver = solverKind(spec.solver);
  return seal({
    name: meta.name,
    namespace: meta.namespace,
    orderName: ownerName(item, "Order"),
    issuerRef: readIssuerRef(spec.issuerRef),
    type: str(spec.type),
    dnsName: str(spec.dnsName),
    wildcard: spec.wildcard === true,
    state: str(status.state),
    reason: str(status.reason),
    presented: status.presented === true,
    processing: status.processing === true,
    solverKind: solver.kind,
    solverName: solver.name,
    createdAt: meta.createdAt,
    readAt: now.toISOString(),
  }, [...secrets, ...acmeSecrets(item)]);
}

/** The inventory line of a Challenge: healthy when its state is valid. */
export function challengeItem(c: ChallengeData): StateItem {
  return stateItem({
    namespace: c.namespace,
    name: c.name,
    dataName: dataName(c.namespace, c.name),
    healthy: c.state === "valid",
    state: c.state,
    why: c.reason,
  });
}

/** The issuer kinds cert-manager itself serves. */
export const ISSUER_KINDS = ["Issuer", "ClusterIssuer"] as const;

/** One of the issuer kinds. */
export type IssuerKind = typeof ISSUER_KINDS[number];

/** An Issuer or ClusterIssuer as stored. */
export const IssuerSchema = z.object({
  name: z.string(),
  namespace: z.string().describe("Empty for a ClusterIssuer"),
  kind: z.enum(ISSUER_KINDS),
  type: z.string().describe(
    "acme, ca, selfSigned, vault, venafi, or unknown",
  ),
  ready: z.boolean(),
  readyReason: z.string(),
  readyMessage: z.string(),
  acmeServer: z.string().nullable().describe("The ACME directory URL"),
  conditions: z.array(ConditionSchema),
  readAt: z.string(),
});

/** One stored issuer record. */
export type IssuerData = z.infer<typeof IssuerSchema>;

const ISSUER_TYPES = ["acme", "ca", "selfSigned", "vault", "venafi"];

/** Reduce an Issuer or ClusterIssuer object to the stored record. */
export function parseIssuer(
  item: Record<string, unknown>,
  kind: IssuerKind,
  now: Date,
): IssuerData {
  const meta = readMeta(item, kind === "Issuer", kind);
  const spec = obj(item.spec);
  const conditions = readConditions(obj(item.status).conditions);
  const ready = findCondition(conditions, "Ready");
  return seal({
    name: meta.name,
    namespace: kind === "ClusterIssuer" ? "" : meta.namespace,
    kind,
    type: ISSUER_TYPES.find((t) =>
      spec[t] !== null && typeof spec[t] === "object"
    ) ?? "unknown",
    ready: ready?.status === "True",
    readyReason: ready?.reason ?? "",
    readyMessage: ready?.message ?? "",
    acmeServer: nonEmpty(obj(spec.acme).server),
    conditions,
    readAt: now.toISOString(),
  });
}

/** The data name of an issuer record: the kind first, as two kinds share a spec. */
export function issuerDataName(
  issuer: { kind: IssuerKind; namespace: string; name: string },
): string {
  return issuer.kind === "ClusterIssuer"
    ? `ClusterIssuer--${dataName(null, issuer.name)}`
    : `Issuer--${dataName(issuer.namespace, issuer.name)}`;
}

/** The inventory line of an issuer: healthy when it is Ready. */
export function issuerItem(i: IssuerData): StateItem {
  return stateItem({
    namespace: i.namespace,
    name: i.name,
    dataName: issuerDataName(i),
    healthy: i.ready,
    state: i.ready ? "Ready" : "NotReady",
    why: i.readyMessage || i.readyReason,
  });
}
