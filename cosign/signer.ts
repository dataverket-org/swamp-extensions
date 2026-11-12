/**
 * `@dataverket/cosign/signer`: one signing identity for container images,
 * driven through [cosign](https://github.com/sigstore/cosign): sign images by
 * digest, verify them against a public key or, keyless, against the identity
 * in a Sigstore certificate, read who signed an image when that identity is
 * not known yet, attach attestations and verify those, sign and verify files
 * with a Sigstore bundle beside each, and generate a key pair.
 *
 * The private key never touches a file or an argument here: a PEM from a
 * vault expression reaches cosign through its environment (`--key env://`),
 * a KMS or HSM reference is passed as it is, and a key file is named by
 * path. cosign runs as a subprocess in the repository root with arguments as
 * argv arrays, never through a shell.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The signer's arguments. */
export const GlobalArgsSchema = z.object({
  key: z.string().meta({ sensitive: true }).default("").describe(
    "The private key: a PEM, written as a vault expression; a KMS or HSM reference (awskms://, gcpkms://, azurekms://, hashivault://, k8s://, pkcs11:); or a key file, absolute or relative to the repository root. Empty for a signer that only verifies",
  ),
  password: z.string().meta({ sensitive: true }).default("").describe(
    "The key's passphrase, written as a vault expression; empty for an unencrypted key",
  ),
  publicKey: z.string().default("").describe(
    "The public key verify checks against: a PEM, or a file absolute or relative to the repository root; derived from key when empty",
  ),
  certificateIdentity: z.string().default("").describe(
    "For keyless verification: the exact identity the signing certificate must name, such as a GitHub workflow URL; verify, verifyAttestation and verifyBlob then check the certificate and its log entry instead of a public key. Needs oidcIssuer and tlog true",
  ),
  certificateIdentityRegexp: z.string().default("").describe(
    "For keyless verification: a regular expression the certificate's identity must match, instead of certificateIdentity",
  ),
  oidcIssuer: z.string().default("").describe(
    "For keyless verification: the OIDC issuer that vouched for the identity, such as https://token.actions.githubusercontent.com; required with an identity",
  ),
  tlog: z.boolean().default(false).describe(
    "Record every signature in a transparency log and require a log entry when verifying; false signs through a signing config with no log service and verifies ignoring the log. Keyless verification requires true; identify requires the log entry of a certificate whatever this says",
  ),
  signingConfig: z.string().default("").describe(
    "A Sigstore signing config file for sign and attest, relative to the repository root, such as one naming a private Rekor or TSA; replaces what tlog chooses",
  ),
  trustedRoot: z.string().default("").describe(
    "A Sigstore trusted root file for sign, attest, verify and identify, relative to the repository root, for private infrastructure",
  ),
  insecureRegistry: z.boolean().default(false).describe(
    "Allow a registry whose certificate does not verify",
  ),
  httpRegistry: z.boolean().default(false).describe(
    "Allow a registry served over plain HTTP",
  ),
  cosignBinary: z.string().min(1).default("cosign"),
});

/** The signer's arguments, parsed. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RefsSchema = z.array(z.string().min(1)).min(1).describe(
  "Image references pinned by digest, <repository>@sha256:<digest>; a tag is refused",
);

/** `sign`'s arguments. */
export const SignArgsSchema = z.object({
  refs: RefsSchema,
  annotations: z.array(z.string()).default([]).describe(
    "Annotations carried by every signature, key=value",
  ),
  recursive: z.boolean().default(false).describe(
    "For an image index, also sign every image in it",
  ),
  upload: z.boolean().default(true).describe(
    "Push the signature to the registry; false signs and discards, a rehearsal",
  ),
});

/** `verify`'s arguments. */
export const VerifyArgsSchema = z.object({
  refs: RefsSchema,
  annotations: z.array(z.string()).default([]).describe(
    "Annotations a signature must carry to count, key=value",
  ),
});

/** `identify`'s arguments. */
export const IdentifyArgsSchema = z.object({ refs: RefsSchema });

/** `attest`'s arguments. */
export const AttestArgsSchema = z.object({
  refs: RefsSchema,
  predicate: z.string().min(1).describe(
    "The predicate file, absolute or relative to the repository root",
  ),
  type: z.string().min(1).default("custom").describe(
    "The predicate type: slsaprovenance, slsaprovenance02, slsaprovenance1, link, spdx, spdxjson, cyclonedx, vuln, openvex, custom, or a URI",
  ),
  upload: z.boolean().default(true).describe(
    "Push the attestation to the registry",
  ),
});

/** `verifyAttestation`'s arguments. */
export const VerifyAttestationArgsSchema = z.object({
  refs: RefsSchema,
  type: z.string().min(1).default("custom").describe(
    "The predicate type an attestation must have to count",
  ),
  sourceRepository: z.string().default("").describe(
    "When set, an attestation counts only if the source repository its provenance names equals this exactly, such as https://github.com/<owner>/<repository>; empty asks nothing",
  ),
  sourceCommit: z.string().default("").describe(
    "When set, an attestation counts only if the source commit its provenance names equals this exactly, the full hash in lower case; empty asks nothing",
  ),
});

/** `signBlob`'s arguments. */
export const SignBlobArgsSchema = z.object({
  path: z.string().min(1).describe(
    "The file to sign, absolute or relative to the repository root",
  ),
  bundle: z.string().default("").describe(
    "Where the Sigstore bundle is written, absolute or relative to the repository root; <path>.sigstore.json when empty",
  ),
});

/** `verifyBlob`'s arguments. */
export const VerifyBlobArgsSchema = z.object({
  path: z.string().min(1).describe(
    "The file to verify, absolute or relative to the repository root",
  ),
  bundle: z.string().default("").describe(
    "Its Sigstore bundle, absolute or relative to the repository root; <path>.sigstore.json when empty",
  ),
});

type SignArgs = z.infer<typeof SignArgsSchema>;
type IdentifyArgs = z.infer<typeof IdentifyArgsSchema>;
type VerifyArgs = z.infer<typeof VerifyArgsSchema>;
type AttestArgs = z.infer<typeof AttestArgsSchema>;
type VerifyAttestationArgs = z.infer<typeof VerifyAttestationArgsSchema>;
type SignBlobArgs = z.infer<typeof SignBlobArgsSchema>;
type VerifyBlobArgs = z.infer<typeof VerifyBlobArgsSchema>;

/** How a key was given. */
export const KEY_KINDS = ["none", "pem", "reference", "file"] as const;

/** How a signer verifies: against a public key, against a certificate identity, or not at all. */
export const VERIFY_MODES = ["key", "keyless", "none"] as const;

const SignerSchema = z.object({
  version: z.string(),
  keyKind: z.enum(KEY_KINDS),
  publicKey: z.string(),
  publicKeySource: z.enum(["argument", "derived", "none"]),
  fingerprint: z.string(),
  verifyMode: z.enum(VERIFY_MODES),
  certificateIdentity: z.string(),
  certificateIdentityRegexp: z.string(),
  oidcIssuer: z.string(),
  tlog: z.boolean(),
  signingConfig: z.string(),
  trustedRoot: z.string(),
  checkedAt: z.iso.datetime(),
});

const KeypairSchema = z.object({
  publicKey: z.string(),
  privateKey: z.string().meta({ sensitive: true }),
  passphraseSet: z.boolean(),
  generatedAt: z.iso.datetime(),
});

const SignatureSchema = z.object({
  ref: z.string(),
  repository: z.string(),
  digest: z.string(),
  annotations: z.record(z.string(), z.string()),
  recursive: z.boolean(),
  uploaded: z.boolean(),
  tlog: z.boolean(),
  signedAt: z.iso.datetime(),
});

const PayloadSchema = z.object({
  digest: z.string(),
  annotations: z.record(z.string(), z.string()),
});

const VerificationSchema = z.object({
  ref: z.string(),
  repository: z.string(),
  digest: z.string(),
  verified: z.boolean(),
  signatures: z.number().int(),
  payloads: z.array(PayloadSchema),
  annotations: z.record(z.string(), z.string()),
  verifyMode: z.enum(["key", "keyless"]),
  certificateIdentity: z.string(),
  certificateIdentityRegexp: z.string(),
  oidcIssuer: z.string(),
  publicKeyFingerprint: z.string(),
  error: z.string(),
  tlog: z.boolean(),
  verifiedAt: z.iso.datetime(),
});

/** How a signature is stored: as a Sigstore bundle, or under a `.sig` tag. */
export const SIGNATURE_FORMS = ["bundle", "tag"] as const;

/** What `identify` found for one image. */
export const IDENTIFY_STATES = [
  "identified",
  "several-identities",
  "key-signed",
  "unproven",
  "unsigned",
  "not-found",
] as const;

const IdentifiedSignatureSchema = z.object({
  form: z.enum(SIGNATURE_FORMS),
  signedWith: z.enum(["certificate", "key", "unknown"]),
  subjectMatches: z.boolean(),
  certificateGenuine: z.boolean(),
  certificateIdentity: z.string(),
  oidcIssuer: z.string(),
  claims: z.record(z.string(), z.string()),
  unprovenIdentity: z.string(),
  unprovenIssuer: z.string(),
  unprovenKeyFingerprint: z.string(),
  reason: z.string(),
  withheld: z.number().int(),
});

const IdentificationSchema = z.object({
  ref: z.string(),
  repository: z.string(),
  digest: z.string(),
  state: z.enum(IDENTIFY_STATES),
  certificateIdentity: z.string(),
  oidcIssuer: z.string(),
  identities: z.array(z.object({
    certificateIdentity: z.string(),
    oidcIssuer: z.string(),
    signatures: z.number().int(),
  })),
  identityChecked: z.literal(false),
  signaturesFound: z.number().int(),
  certificatesGenuine: z.number().int(),
  keySigned: z.number().int(),
  otherStatements: z.number().int(),
  tagSignaturesUnlisted: z.boolean(),
  forms: z.array(z.enum(SIGNATURE_FORMS)),
  signatures: z.array(IdentifiedSignatureSchema),
  reason: z.string(),
  identifiedAt: z.iso.datetime(),
});

const AttestationSchema = z.object({
  ref: z.string(),
  repository: z.string(),
  digest: z.string(),
  type: z.string(),
  predicate: z.string(),
  predicateSha256: z.string(),
  uploaded: z.boolean(),
  tlog: z.boolean(),
  attestedAt: z.iso.datetime(),
});

const SubjectSchema = z.object({
  name: z.string().nullable(),
  digest: z.record(z.string(), z.string()),
});

const ProvenanceSchema = z.object({
  buildType: z.string().nullable(),
  workflow: z.object({
    repository: z.string().nullable(),
    ref: z.string().nullable(),
    path: z.string().nullable(),
  }).nullable(),
  resolvedDependencies: z.array(z.object({
    uri: z.string().nullable(),
    gitCommit: z.string().nullable(),
  })),
  resolvedDependencyCount: z.number().int(),
  builderId: z.string().nullable(),
  invocationId: z.string().nullable(),
});

const StatementSchema = z.object({
  predicateType: z.string(),
  subjects: z.array(SubjectSchema),
  subjectCount: z.number().int(),
  subjectMatches: z.boolean(),
  counted: z.boolean(),
  reason: z.string(),
  provenance: ProvenanceSchema.nullable(),
  sourceRepository: z.string().nullable(),
  sourceRef: z.string().nullable(),
  sourceCommit: z.string().nullable(),
  builderId: z.string().nullable(),
  withheld: z.number().int(),
});

const AttestationVerificationSchema = z.object({
  ref: z.string(),
  repository: z.string(),
  digest: z.string(),
  type: z.string(),
  verified: z.boolean(),
  attestations: z.number().int(),
  matched: z.number().int(),
  predicateTypes: z.array(z.string()),
  statements: z.array(StatementSchema),
  sourceRepository: z.string().nullable(),
  sourceRef: z.string().nullable(),
  sourceCommit: z.string().nullable(),
  builderId: z.string().nullable(),
  expectedSourceRepository: z.string(),
  expectedSourceCommit: z.string(),
  verifyMode: z.enum(["key", "keyless"]),
  certificateIdentity: z.string(),
  certificateIdentityRegexp: z.string(),
  oidcIssuer: z.string(),
  publicKeyFingerprint: z.string(),
  error: z.string(),
  tlog: z.boolean(),
  verifiedAt: z.iso.datetime(),
});

const BlobSignatureSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bundle: z.string(),
  tlog: z.boolean(),
  signedAt: z.iso.datetime(),
});

const BlobVerificationSchema = z.object({
  path: z.string(),
  sha256: z.string(),
  bundle: z.string(),
  verified: z.boolean(),
  error: z.string(),
  tlog: z.boolean(),
  verifiedAt: z.iso.datetime(),
});

type BlobSignature = z.infer<typeof BlobSignatureSchema>;
type BlobVerification = z.infer<typeof BlobVerificationSchema>;
type Signer = z.infer<typeof SignerSchema>;
type Keypair = z.infer<typeof KeypairSchema>;
type Signature = z.infer<typeof SignatureSchema>;
type Payload = z.infer<typeof PayloadSchema>;
type Verification = z.infer<typeof VerificationSchema>;
type Attestation = z.infer<typeof AttestationSchema>;
type AttestationVerification = z.infer<typeof AttestationVerificationSchema>;
type Subject = z.infer<typeof SubjectSchema>;
type Identification = z.infer<typeof IdentificationSchema>;

/** One signature `identify` found, as the record keeps it. */
export type IdentifiedSignature = z.infer<typeof IdentifiedSignatureSchema>;
type Provenance = z.infer<typeof ProvenanceSchema>;

/** What one verified attestation says, as the record keeps it. */
export type Statement = z.infer<typeof StatementSchema>;

