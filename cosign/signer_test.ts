import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { z } from "npm:zod@4";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import {
  __setExec,
  __setScratchRoot,
  absolute,
  annotationRecord,
  argumentProblem,
  AttestArgsSchema,
  certificateFacts,
  type CommandResult,
  type Context,
  type ExecOptions,
  fingerprint,
  GlobalArgsSchema,
  IdentifyArgsSchema,
  identityProblem,
  keyKind,
  masked,
  model,
  parseAttestationOutput,
  parseDigestRef,
  parseDownload,
  parseGitUri,
  parseVerifyOutput,
  readCertificate,
  readStatement,
  SignArgsSchema,
  SignBlobArgsSchema,
  VerifyArgsSchema,
  VerifyAttestationArgsSchema,
  VerifyBlobArgsSchema,
  verifyMode,
} from "./signer.ts";

/** This extension's directory doubles as the repository root in tests. */
const REPO = import.meta.dirname!;

/**
 * Every temporary file of a test, and of the model under test, is made in
 * this one directory, which is removed when the run ends, also after a
 * failed test. Nothing is left in the system's temporary directory.
 */
const SCRATCH = Deno.makeTempDirSync({ prefix: "cosign-test-" });
__setScratchRoot(SCRATCH);
globalThis.addEventListener("unload", () => {
  try {
    Deno.removeSync(SCRATCH, { recursive: true });
  } catch {
    // Already gone.
  }
});

const DIGEST =
  "sha256:c02a5ac89d2df90595ef9dee1fba7364dfd8b218df88536e742421203fcb5c19";
const REF = `registry.example.org/team/api@${DIGEST}`;

const DIGEST2 =
  "sha256:4b9874bd1e5a1ee8ae9a5819237de1088fa7307d419e61cb4281e849a39a0405";
const PRIVATE = `-----BEGIN ENCRYPTED SIGSTORE PRIVATE KEY-----
eyJrZGYiOnsibmFtZSI6InNjcnlwdCIsInBhcmFtcyI6eyJOIjo2NTUzNiwiciI6
-----END ENCRYPTED SIGSTORE PRIVATE KEY-----
`;

const PUBLIC = `-----BEGIN PUBLIC KEY-----
MFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEiiOtHpdejXu40bGu77HIwue5Jc2Z
rng3f+djpPTUpSqSUL6xZ8e7TRWlZ/rTjqAh8n/0JBNMBjFhnZNlrf0rxA==
-----END PUBLIC KEY-----
`;

function payload(digest: string, optional: Record<string, string> | null) {
  return {
    critical: {
      identity: { "docker-reference": "x" },
      image: { "docker-manifest-digest": digest },
      type: "https://sigstore.dev/cosign/sign/v1",
    },
    optional,
  };
}

/** One DSSE envelope as cosign prints it, around any statement. */
function wrap(statement: unknown): string {
  return JSON.stringify({
    payload: btoa(JSON.stringify(statement)),
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ sig: "MEUC" }],
  });
}

/** A statement of a type about one digest, with an empty predicate. */
function envelope(predicateType: string, digest: string): string {
  return wrap({
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [{
      name: "registry.example.org/team/api",
      digest: { sha256: digest.slice("sha256:".length) },
    }],
    predicateType,
    predicate: {},
  });
}

type Written = { spec: string; name: string; data: Record<string, unknown> };

