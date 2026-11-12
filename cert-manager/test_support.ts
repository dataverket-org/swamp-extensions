/**
 * Fixtures and shared assertions of the cert-manager tests: the objects the
 * parsers read, and the planted values that must reach no record.
 *
 * @module
 */
import { HOSTILE } from "../lib/test_inputs.ts";

export { HOSTILE };

/** Every value in the fixtures that must never reach a record, log or error. */
export const SECRETS = [
  "SECRET-TOKEN",
  "SECRET-KEY",
  "SECRET-CSR",
  "SECRET-PEM",
  "SECRET-CA-PEM",
  "SECRET-CONFIG",
  "SECRET-URL",
  "SECRET-HASH",
];

/**
 * An ACME challenge token, the account key thumbprint, and the key
 * authorization made of them (RFC 8555, section 8.1), shaped as Pebble and
 * Let's Encrypt make them: 43 base64url characters each.
 */
export const ACME_TOKEN = "kZrw0Tq3-fX_9aLmC1dE2bGhJ4nP5sUvW6xY7zA8B0c";

export const ACME_THUMBPRINT = "Lr3_tN8qXw-1ZcVbM5kJ2hGfD4sA6pO9iU7yT0eRxQw";

export const KEY_AUTHORIZATION = `${ACME_TOKEN}.${ACME_THUMBPRINT}`;

/**
 * What cert-manager writes into a Challenge's status.reason when the HTTP-01
 * self check gets another answer: the expected key authorization, quoted.
 */
export const SELF_CHECK_REASON =
  `Waiting for HTTP-01 challenge propagation: did not get expected response when querying endpoint, expected "${KEY_AUTHORIZATION}" but got: wrong-answer-84b645d94f-... (truncated)`;

/**
 * What cert-manager writes when the self check cannot reach the solver: the
 * challenge URL, twice, and its last part is the token.
 */
export const SELF_CHECK_UNREACHABLE =
  `Waiting for HTTP-01 challenge propagation: failed to perform self check GET request 'http://wrong.example.test/.well-known/acme-challenge/${ACME_TOKEN}': Get "http://wrong.example.test/.well-known/acme-challenge/${ACME_TOKEN}": dial tcp 10.96.100.80:80: connect: connection refused`;

/** An HTTP-01 Challenge whose self check failed, as kubectl prints it. */
export function selfCheckChallenge(
  name: string,
  owner: { uid: string; name: string },
): Record<string, unknown> {
  const c = challenge(name, owner, {
    wildcard: false,
    solver: { http01: { ingress: {} } },
    status: {
      presented: true,
      processing: true,
      state: "pending",
      reason: SELF_CHECK_REASON,
    },
  });
  Object.assign(c.spec as Record<string, unknown>, {
    type: "HTTP-01",
    dnsName: "wrong.example.test",
    token: ACME_TOKEN,
    key: KEY_AUTHORIZATION,
  });
  return c;
}

/** Fail when the key authorization, or its token alone, is in what was passed. */
export function assertNoKeyAuthorization(...things: unknown[]): void {
  const text = JSON.stringify(things);
  for (const s of [KEY_AUTHORIZATION, ACME_TOKEN]) {
    if (text.includes(s)) {
      throw new Error(
        `the ACME ${
          s === ACME_TOKEN ? "token" : "key authorization"
        } leaked: ...${
          text.slice(Math.max(0, text.indexOf(s) - 120), text.indexOf(s))
        }<here>`,
      );
    }
  }
}

/** Fail when any fixture secret appears in what was passed. */
export function assertNoSecrets(...things: unknown[]): void {
  const text = JSON.stringify(things);
  for (const s of SECRETS) {
    if (text.includes(s)) throw new Error(`${s} leaked: ${text.slice(0, 200)}`);
  }
}

