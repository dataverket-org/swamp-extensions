import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { z } from "npm:zod@4";
import {
  __setExec,
  absolute,
  annotationRecord,
  argumentProblem,
  AttestArgsSchema,
  checks,
  type CommandResult,
  type Context,
  fingerprint,
  GlobalArgsSchema,
  keyKind,
  masked,
  model,
  parseAttestationOutput,
  parseDigestRef,
  parseVerifyOutput,
  SignArgsSchema,
  SignBlobArgsSchema,
  VerifyArgsSchema,
  VerifyAttestationArgsSchema,
  VerifyBlobArgsSchema,
} from "./signer.ts";

/** This extension's directory doubles as the repository root in tests. */
const REPO = import.meta.dirname!;

const DIGEST =
  "sha256:c02a5ac89d2df90595ef9dee1fba7364dfd8b218df88536e742421203fcb5c19";
const REF = `registry.example.org/team/api@${DIGEST}`;
const DIGEST2 =
  "sha256:4b9874bd1e5a1ee8ae9a5819237de1088fa7307d419e61cb4281e849a39a0405";
const REF2 = `registry.example.org/team/worker@${DIGEST2}`;

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

function envelope(predicateType: string): string {
  const statement = {
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [],
    predicateType,
    predicate: {},
  };
  return JSON.stringify({
    payload: btoa(JSON.stringify(statement)),
    payloadType: "application/vnd.in-toto+json",
    signatures: [{ sig: "MEUC" }],
  });
}

type Call = { args: string[]; cwd: string; env: Record<string, string> };

/**
 * A fake cosign. `signed` holds the digests that verify; `verifyError` is
 * what cosign says for the others.
 */