/** A data handle, as swamp returns it. */
export type Handle = { name: string };

/** The parts of swamp's method context the signer uses. */
export type Context = {
  globalArgs: GlobalArgs;
  repoDir: string;
  signal?: AbortSignal;
  traceHeaders?: Readonly<Record<string, string>>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<Handle>;
};

/** A command's outcome. */
export type CommandResult = { code: number; stdout: string; stderr: string };

/** Where and with what a command runs. */
export type ExecOptions = { cwd: string; env: Record<string, string> };

/** Runs one command. Replaced in tests. */
export type Exec = (
  bin: string,
  args: string[],
  opts: ExecOptions,
  ctx: Context,
) => Promise<CommandResult>;

async function denoExec(
  bin: string,
  args: string[],
  opts: ExecOptions,
  ctx: Context,
): Promise<CommandResult> {
  // cosign is the interface being driven; see README "Commands".
  // swamp-quality-ignore deno-command
  const out = await new Deno.Command(bin, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
    signal: ctx.signal,
  }).output();
  const decoder = new TextDecoder();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

let exec: Exec = denoExec;

/** Swaps the command runner; returns a function that restores it. */
export function __setExec(fake: Exec): () => void {
  const prev = exec;
  exec = fake;
  return () => {
    exec = prev;
  };
}

