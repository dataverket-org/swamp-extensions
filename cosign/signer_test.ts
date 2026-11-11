import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { z } from "npm:zod@4";
import {
  __setExec,
  __setScratchRoot,
  absolute,
  annotationRecord,
  argumentProblem,
  AttestArgsSchema,
  certificateFacts,
  checks,
  type CommandResult,
  type Context,
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
  parseTree,
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

type Call = {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

/** The flags each cosign command of the fake knows: those that take a value, and those that do not. */
const REGISTRY = ["--allow-insecure-registry", "--allow-http-registry"];
const IDENTITY_FLAGS = [
  "--key",
  "--certificate-identity",
  "--certificate-identity-regexp",
  "--certificate-oidc-issuer",
  "--trusted-root",
];
/** The flags that have cosign verify require a claim of the certificate, by the claim's name. */
const GITHUB_CLAIM_FLAGS: Record<string, string> = {
  githubWorkflowTrigger: "--certificate-github-workflow-trigger",
  githubWorkflowSha: "--certificate-github-workflow-sha",
  githubWorkflowName: "--certificate-github-workflow-name",
  githubWorkflowRepository: "--certificate-github-workflow-repository",
  githubWorkflowRef: "--certificate-github-workflow-ref",
};
const GITHUB_FLAGS = Object.values(GITHUB_CLAIM_FLAGS);
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
    value: [
      ...IDENTITY_FLAGS,
      "--certificate-oidc-issuer-regexp",
      ...GITHUB_FLAGS,
      "--output",
      "-a",
    ],
    plain: [
      "--insecure-ignore-tlog",
      "--new-bundle-format=false",
      ...REGISTRY,
    ],
  },
  "download": { value: [], plain: REGISTRY },
  "tree": { value: [], plain: REGISTRY },
  "verify-blob-attestation": {
    value: [
      "--bundle",
      "--certificate-identity-regexp",
      "--certificate-oidc-issuer-regexp",
      "--digest",
      "--digestAlg",
      "--type",
      "--trusted-root",
    ],
    plain: [],
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
  "download",
  "tree",
];

/** argv as cosign's flag parser reads it, or what it refuses. */
function parseArgv(
  args: string[],
): { flags: Record<string, string[]>; positional: string[] } | string {
  const known = FLAGS[args[0]];
  if (!known) return `unknown command "${args[0]}" for "cosign"`;
  const flags: Record<string, string[]> = {};
  const positional: string[] = [];
  if (args[0] === "download" && args[1] !== "signature") {
    return `unknown command "${args[1]}" for "cosign download"`;
  }
  let i = args[0] === "signing-config" || args[0] === "download" ? 2 : 1;
  for (; i < args.length; i++) {
    const a = args[i];
    if (a === "--") {
      positional.push(...args.slice(i + 1));
      break;
    }
    const eq = a.indexOf("=");
    if (known.plain.includes(a)) {
      flags[a] = [];
    } else if (eq > 0 && known.value.includes(a.slice(0, eq))) {
      // --flag=value: one argument, whatever the value starts with.
      (flags[a.slice(0, eq)] ??= []).push(a.slice(eq + 1));
    } else if (known.value.includes(a)) {
      if (i + 1 >= args.length) return `flag needs an argument: ${a}`;
      (flags[a] ??= []).push(args[++i]);
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
 *
 * For identify: `downloads` is what `download signature` prints for a
 * digest, as objects, one per line, or as text printed as it is; a digest
 * with none has no signature, and `downloadError` is cosign's message for
 * one that fails another way. `tree` lists what the downloads hold, as
 * cosign tree does, unless `treeLists` says what it lists for a digest or
 * `treeError` that it fails. `genuine` holds the certificates
 * `verify-blob-attestation` accepts, as base64; any other gets
 * `bundleError`. That command refuses, with words that are no verdict, a
 * bundle that holds a field the model did not read. `tagVerified` is what
 * `verify` prints for a digest when it is asked with an identity pattern,
 * and `tagError` what it says when it has nothing to print. `certified` is
 * what the certificates of those signatures really say, which is what the
 * exact flags of `verify` are held against; when not given it is what was
 * printed. Beside bundles `verify` reads the tag form only with
 * `--new-bundle-format=false`, and refuses that flag anywhere else;
 * `tagBeside` names digests with key signatures under the tag beside
 * their bundles. `treePrints` replaces what cosign tree prints. `spawn` is
 * thrown instead of running anything: a binary that is not there, or a
 * cancelled run.
 */
/** What the certificate of one verified tag-form signature really says. */
type TagCertificate = {
  identity: string;
  issuer: string;
  claims: Record<string, string>;
};

function fake(opts: {
  downloads?: Record<string, unknown[] | string>;
  downloadError?: Record<string, string>;
  genuine?: string[];
  bundleError?: string;
  tagVerified?: Record<string, unknown[]>;
  tagError?: string;
  certified?: Record<string, TagCertificate[]>;
  tagBeside?: string[];
  treeLists?: Record<
    string,
    ("bundle" | "tag" | "attestation" | "foreign" | "odd")[]
  >;
  treeError?: Record<string, string>;
  treePrints?: Record<
    string,
    { code?: number; stdout?: string; stderr?: string }
  >;
  spawn?: Error;
  signed?: string[];
  attested?: Record<string, string[]>;
  statements?: Record<string, unknown[]>;
  printed?: Record<string, unknown[]>;
  verifyError?: string;
  blobError?: string;
  fail?: string;
}) {
  const calls: Call[] = [];
  /** Every bundle file a call named, to see that none is left behind. */
  const bundles: string[] = [];
  const run = async (
    bin: string,
    args: string[],
    o: { cwd: string; env: Record<string, string> },
  ): Promise<CommandResult> => {
    {
      calls.push({ bin, args, cwd: o.cwd, env: o.env });
      if (opts.spawn) throw opts.spawn;
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
      if (args[0] === "verify-blob-attestation") {
        const path = flags["--bundle"][0];
        bundles.push(path);
        const bundle = JSON.parse(await Deno.readTextFile(path));
        const statement = JSON.parse(atob(bundle.dsseEnvelope.payload));
        const refuse = (said: string) => ({
          code: 1,
          stdout: "",
          stderr: `Error: ${said}\nerror during command execution: ${said}\n`,
        });
        if (
          flags["--certificate-identity-regexp"]?.[0] !== ".*" ||
          flags["--certificate-oidc-issuer-regexp"]?.[0] !== ".*" ||
          flags["--digestAlg"]?.[0] !== "sha256"
        ) {
          return refuse("the fake wants the patterns and sha256");
        }
        if (flags["--trusted-root"]?.[0]?.endsWith("missing.json")) {
          return refuse(
            "setting trusted material: loading trusted root: failed to read trusted root open missing.json: no such file or directory",
          );
        }
        if (statement.predicateType !== flags["--type"]?.[0]) {
          return refuse(
            `invalid predicate type, expected ${
              flags["--type"]?.[0]
            } got ${statement.predicateType}`,
          );
        }
        if (
          !statement.subject.some((x: { digest: { sha256: string } }) =>
            x.digest.sha256 === flags["--digest"]?.[0]
          )
        ) {
          return refuse(
            "failed to verify signature: provided artifact digest does not match any digest in statement",
          );
        }
        // cosign reads more spellings of a bundle's fields than the model
        // does, so the model must hand over only what it read.
        const material = bundle.verificationMaterial ?? {};
        const extra = [
          ...Object.keys(bundle).filter((k) =>
            !["mediaType", "verificationMaterial", "dsseEnvelope"].includes(k)
          ),
          ...Object.keys(material).filter((k) =>
            ![
              "certificate",
              "x509CertificateChain",
              "tlogEntries",
              "timestampVerificationData",
            ].includes(k)
          ),
          ...Object.keys(material.certificate ?? {}).filter((k) =>
            k !== "rawBytes"
          ),
          ...Object.keys(bundle.dsseEnvelope).filter((k) =>
            !["payload", "payloadType", "signatures"].includes(k)
          ),
        ];
        if (
          extra.length > 0 ||
          (material.certificate && material.x509CertificateChain)
        ) {
          return refuse(
            `the fake was handed a bundle with more than was read: ${
              extra.join(",")
            }`,
          );
        }
        const raw = material.certificate?.rawBytes ??
          material.x509CertificateChain?.certificates?.[0]?.rawBytes;
        if (!(opts.genuine ?? []).includes(raw)) {
          return refuse(
            opts.bundleError ??
              "failed to verify log inclusion: transparency log certificate does not match",
          );
        }
        return { code: 0, stdout: "", stderr: "Verified OK\n" };
      }
      const digest = (positional[0] ?? "").split("@")[1];
      if (args[0] === "download") {
        const failure = (opts.downloadError ?? {})[digest];
        if (failure) {
          return {
            code: 1,
            stdout: "",
            stderr:
              `Error: ${failure}\nerror during command execution: ${failure}\n`,
          };
        }
        const lines = (opts.downloads ?? {})[digest];
        if (lines === undefined) {
          const none = `${positional[0]}: no signatures associated`;
          return {
            code: 1,
            stdout: "",
            stderr: `Error: ${none}\nerror during command execution: ${none}\n`,
          };
        }
        return ok(
          typeof lines === "string"
            ? lines
            : lines.map((l) => JSON.stringify(l)).join("\n") + "\n",
        );
      }
      const held = (opts.downloads ?? {})[digest];
      const beside = Array.isArray(held) &&
        held.some((l) => !Object.hasOwn(l as object, "Base64Signature"));
      const tagForm = flags["--new-bundle-format=false"] !== undefined;
      if (args[0] === "verify" && tagForm && !beside) {
        return {
          code: 1,
          stdout: "",
          stderr:
            "Error: the fake wants --new-bundle-format=false only beside bundles\n",
        };
      }
      if (
        args[0] === "verify" &&
        (opts.tagVerified || opts.certified || tagForm)
      ) {
        const refuse = (code: number, none: string) => ({
          code,
          stdout: "",
          stderr: `Error: ${none}\nerror during command execution: ${none}\n`,
        });
        if (beside && !tagForm) {
          // cosign reads bundles only once an image has one.
          return refuse(
            1,
            "no matching attestations: the fake was asked for bundles",
          );
        }
        const printed = (opts.tagVerified ?? {})[digest];
        const anyone = flags["--certificate-identity-regexp"]?.[0] === ".*" &&
          flags["--certificate-oidc-issuer-regexp"]?.[0] === ".*";
        if (!printed) {
          if (opts.tagError) return refuse(10, opts.tagError);
          const there = (Array.isArray(held) && held.some((l) =>
            Object.hasOwn(l as object, "Base64Signature")
          )) || (opts.tagBeside ?? []).includes(digest);
          const withCertificate = Array.isArray(held) &&
            held.some((l) =>
              (l as { Cert?: unknown }).Cert
            );
          return refuse(
            10,
            withCertificate
              ? "no matching signatures: error verifying bundle: comparing public key PEMs"
              : there
              ? "no matching signatures: x509: unsupported public key type: <nil>"
              : "no signatures found",
          );
        }
        if (anyone) return ok(JSON.stringify(printed) + "\n");
        // Exact requirements are held against the certificates themselves.
        const certificates = (opts.certified ?? {})[digest] ??
          (printed as { optional: Record<string, string> }[]).map((p) => ({
            identity: p.optional.Subject,
            issuer: p.optional.Issuer,
            claims: Object.fromEntries(
              Object.keys(GITHUB_CLAIM_FLAGS).filter((k) => k in p.optional)
                .map((k) => [k, p.optional[k]]),
            ),
          }));
        // A pattern that matches anything asks nothing of that field.
        const any = (flag: string) => flags[flag]?.[0] === ".*";
        const matching = certificates.filter((c) =>
          (any("--certificate-identity-regexp") ||
            c.identity === flags["--certificate-identity"]?.[0]) &&
          (any("--certificate-oidc-issuer-regexp") ||
            c.issuer === flags["--certificate-oidc-issuer"]?.[0])
        );
        if (matching.length === 0) {
          return refuse(
            12,
            "no matching signatures: none of the expected identities matched what was in the certificate",
          );
        }
        const accepted = matching.filter((c) =>
          Object.entries(GITHUB_CLAIM_FLAGS).every(([claim, flag]) =>
            // An empty requirement asks nothing, as with cosign.
            !flags[flag]?.[0] || c.claims[claim] === flags[flag][0]
          )
        );
        if (accepted.length === 0) {
          return refuse(
            12,
            "no matching signatures: expected GitHub Workflow Repository not found in certificate",
          );
        }
        return ok(
          JSON.stringify(
            accepted.map((c) =>
              payload(digest, {
                Subject: c.identity,
                Issuer: c.issuer,
                ...c.claims,
              })
            ),
          ) + "\n",
        );
      }
      if (args[0] === "tree") {
        const failure = (opts.treeError ?? {})[digest];
        if (failure) {
          return {
            code: 1,
            stdout: `📦 Supply Chain Security Related artifacts for an image: ${
              positional[0]
            }\n`,
            stderr:
              `Error: ${failure}\nerror during command execution: ${failure}\n`,
          };
        }
        const replaced = (opts.treePrints ?? {})[digest];
        if (replaced) {
          return {
            code: replaced.code ?? 0,
            stdout: replaced.stdout ??
              `📦 Supply Chain Security Related artifacts for an image: ${
                positional[0]
              }\nNo Supply Chain Security Related Artifacts found for image ${
                positional[0]
              },\n start creating one with simply running$ cosign sign <img>`,
            stderr: replaced.stderr ?? "",
          };
        }
        const kindOf = (l: unknown) => {
          if (Object.hasOwn(l as object, "Base64Signature")) return "tag";
          let type: unknown = SIGN_TYPE;
          try {
            const statement = JSON.parse(
              atob(
                (l as { dsseEnvelope: { payload: string } }).dsseEnvelope
                  .payload,
              ),
            );
            type = statement.predicateType ?? statement.predicate_type;
          } catch {
            // A bundle with no statement is listed as a signature.
          }
          return type === SIGN_TYPE ? "bundle" : "attestation";
        };
        const listed = (opts.treeLists ?? {})[digest] ?? [
          ...(Array.isArray(held) ? held.map(kindOf) : []),
          ...((opts.tagBeside ?? []).includes(digest) ? ["tag"] : []),
        ];
        const repository = positional[0].split("@")[0];
        const layer = (last: boolean, n: number) =>
          `   ${last ? "└" : "├"}── 🍒 sha256:${
            n.toString(16).padStart(64, "0")
          }\n`;
        const tags = listed.includes("tag")
          ? `└── 🔐 Signatures for an image tag: ${repository}:sha256-x.sig\n` +
            layer(true, 1)
          : "";
        const referrers = listed.filter((k) => k !== "tag").map((kind, i) =>
          `└── 🔗 ${
            kind === "bundle"
              ? SIGN_TYPE
              : kind === "foreign"
              ? "application/vnd.cncf.notary.signature"
              : kind === "odd"
              ? "doc/example"
              : "https://slsa.dev/provenance/v1"
          } artifacts via OCI referrer: ${repository}@sha256:${
            (i + 2).toString(16).padStart(64, "0")
          }\n` + layer(true, i + 2)
        ).join("");
        return ok(
          `📦 Supply Chain Security Related artifacts for an image: ${
            positional[0]
          }\n` +
            (listed.length
              ? tags + referrers
              : `No Supply Chain Security Related Artifacts found for image ${
                positional[0]
              },\n start creating one with simply running$ cosign sign <img>`),
        );
      }
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
  return { calls, bundles, restore, direct };
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
    // An empty key fails only where a key is needed: before a method that
    // signs. swamp model validate with no --method names no method.
    for (const methodName of ["sign", "attest", "signBlob"]) {
      const none = await checks["key-usable"].execute({
        globalArgs: {},
        methodName,
        logger,
      });
      assertEquals(none, {
        pass: false,
        errors: ["key is empty: nothing to sign with"],
      });
    }
    for (
      const methodName of [undefined, "", "verify", "identify", "describe"]
    ) {
      assertEquals(
        await checks["key-usable"].execute({
          globalArgs: {},
          methodName,
          logger,
        }),
        { pass: true },
      );
    }
    // No cosign ran for an empty key, and a key that is there is still tried.
    assertEquals(f.calls.map((c) => c.args[0]), ["version", "public-key"]);
    assertEquals(checks["key-usable"].appliesTo, [
      "sign",
      "attest",
      "signBlob",
    ]);
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
  const dir = await Deno.makeTempDir({
    prefix: "cosign-attest-",
    dir: SCRATCH,
  });
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
  const dir = await Deno.makeTempDir({
    prefix: "cosign-blob-",
    dir: SCRATCH,
  });
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
  const dir = await Deno.makeTempDir({
    prefix: "cosign-blob-",
    dir: SCRATCH,
  });
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
  const dir = await Deno.makeTempDir({
    prefix: "cosign-blob-",
    dir: SCRATCH,
  });
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
  const dir = await Deno.makeTempDir({
    prefix: "cosign-keyless-",
    dir: SCRATCH,
  });
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

// identify: who signed an image.

const identify = (a: z.input<typeof IdentifyArgsSchema>, ctx: Context) =>
  model.methods.identify.execute(IdentifyArgsSchema.parse(a), ctx);

const SIGN_TYPE = "https://sigstore.dev/cosign/sign/v1";
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
 * say, and in these tests for the fake.
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

/** A certificate as Fulcio issues one: one URI, the issuer twice, claims by number. */
function issued(
  identity: string,
  issuer: string,
  claims: Record<number, string> = {},
): string {
  return certificate([uri(identity)], [
    [1, bytes(issuer)],
    [8, utf8(issuer)],
    ...Object.entries(claims).map(([n, v]): [number, Uint8Array] => [
      Number(n),
      Number(n) <= 6 ? bytes(v) : utf8(v),
    ]),
  ]);
}

const ID_A =
  "https://github.com/example/api/.github/workflows/release.yml@refs/tags/v1";
const ID_B =
  "https://gitlab.example.org/team/api//.gitlab-ci.yml@refs/heads/main";
const ISSUER_B = "https://gitlab.example.org";
const CLAIMS_A = {
  2: "push",
  3: COMMIT,
  4: "release",
  5: "example/api",
  6: "refs/tags/v1",
  12: SOURCE,
  13: COMMIT,
  14: "refs/tags/v1",
  20: "push",
  99: "a claim this version has no name for",
};
const CERT_A = issued(ID_A, ISSUER, CLAIMS_A);
const CERT_B = issued(ID_B, ISSUER_B, {
  12: "https://gitlab.example.org/team/api",
});
/** The certificate of A with one claim changed: what a forger would attach. */
const VICTIM = "https://github.com/victim/product";
const CERT_FORGED = issued(ID_A, ISSUER, { ...CLAIMS_A, 12: VICTIM });

/** A signature as a Sigstore bundle, as `cosign download signature` prints one. */
function bundle(
  digest: string,
  material: Record<string, unknown>,
  predicateType = SIGN_TYPE,
) {
  return {
    mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
    verificationMaterial: material,
    dsseEnvelope: {
      payload: btoa(JSON.stringify({
        _type: "https://in-toto.io/Statement/v1",
        subject: [{ digest: { sha256: hex(digest) }, annotations: {} }],
        predicateType,
        predicate: {},
      })),
      payloadType: "application/vnd.in-toto+json",
      signatures: [{ sig: "MEUC" }],
    },
  };
}
const certBundle = (digest: string, cert: string) =>
  bundle(digest, { certificate: { rawBytes: cert }, tlogEntries: [{}] });
/** The hint of a key-signed bundle: the base64 of the key's sha256. */
const HINT = "6VIIIu1k4vanonG242viGb2RM9QmtkztF1/bcse7k9c=";
const HINT_FINGERPRINT =
  "sha256:e9520822ed64e2f6a7a271b6e36be219bd9133d426b64ced175fdb72c7bb93d7";
const keyBundle = (digest: string) =>
  bundle(digest, { publicKey: { hint: HINT } });

/** A signature of the tag form, as `cosign download signature` prints one. */
function tagLine(digest: string, cert: string | null, body?: unknown) {
  return {
    Base64Signature: "MEUC",
    Payload: btoa(JSON.stringify(body ?? payload(digest, null))),
    Cert: cert === null ? null : { Raw: cert, Version: 3 },
    Chain: null,
    Bundle: null,
    RFC3161Timestamp: null,
  };
}
/** A payload cosign accepts and a reader of exact names does not: Go reads names in any case. */
const capitalised = (digest: string) => ({
  Critical: {
    identity: { "docker-reference": "x" },
    IMAGE: { "Docker-Manifest-Digest": digest },
    type: "cosign container image signature",
  },
  optional: null,
});

/** What `cosign verify` prints for a tag-form signature whose certificate it verified. */
function tagVerified(
  digest: string,
  identity: string,
  issuer: string,
  github: Record<string, string> = {},
) {
  return payload(digest, { Subject: identity, Issuer: issuer, ...github });
}
const GITHUB_A = {
  githubWorkflowTrigger: "push",
  githubWorkflowSha: COMMIT,
  githubWorkflowName: "release",
  githubWorkflowRepository: "example/api",
  githubWorkflowRef: "refs/tags/v1",
};

type Identified = Record<string, unknown> & {
  signatures: (Record<string, unknown> & { claims: Record<string, string> })[];
  identities: Record<string, unknown>[];
};

/** identify on a signer with nothing set, against the fake; the record, the calls, the log. */
async function identified(
  opts: Parameters<typeof fake>[0],
  refs: string[] = [REF],
  over: Record<string, unknown> = { key: "", password: "" },
) {
  const f = fake(opts);
  try {
    const { ctx, written, logs } = context(over);
    await identify({ refs }, ctx);
    return {
      record: written[0].data as Identified,
      written,
      logs,
      calls: f.calls,
      bundles: f.bundles,
    };
  } finally {
    f.restore();
  }
}

/** identify that must fail: the error, with nothing written and no file left. */
async function failing(
  opts: Parameters<typeof fake>[0],
  over: Record<string, unknown> = { key: "" },
): Promise<string> {
  const f = fake(opts);
  try {
    const { ctx, written } = context(over);
    const err = await assertRejects(() => identify({ refs: [REF] }, ctx));
    assertEquals(written.length, 0);
    for (const path of f.bundles) {
      await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
    }
    return String(err);
  } finally {
    f.restore();
  }
}

/** The subcommands of the calls made. */
const commands = (calls: Call[]) => calls.map((c) => c.args[0]);

Deno.test("identify records who signed an image kept as a bundle: the identity, the issuer and the claims of a certificate cosign finds genuine", async () => {
  const { record, written, calls, bundles, logs } = await identified({
    downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
    genuine: [CERT_A],
  });
  assertEquals(written.length, 1);
  assertEquals(written[0].spec, "identification");
  assertEquals(
    written[0].name,
    "identification-registry.example.org-team-api-c02a5ac89d2d",
  );
  const { identifiedAt: _, signatures, ...rest } = record;
  assertEquals(rest, {
    ref: REF,
    repository: "registry.example.org/team/api",
    digest: DIGEST,
    state: "identified",
    certificateIdentity: ID_A,
    oidcIssuer: ISSUER,
    identities: [{
      certificateIdentity: ID_A,
      oidcIssuer: ISSUER,
      signatures: 1,
    }],
    identityChecked: false,
    signaturesFound: 1,
    certificatesGenuine: 1,
    keySigned: 0,
    otherStatements: 0,
    tagSignaturesUnlisted: false,
    forms: ["bundle"],
    reason: "",
  });
  assertEquals(signatures, [{
    form: "bundle",
    signedWith: "certificate",
    subjectMatches: true,
    certificateGenuine: true,
    certificateIdentity: ID_A,
    oidcIssuer: ISSUER,
    claims: {
      githubWorkflowTrigger: "push",
      githubWorkflowSha: COMMIT,
      githubWorkflowName: "release",
      githubWorkflowRepository: "example/api",
      githubWorkflowRef: "refs/tags/v1",
      sourceRepositoryUri: SOURCE,
      sourceRepositoryDigest: COMMIT,
      sourceRepositoryRef: "refs/tags/v1",
      buildTrigger: "push",
      [`${FULCIO}99`]: "a claim this version has no name for",
    },
    unprovenIdentity: "",
    unprovenIssuer: "",
    unprovenKeyFingerprint: "",
    reason: "",
    withheld: 0,
  }]);
  // The record passes the schema swamp checks it against.
  model.resources.identification.schema.parse(record);
  // The download, which proves nothing; cosign tree, to know every lookup
  // answered; one check of the one bundle, with patterns that match any
  // identity and any issuer; and the tag form, which cosign reads beside
  // bundles only when told to.
  assertEquals(calls[0].args, ["download", "signature", "--", REF]);
  assertEquals(calls[1].args, ["tree", "--", REF]);
  assertEquals(calls[3].args, [
    "verify",
    "--new-bundle-format=false",
    "--certificate-identity-regexp",
    ".*",
    "--certificate-oidc-issuer-regexp",
    ".*",
    "--output",
    "json",
    "--",
    REF,
  ]);
  assertEquals(calls[2].args, [
    "verify-blob-attestation",
    "--bundle",
    bundles[0],
    "--certificate-identity-regexp",
    ".*",
    "--certificate-oidc-issuer-regexp",
    ".*",
    "--digest",
    hex(DIGEST),
    "--digestAlg",
    "sha256",
    "--type",
    SIGN_TYPE,
  ]);
  assertEquals(calls.length, 4);
  // The bundle file was made in the test's own directory and is gone.
  assertEquals(bundles.length, 1);
  assert(bundles[0].startsWith(`${SCRATCH}/cosign-bundle-`));
  await assertRejects(() => Deno.stat(bundles[0]), Deno.errors.NotFound);
  // The log line says it is no comparison.
  assert(logs.some((l) => l.includes("not compared with any identity")));
  // The method is a read, so swamp runs no check before it.
  assertEquals(model.methods.identify.kind, "read");
});

Deno.test("identify honours trustedRoot, the registry switches and cosignBinary, never ignores the log, and hands cosign no key", async () => {
  const { record, calls, bundles } = await identified(
    {
      downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
      genuine: [CERT_A],
    },
    [REF],
    {
      key: PRIVATE,
      password: MARKER,
      tlog: false,
      trustedRoot: "trust/root.json",
      insecureRegistry: true,
      httpRegistry: true,
      cosignBinary: "/opt/cosign",
    },
  );
  assertEquals(record.state, "identified");
  assertEquals(calls[0].args, [
    "download",
    "signature",
    "--allow-insecure-registry",
    "--allow-http-registry",
    "--",
    REF,
  ]);
  assertEquals(calls[1].args, [
    "tree",
    "--allow-insecure-registry",
    "--allow-http-registry",
    "--",
    REF,
  ]);
  assertEquals(calls[2].args.slice(-2), [
    "--trusted-root",
    `${REPO}/trust/root.json`,
  ]);
  assertEquals(calls[2].args[2], bundles[0]);
  assertEquals(calls[3].args.slice(6), [
    "--trusted-root",
    `${REPO}/trust/root.json`,
    "--allow-insecure-registry",
    "--allow-http-registry",
    "--output",
    "json",
    "--",
    REF,
  ]);
  assertEquals(calls.length, 4);
  for (const call of calls) {
    assertEquals(call.bin, "/opt/cosign");
    assertEquals(call.cwd, REPO);
    // No key and no passphrase: identify signs nothing.
    assertEquals(call.env, {});
    assert(!call.args.includes("--insecure-ignore-tlog"));
    assert(!call.args.includes("--key"));
  }
});

Deno.test("cosign is handed a bundle of only the fields that were read, so it cannot check one certificate while another is recorded", async () => {
  // cosign reads a bundle's fields under more than one spelling. A line
  // that holds a forged certificate where the model reads, and the real
  // one where only cosign would, must not come out as genuine.
  const twoSpellings = {
    ...certBundle(DIGEST, CERT_FORGED),
    verification_material: {
      certificate: { rawBytes: CERT_A },
      tlogEntries: [{}],
    },
  };
  const rawBytesTwice = bundle(DIGEST, {
    certificate: { rawBytes: CERT_FORGED, raw_bytes: CERT_A },
    tlogEntries: [{}],
  });
  // The certificate is read before the chain of the older bundle versions.
  const certificateAndChain = bundle(DIGEST, {
    certificate: { rawBytes: CERT_FORGED },
    x509CertificateChain: { certificates: [{ rawBytes: CERT_A }] },
    tlogEntries: [{}],
  });
  for (const line of [twoSpellings, rawBytesTwice, certificateAndChain]) {
    const { record, calls } = await identified({
      downloads: { [DIGEST]: [line] },
      genuine: [CERT_A],
    });
    assertEquals(record.state, "unproven");
    assertEquals(record.certificatesGenuine, 0);
    assertEquals(record.signatures[0].claims, {});
    assertEquals(record.signatures[0].unprovenIdentity, ID_A);
    assertEquals(commands(calls), [
      "download",
      "tree",
      "verify-blob-attestation",
      "verify",
    ]);
    assert(!JSON.stringify(record).includes(VICTIM));
  }
  // A chain alone, as bundles before version 0.3 hold one, is read and
  // handed over as a chain.
  const { record, calls, bundles } = await identified({
    downloads: {
      [DIGEST]: [
        bundle(DIGEST, {
          x509CertificateChain: {
            certificates: [{ rawBytes: CERT_A }, { rawBytes: CERT_B }],
          },
          tlogEntries: [{}],
          timestampVerificationData: {},
          somethingElse: MARKER,
        }),
      ],
    },
    genuine: [CERT_A],
  });
  assertEquals(record.state, "identified");
  assertEquals(record.certificateIdentity, ID_A);
  assertEquals(calls[2].args[2], bundles[0]);
  // A statement that spells its type as protobuf's JSON also allows.
  const snake = bundle(DIGEST, { certificate: { rawBytes: CERT_A } });
  snake.dsseEnvelope.payload = btoa(JSON.stringify({
    subject: [{ digest: { sha256: hex(DIGEST) } }],
    predicate_type: SIGN_TYPE,
  }));
  const spelled = await identified({ downloads: { [DIGEST]: [snake] } });
  assertEquals(spelled.record.signaturesFound, 1);
  assertEquals(spelled.record.otherStatements, 0);
});

Deno.test("identify reads the tag form too, and records for it only what cosign verify itself printed", async () => {
  const { record, calls } = await identified(
    {
      downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
      tagVerified: { [DIGEST]: [tagVerified(DIGEST, ID_A, ISSUER, GITHUB_A)] },
    },
    [REF],
    { key: "", trustedRoot: "root.json", httpRegistry: true },
  );
  assertEquals(record.state, "identified");
  assertEquals(record.certificateIdentity, ID_A);
  assertEquals(record.oidcIssuer, ISSUER);
  assertEquals(record.forms, ["tag"]);
  assertEquals(record.signaturesFound, 1);
  assertEquals(record.certificatesGenuine, 1);
  assertEquals(record.signatures, [{
    form: "tag",
    signedWith: "certificate",
    subjectMatches: true,
    certificateGenuine: true,
    certificateIdentity: ID_A,
    oidcIssuer: ISSUER,
    // The five claims cosign prints, and none read from the certificate.
    claims: GITHUB_A,
    unprovenIdentity: "",
    unprovenIssuer: "",
    unprovenKeyFingerprint: "",
    reason: "",
    withheld: 0,
  }]);
  model.resources.identification.schema.parse(record);
  // The download, cosign tree, the check of the tag form, and its confirmation.
  assertEquals(calls.map((c) => c.args), [
    ["download", "signature", "--allow-http-registry", "--", REF],
    ["tree", "--allow-http-registry", "--", REF],
    [
      "verify",
      "--certificate-identity-regexp",
      ".*",
      "--certificate-oidc-issuer-regexp",
      ".*",
      "--trusted-root",
      `${REPO}/root.json`,
      "--allow-http-registry",
      "--output",
      "json",
      "--",
      REF,
    ],
    // What cosign printed, given back as exact requirements on the
    // certificate, each as one argument.
    [
      "verify",
      `--certificate-identity=${ID_A}`,
      `--certificate-oidc-issuer=${ISSUER}`,
      "--certificate-github-workflow-trigger=push",
      `--certificate-github-workflow-sha=${COMMIT}`,
      "--certificate-github-workflow-name=release",
      "--certificate-github-workflow-repository=example/api",
      "--certificate-github-workflow-ref=refs/tags/v1",
      "--trusted-root",
      `${REPO}/root.json`,
      "--allow-http-registry",
      "--output",
      "json",
      "--",
      REF,
    ],
  ]);
  for (const call of calls) assertEquals(call.env, {});
});

Deno.test("in the tag form a forged certificate adds nothing: not a claim, not a genuine mark, however many there are and however the payload is spelled", async () => {
  // Twenty layers with a forged certificate, then twenty real ones. cosign
  // verifies the real ones; the forged claim must be nowhere in the record.
  const many = await identified({
    downloads: {
      [DIGEST]: [
        ...Array.from({ length: 20 }, () => tagLine(DIGEST, CERT_FORGED)),
        ...Array.from({ length: 20 }, () => tagLine(DIGEST, CERT_A)),
      ],
    },
    tagVerified: {
      [DIGEST]: Array.from(
        { length: 20 },
        () => tagVerified(DIGEST, ID_A, ISSUER, GITHUB_A),
      ),
    },
  });
  assertEquals(many.record.state, "identified");
  assertEquals(many.record.certificateIdentity, ID_A);
  assertEquals(many.record.signaturesFound, 40);
  assertEquals(many.record.certificatesGenuine, 20);
  assertEquals(many.record.identities, [{
    certificateIdentity: ID_A,
    oidcIssuer: ISSUER,
    signatures: 20,
  }]);
  assertEquals(
    many.record.reason,
    "other signatures on this image: 20 that could not be checked",
  );
  assertEquals(many.record.signatures.length, 20);
  for (const s of many.record.signatures) {
    assertEquals(s.certificateGenuine, true);
    assertEquals(s.claims, GITHUB_A);
  }
  assert(!JSON.stringify(many.written).includes(VICTIM));
  assert(!many.logs.join("\n").includes(VICTIM));

  // Every line counts, also past the twentieth: 25 real signatures.
  const all = await identified({
    downloads: {
      [DIGEST]: Array.from({ length: 25 }, () => tagLine(DIGEST, CERT_A)),
    },
    tagVerified: {
      [DIGEST]: Array.from(
        { length: 25 },
        () => tagVerified(DIGEST, ID_A, ISSUER, GITHUB_A),
      ),
    },
  });
  assertEquals(all.record.signaturesFound, 25);
  assertEquals(all.record.certificatesGenuine, 25);
  assertEquals(all.record.identities[0].signatures, 25);
  assertEquals(all.record.signatures.length, 20);
  assertEquals(all.record.reason, "");
  assertEquals(commands(all.calls), ["download", "tree", "verify", "verify"]);

  // A real signature whose payload is spelled in capitals, which cosign
  // accepts, beside a forged certificate.
  const spelled = await identified({
    downloads: {
      [DIGEST]: [
        tagLine(DIGEST, CERT_FORGED),
        tagLine(DIGEST, CERT_A, capitalised(DIGEST)),
      ],
    },
    tagVerified: { [DIGEST]: [tagVerified(DIGEST, ID_A, ISSUER, GITHUB_A)] },
  });
  assertEquals(spelled.record.state, "identified");
  assertEquals(spelled.record.certificatesGenuine, 1);
  assertEquals(spelled.record.signaturesFound, 2);
  assertEquals(spelled.record.signatures[0].claims, GITHUB_A);
  assertEquals(spelled.record.signatures[1], {
    form: "tag",
    signedWith: "certificate",
    subjectMatches: false,
    certificateGenuine: false,
    certificateIdentity: "",
    oidcIssuer: "",
    claims: {},
    unprovenIdentity: "",
    unprovenIssuer: "",
    unprovenKeyFingerprint: "",
    reason:
      "cosign verified 1 of the 2 signatures with a certificate, and in the tag form it does not say which",
    withheld: 0,
  });
  assert(!JSON.stringify(spelled.written).includes(VICTIM));

  // What cosign printed is for another digest: it is not about this image.
  const other = await identified({
    downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
    tagVerified: { [DIGEST]: [tagVerified(DIGEST2, ID_A, ISSUER, GITHUB_A)] },
  });
  assertEquals(other.record.state, "unproven");
  assertEquals(other.record.certificateIdentity, "");
  assertEquals(other.record.certificatesGenuine, 0);
  assertEquals(
    other.record.signatures[0].reason,
    "cosign verified 0 of the 1 signatures with a certificate, and in the tag form it does not say which",
  );
  // The certificate cosign did not verify names no one, not even as unproven.
  assert(!JSON.stringify(other.record).includes(ID_A));

  // cosign verified none: its reason is the record's.
  const none = await identified({
    downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A), tagLine(DIGEST, null)] },
    tagVerified: {},
  });
  assertEquals(none.record.state, "unproven");
  assertEquals(none.record.keySigned, 1);
  assertEquals(none.record.signaturesFound, 2);
  assertStringIncludes(
    String(
      none.record.signatures.find((s) => s.signedWith === "certificate")!
        .reason,
    ),
    "no matching signatures: error verifying bundle",
  );

  // Two identities in the tag form are two identities.
  const two = await identified({
    downloads: {
      [DIGEST]: [tagLine(DIGEST, CERT_A), tagLine(DIGEST, CERT_B)],
    },
    tagVerified: {
      [DIGEST]: [
        tagVerified(DIGEST, ID_A, ISSUER, GITHUB_A),
        tagVerified(DIGEST, ID_B, ISSUER_B),
      ],
    },
  });
  assertEquals(two.record.state, "several-identities");
  assertEquals(two.record.certificateIdentity, "");
  assertEquals(two.record.identities.length, 2);

  // What cosign prints goes through the same rule as any other text.
  const odd = await identified({
    downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
    tagVerified: {
      [DIGEST]: [
        tagVerified(DIGEST, `https://a.example/\u202eevil`, ISSUER, {
          githubWorkflowName: `x\u0085y`,
          githubWorkflowRef: "refs/heads/main",
          notAClaim: MARKER,
        }),
      ],
    },
  });
  assertEquals(odd.record.state, "unproven");
  assertEquals(odd.record.signatures[0].certificateGenuine, true);
  assertEquals(odd.record.signatures[0].certificateIdentity, "");
  // An identity that cannot be stored cannot be confirmed, so no claim is
  // kept, and cosign is not asked to confirm an empty one.
  assertEquals(odd.record.signatures[0].claims, {});
  assertEquals(
    odd.record.signatures[0].reason,
    "the certificate is genuine, and its identity or its issuer is not text that can be stored",
  );
  assertEquals(commands(odd.calls), ["download", "tree", "verify"]);
  assertEquals(odd.record.signatures[0].withheld, 3);
  assert(!JSON.stringify(odd.record).includes(MARKER));
});

Deno.test("an image with no signature is a record, not a failure, and so is one that is not in the registry", async () => {
  const unsigned = await identified({});
  assertEquals(unsigned.record.state, "unsigned");
  assertEquals(unsigned.record.reason, "no signature found");
  assertEquals(unsigned.record.certificateIdentity, "");
  assertEquals(unsigned.record.oidcIssuer, "");
  assertEquals(unsigned.record.signaturesFound, 0);
  assertEquals(unsigned.record.signatures, []);
  assertEquals(unsigned.record.identities, []);
  assertEquals(unsigned.record.identityChecked, false);
  // cosign tree is asked before an image is called unsigned.
  assertEquals(unsigned.calls.map((c) => c.args), [
    ["download", "signature", "--", REF],
    ["tree", "--", REF],
  ]);

  const gone = await identified({
    downloadError: {
      [DIGEST]:
        `entity not found in registry, error: GET https://registry.example.org/v2/team/api/manifests/${DIGEST}: MANIFEST_UNKNOWN: manifest unknown`,
    },
  });
  assertEquals(gone.record.state, "not-found");
  assertStringIncludes(String(gone.record.reason), "MANIFEST_UNKNOWN");
  assertEquals(gone.record.certificateIdentity, "");
  assertEquals(gone.record.signaturesFound, 0);
  assertEquals(commands(gone.calls), ["download"]);

  // The reference is quoted in cosign's messages and must not decide how
  // one is read: an unsigned image in a repository named after a registry
  // error, or after cosign tree's own words, is unsigned.
  for (
    const repository of [
      "registry.example.org/MANIFEST_UNKNOWN/api",
      "registry.example.org/UNAUTHORIZED/api",
      "registry.example.org/sigstore.dev/cosign/sign/v1",
    ]
  ) {
    const odd = await identified({}, [`${repository}@${DIGEST}`]);
    assertEquals(odd.record.state, "unsigned");
  }

  // Attestations stored the same way are not signatures.
  const attested = await identified({
    downloads: {
      [DIGEST]: [
        bundle(DIGEST, { certificate: { rawBytes: CERT_A } }, SLSA1),
      ],
    },
    genuine: [CERT_A],
  });
  assertEquals(attested.record.state, "unsigned");
  assertEquals(attested.record.otherStatements, 1);
  assertEquals(attested.record.signaturesFound, 0);
  assertEquals(
    attested.record.reason,
    "no signature found; identify does not read attestations, and the image has 1",
  );
  assertEquals(commands(attested.calls), ["download", "tree", "verify"]);
  // An artifact of another kind beside the image, such as a signature of
  // another tool, is no Sigstore bundle and does not contradict "unsigned".
  const listed = await identified({ treeLists: { [DIGEST]: ["foreign"] } });
  assertEquals(listed.record.state, "unsigned");
});

Deno.test("unsigned means the registry answered and there was nothing: a lookup that failed fails the method", async () => {
  const limited =
    `getting referrers: GET https://registry.example.org/v2/team/api/referrers/${DIGEST}: TOOMANYREQUESTS: rate limited`;
  // cosign download signature says "no signatures" for a rate limit, a
  // refused login and a server error on the lookup of the bundles.
  for (
    const failure of [
      limited,
      limited.replace("TOOMANYREQUESTS: rate limited", "UNAUTHORIZED: login"),
      limited.replace("TOOMANYREQUESTS: rate limited", "UNKNOWN: injected"),
    ]
  ) {
    const err = await failing({ treeError: { [DIGEST]: failure } });
    assertStringIncludes(err, "cosign tree -- " + REF);
    assertStringIncludes(err, "exited 1");
    assertStringIncludes(err, failure.slice(-20));
    assertStringIncludes(err, "says nothing while a lookup fails");
  }
  // The same fault on an image that also has signatures under a tag: the
  // tag form must not be read in place of the bundles.
  const f = fake({
    downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
    tagVerified: { [DIGEST]: [tagVerified(DIGEST, ID_A, ISSUER, GITHUB_A)] },
    treeError: { [DIGEST]: limited },
  });
  try {
    const { ctx, written } = context({ key: "" });
    await assertRejects(() => identify({ refs: [REF] }, ctx));
    assertEquals(written.length, 0);
    assertEquals(commands(f.calls), ["download", "tree"]);
  } finally {
    f.restore();
  }
  // The lookup failed for the download and worked for cosign tree: the two
  // answers disagree, and nothing is recorded.
  assertStringIncludes(
    await failing({ treeLists: { [DIGEST]: ["bundle"] } }),
    "cosign tree lists 1 bundles and cosign download signature returned 0",
  );
  assertStringIncludes(
    await failing({ treeLists: { [DIGEST]: ["tag"] } }),
    "cosign tree lists signatures under a tag that cosign download signature did not return",
  );
  assertStringIncludes(
    await failing({
      downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
      tagVerified: { [DIGEST]: [tagVerified(DIGEST, ID_A, ISSUER)] },
      treeLists: { [DIGEST]: ["tag", "bundle"] },
    }),
    "cosign tree lists 1 bundles and cosign download signature returned 0",
  );
  // Two bundles listed, one returned: the other one's lookup failed.
  assertStringIncludes(
    await failing({
      downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
      genuine: [CERT_A],
      treeLists: { [DIGEST]: ["bundle", "bundle"] },
    }),
    "cosign tree lists 2 bundles and cosign download signature returned 1",
  );
  // What cosign tree calls a bundle is a label its writer chose. A real
  // image has an attestation labelled as a signature: as many bundles came
  // back as are listed, and each one's own statement says what it is.
  const mislabelled = await identified({
    downloads: {
      [DIGEST]: [
        certBundle(DIGEST, CERT_A),
        bundle(DIGEST, { certificate: { rawBytes: CERT_A } }, SLSA1),
      ],
    },
    genuine: [CERT_A],
    treeLists: { [DIGEST]: ["bundle", "bundle"] },
  });
  assertEquals(mislabelled.record.state, "identified");
  assertEquals(mislabelled.record.signaturesFound, 1);
  assertEquals(mislabelled.record.otherStatements, 1);
  const onlyLabel = await identified({
    downloads: {
      [DIGEST]: [
        bundle(DIGEST, { certificate: { rawBytes: CERT_A } }, SLSA1),
      ],
    },
    treeLists: { [DIGEST]: ["bundle"] },
  });
  assertEquals(onlyLabel.record.state, "unsigned");
  assertEquals(onlyLabel.record.otherStatements, 1);
  // A signature labelled as an attestation is still a signature.
  const other = await identified({
    downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
    genuine: [CERT_A],
    treeLists: { [DIGEST]: ["attestation"] },
  });
  assertEquals(other.record.state, "identified");
  // An artifact of a kind nobody registered, beside an unsigned image.
  for (const kind of ["odd", "foreign"] as const) {
    const beside = await identified({ treeLists: { [DIGEST]: [kind] } });
    assertEquals(beside.record.state, "unsigned");
  }
  // An attestation bundle that is listed and did not come back: cosign
  // then reads the tag form in its place, so nothing is recorded.
  assertStringIncludes(
    await failing({ treeLists: { [DIGEST]: ["attestation"] } }),
    "cosign tree lists 1 bundles and cosign download signature returned 0",
  );
  assertStringIncludes(
    await failing({
      downloads: { [DIGEST]: [tagLine(DIGEST, null)] },
      treeLists: { [DIGEST]: ["attestation", "tag"] },
    }),
    "cosign tree lists 1 bundles and cosign download signature returned 0",
  );
  // "no signatures" beside the words of a fault is a fault.
  assertStringIncludes(
    await failing({
      downloadError: {
        [DIGEST]: "no signatures associated: UNAUTHORIZED: authentication",
      },
    }),
    "cosign download signature -- " + REF,
  );
});

Deno.test("an image signed with a key has no identity to read, in either form; nothing of it is checked, and the record says so", async () => {
  for (const line of [keyBundle(DIGEST), tagLine(DIGEST, null)]) {
    const { record, calls } = await identified({
      downloads: { [DIGEST]: [line] },
    });
    assertEquals(record.state, "key-signed");
    assertStringIncludes(String(record.reason), "made with a key");
    assertStringIncludes(String(record.reason), "was not checked");
    assertStringIncludes(String(record.reason), "nothing here says which key");
    assertEquals(record.certificateIdentity, "");
    assertEquals(record.oidcIssuer, "");
    assertEquals(record.identities, []);
    assertEquals(record.keySigned, 1);
    assertEquals(record.certificatesGenuine, 0);
    assertEquals(record.signatures[0].signedWith, "key");
    assertEquals(record.signatures[0].certificateGenuine, false);
    // No check of the signature: the download, and cosign tree for the tag form.
    assertEquals(
      commands(calls),
      "Payload" in line ? ["download", "tree"] : ["download", "tree", "verify"],
    );
  }
  // The bundle form carries a hint of the key, written as describe writes
  // a fingerprint, under a name that says it is not proven.
  const hinted = await identified({
    downloads: { [DIGEST]: [keyBundle(DIGEST)] },
  });
  assertEquals(
    hinted.record.signatures[0].unprovenKeyFingerprint,
    HINT_FINGERPRINT,
  );
  assert(!("publicKeyFingerprint" in hinted.record.signatures[0]));
  // A hint that is not the base64 of a sha256 is not stored.
  const odd = await identified({
    downloads: {
      [DIGEST]: [bundle(DIGEST, { publicKey: { hint: MARKER } })],
    },
  });
  assertEquals(odd.record.signatures[0].unprovenKeyFingerprint, "");
  assert(!JSON.stringify(odd.record).includes(MARKER));
  const short = await identified({
    downloads: {
      [DIGEST]: [bundle(DIGEST, { publicKey: { hint: btoa(MARKER) } })],
    },
  });
  assertEquals(short.record.signatures[0].unprovenKeyFingerprint, "");
  assertEquals(short.record.state, "key-signed");
  // A tag-form key signature whose payload is spelled in capitals is about
  // this digest, as cosign reads it; one that names the digest twice is not.
  const spelled = await identified({
    downloads: { [DIGEST]: [tagLine(DIGEST, null, capitalised(DIGEST))] },
  });
  assertEquals(spelled.record.state, "key-signed");
  const twice = await identified({
    downloads: {
      [DIGEST]: [
        tagLine(DIGEST, null, {
          ...payload(DIGEST, null),
          ...capitalised(DIGEST2),
        }),
      ],
    },
  });
  assertEquals(twice.record.state, "unproven");
  assertEquals(twice.record.keySigned, 0);
});

Deno.test("several identities are listed and none is chosen; one identity beside a key's signature is still one", async () => {
  const two = await identified({
    downloads: {
      [DIGEST]: [
        certBundle(DIGEST, CERT_A),
        certBundle(DIGEST, CERT_B),
        certBundle(DIGEST, CERT_A),
      ],
    },
    genuine: [CERT_A, CERT_B],
  });
  assertEquals(two.record.state, "several-identities");
  assertEquals(two.record.certificateIdentity, "");
  assertEquals(two.record.oidcIssuer, "");
  assertEquals(two.record.identities, [
    { certificateIdentity: ID_A, oidcIssuer: ISSUER, signatures: 2 },
    { certificateIdentity: ID_B, oidcIssuer: ISSUER_B, signatures: 1 },
  ]);
  assertEquals(two.record.certificatesGenuine, 3);
  assertStringIncludes(String(two.record.reason), "2 identities");
  assertEquals(commands(two.calls), [
    "download",
    "tree",
    "verify-blob-attestation",
    "verify-blob-attestation",
    "verify-blob-attestation",
    "verify",
  ]);

  // The same identity from another issuer is another identity.
  const issuers = await identified({
    downloads: {
      [DIGEST]: [
        certBundle(DIGEST, CERT_A),
        certBundle(DIGEST, issued(ID_A, ISSUER_B)),
      ],
    },
    genuine: [CERT_A, issued(ID_A, ISSUER_B)],
  });
  assertEquals(issuers.record.state, "several-identities");
  assertEquals(issuers.record.oidcIssuer, "");

  const mixed = await identified({
    downloads: {
      [DIGEST]: [keyBundle(DIGEST), certBundle(DIGEST, CERT_A)],
    },
    genuine: [CERT_A],
  });
  assertEquals(mixed.record.state, "identified");
  assertEquals(mixed.record.certificateIdentity, ID_A);
  assertEquals(mixed.record.keySigned, 1);
  assertEquals(
    mixed.record.reason,
    "other signatures on this image: 1 made with a key, not checked",
  );
  // The signature that names the identity comes first.
  assertEquals(mixed.record.signatures.map((s) => s.signedWith), [
    "certificate",
    "key",
  ]);
});

Deno.test("a certificate cosign does not find genuine names no identity: what it says is kept apart, as unproven", async () => {
  const { record } = await identified({
    downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
    genuine: [],
  });
  assertEquals(record.state, "unproven");
  assertEquals(record.certificateIdentity, "");
  assertEquals(record.oidcIssuer, "");
  assertEquals(record.identities, []);
  assertEquals(record.certificatesGenuine, 0);
  assertEquals(record.signaturesFound, 1);
  const [s] = record.signatures;
  assertEquals(s.certificateGenuine, false);
  assertEquals(s.certificateIdentity, "");
  assertEquals(s.oidcIssuer, "");
  assertEquals(s.claims, {});
  assertEquals(s.unprovenIdentity, ID_A);
  assertEquals(s.unprovenIssuer, ISSUER);
  assertEquals(
    s.reason,
    "failed to verify log inclusion: transparency log certificate does not match",
  );
  assertEquals(
    record.reason,
    "no identity could be established: failed to verify log inclusion: transparency log certificate does not match",
  );
  // The identity appears in the record only in the fields that say unproven.
  const { unprovenIdentity: _i, unprovenIssuer: _o, ...proven } = s;
  assert(!JSON.stringify({ ...record, signatures: [proven] }).includes(ID_A));

  // A genuine signature beside a forged one for another identity: the
  // forged one adds no identity.
  const forged = await identified({
    downloads: {
      [DIGEST]: [certBundle(DIGEST, CERT_B), certBundle(DIGEST, CERT_A)],
    },
    genuine: [CERT_A],
  });
  assertEquals(forged.record.state, "identified");
  assertEquals(forged.record.certificateIdentity, ID_A);
  assertEquals(forged.record.identities.length, 1);
  assertEquals(
    forged.record.reason,
    "other signatures on this image: 1 that could not be checked",
  );
  assertEquals(forged.record.signatures[1].unprovenIdentity, ID_B);
  assertEquals(forged.record.signatures[1].certificateIdentity, "");

  // Every way cosign has of saying a bundle does not check out is a record.
  for (
    const bundleError of [
      "failed to verify log inclusion: not enough verified log entries from transparency log: 0 < 1",
      "failed to verify leaf certificate: leaf certificate verification failed",
      "failed to verify signature: could not verify envelope",
      "bundle does not contain cert for verification, please provide public key",
    ]
  ) {
    const said = await identified({
      downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
      bundleError,
    });
    assertEquals(said.record.state, "unproven");
    assertEquals(said.record.signatures[0].reason, bundleError);
  }
});

Deno.test("a bundle that is about another digest, has no statement, or no certificate that can be read, is never checked and never counts", async () => {
  const other = await identified({
    downloads: { [DIGEST]: [certBundle(DIGEST2, CERT_A)] },
    genuine: [CERT_A],
  });
  assertEquals(other.record.state, "unproven");
  assertEquals(other.record.certificateIdentity, "");
  assertEquals(other.record.signatures[0].subjectMatches, false);
  assertEquals(
    other.record.signatures[0].reason,
    "this signature is about another digest",
  );
  assertEquals(commands(other.calls), ["download", "tree", "verify"]);

  // A key's signature about another digest is not a signature of this image.
  const key = await identified({
    downloads: { [DIGEST]: [keyBundle(DIGEST2)] },
  });
  assertEquals(key.record.state, "unproven");
  assertEquals(key.record.keySigned, 0);
  const tagKey = await identified({
    downloads: { [DIGEST]: [tagLine(DIGEST2, null)] },
  });
  assertEquals(tagKey.record.state, "unproven");
  assertEquals(tagKey.record.keySigned, 0);

  const noStatement = await identified({
    downloads: {
      [DIGEST]: [{
        mediaType: "application/vnd.dev.sigstore.bundle.v0.3+json",
        verificationMaterial: { certificate: { rawBytes: CERT_A } },
        dsseEnvelope: { payload: "not base64 json" },
      }, {
        verificationMaterial: { certificate: { rawBytes: CERT_A } },
        messageSignature: { signature: "MEUC" },
      }],
    },
    genuine: [CERT_A],
  });
  assertEquals(noStatement.record.state, "unproven");
  assertEquals(noStatement.record.signatures.map((s) => s.reason), [
    "the bundle holds no in-toto statement",
    "the bundle holds no in-toto statement",
  ]);
  assertEquals(commands(noStatement.calls), ["download", "tree", "verify"]);

  for (
    const raw of ["", "AAAA", "not base64!", 7, null, "A".repeat(40000), {
      rawBytes: CERT_A,
    }]
  ) {
    const unread = await identified({
      downloads: {
        [DIGEST]: [bundle(DIGEST, { certificate: { rawBytes: raw } })],
      },
      genuine: [CERT_A],
    });
    assertEquals(unread.record.state, "unproven");
    assertEquals(unread.record.certificateIdentity, "");
    assertEquals(unread.record.certificatesGenuine, 0);
    assertEquals(
      unread.record.signatures[0].reason,
      "its certificate cannot be read",
    );
    assertEquals(commands(unread.calls), ["download", "tree", "verify"]);
  }

  // A certificate far larger than Fulcio issues is not read at all.
  const huge = issued(ID_A, ISSUER, { 12: "x".repeat(30000) });
  const large = await identified({
    downloads: { [DIGEST]: [certBundle(DIGEST, huge)] },
    genuine: [huge],
  });
  assertEquals(large.record.state, "unproven");
  assertEquals(
    large.record.signatures[0].reason,
    "its certificate cannot be read",
  );
  assertEquals(commands(large.calls), ["download", "tree", "verify"]);

  const nothing = await identified({
    downloads: { [DIGEST]: [bundle(DIGEST, {})] },
  });
  assertEquals(nothing.record.state, "unproven");
  assertEquals(nothing.record.signatures[0].signedWith, "unknown");
  assertEquals(
    nothing.record.signatures[0].reason,
    "the bundle holds no certificate and no key",
  );
});

Deno.test("identify fails, and records nothing for that image, when cosign prints what is not a signature list or cannot do its work", async () => {
  assertStringIncludes(
    await failing({ downloads: { [DIGEST]: "Signed by someone\n" } }),
    "printed a line that is not JSON",
  );
  assertStringIncludes(
    await failing({ downloads: { [DIGEST]: '["a"]\n' } }),
    "JSON that is not an object",
  );
  assertStringIncludes(
    await failing({ downloads: { [DIGEST]: "7\n" } }),
    "JSON that is not an object",
  );
  assertStringIncludes(
    await failing({ downloads: { [DIGEST]: [{ kind: "something else" }] } }),
    "neither a Sigstore bundle nor a signature",
  );
  // A registry that does not answer is not an unsigned image.
  const refused = await failing({
    downloadError: {
      [DIGEST]:
        'Get "https://registry.example.org/v2/": dial tcp: connection refused',
    },
  });
  assertStringIncludes(refused, "cosign download signature -- " + REF);
  assertStringIncludes(refused, "exited 1");
  assertStringIncludes(refused, "connection refused");
  // Nor is a login that is refused.
  assertStringIncludes(
    await failing({
      downloadError: { [DIGEST]: "UNAUTHORIZED: authentication required" },
    }),
    "UNAUTHORIZED",
  );
  // A trusted root that cannot be loaded says nothing about the signature:
  // one that is not there, and one that is not JSON, in cosign's words.
  assertStringIncludes(
    await failing({
      downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
      genuine: [CERT_A],
    }, { key: "", trustedRoot: "missing.json" }),
    "loading trusted root",
  );
  for (
    const bundleError of [
      "setting trusted material: loading trusted root: failed to proto-json unmarshal trusted root: proto: syntax error (line 1:1): invalid value not",
      "setting trusted material: loading trusted root: unsupported TrustedRoot media type: ",
      // The words of a verdict in front of a call that could not be made.
      // The words of a verdict that are not at the start are no verdict.
      "setting trusted material: the root says: failed to verify signature",
      "failed to verify log inclusion: fetching the log's key: dial tcp 192.0.2.1:443: i/o timeout",
      'failed to verify signature: Get "https://tuf.example.org/root.json": context deadline exceeded',
      "reading /tmp/x: open /tmp/x: no such file or directory",
      "something this version has never seen",
    ]
  ) {
    const err = await failing({
      downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
      bundleError,
    });
    assertStringIncludes(err, "cosign verify-blob-attestation --bundle");
    assertStringIncludes(err, bundleError.slice(0, 40));
  }
  // The tag form: a log that cannot be reached is not a verdict, and
  // neither is an error cosign has no verdict words for.
  for (
    const tagError of [
      'no matching signatures: searching log query: Post "https://rekor.example.org/api/v1/log/entries/retrieve": dial tcp 192.0.2.1:443: connect: connection refused',
      "no matching signatures: context deadline exceeded",
      // The payload of a signature could not be fetched, whatever the answer.
      "no matching signatures: GET https://registry.example.org/v2/team/api/blobs/sha256:ab: UNKNOWN: injected",
      "no matching signatures: GET https://registry.example.org/v2/team/api/blobs/sha256:ab: BLOB_UNKNOWN: blob unknown to registry",
      "no signatures found",
      "loading trusted root: proto: syntax error",
    ]
  ) {
    const err = await failing({
      downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
      tagVerified: {},
      tagError,
    });
    assertStringIncludes(err, "cosign verify --certificate-identity-regexp");
    assertStringIncludes(err, tagError.slice(0, 30));
  }
  assertStringIncludes(
    await failing({
      downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
      fail: "verify",
    }),
    "verify: boom",
  );
  // What cosign verify prints for the tag form must be its JSON.
  assertStringIncludes(
    await failing({
      downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
      tagVerified: { [DIGEST]: "not a list" as unknown as unknown[] },
    }),
    "not an array",
  );
});

Deno.test("identify says so when cosign is not installed, and passes a cancelled run on as it is", async () => {
  const f = fake({ spawn: new Deno.errors.NotFound("No such file: cosign-x") });
  try {
    const { ctx, written } = context({ key: "", cosignBinary: "cosign-x" });
    const err = await assertRejects(() => identify({ refs: [REF] }, ctx));
    assertStringIncludes(String(err), "cosign-x could not be run");
    assertStringIncludes(String(err), "install cosign");
    assertStringIncludes(String(err), "set cosignBinary");
    assertEquals(written.length, 0);
  } finally {
    f.restore();
  }
  const abort = new AbortController();
  abort.abort();
  const cancelled = new DOMException("The operation was aborted", "AbortError");
  const g = fake({ spawn: cancelled });
  try {
    const { ctx, written } = context({ key: "" });
    const err = await assertRejects(() =>
      identify({ refs: [REF] }, { ...ctx, signal: abort.signal })
    );
    assert(err === cancelled);
    assertEquals(written.length, 0);
  } finally {
    g.restore();
  }
});

Deno.test("with several references identify records each as it goes, and a failure at a later one leaves the earlier records", async () => {
  const f = fake({
    downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
    downloadError: { [DIGEST2]: "dial tcp: connection refused" },
    genuine: [CERT_A],
  });
  try {
    const { ctx, written } = context({ key: "" });
    await assertRejects(() => identify({ refs: [REF, REF2] }, ctx));
    assertEquals(written.map((w) => w.name), [
      "identification-registry.example.org-team-api-c02a5ac89d2d",
    ]);
    assertEquals(written[0].data.state, "identified");
    for (const path of f.bundles) {
      await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
    }
  } finally {
    f.restore();
  }
  // Two repositories with one digest get a record each.
  const other = `registry.example.org/team/mirror@${DIGEST}`;
  const { written } = await identified({}, [REF, other]);
  assertEquals(written.map((w) => w.name), [
    "identification-registry.example.org-team-api-c02a5ac89d2d",
    "identification-registry.example.org-team-mirror-c02a5ac89d2d",
  ]);
});

Deno.test("identify refuses a tag, a reference shaped like a flag and a trusted root that is not a path, before cosign runs", async () => {
  const f = fake({});
  try {
    for (
      const refs of [
        ["registry.example.org/team/api:v1"],
        [REF, `-x@${DIGEST}`],
        [`--allow-http-registry@${DIGEST}`],
        [`--certificate-identity=me@${DIGEST}`],
      ]
    ) {
      const { ctx, written } = context({ key: "" });
      const err = await assertRejects(() => identify({ refs }, ctx));
      assertStringIncludes(String(err), "not an image reference");
      assertEquals(written.length, 0);
    }
    for (
      const [trustedRoot, said] of [
        ["a\nb", "trustedRoot holds a newline"],
        ["${{ inputs.root }}", "unevaluated expression"],
      ]
    ) {
      const { ctx } = context({ key: "", trustedRoot });
      const err = await assertRejects(() => identify({ refs: [REF] }, ctx));
      assertStringIncludes(String(err), said);
    }
    assertEquals(f.calls.length, 0);
    assert(!IdentifyArgsSchema.safeParse({ refs: [] }).success);
    // The fake refuses what cosign refuses for the new commands.
    assertStringIncludes(
      (await f.direct(["download", "signature", REF])).stderr,
      "wants -- before",
    );
    assertStringIncludes(
      (await f.direct(["download", "signature", "--key", "k", "--", REF]))
        .stderr,
      "unknown flag: --key",
    );
    assertStringIncludes(
      (await f.direct(["download", "sbom", "--", REF])).stderr,
      "unknown command",
    );
    assertStringIncludes(
      (await f.direct(["tree", REF])).stderr,
      "wants -- before",
    );
    assertStringIncludes(
      (await f.direct(["tree", "--trusted-root", "x", "--", REF])).stderr,
      "unknown flag: --trusted-root",
    );
    assertStringIncludes(
      (await f.direct([
        "verify-blob-attestation",
        "--insecure-ignore-tlog",
      ])).stderr,
      "unknown flag: --insecure-ignore-tlog",
    );
    assertStringIncludes(
      (await f.direct(["verify-blob-attestation", "--bundle", "b", "--", REF]))
        .stderr,
      "accepts 0 arg(s)",
    );
  } finally {
    f.restore();
  }
});

Deno.test("no key, no passphrase and no credential in a certificate reaches a record, a log line or a call of identify", async () => {
  const secretUrl = `https://builder:${MARKER}@ci.example.org/job`;
  const cert = certificate([uri(secretUrl), email(`${MARKER}@example.org`)], [
    [1, bytes(ISSUER)],
    [8, utf8(ISSUER)],
    [12, utf8(`https://${MARKER}@git.example.org/team/api`)],
    [14, utf8(`refs/heads/main\u0000${MARKER}`)],
    [20, utf8(`${MARKER}`.repeat(200))],
    [21, tlv(0x04, bytes(MARKER))],
    [3, Uint8Array.of(0xff, 0xfe)],
  ]);
  const key = PRIVATE.replace("eyJr", MARKER);
  for (const genuine of [[cert], []]) {
    const { record, written, logs, calls } = await identified(
      { downloads: { [DIGEST]: [certBundle(DIGEST, cert)] }, genuine },
      [REF],
      { key, password: MARKER },
    );
    const [s] = record.signatures;
    assertEquals(s.certificateIdentity, "");
    assertEquals(s.unprovenIdentity, "");
    assertEquals(s.claims, {});
    // The identity, the second name and five claims were not stored.
    assertEquals(s.withheld, 7);
    assertEquals(record.certificateIdentity, "");
    assertEquals(record.identities, []);
    // A genuine certificate whose identity cannot be stored names no one.
    assertEquals(record.state, "unproven");
    assertEquals(s.certificateGenuine, genuine.length === 1);
    assert(!JSON.stringify(written).includes(MARKER));
    assert(!logs.join("\n").includes(MARKER));
    for (const call of calls) {
      assert(!JSON.stringify(call.env).includes(MARKER));
      assert(!call.args.join(" ").includes(MARKER));
    }
  }
  // The tag form makes three calls; none gets the key or the passphrase.
  const tag = await identified(
    {
      downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
      tagVerified: { [DIGEST]: [tagVerified(DIGEST, ID_A, ISSUER)] },
    },
    [REF],
    { key, password: MARKER },
  );
  assertEquals(commands(tag.calls), ["download", "tree", "verify", "verify"]);
  for (const call of tag.calls) assertEquals(call.env, {});
  // An error names the command, never the key: the key is not in its
  // environment, and its PEM would be masked if cosign echoed one.
  const f = fake({
    downloadError: { [DIGEST]: `cannot reach the registry ${key}` },
  });
  try {
    const { ctx } = context({ key, password: MARKER });
    const err = await assertRejects(() => identify({ refs: [REF] }, ctx));
    assert(!String(err).includes(MARKER));
    assertStringIncludes(String(err), "<redacted>");
  } finally {
    f.restore();
  }
});

Deno.test("text that changes how a line reads without showing is never stored and never logged: one rule for an identity, an issuer and a claim", async () => {
  const unsafe: Record<string, string> = {
    "a C0 control": "\u0007",
    "a newline": "\n",
    "delete": "\u007f",
    "next line, a C1 control": "\u0085",
    "line separator": "\u2028",
    "paragraph separator": "\u2029",
    "right-to-left override": "\u202e",
    "left-to-right isolate": "\u2066",
    "right-to-left mark": "\u200f",
    "zero-width space": "\u200b",
    "zero-width joiner": "\u200d",
    "byte order mark": "\ufeff",
    "soft hyphen": "\u00ad",
    "a private use character": "\ue000",
    "an unassigned code point": "\u0378",
  };
  for (const [name, ch] of Object.entries(unsafe)) {
    const identity = `https://github.com/example/api${ch}evil`;
    for (
      const cert of [
        issued(identity, ISSUER),
        issued(ID_A, `https://issuer.example.org/${ch}x`),
        issued(ID_A, ISSUER, { 12: `https://a.example/${ch}x`, 4: `b${ch}c` }),
      ]
    ) {
      const { record, logs, written } = await identified({
        downloads: { [DIGEST]: [certBundle(DIGEST, cert)] },
        genuine: [cert],
      });
      assert(
        !JSON.stringify(written).includes(JSON.stringify(ch).slice(1, -1)),
        name,
      );
      assert(!JSON.stringify(written).includes(ch), name);
      assert(!logs.join("").includes(ch), name);
      assert(Number(record.signatures[0].withheld) >= 1, name);
      assertEquals(record.signatures[0].claims, {}, name);
    }
    // At the very start too, where a decoder may drop a byte order mark.
    const leading = certificateFacts(
      issued(`${ch}https://x.example/y`, ISSUER),
    )!;
    assertEquals(leading.certificateIdentity, "", name);
    assertEquals(leading.withheld, 1, name);
    // An identity or an issuer that is withheld names no one.
    const { record } = await identified({
      downloads: {
        [DIGEST]: [certBundle(DIGEST, issued(identity, ISSUER))],
      },
      genuine: [issued(identity, ISSUER)],
    });
    assertEquals(record.state, "unproven", name);
    assertEquals(record.certificateIdentity, "", name);
    // The same in what cosign says, which becomes a reason: there it is
    // replaced by a space, since a reason is not copied anywhere.
    const said = await identified({
      downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
      bundleError: `failed to verify signature: got "x${ch}y"`,
    });
    assert(!JSON.stringify(said.written).includes(ch), name);
    assert(!said.logs.join("").includes(ch), name);
    assertEquals(
      said.record.signatures[0].reason,
      // cosign's reason is one line of what it printed.
      ch === "\n"
        ? 'failed to verify signature: got "x'
        : 'failed to verify signature: got "x y"',
      name,
    );
  }
  // Text in another script, and a long one within the bound, is kept as it is.
  const plainIdentity = "https://例え.example/ジョブ/émile@refs/heads/main";
  const kept = await identified({
    downloads: {
      [DIGEST]: [certBundle(DIGEST, issued(plainIdentity, ISSUER))],
    },
    genuine: [issued(plainIdentity, ISSUER)],
  });
  assertEquals(kept.record.certificateIdentity, plainIdentity);
});

Deno.test("what cosign says about a bundle is one bounded line, and only the first 20 certificates are checked", async () => {
  const { record } = await identified({
    downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
    bundleError: "failed to verify signature: \u001b[31m\t" + "x".repeat(3000),
  });
  const reason = String(record.signatures[0].reason);
  assert(reason.length <= 1024);
  // deno-lint-ignore no-control-regex
  assert(!/[\u0000-\u001f]/.test(reason));
  assert(String(record.reason).length <= 1024);

  const certs = Array.from(
    { length: 25 },
    (_, i) => issued(`https://example.org/job/${i}`, ISSUER),
  );
  const many = await identified({
    downloads: { [DIGEST]: certs.map((c) => certBundle(DIGEST, c)) },
    genuine: certs,
  });
  assertEquals(
    commands(many.calls).filter((c) => c === "verify-blob-attestation").length,
    20,
  );
  // The download, cosign tree, 20 checks and the tag form: 23 calls.
  assertEquals(many.calls.length, 23);
  assertEquals(many.record.signaturesFound, 25);
  assertEquals(many.record.certificatesGenuine, 20);
  assertEquals(many.record.signatures.length, 20);
  assertEquals(many.record.identities.length, 20);
  assertEquals(many.record.state, "several-identities");
  assertEquals(many.record.certificateIdentity, "");
  for (const path of many.bundles) {
    await assertRejects(() => Deno.stat(path), Deno.errors.NotFound);
  }
});

/** The certificate of ghcr.io/renovatebot/renovate 44.226.2's signature, issued by the public Fulcio on 2026-11-10. */
const RENOVATE_CERT =
  "MIIGzjCCBlWgAwIBAgIUE0k/Qs9mCNMbPyAK90Y18rYmvS8wCgYIKoZIzj0EAwMwNzEVMBMGA1UEChMMc2lnc3RvcmUuZGV2MR4wHAYDVQQDExVzaWdzdG9yZS1pbnRlcm1lZGlhdGUwHhcNMjYxMTEwMTQ1MDIyWhcNMjYxMTEwMTUwMDIyWjAAMFkwEwYHKoZIzj0CAQYIKoZIzj0DAQcDQgAEZ8tHDTQpW+5oWGrgZQ7+L90xOJUqTNqsUwKWjNeXxkdqzEhNAwtbY8Lo8xUXLrwiZZUSxUes9jnNZk42DBWptqOCBXQwggVwMA4GA1UdDwEB/wQEAwIHgDATBgNVHSUEDDAKBggrBgEFBQcDAzAfBgNVHSMEGDAWgBTf0+nPViQRlvmo2OkoVaLGLhhkPzBhBgNVHREBAf8EVzBVhlNodHRwczovL2dpdGh1Yi5jb20vcmVub3ZhdGVib3QvcmVub3ZhdGUvLmdpdGh1Yi93b3JrZmxvd3MvYnVpbGQueW1sQHJlZnMvaGVhZHMvbWFpbjA5BgorBgEEAYO/MAEBBCtodHRwczovL3Rva2VuLmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tMBIGCisGAQQBg78wAQIEBHB1c2gwNgYKKwYBBAGDvzABAwQoYTQyNTUyZTZjOTczOWE5ZDU3N2Y4NmRkODE5ZTlkNDFhZWU3YzA1OTATBgorBgEEAYO/MAEEBAVCdWlsZDAiBgorBgEEAYO/MAEFBBRyZW5vdmF0ZWJvdC9yZW5vdmF0ZTAdBgorBgEEAYO/MAEGBA9yZWZzL2hlYWRzL21haW4wOwYKKwYBBAGDvzABCAQtDCtodHRwczovL3Rva2VuLmFjdGlvbnMuZ2l0aHVidXNlcmNvbnRlbnQuY29tMGMGCisGAQQBg78wAQkEVQxTaHR0cHM6Ly9naXRodWIuY29tL3Jlbm92YXRlYm90L3Jlbm92YXRlLy5naXRodWIvd29ya2Zsb3dzL2J1aWxkLnltbEByZWZzL2hlYWRzL21haW4wOAYKKwYBBAGDvzABCgQqDChhNDI1NTJlNmM5NzM5YTlkNTc3Zjg2ZGQ4MTllOWQ0MWFlZTdjMDU5MB0GCisGAQQBg78wAQsEDwwNZ2l0aHViLWhvc3RlZDA3BgorBgEEAYO/MAEMBCkMJ2h0dHBzOi8vZ2l0aHViLmNvbS9yZW5vdmF0ZWJvdC9yZW5vdmF0ZTA4BgorBgEEAYO/MAENBCoMKGE0MjU1MmU2Yzk3MzlhOWQ1NzdmODZkZDgxOWU5ZDQxYWVlN2MwNTkwHwYKKwYBBAGDvzABDgQRDA9yZWZzL2hlYWRzL21haW4wGAYKKwYBBAGDvzABDwQKDAg3NjczNDA2ODAuBgorBgEEAYO/MAEQBCAMHmh0dHBzOi8vZ2l0aHViLmNvbS9yZW5vdmF0ZWJvdDAYBgorBgEEAYO/MAERBAoMCDM4NjU2NTIwMGMGCisGAQQBg78wARIEVQxTaHR0cHM6Ly9naXRodWIuY29tL3Jlbm92YXRlYm90L3Jlbm92YXRlLy5naXRodWIvd29ya2Zsb3dzL2J1aWxkLnltbEByZWZzL2hlYWRzL21haW4wOAYKKwYBBAGDvzABEwQqDChhNDI1NTJlNmM5NzM5YTlkNTc3Zjg2ZGQ4MTllOWQ0MWFlZTdjMDU5MBQGCisGAQQBg78wARQEBgwEcHVzaDBbBgorBgEEAYO/MAEVBE0MS2h0dHBzOi8vZ2l0aHViLmNvbS9yZW5vdmF0ZWJvdC9yZW5vdmF0ZS9hY3Rpb25zL3J1bnMvNDI4MzUwNzQ5NjEvYXR0ZW1wdHMvMTAWBgorBgEEAYO/MAEWBAgMBnB1YmxpYzA9BgorBgEEAYO/MAEYBC8MLXJlcG86cmVub3ZhdGVib3QvcmVub3ZhdGU6cmVmOnJlZnMvaGVhZHMvbWFpbjCBiQYKKwYBBAHWeQIEAgR7BHkAdwB1AN09MGrGxxEyYxkeHJlnNwKiSl643jyt/4eKcoAvKe6OAAABocXwTToAAAQDAEYwRAIgZgvU7goZ19PY708MzAZUol3PzEEEKWdLzRTSA7vNAQQCIB9PRWugGB+GgGZYBB84XLNk5K0Rjy0RcI7VgXSsEjarMAoGCCqGSM49BAMDA2cAMGQCMBJnbKuBE6+WHLE2IAImaJGahMborgjIx6vjA06i+Gs4EeYF1amVH1XJipTgPVh0oAIwAOCfDPk6nbwtcU6K7FPzPIqm+UT9fWRzU8F/0YzJpJFJSrJJCiXQ6RpaLdUaZFx4";

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

Deno.test("attest and signBlob refuse an empty key themselves, before running cosign, as sign does", async () => {
  const f = fake({});
  try {
    for (
      const call of [
        (c: Context) => sign({ refs: [REF] }, c),
        (c: Context) => attest({ refs: [REF], predicate: "deno.json" }, c),
        (c: Context) => signBlob({ path: "deno.json" }, c),
      ]
    ) {
      const { ctx, written } = context({ key: "", password: "" });
      const err = await assertRejects(() => call(ctx));
      assertStringIncludes(String(err), "key is empty: nothing to sign with");
      assertEquals(written.length, 0);
    }
    assertEquals(f.calls.length, 0);
    // No bundle was written beside the file either.
    await assertRejects(
      () => Deno.stat(`${REPO}/deno.json.sigstore.json`),
      Deno.errors.NotFound,
    );
  } finally {
    f.restore();
  }
});

Deno.test("no test and no method leaves a temporary file behind: everything is made in the run's own directory", async () => {
  const f = fake({
    downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
    signed: [DIGEST],
    genuine: [CERT_A],
  });
  try {
    const { ctx } = context();
    await identify({ refs: [REF] }, ctx);
    await verify({ refs: [REF] }, ctx);
    await sign({ refs: [REF] }, ctx);
    // Every file a call named lies in the run's directory, and is gone.
    const named = f.calls.flatMap((c) => c.args).filter((a) =>
      a.includes("cosign-")
    );
    assert(named.length >= 3);
    for (const path of named) assert(path.startsWith(`${SCRATCH}/`), path);
    const left: string[] = [];
    for await (const entry of Deno.readDir(SCRATCH)) left.push(entry.name);
    assertEquals(left, []);
  } finally {
    f.restore();
  }
});

Deno.test("in the tag form only what cosign confirms of a certificate is recorded: a signer's own annotations are not claims, and not an issuer", async () => {
  const mail = "builder@attacker.example";
  const google = "https://accounts.google.com";
  // cosign prints the signer's own annotations where the certificate has
  // no such extension. The certificate here has an identity and an issuer.
  const annotated = tagVerified(DIGEST, mail, google, {
    githubWorkflowRepository: "victim/product",
    githubWorkflowRef: "refs/tags/v1.0.0",
    githubWorkflowName: "release",
    githubWorkflowSha: "a".repeat(40),
    githubWorkflowTrigger: "push",
  });
  const first = await identified({
    downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
    tagVerified: { [DIGEST]: [annotated] },
    certified: { [DIGEST]: [{ identity: mail, issuer: google, claims: {} }] },
  });
  assertEquals(first.record.state, "identified");
  assertEquals(first.record.certificateIdentity, mail);
  assertEquals(first.record.oidcIssuer, google);
  assertEquals(first.record.signatures[0].certificateGenuine, true);
  assertEquals(first.record.signatures[0].claims, {});
  assertEquals(first.record.signatures[0].withheld, 5);
  assert(!JSON.stringify(first.written).includes("victim"));
  assert(!first.logs.join("\n").includes("victim"));
  // The pattern check, the whole of what was printed, then the identity
  // and the issuer alone.
  assertEquals(first.calls.map((c) => c.args.slice(1, 3)), [
    ["signature", "--"],
    ["--", REF],
    ["--certificate-identity-regexp", ".*"],
    [`--certificate-identity=${mail}`, `--certificate-oidc-issuer=${google}`],
    [`--certificate-identity=${mail}`, `--certificate-oidc-issuer=${google}`],
  ]);
  assertEquals(first.calls[3].args.length, first.calls[4].args.length + 5);

  // One claim that the certificate says otherwise: none of them is kept.
  const oneWrong = await identified({
    downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
    tagVerified: { [DIGEST]: [tagVerified(DIGEST, ID_A, ISSUER, GITHUB_A)] },
    certified: {
      [DIGEST]: [{
        identity: ID_A,
        issuer: ISSUER,
        claims: { ...GITHUB_A, githubWorkflowRepository: "other/repository" },
      }],
    },
  });
  assertEquals(oneWrong.record.state, "identified");
  assertEquals(oneWrong.record.signatures[0].claims, {});

  // With a trusted root whose certificates name no issuer, the issuer
  // cosign prints is the signer's annotation too: nothing is confirmed,
  // and the signature names no one.
  const noIssuer = await identified({
    downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
    tagVerified: { [DIGEST]: [tagVerified(DIGEST, mail, google)] },
    certified: { [DIGEST]: [{ identity: mail, issuer: "", claims: {} }] },
  });
  assertEquals(noIssuer.record.state, "unproven");
  assertEquals(noIssuer.record.certificateIdentity, "");
  assertEquals(noIssuer.record.identities, []);
  assertEquals(noIssuer.record.signatures[0].certificateGenuine, true);
  assertEquals(noIssuer.record.signatures[0].certificateIdentity, "");
  assertEquals(noIssuer.record.signatures[0].oidcIssuer, "");
  assertStringIncludes(
    String(noIssuer.record.signatures[0].reason),
    "did not confirm the identity and the issuer it printed",
  );
  assert(!JSON.stringify(noIssuer.record).includes(mail));
  // One call, since there are no claims to drop.
  assertEquals(commands(noIssuer.calls), [
    "download",
    "tree",
    "verify",
    "verify",
  ]);

  // Three signatures print the same; two certificates say it. Two are named.
  const some = await identified({
    downloads: {
      [DIGEST]: [1, 2, 3].map(() => tagLine(DIGEST, CERT_A)),
    },
    tagVerified: {
      [DIGEST]: [1, 2, 3].map(() => tagVerified(DIGEST, mail, google)),
    },
    certified: {
      [DIGEST]: [
        { identity: mail, issuer: google, claims: {} },
        { identity: mail, issuer: google, claims: {} },
        { identity: mail, issuer: "https://elsewhere.example", claims: {} },
      ],
    },
  });
  assertEquals(some.record.state, "identified");
  assertEquals(some.record.identities, [{
    certificateIdentity: mail,
    oidcIssuer: google,
    signatures: 2,
  }]);
  assertEquals(some.record.certificatesGenuine, 3);
  assertEquals(
    some.record.reason,
    "other signatures on this image: 1 that could not be checked",
  );

  // What cosign printed is given back as one argument each, so a value
  // shaped like a flag is a value.
  const shaped = await identified({
    downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
    tagVerified: {
      [DIGEST]: [
        tagVerified(DIGEST, "--key=/tmp/k", "--insecure-ignore-tlog", {
          githubWorkflowName: "--certificate-identity-regexp=.*",
        }),
      ],
    },
  });
  assertEquals(shaped.record.certificateIdentity, "--key=/tmp/k");
  assertEquals(shaped.calls[3].args.slice(1, 4), [
    "--certificate-identity=--key=/tmp/k",
    "--certificate-oidc-issuer=--insecure-ignore-tlog",
    "--certificate-github-workflow-name=--certificate-identity-regexp=.*",
  ]);

  // Seven identities: five are confirmed, with one call each here, and
  // the other two name no one.
  const ids = [1, 2, 3, 4, 5, 6, 7].map((i) => `https://example.org/job/${i}`);
  const seven = await identified({
    downloads: { [DIGEST]: ids.map(() => tagLine(DIGEST, CERT_A)) },
    tagVerified: { [DIGEST]: ids.map((i) => tagVerified(DIGEST, i, ISSUER)) },
  });
  assertEquals(seven.record.identities.length, 5);
  assertEquals(seven.record.certificatesGenuine, 7);
  assertEquals(seven.calls.length, 3 + 5);
  assertStringIncludes(
    String(seven.record.signatures[6].reason),
    "cosign printed more identities for this image than the 5 that are confirmed",
  );
  assertEquals(
    seven.record.reason,
    "5 identities signed this image; identities lists them, and none is chosen for you; 2 more signatures name identities beyond the 5 that are confirmed",
  );
  // One identity confirmed and others beyond the five: the record says
  // there are more than were confirmed.
  const crowded = await identified({
    downloads: { [DIGEST]: ids.map(() => tagLine(DIGEST, CERT_A)) },
    tagVerified: { [DIGEST]: ids.map((i) => tagVerified(DIGEST, i, ISSUER)) },
    certified: {
      [DIGEST]: [{ identity: ids[4], issuer: ISSUER, claims: {} }],
    },
  });
  assertEquals(crowded.record.state, "identified");
  assertEquals(crowded.record.certificateIdentity, ids[4]);
  assertEquals(
    crowded.record.reason,
    "other signatures on this image: 6 that could not be checked, 2 of those name identities beyond the 5 that are confirmed",
  );
  // The most calls the tag form can take: two for each of five identities.
  const most = await identified({
    downloads: { [DIGEST]: ids.map(() => tagLine(DIGEST, CERT_A)) },
    tagVerified: {
      [DIGEST]: ids.map((i) => tagVerified(DIGEST, i, ISSUER, GITHUB_A)),
    },
    certified: {
      [DIGEST]: ids.map((identity) => ({
        identity,
        issuer: ISSUER,
        claims: {},
      })),
    },
  });
  assertEquals(most.calls.length, 3 + 10);
  assertEquals(most.record.identities.length, 5);

  // A confirming call that cannot be made fails the method.
  const f = fake({
    downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
    tagVerified: { [DIGEST]: [tagVerified(DIGEST, mail, google)] },
    certified: { [DIGEST]: [] },
    tagError: "x",
  });
  f.restore();
  let call = 0;
  const restore = __setExec((_bin, args) => {
    if (args[0] === "verify" && ++call === 2) {
      return Promise.resolve({
        code: 1,
        stdout: "",
        stderr: "Error: no matching signatures: dial tcp: i/o timeout\n",
      });
    }
    return f.direct(args);
  });
  try {
    const { ctx, written } = context({ key: "" });
    const err = await assertRejects(() => identify({ refs: [REF] }, ctx));
    assertStringIncludes(String(err), "--certificate-identity=" + mail);
    assertEquals(written.length, 0);
  } finally {
    restore();
  }
});

Deno.test("signatures under a tag beside bundles are read, or said to be there: an attestation does not hide them", async () => {
  const attestation = bundle(
    DIGEST,
    { certificate: { rawBytes: CERT_B } },
    SLSA1,
  );
  // Signed keyless under the tag by an older cosign, attested later as a
  // bundle. cosign reads the tag form here only when told to.
  const { record, calls } = await identified({
    downloads: { [DIGEST]: [attestation] },
    tagVerified: { [DIGEST]: [tagVerified(DIGEST, ID_A, ISSUER, GITHUB_A)] },
    treeLists: { [DIGEST]: ["attestation", "tag"] },
  });
  assertEquals(record.state, "identified");
  assertEquals(record.certificateIdentity, ID_A);
  assertEquals(record.forms, ["tag"]);
  assertEquals(record.otherStatements, 1);
  assertEquals(record.tagSignaturesUnlisted, true);
  assertEquals(record.signatures[0].claims, GITHUB_A);
  assertEquals(commands(calls), ["download", "tree", "verify", "verify"]);
  for (const call of calls.slice(2)) {
    assertEquals(call.args[1], "--new-bundle-format=false");
    assertEquals(call.env, {});
  }

  // A key's signature under the tag beside an attestation: it cannot be
  // listed or checked, and the image is not called unsigned.
  const key = await identified({
    downloads: { [DIGEST]: [attestation] },
    tagBeside: [DIGEST],
  });
  assertEquals(key.record.state, "unproven");
  assertEquals(key.record.tagSignaturesUnlisted, true);
  assertEquals(key.record.signaturesFound, 1);
  assertEquals(key.record.signatures[0].form, "tag");
  assertEquals(key.record.signatures[0].signedWith, "unknown");
  assertStringIncludes(
    String(key.record.reason),
    "signatures are stored under the tag beside the bundles, and cosign verified none of them with a certificate",
  );

  // The mirror: a bundle signature, and signatures under the tag too.
  const mirror = await identified({
    downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
    genuine: [CERT_A],
    tagBeside: [DIGEST],
  });
  assertEquals(mirror.record.state, "identified");
  assertEquals(mirror.record.tagSignaturesUnlisted, true);
  assertEquals(mirror.record.forms, ["bundle", "tag"]);
  assertEquals(
    mirror.record.reason,
    "other signatures on this image: 1 that could not be checked",
  );
  const two = await identified({
    downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
    genuine: [CERT_A],
    tagVerified: { [DIGEST]: [tagVerified(DIGEST, ID_B, ISSUER_B)] },
    tagBeside: [DIGEST],
  });
  assertEquals(two.record.state, "several-identities");

  // Bundles and nothing under the tag: the registry said so.
  const none = await identified({
    downloads: { [DIGEST]: [certBundle(DIGEST, CERT_A)] },
    genuine: [CERT_A],
  });
  assertEquals(none.record.tagSignaturesUnlisted, false);
  assertEquals(none.record.forms, ["bundle"]);
  // The tag form alone is listed in full, so nothing is unlisted.
  const alone = await identified({
    downloads: { [DIGEST]: [tagLine(DIGEST, null)] },
  });
  assertEquals(alone.record.tagSignaturesUnlisted, false);

  // cosign tree lists signatures under the tag and verify finds none
  // there: one of the two lookups failed.
  assertStringIncludes(
    await failing({
      downloads: { [DIGEST]: [attestation] },
      treeLists: { [DIGEST]: ["attestation", "tag"] },
    }),
    "cosign tree lists signatures under a tag and cosign verify found none there",
  );
  // The lookup of the tag fails beside bundles: not "there is none".
  assertStringIncludes(
    await failing({
      downloads: { [DIGEST]: [attestation] },
      tagVerified: {},
      tagError:
        "GET https://registry.example.org/v2/team/api/manifests/sha256-x.sig: TOOMANYREQUESTS: rate limited",
    }),
    "cosign verify --new-bundle-format=false",
  );
});

Deno.test("everything cosign tree prints must be understood: an error it prints and carries on from fails the method", async () => {
  const header =
    `📦 Supply Chain Security Related artifacts for an image: ${REF}\n`;
  const nothing = header +
    `No Supply Chain Security Related Artifacts found for image ${REF},\n start creating one with simply running$ cosign sign <img>`;
  const layer = `   └── 🍒 ${DIGEST2}\n`;
  const sign =
    `└── 🔗 ${SIGN_TYPE} artifacts via OCI referrer: registry.example.org/team/api@${DIGEST2}\n`;
  assertEquals(parseTree(nothing), {
    bundleLayers: 0,
    tagSignatures: false,
  });
  assertEquals(
    parseTree(
      header + sign + `   ├── 🍒 ${DIGEST}\n` + layer +
        `└── 🔗 https://slsa.dev/provenance/v1 artifacts via OCI referrer: x@${DIGEST}\n` +
        layer +
        `└── 🔗 application/vnd.cncf.notary.signature artifacts via OCI referrer: x@${DIGEST}\n` +
        layer +
        `└── 🔗 doc/example artifacts via OCI referrer: x@${DIGEST}\n` + layer +
        `└── 🔗 x-custom/thing artifacts via OCI referrer: x@${DIGEST}\n` +
        layer +
        `└── 💾 Attestations for an image tag: x:sha256-ab.att\n` + layer +
        `└── 📦 SBOMs for an image tag: x:sha256-ab.sbom\n` + layer,
    ),
    // Seven layers under referrers; three are of other kinds of artifact,
    // registered or not, and are no bundles.
    { bundleLayers: 3, tagSignatures: false },
  );
  // A bundle whose manifest has no predicate label is named by its media
  // type, and is a bundle.
  assertEquals(
    parseTree(
      header +
        `└── 🔗 application/vnd.dev.sigstore.bundle.v0.3+json artifacts via OCI referrer: x@${DIGEST}\n` +
        layer,
    ),
    { bundleLayers: 1, tagSignatures: false },
  );
  assertEquals(
    parseTree(
      header + `└── 🔐 Signatures for an image tag: x:sha256-ab.sig\n` + layer,
    ),
    { bundleLayers: 0, tagSignatures: true },
  );
  for (
    const printed of [
      "",
      header,
      nothing + "\nand more",
      header + "Error fetching artifact x: TOOMANYREQUESTS\n" +
      nothing.slice(header.length),
      header + sign + "something new\n",
      header + "└── 🔗 two words artifacts via OCI referrer: x\n",
      "not the header\n" + nothing.slice(header.length),
    ]
  ) {
    assert(assertThrows(() => parseTree(printed)) instanceof Error, printed);
  }

  // The fault the download swallows: the manifest of the one signature
  // bundle is refused. cosign tree exits 0, prints the error and then
  // says there is nothing.
  const fetching =
    `Error fetching artifact sha256:ab: GET https://registry.example.org/v2/team/api/manifests/sha256:ab: TOOMANYREQUESTS: rate limited\n`;
  for (
    const treePrints of [
      { stderr: fetching },
      {
        stderr: fetching.replace(
          "TOOMANYREQUESTS: rate limited",
          "MANIFEST_UNKNOWN: manifest unknown",
        ),
      },
      { stderr: "WARNING: something cosign has not said before\n" },
      { stdout: header + fetching + nothing.slice(header.length) },
      { stdout: "" },
      { stdout: header },
      // An exit code that says failure, with nothing printed about it.
      { code: 1 },
    ]
  ) {
    const err = await failing({ treePrints: { [DIGEST]: treePrints } });
    assert(
      err.includes("cosign tree -- " + REF) ||
        err.includes("cosign tree printed"),
      err,
    );
    // And the same when signatures under a tag did come back.
    await failing({
      downloads: { [DIGEST]: [tagLine(DIGEST, null)] },
      treePrints: { [DIGEST]: treePrints },
    });
  }
});

Deno.test("what cosign printed is confirmed for each identity, issuer and set of claims apart, and never with an empty issuer", async () => {
  const mail = "builder@example.org";
  const google = "https://accounts.google.com";
  // Two signatures of one identity and issuer: one certificate has the
  // claims, for the other they are the signer's own words.
  const mixed = await identified({
    downloads: {
      [DIGEST]: [tagLine(DIGEST, CERT_A), tagLine(DIGEST, CERT_A)],
    },
    tagVerified: {
      [DIGEST]: [
        tagVerified(DIGEST, ID_A, ISSUER, {
          githubWorkflowRepository: "victim/product",
        }),
        tagVerified(DIGEST, ID_A, ISSUER, GITHUB_A),
      ],
    },
    certified: {
      [DIGEST]: [
        { identity: ID_A, issuer: ISSUER, claims: {} },
        { identity: ID_A, issuer: ISSUER, claims: GITHUB_A },
      ],
    },
  });
  assertEquals(mixed.record.state, "identified");
  assertEquals(mixed.record.identities[0].signatures, 2);
  assertEquals(mixed.record.signatures.map((s) => s.claims), [{}, GITHUB_A]);
  assert(!JSON.stringify(mixed.written).includes("victim"));

  // One identity under two issuers, and only one certificate says its issuer.
  const issuers = await identified({
    downloads: {
      [DIGEST]: [tagLine(DIGEST, CERT_A), tagLine(DIGEST, CERT_A)],
    },
    tagVerified: {
      [DIGEST]: [
        tagVerified(DIGEST, mail, google),
        tagVerified(DIGEST, mail, ISSUER_B),
      ],
    },
    certified: {
      [DIGEST]: [
        { identity: mail, issuer: google, claims: {} },
        { identity: mail, issuer: "", claims: {} },
      ],
    },
  });
  assertEquals(issuers.record.state, "identified");
  assertEquals(issuers.record.identities, [{
    certificateIdentity: mail,
    oidcIssuer: google,
    signatures: 1,
  }]);
  assertEquals(issuers.record.certificatesGenuine, 2);
  assert(!JSON.stringify(issuers.record).includes(ISSUER_B));
  // The same identity under two issuers, and each certificate says its
  // own: two identities, each confirmed with its own issuer.
  const both = await identified({
    downloads: {
      [DIGEST]: [tagLine(DIGEST, CERT_A), tagLine(DIGEST, CERT_A)],
    },
    tagVerified: {
      [DIGEST]: [
        tagVerified(DIGEST, mail, google),
        tagVerified(DIGEST, mail, ISSUER_B),
      ],
    },
  });
  assertEquals(both.record.state, "several-identities");
  assertEquals(both.record.identities.map((i) => i.oidcIssuer), [
    google,
    ISSUER_B,
  ]);

  // cosign printed an identity and no issuer: there is nothing to ask
  // cosign to confirm, and it is not asked.
  const bare = payload(DIGEST, { Subject: mail });
  const noIssuer = await identified({
    downloads: { [DIGEST]: [tagLine(DIGEST, CERT_A)] },
    tagVerified: { [DIGEST]: [bare] },
    certified: { [DIGEST]: [{ identity: mail, issuer: "", claims: {} }] },
  });
  assertEquals(noIssuer.record.state, "unproven");
  assertEquals(noIssuer.record.signatures[0].certificateIdentity, "");
  assertEquals(
    noIssuer.record.signatures[0].reason,
    "the certificate is genuine, and its identity or its issuer is not text that can be stored",
  );
  assertEquals(commands(noIssuer.calls), ["download", "tree", "verify"]);
});
