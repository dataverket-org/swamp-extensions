/**
 * `@dataverket/cosign/signer` — one signing identity for container images,
 * driven through [cosign](https://github.com/sigstore/cosign): sign images by
 * digest, verify them against a public key or, keyless, against the identity
 * in a Sigstore certificate, attach attestations and verify those, sign and
 * verify files with a Sigstore bundle beside each, and generate a key pair.
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
    "Record every signature in a transparency log and require a log entry when verifying; false signs through a signing config with no log service and verifies ignoring the log. Keyless verification requires true",
  ),
  signingConfig: z.string().default("").describe(
    "A Sigstore signing config file for sign and attest, relative to the repository root, such as one naming a private Rekor or TSA; replaces what tlog chooses",
  ),
  trustedRoot: z.string().default("").describe(
    "A Sigstore trusted root file for sign, attest and verify, relative to the repository root, for private infrastructure",
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

function env(ctx: Context): Record<string, string> {
  const g = ctx.globalArgs;
  const e: Record<string, string> = { COSIGN_PASSWORD: g.password };
  if (keyKind(g.key) === "pem") e.COSIGN_KEY = g.key;
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

async function run(args: string[], ctx: Context): Promise<CommandResult> {
  const res = await exec(
    ctx.globalArgs.cosignBinary,
    args,
    { cwd: ctx.repoDir, env: env(ctx) },
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
      throw new Error("key is empty: this signer can only verify");
  }
}

function registryFlags(g: GlobalArgs): string[] {
  const flags: string[] = [];
  if (g.insecureRegistry) flags.push("--allow-insecure-registry");
  if (g.httpRegistry) flags.push("--allow-http-registry");
  return flags;
}

/** Temporary files a method needs, removed when it is done. */
class Scratch {
  readonly paths: string[] = [];
  async file(prefix: string, content: string): Promise<string> {
    const path = await Deno.makeTempFile({ prefix });
    await Deno.writeTextFile(path, content);
    this.paths.push(path);
    return path;
  }
  async dir(prefix: string): Promise<string> {
    const path = await Deno.makeTempDir({ prefix });
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

/** Pre-flight checks, run before every method but describe. */
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
      "The private key loads and, when encrypted, password decrypts it: its public key can be derived",
    labels: ["live"],
    appliesTo: ["sign", "attest", "signBlob"],
    execute: async (
      context: {
        globalArgs: z.input<typeof GlobalArgsSchema>;
        repoDir?: string;
        signal?: AbortSignal;
        logger: Context["logger"];
      },
    ): Promise<CheckResult> => {
      const ctx = checkContext(context);
      if (keyKind(ctx.globalArgs.key) === "none") {
        return { pass: false, errors: ["key is empty: nothing to sign with"] };
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

/** Model definition for one cosign signing identity. */
export const model = {
  type: "@dataverket/cosign/signer",
  version: "2026.11.10.1",
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