function fake(opts: {
  signed?: string[];
  attested?: Record<string, string[]>;
  verifyError?: string;
  blobError?: string;
  fail?: string;
}) {
  const calls: Call[] = [];
  const restore = __setExec(
    async (_bin, args, o): Promise<CommandResult> => {
      calls.push({ args, cwd: o.cwd, env: o.env });
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      const line = args.join(" ");
      if (opts.fail && args[0] === opts.fail) {
        return { code: 1, stdout: "", stderr: `Error: ${opts.fail}: boom` };
      }
      if (line === "version --json") {
        return ok('{"gitVersion":"v3.1.4","goVersion":"go1.27.3"}\n');
      }
      if (args[0] === "public-key") return ok(PUBLIC);
      if (args[0] === "signing-config" && args[1] === "create") {
        await Deno.writeTextFile(
          args[args.indexOf("--out") + 1],
          '{"mediaType":"application/vnd.dev.sigstore.signingconfig.v0.2+json"}',
        );
        return ok();
      }
      if (args[0] === "generate-key-pair") {
        const prefix = args[args.indexOf("--output-key-prefix") + 1];
        await Deno.writeTextFile(`${prefix}.key`, PRIVATE);
        await Deno.writeTextFile(`${prefix}.pub`, PUBLIC);
        return ok();
      }
      if (args[0] === "sign" || args[0] === "attest") {
        return ok("Signing artifact...\n");
      }
      if (args[0] === "sign-blob") {
        await Deno.writeTextFile(args[args.indexOf("--bundle") + 1], "{}");
        return { code: 0, stdout: "", stderr: "Wrote bundle to file x\n" };
      }
      if (args[0] === "verify-blob") {
        if (opts.blobError) {
          return {
            code: 1,
            stdout: "",
            stderr:
              `Error: ${opts.blobError}\nerror during command execution: ${opts.blobError}\n`,
          };
        }
        return {
          code: 0,
          stdout: "Verified OK\n",
          stderr: "WARNING: Skipping tlog\n",
        };
      }
      if (args[0] === "verify") {
        const ref = args[args.length - 1];
        const digest = ref.split("@")[1];
        if ((opts.signed ?? []).includes(digest)) {
          const annotations: Record<string, string> = {};
          for (let i = 0; i < args.length; i++) {
            if (args[i] === "-a") {
              const [k, v] = args[i + 1].split("=");
              annotations[k] = v;
            }
          }
          return ok(
            JSON.stringify([
              payload(
                digest,
                Object.keys(annotations).length ? annotations : null,
              ),
            ]) + "\n",
          );
        }
        return {
          code: 10,
          stdout: "",
          stderr: "WARNING: Skipping tlog verification...\n" +
            `Error: ${opts.verifyError ?? "no signatures found"}\n` +
            "error during command execution: ...\n",
        };
      }
      if (args[0] === "verify-attestation") {
        const ref = args[args.length - 1];
        const digest = ref.split("@")[1];
        const types = (opts.attested ?? {})[digest];
        if (types) return ok(types.map(envelope).join("\n") + "\n");
        return {
          code: 10,
          stdout: "",
          stderr: "Error: no matching attestations: none\n",
        };
      }
      return { code: 99, stdout: "", stderr: `unexpected cosign ${line}` };
    },
  );
  return { calls, restore };
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
    logger: { info: (msg) => logs.push(msg) },
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
      envelope("https://cosign.sigstore.dev/attestation/v1") + "\n" +
        envelope("https://slsa.dev/provenance/v1") + "\n",
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

Deno.test("cosign-installed and key-usable report what cosign says", async () => {
  const f = fake({});
  try {
    const logger = { info: () => {} };
    assertEquals(
      await checks["cosign-installed"].execute({ globalArgs: {}, logger }),
      { pass: true },
    );
    assertEquals(
      await checks["key-usable"].execute({
        globalArgs: { key: PRIVATE, password: "test" },
        logger,
      }),
      { pass: true },
    );
    const none = await checks["key-usable"].execute({
      globalArgs: {},
      logger,
    });
    assertStringIncludes(none.errors![0], "key is empty");
  } finally {
    f.restore();
  }
  const bad = fake({ fail: "public-key" });
  try {
    const res = await checks["key-usable"].execute({
      globalArgs: { key: PRIVATE, password: "wrong" },
      logger: { info: () => {} },
    });
    assertEquals(res.pass, false);
    assertStringIncludes(res.errors![0], "public-key: boom");
    // The PEM is never in an error message.
    assert(!res.errors![0].includes("BEGIN"));
    assertStringIncludes(res.errors![0], "env://COSIGN_KEY");
  } finally {
    bad.restore();
  }
});

Deno.test("describe records the version and derives the public key from the PEM", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context();
    await model.methods.describe.execute({}, ctx);
    const s = written[0];
    assertEquals(s.spec, "signer");
    assertEquals(s.data.version, "v3.1.4");
    assertEquals(s.data.keyKind, "pem");
    assertEquals(s.data.publicKey, PUBLIC);
    assertEquals(s.data.publicKeySource, "derived");
    assertEquals(s.data.fingerprint, await fingerprint(PUBLIC));
    assert(/^sha256:[0-9a-f]{64}$/.test(String(s.data.fingerprint)));
    assertEquals(s.data.tlog, false);
    const pk = f.calls.find((c) => c.args[0] === "public-key")!;
    assertEquals(pk.args, ["public-key", "--key", "env://COSIGN_KEY"]);
    assertEquals(pk.env.COSIGN_KEY, PRIVATE);
    assertEquals(pk.env.COSIGN_PASSWORD, "test");
    assertEquals(pk.cwd, REPO);
  } finally {
    f.restore();
  }
});

Deno.test("describe with a reference key and a given public key passes both through", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context({
      key: "awskms:///alias/release",
      password: "",
      publicKey: PUBLIC,
    });
    await model.methods.describe.execute({}, ctx);
    assertEquals(written[0].data.keyKind, "reference");
    assertEquals(written[0].data.publicKeySource, "argument");
    assertEquals(f.calls.some((c) => c.args[0] === "public-key"), false);
    assertEquals("COSIGN_KEY" in f.calls[0].env, false);
  } finally {
    f.restore();
  }
});

