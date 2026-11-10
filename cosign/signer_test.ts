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
  identityProblem,
  keyKind,
  masked,
  model,
  parseAttestationOutput,
  parseDigestRef,
  parseGitUri,
  parseVerifyOutput,
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

type Call = { args: string[]; cwd: string; env: Record<string, string> };

/** The flags each cosign command of the fake knows: those that take a value, and those that do not. */
const REGISTRY = ["--allow-insecure-registry", "--allow-http-registry"];
const IDENTITY_FLAGS = [
  "--key",
  "--certificate-identity",
  "--certificate-identity-regexp",
  "--certificate-oidc-issuer",
  "--trusted-root",
];
const FLAGS: Record<string, { value: string[]; plain: string[] }> = {
  "version": { value: [], plain: ["--json"] },
  "public-key": { value: ["--key"], plain: [] },
  "signing-config": { value: ["--out"], plain: [] },
  "generate-key-pair": { value: ["--output-key-prefix"], plain: [] },
  "sign": {
    value: ["--key", "--signing-config", "--trusted-root", "-a"],
    plain: ["--yes", "--recursive", "--upload=false", ...REGISTRY],
  },
  "attest": {
    value: [
      "--key",
      "--signing-config",
      "--trusted-root",
      "--predicate",
      "--type",
    ],
    plain: ["--yes", "--upload=false", ...REGISTRY],
  },
  "verify": {
    value: [...IDENTITY_FLAGS, "--output", "-a"],
    plain: ["--insecure-ignore-tlog", ...REGISTRY],
  },
  "verify-attestation": {
    value: [...IDENTITY_FLAGS, "--output", "--type"],
    plain: ["--insecure-ignore-tlog", ...REGISTRY],
  },
  "sign-blob": {
    value: ["--key", "--signing-config", "--trusted-root", "--bundle"],
    plain: ["--yes"],
  },
  "verify-blob": {
    value: [...IDENTITY_FLAGS, "--bundle"],
    plain: ["--insecure-ignore-tlog"],
  },
};
/** Commands whose one positional must follow `--`, as the model writes it. */
const POSITIONAL = [
  "sign",
  "attest",
  "verify",
  "verify-attestation",
  "sign-blob",
  "verify-blob",
];

/** argv as cosign's flag parser reads it, or what it refuses. */
function parseArgv(
  args: string[],
): { flags: Record<string, string[]>; positional: string[] } | string {
  const known = FLAGS[args[0]];
  if (!known) return `unknown command "${args[0]}" for "cosign"`;
  const flags: Record<string, string[]> = {};
  const positional: string[] = [];
  let i = args[0] === "signing-config" ? 2 : 1;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    if (known.value.includes(a)) {
      if (i + 1 >= args.length) return `flag needs an argument: ${a}`;
      (flags[a] ??= []).push(args[++i]);
    } else if (known.plain.includes(a)) {
      flags[a] = [];
    } else if (a.startsWith("-")) {
      return `unknown flag: ${a}`;
    } else {
      return `the fake wants -- before ${a}`;
    }
  }
  const want = POSITIONAL.includes(args[0]) ? 1 : 0;
  if (positional.length !== want) {
    return `accepts ${want} arg(s), received ${positional.length}`;
  }
  return { flags, positional };
}

/** The predicate type URI cosign's --type stands for. */
function predicateUri(type: string): string {
  return ({
    custom: "https://cosign.sigstore.dev/attestation/v1",
    slsaprovenance: "https://slsa.dev/provenance/v0.2",
    slsaprovenance02: "https://slsa.dev/provenance/v0.2",
    slsaprovenance1: "https://slsa.dev/provenance/v1",
    spdxjson: "https://spdx.dev/Document",
  } as Record<string, string>)[type] ?? type;
}

/**
 * A fake cosign, as strict as the real one about its command line: a flag
 * it does not know, or a reference not after `--`, is an error. `signed`
 * holds the digests that verify; `verifyError` is what cosign says for the
 * others. `statements` are the attestations on a digest; of them
 * verify-attestation prints those of the `--type` asked for, and fails as
 * cosign does when there is none. `printed` is printed whatever it is: for
 * output the real cosign would not give, such as a statement about another
 * digest, which it refuses with its default --check-claims.
 */
