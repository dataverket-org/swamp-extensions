/**
 * What the cert-manager types share and what belongs to cert-manager alone:
 * the argument schemas for a name and a namespace, the issuer reference, the
 * line a list writes into its inventory, the resource names, and the kubectl
 * call that says "cert-manager is not installed" when its CRDs are not
 * served.
 *
 * Everything about running kubectl (the spawn, the time limit, the named
 * failures, the name checks, the readers, the data names) comes from the
 * shared layer in `../lib/kubectl.ts` and `../lib/cli.ts`.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { brief, redact } from "../lib/cli.ts";
import {
  arr,
  InventoryItemSchema,
  InventorySchema,
  isKubectlError,
  KubectlError,
  type KubectlGlobalArgs,
  kubectlOpts,
  NAMESPACE_NAME,
  obj,
  OBJECT_NAME,
  runKubectl,
  str,
} from "../lib/kubectl.ts";

/** An object name argument: a DNS subdomain, as Kubernetes requires. */
export const NameSchema = z.string().regex(
  OBJECT_NAME,
  "must be a Kubernetes object name: lowercase letters, digits, '-' and '.', starting and ending with a letter or digit, at most 253 characters",
);

/**
 * A namespace argument: a DNS label, as Kubernetes requires. Empty is
 * allowed and means "not given": swamp fills a method argument from the
 * global argument of the same name, whose default is empty.
 */
export const NamespaceSchema = z.string().regex(
  new RegExp(`^(${NAMESPACE_NAME.source.slice(1, -1)})?$`),
  "must be a Kubernetes namespace name: lowercase letters, digits and '-', starting and ending with a letter or digit, at most 63 characters",
);

/** A reference to the issuer of a certificate, request, order or challenge. */
export const IssuerRefSchema = z.object({
  name: z.string(),
  kind: z.string(),
  group: z.string(),
});

/** One stored issuer reference. */
export type IssuerRef = z.infer<typeof IssuerRefSchema>;

/** An issuer reference with cert-manager's defaults filled in. */
export function readIssuerRef(v: unknown): IssuerRef {
  const ref = obj(v);
  return {
    name: str(ref.name),
    kind: str(ref.kind) || "Issuer",
    group: str(ref.group) || "cert-manager.io",
  };
}

/**
 * An ACME key authorization by its shape (RFC 8555, section 8.1): the
 * challenge token, a dot, and the base64url SHA-256 thumbprint of the
 * account key, which is always 43 characters. A token has at least 128 bits
 * of entropy, so at least 22 base64url characters. The match must stand
 * alone: not inside a longer dotted name, so a DNS name whose labels happen
 * to have these lengths is left alone unless it ends there.
 */
const KEY_AUTHORIZATION =
  /(?<![A-Za-z0-9_.-])([A-Za-z0-9_-]{22,})\.[A-Za-z0-9_-]{43}(?![A-Za-z0-9_-]|\.[A-Za-z0-9_-])/g;

/**
 * A challenge token by where it stands: the last part of the HTTP-01 URL
 * (RFC 8555, section 8.3). cert-manager quotes that URL when its self check
 * cannot reach the solver at all.
 */
const CHALLENGE_URL = /\/\.well-known\/acme-challenge\/([A-Za-z0-9_-]{8,})/g;

/**
 * The key authorizations a text quotes, each followed by its token, and the
 * tokens of the HTTP-01 challenge URLs it quotes. They
 * are found by shape, for text of an object that does not hold the token
 * itself: cert-manager's HTTP-01 self check quotes the expected key in the
 * reason of a Challenge, and that reason travels into other messages. A
 * DNS-01 value (43 base64url characters, no dot) and a token outside such a
 * URL have no shape that tells them from a hash or an id, so they are not
 * found here;
 * they are blanked by value where the Challenge or Order is at hand.
 */
export function keyAuthorizations(text: string): string[] {
  const found: string[] = [];
  for (const m of text.matchAll(KEY_AUTHORIZATION)) found.push(m[0], m[1]);
  for (const m of text.matchAll(CHALLENGE_URL)) found.push(m[1]);
  return [...new Set(found)];
}

/** Shorter values are not named as secrets: they would blank ordinary words. */
const SHORTEST_SECRET = 8;

/**
 * The secrets an ACME Challenge or Order holds, as kubectl printed it: the
 * Challenge's token and key (the key authorization for HTTP-01, its digest
 * for DNS-01) and the token of every challenge an Order's authorizations
 * list. Given to `seal` so they are blanked by value.
 */