/** Makes `path` absolute against `root` when it is relative; "" stays "". */
export function absolute(root: string, path: string): string {
  if (path === "" || path.startsWith("/")) return path;
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\.\/+/, "")}`;
}

const PEM = /^-----BEGIN [A-Z ]+-----\r?\n[\s\S]+-----END [A-Z ]+-----\s*$/;
const REFERENCE = /^([a-z0-9]+:\/\/|pkcs11:)/;
// A repository starts with a letter or a digit, as a registry host does: one
// that starts with a dash would be read by cosign as a flag.
const DIGEST_REF = /^([A-Za-z0-9][^@\s]*)@(sha256:[0-9a-f]{64})$/;
const ANNOTATION = /^[^=\s]+=[^\n]*$/;

/** How `key` was given. */
export function keyKind(key: string): (typeof KEY_KINDS)[number] {
  if (key === "") return "none";
  if (key.startsWith("-----BEGIN")) return "pem";
  if (REFERENCE.test(key)) return "reference";
  return "file";
}

/** The arguments `verifyMode` reads. */
type VerifyChoice = {
  key?: string;
  publicKey?: string;
  certificateIdentity?: string;
  certificateIdentityRegexp?: string;
};

/**
 * How `g` verifies: keyless when a certificate identity is set, by key when
 * a public key is given or can be derived from the private key, else not at
 * all. An identity wins over a key, so a signer can sign with its key and
 * verify another party's keyless signatures.
 */
export function verifyMode(g: VerifyChoice): (typeof VERIFY_MODES)[number] {
  if (
    (g.certificateIdentity ?? "") !== "" ||
    (g.certificateIdentityRegexp ?? "") !== ""
  ) {
    return "keyless";
  }
  if ((g.publicKey ?? "") !== "" || keyKind(g.key ?? "") !== "none") {
    return "key";
  }
  return "none";
}

/** What is wrong with the keyless arguments as a set, or null. */
export function identityProblem(
  g: z.input<typeof GlobalArgsSchema>,
): string | null {
  const identity = g.certificateIdentity ?? "";
  const regexp = g.certificateIdentityRegexp ?? "";
  const issuer = g.oidcIssuer ?? "";
  if (identity === "" && regexp === "") {
    if (issuer !== "") {
      return "oidcIssuer is set without a certificate identity: name what the certificate must say in certificateIdentity or certificateIdentityRegexp";
    }
    return null;
  }
  if (identity !== "" && regexp !== "") {
    return "certificateIdentity and certificateIdentityRegexp are both set: one names the identity exactly, the other matches it, choose one";
  }
  if (issuer === "") {
    return "a certificate identity without oidcIssuer: a keyless signature is checked against the identity and the issuer that vouched for it";
  }
  if ((g.publicKey ?? "") !== "") {
    return "publicKey and a certificate identity are both set: a signer verifies against a key or against an identity, not both";
  }
  if (!(g.tlog ?? false)) {
    return "tlog is false with a certificate identity: a keyless signature lives in the transparency log, so set tlog to true";
  }
  return null;
}

/** What is wrong with the arguments as written, or null. */
export function argumentProblem(
  g: z.input<typeof GlobalArgsSchema>,
): string | null {
  const key = g.key ?? "";
  for (
    const [name, value] of [
      ["key", key],
      ["password", g.password ?? ""],
      ["publicKey", g.publicKey ?? ""],
      ["certificateIdentity", g.certificateIdentity ?? ""],
      ["certificateIdentityRegexp", g.certificateIdentityRegexp ?? ""],
      ["oidcIssuer", g.oidcIssuer ?? ""],
    ]
  ) {
    if (value.includes("${{")) {
      return `${name} holds an unevaluated expression; a check on an auto-definition sees the text a workflow wrote, run the workflow instead`;
    }
  }
  if (keyKind(key) === "pem" && !PEM.test(key)) {
    return "key starts like a PEM but is not one whole PEM block";
  }
  if (keyKind(key) === "file" && /[\n\r]/.test(key)) {
    return "key is neither a PEM nor a reference, and holds a newline, so it is not a path either";
  }
  const pub = g.publicKey ?? "";
  if (pub.startsWith("-----BEGIN") && !PEM.test(pub)) {
    return "publicKey starts like a PEM but is not one whole PEM block";
  }
  if (!pub.startsWith("-----BEGIN") && /[\n\r]/.test(pub)) {
    return "publicKey is not a PEM and holds a newline, so it is not a path either";
  }
  for (
    const [name, value] of [
      ["signingConfig", g.signingConfig],
      ["trustedRoot", g.trustedRoot],
      ["certificateIdentity", g.certificateIdentity],
      ["certificateIdentityRegexp", g.certificateIdentityRegexp],
      ["oidcIssuer", g.oidcIssuer],
    ]
  ) {
    if (/[\n\r]/.test(value ?? "")) return `${name} holds a newline`;
  }
  return identityProblem(g);
}

/** Splits `<repository>@sha256:<hex>`, or says why it is not one. */
export function parseDigestRef(
  ref: string,
): { repository: string; digest: string } | string {
  const m = ref.match(DIGEST_REF);
  if (!m) {
    return `${
      JSON.stringify(ref)
    } is not an image reference pinned by digest (<repository>@sha256:<64 hex>); sign and verify digests, a tag can move`;
  }
  return { repository: m[1], digest: m[2] };
}

function refsProblem(refs: string[]): string | null {
  for (const r of refs) {
    const parsed = parseDigestRef(r);
    if (typeof parsed === "string") return parsed;
  }
  return null;
}

function annotationsProblem(annotations: string[]): string | null {
  for (const a of annotations) {
    if (!ANNOTATION.test(a)) {
      return `annotation ${JSON.stringify(a)} is not key=value`;
    }
  }
  return null;
}

/** `key=value` pairs as a record; a later key wins. */
export function annotationRecord(
  annotations: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of annotations) {
    const i = a.indexOf("=");
    out[a.slice(0, i)] = a.slice(i + 1);
  }
  return out;
}

/** What cosign verify printed, as payloads; throws on anything but a JSON array. */
export function parseVerifyOutput(stdout: string): Payload[] {
  const text = stdout.trim();
  if (text === "") return [];
  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `cosign verify printed something that is not JSON: ${text.slice(0, 200)}`,
    );
  }
  if (!Array.isArray(parsed)) {
    throw new Error("cosign verify printed JSON that is not an array");
  }
  return parsed.map((p) => {
    const o = p as {
      critical?: { image?: { "docker-manifest-digest"?: string } };
      optional?: Record<string, unknown> | null;
    };
    const annotations: Record<string, string> = {};
    for (const [k, v] of Object.entries(o.optional ?? {})) {
      annotations[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
    return {
      digest: o.critical?.image?.["docker-manifest-digest"] ?? "",
      annotations,
    };
  });
}

/** The in-toto statements in the DSSE envelopes cosign verify-attestation printed, one per line. */
export function parseStatements(stdout: string): unknown[] {
  const statements: unknown[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    let envelope: { payload?: string };
    try {
      envelope = JSON.parse(text);
    } catch {
      throw new Error(
        `cosign verify-attestation printed a line that is not JSON: ${
          text.slice(0, 200)
        }`,
      );
    }
    try {
      statements.push(JSON.parse(
        new TextDecoder().decode(
          Uint8Array.from(
            atob(envelope?.payload ?? ""),
            (c) => c.charCodeAt(0),
          ),
        ),
      ));
    } catch {
      throw new Error(
        "cosign verify-attestation printed an envelope whose payload is not an in-toto statement",
      );
    }
  }
  return statements;
}

/** The longest text kept from a statement; a longer value is not stored. */
const MAX_TEXT = 1024;
/** How many statements, subjects and dependencies a record keeps; the counts say how many there were. */
const MAX_LIST = 20;
/** How many predicate types a record keeps; `attestations` is the whole number. */
const MAX_TYPES = 100;

const SLSA_V1 = "https://slsa.dev/provenance/v1";
const SLSA_V02 = "https://slsa.dev/provenance/v0.2";

/** A whole SHA-1 or SHA-256 in lower case: what a git commit is. */
const COMMIT = /^([0-9a-f]{40}|[0-9a-f]{64})$/;
// deno-lint-ignore no-control-regex
const CONTROL = /[\u0000-\u001f\u007f]/;
const HEX = /^[0-9a-fA-F]{7,128}$/;
/** The digest algorithms kept for a subject; a name is text a statement chose. */
const SUBJECT_ALGORITHMS = ["sha256", "sha512", "sha384", "sha1", "gitCommit"];

/** `v` when it is an object with fields, else an object with none. */
function fields(v: unknown): Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v)
    ? v as Record<string, unknown>
    : {};
}

function own(o: Record<string, unknown>, key: string): unknown {
  return Object.hasOwn(o, key) ? o[key] : undefined;
}

/** Counts what a statement held and the record does not keep. */
type Tally = { withheld: number };

/** Whether `v` is text short enough to keep, with no control character. */
function plain(v: unknown): v is string {
  return typeof v === "string" && v.length <= MAX_TEXT && !CONTROL.test(v);
}

/**
 * `v` when it is text short enough to keep, with no control character;
 * null for a field that is not there. Anything else is counted as withheld
 * and is null too. For what is not a URL: a subject name, a ref, a path.
 */
function kept(v: unknown, tally: Tally): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (!plain(v)) {
    tally.withheld++;
    return null;
  }
  return v;
}

/** URI schemes that have no host, so no place for a user or a password. */
const OPAQUE = /^(pkg|mailto|urn):(?!\/\/)[^?#\s\\]+$/i;
// The host starts right after the two slashes: a third slash is refused,
// where a URL parser would take the first path segment for the host.
const HIERARCHICAL = /^(?:git\+)?(https?|git|ssh):\/\/[^\/\s\\][^\s\\]*$/i;

/**
 * Whether `v` is a URL that can be stored: http, https, git or ssh, with
 * or without `git+` before it, that parses with a host and has no user, no
 * password, no query and no fragment; or a `pkg:`, `mailto:` or `urn:`
 * URI, which has no host, without query or fragment. Anything else is not:
 * no scheme, one slash, a space, a backslash, another scheme, and the scp
 * form `git@host:path`, whose user cannot be told from a credential.
 */
export function storableUrl(v: unknown): v is string {
  if (!plain(v)) return false;
  if (OPAQUE.test(v)) return true;
  if (!HIERARCHICAL.test(v) || /[?#]/.test(v)) return false;
  let url: URL;
  try {
    url = new URL(v.replace(/^git\+/i, ""));
  } catch {
    return false;
  }
  return url.hostname !== "" && url.username === "" && url.password === "" &&
    url.search === "" && url.hash === "";
}

/** `v` when it is a URL that can be stored, see storableUrl; else as kept. */
function keptUrl(v: unknown, tally: Tally): string | null {
  if (v === undefined || v === null || v === "") return null;
  if (!storableUrl(v)) {
    tally.withheld++;
    return null;
  }
  return v;
}

/** An invocation id: a URL that can be stored, or one plain token. */
function keptId(v: unknown, tally: Tally): string | null {
  return typeof v === "string" && /^[A-Za-z0-9._-]+$/.test(v)
    ? kept(v, tally)
    : keptUrl(v, tally);
}

/** A hash as hex, as it was given, or null. */
function keptHex(v: unknown, tally: Tally): string | null {
  if (v === undefined || v === null) return null;
  if (typeof v !== "string" || !HEX.test(v)) {
    tally.withheld++;
    return null;
  }
  return v;
}

/**
 * A git URI as SLSA writes it, `git+<repository URL>[@<ref>]`, split; null
 * for anything else, and for a URL with a user, a password or a query.
 */
export function parseGitUri(
  uri: unknown,
): { repository: string; ref: string | null } | null {
  if (
    typeof uri !== "string" || !uri.startsWith("git+") || CONTROL.test(uri)
  ) {
    return null;
  }
  const m = uri.slice("git+".length).match(
    /^([a-z][a-z0-9+.-]*:\/\/[^\/?#@\s]+\/[^@?#\s]*)(?:@([^?#\s]+))?$/,
  );
  if (!m || m[1].length > MAX_TEXT || (m[2] ?? "").length > MAX_TEXT) {
    return null;
  }
  return { repository: m[1], ref: m[2] ?? null };
}

/** The first MAX_LIST dependencies as records, and how many there were. */
function dependencies(
  list: unknown,
  commitOf: (uri: unknown, digest: Record<string, unknown>) => unknown,
  tally: Tally,
): Pick<Provenance, "resolvedDependencies" | "resolvedDependencyCount"> {
  const all = Array.isArray(list) ? list : [];
  return {
    resolvedDependencies: all.slice(0, MAX_LIST).map((d) => {
      const dep = fields(d);
      const uri = own(dep, "uri");
      return {
        uri: keptUrl(uri, tally),
        gitCommit: keptHex(commitOf(uri, fields(own(dep, "digest"))), tally),
      };
    }),
    resolvedDependencyCount: all.length,
  };
}

type Source = {
  provenance: Provenance;
  sourceRepository: string | null;
  sourceRef: string | null;
  sourceCommit: string | null;
};

/**
 * The build types whose own fields are read for a source. A predicate of
 * another build type keeps its build type, dependencies and builder, and
 * names no source: what its `workflow` or config source means is for that
 * builder to say, and a caller of it may choose the value.
 */
export const KNOWN_BUILD_TYPES = {
  /**
   * SLSA v1: GitHub's workflow build type, and the community build type it
   * replaced, which has the same `externalParameters.workflow` and the same
   * resolved dependency for it.
   */
  v1: [
    "https://actions.github.io/buildtypes/workflow/v1",
    "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
  ],
  /** SLSA v0.2: the slsa-github-generator's builders, `invocation.configSource`. */
  v02: [
    "https://github.com/slsa-framework/slsa-github-generator/container@v1",
    "https://github.com/slsa-framework/slsa-github-generator/generic@v1",
    "https://github.com/slsa-framework/slsa-github-generator/go@v1",
  ],
};

/** `v` when it is a whole commit hash, else null: a summary holds nothing shorter. */
function commitOrNull(v: unknown): string | null {
  return typeof v === "string" && COMMIT.test(v) ? v : null;
}

/**
 * SLSA v1 of GitHub's workflow build type: the workflow reference of the
 * external parameters is the source, and its commit is the one of the
 * resolved dependency that names exactly that repository at that ref. No
 * such dependency, or more than one unless each names the same whole
 * commit: no commit, rather than a guess.
 */
function slsaV1(predicate: Record<string, unknown>, tally: Tally): Source {
  const definition = fields(own(predicate, "buildDefinition"));
  const run = fields(own(predicate, "runDetails"));
  const buildType = own(definition, "buildType");
  const known = typeof buildType === "string" &&
    KNOWN_BUILD_TYPES.v1.includes(buildType);
  const external = fields(own(definition, "externalParameters"));
  const rawWorkflow = known ? own(external, "workflow") : undefined;
  const w = fields(rawWorkflow);
  const workflow = rawWorkflow === undefined || rawWorkflow === null ? null : {
    repository: keptUrl(own(w, "repository"), tally),
    ref: kept(own(w, "ref"), tally),
    path: kept(own(w, "path"), tally),
  };
  const raw = own(definition, "resolvedDependencies");
  let sourceCommit: string | null = null;
  if (workflow?.repository && workflow.ref && Array.isArray(raw)) {
    const uri = `git+${workflow.repository}@${workflow.ref}`;
    const commits = raw.filter((d) => own(fields(d), "uri") === uri).map((d) =>
      commitOrNull(own(fields(own(fields(d), "digest")), "gitCommit"))
    );
    if (commits.length > 0 && commits.every((c) => c === commits[0])) {
      sourceCommit = commits[0];
    }
  }
  return {
    provenance: {
      buildType: keptUrl(buildType, tally),
      workflow,
      ...dependencies(raw, (_uri, digest) => own(digest, "gitCommit"), tally),
      builderId: keptUrl(own(fields(own(run, "builder")), "id"), tally),
      invocationId: keptId(
        own(fields(own(run, "metadata")), "invocationId"),
        tally,
      ),
    },
    sourceRepository: workflow?.repository ?? null,
    sourceRef: workflow?.ref ?? null,
    sourceCommit,
  };
}

/**
 * A v0.2 digest's commit: `gitCommit`, or `sha1` when the URI is a git one.
 * With both, they must be the same: two values name no commit.
 */
function commitV02(uri: unknown, digest: Record<string, unknown>): unknown {
  const commit = own(digest, "gitCommit");
  const sha1 = typeof uri === "string" && uri.startsWith("git+")
    ? own(digest, "sha1")
    : undefined;
  if (commit === undefined) return sha1;
  return sha1 === undefined || sha1 === commit ? commit : undefined;
}

/**
 * SLSA v0.2 of the slsa-github-generator's build types: the config source
 * of the invocation is the source, when its URI is a git one; its entry
 * point is the workflow's path, the materials are the dependencies. The
 * invocation's parameters and environment are not read.
 */
function slsaV02(predicate: Record<string, unknown>, tally: Tally): Source {
  const invocation = fields(own(predicate, "invocation"));
  const buildType = own(predicate, "buildType");
  const known = typeof buildType === "string" &&
    KNOWN_BUILD_TYPES.v02.includes(buildType);
  const rawConfig = known ? own(invocation, "configSource") : undefined;
  const config = fields(rawConfig);
  const uri = own(config, "uri");
  const parsed = parseGitUri(uri);
  // The same rule as for any other text that is kept.
  const repository = keptUrl(parsed?.repository, tally);
  const git = repository === null
    ? null
    : { repository, ref: kept(parsed?.ref, tally) };
  const metadata = fields(own(predicate, "metadata"));
  if (uri !== undefined && uri !== null && parsed === null) tally.withheld++;
  const workflow = rawConfig === undefined || rawConfig === null ? null : {
    repository: git?.repository ?? null,
    ref: git?.ref ?? null,
    path: kept(own(config, "entryPoint"), tally),
  };
  return {
    provenance: {
      buildType: keptUrl(buildType, tally),
      workflow,
      ...dependencies(own(predicate, "materials"), commitV02, tally),
      builderId: keptUrl(own(fields(own(predicate, "builder")), "id"), tally),
      // The specification writes buildInvocationId; the generators that
      // use in-toto's Go types write buildInvocationID.
      invocationId: keptId(
        own(metadata, "buildInvocationId") ??
          own(metadata, "buildInvocationID"),
        tally,
      ),
    },
    sourceRepository: git?.repository ?? null,
    sourceRef: git?.ref ?? null,
    sourceCommit: git
      ? commitOrNull(commitV02(uri, fields(own(config, "digest"))))
      : null,
  };
}

/** A statement's predicate type as text; "" when it has none. */
function predicateTypeOf(statement: unknown): string {
  const type = own(fields(statement), "predicateType");
  return typeof type === "string" ? type.slice(0, MAX_TEXT) : "";
}

/** Whether a subject entry names `digest`, a `sha256:<hex>`, exactly. */
function names(subject: unknown, digest: string): boolean {
  const sha256 = own(fields(own(fields(subject), "digest")), "sha256");
  return typeof sha256 === "string" && `sha256:${sha256}` === digest;
}

/** What is asked of an attestation's source; "" asks nothing. */
export type Expected = { sourceRepository: string; sourceCommit: string };

/**
 * What one in-toto statement says, bounded, judged against the digest that
 * was verified and against what is expected of its source. Nothing of the
 * predicate is kept but the fields named here; a value that is too long,
 * not text, or a URL with a credential in it is counted in `withheld`.
 */
export function readStatement(
  statement: unknown,
  digest: string,
  expected: Expected = { sourceRepository: "", sourceCommit: "" },
): Statement {
  const tally: Tally = { withheld: 0 };
  const s = fields(statement);
  const predicateType = predicateTypeOf(statement);
  const rawSubjects = own(s, "subject");
  const all = Array.isArray(rawSubjects) ? rawSubjects : [];
  const matching = all.filter((x) => names(x, digest));
  const subjectMatches = matching.length > 0;
  const subjects: Subject[] = [
    ...matching,
    ...all.filter((x) => !names(x, digest)),
  ].slice(0, MAX_LIST).map((x) => {
    const subject = fields(x);
    const rawDigest = fields(own(subject, "digest"));
    const kinds: Record<string, string> = {};
    for (const key of Object.keys(rawDigest).slice(0, MAX_LIST)) {
      const value = SUBJECT_ALGORITHMS.includes(key)
        ? keptHex(rawDigest[key], tally)
        : (tally.withheld++, null);
      if (value !== null) kinds[key] = value;
    }
    return { name: kept(own(subject, "name"), tally), digest: kinds };
  });

  const predicate = fields(own(s, "predicate"));
  const source = predicateType === SLSA_V1
    ? slsaV1(predicate, tally)
    : predicateType === SLSA_V02
    ? slsaV02(predicate, tally)
    : null;
  const sourceRepository = source?.sourceRepository ?? null;
  const sourceCommit = source?.sourceCommit ?? null;

  let reason = "";
  if (!subjectMatches) {
    reason = `no subject digest equals ${digest}`;
  } else if (
    expected.sourceRepository !== "" &&
    sourceRepository !== expected.sourceRepository
  ) {
    reason = `sourceRepository is ${JSON.stringify(sourceRepository)}, not ${
      JSON.stringify(expected.sourceRepository)
    }`;
  } else if (
    expected.sourceCommit !== "" && sourceCommit !== expected.sourceCommit
  ) {
    reason = `sourceCommit is ${JSON.stringify(sourceCommit)}, not ${
      JSON.stringify(expected.sourceCommit)
    }`;
  }
  return {
    predicateType,
    subjects,
    subjectCount: all.length,
    subjectMatches,
    counted: reason === "",
    reason,
    provenance: source?.provenance ?? null,
    sourceRepository,
    sourceRef: source?.sourceRef ?? null,
    sourceCommit,
    builderId: source?.provenance.builderId ?? null,
    withheld: tally.withheld,
  };
}

/** The value every statement agrees on, or null: a summary never chooses. */
function agreed(values: (string | null)[]): string | null {
  return values.length > 0 && values.every((v) => v === values[0])
    ? values[0]
    : null;
}

/** What is wrong with an expectation as written, or null. */
function expectedProblem(expected: Expected): string | null {
  for (const [name, value] of Object.entries(expected)) {
    if (value === "") continue;
    if (value.includes("${{")) {
      return `${name} holds an unevaluated expression`;
    }
    if (value.length > MAX_TEXT || /\s/.test(value) || CONTROL.test(value)) {
      return `${name} is not one word of at most ${MAX_TEXT} characters: it is compared exactly with what the provenance names, so write it with no space or newline`;
    }
  }
  return null;
}

/** The predicate types of the DSSE envelopes cosign verify-attestation printed, one per line. */
export function parseAttestationOutput(stdout: string): string[] {
  return parseStatements(stdout).map(predicateTypeOf);
}

/** cosign's way of saying the signature or attestation is not there or does not check out. */
const NOT_VERIFIED =
  /no matching (attestations|signatures)|no signatures found|no attestations found|none of the attestations matched the predicate type|failed to verify signature|invalid signature|none of the expected (identities|issuers) matched/i;

/**
 * cosign's environment. `withKey` false leaves the key and its passphrase
 * out, for a call that only reads what others signed.
 */
function env(ctx: Context, withKey = true): Record<string, string> {
  const g = ctx.globalArgs;
  const e: Record<string, string> = {};
  if (withKey) e.COSIGN_PASSWORD = g.password;
  if (withKey && keyKind(g.key) === "pem") e.COSIGN_KEY = g.key;
  if (ctx.traceHeaders?.traceparent) {
    e.TRACEPARENT = ctx.traceHeaders.traceparent;
  }
  if (ctx.traceHeaders?.tracestate) e.TRACESTATE = ctx.traceHeaders.tracestate;
  return e;
}

/**
 * `text` with the private key's PEM replaced, should cosign ever echo it.
 * The passphrase is not masked: cosign never prints it, and a short one
 * would mangle the output it is parsed from.
 */
export function masked(text: string, g: GlobalArgs): string {
  if (keyKind(g.key) !== "pem") return text;
  return text.split(g.key).join("<redacted>").split(g.key.trim()).join(
    "<redacted>",
  );
}

async function run(
  args: string[],
  ctx: Context,
  withKey = true,
): Promise<CommandResult> {
  const res = await exec(
    ctx.globalArgs.cosignBinary,
    args,
    { cwd: ctx.repoDir, env: env(ctx, withKey) },
    ctx,
  );
  return {
    code: res.code,
    stdout: masked(res.stdout, ctx.globalArgs),
    stderr: masked(res.stderr, ctx.globalArgs),
  };
}

/** argv with the key's value replaced, for an error message. */
function shown(args: string[]): string {
  return args.map((a) => a.startsWith("-----BEGIN") ? "<pem>" : a).join(" ");
}

async function mustRun(args: string[], ctx: Context): Promise<string> {
  const res = await run(args, ctx);
  if (res.code !== 0) {
    throw new Error(
      `cosign ${shown(args)} exited ${res.code}: ${
        res.stderr.trim() || res.stdout.trim()
      }`,
    );
  }
  return res.stdout;
}

/** What `--key` gets for the private key. */
function keyFlag(ctx: Context): string {
  const g = ctx.globalArgs;
  switch (keyKind(g.key)) {
    case "pem":
      return "env://COSIGN_KEY";
    case "reference":
      return g.key;
    case "file":
      return absolute(ctx.repoDir, g.key);
    default:
      throw new Error(
        "key is empty: nothing to sign with; this signer can only verify",
      );
  }
}

function registryFlags(g: GlobalArgs): string[] {
  const flags: string[] = [];
  if (g.insecureRegistry) flags.push("--allow-insecure-registry");
  if (g.httpRegistry) flags.push("--allow-http-registry");
  return flags;
}

/** Where temporary files are made; the system's temporary directory when not set. */
let scratchRoot: string | undefined;

/** Makes temporary files under `dir`; returns a function that restores the default. For tests. */
export function __setScratchRoot(dir: string): () => void {
  const prev = scratchRoot;
  scratchRoot = dir;
  return () => {
    scratchRoot = prev;
  };
}

/** Temporary files a method needs, removed when it is done. */
class Scratch {
  readonly paths: string[] = [];
  async file(prefix: string, content: string): Promise<string> {
    const path = await Deno.makeTempFile({ prefix, dir: scratchRoot });
    await Deno.writeTextFile(path, content);
    this.paths.push(path);
    return path;
  }
  async dir(prefix: string): Promise<string> {
    const path = await Deno.makeTempDir({ prefix, dir: scratchRoot });
    this.paths.push(path);
    return path;
  }
  async clean(): Promise<void> {
    for (const p of this.paths) {
      await Deno.remove(p, { recursive: true }).catch(() => {});
    }
  }
}

/** Flags that say how a signature is made: signing config, trusted root. */
async function signingFlags(ctx: Context, scratch: Scratch): Promise<string[]> {
  const g = ctx.globalArgs;
  const flags: string[] = [];
  if (g.signingConfig !== "") {
    flags.push("--signing-config", absolute(ctx.repoDir, g.signingConfig));
  } else if (!g.tlog) {
    // cosign 3 records in a log unless its signing config names none.
    const path = await scratch.file("cosign-signing-config-", "");
    await mustRun(["signing-config", "create", "--out", path], ctx);
    flags.push("--signing-config", path);
  }
  if (g.trustedRoot !== "") {
    flags.push("--trusted-root", absolute(ctx.repoDir, g.trustedRoot));
  }
  return [...flags, ...registryFlags(g)];
}

/** The public key as a PEM: the argument, read from its file, or derived from the private key. */
async function publicKeyPem(
  ctx: Context,
): Promise<{ pem: string; source: "argument" | "derived" | "none" }> {
  const g = ctx.globalArgs;
  if (g.publicKey.startsWith("-----BEGIN")) {
    return { pem: g.publicKey, source: "argument" };
  }
  if (g.publicKey !== "") {
    return {
      pem: await Deno.readTextFile(absolute(ctx.repoDir, g.publicKey)),
      source: "argument",
    };
  }
  if (keyKind(g.key) === "none") return { pem: "", source: "none" };
  const pem = await mustRun(["public-key", "--key", keyFlag(ctx)], ctx);
  return { pem: pem.trim() + "\n", source: "derived" };
}

/**
 * What a verification was checked against, for its record: the certificate
 * identity and issuer, or the fingerprint of the public key. Never the key
 * or a path to it.
 */
type Checked = {
  verifyMode: "key" | "keyless";
  certificateIdentity: string;
  certificateIdentityRegexp: string;
  oidcIssuer: string;
  publicKeyFingerprint: string;
};

/**
 * Flags that say how a signature is checked: the certificate identity and
 * its issuer for a keyless signature, else the public key file and the log
 * choice; then the trusted root.
 */
async function verifyFlags(
  ctx: Context,
  scratch: Scratch,
): Promise<{ flags: string[]; checked: Checked }> {
  const g = ctx.globalArgs;
  const flags: string[] = [];
  let checked: Checked;
  if (verifyMode(g) === "keyless") {
    const problem = identityProblem(g);
    if (problem) throw new Error(problem);
    if (g.certificateIdentity !== "") {
      flags.push("--certificate-identity", g.certificateIdentity);
    } else {
      flags.push("--certificate-identity-regexp", g.certificateIdentityRegexp);
    }
    flags.push("--certificate-oidc-issuer", g.oidcIssuer);
    checked = {
      verifyMode: "keyless",
      certificateIdentity: g.certificateIdentity,
      certificateIdentityRegexp: g.certificateIdentityRegexp,
      oidcIssuer: g.oidcIssuer,
      publicKeyFingerprint: "",
    };
  } else {
    const { pem, source } = await publicKeyPem(ctx);
    if (source === "none") {
      throw new Error(
        "publicKey and key are both empty and no certificate identity is set: nothing to verify with",
      );
    }
    flags.push("--key", await scratch.file("cosign-public-key-", pem));
    if (!g.tlog) flags.push("--insecure-ignore-tlog");
    checked = {
      verifyMode: "key",
      certificateIdentity: "",
      certificateIdentityRegexp: "",
      oidcIssuer: "",
      // cosign judges the key; a key it would refuse has no fingerprint here.
      publicKeyFingerprint: await fingerprint(pem).catch(() => ""),
    };
  }
  if (g.trustedRoot !== "") {
    flags.push("--trusted-root", absolute(ctx.repoDir, g.trustedRoot));
  }
  return { flags: [...flags, ...registryFlags(g)], checked };
}

/** A check's outcome. */
export type CheckResult = { pass: boolean; errors?: string[] };

function checkContext(context: {
  globalArgs: z.input<typeof GlobalArgsSchema>;
  repoDir?: string;
  signal?: AbortSignal;
  logger: Context["logger"];
}): Context {
  return {
    ...context,
    globalArgs: GlobalArgsSchema.parse(context.globalArgs),
    repoDir: context.repoDir ?? ".",
    writeResource: () => Promise.reject(new Error("not in a check")),
  };
}

/** The methods that sign, and so need the private key. */
const SIGNING_METHODS = ["sign", "attest", "signBlob"];

/** Pre-flight checks, run before every method that is not a read. */
export const checks = {
  "arguments": {
    description:
      "key is a PEM, a KMS or HSM reference, a file or empty; publicKey a PEM, a file or empty; a certificate identity comes with oidcIssuer and tlog true and without publicKey; the config paths hold no newline",
    labels: ["policy"],
    execute: (
      context: { globalArgs: z.input<typeof GlobalArgsSchema> },
    ): Promise<CheckResult> => {
      const problem = argumentProblem(context.globalArgs);
      return Promise.resolve(
        problem ? { pass: false, errors: [problem] } : { pass: true },
      );
    },
  },
  "cosign-installed": {
    description: "cosignBinary runs and reports its version",
    labels: ["local", "live"],
    execute: async (
      context: {
        globalArgs: z.input<typeof GlobalArgsSchema>;
        repoDir?: string;
        signal?: AbortSignal;
        logger: Context["logger"];
      },
    ): Promise<CheckResult> => {
      const ctx = checkContext(context);
      const bin = ctx.globalArgs.cosignBinary;
      try {
        const res = await run(["version", "--json"], ctx);
        if (res.code !== 0) {
          return {
            pass: false,
            errors: [`${bin} version exited ${res.code}: ${res.stderr.trim()}`],
          };
        }
        return { pass: true };
      } catch (err) {
        return {
          pass: false,
          errors: [
            `${bin} could not be run (${
              err instanceof Error ? err.message : String(err)
            }); install cosign, https://docs.sigstore.dev/cosign/system_config/installation/, or set cosignBinary`,
          ],
        };
      }
    },
  },
  "key-usable": {
    description:
      "The private key loads and, when encrypted, password decrypts it: its public key can be derived. An empty key fails before sign, attest and signBlob, and passes otherwise: such a signer only verifies",
    labels: ["live"],
    appliesTo: SIGNING_METHODS,
    execute: async (
      context: {
        globalArgs: z.input<typeof GlobalArgsSchema>;
        methodName?: string;
        repoDir?: string;
        signal?: AbortSignal;
        logger: Context["logger"];
      },
    ): Promise<CheckResult> => {
      const ctx = checkContext(context);
      if (keyKind(ctx.globalArgs.key) === "none") {
        // swamp model validate with no --method runs every check, whatever
        // its appliesTo, and names no method. A signer without a key is a
        // correct one that only verifies, so only a signing method fails.
        if (SIGNING_METHODS.includes(context.methodName ?? "")) {
          return {
            pass: false,
            errors: ["key is empty: nothing to sign with"],
          };
        }
        return { pass: true };
      }
      try {
        await mustRun(["public-key", "--key", keyFlag(ctx)], ctx);
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

function hex12(digest: string): string {
  return digest.slice("sha256:".length, "sha256:".length + 12);
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/** sha256 of a PEM's DER body, as cosign's bundle `hint` and openssl print it; "" for no PEM. */
export async function fingerprint(pem: string): Promise<string> {
  const body = pem.replace(/-----[^-]+-----/g, "").replace(/\s+/g, "");
  if (body === "") return "";
  let der: Uint8Array;
  try {
    der = Uint8Array.from(atob(body), (c) => c.charCodeAt(0));
  } catch {
    throw new Error(
      "the public key is not a PEM: what lies between its markers is not base64",
    );
  }
  return "sha256:" + await sha256Hex(der);
}

/** A file's sha256, or why it cannot be read. */
async function fileSha256(path: string): Promise<string> {
  let bytes: Uint8Array;
  try {
    bytes = await Deno.readFile(path);
  } catch {
    throw new Error(`${path} cannot be read`);
  }
  return "sha256:" + await sha256Hex(bytes);
}

/** The bundle a blob's signature lives in: the argument, or beside the file. */
function bundlePath(ctx: Context, path: string, bundle: string): string {
  return bundle === ""
    ? `${path}.sigstore.json`
    : absolute(ctx.repoDir, bundle);
}

/** `<spec>-<repository>-<12 hex of the digest>`: unique per image, in any repository. */
function imageInstance(
  spec: string,
  parsed: { repository: string; digest: string },
): string {
  const repo = parsed.repository.replace(/[^A-Za-z0-9_.-]+/g, "-");
  return `${spec}-${repo}-${hex12(parsed.digest)}`;
}

/** `<spec>-<file name>-<12 hex of the path's sha256>`: unique per file, in any directory. */
async function fileInstance(spec: string, path: string): Promise<string> {
  const name = (path.split("/").pop() ?? path).replace(
    /[^A-Za-z0-9_.-]+/g,
    "-",
  );
  const hash = await sha256Hex(new TextEncoder().encode(path));
  return `${spec}-${name}-${hash.slice(0, 12)}`;
}

/**
 * Text cosign printed, as one bounded line: control characters become
 * spaces, and what is longer than MAX_TEXT is cut with an ellipsis. Its
 * messages quote what a registry holds, such as the predicate types found.
 */
export function oneLine(text: string): string {
  // deno-lint-ignore no-control-regex
  const line = text.replace(/[\u0000-\u001f\u007f]+/g, " ").trim();
  return line.length > MAX_TEXT ? line.slice(0, MAX_TEXT - 1) + "…" : line;
}

/** Runs a verify-like command and says whether it verified, with cosign's reason when not. */
async function verifyOne(
  args: string[],
  ctx: Context,
): Promise<{ verified: boolean; stdout: string; error: string }> {
  const res = await run(args, ctx);
  if (res.code === 0) return { verified: true, stdout: res.stdout, error: "" };
  const stderr = res.stderr.trim();
  const reason = stderr.split("\n").find((l) => l.startsWith("Error:")) ??
    stderr;
  if (NOT_VERIFIED.test(stderr)) {
    return {
      verified: false,
      stdout: "",
      error: oneLine(reason.replace(/^Error:\s*/, "")),
    };
  }
  throw new Error(`cosign ${shown(args)} exited ${res.code}: ${stderr}`);
}

/** The predicate type of an image signature that is kept as a Sigstore bundle. */
const SIGN_TYPE = "https://sigstore.dev/cosign/sign/v1";
/** The X.509 extension that holds a certificate's subject alternative names. */
const SAN_OID = "2.5.29.17";
/** The arc of the extensions Fulcio writes into a certificate. */
const FULCIO_ARC = "1.3.6.1.4.1.57264.1.";
/** How many claims of one certificate a record keeps. */
const MAX_CLAIMS = 40;
/** The longest certificate read, as base64 text; a Fulcio certificate is about 2500 characters. */
const MAX_CERTIFICATE = 32768;

/**
 * The names of the claims Fulcio writes, by the last number of their object
 * identifier. 1 and 8 are the OIDC issuer and 7 is a kind of identity, so
 * they are not claims here. A number that is not listed is kept under its
 * whole object identifier.
 */
export const FULCIO_CLAIMS: Record<string, string> = {
  "2": "githubWorkflowTrigger",
  "3": "githubWorkflowSha",
  "4": "githubWorkflowName",
  "5": "githubWorkflowRepository",
  "6": "githubWorkflowRef",
  "9": "buildSignerUri",
  "10": "buildSignerDigest",
  "11": "runnerEnvironment",
  "12": "sourceRepositoryUri",
  "13": "sourceRepositoryDigest",
  "14": "sourceRepositoryRef",
  "15": "sourceRepositoryIdentifier",
  "16": "sourceRepositoryOwnerUri",
  "17": "sourceRepositoryOwnerIdentifier",
  "18": "buildConfigUri",
  "19": "buildConfigDigest",
  "20": "buildTrigger",
  "21": "runInvocationUri",
  "22": "sourceRepositoryVisibilityAtSigning",
};

/** One DER element: its tag and where its content lies. */
type Der = { tag: number; from: number; to: number };

/** The DER element that starts at `at` and ends by `end`; throws when there is none. */
function derAt(b: Uint8Array, at: number, end: number): Der {
  if (at + 2 > end) throw new Error("truncated");
  const tag = b[at];
  if ((tag & 0x1f) === 0x1f) throw new Error("a tag of several bytes");
  let length = b[at + 1];
  let from = at + 2;
  if (length & 0x80) {
    const count = length & 0x7f;
    if (count === 0 || count > 4 || from + count > end) {
      throw new Error("a length that cannot be read");
    }
    length = 0;
    for (let i = 0; i < count; i++) length = length * 256 + b[from + i];
    from += count;
  }
  if (from + length > end) throw new Error("truncated");
  return { tag, from, to: from + length };
}

/** The DER elements that fill `from` to `to`, one after another. */
function derList(b: Uint8Array, from: number, to: number): Der[] {
  const out: Der[] = [];
  for (let at = from; at < to;) {
    const d = derAt(b, at, to);
    out.push(d);
    at = d.to;
  }
  return out;
}

/** An object identifier as dotted numbers. */
function derOid(b: Uint8Array, d: Der): string {
  const parts: number[] = [];
  let value = 0;
  for (let i = d.from; i < d.to; i++) {
    value = value * 128 + (b[i] & 0x7f);
    if (!(b[i] & 0x80)) {
      parts.push(value);
      value = 0;
    }
  }
  if (parts.length === 0) return "";
  const first = Math.min(2, Math.floor(parts[0] / 40));
  return [first, parts[0] - first * 40, ...parts.slice(1)].join(".");
}

/** Bytes as UTF-8 text, or null when they are not. */
function derText(b: Uint8Array, from: number, to: number): string | null {
  try {
    // A byte order mark at the start is kept, so it is seen and refused:
    // the text recorded is the text the certificate holds, or nothing.
    return new TextDecoder("utf-8", { fatal: true, ignoreBOM: true }).decode(
      b.subarray(from, to),
    );
  } catch {
    return null;
  }
}

/** UTF8String, PrintableString and IA5String: the string types read as text. */
const DER_STRINGS = [0x0c, 0x13, 0x16];

/** The one DER string that fills `from` to `to`, or null. */
function derString(b: Uint8Array, from: number, to: number): string | null {
  try {
    const d = derAt(b, from, to);
    return DER_STRINGS.includes(d.tag) && d.to === to
      ? derText(b, d.from, d.to)
      : null;
  } catch {
    return null;
  }
}

/** One subject alternative name as text, or null for a kind not read. */
function generalName(b: Uint8Array, d: Der): string | null {
  // rfc822Name, dNSName and uniformResourceIdentifier are text as they are.
  if (d.tag === 0x81 || d.tag === 0x82 || d.tag === 0x86) {
    return derText(b, d.from, d.to);
  }
  if (d.tag === 0x87 && d.to - d.from === 4) {
    return Array.from(b.subarray(d.from, d.to)).join(".");
  }
  // otherName, of the type Fulcio uses for a user name.
  if (d.tag === 0xa0) {
    const [type, value] = derList(b, d.from, d.to);
    if (
      type?.tag === 0x06 && derOid(b, type) === `${FULCIO_ARC}7` &&
      value?.tag === 0xa0
    ) {
      return derString(b, value.from, value.to);
    }
  }
  return null;
}

/**
 * What a certificate says, as read from its DER: its subject alternative
 * names, in order, and the Fulcio extensions by the last number of their
 * object identifier, in order. A value that is there and cannot be read as
 * text is null. Nothing is checked here: not the signature on the
 * certificate, not its issuer, not its dates. Throws for bytes that are
 * not a certificate.
 */
export function readCertificate(
  der: Uint8Array,
): { names: (string | null)[]; fulcio: [string, string | null][] } {
  const certificate = derAt(der, 0, der.length);
  if (certificate.tag !== 0x30) throw new Error("not a sequence");
  const tbs = derAt(der, certificate.from, certificate.to);
  if (tbs.tag !== 0x30) throw new Error("not a sequence");
  const names: (string | null)[] = [];
  const fulcio: [string, string | null][] = [];
  const wrapper = derList(der, tbs.from, tbs.to).find((d) => d.tag === 0xa3);
  if (!wrapper) return { names, fulcio };
  const extensions = derAt(der, wrapper.from, wrapper.to);
  for (const extension of derList(der, extensions.from, extensions.to)) {
    const parts = derList(der, extension.from, extension.to);
    const id = parts[0];
    const value = parts[parts.length - 1];
    if (id?.tag !== 0x06 || value?.tag !== 0x04 || parts.length < 2) continue;
    const oid = derOid(der, id);
    if (oid === SAN_OID) {
      const list = derAt(der, value.from, value.to);
      for (const name of derList(der, list.from, list.to)) {
        names.push(generalName(der, name));
      }
    } else if (oid.startsWith(FULCIO_ARC)) {
      const number = oid.slice(FULCIO_ARC.length);
      // Fulcio wrote 1 to 6 as bare text; from 8 on each is a DER string.
      fulcio.push([
        number,
        /^[1-6]$/.test(number)
          ? derText(der, value.from, value.to)
          : derString(der, value.from, value.to),
      ]);
    }
  }
  return { names, fulcio };
}

/**
 * Characters that change how a line reads without showing: control
 * characters of every block, format characters such as the bidirectional
 * and the zero-width ones, line and paragraph separators, and code points
 * that are private, unassigned or half a pair. A value with one of them is
 * not stored: an identity altered to fit could not be given to verify.
 */
const UNSAFE_TEXT = /[\p{Cc}\p{Cf}\p{Zl}\p{Zp}\p{Co}\p{Cn}\p{Cs}]/u;

/**
 * Whether `v` is text that can be stored: not empty, short enough, with no
 * character of UNSAFE_TEXT, and when it is written as a URL with `://`,
 * one that parses and has no user and no password.
 */
function storableClaim(v: unknown): v is string {
  if (!plain(v) || v === "" || UNSAFE_TEXT.test(v)) return false;
  if (!/^[a-z][a-z0-9+.-]*:\/\//i.test(v)) return true;
  try {
    const url = new URL(v);
    return url.username === "" && url.password === "";
  } catch {
    return false;
  }
}

/** What one certificate says, bounded; whether it is genuine is not known here. */
export type CertificateFacts = {
  certificateIdentity: string;
  oidcIssuer: string;
  claims: Record<string, string>;
  withheld: number;
};

/**
 * The identity, the OIDC issuer and the further claims in a certificate
 * given as base64 DER, or null when it cannot be read. The identity is the
 * first subject alternative name; the issuer is Fulcio's extension 8, or 1
 * when there is no 8, as cosign reads them. A value that cannot be stored
 * is counted in `withheld`, and its field is "" or absent.
 */
export function certificateFacts(rawBytes: unknown): CertificateFacts | null {
  if (
    typeof rawBytes !== "string" || rawBytes === "" ||
    rawBytes.length > MAX_CERTIFICATE
  ) {
    return null;
  }
  let read: ReturnType<typeof readCertificate>;
  try {
    read = readCertificate(
      Uint8Array.from(atob(rawBytes), (c) => c.charCodeAt(0)),
    );
  } catch {
    return null;
  }
  const facts: CertificateFacts = {
    certificateIdentity: "",
    oidcIssuer: "",
    claims: {},
    withheld: 0,
  };
  const [first, ...rest] = read.names;
  if (storableClaim(first)) facts.certificateIdentity = first;
  else if (first !== undefined) facts.withheld++;
  // cosign accepts any of several names; one is recorded, the rest counted.
  facts.withheld += rest.length;
  const seen = new Set<string>();
  const issuers: Record<string, string> = {};
  for (const [number, value] of read.fulcio) {
    // An extension appears once in a certificate; a second one is not read.
    if (seen.has(number) || !storableClaim(value)) {
      facts.withheld++;
      continue;
    }
    seen.add(number);
    if (number === "1" || number === "8") {
      issuers[number] = value;
    } else if (Object.keys(facts.claims).length < MAX_CLAIMS) {
      facts.claims[FULCIO_CLAIMS[number] ?? `${FULCIO_ARC}${number}`] = value;
    } else {
      facts.withheld++;
    }
  }
  facts.oidcIssuer = issuers["8"] ?? issuers["1"] ?? "";
  return facts;
}

/** The lines `cosign download signature` printed, each a JSON object; throws on anything else. */
export function parseDownload(stdout: string): Record<string, unknown>[] {
  const out: Record<string, unknown>[] = [];
  for (const line of stdout.split("\n")) {
    const text = line.trim();
    if (text === "") continue;
    let parsed: unknown;
    try {
      parsed = JSON.parse(text);
    } catch {
      throw new Error(
        `cosign download signature printed a line that is not JSON: ${
          oneLine(text).slice(0, 200)
        }`,
      );
    }
    if (
      typeof parsed !== "object" || parsed === null || Array.isArray(parsed)
    ) {
      throw new Error(
        "cosign download signature printed JSON that is not an object",
      );
    }
    out.push(parsed as Record<string, unknown>);
  }
  return out;
}

/** Base64 text as UTF-8 JSON, or undefined when it is not. */
function base64Json(v: unknown): unknown {
  try {
    return JSON.parse(
      new TextDecoder().decode(
        Uint8Array.from(atob(v as string), (c) => c.charCodeAt(0)),
      ),
    );
  } catch {
    return undefined;
  }
}

/** A bundle's key hint, the base64 of a sha256, written as `describe` writes a fingerprint; "" for anything else. */
function hintFingerprint(hint: unknown): string {
  if (typeof hint !== "string" || !/^[A-Za-z0-9+/]{43}=$/.test(hint)) return "";
  try {
    return "sha256:" +
      Array.from(
        atob(hint),
        (c) => c.charCodeAt(0).toString(16).padStart(2, "0"),
      )
        .join("");
  } catch {
    return "";
  }
}

/** One signature being looked at: its record, and what is needed to check it. */
type Candidate = {
  entry: IdentifiedSignature;
  facts: CertificateFacts | null;
  /** The bundle cosign is given to check: only the fields that were read here. */
  bundle: Record<string, unknown> | null;
};

function candidate(form: IdentifiedSignature["form"]): Candidate {
  return {
    entry: {
      form,
      signedWith: "unknown",
      subjectMatches: false,
      certificateGenuine: false,
      certificateIdentity: "",
      oidcIssuer: "",
      claims: {},
      unprovenIdentity: "",
      unprovenIssuer: "",
      unprovenKeyFingerprint: "",
      reason: "",
      withheld: 0,
    },
    facts: null,
    bundle: null,
  };
}

const KEY_REASON =
  "made with a key, as the registry holds it: there is no certificate, so no identity to read, and the signature was not checked, so nothing here says which key made it; verify with the signer's public key";
const OTHER_DIGEST = "this signature is about another digest";
const NO_NAME =
  "the certificate is genuine, and its identity or its issuer is not text that can be stored";

/** Fills in what a certificate says, as not proven; `genuine` moves it over. */
function certified(c: Candidate, rawBytes: unknown): void {
  c.entry.signedWith = "certificate";
  c.facts = certificateFacts(rawBytes);
  if (c.facts === null) {
    c.entry.reason = "its certificate cannot be read";
    return;
  }
  c.entry.unprovenIdentity = c.facts.certificateIdentity;
  c.entry.unprovenIssuer = c.facts.oidcIssuer;
  c.entry.withheld = c.facts.withheld;
}

/** Marks a candidate's certificate as genuine: cosign checked exactly it. */
function genuine(c: Candidate): void {
  const facts = c.facts as CertificateFacts;
  c.entry.certificateGenuine = true;
  c.entry.certificateIdentity = facts.certificateIdentity;
  c.entry.oidcIssuer = facts.oidcIssuer;
  c.entry.claims = facts.claims;
  c.entry.unprovenIdentity = "";
  c.entry.unprovenIssuer = "";
  c.entry.reason = facts.certificateIdentity === "" || facts.oidcIssuer === ""
    ? NO_NAME
    : "";
}

/** Whether a line of `cosign download signature` is a Sigstore bundle. */
function isBundle(line: Record<string, unknown>): boolean {
  return Object.hasOwn(line, "verificationMaterial") ||
    Object.hasOwn(line, "dsseEnvelope") ||
    Object.hasOwn(line, "messageSignature");
}

/** Whether a line of `cosign download signature` is a signature of the tag form. */
function isTagSignature(line: Record<string, unknown>): boolean {
  return Object.hasOwn(line, "Base64Signature") ||
    Object.hasOwn(line, "Payload");
}

/**
 * One bundle as a candidate, or null for a bundle that is an attestation
 * and not a signature. The bundle kept for cosign to check is built from
 * the fields read here and nothing else, so cosign can never check one
 * certificate while another is recorded: cosign reads a bundle's fields
 * under more than one spelling, and this reads one.
 */
function readBundle(
  line: Record<string, unknown>,
  digest: string,
): Candidate | null {
  const c = candidate("bundle");
  const envelope = fields(own(line, "dsseEnvelope"));
  const statement = base64Json(own(envelope, "payload"));
  const type = own(fields(statement), "predicateType") ??
    own(fields(statement), "predicate_type");
  if (statement !== undefined && type !== SIGN_TYPE) return null;
  const subjects = own(fields(statement), "subject");
  c.entry.subjectMatches = Array.isArray(subjects) &&
    subjects.some((s) => names(s, digest));
  const material = fields(own(line, "verificationMaterial"));
  const certificate = own(material, "certificate");
  const chain = own(
    fields(own(material, "x509CertificateChain")),
    "certificates",
  );
  const publicKey = own(material, "publicKey");
  // The certificate of a bundle is its `certificate`; the chain of the
  // older bundle versions is read only when there is no such field.
  let proof: Record<string, unknown> | null = null;
  if (certificate !== undefined && certificate !== null) {
    const rawBytes = own(fields(certificate), "rawBytes");
    certified(c, rawBytes);
    proof = { certificate: { rawBytes } };
  } else if (Array.isArray(chain) && chain.length > 0) {
    const all = chain.slice(0, 10).map((x) => ({
      rawBytes: own(fields(x), "rawBytes"),
    }));
    certified(c, all[0].rawBytes);
    proof = { x509CertificateChain: { certificates: all } };
  } else if (publicKey !== undefined && publicKey !== null) {
    c.entry.signedWith = "key";
    c.entry.unprovenKeyFingerprint = hintFingerprint(
      own(fields(publicKey), "hint"),
    );
    c.entry.reason = KEY_REASON;
  } else {
    c.entry.reason = "the bundle holds no certificate and no key";
  }
  if (statement === undefined) {
    c.entry.reason = "the bundle holds no in-toto statement";
  } else if (!c.entry.subjectMatches) {
    c.entry.reason = OTHER_DIGEST;
  }
  if (proof !== null && c.facts !== null) {
    c.bundle = {
      mediaType: own(line, "mediaType"),
      verificationMaterial: {
        ...proof,
        tlogEntries: own(material, "tlogEntries"),
        timestampVerificationData: own(material, "timestampVerificationData"),
      },
      dsseEnvelope: {
        payload: own(envelope, "payload"),
        payloadType: own(envelope, "payloadType"),
        signatures: own(envelope, "signatures"),
      },
    };
  }
  return c;
}

/**
 * A field of a JSON object the way cosign, a Go program, reads one: under
 * its name in any mix of upper and lower case. Two fields that both match
 * are not chosen between: the answer is then undefined.
 */
function foldedField(v: unknown, name: string): unknown {
  const o = fields(v);
  const fold = (s: string) => s.toUpperCase().toLowerCase();
  const matching = Object.keys(o).filter((k) => fold(k) === fold(name));
  return matching.length === 1 ? o[matching[0]] : undefined;
}

/**
 * A tag-form signature that carries no certificate, as a candidate. Nothing
 * of it is checked: it is there, and its payload names the digest or not.
 */
function readTagKey(line: Record<string, unknown>, digest: string): Candidate {
  const c = candidate("tag");
  c.entry.signedWith = "key";
  const image = foldedField(
    foldedField(base64Json(own(line, "Payload")), "critical"),
    "image",
  );
  c.entry.subjectMatches =
    foldedField(image, "docker-manifest-digest") === digest;
  c.entry.reason = c.entry.subjectMatches ? KEY_REASON : OTHER_DIGEST;
  return c;
}

/**
 * The claims `cosign verify` prints for a tag-form signature, each with the
 * flag that has cosign require exactly that value of the certificate.
 */
const CLAIM_FLAGS: Record<string, string> = {
  githubWorkflowTrigger: "--certificate-github-workflow-trigger",
  githubWorkflowSha: "--certificate-github-workflow-sha",
  githubWorkflowName: "--certificate-github-workflow-name",
  githubWorkflowRepository: "--certificate-github-workflow-repository",
  githubWorkflowRef: "--certificate-github-workflow-ref",
};
/** How many distinct identities of the tag form are confirmed, with two calls each at most. */
const MAX_CONFIRM = 5;

/**
 * What `cosign verify` printed for one tag-form signature it verified, as
 * far as it can be stored: the identity, the issuer and the five GitHub
 * claims. This is not yet proven. cosign starts from what the signer wrote
 * in the payload and overwrites a field only when the certificate has it,
 * so a certificate without, say, a repository leaves the signer's own
 * "githubWorkflowRepository" in place. `confirmTagged` has cosign prove it.
 */
type Printed = {
  identity: string;
  issuer: string;
  claims: [string, string][];
  withheld: number;
};

function readPrinted(printed: Payload): Printed {
  const out: Printed = { identity: "", issuer: "", claims: [], withheld: 0 };
  const take = (v: unknown): string => {
    if (v === undefined) return "";
    if (storableClaim(v)) return v;
    out.withheld++;
    return "";
  };
  out.identity = take(printed.annotations.Subject);
  out.issuer = take(printed.annotations.Issuer);
  for (const name of Object.keys(CLAIM_FLAGS)) {
    if (!Object.hasOwn(printed.annotations, name)) continue;
    const value = take(printed.annotations[name]);
    if (value !== "") out.claims.push([name, value]);
  }
  return out;
}

/** A tag-form signature cosign verified with a certificate, as a candidate that names no one yet. */
function verifiedTag(reason: string, withheld: number): Candidate {
  const c = candidate("tag");
  c.entry.signedWith = "certificate";
  c.entry.subjectMatches = true;
  c.entry.certificateGenuine = true;
  c.entry.reason = reason;
  c.entry.withheld = withheld;
  return c;
}

/** cosign's way of saying an image has no signature. */
const NO_SIGNATURES = /no signatures associated|no signatures found/i;
/** A registry's way of saying the image is not there. */
const NO_IMAGE = /entity not found in registry|MANIFEST_UNKNOWN|NAME_UNKNOWN/;
/**
 * cosign's ways of saying one bundle does not check out, at the start of
 * its error. Anything else is not a verdict on the signature, and fails
 * the method: a trusted root that cannot be loaded, a file that is not
 * there.
 */
const BUNDLE_VERDICT =
  /^(failed to verify (log inclusion|leaf certificate|signature|certificate identity)\b|invalid predicate type\b|bundle does not contain cert for verification\b)/;
/** cosign's way of saying none of the tag-form signatures checks out. */
const TAG_VERDICT = /^no matching signatures\b/;
/** cosign's way of saying there is no signature under the tag at all: the registry answered, and it is not there. */
const TAG_NONE = /^no signatures found\b/;
/**
 * Words of a call that could not be made: a network, a registry or a log
 * that did not answer, and any request to a registry that cosign names in
 * its error, whatever the registry answered. A message with any of them is
 * never a verdict, whatever it starts with.
 */
const FAULT =
  /connection refused|connection reset|dial tcp|i\/o timeout|no such host|deadline exceeded|timed? ?out|TLS handshake|\bEOF\b|TOOMANYREQUESTS|UNAUTHORIZED|DENIED|UNAVAILABLE|\b(GET|HEAD|POST|PUT) https?:\/\/|status code|searching log query|temporary failure|network is unreachable|proxyconnect/i;
/** The lines `cosign tree` prints, each a whole line; any other line is not understood, and fails the method. */
const TREE_HEADER =
  /^📦 Supply Chain Security Related artifacts for an image: \S+$/u;
const TREE_NOTHING =
  /^No Supply Chain Security Related Artifacts found for image \S+,$/;
const TREE_HINT =
  /^ start creating one with simply running\$ cosign sign <img>$/;
const TREE_REFERRER = /^└── 🔗 (\S+) artifacts via OCI referrer: \S+$/u;
const TREE_TAGGED =
  /^└── (🔐 Signatures|💾 Attestations|📦 SBOMs) for an image tag: \S+$/u;
const TREE_LAYER = /^ {3}[├└]── 🍒 sha256:[0-9a-f]{64}$/u;

/**
 * How `cosign tree` names a referrer that is a Sigstore bundle: by the
 * predicate type its manifest is labelled with, a URI, or, without that
 * label, by the bundle's media type. Any other name is another kind of
 * artifact, which `cosign download signature` passes over, and so does
 * this. The name is only a label, set by whoever wrote the artifact: it
 * says that a bundle should come back, never what the bundle is.
 */
const BUNDLE_LABEL =
  /^(application\/vnd\.dev\.sigstore\.bundle|[a-z][a-z0-9+.-]*:\/\/)/i;

/**
 * What `cosign tree` listed: the layers of Sigstore bundles, of signatures
 * and of attestations alike, and whether there are signatures under a tag.
 */
export type Listed = { bundleLayers: number; tagSignatures: boolean };

/**
 * What `cosign tree` printed, read line by line. Every line must be one
 * this knows, and the output must say either that there is nothing or
 * list something: a line it does not know, such as an error cosign prints
 * and then carries on from, throws. So does an output that is empty.
 */
export function parseTree(stdout: string): Listed {
  const lines = stdout.split("\n").filter((l) => l !== "");
  const out: Listed = { bundleLayers: 0, tagSignatures: false };
  if (lines.length < 2 || !TREE_HEADER.test(lines[0])) {
    throw new Error("cosign tree printed no list");
  }
  if (TREE_NOTHING.test(lines[1])) {
    if (lines.length !== 3 || !TREE_HINT.test(lines[2])) {
      throw new Error("cosign tree said there is nothing, and then more");
    }
    return out;
  }
  let under = "";
  for (const line of lines.slice(1)) {
    const referrer = line.match(TREE_REFERRER);
    const tag = line.match(TREE_TAGGED);
    if (referrer) {
      under = referrer[1];
    } else if (tag) {
      under = "";
      if (tag[1].endsWith("Signatures")) out.tagSignatures = true;
    } else if (TREE_LAYER.test(line)) {
      if (BUNDLE_LABEL.test(under)) out.bundleLayers++;
    } else {
      throw new Error(
        `cosign tree printed a line that is not understood: ${
          safeLine(line).slice(0, 200)
        }`,
      );
    }
  }
  return out;
}

/** Text for a record or a log line: what is in UNSAFE_TEXT becomes a space, then as oneLine. */
function safeLine(text: string): string {
  return oneLine(
    text.replace(new RegExp(`${UNSAFE_TEXT.source}+`, "gu"), " "),
  );
}

/** The line of what cosign printed that says why, made safe and bounded. */
function said(stderr: string): string {
  const text = stderr.trim();
  return safeLine(
    (text.split("\n").find((l) => l.startsWith("Error:")) ?? text).replace(
      /^Error:\s*/,
      "",
    ),
  );
}

/** What is wrong with the arguments identify reads, or null: no check runs before a read. */
function identifyProblem(g: GlobalArgs): string | null {
  if (g.trustedRoot.includes("${{")) {
    return "trustedRoot holds an unevaluated expression";
  }
  if (/[\n\r]/.test(g.trustedRoot)) return "trustedRoot holds a newline";
  return null;
}

/** A failed cosign call as an error: the command, its exit code, what it printed. */
function failed(argv: string[], res: CommandResult): Error {
  return new Error(
    `cosign ${shown(argv)} exited ${res.code}: ${res.stderr.trim()}`,
  );
}

/**
 * Who signed one image. Downloads its signatures, which proves nothing,
 * then has cosign check them with an identity and an issuer pattern that
 * match anything: the signature over this digest, the certificate's chain
 * to the trusted root and its entry in the transparency log. The log entry
 * is always required, whatever `tlog` says, since a certificate is valid
 * for minutes and only the entry shows it was used in time. The key and
 * its passphrase reach no call.
 *
 * A bundle is checked alone, so the certificate read from it is the one
 * cosign checked. The tag form is checked as a whole, and cosign does not
 * say which certificate a verdict belongs to, so there only what cosign
 * printed for a signature it verified is recorded.
 *
 * At most 33 cosign calls: the download, a `cosign tree`, one check per
 * bundle for the first MAX_LIST, one `cosign verify` of the tag form, and
 * for the first MAX_CONFIRM identities it printed two more at most.
 */
async function identifyOne(
  ref: string,
  parsed: { repository: string; digest: string },
  ctx: Context,
  scratch: Scratch,
): Promise<Identification> {
  const g = ctx.globalArgs;
  const anyone = [
    "--certificate-identity-regexp",
    ".*",
    "--certificate-oidc-issuer-regexp",
    ".*",
  ];
  const trust = g.trustedRoot === ""
    ? []
    : ["--trusted-root", absolute(ctx.repoDir, g.trustedRoot)];
  // The reference is in cosign's messages; it must not decide how one is read.
  const unnamed = (text: string) =>
    text.split(ref).join("<ref>").split(parsed.repository).join("<repository>");
  const download = ["download", "signature", ...registryFlags(g), "--", ref];
  let res: CommandResult;
  try {
    res = await run(download, ctx, false);
  } catch (err) {
    if (ctx.signal?.aborted) throw err;
    throw new Error(
      `${g.cosignBinary} could not be run (${
        err instanceof Error ? err.message : String(err)
      }); install cosign, https://docs.sigstore.dev/cosign/system_config/installation/, or set cosignBinary`,
    );
  }
  let missing = "";
  let lines: Record<string, unknown>[] = [];
  if (res.code !== 0) {
    const stderr = unnamed(res.stderr);
    if (NO_IMAGE.test(stderr)) {
      missing = said(res.stderr);
    } else if (!NO_SIGNATURES.test(stderr) || FAULT.test(stderr)) {
      throw failed(download, res);
    }
  } else {
    lines = parseDownload(res.stdout);
  }
  for (const line of lines) {
    if (!isBundle(line) && !isTagSignature(line)) {
      throw new Error(
        "cosign download signature printed an object that is neither a Sigstore bundle nor a signature",
      );
    }
  }
  const bundles = lines.filter(isBundle);
  const tagged = lines.filter((l) => !isBundle(l));

  // cosign download signature answers "no signatures" also when a lookup
  // failed: a rate limit, a refused login, a server error, on the list of
  // bundles or on one bundle's own manifest. cosign tree fails on the
  // first and prints an error and carries on for the second, so it is
  // always asked, and everything it prints must be understood.
  let listed: Listed = { bundleLayers: 0, tagSignatures: false };
  if (missing === "") {
    const tree = ["tree", ...registryFlags(g), "--", ref];
    const res = await run(tree, ctx, false);
    if (res.code !== 0 || res.stderr.trim() !== "") {
      throw new Error(
        `${
          failed(tree, res).message
        }; what cosign download signature returned says nothing while a lookup fails`,
      );
    }
    listed = parseTree(res.stdout);
    // Every bundle cosign tree lists must have come back, of a signature
    // or of an attestation: when one is missing, cosign has also changed
    // which form it reads. Which of them are signatures is not taken from
    // the list, whose names are labels: each bundle's own statement says.
    if (listed.bundleLayers > bundles.length) {
      throw new Error(
        `cosign tree lists ${listed.bundleLayers} bundles and cosign download signature returned ${bundles.length}: a lookup failed, or the registry lists what it does not hold, so nothing is recorded`,
      );
    }
    if (bundles.length === 0 && tagged.length === 0 && listed.tagSignatures) {
      throw new Error(
        "cosign tree lists signatures under a tag that cosign download signature did not return: one of the two lookups failed, so nothing is recorded",
      );
    }
  }

  const candidates: Candidate[] = [];
  let otherStatements = 0;
  for (const line of bundles) {
    const c = readBundle(line, parsed.digest);
    if (c === null) otherStatements++;
    else candidates.push(c);
  }
  const checkable = candidates.filter((c) =>
    c.bundle !== null && c.entry.subjectMatches
  );
  for (const c of checkable.slice(MAX_LIST)) {
    c.entry.reason =
      `not checked: only the first ${MAX_LIST} signatures with a certificate are`;
  }
  for (const c of checkable.slice(0, MAX_LIST)) {
    const path = await scratch.file("cosign-bundle-", JSON.stringify(c.bundle));
    const argv = [
      "verify-blob-attestation",
      "--bundle",
      path,
      ...anyone,
      "--digest",
      parsed.digest.slice("sha256:".length),
      "--digestAlg",
      "sha256",
      "--type",
      SIGN_TYPE,
      ...trust,
    ];
    const one = await run(argv, ctx, false);
    if (one.code === 0) {
      genuine(c);
    } else if (
      BUNDLE_VERDICT.test(said(one.stderr)) && !FAULT.test(one.stderr)
    ) {
      c.entry.reason = said(one.stderr);
    } else {
      throw failed(argv, one);
    }
  }

  // The tag form. Once an image has a bundle, of a signature or of an
  // attestation, cosign reads bundles only: the download returns no tag
  // signature, and verify must be told to read the tag. So beside bundles
  // the tag form is always asked for, and only "no signatures found" says
  // there is none.
  const beside = bundles.length > 0;
  const withCertificate = tagged.filter((l) => {
    const certificate = own(l, "Cert");
    return certificate !== undefined && certificate !== null;
  });
  for (const line of tagged) {
    if (!withCertificate.includes(line)) {
      candidates.push(readTagKey(line, parsed.digest));
    }
  }
  let tagSignaturesUnlisted = false;
  if (withCertificate.length > 0 || beside) {
    // One cosign verify of the tag form, requiring `who` of the
    // certificate: what it printed for this digest, or why it printed
    // nothing. A failure that is no verdict throws.
    const tagVerify = async (who: string[]): Promise<
      { printed: Payload[]; why: string; none: boolean }
    > => {
      const argv = [
        "verify",
        ...(beside ? ["--new-bundle-format=false"] : []),
        ...who,
        ...trust,
        ...registryFlags(g),
        "--output",
        "json",
        "--",
        ref,
      ];
      const res = await run(argv, ctx, false);
      if (res.code === 0) {
        return {
          printed: parseVerifyOutput(res.stdout).filter((p) =>
            p.digest === parsed.digest
          ),
          why: "",
          none: false,
        };
      }
      const why = said(res.stderr);
      if (FAULT.test(res.stderr)) throw failed(argv, res);
      if (TAG_VERDICT.test(why)) return { printed: [], why, none: false };
      if (beside && TAG_NONE.test(why)) {
        return { printed: [], why: "", none: true };
      }
      throw failed(argv, res);
    };
    const all = await tagVerify(anyone);
    if (all.none && listed.tagSignatures) {
      throw new Error(
        "cosign tree lists signatures under a tag and cosign verify found none there: one of the two lookups failed, so nothing is recorded",
      );
    }
    tagSignaturesUnlisted = beside && !all.none;

    // What cosign printed is grouped by what it says, and cosign is asked
    // again with exactly that as a requirement on the certificate: the
    // identity, the issuer and each claim. Only what such a call accepts
    // is recorded as what a certificate says.
    const groups = new Map<string, { said: Printed; count: number }>();
    for (const p of all.printed) {
      const said = readPrinted(p);
      const key = JSON.stringify([said.identity, said.issuer, said.claims]);
      const group = groups.get(key);
      if (group) group.count++;
      else groups.set(key, { said, count: 1 });
    }
    let asked = 0;
    for (const { said: p, count } of groups.values()) {
      let confirmed = 0;
      let claims: [string, string][] = [];
      let reason =
        "cosign verified this signature and did not confirm the identity and the issuer it printed for it, so they are not recorded";
      if (p.identity === "" || p.issuer === "") {
        reason = NO_NAME;
      } else if (asked >= MAX_CONFIRM) {
        reason =
          `not confirmed: cosign printed more identities for this image than the ${MAX_CONFIRM} that are confirmed, and this signature names one of the others`;
      } else {
        asked++;
        const who = [
          `--certificate-identity=${p.identity}`,
          `--certificate-oidc-issuer=${p.issuer}`,
        ];
        const full = await tagVerify([
          ...who,
          ...p.claims.map(([name, value]) => `${CLAIM_FLAGS[name]}=${value}`),
        ]);
        confirmed = Math.min(full.printed.length, count);
        claims = p.claims;
        if (confirmed === 0 && p.claims.length > 0) {
          // The certificate does not say all of it: the claims are the
          // signer's own words. The identity and the issuer alone.
          const bare = await tagVerify(who);
          confirmed = Math.min(bare.printed.length, count);
          claims = [];
        }
      }
      for (let i = 0; i < count; i++) {
        if (i < confirmed) {
          const c = verifiedTag(
            "",
            p.withheld + p.claims.length - claims.length,
          );
          c.entry.certificateIdentity = p.identity;
          c.entry.oidcIssuer = p.issuer;
          c.entry.claims = Object.fromEntries(claims);
          candidates.push(c);
        } else {
          candidates.push(verifiedTag(reason, p.withheld + p.claims.length));
        }
      }
    }
    if (beside) {
      // The tag's signatures cannot be listed beside bundles. When cosign
      // verified none with a certificate, that there are some is still said.
      if (!all.none && all.printed.length === 0) {
        const c = candidate("tag");
        c.entry.reason =
          `signatures are stored under the tag beside the bundles, and cosign verified none of them with a certificate: ${all.why}; they cannot be listed, so they are counted as one`;
        candidates.push(c);
      }
    } else {
      const unverified = withCertificate.length - all.printed.length;
      for (let i = 0; i < unverified; i++) {
        const c = candidate("tag");
        c.entry.signedWith = "certificate";
        c.entry.reason = all.why !== ""
          ? all.why
          : `cosign verified ${all.printed.length} of the ${withCertificate.length} signatures with a certificate, and in the tag form it does not say which`;
        candidates.push(c);
      }
    }
  }

  const entries = candidates.map((c) => c.entry);
  const named = entries.filter((e) =>
    e.certificateGenuine && e.certificateIdentity !== "" && e.oidcIssuer !== ""
  );
  const identities: Identification["identities"] = [];
  for (const e of named) {
    const known = identities.find((i) =>
      i.certificateIdentity === e.certificateIdentity &&
      i.oidcIssuer === e.oidcIssuer
    );
    if (known) known.signatures++;
    else {
      identities.push({
        certificateIdentity: e.certificateIdentity,
        oidcIssuer: e.oidcIssuer,
        signatures: 1,
      });
    }
  }
  const isKey = (e: IdentifiedSignature) =>
    e.signedWith === "key" && e.subjectMatches;
  const keySigned = entries.filter(isKey).length;
  const rest = entries.filter((e) => !e.certificateGenuine && !isKey(e));
  const unnamedCertificates = entries.filter((e) =>
    e.certificateGenuine && !named.includes(e)
  );
  const beyond =
    entries.filter((e) =>
      e.reason.startsWith("not confirmed: cosign printed more identities")
    ).length;
  const also = [
    keySigned > 0 ? `${keySigned} made with a key, not checked` : "",
    rest.length + unnamedCertificates.length > 0
      ? `${rest.length + unnamedCertificates.length} that could not be checked`
      : "",
    beyond > 0
      ? `${beyond} of those name identities beyond the ${MAX_CONFIRM} that are confirmed`
      : "",
  ].filter((t) => t !== "").join(", ");
  let state: Identification["state"];
  let reason: string;
  if (missing !== "") {
    state = "not-found";
    reason = missing;
  } else if (identities.length === 1) {
    state = "identified";
    reason = also === "" ? "" : `other signatures on this image: ${also}`;
  } else if (identities.length > 1) {
    state = "several-identities";
    reason =
      `${identities.length} identities signed this image; identities lists them, and none is chosen for you${
        beyond > 0
          ? `; ${beyond} more signatures name identities beyond the ${MAX_CONFIRM} that are confirmed`
          : ""
      }`;
  } else if (rest.length + unnamedCertificates.length > 0) {
    state = "unproven";
    reason = `no identity could be established: ${
      [...new Set([...rest, ...unnamedCertificates].map((e) => e.reason))]
        .slice(0, 3).join("; ")
    }`;
  } else if (keySigned > 0) {
    state = "key-signed";
    reason = KEY_REASON;
  } else {
    state = "unsigned";
    reason = otherStatements === 0
      ? "no signature found"
      : `no signature found; identify does not read attestations, and the image has ${otherStatements}`;
  }
  return {
    ref,
    ...parsed,
    state,
    certificateIdentity: state === "identified"
      ? identities[0].certificateIdentity
      : "",
    oidcIssuer: state === "identified" ? identities[0].oidcIssuer : "",
    identities: identities.slice(0, MAX_LIST),
    identityChecked: false,
    signaturesFound: candidates.length,
    certificatesGenuine: entries.filter((e) => e.certificateGenuine).length,
    keySigned,
    otherStatements,
    tagSignaturesUnlisted,
    forms: SIGNATURE_FORMS.filter((f) => entries.some((e) => e.form === f)),
    signatures: [
      ...named,
      ...entries.filter((e) => !named.includes(e)),
    ].slice(0, MAX_LIST),
    reason: safeLine(reason),
    identifiedAt: new Date().toISOString(),
  };
}

/** Model definition for one cosign signing identity. */
export const model = {
  type: "@dataverket/cosign/signer",
  version: "2026.11.12.1",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.11.10.1",
      description:
        "verifyAttestation records what each verified attestation says (subjects, SLSA provenance, a source summary), counts only an attestation whose subject is the digest verified, takes sourceRepository and sourceCommit, and records an image with no attestation of the type asked for as not verified instead of failing; verification and attestationVerification records say which identity and issuer, or which key, they were checked against; a reference that starts with a dash is refused. No global argument changed",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.11.10.2",
      description:
        "A new method, identify, records who signed an image: the identity and OIDC issuer of each signing certificate cosign finds genuine, with no identity expected; a new record, identification. The key-usable check passes on an empty key unless the method signs, so a signer that only verifies validates; sign, attest and signBlob still refuse an empty key. No global argument and no existing record changed",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
    {
      toVersion: "2026.11.12.1",
      description: "Tests only; global arguments unchanged",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  checks,
  resources: {
    signer: {
      description:
        "The signer as cosign sees it: version, how the key was given, the public key, how it verifies, log and config choices",
      schema: SignerSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    keypair: {
      description:
        "One generated key pair; the private key is sensitive and lives in the vault, and is always an encrypted PEM, with password as its passphrase, empty or not",
      schema: KeypairSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    signature: {
      description: "One image signed: its reference, digest and annotations",
      schema: SignatureSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    verification: {
      description:
        "One image verified, or not: the signatures found and cosign's reason when none counted",
      schema: VerificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    identification: {
      description:
        "Who signed one image, as its signing certificates say: the identity and OIDC issuer of each certificate cosign finds genuine, and its further claims. Not a verification: no identity was expected, so nothing here says the image is trusted, and nothing is proven of a signature made with a key",
      schema: IdentificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    attestation: {
      description: "One attestation attached: its type and predicate",
      schema: AttestationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    attestationVerification: {
      description:
        "One image's attestations of a type verified, or not: their predicate types, the subjects and SLSA provenance of each, and the source repository, ref, commit and builder they agree on",
      schema: AttestationVerificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    blobSignature: {
      description:
        "One file signed: its sha256 and the Sigstore bundle written beside it",
      schema: BlobSignatureSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    blobVerification: {
      description:
        "One file verified against its bundle, or not, with cosign's reason",
      schema: BlobVerificationSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    describe: {
      description:
        "Record cosign's version, how the key was given, the public key in effect and the log and config choices",
      kind: "read" as const,
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const g = ctx.globalArgs;
        ctx.logger.info("Describing cosign signer");
        const out = await mustRun(["version", "--json"], ctx);
        let version = "";
        try {
          version = String(JSON.parse(out).gitVersion ?? "");
        } catch {
          throw new Error(
            `cosign version --json printed something that is not JSON: ${
              out.slice(0, 200)
            }`,
          );
        }
        const pub = await publicKeyPem(ctx);
        const record: Signer = {
          version,
          keyKind: keyKind(g.key),
          publicKey: pub.pem,
          publicKeySource: pub.source,
          fingerprint: await fingerprint(pub.pem),
          verifyMode: verifyMode(g),
          certificateIdentity: g.certificateIdentity,
          certificateIdentityRegexp: g.certificateIdentityRegexp,
          oidcIssuer: g.oidcIssuer,
          tlog: g.tlog,
          signingConfig: absolute(ctx.repoDir, g.signingConfig),
          trustedRoot: absolute(ctx.repoDir, g.trustedRoot),
          checkedAt: new Date().toISOString(),
        };
        ctx.logger.info(
          "cosign {version}, key {kind}, public key {source} {fingerprint}, verifies {mode}",
          {
            version,
            kind: record.keyKind,
            source: pub.source,
            fingerprint: record.fingerprint,
            mode: record.verifyMode,
          },
        );
        const handle = await ctx.writeResource("signer", "signer", record);
        return { dataHandles: [handle] };
      },
    },
    generateKeyPair: {
      description:
        "Generate a key pair, encrypted with password when one is set, and record it with the private key as a sensitive field",
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const scratch = new Scratch();
        try {
          ctx.logger.info("Generating a cosign key pair");
          const dir = await scratch.dir("cosign-keypair-");
          await mustRun([
            "generate-key-pair",
            "--output-key-prefix",
            `${dir}/key`,
          ], ctx);
          const record: Keypair = {
            publicKey: await Deno.readTextFile(`${dir}/key.pub`),
            privateKey: await Deno.readTextFile(`${dir}/key.key`),
            passphraseSet: ctx.globalArgs.password !== "",
            generatedAt: new Date().toISOString(),
          };
          const handle = await ctx.writeResource("keypair", "keypair", record);
          ctx.logger.info("Key pair recorded; the private key is in the vault");
          return { dataHandles: [handle] };
        } finally {
          await scratch.clean();
        }
      },
    },
    sign: {
      description:
        "Sign every image named by digest with the key, with annotations, and record each signature",
      arguments: SignArgsSchema,
      execute: async (args: SignArgs, ctx: Context) => {
        const g = ctx.globalArgs;
        const problem = refsProblem(args.refs) ??
          annotationsProblem(args.annotations);
        if (problem) throw new Error(problem);
        const key = keyFlag(ctx);
        const scratch = new Scratch();
        try {
          const flags = await signingFlags(ctx, scratch);
          ctx.logger.info("Signing {count} images, {log}", {
            count: args.refs.length,
            log: g.tlog ? "recorded in the transparency log" : "no log",
          });
          const handles: Handle[] = [];
          const signedAt = new Date().toISOString();
          for (const ref of args.refs) {
            const parsed = parseDigestRef(ref) as {
              repository: string;
              digest: string;
            };
            const argv = ["sign", "--yes", "--key", key, ...flags];
            for (const a of args.annotations) argv.push("-a", a);
            if (args.recursive) argv.push("--recursive");
            if (!args.upload) argv.push("--upload=false");
            argv.push("--", ref);
            await mustRun(argv, ctx);
            ctx.logger.info("Signed {ref}", { ref });
            const record: Signature = {
              ref,
              ...parsed,
              annotations: annotationRecord(args.annotations),
              recursive: args.recursive,
              uploaded: args.upload,
              tlog: g.tlog,
              signedAt,
            };
            handles.push(
              await ctx.writeResource(
                "signature",
                imageInstance("signature", parsed),
                record,
              ),
            );
          }
          return { dataHandles: handles };
        } finally {
          await scratch.clean();
        }
      },
    },
    verify: {
      description:
        "Verify every image named by digest against the public key, or keyless against the certificate identity, and record what was found; an image that does not verify is recorded, not a failure",
      arguments: VerifyArgsSchema,
      execute: async (args: VerifyArgs, ctx: Context) => {
        const g = ctx.globalArgs;
        const problem = refsProblem(args.refs) ??
          annotationsProblem(args.annotations);
        if (problem) throw new Error(problem);
        const scratch = new Scratch();
        try {
          const { flags, checked } = await verifyFlags(ctx, scratch);
          ctx.logger.info("Verifying {count} images", {
            count: args.refs.length,
          });
          const handles: Handle[] = [];
          for (const ref of args.refs) {
            const parsed = parseDigestRef(ref) as {
              repository: string;
              digest: string;
            };
            const argv = ["verify", ...flags, "--output", "json"];
            for (const a of args.annotations) argv.push("-a", a);
            argv.push("--", ref);
            const res = await verifyOne(argv, ctx);
            const payloads = res.verified ? parseVerifyOutput(res.stdout) : [];
            const record: Verification = {
              ref,
              ...parsed,
              verified: res.verified && payloads.length > 0,
              signatures: payloads.length,
              payloads,
              annotations: annotationRecord(args.annotations),
              ...checked,
              error: res.error,
              tlog: g.tlog,
              verifiedAt: new Date().toISOString(),
            };
            ctx.logger.info("{ref}: {outcome}", {
              ref,
              outcome: record.verified
                ? `${payloads.length} signatures verified`
                : `not verified: ${res.error || "no signature counted"}`,
            });
            handles.push(
              await ctx.writeResource(
                "verification",
                imageInstance("verification", parsed),
                record,
              ),
            );
          }
          return { dataHandles: handles };
        } finally {
          await scratch.clean();
        }
      },
    },
    identify: {
      description:
        "Read who signed every image named by digest: the identity and OIDC issuer each signing certificate was issued to, and its further claims, kept only when cosign finds the signature, the certificate chain and the transparency log entry genuine. Not a verification, and its record is never a pass: no identity is expected, so choose the one you trust, then run verify against it. No signature, a key's signature (not checked, so nothing says which key) and several identities are recorded with a reason. A registry or log that does not answer fails the method",
      kind: "read" as const,
      arguments: IdentifyArgsSchema,
      execute: async (args: IdentifyArgs, ctx: Context) => {
        const problem = refsProblem(args.refs) ??
          identifyProblem(ctx.globalArgs);
        if (problem) throw new Error(problem);
        const scratch = new Scratch();
        try {
          ctx.logger.info("Reading who signed {count} images", {
            count: args.refs.length,
          });
          const handles: Handle[] = [];
          for (const ref of args.refs) {
            const parsed = parseDigestRef(ref) as {
              repository: string;
              digest: string;
            };
            const record = await identifyOne(ref, parsed, ctx, scratch);
            ctx.logger.info("{ref}: {state}, {outcome}", {
              ref,
              state: record.state,
              outcome: record.state === "identified"
                ? `signed by ${record.certificateIdentity}, vouched for by ${record.oidcIssuer}; not compared with any identity`
                : record.reason,
            });
            handles.push(
              await ctx.writeResource(
                "identification",
                imageInstance("identification", parsed),
                record,
              ),
            );
          }
          return { dataHandles: handles };
        } finally {
          await scratch.clean();
        }
      },
    },
    attest: {
      description:
        "Attach the predicate file as an attestation of the given type to every image named by digest, signed with the key, and record each",
      arguments: AttestArgsSchema,
      execute: async (args: AttestArgs, ctx: Context) => {
        const g = ctx.globalArgs;
        const problem = refsProblem(args.refs);
        if (problem) throw new Error(problem);
        const key = keyFlag(ctx);
        const predicate = absolute(ctx.repoDir, args.predicate);
        const predicateSha256 = await fileSha256(predicate);
        const scratch = new Scratch();
        try {
          const flags = await signingFlags(ctx, scratch);
          ctx.logger.info(
            "Attesting {count} images with {predicate} as {type}",
            {
              count: args.refs.length,
              predicate,
              type: args.type,
            },
          );
          const handles: Handle[] = [];
          const attestedAt = new Date().toISOString();
          for (const ref of args.refs) {
            const parsed = parseDigestRef(ref) as {
              repository: string;
              digest: string;
            };
            const argv = [
              "attest",
              "--yes",
              "--key",
              key,
              ...flags,
              "--predicate",
              predicate,
              "--type",
              args.type,
            ];
            if (!args.upload) argv.push("--upload=false");
            argv.push("--", ref);
            await mustRun(argv, ctx);
            ctx.logger.info("Attested {ref}", { ref });
            const record: Attestation = {
              ref,
              ...parsed,
              type: args.type,
              predicate,
              predicateSha256,
              uploaded: args.upload,
              tlog: g.tlog,
              attestedAt,
            };
            handles.push(
              await ctx.writeResource(
                "attestation",
                imageInstance("attestation", parsed),
                record,
              ),
            );
          }
          return { dataHandles: handles };
        } finally {
          await scratch.clean();
        }
      },
    },
    verifyAttestation: {
      description:
        "Verify the attestations of the given type on every image named by digest against the public key, or keyless against the certificate identity, and record what was found and what each says; an attestation counts only when one of its subjects is that digest and, when sourceRepository or sourceCommit is given, its provenance names exactly that",
      arguments: VerifyAttestationArgsSchema,
      execute: async (args: VerifyAttestationArgs, ctx: Context) => {
        const g = ctx.globalArgs;
        const expected: Expected = {
          sourceRepository: args.sourceRepository,
          sourceCommit: args.sourceCommit,
        };
        const problem = refsProblem(args.refs) ?? expectedProblem(expected);
        if (problem) throw new Error(problem);
        const scratch = new Scratch();
        try {
          const { flags, checked } = await verifyFlags(ctx, scratch);
          ctx.logger.info("Verifying {type} attestations on {count} images", {
            type: args.type,
            count: args.refs.length,
          });
          const handles: Handle[] = [];
          for (const ref of args.refs) {
            const parsed = parseDigestRef(ref) as {
              repository: string;
              digest: string;
            };
            const argv = [
              "verify-attestation",
              ...flags,
              "--type",
              args.type,
              "--output",
              "json",
              "--",
              ref,
            ];
            const res = await verifyOne(argv, ctx);
            const raw = res.verified ? parseStatements(res.stdout) : [];
            const statements = raw.map((s) =>
              readStatement(s, parsed.digest, expected)
            );
            const counted = statements.filter((s) => s.counted);
            let error = res.error;
            if (statements.length > 0 && counted.length === 0) {
              const reasons = [...new Set(statements.map((s) => s.reason))];
              error = `${statements.length} attestation${
                statements.length === 1 ? "" : "s"
              } verified by cosign, none counted: ${
                reasons.slice(0, 3).join("; ")
              }`;
            }
            const record: AttestationVerification = {
              ref,
              ...parsed,
              type: args.type,
              verified: res.verified && counted.length > 0,
              attestations: statements.length,
              matched: counted.length,
              predicateTypes: raw.slice(0, MAX_TYPES).map(predicateTypeOf),
              statements: [
                ...counted,
                ...statements.filter((s) => !s.counted),
              ].slice(0, MAX_LIST),
              sourceRepository: agreed(counted.map((s) => s.sourceRepository)),
              sourceRef: agreed(counted.map((s) => s.sourceRef)),
              sourceCommit: agreed(counted.map((s) => s.sourceCommit)),
              builderId: agreed(counted.map((s) => s.builderId)),
              expectedSourceRepository: expected.sourceRepository,
              expectedSourceCommit: expected.sourceCommit,
              ...checked,
              error,
              tlog: g.tlog,
              verifiedAt: new Date().toISOString(),
            };
            ctx.logger.info("{ref}: {outcome}", {
              ref,
              outcome: record.verified
                ? `${counted.length} of ${statements.length} attestations verified and counted`
                : `not verified: ${error || "no attestation counted"}`,
            });
            handles.push(
              await ctx.writeResource(
                "attestationVerification",
                imageInstance("attestationVerification", parsed),
                record,
              ),
            );
          }
          return { dataHandles: handles };
        } finally {
          await scratch.clean();
        }
      },
    },
    signBlob: {
      description:
        "Sign one file with the key and write a Sigstore bundle beside it; record the file's sha256 and the bundle",
      arguments: SignBlobArgsSchema,
      execute: async (args: SignBlobArgs, ctx: Context) => {
        const g = ctx.globalArgs;
        const key = keyFlag(ctx);
        const path = absolute(ctx.repoDir, args.path);
        const bundle = bundlePath(ctx, path, args.bundle);
        const sha256 = await fileSha256(path);
        const scratch = new Scratch();
        try {
          const flags = (await signingFlags(ctx, scratch)).filter((f) =>
            !f.startsWith("--allow-")
          );
          ctx.logger.info("Signing {path}, {log}", {
            path,
            log: g.tlog ? "recorded in the transparency log" : "no log",
          });
          await mustRun(
            [
              "sign-blob",
              "--yes",
              "--key",
              key,
              ...flags,
              "--bundle",
              bundle,
              "--",
              path,
            ],
            ctx,
          );
          ctx.logger.info("Wrote {bundle}", { bundle });
          const record: BlobSignature = {
            path,
            sha256,
            bundle,
            tlog: g.tlog,
            signedAt: new Date().toISOString(),
          };
          const handle = await ctx.writeResource(
            "blobSignature",
            await fileInstance("blobSignature", path),
            record,
          );
          return { dataHandles: [handle] };
        } finally {
          await scratch.clean();
        }
      },
    },
    verifyBlob: {
      description:
        "Verify one file against its Sigstore bundle with the public key, or keyless against the certificate identity, and record the outcome; a file that does not verify is recorded, not a failure",
      arguments: VerifyBlobArgsSchema,
      execute: async (args: VerifyBlobArgs, ctx: Context) => {
        const g = ctx.globalArgs;
        const path = absolute(ctx.repoDir, args.path);
        const bundle = bundlePath(ctx, path, args.bundle);
        const sha256 = await fileSha256(path);
        const scratch = new Scratch();
        try {
          const flags = (await verifyFlags(ctx, scratch)).flags.filter((f) =>
            !f.startsWith("--allow-")
          );
          ctx.logger.info("Verifying {path} against {bundle}", {
            path,
            bundle,
          });
          const res = await verifyOne(
            ["verify-blob", ...flags, "--bundle", bundle, "--", path],
            ctx,
          );
          const record: BlobVerification = {
            path,
            sha256,
            bundle,
            verified: res.verified,
            error: res.error,
            tlog: g.tlog,
            verifiedAt: new Date().toISOString(),
          };
          ctx.logger.info("{path}: {outcome}", {
            path,
            outcome: res.verified ? "verified" : `not verified: ${res.error}`,
          });
          const handle = await ctx.writeResource(
            "blobVerification",
            await fileInstance("blobVerification", path),
            record,
          );
          return { dataHandles: [handle] };
        } finally {
          await scratch.clean();
        }
      },
    },
  },
};