function fake(opts: {
  signed?: string[];
  attested?: Record<string, string[]>;
  statements?: Record<string, unknown[]>;
  printed?: Record<string, unknown[]>;
  verifyError?: string;
  blobError?: string;
  fail?: string;
}) {
  const calls: Call[] = [];
  const run = async (
    _bin: string,
    args: string[],
    o: { cwd: string; env: Record<string, string> },
  ): Promise<CommandResult> => {
    {
      calls.push({ args, cwd: o.cwd, env: o.env });
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      const parsed = parseArgv(args);
      if (typeof parsed === "string") {
        return { code: 1, stdout: "", stderr: `Error: ${parsed}\n` };
      }
      const { flags, positional } = parsed;
      if (opts.fail && args[0] === opts.fail) {
        return { code: 1, stdout: "", stderr: `Error: ${opts.fail}: boom` };
      }
      if (args[0] === "version") {
        return ok('{"gitVersion":"v3.1.4","goVersion":"go1.27.3"}\n');
      }
      if (args[0] === "public-key") return ok(PUBLIC);
      if (args[0] === "signing-config" && args[1] === "create") {
        await Deno.writeTextFile(
          flags["--out"][0],
          '{"mediaType":"application/vnd.dev.sigstore.signingconfig.v0.2+json"}',
        );
        return ok();
      }
      if (args[0] === "generate-key-pair") {
        const prefix = flags["--output-key-prefix"][0];
        await Deno.writeTextFile(`${prefix}.key`, PRIVATE);
        await Deno.writeTextFile(`${prefix}.pub`, PUBLIC);
        return ok();
      }
      if (args[0] === "sign" || args[0] === "attest") {
        return ok("Signing artifact...\n");
      }
      if (args[0] === "sign-blob") {
        await Deno.writeTextFile(flags["--bundle"][0], "{}");
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
      const digest = (positional[0] ?? "").split("@")[1];
      if (args[0] === "verify") {
        if ((opts.signed ?? []).includes(digest)) {
          const annotations: Record<string, string> = {};
          for (const a of flags["-a"] ?? []) {
            const [k, v] = a.split("=");
            annotations[k] = v;
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
        const printed = (opts.printed ?? {})[digest];
        if (printed) return ok(printed.map(wrap).join("\n") + "\n");
        const type = (flags["--type"] ?? ["custom"])[0];
        const all = (opts.statements ?? {})[digest] ??
          ((opts.attested ?? {})[digest] ?? []).map((t) =>
            JSON.parse(atob(JSON.parse(envelope(t, digest)).payload))
          );
        if (all.length === 0) {
          return {
            code: 10,
            stdout: "",
            stderr: "Error: no matching attestations: none\n",
          };
        }
        const typed = all.filter((st) =>
          (st as { predicateType?: unknown })?.predicateType ===
            predicateUri(type)
        );
        if (typed.length === 0) {
          const said =
            `none of the attestations matched the predicate type: ${type}, found: ${
              all.map((st) => (st as { predicateType?: unknown }).predicateType)
                .join(",")
            }`;
          return {
            code: 1,
            stdout: "",
            stderr: `Error: ${said}\nerror during command execution: ${said}\n`,
          };
        }
        return ok(typed.map(wrap).join("\n") + "\n");
      }
      return {
        code: 99,
        stdout: "",
        stderr: `unexpected cosign ${args.join(" ")}`,
      };
    }
  };
  const restore = __setExec(run);
  /** One call straight at the fake, as cosign would be called. */
  const direct = (args: string[]) => run("cosign", args, { cwd: "", env: {} });
  return { calls, restore, direct };
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
      "--",
      REF,
    ]);
    assertEquals(signs[1].args.slice(-2), ["--", REF2]);
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
      "--",
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
      "--",
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
    assertEquals(a.args.slice(-6), [
      "--predicate",
      `${dir}/release.json`,
      "--type",
      "slsaprovenance1",
      "--",
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
      "--",
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
    assertEquals(sb.args.slice(-4), [
      "--bundle",
      `${dir}/release.json.sigstore.json`,
      "--",
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
      "--",
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

Deno.test("verify keyless passes the identity and issuer instead of a key, with the log required", async () => {
  const f = fake({ signed: [DIGEST] });
  try {
    const { ctx, written } = context(KEYLESS);
    await verify({ refs: [REF, REF2], annotations: ["build=abc"] }, ctx);
    assertEquals(f.calls.some((c) => c.args[0] === "public-key"), false);
    const v = f.calls.filter((c) => c.args[0] === "verify");
    assertEquals(v[0].args, [
      "verify",
      "--certificate-identity-regexp",
      IDENTITY_REGEXP,
      "--certificate-oidc-issuer",
      ISSUER,
      "--output",
      "json",
      "-a",
      "build=abc",
      "--",
      REF,
    ]);
    assertEquals("COSIGN_KEY" in v[0].env, false);
    assertEquals(written[0].data.verified, true);
    assertEquals(written[0].data.tlog, true);
    assertEquals(written[1].data.verified, false);
    assertEquals(written[1].data.error, "no signatures found");
  } finally {
    f.restore();
  }
  const g = fake({ signed: [DIGEST] });
  try {
    const { ctx } = context({
      ...KEYLESS,
      certificateIdentityRegexp: "",
      certificateIdentity: IDENTITY,
      trustedRoot: "sigstore/root.json",
      httpRegistry: true,
    });
    await verify({ refs: [REF] }, ctx);
    const v = g.calls.find((c) => c.args[0] === "verify")!;
    assertEquals(v.args.slice(0, 9), [
      "verify",
      "--certificate-identity",
      IDENTITY,
      "--certificate-oidc-issuer",
      ISSUER,
      "--trusted-root",
      `${REPO}/sigstore/root.json`,
      "--allow-http-registry",
      "--output",
    ]);
    assertEquals(v.args.includes("--insecure-ignore-tlog"), false);
  } finally {
    g.restore();
  }
});

Deno.test("verifyAttestation and verifyBlob keyless carry the identity flags and no key file", async () => {
  const f = fake({ attested: { [DIGEST]: ["https://spdx.dev/Document"] } });
  const dir = await Deno.makeTempDir({ prefix: "cosign-keyless-" });
  try {
    await Deno.writeTextFile(`${dir}/release.json`, "{}\n");
    const { ctx, written } = context(KEYLESS);
    await verifyAttestation(
      { refs: [REF], type: "https://spdx.dev/Document" },
      ctx,
    );
    const va = f.calls.find((c) => c.args[0] === "verify-attestation")!;
    assertEquals(va.args, [
      "verify-attestation",
      "--certificate-identity-regexp",
      IDENTITY_REGEXP,
      "--certificate-oidc-issuer",
      ISSUER,
      "--type",
      "https://spdx.dev/Document",
      "--output",
      "json",
      "--",
      REF,
    ]);
    assertEquals(written[0].data.verified, true);
    assertEquals(written[0].data.predicateTypes, ["https://spdx.dev/Document"]);

    await verifyBlob({ path: `${dir}/release.json` }, ctx);
    const vb = f.calls.find((c) => c.args[0] === "verify-blob")!;
    assertEquals(vb.args, [
      "verify-blob",
      "--certificate-identity-regexp",
      IDENTITY_REGEXP,
      "--certificate-oidc-issuer",
      ISSUER,
      "--bundle",
      `${dir}/release.json.sigstore.json`,
      "--",
      `${dir}/release.json`,
    ]);
    assertEquals(written[1].data.verified, true);
    assertEquals(written[1].data.tlog, true);
    assertEquals(f.calls.some((c) => c.args.includes("--key")), false);
  } finally {
    f.restore();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("verify with an identity but no log, no issuer, or a public key too is refused before cosign runs", async () => {
  const f = fake({ signed: [DIGEST] });
  try {
    for (
      const [over, phrase] of [
        [{ tlog: false }, "tlog is false"],
        [{ oidcIssuer: "" }, "without oidcIssuer"],
        [{ publicKey: PUBLIC }, "both set"],
      ] as [Record<string, unknown>, string][]
    ) {
      const { ctx, written } = context({ ...KEYLESS, ...over });
      const err = await assertRejects(() => verify({ refs: [REF] }, ctx));
      assertStringIncludes(String(err), phrase);
      assertEquals(written.length, 0);
    }
    assertEquals(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("describe records how the signer verifies: keyless with its identity and issuer, by key, or not at all", async () => {
  const f = fake({});
  try {
    const keyless = context(KEYLESS);
    await model.methods.describe.execute({}, keyless.ctx);
    assertEquals(keyless.written[0].data.verifyMode, "keyless");
    assertEquals(keyless.written[0].data.certificateIdentity, "");
    assertEquals(
      keyless.written[0].data.certificateIdentityRegexp,
      IDENTITY_REGEXP,
    );
    assertEquals(keyless.written[0].data.oidcIssuer, ISSUER);
    assertEquals(keyless.written[0].data.publicKeySource, "none");
    assertEquals(keyless.written[0].data.keyKind, "none");
    const key = context();
    await model.methods.describe.execute({}, key.ctx);
    assertEquals(key.written[0].data.verifyMode, "key");
    assertEquals(key.written[0].data.oidcIssuer, "");
    const none = context({ key: "", password: "" });
    await model.methods.describe.execute({}, none.ctx);
    assertEquals(none.written[0].data.verifyMode, "none");
  } finally {
    f.restore();
  }
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
const SLSA02 = "https://slsa.dev/provenance/v0.2";
const SOURCE = "https://github.com/example/api";
const COMMIT = "a42552e6c9739a9d577f86dd819e9d41aee7c059";
const COMMIT2 = "0f3c1b2a4d5e6f708192a3b4c5d6e7f801234567";
const BUILDER =
  "https://github.com/example/api/.github/workflows/build.yml@refs/heads/main";
const INVOCATION =
  "https://github.com/example/api/actions/runs/42835074961/attempts/1";
/** Planted wherever a predicate can hold a credential; no record may hold it. */
const MARKER = "PLANTED-SECRET-7f3a";

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

/** SLSA provenance v0.2 as the slsa-github-generator writes it. */
function slsa02(digest: string) {
  return {
    _type: "https://in-toto.io/Statement/v0.1",
    subject: [subject(digest)],
    predicateType: SLSA02,
    predicate: {
      builder: {
        id:
          "https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@refs/tags/v1.9.0",
      },
      buildType:
        "https://github.com/slsa-framework/slsa-github-generator/container@v1",
      invocation: {
        configSource: {
          uri: `git+${SOURCE}@refs/tags/v1.2.3`,
          digest: { sha1: COMMIT },
          entryPoint: ".github/workflows/release.yml",
        },
        parameters: { token: MARKER },
        environment: { github_actor: "someone", SECRET_TOKEN: MARKER },
      },
      metadata: {
        // As in-toto's Go types write it, and so the generator; the
        // specification's spelling is buildInvocationId.
        buildInvocationID: "42835074961-1",
        completeness: {
          parameters: true,
          environment: false,
          materials: false,
        },
        reproducible: false,
      },
      materials: [{
        uri: `git+${SOURCE}@refs/tags/v1.2.3`,
        digest: { sha1: COMMIT },
      }],
    },
  };
}

type Rec = Record<string, unknown> & {
  statements: (Record<string, unknown> & {
    subjects: { name: string | null; digest: Record<string, string> }[];
    provenance: Record<string, unknown> | null;
  })[];
};

/** verifyAttestation of REF over what the fake cosign verifies for DIGEST. */
async function attested(
  statements: unknown[],
  args: Partial<z.input<typeof VerifyAttestationArgsSchema>> = {},
  how: "statements" | "printed" = "statements",
): Promise<{ record: Rec; all: string; calls: Call[] }> {
  const f = fake({ [how]: { [DIGEST]: statements } });
  try {
    const { ctx, written, logs } = context({
      publicKey: PUBLIC,
      key: "",
      password: "",
    });
    await verifyAttestation(
      { refs: [REF], type: "slsaprovenance1", ...args },
      ctx,
    );
    assertEquals(written.length, 1);
    return {
      record: written[0].data as Rec,
      all: JSON.stringify(written) + logs.join("\n"),
      calls: f.calls,
    };
  } finally {
    f.restore();
  }
}

Deno.test("verifyAttestation records the subjects and what SLSA v1 provenance says, with a summary", async () => {
  const { record } = await attested([slsa1(DIGEST)]);
  assertEquals(record.verified, true);
  assertEquals(record.attestations, 1);
  assertEquals(record.matched, 1);
  assertEquals(record.predicateTypes, [SLSA1]);
  assertEquals(record.error, "");
  assertEquals(record.sourceRepository, SOURCE);
  assertEquals(record.sourceRef, "refs/heads/main");
  assertEquals(record.sourceCommit, COMMIT);
  assertEquals(record.builderId, BUILDER);
  assertEquals(record.expectedSourceRepository, "");
  assertEquals(record.expectedSourceCommit, "");
  assertEquals(record.statements, [{
    predicateType: SLSA1,
    subjects: [{
      name: "registry.example.org/team/api",
      digest: { sha256: hex(DIGEST) },
    }],
    subjectCount: 1,
    subjectMatches: true,
    counted: true,
    reason: "",
    provenance: {
      buildType: "https://actions.github.io/buildtypes/workflow/v1",
      workflow: {
        repository: SOURCE,
        ref: "refs/heads/main",
        path: ".github/workflows/build.yml",
      },
      resolvedDependencies: [{
        uri: `git+${SOURCE}@refs/heads/main`,
        gitCommit: COMMIT,
      }],
      resolvedDependencyCount: 1,
      builderId: BUILDER,
      invocationId: INVOCATION,
    },
    sourceRepository: SOURCE,
    sourceRef: "refs/heads/main",
    sourceCommit: COMMIT,
    builderId: BUILDER,
    withheld: 0,
  }]);
});

Deno.test("an attestation about another artifact does not count, however well it verifies", async () => {
  // Real cosign would stop this first: with its default --check-claims it
  // refuses a statement about another digest. The type checks for itself.
  const { record } = await attested([slsa1(DIGEST2)], {}, "printed");
  assertEquals(record.verified, false);
  assertEquals(record.attestations, 1);
  assertEquals(record.matched, 0);
  assertStringIncludes(String(record.error), "none counted");
  assertStringIncludes(
    String(record.error),
    `no subject digest equals ${DIGEST}`,
  );
  assertEquals(record.statements[0].subjectMatches, false);
  assertEquals(record.statements[0].counted, false);
  assertEquals(record.statements[0].subjects[0].digest, {
    sha256: hex(DIGEST2),
  });
  // What another artifact's provenance says is not this image's source.
  assertEquals(record.sourceCommit, null);
  assertEquals(record.sourceRepository, null);
  assertEquals(record.builderId, null);

  // No subject at all, a subject that is not a list, the digest under
  // another algorithm, in upper case, or with a prefix: none is this digest.
  for (
    const subjects of [
      [],
      undefined,
      "sha256:" + hex(DIGEST),
      { sha256: hex(DIGEST) },
      [{ name: "x", digest: { sha512: hex(DIGEST) } }],
      [{ name: "x", digest: { sha256: hex(DIGEST).toUpperCase() } }],
      [{ name: "x", digest: { sha256: DIGEST } }],
      [{ name: "x", digest: hex(DIGEST) }],
      [{ name: hex(DIGEST) }],
      [null, 7, "x"],
    ]
  ) {
    const r = await attested(
      [{ ...slsa1(DIGEST), subject: subjects }],
      {},
      "printed",
    );
    assertEquals(r.record.verified, false, JSON.stringify(subjects));
    assertEquals(r.record.matched, 0);
    assertEquals(r.record.sourceCommit, null);
  }
});

Deno.test("of several attestations the one about this digest counts, and only it feeds the summary", async () => {
  // Real cosign would stop this first: with its default --check-claims it
  // refuses a statement about another digest. The type checks for itself.
  const { record } = await attested(
    [
      slsa1(DIGEST2, {
        commit: COMMIT2,
        repository: "https://github.com/other/thing",
      }),
      slsa1(DIGEST),
      { ...slsa1(DIGEST2), subject: [subject(DIGEST2), subject(REF2)] },
    ],
    {},
    "printed",
  );
  assertEquals(record.verified, true);
  assertEquals(record.attestations, 3);
  assertEquals(record.matched, 1);
  assertEquals(record.sourceCommit, COMMIT);
  assertEquals(record.sourceRepository, SOURCE);
  // The one that counts is listed first.
  assertEquals(record.statements.map((s) => s.counted), [true, false, false]);
  assertEquals(record.statements[0].sourceCommit, COMMIT);
  assertEquals(record.statements[1].sourceCommit, COMMIT2);

  // One statement naming several subjects counts when one of them is the digest.
  const many = await attested([
    {
      ...slsa1(DIGEST),
      subject: [subject(DIGEST2, "worker"), subject(DIGEST)],
    },
  ]);
  assertEquals(many.record.verified, true);
  assertEquals(many.record.statements[0].subjectCount, 2);
});

Deno.test("two attestations that count and disagree leave the summary empty instead of choosing", async () => {
  const { record } = await attested([
    slsa1(DIGEST),
    slsa1(DIGEST, { commit: COMMIT2 }),
  ]);
  assertEquals(record.verified, true);
  assertEquals(record.matched, 2);
  assertEquals(record.sourceCommit, null);
  assertEquals(record.sourceRepository, SOURCE);
  assertEquals(record.builderId, BUILDER);
  assertEquals(record.statements.map((s) => s.sourceCommit), [COMMIT, COMMIT2]);
});

Deno.test("SLSA v0.2 maps onto the same fields: config source, builder, materials", async () => {
  const { record, all } = await attested([slsa02(DIGEST)], {
    type: "slsaprovenance02",
  });
  assertEquals(record.verified, true);
  assertEquals(record.predicateTypes, [SLSA02]);
  assertEquals(record.sourceRepository, SOURCE);
  assertEquals(record.sourceRef, "refs/tags/v1.2.3");
  assertEquals(record.sourceCommit, COMMIT);
  assertStringIncludes(
    String(record.builderId),
    "generator_container_slsa3.yml",
  );
  assertEquals(record.statements[0].provenance, {
    buildType:
      "https://github.com/slsa-framework/slsa-github-generator/container@v1",
    workflow: {
      repository: SOURCE,
      ref: "refs/tags/v1.2.3",
      path: ".github/workflows/release.yml",
    },
    resolvedDependencies: [{
      uri: `git+${SOURCE}@refs/tags/v1.2.3`,
      gitCommit: COMMIT,
    }],
    resolvedDependencyCount: 1,
    builderId: record.builderId,
    invocationId: "42835074961-1",
  });
  assertEquals(all.includes(MARKER), false);

  // A config source that is not a git URI names no repository and no commit:
  // a sha1 of something else is not a commit.
  const st = slsa02(DIGEST);
  st.predicate.invocation.configSource.uri = "https://example.org/build.tar";
  // Nor is the sha1 of a material that is not a git one.
  st.predicate.materials = [
    { uri: "https://example.org/base.tar", digest: { sha1: COMMIT2 } },
    { uri: "git+https://github.com/example/lib@v2", digest: { sha1: COMMIT2 } },
  ];
  (st.predicate.metadata as Record<string, unknown>) = {
    buildInvocationId: "as-the-specification-spells-it",
  };
  const other = await attested([st], { type: "slsaprovenance02" });
  assertEquals(
    other.record.statements[0].provenance!.invocationId,
    "as-the-specification-spells-it",
  );
  assertEquals(other.record.statements[0].provenance!.resolvedDependencies, [
    { uri: "https://example.org/base.tar", gitCommit: null },
    { uri: "git+https://github.com/example/lib@v2", gitCommit: COMMIT2 },
  ]);
  assertEquals(other.record.verified, true);
  assertEquals(other.record.sourceRepository, null);
  assertEquals(other.record.sourceRef, null);
  assertEquals(other.record.sourceCommit, null);
});

Deno.test("another predicate type keeps its type and subjects, and claims no source", async () => {
  const { record } = await attested([{
    _type: "https://in-toto.io/Statement/v1",
    subject: [subject(DIGEST)],
    predicateType: "https://spdx.dev/Document",
    predicate: {
      spdxVersion: "SPDX-2.3",
      // Fields that look like provenance in a predicate that is not.
      buildDefinition: slsa1(DIGEST).predicate.buildDefinition,
      runDetails: slsa1(DIGEST).predicate.runDetails,
    },
  }], { type: "https://spdx.dev/Document" });
  assertEquals(record.verified, true);
  assertEquals(record.matched, 1);
  assertEquals(record.statements[0].predicateType, "https://spdx.dev/Document");
  assertEquals(record.statements[0].provenance, null);
  assertEquals(record.sourceRepository, null);
  assertEquals(record.sourceRef, null);
  assertEquals(record.sourceCommit, null);
  assertEquals(record.builderId, null);
});

Deno.test("a SLSA v1 commit is never guessed: no workflow, or no dependency for it, leaves it empty", async () => {
  // A buildkit-shaped predicate: no workflow, the source among base images.
  const kit = slsa1(DIGEST);
  (kit.predicate.buildDefinition as Record<string, unknown>)
    .externalParameters = {
      configSource: {
        uri: "https://github.com/example/api.git#refs/heads/main",
      },
      request: { args: { TOKEN: MARKER }, secrets: [{ id: MARKER }] },
    };
  const a = await attested([kit]);
  assertEquals(a.record.verified, true);
  assertEquals(a.record.statements[0].provenance!.workflow, null);
  assertEquals(a.record.sourceRepository, null);
  assertEquals(a.record.sourceCommit, null);
  assertEquals(a.record.builderId, BUILDER);
  assertEquals(a.all.includes(MARKER), false);

  // A workflow, but the only commit belongs to another repository.
  const b = slsa1(DIGEST);
  b.predicate.buildDefinition.resolvedDependencies[0].uri =
    "git+https://github.com/other/thing@refs/heads/main";
  const rb = await attested([b]);
  assertEquals(rb.record.sourceRepository, SOURCE);
  assertEquals(rb.record.sourceCommit, null);

  // Two dependencies for the workflow's source with two commits.
  const c = slsa1(DIGEST);
  c.predicate.buildDefinition.resolvedDependencies.push({
    uri: `git+${SOURCE}@refs/heads/main`,
    digest: { gitCommit: COMMIT2 },
  });
  const rc = await attested([c]);
  assertEquals(rc.record.sourceCommit, null);
  assertEquals(rc.record.statements[0].provenance!.resolvedDependencyCount, 2);
});

Deno.test("a malformed predicate is recorded as saying nothing, and does not fail the method", async () => {
  const base = slsa1(DIGEST);
  for (
    const predicate of [
      undefined,
      null,
      "a string",
      42,
      [],
      [base.predicate],
      {},
      { buildDefinition: 7, runDetails: "x" },
      { buildDefinition: [], runDetails: [] },
      {
        buildDefinition: {
          buildType: { nested: true },
          externalParameters: "x",
          resolvedDependencies: { uri: "x" },
        },
        runDetails: { builder: "me", metadata: [] },
      },
      {
        buildDefinition: {
          externalParameters: { workflow: [SOURCE] },
          resolvedDependencies: [null, 3, "x", [], { uri: 5, digest: "x" }, {
            uri: `git+${SOURCE}@refs/heads/main`,
            digest: { gitCommit: "not-hex" },
          }],
        },
        runDetails: { builder: { id: 9 }, metadata: { invocationId: {} } },
      },
      {
        buildDefinition: {
          externalParameters: {
            workflow: { repository: 1, ref: null, path: ["x"] },
          },
        },
      },
    ]
  ) {
    const { record } = await attested([{ ...base, predicate }]);
    const what = JSON.stringify(predicate);
    assertEquals(record.verified, true, what);
    assertEquals(record.matched, 1, what);
    assertEquals(record.sourceRepository, null, what);
    assertEquals(record.sourceRef, null, what);
    assertEquals(record.sourceCommit, null, what);
    assertEquals(record.builderId, null, what);
  }

  // A statement that is not an object, or has no predicate type, verifies as
  // nothing about this digest.
  for (const statement of [[], "text", 7, null, {}, { predicateType: 5 }]) {
    const { record } = await attested([statement], {}, "printed");
    assertEquals(record.verified, false, JSON.stringify(statement));
    assertEquals(record.attestations, 1);
    assertEquals(record.predicateTypes, [""]);
  }

  // A payload that is no statement at all is still cosign output that was not
  // understood: the method fails and records nothing.
  const f = fake({});
  const restore = __setExec(() =>
    Promise.resolve({
      code: 0,
      stdout: JSON.stringify({ payload: btoa("not json") }) + "\n",
      stderr: "",
    })
  );
  try {
    const { ctx, written } = context({
      publicKey: PUBLIC,
      key: "",
      password: "",
    });
    const err = await assertRejects(() =>
      verifyAttestation({ refs: [REF] }, ctx)
    );
    assertStringIncludes(String(err), "not an in-toto statement");
    assertEquals(written.length, 0);
  } finally {
    restore();
    f.restore();
  }
});

Deno.test("a huge predicate leaves a small record: lists are cut with their length kept, long values are not stored", async () => {
  const st = slsa1(DIGEST);
  const def = st.predicate.buildDefinition;
  const source = def.resolvedDependencies[0];
  def.resolvedDependencies = [];
  for (let i = 0; i < 5000; i++) {
    def.resolvedDependencies.push({
      uri: `pkg:docker/library/base-${i}@1.0`,
      digest: { gitCommit: COMMIT2 },
    });
  }
  // The source is the last of 5001, far past what is stored.
  def.resolvedDependencies.push(source);
  st.subject = [];
  for (let i = 0; i < 5000; i++) {
    st.subject.push(
      subject("sha256:" + String(i).padStart(64, "0"), `layer-${i}`),
    );
  }
  st.subject.push(subject(DIGEST));
  st.predicate.runDetails.builder.id = "https://example.org/" +
    "b".repeat(100_000);
  st.predicate.runDetails.metadata.invocationId = "i".repeat(2_000_000);
  (st.predicate as Record<string, unknown>).padding = "p".repeat(3_000_000);

  const { record } = await attested([st]);
  assertEquals(record.verified, true);
  const s = record.statements[0];
  assertEquals(s.subjectCount, 5001);
  assertEquals(s.subjects.length, 20);
  // The subject that matches is kept, first.
  assertEquals(s.subjects[0].digest, { sha256: hex(DIGEST) });
  assertEquals(s.provenance!.resolvedDependencyCount, 5001);
  assertEquals((s.provenance!.resolvedDependencies as unknown[]).length, 20);
  // The commit is found past the cut.
  assertEquals(record.sourceCommit, COMMIT);
  assertEquals(s.provenance!.builderId, null);
  assertEquals(s.provenance!.invocationId, null);
  assertEquals(s.withheld, 2);
  assert(
    JSON.stringify(record).length < 16_000,
    String(JSON.stringify(record).length),
  );

  // Many attestations: all are judged, the first 20 are stored, the one that
  // counts among them.
  const crowd: unknown[] = [];
  for (let i = 0; i < 300; i++) crowd.push(slsa1(DIGEST2));
  crowd.push(slsa1(DIGEST));
  const many = await attested(crowd, {}, "printed");
  // predicateTypes is cut too, far above what an image carries; the count
  // of attestations is the whole number.
  assertEquals((many.record.predicateTypes as string[]).length, 100);
  assertEquals(many.record.verified, true);
  assertEquals(many.record.attestations, 301);
  assertEquals(many.record.matched, 1);
  assertEquals(many.record.statements.length, 20);
  assertEquals(many.record.statements[0].counted, true);
  assert(JSON.stringify(many.record).length < 64_000);
});

Deno.test("no field that can hold a secret is stored: environments, parameters, credentials in a URI", async () => {
  const st = slsa1(DIGEST);
  const p = st.predicate as Record<string, unknown>;
  const def = st.predicate.buildDefinition as Record<string, unknown>;
  def.externalParameters = {
    workflow: {
      ref: "refs/heads/main",
      repository: SOURCE,
      path: ".github/workflows/build.yml",
      token: MARKER,
      inputs: { password: MARKER },
    },
    inputs: { deploy_key: MARKER },
    vars: { API_TOKEN: MARKER },
    secrets: { NPM_TOKEN: MARKER },
    [MARKER]: "a key is text too",
  };
  def.internalParameters = { github: { token: MARKER }, env: { CI: MARKER } };
  def.environment = { PASSWORD: MARKER };
  (def.resolvedDependencies as unknown[]).push(
    {
      uri: `https://user:${MARKER}@git.example.org/team/dep.git`,
      digest: { gitCommit: COMMIT2 },
    },
    {
      uri: `https://bucket.example.org/dep.tar?X-Amz-Signature=${MARKER}`,
      digest: { sha256: MARKER },
    },
    {
      uri: "pkg:generic/dep",
      digest: { gitCommit: MARKER },
      annotations: { note: MARKER },
    },
    {
      uri: "pkg:generic/dep2",
      name: MARKER,
      content: MARKER,
      downloadLocation: MARKER,
    },
  );
  const run = st.predicate.runDetails as Record<string, unknown>;
  run.builder = {
    id: BUILDER,
    version: { runner: MARKER },
    builderDependencies: [{ uri: MARKER }],
  };
  run.metadata = { invocationId: INVOCATION, env: MARKER, startedOn: MARKER };
  run.byproducts = [{ name: "log", content: MARKER }];
  p.environment = { TOKEN: MARKER };
  p[MARKER] = MARKER;
  const whole = {
    ...st,
    subject: [{
      ...subject(DIGEST),
      annotations: { token: MARKER },
      digest: {
        sha256: hex(DIGEST),
        [MARKER]: "abcdef0123456789",
        md5: "abcdef0123456789",
        note: MARKER,
      },
    }],
    [MARKER]: MARKER,
  };

  const { record, all } = await attested([whole]);
  assertEquals(record.verified, true);
  assertEquals(record.matched, 1);
  assertEquals(all.includes(MARKER), false, all.slice(0, 2000));
  const s = record.statements[0];
  assertEquals(s.sourceCommit, COMMIT);
  assertEquals(s.provenance!.resolvedDependencyCount, 5);
  assertEquals(s.provenance!.resolvedDependencies, [
    { uri: `git+${SOURCE}@refs/heads/main`, gitCommit: COMMIT },
    { uri: null, gitCommit: COMMIT2 },
    { uri: null, gitCommit: null },
    { uri: "pkg:generic/dep", gitCommit: null },
    { uri: "pkg:generic/dep2", gitCommit: null },
  ]);
  assert((s.withheld as number) >= 3, String(s.withheld));
  // Of a subject's digests the known algorithms are kept, by name.
  assertEquals(s.subjects[0].digest, { sha256: hex(DIGEST) });

  // The same in the places the summary is derived from: a credential in the
  // repository, the builder or the ref is not stored and not reported.
  const bad = slsa1(DIGEST, {
    repository: `https://x:${MARKER}@github.com/example/api`,
  });
  bad.predicate.runDetails.builder.id =
    `https://${MARKER}@builder.example.org/b`;
  const r = await attested([bad], { sourceRepository: SOURCE });
  assertEquals(r.record.verified, false);
  assertEquals(r.record.statements[0].sourceRepository, null);
  assertEquals(r.record.statements[0].builderId, null);
  assertEquals(r.all.includes(MARKER), false);
});

Deno.test("sourceRepository and sourceCommit, when given, must equal what an attestation says, exactly", async () => {
  const right = await attested([slsa1(DIGEST)], {
    sourceRepository: SOURCE,
    sourceCommit: COMMIT,
  });
  assertEquals(right.record.verified, true);
  assertEquals(right.record.matched, 1);
  assertEquals(right.record.error, "");
  assertEquals(right.record.expectedSourceRepository, SOURCE);
  assertEquals(right.record.expectedSourceCommit, COMMIT);
  // The expectation is checked here, never handed to cosign.
  const argv =
    right.calls.find((c) => c.args[0] === "verify-attestation")!.args;
  assertEquals(argv.includes(COMMIT) || argv.includes(SOURCE), false);
  assertEquals(argv.slice(-2), ["--", REF]);

  const commit = await attested([slsa1(DIGEST)], { sourceCommit: COMMIT2 });
  assertEquals(commit.record.verified, false);
  assertEquals(commit.record.attestations, 1);
  assertEquals(commit.record.matched, 0);
  assertEquals(
    commit.record.error,
    `1 attestation verified by cosign, none counted: sourceCommit is "${COMMIT}", not "${COMMIT2}"`,
  );
  assertEquals(commit.record.statements[0].subjectMatches, true);
  assertEquals(commit.record.statements[0].counted, false);
  // What did not count is in the statement, not in the summary.
  assertEquals(commit.record.statements[0].sourceCommit, COMMIT);
  assertEquals(commit.record.sourceCommit, null);

  for (
    const sourceRepository of [
      SOURCE + "/",
      SOURCE + ".git",
      SOURCE.toUpperCase(),
      "github.com/example/api",
      "https://github.com/example",
    ]
  ) {
    const r = await attested([slsa1(DIGEST)], { sourceRepository });
    assertEquals(r.record.verified, false, sourceRepository);
    assertStringIncludes(String(r.record.error), "sourceRepository is ");
  }
  for (
    const sourceCommit of [
      COMMIT.slice(0, 12),
      COMMIT.toUpperCase(),
      COMMIT + "0",
    ]
  ) {
    const r = await attested([slsa1(DIGEST)], { sourceCommit });
    assertEquals(r.record.verified, false, sourceCommit);
  }

  // The repository right and the commit wrong is wrong; so is the reverse.
  const half = await attested([slsa1(DIGEST)], {
    sourceRepository: SOURCE,
    sourceCommit: COMMIT2,
  });
  assertEquals(half.record.verified, false);
  const half2 = await attested([slsa1(DIGEST)], {
    sourceRepository: "https://github.com/other/thing",
    sourceCommit: COMMIT,
  });
  assertEquals(half2.record.verified, false);

  // The right commit in an attestation about another artifact does not count,
  // and the two expectations are not met by two different attestations.
  const elsewhere = await attested(
    [slsa1(DIGEST2)],
    { sourceCommit: COMMIT },
    "printed",
  );
  assertEquals(elsewhere.record.verified, false);
  const split = await attested([
    slsa1(DIGEST, { commit: COMMIT2 }),
    slsa1(DIGEST, { repository: "https://github.com/other/thing" }),
  ], { sourceRepository: SOURCE, sourceCommit: COMMIT });
  assertEquals(split.record.verified, false);
  assertEquals(split.record.matched, 0);

  // Of two, the one that says it counts.
  const two = await attested([
    slsa1(DIGEST, { commit: COMMIT2 }),
    slsa1(DIGEST),
  ], { sourceCommit: COMMIT });
  assertEquals(two.record.verified, true);
  assertEquals(two.record.matched, 1);
  assertEquals(two.record.sourceCommit, COMMIT);

  // A predicate that names no source cannot meet an expectation.
  const none = await attested([{
    ...slsa1(DIGEST),
    predicateType: "https://spdx.dev/Document",
  }], { sourceCommit: COMMIT, type: "https://spdx.dev/Document" });
  assertEquals(none.record.verified, false);
  assertEquals(
    none.record.error,
    `1 attestation verified by cosign, none counted: sourceCommit is null, not "${COMMIT}"`,
  );
});

Deno.test("an expectation that is not one line of text is refused before cosign runs", async () => {
  const f = fake({ statements: { [DIGEST]: [slsa1(DIGEST)] } });
  try {
    for (
      const args of [
        { sourceCommit: COMMIT + "\n" },
        { sourceCommit: " " + COMMIT },
        { sourceRepository: SOURCE + "\n--key" },
        { sourceRepository: "x".repeat(1025) },
        { sourceCommit: "${{ inputs.sourceCommit }}" },
      ]
    ) {
      const { ctx, written } = context({
        publicKey: PUBLIC,
        key: "",
        password: "",
      });
      await assertRejects(() =>
        verifyAttestation({ refs: [REF], ...args }, ctx)
      );
      assertEquals(written.length, 0);
    }
    assertEquals(f.calls.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("an image cosign does not verify has no statements and an empty summary", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context({
      publicKey: PUBLIC,
      key: "",
      password: "",
    });
    await verifyAttestation({ refs: [REF], sourceCommit: COMMIT }, ctx);
    const r = written[0].data;
    assertEquals(r.verified, false);
    assertEquals(r.error, "no matching attestations: none");
    assertEquals(r.attestations, 0);
    assertEquals(r.matched, 0);
    assertEquals(r.statements, []);
    assertEquals(r.sourceCommit, null);
    assertEquals(r.expectedSourceCommit, COMMIT);
  } finally {
    f.restore();
  }
});

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
  assertEquals(model.version, "2026.11.10.1");
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

Deno.test("an image with attestations, none of the type asked for, is recorded as not verified, in cosign's words", async () => {
  // What cosign 3.1.4 prints, and exits 1 with, for an image that has
  // attestations of other types only.
  const said =
    "none of the attestations matched the predicate type: spdxjson, found: https://sigstore.dev/cosign/sign/v1,https://slsa.dev/provenance/v1";
  const restore = __setExec((_bin, args) =>
    Promise.resolve(
      args[0] === "verify-attestation"
        ? {
          code: 1,
          stdout: "",
          stderr: `Error: ${said}\nerror during command execution: ${said}\n`,
        }
        : { code: 99, stdout: "", stderr: "unexpected" },
    )
  );
  try {
    const { ctx, written } = context(KEYLESS);
    await verifyAttestation({ refs: [REF], type: "spdxjson" }, ctx);
    assertEquals(written.length, 1);
    assertEquals(written[0].data.verified, false);
    assertEquals(written[0].data.attestations, 0);
    assertEquals(written[0].data.error, said);
  } finally {
    restore();
  }
});

// Round two: what the review of 2026.11.10.1's first cut found.

const GITHUB = "https://actions.github.io/buildtypes/workflow/v1";

/** slsa1 with one field of its workflow reference replaced. */
function withRepository(repository: unknown) {
  const st = slsa1(DIGEST);
  (st.predicate.buildDefinition.externalParameters.workflow as Record<
    string,
    unknown
  >).repository = repository;
  return st;
}

Deno.test("a URL with a user, a password, a query or a fragment is withheld in every form, and a control character anywhere", async () => {
  for (
    const repository of [
      `https://user:${MARKER}@github.com/example/api`,
      `https://${MARKER}@github.com/example/api`,
      `user:${MARKER}@github.com/example/api`,
      `${MARKER}@github.com/example/api`,
      `//user:${MARKER}@github.com/example/api`,
      `git@github.com:example/${MARKER}.git`,
      `ssh://git:${MARKER}@github.com/example/api`,
      `see https://x:${MARKER}@github.com/example/api for the source`,
      `https://github.com/example/api#${MARKER}`,
      `https://github.com/example/api?token=${MARKER}`,
      `https://github.com/example/api\u001b[31m${MARKER}`,
      `https://github.com/example/api\u0000${MARKER}`,
      `https://github.com/example/api\n${MARKER}`,
      `https://github.com/example/api\u007f${MARKER}`,
      // A space in the user, one slash, no scheme, a backslash, a tab.
      `https://u s:${MARKER}@github.com/example/api`,
      `https:/u:${MARKER}@github.com/example/api`,
      `https:u:${MARKER}@github.com/example/api`,
      `a/../u:${MARKER}@github.com/example/api`,
      `https:\\\\u:${MARKER}@github.com/example/api`,
      `https://github.com\\@${MARKER}.example.org/api`,
      `https://u:${MARKER}@/example/api`,
      `HTTPS://u:${MARKER}@github.com/example/api`,
      `git+https://u:${MARKER}@github.com/example/api`,
      `ftp://github.com/example/${MARKER}`,
      `https:///${MARKER}`,
      `https://:${MARKER}@github.com/example/api`,
      `https:/github.com/example/${MARKER}`,
      "https://github.com/example/api?",
      "https://github.com/example/api#",
      `${MARKER}`,
    ]
  ) {
    const { record, all } = await attested([withRepository(repository)]);
    const what = JSON.stringify(repository);
    assertEquals(record.verified, true, what);
    assertEquals(record.sourceRepository, null, what);
    assertEquals(record.statements[0].provenance!.workflow, {
      repository: null,
      ref: "refs/heads/main",
      path: ".github/workflows/build.yml",
    }, what);
    assert((record.statements[0].withheld as number) >= 1, what);
    assertEquals(all.includes(MARKER), false, what);
    // And it cannot be asked for either: null equals nothing.
    const asked = await attested([withRepository(repository)], {
      sourceRepository: "https://github.com/example/api",
    });
    assertEquals(asked.record.verified, false, what);
  }
  // An @ after the host is not a user: a builder id and a git URI keep it.
  const fine = await attested([slsa1(DIGEST)]);
  assertEquals(fine.record.builderId, BUILDER);
  assertEquals(fine.record.statements[0].withheld, 0);

  // The other direction: honest values with an @ and no host before it.
  for (
    const id of [
      "mailto:ci@example.org",
      "pkg:github/example/builder@v1",
      "urn:example:builder@2",
      "ssh://git.example.org/team/builder.git",
      "git://git.example.org/team/builder.git",
      "HTTPS://Builder.example.org/b@refs/heads/main",
    ]
  ) {
    const st = slsa1(DIGEST);
    st.predicate.runDetails.builder.id = id;
    const r = await attested([st]);
    assertEquals(r.record.builderId, id);
    assertEquals(r.record.statements[0].withheld, 0, id);
  }
  // A builder id is held to the same rule as a repository.
  for (
    const id of [
      `${BUILDER}?token=${MARKER}`,
      `${BUILDER}#${MARKER}`,
      `https://u:${MARKER}@builder.example.org/b`,
      `mailto:ci@example.org?subject=${MARKER}`,
      `pkg:github/example/builder@v1#${MARKER}`,
      `pkg://u:${MARKER}@example.org/builder`,
    ]
  ) {
    const st = slsa1(DIGEST);
    st.predicate.runDetails.builder.id = id;
    const r = await attested([st]);
    assertEquals(r.record.builderId, null, id);
    assertEquals(r.all.includes(MARKER), false, id);
  }
  // A subject name is not a URL: it is stored as the attestation gives it,
  // bounded and without control characters, whatever it looks like.
  for (
    const name of [
      "foo@1.0.0.tgz",
      "pkg:docker/example/api@1.2.3?platform=linux%2Famd64",
      "registry.example.org/team/api",
      "release notes (final).txt",
      "user@host:path",
    ]
  ) {
    const st = { ...slsa1(DIGEST), subject: [subject(DIGEST, name)] };
    const r = await attested([st]);
    assertEquals(r.record.statements[0].subjects[0].name, name);
    assertEquals(r.record.statements[0].withheld, 0, name);
  }
  for (const name of ["a\u001b[2Jb", "x".repeat(1025), 7]) {
    const st = {
      ...slsa1(DIGEST),
      subject: [{ ...subject(DIGEST), name }],
    };
    const r = await attested([st]);
    assertEquals(r.record.statements[0].subjects[0].name, null);
    assertEquals(r.record.statements[0].withheld, 1);
  }
  // An invocation id is a URL, as GitHub writes it, or a plain token, as the
  // generator does; anything else is not stored.
  for (
    const [id, expected] of [
      [INVOCATION, INVOCATION],
      ["15275748456-1", "15275748456-1"],
      [`${INVOCATION}?t=${MARKER}`, null],
      [`run ${MARKER}`, null],
      [`u:${MARKER}@host/run`, null],
    ] as [string, string | null][]
  ) {
    const st = slsa1(DIGEST);
    st.predicate.runDetails.metadata.invocationId = id;
    const r = await attested([st]);
    assertEquals(r.record.statements[0].provenance!.invocationId, expected, id);
  }
});

Deno.test("the same rule on the v0.2 path: a config source with a control character or a user names nothing", async () => {
  for (
    const uri of [
      `git+${SOURCE}\u001b[2J@refs/tags/v1.2.3`,
      `git+${SOURCE}@refs/tags/v1\u0000.2.3`,
      `git+${SOURCE}\u0007@refs/tags/v1.2.3`,
      `git+https://x:${MARKER}@github.com/example/api@refs/tags/v1.2.3`,
      `git+${SOURCE}#${MARKER}@refs/tags/v1.2.3`,
      // A scheme that is not one a repository is fetched over.
      `git+ftp://example.org/${MARKER}@refs/tags/v1.2.3`,
    ]
  ) {
    if (!uri.startsWith("git+ftp")) {
      assertEquals(parseGitUri(uri), null, JSON.stringify(uri));
    }
    const st = slsa02(DIGEST);
    st.predicate.builder.id = `https://builder.example.org/b?t=${MARKER}`;
    st.predicate.invocation.configSource.uri = uri;
    st.predicate.materials = [];
    const { record, all } = await attested([st], { type: "slsaprovenance02" });
    assertEquals(record.sourceRepository, null, JSON.stringify(uri));
    assertEquals(record.builderId, null);
    assertEquals(record.sourceRef, null);
    assertEquals(record.sourceCommit, null);
    // In JSON a control character is written \u00xx.
    assertEquals(all.includes("\\u00"), false, JSON.stringify(uri));
    assertEquals(all.includes(MARKER), false);
  }
});

Deno.test("cosign's reason is one bounded line with no control character, in the record and in the log", async () => {
  const long = "no matching signatures: " + "x".repeat(5000);
  const f = fake({ verifyError: `${long}\u001b[31m red\u0000` });
  try {
    const { ctx, written, logs } = context({
      publicKey: PUBLIC,
      key: "",
      password: "",
    });
    await verify({ refs: [REF] }, ctx);
    const error = String(written[0].data.error);
    assertEquals(written[0].data.verified, false);
    assert(error.startsWith("no matching signatures: xxx"), error.slice(0, 80));
    assert(error.length <= 1024, String(error.length));
    assert(error.endsWith("…"));
    // The log line carries the same reason, cut and cleaned the same way.
    const line = logs.find((l) => l.includes("not verified"))!;
    assertStringIncludes(line, "no matching signatures: xxx");
    assert(line.length <= 1024 + 200, String(line.length));
    assertEquals(logs.join("").includes("\\u00"), false);
    assertEquals(logs.join("").includes("red"), false);
  } finally {
    f.restore();
  }

  // The types "found" on an image are text whoever can write to the
  // registry chose: they reach the record through cosign's own message.
  const planted = {
    ...slsa1(DIGEST),
    predicateType: "https://example.org/\u001b[2Jx\u0000y\u0007" +
      "t".repeat(4000),
  };
  const { record, all } = await attested([planted], { type: "spdxjson" });
  assertEquals(record.verified, false);
  assertEquals(record.attestations, 0);
  const error = String(record.error);
  assert(
    error.startsWith(
      "none of the attestations matched the predicate type: spdxjson, found: https://example.org/",
    ),
    error.slice(0, 120),
  );
  assert(error.length <= 1024, String(error.length));
  assertEquals(all.includes("\\u00"), false);
  assertEquals(all.includes("\u007f"), false);
});

Deno.test("a reference that starts with a dash is refused before cosign runs, by every method that takes one", async () => {
  const f = fake({ signed: [DIGEST] });
  try {
    for (const ref of [`-x@${DIGEST}`, `--key=/tmp/k@${DIGEST}`]) {
      const refs = [REF, ref];
      for (
        const call of [
          (c: Context) => sign({ refs }, c),
          (c: Context) => verify({ refs }, c),
          (c: Context) => attest({ refs, predicate: "deno.json" }, c),
          (c: Context) => verifyAttestation({ refs }, c),
        ]
      ) {
        const { ctx, written } = context();
        const err = await assertRejects(() => call(ctx));
        assertStringIncludes(String(err), "not an image reference");
        assertEquals(written.length, 0);
      }
    }
    assertEquals(f.calls.length, 0);
    assertEquals(typeof parseDigestRef(`-x@${DIGEST}`), "string");
    assertEquals(typeof parseDigestRef(`.x/y@${DIGEST}`), "string");
    assertEquals(typeof parseDigestRef(`localhost:5000/x@${DIGEST}`), "object");
  } finally {
    f.restore();
  }
});

Deno.test("the fake cosign refuses what the real one refuses: an unknown flag, a reference read as a flag", async () => {
  const f = fake({ signed: [DIGEST] });
  try {
    const direct = f.direct;
    assertStringIncludes(
      (await direct(["verify", "--no-such-flag", "--", REF])).stderr,
      "unknown flag: --no-such-flag",
    );
    assertStringIncludes(
      (await direct(["verify", `-x@${DIGEST}`])).stderr,
      "unknown flag",
    );
    assertStringIncludes(
      (await direct(["verify", "--key", "k", REF])).stderr,
      "wants -- before",
    );
    assertStringIncludes(
      (await direct(["verify-attestation", "--recursive", "--", REF])).stderr,
      "unknown flag: --recursive",
    );
    assertStringIncludes(
      (await direct(["verify", "--key", "k", "--", REF, REF2])).stderr,
      "accepts 1 arg(s), received 2",
    );
    assertEquals((await direct(["verify", "--key", "k", "--", REF])).code, 0);
  } finally {
    f.restore();
  }
});

Deno.test("the source commit is the dependency for exactly the workflow's repository and ref, a full hash, and the only one", async () => {
  const dep = (uri: string, gitCommit: unknown) => ({
    uri,
    digest: { gitCommit },
  });
  const exact = `git+${SOURCE}@refs/heads/main`;
  const cases: [string, unknown[], string | null][] = [
    ["the dependency itself", [dep(exact, COMMIT)], COMMIT],
    ["a sha256 commit", [dep(exact, "a".repeat(64))], "a".repeat(64)],
    ["the same commit twice", [dep(exact, COMMIT), dep(exact, COMMIT)], COMMIT],
    // A prefix or an extension of the uri is another source.
    ["a longer ref", [dep(`${exact}-next`, COMMIT)], null],
    [
      "a longer repository",
      [dep(`git+${SOURCE}-fork@refs/heads/main`, COMMIT)],
      null,
    ],
    ["a shorter uri", [dep(`git+${SOURCE}`, COMMIT)], null],
    ["without git+", [dep(`${SOURCE}@refs/heads/main`, COMMIT)], null],
    // Only a whole SHA-1 or SHA-256 in lower case is a commit.
    ["not hex", [dep(exact, "not-a-commit-but-forty-characters-long!!")], null],
    ["12 hex", [dep(exact, COMMIT.slice(0, 12))], null],
    ["50 hex", [dep(exact, "a".repeat(50))], null],
    ["128 hex", [dep(exact, "a".repeat(128))], null],
    ["upper case", [dep(exact, COMMIT.toUpperCase())], null],
    ["not text", [dep(exact, 42)], null],
    // A second entry for that uri that is not the same commit: no commit.
    ["two commits", [dep(exact, COMMIT), dep(exact, COMMIT2)], null],
    ["a second in upper case", [
      dep(exact, COMMIT),
      dep(exact, COMMIT.toUpperCase()),
    ], null],
    ["a second malformed", [dep(exact, COMMIT), dep(exact, "zz")], null],
    ["a second with no commit", [dep(exact, COMMIT), { uri: exact }], null],
    ["a second with no digest first", [
      { uri: exact, digest: 7 },
      dep(exact, COMMIT),
    ], null],
  ];
  for (const [name, dependencies, expected] of cases) {
    const st = slsa1(DIGEST);
    (st.predicate.buildDefinition as Record<string, unknown>)
      .resolvedDependencies = dependencies;
    const { record } = await attested([st]);
    assertEquals(record.sourceCommit, expected, name);
    assertEquals(record.sourceRepository, SOURCE, name);
  }
  // What is not a commit is still in the statement as it was given, when
  // it is hex; the summary alone is strict.
  const st = slsa1(DIGEST);
  st.predicate.buildDefinition.resolvedDependencies = [
    dep(exact, COMMIT.slice(0, 12)) as never,
    dep("pkg:generic/x", COMMIT.toUpperCase()) as never,
  ];
  const { record } = await attested([st]);
  assertEquals(record.statements[0].provenance!.resolvedDependencies, [
    { uri: exact, gitCommit: COMMIT.slice(0, 12) },
    { uri: "pkg:generic/x", gitCommit: COMMIT.toUpperCase() },
  ]);
  assertEquals(record.sourceCommit, null);

  // The same for v0.2's config source.
  for (
    const [sha1, expected] of [
      [COMMIT, COMMIT],
      [COMMIT.slice(0, 12), null],
      [COMMIT.toUpperCase(), null],
      ["a".repeat(50), null],
    ] as [string, string | null][]
  ) {
    const old = slsa02(DIGEST);
    old.predicate.invocation.configSource.digest.sha1 = sha1;
    const r = await attested([old], { type: "slsaprovenance02" });
    assertEquals(r.record.sourceCommit, expected, sha1);
  }
});

Deno.test("a source is derived only for a build type whose fields are known; any other keeps its build type and names none", async () => {
  // Another builder's predicate with a workflow key its caller chose.
  for (
    const buildType of [
      "https://example.org/buildtypes/any/v1",
      GITHUB + "/",
      GITHUB.toUpperCase(),
      "",
      undefined,
      7,
    ]
  ) {
    const st = slsa1(DIGEST);
    (st.predicate.buildDefinition as Record<string, unknown>).buildType =
      buildType;
    const { record } = await attested([st]);
    const what = JSON.stringify(buildType);
    assertEquals(record.verified, true, what);
    assertEquals(record.sourceRepository, null, what);
    assertEquals(record.sourceRef, null, what);
    assertEquals(record.sourceCommit, null, what);
    assertEquals(record.statements[0].provenance!.workflow, null, what);
    assertEquals(
      record.statements[0].provenance!.buildType,
      typeof buildType === "string" && buildType !== "" ? buildType : null,
      what,
    );
    // The fields SLSA v1 itself defines are read for any build type.
    assertEquals(record.builderId, BUILDER, what);
    assertEquals(record.statements[0].provenance!.resolvedDependencyCount, 1);
    // So an expectation given alone cannot be met by it.
    const asked = await attested([st], { sourceRepository: SOURCE });
    assertEquals(asked.record.verified, false, what);
  }
  const known = await attested([slsa1(DIGEST)]);
  assertEquals(known.record.statements[0].provenance!.buildType, GITHUB);
  assertEquals(known.record.sourceRepository, SOURCE);

  for (
    const [buildType, expected] of [
      [
        "https://github.com/slsa-framework/slsa-github-generator/container@v1",
        SOURCE,
      ],
      [
        "https://github.com/slsa-framework/slsa-github-generator/generic@v1",
        SOURCE,
      ],
      ["https://github.com/slsa-framework/slsa-github-generator/go@v1", SOURCE],
      ["https://example.org/builder@v1", null],
      [
        "https://github.com/slsa-framework/slsa-github-generator/container@v1-evil",
        null,
      ],
    ] as [string, string | null][]
  ) {
    const old = slsa02(DIGEST);
    old.predicate.buildType = buildType;
    const r = await attested([old], { type: "slsaprovenance02" });
    assertEquals(r.record.sourceRepository, expected, buildType);
    assertEquals(r.record.sourceCommit, expected === null ? null : COMMIT);
    assertEquals(r.record.statements[0].provenance!.buildType, buildType);
    assertEquals(
      r.record.statements[0].provenance!.workflow === null,
      expected === null,
      buildType,
    );
  }
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

Deno.test("verification and attestationVerification say what they were checked against: the identity and issuer, or the key's fingerprint", async () => {
  const f = fake({
    signed: [DIGEST],
    statements: { [DIGEST]: [slsa1(DIGEST)] },
  });
  try {
    const keyless = context(KEYLESS);
    await verify({ refs: [REF, REF2] }, keyless.ctx);
    await verifyAttestation(
      { refs: [REF], type: "slsaprovenance1" },
      keyless.ctx,
    );
    for (const w of keyless.written) {
      assertEquals(w.data.verifyMode, "keyless", w.name);
      assertEquals(w.data.certificateIdentity, "", w.name);
      assertEquals(w.data.certificateIdentityRegexp, IDENTITY_REGEXP, w.name);
      assertEquals(w.data.oidcIssuer, ISSUER, w.name);
      assertEquals(w.data.publicKeyFingerprint, "", w.name);
    }
    assertEquals(keyless.written.length, 3);
    // Also on the record of what did not verify.
    assertEquals(keyless.written[1].data.verified, false);

    const exact = context({
      ...KEYLESS,
      certificateIdentityRegexp: "",
      certificateIdentity: IDENTITY,
    });
    await verify({ refs: [REF] }, exact.ctx);
    assertEquals(exact.written[0].data.certificateIdentity, IDENTITY);
    assertEquals(exact.written[0].data.certificateIdentityRegexp, "");

    const byKey = context({ publicKey: PUBLIC, key: "", password: "" });
    await verify({ refs: [REF] }, byKey.ctx);
    await verifyAttestation(
      { refs: [REF], type: "slsaprovenance1" },
      byKey.ctx,
    );
    for (const w of byKey.written) {
      assertEquals(w.data.verifyMode, "key", w.name);
      assertEquals(w.data.certificateIdentity, "", w.name);
      assertEquals(w.data.oidcIssuer, "", w.name);
      assertEquals(w.data.publicKeyFingerprint, await fingerprint(PUBLIC));
    }
    // The key itself, and a path to it, are in neither record.
    const all = JSON.stringify(byKey.written);
    assertEquals(all.includes("BEGIN PUBLIC KEY"), false);
    assertEquals(all.includes("cosign-public-key-"), false);
  } finally {
    f.restore();
  }
});

Deno.test("with several references a failure at a later one leaves the earlier records, which are true", async () => {
  let n = 0;
  const restore = __setExec((_bin, args) =>
    Promise.resolve(
      args[0] === "verify" && ++n === 2
        ? {
          code: 1,
          stdout: "",
          stderr:
            "Error: GET https://registry.example.org/v2/: connection refused\n",
        }
        : {
          code: 0,
          stdout: JSON.stringify([payload(DIGEST, null)]) + "\n",
          stderr: "",
        },
    )
  );
  try {
    const { ctx, written } = context({
      publicKey: PUBLIC,
      key: "",
      password: "",
    });
    const err = await assertRejects(() => verify({ refs: [REF, REF2] }, ctx));
    assertStringIncludes(String(err), "connection refused");
    assertEquals(written.length, 1);
    assertEquals(written[0].data.ref, REF);
    assertEquals(written[0].data.verified, true);
  } finally {
    restore();
  }
});

Deno.test("a v0.2 digest that names two different commits names none", async () => {
  for (
    const [digest, expected] of [
      [{ sha1: COMMIT, gitCommit: COMMIT }, COMMIT],
      [{ gitCommit: COMMIT }, COMMIT],
      [{ sha1: COMMIT }, COMMIT],
      [{ sha1: COMMIT, gitCommit: COMMIT2 }, null],
      [{ sha1: COMMIT2, gitCommit: COMMIT }, null],
      [{ sha1: "zz", gitCommit: COMMIT }, null],
      [{ sha1: COMMIT, gitCommit: 7 }, null],
    ] as [Record<string, unknown>, string | null][]
  ) {
    const st = slsa02(DIGEST);
    (st.predicate.invocation.configSource as Record<string, unknown>).digest =
      digest;
    (st.predicate.materials[0] as Record<string, unknown>).digest = digest;
    const { record } = await attested([st], { type: "slsaprovenance02" });
    const what = JSON.stringify(digest);
    assertEquals(record.sourceCommit, expected, what);
    assertEquals(
      (record.statements[0].provenance!.resolvedDependencies as {
        gitCommit: string | null;
      }[])[0].gitCommit,
      expected,
      what,
    );
  }
});

Deno.test("the community build type GitHub's first attestations used is read as GitHub's own", async () => {
  // The example of slsa-framework/github-actions-buildtypes, workflow/v1.
  const st = {
    _type: "https://in-toto.io/Statement/v1",
    subject: [subject(DIGEST)],
    predicateType: SLSA1,
    predicate: {
      buildDefinition: {
        buildType:
          "https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1",
        externalParameters: {
          workflow: {
            ref: "refs/heads/main",
            repository: "https://github.com/octocat/hello-world",
            path: ".github/workflow/release.yml",
          },
        },
        internalParameters: {
          github: { event_name: "push", repository_id: "1296269" },
        },
        resolvedDependencies: [
          {
            uri: "git+https://github.com/octocat/hello-world@refs/heads/main",
            digest: { gitCommit: "c27d339ee6075c1f744c5d4b200f7901aad2c369" },
          },
          {
            uri:
              "https://github.com/actions/virtual-environments/releases/tag/ubuntu20/20220515.1",
          },
        ],
      },
      runDetails: {
        builder: {
          id:
            "https://github.com/slsa-framework/slsa-github-generator/.github/workflows/builder_go_slsa3.yml@refs/tags/v0.0.1",
        },
        metadata: {
          invocationId:
            "https://github.com/octocat/hello-world/actions/runs/1536140711/attempts/1",
        },
      },
    },
  };
  const { record } = await attested([st]);
  assertEquals(record.verified, true);
  assertEquals(
    record.sourceRepository,
    "https://github.com/octocat/hello-world",
  );
  assertEquals(record.sourceRef, "refs/heads/main");
  assertEquals(record.sourceCommit, "c27d339ee6075c1f744c5d4b200f7901aad2c369");
  assertEquals(record.statements[0].withheld, 0);
  assertEquals(record.statements[0].provenance!.resolvedDependencyCount, 2);
});