/** A Certificate as kubectl prints it: issued once, Ready. */
export function certificate(
  over: {
    name?: string;
    namespace?: string;
    uid?: string;
    status?: unknown;
    issuerRef?: unknown;
    resourceVersion?: string | null;
  } = {},
): Record<string, unknown> {
  return {
    apiVersion: "cert-manager.io/v1",
    kind: "Certificate",
    metadata: {
      name: over.name ?? "leaf",
      namespace: over.namespace ?? "pki",
      uid: over.uid ?? "uid-cert",
      generation: 4,
      creationTimestamp: "2026-11-10T09:41:41Z",
      ...(over.resourceVersion === null
        ? {}
        : { resourceVersion: over.resourceVersion ?? "2028" }),
    },
    spec: {
      commonName: "leaf.example.test",
      dnsNames: ["leaf.example.test", "www.leaf.example.test"],
      duration: "24h",
      renewBefore: "8h",
      secretName: "leaf-tls",
      issuerRef: over.issuerRef ?? { kind: "Issuer", name: "ca" },
    },
    status: "status" in over ? over.status : {
      conditions: [{
        type: "Ready",
        status: "True",
        reason: "Ready",
        message: "Certificate is up to date and has not expired",
        lastTransitionTime: "2026-11-10T09:41:51Z",
        observedGeneration: 4,
      }],
      notBefore: "2026-11-10T09:42:49Z",
      notAfter: "2026-11-11T09:42:49Z",
      renewalTime: "2026-11-11T01:42:49Z",
      revision: 3,
    },
  };
}

/** The status of a Certificate with an issuance in progress. */
export const issuingStatus = {
  conditions: [
    {
      type: "Ready",
      status: "False",
      reason: "DoesNotExist",
      message: "Issuing certificate as Secret does not exist",
      lastTransitionTime: "2026-11-10T09:41:45Z",
      observedGeneration: 1,
    },
    {
      type: "Issuing",
      status: "True",
      reason: "DoesNotExist",
      message: "Issuing certificate as Secret does not exist",
      lastTransitionTime: "2026-11-10T09:41:45Z",
      observedGeneration: 1,
    },
  ],
  nextPrivateKeySecretName: "hanging-sq9m9",
};

/** A CertificateRequest as kubectl prints it. */
export function request(
  name: string,
  revision: string | undefined,
  owner: { uid?: string; name: string },
  ready: { status: string; reason: string; message: string } = {
    status: "False",
    reason: "Pending",
    message:
      'Waiting on certificate issuance from order acme-test/o: "pending"',
  },
  createdAt = "2026-11-10T09:41:45Z",
): Record<string, unknown> {
  return {
    apiVersion: "cert-manager.io/v1",
    kind: "CertificateRequest",
    metadata: {
      name,
      namespace: "acme-test",
      uid: `uid-${name}`,
      creationTimestamp: createdAt,
      annotations: {
        "cert-manager.io/certificate-name": owner.name,
        ...(revision === undefined
          ? {}
          : { "cert-manager.io/certificate-revision": revision }),
        "cert-manager.io/private-key-secret-name": "hanging-sq9m9",
      },
      ownerReferences: [{
        apiVersion: "cert-manager.io/v1",
        kind: "Certificate",
        name: owner.name,
        ...(owner.uid ? { uid: owner.uid } : {}),
        controller: true,
      }],
    },
    spec: {
      duration: "2160h",
      issuerRef: { kind: "ClusterIssuer", name: "acme-dns01" },
      request: "SECRET-CSR",
      usages: ["digital signature", "key encipherment"],
      username: "system:serviceaccount:cert-manager:cert-manager",
    },
    status: {
      conditions: [
        {
          type: "Approved",
          status: "True",
          reason: "cert-manager.io",
          message: "Certificate request has been approved by cert-manager.io",
          lastTransitionTime: "2026-11-10T09:41:45Z",
        },
        { type: "Ready", ...ready, lastTransitionTime: "2026-11-10T09:41:48Z" },
      ],
      ...(ready.status === "True"
        ? { certificate: "SECRET-PEM", ca: "SECRET-CA-PEM" }
        : {}),
    },
  };
}