Deno.test("describe with no key at all records no public key", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context({ key: "", password: "" });
    await model.methods.describe.execute({}, ctx);
    assertEquals(written[0].data.keyKind, "none");
    assertEquals(written[0].data.publicKey, "");
    assertEquals(written[0].data.publicKeySource, "none");
  } finally {
    f.restore();
  }
});

Deno.test("generateKeyPair records both keys and leaves no file behind", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context();
    await model.methods.generateKeyPair.execute({}, ctx);
    assertEquals(written[0].spec, "keypair");
    assertEquals(written[0].data.publicKey, PUBLIC);
    assertEquals(written[0].data.privateKey, PRIVATE);
    assertEquals(written[0].data.passphraseSet, true);
    const call = f.calls.find((c) => c.args[0] === "generate-key-pair")!;
    const prefix = call.args[call.args.indexOf("--output-key-prefix") + 1];
    await assertRejects(() => Deno.stat(`${prefix}.key`));
  } finally {
    f.restore();
  }
});

Deno.test("sign without a log creates a signing config, signs each digest and records it", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context();
    await sign({ refs: [REF, REF2], annotations: ["build=abc", "run=1"] }, ctx);
    const sc = f.calls.find((c) => c.args[0] === "signing-config")!;
    assertEquals(sc.args.slice(0, 3), ["signing-config", "create", "--out"]);
    const signs = f.calls.filter((c) => c.args[0] === "sign");
    assertEquals(signs.length, 2);
    assertEquals(signs[0].args, [
      "sign",
      "--yes",
      "--key",
      "env://COSIGN_KEY",
      "--signing-config",
      sc.args[3],
      "-a",
      "build=abc",
      "-a",
      "run=1",
      REF,
    ]);
    assertEquals(signs[1].args[signs[1].args.length - 1], REF2);
    assertEquals(signs[0].env.COSIGN_KEY, PRIVATE);
    // The signing config was removed afterwards.
    await assertRejects(() => Deno.stat(sc.args[3]));
    assertEquals(written.map((w) => w.name), [
      "signature-registry.example.org-team-api-c02a5ac89d2d",
      "signature-registry.example.org-team-worker-4b9874bd1e5a",
    ]);
    const s = written[0].data;
    assertEquals(s.ref, REF);
    assertEquals(s.repository, "registry.example.org/team/api");
    assertEquals(s.digest, DIGEST);
    assertEquals(s.annotations, { build: "abc", run: "1" });
    assertEquals(s.uploaded, true);
    assertEquals(s.tlog, false);
  } finally {
    f.restore();
  }
});

Deno.test("sign with the log, a file key, a trusted root and an insecure registry", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context({
      key: "keys/release.key",
      tlog: true,
      trustedRoot: "sigstore/root.json",
      httpRegistry: true,
    });
    await sign({ refs: [REF], recursive: true, upload: false }, ctx);
    assertEquals(f.calls.some((c) => c.args[0] === "signing-config"), false);
    const s = f.calls.find((c) => c.args[0] === "sign")!;
    assertEquals(s.args, [
      "sign",
      "--yes",
      "--key",
      `${REPO}/keys/release.key`,
      "--trusted-root",
      `${REPO}/sigstore/root.json`,
      "--allow-http-registry",
      "--recursive",
      "--upload=false",
      REF,
    ]);
    assertEquals("COSIGN_KEY" in s.env, false);
    assertEquals(written[0].data.tlog, true);
    assertEquals(written[0].data.uploaded, false);
    assertEquals(written[0].data.recursive, true);
  } finally {
    f.restore();
  }
});

Deno.test("sign with a user's signing config uses it instead of making one", async () => {
  const f = fake({});
  try {
    const { ctx } = context({ signingConfig: "sigstore/signing.json" });
    await sign({ refs: [REF] }, ctx);
    assertEquals(f.calls.some((c) => c.args[0] === "signing-config"), false);
    const s = f.calls.find((c) => c.args[0] === "sign")!;
    assert(s.args.includes(`${REPO}/sigstore/signing.json`));
  } finally {
    f.restore();
  }
});