export function acmeSecrets(...items: unknown[]): string[] {
  const out: unknown[] = [];
  for (const item of items) {
    const spec = obj(obj(item).spec);
    out.push(spec.token, spec.key);
    for (const a of arr(obj(obj(item).status).authorizations)) {
      for (const c of arr(obj(a).challenges)) out.push(obj(c).token);
    }
  }
  return [
    ...new Set(
      out.filter((s): s is string =>
        typeof s === "string" && s.length >= SHORTEST_SECRET
      ),
    ),
  ];
}

/** Fields that say which object a record is about; `seal` leaves them. */
const IDENTITY = new Set([
  "name",
  "namespace",
  "kind",
  "group",
  "dataName",
  "certificateName",
  "certificateRequestName",
  "orderName",
  "secretName",
  "dnsNames",
  "dnsName",
  "commonName",
  "ipAddresses",
  "identifier",
]);

function texts(v: unknown, out: string[]): string[] {
  if (typeof v === "string") out.push(v);
  else if (Array.isArray(v)) { for (const x of v) texts(x, out); }
  else if (v !== null && typeof v === "object") {
    for (const [k, x] of Object.entries(v)) if (!IDENTITY.has(k)) texts(x, out);
  }
  return out;
}

function sealed(v: unknown, secrets: string[]): unknown {
  if (typeof v === "string") return redact(v, secrets);
  if (Array.isArray(v)) return v.map((x) => sealed(x, secrets));
  if (v !== null && typeof v === "object") {
    return Object.fromEntries(
      Object.entries(v).map((
        [k, x],
      ) => [k, IDENTITY.has(k) ? x : sealed(x, secrets)]),
    );
  }
  return v;
}

/**
 * A record with every text field made safe to store: `secrets` and every
 * key authorization any of its texts quotes are blanked by value, and the
 * shared redaction is applied. The fields that identify the object (names,
 * namespaces, DNS names) are left as they are. Blanking is the shared
 * layer's `redact`; this only says which values to name.
 */
export function seal<T>(record: T, secrets: string[] = []): T {
  const all = [
    ...new Set([
      ...secrets,
      ...texts(record, []).flatMap(keyAuthorizations),
    ]),
  ];
  return sealed(record, all) as T;
}

/**
 * One line of a list's inventory: the shared core (namespace, name, data
 * name, healthy, reason) and the state cert-manager gives the object.
 */
export const StateItemSchema = InventoryItemSchema.extend({
  state: z.string().describe(
    "The state of the object in one word, as its kind names it; empty when the controller has not written one",
  ),
});

/** One stored inventory line. */
export type StateItem = z.infer<typeof StateItemSchema>;

/**
 * What one `list` run saw: every object of the kind in scope. The records of
 * objects that no longer exist stay in the data store, so this is the record
 * that says which objects existed at `observedAt`.
 */
export const StateInventorySchema = InventorySchema.extend({
  items: z.array(StateItemSchema),
});

/**
 * Build one inventory line. A healthy object has no reason; one that is not
 * healthy always has one line: what the controller said, else its state.
 */
export function stateItem(
  o: {
    namespace: string | null;
    name: string;
    dataName: string;
    healthy: boolean;
    state: string;
    why: string;
  },
): StateItem {
  return {
    namespace: o.namespace || null,
    name: o.name,
    dataName: o.dataName,
    healthy: o.healthy,
    reason: o.healthy
      ? null
      : brief(o.why, 300) || (o.state ? `state is ${o.state}` : "no state yet"),
    state: o.state,
  };
}

/** The logger a method receives. */
export interface MethodLogger {
  info: (msg: string, props?: Record<string, string>) => void;
}

/** The context every method in this extension reads. */
export interface MethodContext {
  globalArgs: KubectlGlobalArgs;
  logger: MethodLogger;
  signal?: AbortSignal;
  writeResource: (
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<unknown>;
}

/** The kubectl resource names, each with its full API group. */
export const RESOURCES = {
  certificate: "certificates.cert-manager.io",
  certificateRequest: "certificaterequests.cert-manager.io",
  issuer: "issuers.cert-manager.io",
  clusterIssuer: "clusterissuers.cert-manager.io",
  order: "orders.acme.cert-manager.io",
  challenge: "challenges.acme.cert-manager.io",
} as const;

/**
 * Run kubectl against the cluster of the definition and return the parsed
 * answer. A resource type the cluster does not serve is said in this
 * domain's words: cert-manager is not installed. `stdin` is given to kubectl
 * on standard input.
 */
export async function kubectlJson(
  args: string[],
  context: Pick<MethodContext, "globalArgs" | "signal">,
  stdin?: string,
): Promise<unknown> {
  try {
    return await runKubectl(args, { ...kubectlOpts(context), stdin });
  } catch (err) {
    if (isKubectlError(err, "missing-crd")) {
      throw new KubectlError(
        "missing-crd",
        `cert-manager is not installed in this cluster: ${err.message}`,
        err.stderr,
      );
    }
    throw err;
  }
}