function context(over: Record<string, unknown> = {}) {
  const written: Written[] = [];
  const logs: string[] = [];
  const ctx: Context = {
    globalArgs: GlobalArgsSchema.parse({
      key: PRIVATE,
      password: "test",
      ...over,
    }),
    repoDir: REPO,
    // The message and what fills it in, as a log line would hold them.
    logger: {
      info: (msg, props) => logs.push(msg + " " + JSON.stringify(props ?? {})),
    },
    writeResource: (spec, name, data) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { ctx, written, logs };
}

const sign = (a: z.input<typeof SignArgsSchema>, ctx: Context) =>
  model.methods.sign.execute(SignArgsSchema.parse(a), ctx);
const verify = (a: z.input<typeof VerifyArgsSchema>, ctx: Context) =>
  model.methods.verify.execute(VerifyArgsSchema.parse(a), ctx);
const attest = (a: z.input<typeof AttestArgsSchema>, ctx: Context) =>
  model.methods.attest.execute(AttestArgsSchema.parse(a), ctx);
const signBlob = (a: z.input<typeof SignBlobArgsSchema>, ctx: Context) =>
  model.methods.signBlob.execute(SignBlobArgsSchema.parse(a), ctx);
const verifyBlob = (a: z.input<typeof VerifyBlobArgsSchema>, ctx: Context) =>
  model.methods.verifyBlob.execute(VerifyBlobArgsSchema.parse(a), ctx);
const verifyAttestation = (
  a: z.input<typeof VerifyAttestationArgsSchema>,
  ctx: Context,
) =>
  model.methods.verifyAttestation.execute(
    VerifyAttestationArgsSchema.parse(a),
    ctx,
  );

Deno.test("keyKind tells a PEM, a reference, a file and nothing apart", () => {
  assertEquals(keyKind(""), "none");
  assertEquals(keyKind(PRIVATE), "pem");
  assertEquals(keyKind("awskms:///alias/signing"), "reference");
  assertEquals(keyKind("hashivault://release"), "reference");
  assertEquals(keyKind("pkcs11:token=yubikey;object=sign"), "reference");
  assertEquals(keyKind("k8s://ns/secret"), "reference");
  assertEquals(keyKind("keys/cosign.key"), "file");
});

Deno.test("parseDigestRef accepts digests and refuses tags", () => {
  assertEquals(parseDigestRef(REF), {
    repository: "registry.example.org/team/api",
    digest: DIGEST,
  });
  assertEquals(parseDigestRef(`localhost:5000/api@${DIGEST}`), {
    repository: "localhost:5000/api",
    digest: DIGEST,
  });
  const tag = parseDigestRef("registry.example.org/team/api:v1");
  assert(typeof tag === "string");
  assertStringIncludes(tag, "a tag can move");
  assert(typeof parseDigestRef(`x@sha256:abc`) === "string");
});

Deno.test("annotationRecord, absolute and the verify output parsers", () => {
  assertEquals(annotationRecord(["a=1", "b=x=y", "a=2"]), {
    a: "2",
    b: "x=y",
  });
  assertEquals(absolute("/repo", "keys/k"), "/repo/keys/k");
  assertEquals(absolute("/repo", "/abs"), "/abs");
  assertEquals(absolute("/repo", ""), "");
  assertEquals(
    parseVerifyOutput(JSON.stringify([payload(DIGEST, { build: "abc" })])),
    [{ digest: DIGEST, annotations: { build: "abc" } }],
  );
  assertEquals(parseVerifyOutput(JSON.stringify([payload(DIGEST, null)])), [{
    digest: DIGEST,
    annotations: {},
  }]);
  assertEquals(parseVerifyOutput(""), []);
  assertStringIncludes(
    String(assertThrows(() => parseVerifyOutput("not json"))),
    "not JSON",
  );
  assertEquals(
    parseAttestationOutput(
      envelope("https://cosign.sigstore.dev/attestation/v1", DIGEST) + "\n" +
        envelope("https://slsa.dev/provenance/v1", DIGEST) + "\n",
    ),
    [
      "https://cosign.sigstore.dev/attestation/v1",
      "https://slsa.dev/provenance/v1",
    ],
  );
  assertEquals(parseAttestationOutput(""), []);
});

function assertThrows(fn: () => unknown): unknown {
  try {
    fn();
  } catch (err) {
    return err;
  }
  throw new Error("did not throw");
}

Deno.test("the arguments check judges PEMs, paths and config paths", () => {
  assertEquals(argumentProblem({ key: PRIVATE, publicKey: PUBLIC }), null);
  assertEquals(
    argumentProblem({ key: "keys/k", publicKey: "keys/k.pub" }),
    null,
  );
  assertEquals(argumentProblem({}), null);
  assertStringIncludes(
    argumentProblem({ key: "-----BEGIN PRIVATE KEY-----\nabc" })!,
    "not one whole PEM",
  );
  assertStringIncludes(argumentProblem({ key: "a\nb" })!, "newline");
  assertStringIncludes(
    argumentProblem({ key: "${{ vault.get(inputs.v, inputs.k) }}" })!,
    "unevaluated expression",
  );
  assertStringIncludes(argumentProblem({ publicKey: "a\nb" })!, "publicKey");
  assertStringIncludes(
    argumentProblem({ trustedRoot: "a\nb" })!,
    "trustedRoot holds a newline",
  );
});

Deno.test("a CRLF PEM passes the arguments check, and a public key that is not base64 is named", async () => {
  const crlf = PRIVATE.replace(/\n/g, "\r\n");
  assertEquals(argumentProblem({ key: crlf }), null);
  assertEquals(keyKind(crlf), "pem");
  const err = await assertRejects(() =>
    fingerprint(
      "-----BEGIN PUBLIC KEY-----\nComment: not a key\n-----END PUBLIC KEY-----\n",
    )
  );
  assertStringIncludes(String(err), "not base64");
});

Deno.test("masked replaces the PEM wherever cosign echoes it, and nothing else", () => {
  const g = GlobalArgsSchema.parse({ key: PRIVATE, password: "e2e" });
  assertEquals(
    masked(`key ${PRIVATE} suite=e2e`, g),
    "key <redacted> suite=e2e",
  );
  assertEquals(masked(`key ${PRIVATE.trim()} end`, g), "key <redacted> end");
  const file = GlobalArgsSchema.parse({ key: "keys/k", password: "" });
  assertEquals(masked("keys/k stays", file), "keys/k stays");
});

// The real cosign against an image in a registry, with a key pair generated
// by the model. COSIGN_E2E=1 enables it; COSIGN_E2E_REF names an image by
// digest in a registry that needs no credentials, such as a local one.
const e2e = Deno.env.get("COSIGN_E2E") === "1";

Deno.test({
  name:
    "e2e: generate a key pair, sign, verify, attest, and fail to verify with another key",
  ignore: !e2e,
  fn: async () => {
    const ref = Deno.env.get("COSIGN_E2E_REF")!;
    const over = {
      cosignBinary: Deno.env.get("COSIGN_BINARY") ?? "cosign",
      password: "e2e",
    };
    const k = context({ ...over, key: "" });
    await model.methods.generateKeyPair.execute({}, k.ctx);
    const key = String(k.written[0].data.privateKey);
    assertStringIncludes(key, "SIGSTORE PRIVATE KEY");

    const d = context({ ...over, key });
    await model.methods.describe.execute({}, d.ctx);
    assertEquals(d.written[0].data.publicKey, k.written[0].data.publicKey);
    assertStringIncludes(String(d.written[0].data.version), "v3.");

    const s = context({ ...over, key });
    await sign({ refs: [ref], annotations: ["suite=e2e"] }, s.ctx);
    assertEquals(s.written[0].data.uploaded, true);

    const v = context({ ...over, key });
    await verify({ refs: [ref], annotations: ["suite=e2e"] }, v.ctx);
    assertEquals(
      v.written[0].data.verified,
      true,
      String(v.written[0].data.error),
    );
    assertEquals(
      (v.written[0].data.payloads as { annotations: Record<string, string> }[])[
        0
      ]
        .annotations.suite,
      "e2e",
    );

    const other = context({ ...over, key: "" });
    await model.methods.generateKeyPair.execute({}, other.ctx);
    const wrong = context({
      ...over,
      key,
      publicKey: String(other.written[0].data.publicKey),
    });
    await verify({ refs: [ref] }, wrong.ctx);
    assertEquals(wrong.written[0].data.verified, false);
    assertStringIncludes(String(wrong.written[0].data.error), "no matching");

    const dir = await Deno.makeTempDir({
      prefix: "cosign-e2e-",
      dir: SCRATCH,
    });
    try {
      await Deno.writeTextFile(`${dir}/release.json`, '{"suite":"e2e"}\n');
      const a = context({ ...over, key });
      await attest({ refs: [ref], predicate: `${dir}/release.json` }, a.ctx);
      const va = context({ ...over, key });
      await verifyAttestation({ refs: [ref] }, va.ctx);
      assertEquals(
        va.written[0].data.verified,
        true,
        String(va.written[0].data.error),
      );
      assert((va.written[0].data.attestations as number) >= 1);

      const sb = context({ ...over, key });
      await signBlob({ path: `${dir}/release.json` }, sb.ctx);
      const vb = context({ ...over, key });
      await verifyBlob({ path: `${dir}/release.json` }, vb.ctx);
      assertEquals(
        vb.written[0].data.verified,
        true,
        String(vb.written[0].data.error),
      );
      await Deno.writeTextFile(`${dir}/release.json`, '{"suite":"tampered"}\n');
      await verifyBlob({ path: `${dir}/release.json` }, vb.ctx);
      assertEquals(vb.written[1].data.verified, false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
});

// Keyless: a certificate identity and its issuer instead of a public key.
const IDENTITY_REGEXP =
  "^https://github.com/example/release/.github/workflows/";
const IDENTITY =
  "https://github.com/example/release/.github/workflows/release.yaml@refs/heads/main";
const ISSUER = "https://token.actions.githubusercontent.com";

const KEYLESS = {
  key: "",
  password: "",
  certificateIdentityRegexp: IDENTITY_REGEXP,
  oidcIssuer: ISSUER,
  tlog: true,
};

Deno.test("verifyMode tells keyless, key and nothing apart, and an identity wins over a key", () => {
  assertEquals(verifyMode({}), "none");
  assertEquals(verifyMode({ key: PRIVATE }), "key");
  assertEquals(verifyMode({ publicKey: PUBLIC }), "key");
  assertEquals(verifyMode({ certificateIdentity: IDENTITY }), "keyless");
  assertEquals(verifyMode({ certificateIdentityRegexp: ".*" }), "keyless");
  assertEquals(
    verifyMode({ key: PRIVATE, certificateIdentity: IDENTITY }),
    "keyless",
  );
});

Deno.test("the arguments check accepts a keyless set and refuses the combinations that cannot work", () => {
  assertEquals(argumentProblem(KEYLESS), null);
  assertEquals(
    argumentProblem({
      certificateIdentity: IDENTITY,
      oidcIssuer: ISSUER,
      tlog: true,
    }),
    null,
  );
  // A signer that signs with its key and verifies another party keyless.
  assertEquals(argumentProblem({ ...KEYLESS, key: PRIVATE }), null);
  assertStringIncludes(
    argumentProblem({ ...KEYLESS, publicKey: PUBLIC })!,
    "publicKey and a certificate identity are both set",
  );
  assertStringIncludes(
    argumentProblem({ ...KEYLESS, oidcIssuer: "" })!,
    "without oidcIssuer",
  );
  assertStringIncludes(
    argumentProblem({ oidcIssuer: ISSUER })!,
    "oidcIssuer is set without a certificate identity",
  );
  assertStringIncludes(
    argumentProblem({ ...KEYLESS, certificateIdentity: IDENTITY })!,
    "both set",
  );
  assertStringIncludes(
    argumentProblem({ ...KEYLESS, tlog: false })!,
    "tlog is false with a certificate identity",
  );
  assertStringIncludes(
    argumentProblem({ ...KEYLESS, tlog: undefined })!,
    "tlog is false",
  );
  assertStringIncludes(
    argumentProblem({ ...KEYLESS, oidcIssuer: "a\nb" })!,
    "oidcIssuer holds a newline",
  );
  assertStringIncludes(
    argumentProblem({
      ...KEYLESS,
      certificateIdentityRegexp: "${{ inputs.identity }}",
    })!,
    "unevaluated expression",
  );
  assertEquals(identityProblem({}), null);
});

// The real cosign against a public image signed keyless from a GitHub
// workflow, through the public Sigstore instance: needs the network.
// COSIGN_KEYLESS_E2E=1 enables it; COSIGN_KEYLESS_E2E_REF names the image by
// digest, COSIGN_KEYLESS_E2E_IDENTITY_REGEXP and COSIGN_KEYLESS_E2E_ISSUER
// default to Chainguard's release workflow and GitHub Actions.
const keylessE2e = Deno.env.get("COSIGN_KEYLESS_E2E") === "1";

Deno.test({
  name:
    "keyless e2e: verify a public image and its SPDX attestation, and fail with another identity",
  ignore: !keylessE2e,
  fn: async () => {
    const ref = Deno.env.get("COSIGN_KEYLESS_E2E_REF")!;
    const over = {
      cosignBinary: Deno.env.get("COSIGN_BINARY") ?? "cosign",
      key: "",
      password: "",
      certificateIdentityRegexp:
        Deno.env.get("COSIGN_KEYLESS_E2E_IDENTITY_REGEXP") ??
          "^https://github.com/chainguard-images/images/",
      oidcIssuer: Deno.env.get("COSIGN_KEYLESS_E2E_ISSUER") ??
        "https://token.actions.githubusercontent.com",
      tlog: true,
    };
    const d = context(over);
    await model.methods.describe.execute({}, d.ctx);
    assertEquals(d.written[0].data.verifyMode, "keyless");

    const v = context(over);
    await verify({ refs: [ref] }, v.ctx);
    assertEquals(
      v.written[0].data.verified,
      true,
      String(v.written[0].data.error),
    );
    assert((v.written[0].data.signatures as number) >= 1);

    const va = context(over);
    await verifyAttestation(
      { refs: [ref], type: "https://spdx.dev/Document" },
      va.ctx,
    );
    assertEquals(
      va.written[0].data.verified,
      true,
      String(va.written[0].data.error),
    );

    const wrong = context({
      ...over,
      certificateIdentityRegexp: "^https://github.com/example/nobody/",
    });
    await verify({ refs: [ref] }, wrong.ctx);
    assertEquals(wrong.written[0].data.verified, false);
    assertStringIncludes(
      String(wrong.written[0].data.error),
      "none of the expected identities matched",
    );
  },
});

// What an attestation says: its subjects, and for SLSA provenance where the
// artifact was built from. A verified attestation counts only when it is
// about the digest that was asked for.

const SLSA1 = "https://slsa.dev/provenance/v1";

const SOURCE = "https://github.com/example/api";

const COMMIT = "a42552e6c9739a9d577f86dd819e9d41aee7c059";

const BUILDER =
  "https://github.com/example/api/.github/workflows/build.yml@refs/heads/main";
const INVOCATION =
  "https://github.com/example/api/actions/runs/42835074961/attempts/1";
const hex = (digest: string) => digest.slice("sha256:".length);

function subject(digest: string, name = "registry.example.org/team/api") {
  return { name, digest: { sha256: hex(digest) } };
}

/** SLSA provenance v1 as GitHub's attest-build-provenance writes it. */
function slsa1(
  digest: string,
  over: { commit?: string; repository?: string; ref?: string } = {},
) {
  const repository = over.repository ?? SOURCE;
  const ref = over.ref ?? "refs/heads/main";
  return {
    _type: "https://in-toto.io/Statement/v1",
    subject: [subject(digest)],
    predicateType: SLSA1,
    predicate: {
      buildDefinition: {
        buildType: "https://actions.github.io/buildtypes/workflow/v1",
        externalParameters: {
          workflow: { ref, repository, path: ".github/workflows/build.yml" },
        },
        internalParameters: {
          github: { event_name: "push", repository_id: "76734068" },
        },
        resolvedDependencies: [{
          uri: `git+${repository}@${ref}`,
          digest: { gitCommit: over.commit ?? COMMIT },
        }],
      },
      runDetails: {
        builder: { id: BUILDER },
        metadata: { invocationId: INVOCATION },
      },
    },
  };
}

Deno.test("parseGitUri splits a git URI into repository and ref, and nothing else into anything", () => {
  assertEquals(
    parseGitUri("git+https://github.com/example/api@refs/heads/main"),
    {
      repository: "https://github.com/example/api",
      ref: "refs/heads/main",
    },
  );
  assertEquals(parseGitUri("git+https://github.com/example/api"), {
    repository: "https://github.com/example/api",
    ref: null,
  });
  assertEquals(parseGitUri("git+ssh://git.example.org/team/api.git@v1"), {
    repository: "ssh://git.example.org/team/api.git",
    ref: "v1",
  });
  for (
    const uri of [
      "https://github.com/example/api@refs/heads/main",
      "git+https://user@github.com/example/api@refs/heads/main",
      "git+https://user:pw@github.com/example/api",
      "git+https://github.com/example/api?token=x@refs/heads/main",
      "git+https://github.com/example/api@refs/heads/main?x=1",
      "git+https://github.com",
      "git+github.com/example/api",
      "git+",
      "git+https://github.com/example/" + "a".repeat(5000),
      "git+https://github.com/example/api@" + "r".repeat(5000),
      "",
      7,
      null,
    ]
  ) {
    assertEquals(parseGitUri(uri), null, String(uri));
  }
});

Deno.test("readStatement judges one statement against a digest without the model", () => {
  const s = readStatement(slsa1(DIGEST), DIGEST);
  assertEquals(s.subjectMatches, true);
  assertEquals(s.sourceCommit, COMMIT);
  assertEquals(readStatement(slsa1(DIGEST), DIGEST2).subjectMatches, false);
  assertEquals(readStatement(undefined, DIGEST).subjectMatches, false);
});

Deno.test("the type carries an upgrade to this version, and its arguments are unchanged", () => {
  assertEquals(model.version, "2026.11.10.2");
  assertEquals(model.upgrades.map((u) => u.toVersion), [
    "2026.11.10.1",
    "2026.11.10.2",
  ]);
  const last = model.upgrades[model.upgrades.length - 1];
  assertEquals(last.toVersion, model.version);
  const old = { key: "", tlog: true, certificateIdentity: "x" };
  assertEquals(last.upgradeAttributes(old), old);
  // A call written for 2026.10.28.1 parses as before.
  assertEquals(VerifyAttestationArgsSchema.parse({ refs: [REF] }), {
    refs: [REF],
    type: "custom",
    sourceRepository: "",
    sourceCommit: "",
  });
});

Deno.test("only a statement's own fields are read, never what an object inherits", () => {
  const inherited = Object.create(slsa1(DIGEST));
  const s = readStatement(inherited, DIGEST);
  assertEquals(s.subjectMatches, false);
  assertEquals(s.predicateType, "");
  assertEquals(s.sourceRepository, null);
  const st = slsa1(DIGEST);
  (st.subject as unknown[])[0] = Object.create(st.subject[0]);
  assertEquals(readStatement(st, DIGEST).subjectMatches, false);
});

const FULCIO = "1.3.6.1.4.1.57264.1.";

/** One DER element. */
function tlv(tag: number, ...parts: Uint8Array[]): Uint8Array {
  const length = parts.reduce((n, p) => n + p.length, 0);
  const head = length < 0x80
    ? [tag, length]
    : length < 0x100
    ? [tag, 0x81, length]
    : [tag, 0x82, length >> 8, length & 0xff];
  const out = new Uint8Array(head.length + length);
  out.set(head);
  let at = head.length;
  for (const p of parts) {
    out.set(p, at);
    at += p.length;
  }
  return out;
}

const bytes = (text: string) => new TextEncoder().encode(text);

/** A DER UTF8String, as Fulcio writes its extensions from 8 on. */
const utf8 = (text: string) => tlv(0x0c, bytes(text));

/** Subject alternative names: a URI, an email address. */
const uri = (text: string) => tlv(0x86, bytes(text));

const email = (text: string) => tlv(0x81, bytes(text));

function oidBytes(dotted: string): Uint8Array {
  const n = dotted.split(".").map(Number);
  const body = [n[0] * 40 + n[1]];
  for (const v of n.slice(2)) {
    const chunk = [v & 0x7f];
    for (let rest = v >> 7; rest > 0; rest >>= 7) {
      chunk.unshift((rest & 0x7f) | 0x80);
    }
    body.push(...chunk);
  }
  return tlv(0x06, Uint8Array.from(body));
}

/**
 * A certificate with the given subject alternative names and Fulcio
 * extensions, as base64 DER. It has the structure of one and no signature
 * that would check out: whether a certificate is genuine is for cosign to
 * say.
 */
function certificate(
  names: Uint8Array[],
  fulcio: [number, Uint8Array][],
): string {
  const extension = (oid: string, value: Uint8Array) =>
    tlv(0x30, oidBytes(oid), tlv(0x04, value));
  const extensions = [
    ...(names.length ? [extension("2.5.29.17", tlv(0x30, ...names))] : []),
    ...fulcio.map(([n, v]) => extension(`${FULCIO}${n}`, v)),
  ];
  const tbs = tlv(
    0x30,
    tlv(0xa0, tlv(0x02, Uint8Array.of(2))),
    tlv(0x02, Uint8Array.of(1)),
    tlv(0x30),
    tlv(0x30),
    tlv(0x30),
    tlv(0x30),
    tlv(0x30),
    tlv(0xa3, tlv(0x30, ...extensions)),
  );
  const der = tlv(0x30, tbs, tlv(0x30), tlv(0x03, Uint8Array.of(0)));
  return btoa(Array.from(der, (b) => String.fromCharCode(b)).join(""));
}

const ID_A =
  "https://github.com/example/api/.github/workflows/release.yml@refs/tags/v1";
const ISSUER_B = "https://gitlab.example.org";

/** The certificate of ghcr.io/renovatebot/renovate 44.226.2's signature, issued by the public Fulcio on 2026-11-10. */
const RENOVATE_CERT =
  "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";

Deno.test("certificateFacts reads a certificate the public Fulcio issued, and readCertificate the other kinds of name", () => {
  const facts = certificateFacts(RENOVATE_CERT)!;
  assertEquals(
    facts.certificateIdentity,
    "https://github.com/renovatebot/renovate/.github/workflows/build.yml@refs/heads/main",
  );
  assertEquals(facts.oidcIssuer, ISSUER);
  assertEquals(facts.withheld, 0);
  assertEquals(facts.claims.githubWorkflowRepository, "renovatebot/renovate");
  assertEquals(facts.claims.githubWorkflowSha, COMMIT);
  assertEquals(
    facts.claims.sourceRepositoryUri,
    "https://github.com/renovatebot/renovate",
  );
  assertEquals(facts.claims.sourceRepositoryRef, "refs/heads/main");
  assertEquals(facts.claims.buildTrigger, "push");
  assertEquals(facts.claims.runnerEnvironment, "github-hosted");
  assertEquals(
    facts.claims[`${FULCIO}24`],
    "repo:renovatebot/renovate:ref:refs/heads/main",
  );
  assertEquals(Object.keys(facts.claims).length, 20);

  // An email address, a DNS name, an address, and Fulcio's user name.
  const der = (b64: string) =>
    Uint8Array.from(atob(b64), (c) => c.charCodeAt(0));
  const otherName = tlv(
    0xa0,
    oidBytes(`${FULCIO}7`),
    tlv(0xa0, utf8("alice!example.org")),
  );
  assertEquals(
    readCertificate(der(certificate([
      email("alice@example.org"),
      tlv(0x82, bytes("host.example.org")),
      tlv(0x87, Uint8Array.of(192, 0, 2, 1)),
      otherName,
      tlv(0xa4, tlv(0x30)),
    ], []))).names,
    [
      "alice@example.org",
      "host.example.org",
      "192.0.2.1",
      "alice!example.org",
      null,
    ],
  );
  const mail = certificateFacts(
    certificate([email("alice@example.org")], [[
      1,
      bytes("https://accounts.example.org"),
    ]]),
  )!;
  assertEquals(mail.certificateIdentity, "alice@example.org");
  // With no extension 8 the issuer is extension 1; with both, 8, as cosign reads them.
  assertEquals(mail.oidcIssuer, "https://accounts.example.org");
  assertEquals(
    certificateFacts(
      certificate([uri(ID_A)], [[1, bytes("https://old.example.org")], [
        8,
        utf8(ISSUER),
      ]]),
    )!.oidcIssuer,
    ISSUER,
  );
  // A second extension of one number is not read: the first stands.
  const twice = certificateFacts(
    certificate([uri(ID_A)], [[8, utf8(ISSUER)], [8, utf8(ISSUER_B)], [
      12,
      utf8(SOURCE),
    ], [12, utf8("https://evil.example.org/x")]]),
  )!;
  assertEquals(twice.oidcIssuer, ISSUER);
  assertEquals(twice.claims, { sourceRepositoryUri: SOURCE });
  assertEquals(twice.withheld, 2);
  // More claims than a record keeps are counted.
  const wide = certificateFacts(
    certificate(
      [uri(ID_A)],
      Array.from(
        { length: 60 },
        (_, i): [number, Uint8Array] => [100 + i, utf8("v")],
      ),
    ),
  )!;
  assertEquals(Object.keys(wide.claims).length, 40);
  assertEquals(wide.withheld, 20);
  // A certificate with no names and no extensions says nothing, and is read.
  assertEquals(certificateFacts(certificate([], [])), {
    certificateIdentity: "",
    oidcIssuer: "",
    claims: {},
    withheld: 0,
  });
  // Bytes that are not a certificate are not one.
  for (const raw of ["", "AAAA", "MAA=", "MIIB", btoa("hello"), 7, null]) {
    assertEquals(certificateFacts(raw), null);
  }
  assertEquals(parseDownload(""), []);
  assertEquals(parseDownload('{"a":1}\n\n{"b":2}\n'), [{ a: 1 }, { b: 2 }]);
});

// ───── the methods, through createModelTestContext with a stub exec ─────

/** The passphrase, a marker no record, log line or error may hold. */
const PASSWORD = "PASSWORD-MARKER-0123456789";

/** One answer: what cosign printed, or a function of the call. */
type Answer =
  | CommandResult
  | ((args: string[], opts: ExecOptions) => CommandResult);

/**
 * A stub cosign: `[argument prefix, answer]`, the first route whose prefix
 * starts the call's arguments answers it, and a call no route names fails.
 */
function stubExec(routes: [string, Answer][]) {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  const restore = __setExec((_bin, args, opts) => {
    calls.push({ args, env: opts.env });
    const line = args.join(" ");
    const route = routes.find(([prefix]) => line.startsWith(prefix));
    if (!route) return Promise.reject(new Error(`no answer for ${line}`));
    const a = route[1];
    return Promise.resolve(typeof a === "function" ? a(args, opts) : a);
  });
  return { calls, restore };
}

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });
const exit = (stderr: string, code = 1): CommandResult => ({
  code,
  stdout: "",
  stderr,
});

/** A swamp test context over the signer's global arguments. */
function harness(over: Record<string, unknown> = {}) {
  const t = createModelTestContext({
    globalArgs: GlobalArgsSchema.parse({
      key: PRIVATE,
      password: PASSWORD,
      publicKey: PUBLIC,
      tlog: true,
      ...over,
    }),
    repoDir: REPO,
  });
  return {
    ctx: t.context as unknown as Context,
    written: () =>
      t.getWrittenResources().map((w) => ({
        spec: w.specName,
        name: w.name,
        data: w.data as Record<string, unknown>,
      })),
    logs: () => t.getLogs().map((l) => l.message + JSON.stringify(l.args)),
  };
}

/** Neither the private key nor the passphrase is in `text`. */
function assertNoSecret(text: string) {
  assertEquals(text.includes(PASSWORD), false, "the passphrase leaked");
  assertEquals(
    text.includes(PRIVATE.split("\n")[1]),
    false,
    "the private key leaked",
  );
}

/** The records and log lines of `h`, and the error `err`, hold no secret. */
function assertNothingLeaked(
  h: ReturnType<typeof harness>,
  err?: unknown,
) {
  assertNoSecret(JSON.stringify(h.written()));
  assertNoSecret(h.logs().join("\n"));
  if (err !== undefined) assertNoSecret(String(err));
}

/** A file in the scratch directory, for the blob and attest methods. */
function scratchFile(name: string, content: string): string {
  const dir = Deno.makeTempDirSync({ dir: SCRATCH });
  const path = `${dir}/${name}`;
  Deno.writeTextFileSync(path, content);
  return path;
}

Deno.test("describe records the version, key kind and public key fingerprint", async () => {
  const s = stubExec([["version --json", ok('{"gitVersion":"v3.0.2"}')]]);
  try {
    const h = harness();
    await model.methods.describe.execute({}, h.ctx);
    const [w] = h.written();
    assertEquals([w.spec, w.name], ["signer", "signer"]);
    assertEquals(w.data.version, "v3.0.2");
    assertEquals(w.data.keyKind, "pem");
    assertEquals(w.data.publicKeySource, "argument");
    assertEquals(w.data.verifyMode, "key");
    assertEquals(w.data.fingerprint, await fingerprint(PUBLIC));
    assert(h.logs().some((l) => l.startsWith("cosign {version}")));
    assertNothingLeaked(h);
  } finally {
    s.restore();
  }
});

Deno.test("describe fails when cosign's version is not JSON, and writes nothing", async () => {
  const s = stubExec([["version --json", ok("cosign v3")]]);
  try {
    const h = harness();
    const err = await assertRejects(
      () => model.methods.describe.execute({}, h.ctx),
      Error,
      "not JSON",
    );
    assertEquals(h.written(), []);
    assertNothingLeaked(h, err);
  } finally {
    s.restore();
  }
});

Deno.test("generateKeyPair records the pair cosign wrote, the private key in its sensitive field only", async () => {
  const s = stubExec([[
    "generate-key-pair --output-key-prefix",
    (args) => {
      const prefix = args[args.length - 1];
      Deno.writeTextFileSync(`${prefix}.pub`, PUBLIC);
      Deno.writeTextFileSync(`${prefix}.key`, PRIVATE);
      return ok();
    },
  ]]);
  try {
    const h = harness({ key: "" });
    await model.methods.generateKeyPair.execute({}, h.ctx);
    const [w] = h.written();
    assertEquals([w.spec, w.name], ["keypair", "keypair"]);
    assertEquals(w.data.publicKey, PUBLIC);
    assertEquals(w.data.privateKey, PRIVATE);
    assertEquals(w.data.passphraseSet, true);
    // The passphrase reaches cosign through its environment only.
    assertEquals(s.calls[0].env.COSIGN_PASSWORD, PASSWORD);
    assertEquals(s.calls[0].args.includes(PASSWORD), false);
    assertNoSecret(h.logs().join("\n"));
    assertNoSecret(JSON.stringify({ ...w.data, privateKey: "" }));
    // The key files cosign wrote are removed.
    const prefix = s.calls[0].args[s.calls[0].args.length - 1];
    assertEquals(await Deno.stat(`${prefix}.key`).catch(() => null), null);
  } finally {
    s.restore();
  }
});

Deno.test("generateKeyPair fails when cosign does, and writes nothing", async () => {
  const s = stubExec([[
    "generate-key-pair",
    exit("Error: reading password: inappropriate ioctl"),
  ]]);
  try {
    const h = harness({ key: "" });
    const err = await assertRejects(
      () => model.methods.generateKeyPair.execute({}, h.ctx),
      Error,
      "exited 1: Error: reading password",
    );
    assertEquals(h.written(), []);
    assertNothingLeaked(h, err);
  } finally {
    s.restore();
  }
});

Deno.test("sign signs each image with the key from the environment and records each signature", async () => {
  const s = stubExec([["sign --yes --key env://COSIGN_KEY", ok()]]);
  try {
    const h = harness();
    const ref2 = `registry.example.org/team/web@${DIGEST2}`;
    await model.methods.sign.execute(
      SignArgsSchema.parse({ refs: [REF, ref2], annotations: ["build=7"] }),
      h.ctx,
    );
    assertEquals(s.calls.map((c) => c.args.slice(-2)), [
      ["--", REF],
      ["--", ref2],
    ]);
    assertEquals(s.calls[0].env.COSIGN_KEY, PRIVATE);
    assertEquals(
      h.written().map((
        w,
      ) => [w.spec, w.name, w.data.digest, w.data.annotations]),
      [
        [
          "signature",
          `signature-registry.example.org-team-api-c02a5ac89d2d`,
          DIGEST,
          { build: "7" },
        ],
        [
          "signature",
          `signature-registry.example.org-team-web-4b9874bd1e5a`,
          DIGEST2,
          { build: "7" },
        ],
      ],
    );
    assertEquals(
      h.logs().filter((l) => l.startsWith("Signed {ref}")).length,
      2,
    );
    assertNothingLeaked(h);
  } finally {
    s.restore();
  }
});

Deno.test("sign fails when cosign does, with the key it echoed masked, and records nothing", async () => {
  const s = stubExec([[
    "sign",
    exit(`Error: signing: could not decrypt ${PRIVATE}`),
  ]]);
  try {
    const h = harness();
    const err = await assertRejects(
      () =>
        model.methods.sign.execute(
          SignArgsSchema.parse({ refs: [REF] }),
          h.ctx,
        ),
      Error,
      "<redacted>",
    );
    assertEquals(h.written(), []);
    assertNothingLeaked(h, err);
  } finally {
    s.restore();
  }
});

Deno.test("verify records the signatures cosign found, checked against the public key", async () => {
  const s = stubExec([[
    "verify --key",
    ok(JSON.stringify([payload(DIGEST, { build: "7" })])),
  ]]);
  try {
    const h = harness();
    await model.methods.verify.execute(
      VerifyArgsSchema.parse({ refs: [REF] }),
      h.ctx,
    );
    // Verifying reads no private key and no passphrase.
    const [w] = h.written();
    assertEquals([w.spec, w.name], [
      "verification",
      "verification-registry.example.org-team-api-c02a5ac89d2d",
    ]);
    assertEquals(w.data.verified, true);
    assertEquals(w.data.signatures, 1);
    assertEquals(w.data.verifyMode, "key");
    assertEquals(w.data.publicKeyFingerprint, await fingerprint(PUBLIC));
    assert(h.logs().some((l) => l.includes("1 signatures verified")));
    assertNothingLeaked(h);
  } finally {
    s.restore();
  }
});

Deno.test("verify records an image that does not verify, and fails when cosign cannot run the check", async () => {
  const s = stubExec([[
    `verify`,
    exit("Error: no matching signatures: invalid signature"),
  ]]);
  try {
    const h = harness();
    await model.methods.verify.execute(
      VerifyArgsSchema.parse({ refs: [REF] }),
      h.ctx,
    );
    const [w] = h.written();
    assertEquals(w.data.verified, false);
    assertEquals(w.data.error, "no matching signatures: invalid signature");
  } finally {
    s.restore();
  }
  const f = stubExec([["verify", exit("Error: dial tcp: connection refused")]]);
  try {
    const h = harness();
    const err = await assertRejects(
      () =>
        model.methods.verify.execute(
          VerifyArgsSchema.parse({ refs: [REF] }),
          h.ctx,
        ),
      Error,
      "connection refused",
    );
    assertEquals(h.written(), []);
    assertNothingLeaked(h, err);
  } finally {
    f.restore();
  }
});

Deno.test("identify records an image with no signature as unsigned, and passes no key to cosign", async () => {
  const s = stubExec([
    ["download signature", exit("Error: no signatures associated with image")],
    [
      "tree",
      ok(
        `📦 Supply Chain Security Related artifacts for an image: ${REF}\n` +
          `No Supply Chain Security Related Artifacts found for image ${REF},\n` +
          " start creating one with simply running$ cosign sign <img>\n",
      ),
    ],
  ]);
  try {
    const h = harness();
    await model.methods.identify.execute(
      IdentifyArgsSchema.parse({ refs: [REF] }),
      h.ctx,
    );
    const [w] = h.written();
    assertEquals([w.spec, w.name, w.data.state], [
      "identification",
      "identification-registry.example.org-team-api-c02a5ac89d2d",
      "unsigned",
    ]);
    assertEquals(w.data.certificateIdentity, "");
    for (const c of s.calls) {
      assertEquals(c.env.COSIGN_KEY, undefined);
      assertEquals(c.env.COSIGN_PASSWORD, undefined);
    }
    assert(h.logs().some((l) => l.startsWith("{ref}: {state}")));
    assertNothingLeaked(h);
  } finally {
    s.restore();
  }
});

Deno.test("identify fails when the registry does not answer, and records nothing", async () => {
  const s = stubExec([[
    "download signature",
    exit(
      "Error: no signatures associated: GET https://registry.example.org/v2/: dial tcp: i/o timeout",
    ),
  ]]);
  try {
    const h = harness();
    const err = await assertRejects(
      () =>
        model.methods.identify.execute(
          IdentifyArgsSchema.parse({ refs: [REF] }),
          h.ctx,
        ),
      Error,
      "i/o timeout",
    );
    assertEquals(h.written(), []);
    assertNothingLeaked(h, err);
  } finally {
    s.restore();
  }
});

Deno.test("attest attaches the predicate to each image and records its sha256", async () => {
  const predicate = scratchFile("sbom.json", '{"spdx":true}');
  const s = stubExec([["attest --yes --key env://COSIGN_KEY", ok()]]);
  try {
    const h = harness();
    await model.methods.attest.execute(
      AttestArgsSchema.parse({ refs: [REF], predicate, type: "spdxjson" }),
      h.ctx,
    );
    assertStringIncludes(
      s.calls[0].args.join(" "),
      `--predicate ${predicate} --type spdxjson`,
    );
    const [w] = h.written();
    assertEquals([w.spec, w.name], [
      "attestation",
      "attestation-registry.example.org-team-api-c02a5ac89d2d",
    ]);
    assertEquals(w.data.type, "spdxjson");
    assertEquals(w.data.predicate, predicate);
    assertEquals(String(w.data.predicateSha256).startsWith("sha256:"), true);
    assert(h.logs().some((l) => l.startsWith("Attested {ref}")));
    assertNothingLeaked(h);
  } finally {
    s.restore();
  }
});

Deno.test("attest fails when cosign does, and records nothing", async () => {
  const predicate = scratchFile("sbom.json", "{}");
  const s = stubExec([[
    "attest",
    exit("Error: signing: PUT https://registry.example.org/v2/: DENIED"),
  ]]);
  try {
    const h = harness();
    const err = await assertRejects(
      () =>
        model.methods.attest.execute(
          AttestArgsSchema.parse({ refs: [REF], predicate }),
          h.ctx,
        ),
      Error,
      "DENIED",
    );
    assertEquals(h.written(), []);
    assertNothingLeaked(h, err);
  } finally {
    s.restore();
  }
});

Deno.test("verifyAttestation records the provenance the counted attestations agree on", async () => {
  const s = stubExec([[
    "verify-attestation --key",
    ok(wrap(slsa1(DIGEST)) + "\n"),
  ]]);
  try {
    const h = harness();
    await model.methods.verifyAttestation.execute(
      VerifyAttestationArgsSchema.parse({
        refs: [REF],
        type: "slsaprovenance1",
        sourceRepository: SOURCE,
        sourceCommit: COMMIT,
      }),
      h.ctx,
    );
    const [w] = h.written();
    assertEquals([w.spec, w.name], [
      "attestationVerification",
      "attestationVerification-registry.example.org-team-api-c02a5ac89d2d",
    ]);
    assertEquals(w.data.verified, true);
    assertEquals([w.data.attestations, w.data.matched], [1, 1]);
    assertEquals(w.data.sourceRepository, SOURCE);
    assertEquals(w.data.sourceCommit, COMMIT);
    assert(h.logs().some((l) => l.includes("1 of 1 attestations verified")));
    assertNothingLeaked(h);
  } finally {
    s.restore();
  }
});

Deno.test("verifyAttestation counts no attestation of another commit, and fails when cosign cannot run", async () => {
  const s = stubExec([["verify-attestation", ok(wrap(slsa1(DIGEST)))]]);
  try {
    const h = harness();
    await model.methods.verifyAttestation.execute(
      VerifyAttestationArgsSchema.parse({
        refs: [REF],
        sourceCommit: "b".repeat(40),
      }),
      h.ctx,
    );
    const [w] = h.written();
    assertEquals([w.data.verified, w.data.matched], [false, 0]);
    assertStringIncludes(String(w.data.error), "none counted");
  } finally {
    s.restore();
  }
  const f = stubExec([[
    "verify-attestation",
    exit("Error: loading trusted root: no such file"),
  ]]);
  try {
    const h = harness();
    const err = await assertRejects(
      () =>
        model.methods.verifyAttestation.execute(
          VerifyAttestationArgsSchema.parse({ refs: [REF] }),
          h.ctx,
        ),
      Error,
      "no such file",
    );
    assertEquals(h.written(), []);
    assertNothingLeaked(h, err);
  } finally {
    f.restore();
  }
});

Deno.test("signBlob signs a file, writes its bundle beside it and records its sha256", async () => {
  const path = scratchFile("release.json", '{"v":1}');
  const s = stubExec([["sign-blob --yes --key env://COSIGN_KEY", ok()]]);
  try {
    const h = harness();
    await model.methods.signBlob.execute(
      SignBlobArgsSchema.parse({ path }),
      h.ctx,
    );
    assertEquals(s.calls[0].args.slice(-4), [
      "--bundle",
      `${path}.sigstore.json`,
      "--",
      path,
    ]);
    const [w] = h.written();
    assertEquals(w.spec, "blobSignature");
    assert(w.name.startsWith("blobSignature-release.json-"));
    assertEquals(w.data.bundle, `${path}.sigstore.json`);
    assertEquals(
      w.data.sha256,
      "sha256:" +
        Array.from(
          new Uint8Array(
            await crypto.subtle.digest(
              "SHA-256",
              new TextEncoder().encode('{"v":1}'),
            ),
          ),
        ).map((b) => b.toString(16).padStart(2, "0")).join(""),
    );
    assert(h.logs().some((l) => l.startsWith("Wrote {bundle}")));
    assertNothingLeaked(h);
  } finally {
    s.restore();
  }
});

Deno.test("signBlob fails on a file that is not there, before cosign runs", async () => {
  const s = stubExec([]);
  try {
    const h = harness();
    const err = await assertRejects(
      () =>
        model.methods.signBlob.execute(
          SignBlobArgsSchema.parse({ path: `${SCRATCH}/absent` }),
          h.ctx,
        ),
      Error,
      "cannot be read",
    );
    assertEquals(s.calls, []);
    assertEquals(h.written(), []);
    assertNothingLeaked(h, err);
  } finally {
    s.restore();
  }
});

Deno.test("verifyBlob records a file that verifies against its bundle", async () => {
  const path = scratchFile("release.json", "{}");
  const s = stubExec([["verify-blob --key", ok("Verified OK")]]);
  try {
    const h = harness();
    await model.methods.verifyBlob.execute(
      VerifyBlobArgsSchema.parse({ path }),
      h.ctx,
    );
    const [w] = h.written();
    assertEquals(w.spec, "blobVerification");
    assertEquals([w.data.verified, w.data.error], [true, ""]);
    assert(h.logs().some((l) => l.includes("verified")));
    assertNothingLeaked(h);
  } finally {
    s.restore();
  }
});

Deno.test("verifyBlob records a file that does not verify, and fails when cosign cannot run the check", async () => {
  const path = scratchFile("release.json", "{}");
  const s = stubExec([[
    "verify-blob",
    exit("Error: failed to verify signature"),
  ]]);
  try {
    const h = harness();
    await model.methods.verifyBlob.execute(
      VerifyBlobArgsSchema.parse({ path }),
      h.ctx,
    );
    const [w] = h.written();
    assertEquals([w.data.verified, w.data.error], [
      false,
      "failed to verify signature",
    ]);
  } finally {
    s.restore();
  }
  const f = stubExec([[
    "verify-blob",
    exit("Error: open bundle: no such file"),
  ]]);
  try {
    const h = harness();
    const err = await assertRejects(
      () =>
        model.methods.verifyBlob.execute(
          VerifyBlobArgsSchema.parse({ path }),
          h.ctx,
        ),
      Error,
      "no such file",
    );
    assertEquals(h.written(), []);
    assertNothingLeaked(h, err);
  } finally {
    f.restore();
  }
});