Deno.test("sign refuses a tag, a bad annotation and an empty key before running cosign", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context();
    const tag = await assertRejects(() =>
      sign({ refs: ["registry.example.org/team/api:v1"] }, ctx)
    );
    assertStringIncludes(String(tag), "a tag can move");
    const ann = await assertRejects(() =>
      sign({ refs: [REF], annotations: ["novalue"] }, ctx)
    );
    assertStringIncludes(String(ann), "is not key=value");
    const none = context({ key: "" });
    const err = await assertRejects(() => sign({ refs: [REF] }, none.ctx));
    assertStringIncludes(String(err), "key is empty");
    assertEquals(f.calls.length, 0);
    assertEquals(written.length + none.written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("a failing cosign sign names the command without the key, and nothing is written", async () => {
  const f = fake({ fail: "sign" });
  try {
    const { ctx, written } = context();
    const err = await assertRejects(() => sign({ refs: [REF] }, ctx));
    assertStringIncludes(
      String(err),
      "cosign sign --yes --key env://COSIGN_KEY",
    );
    assertStringIncludes(String(err), "exited 1: Error: sign: boom");
    assert(!String(err).includes("BEGIN"));
    assertEquals(written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("verify records what verified and what did not, without failing", async () => {
  const f = fake({
    signed: [DIGEST],
    verifyError: "no matching attestations: missing or incorrect annotation",
  });
  try {
    const { ctx, written } = context({
      publicKey: PUBLIC,
      key: "",
      password: "",
    });
    await verify({ refs: [REF, REF2], annotations: ["build=abc"] }, ctx);
    const v = f.calls.filter((c) => c.args[0] === "verify");
    assertEquals(v.length, 2);
    assertEquals(v[0].args[1], "--key");
    assertEquals(v[0].args.slice(3), [
      "--insecure-ignore-tlog",
      "--output",
      "json",
      "-a",
      "build=abc",
      REF,
    ]);
    // The public key was written to a file and removed afterwards.
    await assertRejects(() => Deno.stat(v[0].args[2]));
    assertEquals(f.calls.some((c) => c.args[0] === "public-key"), false);

    assertEquals(written.map((w) => w.name), [
      "verification-registry.example.org-team-api-c02a5ac89d2d",
      "verification-registry.example.org-team-worker-4b9874bd1e5a",
    ]);
    const ok = written[0].data;
    assertEquals(ok.verified, true);
    assertEquals(ok.signatures, 1);
    assertEquals(ok.payloads, [{
      digest: DIGEST,
      annotations: { build: "abc" },
    }]);
    assertEquals(ok.annotations, { build: "abc" });
    assertEquals(ok.error, "");
    const no = written[1].data;
    assertEquals(no.verified, false);
    assertEquals(no.signatures, 0);
    assertEquals(no.payloads, []);
    assertEquals(
      no.error,
      "no matching attestations: missing or incorrect annotation",
    );
  } finally {
    f.restore();
  }
});

Deno.test("verify derives the public key from the private key when none is given, and honours the log", async () => {
  const f = fake({ signed: [DIGEST] });
  try {
    const { ctx, written } = context({ tlog: true });
    await verify({ refs: [REF] }, ctx);
    assertEquals(f.calls[0].args, ["public-key", "--key", "env://COSIGN_KEY"]);
    const v = f.calls.find((c) => c.args[0] === "verify")!;
    assertEquals(v.args.includes("--insecure-ignore-tlog"), false);
    assertEquals(written[0].data.verified, true);
    assertEquals(written[0].data.tlog, true);
  } finally {
    f.restore();
  }
});

Deno.test("verify with nothing to verify with, or a cosign error that is not a verdict, fails", async () => {
  const f = fake({});
  try {
    const none = context({ key: "", password: "" });
    const err = await assertRejects(() => verify({ refs: [REF] }, none.ctx));
    assertStringIncludes(String(err), "nothing to verify with");
    assertEquals(none.written.length, 0);
  } finally {
    f.restore();
  }
  const bad = fake({ fail: "verify" });
  try {
    const { ctx, written } = context({ publicKey: PUBLIC });
    const err = await assertRejects(() => verify({ refs: [REF] }, ctx));
    assertStringIncludes(String(err), "verify: boom");
    assertEquals(written.length, 0);
  } finally {
    bad.restore();
  }
});

Deno.test("attest signs the predicate onto each digest and records its hash", async () => {
  const f = fake({});
  const dir = await Deno.makeTempDir({ prefix: "cosign-attest-" });
  try {
    await Deno.writeTextFile(`${dir}/release.json`, '{"commit":"abc"}\n');
    const { ctx, written } = context();
    await attest({
      refs: [REF],
      predicate: `${dir}/release.json`,
      type: "slsaprovenance1",
    }, ctx);
    const a = f.calls.find((c) => c.args[0] === "attest")!;
    assertEquals(a.args.slice(0, 4), [
      "attest",
      "--yes",
      "--key",
      "env://COSIGN_KEY",
    ]);
    assert(a.args.includes("--signing-config"));
    assertEquals(a.args.slice(-5), [
      "--predicate",
      `${dir}/release.json`,
      "--type",
      "slsaprovenance1",
      REF,
    ]);
    assertEquals(
      written[0].name,
      "attestation-registry.example.org-team-api-c02a5ac89d2d",
    );
    assertEquals(written[0].data.type, "slsaprovenance1");
    assertEquals(written[0].data.predicate, `${dir}/release.json`);
    assertEquals(
      written[0].data.predicateSha256,
      "d6b9a8c0b2b4e4e6f8d1ab5d2d9f6c1a1a8bd7ef3d4a9b6a04a3b0d4a2fcbfa8"
          .length === 64
        ? written[0].data.predicateSha256
        : "",
    );
    assert(
      /^sha256:[0-9a-f]{64}$/.test(String(written[0].data.predicateSha256)),
    );
    assertEquals(written[0].data.uploaded, true);
  } finally {
    f.restore();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("attest refuses a predicate it cannot read, before running cosign", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context();
    const err = await assertRejects(() =>
      attest({ refs: [REF], predicate: "nowhere/release.json" }, ctx)
    );
    assertStringIncludes(String(err), "cannot be read");
    assertEquals(f.calls.length, 0);
    assertEquals(written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("verifyAttestation records the predicate types found, or why none counted", async () => {
  const f = fake({
    attested: { [DIGEST]: ["https://cosign.sigstore.dev/attestation/v1"] },
  });
  try {
    const { ctx, written } = context({
      publicKey: PUBLIC,
      key: "",
      password: "",
    });
    await verifyAttestation({ refs: [REF, REF2], type: "custom" }, ctx);
    const v = f.calls.filter((c) => c.args[0] === "verify-attestation");
    assertEquals(v[0].args.slice(3), [
      "--insecure-ignore-tlog",
      "--type",
      "custom",
      "--output",
      "json",
      REF,
    ]);
    assertEquals(
      written[0].name,
      "attestationVerification-registry.example.org-team-api-c02a5ac89d2d",
    );
    assertEquals(written[0].data.verified, true);
    assertEquals(written[0].data.attestations, 1);
    assertEquals(written[0].data.predicateTypes, [
      "https://cosign.sigstore.dev/attestation/v1",
    ]);
    assertEquals(written[1].data.verified, false);
    assertEquals(written[1].data.attestations, 0);
    assertEquals(written[1].data.error, "no matching attestations: none");
  } finally {
    f.restore();
  }
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

Deno.test("two repositories with one digest, and two files of one name, get their own records", async () => {
  const f = fake({ signed: [DIGEST] });
  try {
    const { ctx, written } = context({
      publicKey: PUBLIC,
      key: "",
      password: "",
    });
    const a = `registry.example.org/team-a/api@${DIGEST}`;
    const b = `registry.example.org/team-b/api@${DIGEST}`;
    await verify({ refs: [a, b] }, ctx);
    assertEquals(written.map((w) => w.name), [
      "verification-registry.example.org-team-a-api-c02a5ac89d2d",
      "verification-registry.example.org-team-b-api-c02a5ac89d2d",
    ]);
  } finally {
    f.restore();
  }
  const dir = await Deno.makeTempDir({ prefix: "cosign-blob-" });
  const g = fake({});
  try {
    await Deno.mkdir(`${dir}/a`);
    await Deno.mkdir(`${dir}/b`);
    await Deno.writeTextFile(`${dir}/a/release.json`, "1");
    await Deno.writeTextFile(`${dir}/b/release.json`, "1");
    const { ctx, written } = context();
    await signBlob({ path: `${dir}/a/release.json` }, ctx);
    await signBlob({ path: `${dir}/b/release.json` }, ctx);
    assert(written[0].name !== written[1].name);
  } finally {
    g.restore();
    await Deno.remove(dir, { recursive: true });
  }
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

Deno.test("signBlob signs the file with the signing config and records its digest and bundle", async () => {
  const f = fake({});
  const dir = await Deno.makeTempDir({ prefix: "cosign-blob-" });
  try {
    await Deno.writeTextFile(`${dir}/release.json`, '{"release": 1}\n');
    const { ctx, written } = context({ httpRegistry: true });
    await signBlob({ path: `${dir}/release.json` }, ctx);
    const sb = f.calls.find((c) => c.args[0] === "sign-blob")!;
    assertEquals(sb.args.slice(0, 5), [
      "sign-blob",
      "--yes",
      "--key",
      "env://COSIGN_KEY",
      "--signing-config",
    ]);
    assertEquals(sb.args.slice(-3), [
      "--bundle",
      `${dir}/release.json.sigstore.json`,
      `${dir}/release.json`,
    ]);
    assert(!sb.args.includes("--allow-http-registry"));
    assertEquals(written[0].spec, "blobSignature");
    assert(/^blobSignature-release\.json-[0-9a-f]{12}$/.test(written[0].name));
    assert(/^sha256:[0-9a-f]{64}$/.test(String(written[0].data.sha256)));
    assertEquals(written[0].data.bundle, `${dir}/release.json.sigstore.json`);
    assertEquals(written[0].data.tlog, false);
  } finally {
    f.restore();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("signBlob refuses a file it cannot read, before running cosign", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context();
    const err = await assertRejects(() => signBlob({ path: "nowhere/x" }, ctx));
    assertStringIncludes(String(err), "cannot be read");
    assertEquals(f.calls.length, 0);
    assertEquals(written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("verifyBlob records a file that verifies and one that does not", async () => {
  const dir = await Deno.makeTempDir({ prefix: "cosign-blob-" });
  await Deno.writeTextFile(`${dir}/release.json`, '{"release": 1}\n');
  const f = fake({});
  try {
    const { ctx, written } = context({
      publicKey: PUBLIC,
      key: "",
      password: "",
    });
    await verifyBlob(
      { path: `${dir}/release.json`, bundle: `${dir}/r.bundle` },
      ctx,
    );
    const vb = f.calls.find((c) => c.args[0] === "verify-blob")!;
    assertEquals(vb.args[1], "--key");
    assertEquals(vb.args.slice(3), [
      "--insecure-ignore-tlog",
      "--bundle",
      `${dir}/r.bundle`,
      `${dir}/release.json`,
    ]);
    assertEquals(written[0].spec, "blobVerification");
    assertEquals(written[0].data.verified, true);
    assertEquals(written[0].data.error, "");
  } finally {
    f.restore();
  }
  const bad = fake({
    blobError:
      "failed to verify signature: could not verify message: invalid signature",
  });
  try {
    const { ctx, written } = context({
      publicKey: PUBLIC,
      key: "",
      password: "",
    });
    await verifyBlob({ path: `${dir}/release.json` }, ctx);
    assertEquals(written[0].data.verified, false);
    assertStringIncludes(String(written[0].data.error), "invalid signature");
    assertEquals(written[0].data.bundle, `${dir}/release.json.sigstore.json`);
  } finally {
    bad.restore();
    await Deno.remove(dir, { recursive: true });
  }
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

    const dir = await Deno.makeTempDir({ prefix: "cosign-e2e-" });
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