/** An ACME Order as kubectl prints it, pending with two authorizations. */
export function order(
  name: string,
  owner: { uid: string; name: string },
  state = "pending",
): Record<string, unknown> {
  const challenges = (types: string[]) =>
    types.map((type) => ({
      type,
      token: "SECRET-TOKEN",
      url: "https://acme.example.test/chalZ/SECRET-URL",
    }));
  return {
    apiVersion: "acme.cert-manager.io/v1",
    kind: "Order",
    metadata: {
      name,
      namespace: "acme-test",
      uid: `uid-${name}`,
      creationTimestamp: "2026-11-10T09:41:48Z",
      ownerReferences: [{
        apiVersion: "cert-manager.io/v1",
        kind: "CertificateRequest",
        name: owner.name,
        uid: owner.uid,
        controller: true,
      }],
    },
    spec: {
      dnsNames: ["*.hang.example.test", "hang.example.test"],
      issuerRef: { kind: "ClusterIssuer", name: "acme-dns01" },
      request: "SECRET-CSR",
    },
    status: {
      state,
      url: "https://acme.example.test/my-order/SECRET-URL",
      finalizeURL: "https://acme.example.test/finalize-order/SECRET-URL",
      authorizations: [
        {
          identifier: "hang.example.test",
          wildcard: true,
          initialState: "pending",
          url: "https://acme.example.test/authZ/SECRET-URL",
          challenges: challenges(["dns-account-01", "dns-01"]),
        },
        {
          identifier: "hang.example.test",
          wildcard: false,
          initialState: "pending",
          url: "https://acme.example.test/authZ/SECRET-URL",
          challenges: challenges(["tls-alpn-01", "http-01", "dns-01"]),
        },
      ],
      ...(state === "valid" ? { certificate: "SECRET-PEM" } : {}),
    },
  };
}

/** An ACME Challenge as kubectl prints it: DNS-01 through a webhook solver. */
export function challenge(
  name: string,
  owner: { uid: string; name: string },
  over: { status?: unknown; wildcard?: boolean; solver?: unknown } = {},
): Record<string, unknown> {
  return {
    apiVersion: "acme.cert-manager.io/v1",
    kind: "Challenge",
    metadata: {
      name,
      namespace: "acme-test",
      uid: `uid-${name}`,
      creationTimestamp: "2026-11-10T09:41:51Z",
      finalizers: ["acme.cert-manager.io/finalizer"],
      ownerReferences: [{
        apiVersion: "acme.cert-manager.io/v1",
        kind: "Order",
        name: owner.name,
        uid: owner.uid,
        controller: true,
      }],
    },
    spec: {
      authorizationURL: "https://acme.example.test/authZ/SECRET-URL",
      url: "https://acme.example.test/chalZ/SECRET-URL",
      dnsName: "hang.example.test",
      wildcard: over.wildcard ?? true,
      type: "DNS-01",
      token: "SECRET-TOKEN",
      key: "SECRET-KEY",
      issuerRef: { kind: "ClusterIssuer", name: "acme-dns01" },
      solver: over.solver ?? {
        dns01: {
          webhook: {
            groupName: "acme.example.test",
            solverName: "absent",
            config: { apiKey: "SECRET-CONFIG" },
          },
        },
      },
    },
    status: "status" in over ? over.status : {
      presented: false,
      processing: true,
      state: "pending",
      reason: "the server could not find the requested resource",
    },
  };
}

/** An ACME ClusterIssuer as kubectl prints it. */
export function clusterIssuer(
  name: string,
  ready: { status: string; reason: string; message: string } = {
    status: "True",
    reason: "ACMEAccountRegistered",
    message: "The ACME account was registered with the ACME server",
  },
): Record<string, unknown> {
  return {
    apiVersion: "cert-manager.io/v1",
    kind: "ClusterIssuer",
    metadata: { name, uid: `uid-${name}` },
    spec: {
      acme: {
        server: "https://acme.example.test/dir",
        caBundle: "SECRET-CA-PEM",
        privateKeySecretRef: { name: "acme-account" },
        solvers: [{
          dns01: { webhook: { config: { apiKey: "SECRET-CONFIG" } } },
        }],
      },
    },
    status: {
      acme: {
        lastPrivateKeyHash: "SECRET-HASH",
        uri: "https://acme.example.test/my-account/SECRET-URL",
      },
      conditions: [{
        type: "Ready",
        ...ready,
        lastTransitionTime: "2026-11-10T09:41:45Z",
        observedGeneration: 1,
      }],
    },
  };
}
