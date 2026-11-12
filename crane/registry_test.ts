import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import {
  __setExec,
  argumentProblem,
  checks,
  type CommandResult,
  type Context,
  fileFromLayer,
  GlobalArgsSchema,
  imageInstance,
  isIndex,
  model,
  parseRef,
  pingUrl,
  platformOf,
  refString,
  repositoryUnder,
  sourcePath,
  tarEntries,
} from "./registry.ts";

const REPO = import.meta.dirname!;

const DIGEST_A =
  "sha256:4b9874bd1e5a1ee8ae9a5819237de1088fa7307d419e61cb4281e849a39a0405";
const enc = (s: string) => new TextEncoder().encode(s);

type Written = { spec: string; name: string; data: Record<string, unknown> };

function context(
  over: Record<string, unknown> = {},
  stored: Record<string, Record<string, unknown>> = {},
) {
  const written: Written[] = [];
  const logs: string[] = [];
  const ctx: Context = {
    globalArgs: GlobalArgsSchema.parse({
      registry: "registry.example.org",
      namespace: "mirror",
      ...over,
    }),
    repoDir: REPO,
    logger: { info: (msg) => logs.push(msg) },
    writeResource: (spec, name, data) => {
      written.push({ spec, name, data });
      stored[name] = data;
      return Promise.resolve({ name });
    },
    readResource: (name) => Promise.resolve(stored[name] ?? null),
  };
  return { ctx, written, logs };
}

Deno.test("parseRef splits repository, tag and digest, and refuses what is not a reference", () => {
  assertEquals(parseRef("docker.io/library/nats:2.10"), {
    repository: "docker.io/library/nats",
    name: "nats",
    tag: "2.10",
    digest: "",
  });
  assertEquals(parseRef(`localhost:5001/team/hello@${DIGEST_A}`), {
    repository: "localhost:5001/team/hello",
    name: "hello",
    tag: "",
    digest: DIGEST_A,
  });
  assertEquals(parseRef(`localhost:5001/hello:v1@${DIGEST_A}`), {
    repository: "localhost:5001/hello",
    name: "hello",
    tag: "v1",
    digest: DIGEST_A,
  });
  assertEquals(parseRef("nats"), {
    repository: "nats",
    name: "nats",
    tag: "",
    digest: "",
  });
  assertStringIncludes(parseRef("https://x/y:1") as string, "no scheme");
  assertStringIncludes(parseRef("x/y@sha256:abc") as string, "64 hex");
  assertStringIncludes(parseRef("x/y:a!b") as string, "not an image tag");
  assertStringIncludes(parseRef("x/:1") as string, "names no repository");
});

Deno.test("refString, repositoryUnder and imageInstance", () => {
  const r = parseRef(`a/b:v1@${DIGEST_A}`);
  assert(typeof r !== "string");
  assertEquals(refString(r), `a/b@${DIGEST_A}`);
  assertEquals(refString({ ...r, digest: "" }), "a/b:v1");
  assertEquals(refString({ ...r, digest: "", tag: "" }), "a/b");
  const g = GlobalArgsSchema.parse({ registry: "r.example.org" });
  assertEquals(repositoryUnder(g, "nats"), "r.example.org/nats");
  assertEquals(
    repositoryUnder({ ...g, namespace: "mirror" }, "nats"),
    "r.example.org/mirror/nats",
  );
  assertEquals(
    imageInstance("digest", {
      repository: "docker.io/library/nats",
      name: "nats",
      tag: "2.10",
      digest: "",
    }),
    "digest-docker.io-library-nats-2.10",
  );
  assertEquals(
    imageInstance("image", {
      repository: "localhost:5001/team/hello",
      name: "hello",
      tag: "",
      digest: DIGEST_A,
    }),
    "image-localhost-5001-team-hello-4b9874bd1e5a",
  );
});

Deno.test("the arguments check refuses a bad registry, namespace, a lone password and an unevaluated expression", () => {
  assertEquals(argumentProblem({ registry: "registry.example.org" }), null);
  assertEquals(
    argumentProblem({
      registry: "localhost:5001",
      namespace: "mirror/base",
      username: "u",
      password: "p",
    }),
    null,
  );
  assertEquals(argumentProblem({}), null);
  assertStringIncludes(
    argumentProblem({ registry: "https://registry.example.org" })!,
    "host[:port]",
  );
  assertStringIncludes(
    argumentProblem({ registry: "registry.example.org/team" })!,
    "no path",
  );
  assertStringIncludes(
    argumentProblem({ namespace: "Mirror" })!,
    "repository path",
  );
  assertStringIncludes(
    argumentProblem({ password: "p" })!,
    "come together",
  );
  assertStringIncludes(
    argumentProblem({ username: '${{ vault.get("v", "k") }}', password: "p" })!,
    "unevaluated",
  );
});

Deno.test("platformOf, isIndex and pingUrl", () => {
  assertEquals(
    platformOf({
      platform: { os: "linux", architecture: "arm64", variant: "v8" },
    }),
    "linux/arm64/v8",
  );
  assertEquals(platformOf({}), "");
  assert(isIndex({ manifests: [] }));
  assert(
    isIndex({
      mediaType: "application/vnd.docker.distribution.manifest.list.v2+json",
    }),
  );
  assert(
    !isIndex({
      mediaType: "application/vnd.oci.image.manifest.v1+json",
      layers: [],
    }),
  );
  assertEquals(pingUrl("localhost:5001", false), ["http://localhost:5001/v2/"]);
  assertEquals(pingUrl("127.0.0.1:5000", false), ["http://127.0.0.1:5000/v2/"]);
  assertEquals(pingUrl("registry.example.org", false), [
    "https://registry.example.org/v2/",
  ]);
  assertEquals(pingUrl("registry.example.org:5000", true), [
    "https://registry.example.org:5000/v2/",
    "http://registry.example.org:5000/v2/",
  ]);
});

Deno.test("registry-reachable fails on an empty registry and on one that does not answer", async () => {
  const empty = await checks["registry-reachable"].execute({
    globalArgs: {},
    logger: { info: () => {} },
  });
  assertEquals(empty.pass, false);
  assertStringIncludes(empty.errors![0], "registry is empty");
  // A port nothing listens on, on the loopback: refused at once.
  const down = await checks["registry-reachable"].execute({
    globalArgs: { registry: "127.0.0.1:1" },
    logger: { info: () => {} },
  });
  assertEquals(down.pass, false);
  assertStringIncludes(down.errors![0], "http://127.0.0.1:1/v2/");
});

Deno.test("sourcePath gives the repository a registry mirror is asked for, Docker Hub's in full", () => {
  assertEquals(sourcePath("docker.io/library/nats"), "docker.io/library/nats");
  assertEquals(sourcePath("nats"), "docker.io/library/nats");
  assertEquals(sourcePath("bitnami/redis"), "docker.io/bitnami/redis");
  assertEquals(sourcePath("index.docker.io/nats"), "docker.io/library/nats");
  assertEquals(
    sourcePath("registry-1.docker.io/bitnami/redis"),
    "docker.io/bitnami/redis",
  );
  assertEquals(
    sourcePath("ghcr.io/siderolabs/kubelet"),
    "ghcr.io/siderolabs/kubelet",
  );
  assertEquals(sourcePath("registry.k8s.io/pause"), "registry.k8s.io/pause");
  assertEquals(sourcePath("Quay.IO/cilium/cilium"), "quay.io/cilium/cilium");
  assertEquals(
    sourcePath("localhost:5001/team/hello"),
    "localhost_5001/team/hello",
  );
  assertEquals(sourcePath("localhost/team/hello"), "localhost/team/hello");
  assertEquals(
    sourcePath("registry.example.org:5000/team/hello"),
    "registry.example.org_5000/team/hello",
  );
  assertEquals(sourcePath("10.0.0.1:5000/hello"), "10.0.0.1_5000/hello");
  // A host may hold a dash but never an underscore: no port collides with it.
  assertEquals(
    sourcePath("registry.example.org-5000/team/hello"),
    "registry.example.org-5000/team/hello",
  );
  assertEquals(sourcePath("docker.io/nats"), sourcePath("nats"));
  for (const bad of ["Foo/bar", "[::1]:5000/hello", "ghcr.io/Team/Hello"]) {
    assertStringIncludes(String(sourcePath(bad)), "cannot be mirrored");
  }
});

/** A ustar archive of the files given, as Go's archive/tar and tar(1) write one. */
function tar(files: Record<string, string>): Uint8Array {
  const blocks: Uint8Array[] = [];
  for (const [name, content] of Object.entries(files)) {
    const data = enc(content);
    const header = new Uint8Array(512);
    header.set(enc(name).subarray(0, 100), 0);
    header.set(enc("0000644\0"), 100);
    header.set(enc("0000000\0"), 108);
    header.set(enc("0000000\0"), 116);
    header.set(enc(data.length.toString(8).padStart(11, "0") + "\0"), 124);
    header.set(enc("00000000000\0"), 136);
    header.set(enc("        "), 148);
    header[156] = "0".charCodeAt(0);
    header.set(enc("ustar\0"), 257);
    header.set(enc("00"), 263);
    let sum = 0;
    for (const b of header) sum += b;
    header.set(enc(sum.toString(8).padStart(6, "0") + "\0 "), 148);
    blocks.push(header, data, new Uint8Array((512 - data.length % 512) % 512));
  }
  blocks.push(new Uint8Array(1024));
  const out = new Uint8Array(blocks.reduce((n, b) => n + b.length, 0));
  let o = 0;
  for (const b of blocks) {
    out.set(b, o);
    o += b.length;
  }
  return out;
}

async function gzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new CompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

const RELEASE = JSON.stringify({
  product: "shop",
  images: { api: DIGEST_A },
});

Deno.test("tarEntries and fileFromLayer read a file out of a tar, gzipped or not, and say what is there otherwise", async () => {
  const archive = tar({
    "release.json": RELEASE,
    "./manifests.yaml": "kind: X\n",
  });
  assertEquals([...tarEntries(archive)].map((e) => e.name), [
    "release.json",
    "manifests.yaml",
  ]);
  assertEquals(
    new TextDecoder().decode(await fileFromLayer(archive, "release.json")),
    RELEASE,
  );
  assertEquals(
    new TextDecoder().decode(
      await fileFromLayer(await gzip(archive), "./manifests.yaml"),
    ),
    "kind: X\n",
  );
  assertEquals(await fileFromLayer(enc("raw"), ""), enc("raw"));
  const missing = await assertRejects(() => fileFromLayer(archive, "nope"));
  assertStringIncludes(
    String(missing),
    "it holds: release.json, manifests.yaml",
  );
  const notTar = await assertRejects(() =>
    fileFromLayer(enc("plain text"), "x")
  );
  assertStringIncludes(String(notTar), "not a tar archive");
});

Deno.test("tarEntries honours a pax path and a GNU long name", () => {
  const long = "a".repeat(120) + ".json";
  const paxed = tar({ "short": "x" });
  // A pax header before the entry gives its real path.
  const record = `${("path=" + long).length + 3} path=${long}\n`;
  const pax = tar({ "PaxHeader/short": record });
  pax[156] = "x".charCodeAt(0);
  // Recompute the checksum for the changed type flag.
  pax.set(enc("        "), 148);
  let sum = 0;
  for (let i = 0; i < 512; i++) sum += pax[i];
  pax.set(enc(sum.toString(8).padStart(6, "0") + "\0 "), 148);
  const joined = new Uint8Array(pax.length - 1024 + paxed.length);
  joined.set(pax.subarray(0, pax.length - 1024), 0);
  joined.set(paxed, pax.length - 1024);
  assertEquals([...tarEntries(joined)].map((e) => e.name), [long]);
});

// The real crane against a registry holding an image ko pushed. Needs crane
// on PATH (or CRANE_BINARY) and the registry at CRANE_E2E_REGISTRY, default
// localhost:5001, with CRANE_E2E_IMAGE, default team/hello:v1, in it.
// CRANE_E2E=1 enables it.
const e2e = Deno.env.get("CRANE_E2E") === "1";

Deno.test({
  name: "e2e: digest, describe, copy, tag and blob against a registry",
  ignore: !e2e,
  fn: async () => {
    const host = Deno.env.get("CRANE_E2E_REGISTRY") ?? "localhost:5001";
    const image = Deno.env.get("CRANE_E2E_IMAGE") ?? "team/hello:v1";
    const run = crypto.randomUUID().slice(0, 8);
    const over = {
      registry: host,
      namespace: `e2e-${run}`,
      username: "e2e",
      password: "hunter2",
      craneBinary: Deno.env.get("CRANE_BINARY") ?? "crane",
    };

    const d = context(over);
    await model.methods.digest.execute({ refs: [`${host}/${image}`] }, d.ctx);
    const digest = String(d.written[0].data.digest);
    assert(/^sha256:[0-9a-f]{64}$/.test(digest));
    assertEquals(d.written[0].data.changed, true);

    const s = context(over);
    await model.methods.describe.execute({ refs: [`${host}/${image}`] }, s.ctx);
    const described = s.written[0].data;
    assertEquals(described.digest, digest);
    assert((described.platforms as string[]).length >= 1, "a platform");
    assert(Number(described.size) > 0);
    assert(Number(described.layers) > 0);
    assertStringIncludes(String(described.created), "20");

    const c = context(over);
    const copy = () =>
      model.methods.copy.execute(
        { sources: [`${host}/${image}@${digest}`] },
        c.ctx,
      );
    await copy();
    assertEquals(c.written[0].data.action, "copied");
    assertEquals(c.written[0].data.digest, digest);
    await copy();
    assertEquals(c.written[1].data.action, "unchanged");
    const name = String(c.written[0].data.name);
    const repository = String(c.written[0].data.repository);
    const tag = String(c.written[0].data.tag);

    const t = context(over);
    await model.methods.tag.execute({ name, digest, tag: "stable" }, t.ctx);
    assertEquals(t.written[0].data.previousDigest, "");
    assertEquals(t.written[0].data.changed, true);
    await model.methods.tag.execute({ name, digest, tag: "stable" }, t.ctx);
    assertEquals(t.written[0].data.changed, true);
    assertEquals(t.written[1].data.changed, false);
    const again = context(over);
    await model.methods.digest.execute({
      refs: [`${repository}:${tag}`, `${repository}:stable`],
    }, again.ctx);
    assertEquals(again.written[0].data.digest, digest);
    assertEquals(again.written[1].data.digest, digest);

    // An artifact like Flux's: one tar+gzip layer holding release.json, made
    // with crane append from a tar this test writes.
    const tmp = await Deno.makeTempDir({ prefix: "crane-e2e-" });
    try {
      const layer = `${tmp}/content.tar.gz`;
      await Deno.writeFile(
        layer,
        await gzip(
          tar({ "release.json": RELEASE, "manifests.yaml": "kind: X\n" }),
        ),
      );
      const artifact = `${host}/e2e-${run}/config:v1`;
      const append = await new Deno.Command(over.craneBinary, {
        args: ["append", "--oci-empty-base", "-f", layer, "-t", artifact],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(append.code, 0, new TextDecoder().decode(append.stderr));
      const b = context(over);
      await model.methods.blob.execute(
        { ref: artifact, path: "release.json", layer: 0 },
        b.ctx,
      );
      assertEquals(b.written[0].data.text, RELEASE);
      assertEquals(b.written[0].data.json, JSON.parse(RELEASE));
      assertStringIncludes(
        String(b.written[0].data.layerMediaType),
        "tar+gzip",
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

// ───── the methods, through createModelTestContext with a stub exec ─────

const DIGEST_B =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const DIGEST_C =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";
const ok = (stdout: string | Uint8Array): CommandResult => ({
  code: 0,
  stdout: typeof stdout === "string" ? enc(stdout) : stdout,
  stderr: "",
});
const err = (stderr: string): CommandResult => ({
  code: 1,
  stdout: new Uint8Array(),
  stderr,
});
const MISSING = err("MANIFEST_UNKNOWN: manifest unknown");

/**
 * Routes: `[argument prefix, answer]`; the first route whose prefix starts
 * the call's arguments answers it, an array of answers in turn. A call no
 * route answers fails.
 */
type Routes = [string, CommandResult | CommandResult[]][];

type Call = { args: string; stdin?: string; env: Record<string, string> };

/** Runs `body` with the stub exec and a swamp test context. */
async function withStub(
  routes: Routes,
  body: (h: {
    ctx: Context;
    calls: Call[];
    written: () => Written[];
    logs: () => string[];
  }) => Promise<void>,
  opts: {
    globalArgs?: Record<string, unknown>;
    stored?: Record<string, Record<string, unknown>>;
  } = {},
) {
  const calls: Call[] = [];
  const used = new Map<number, number>();
  const restore = __setExec((_bin, args, o) => {
    const line = args.join(" ");
    calls.push({ args: line, stdin: o.stdin, env: o.env });
    const i = routes.findIndex(([prefix]) => line.startsWith(prefix));
    if (i < 0) {
      return Promise.reject(new Error(`the stub has no answer for ${line}`));
    }
    const a = routes[i][1];
    if (!Array.isArray(a)) return Promise.resolve(a);
    const n = used.get(i) ?? 0;
    used.set(i, n + 1);
    return Promise.resolve(a[Math.min(n, a.length - 1)]);
  });
  const t = createModelTestContext({
    globalArgs: GlobalArgsSchema.parse({
      registry: "registry.example.org",
      namespace: "mirror",
      ...opts.globalArgs,
    }),
    repoDir: REPO,
    storedResources: opts.stored ?? {},
  });
  try {
    await body({
      ctx: t.context as unknown as Context,
      calls,
      written: () =>
        t.getWrittenResources().map((w) => ({
          spec: w.specName,
          name: w.name,
          data: w.data as Record<string, unknown>,
        })),
      logs: () => t.getLogs().map((l) => l.message),
    });
  } finally {
    restore();
  }
}

const NATS = "docker.io/library/nats";

Deno.test("digest records a tag's digest and that it changed since the last record", () =>
  withStub([[`digest ${NATS}:2.10`, ok(DIGEST_B + "\n")]], async (h) => {
    await model.methods.digest.execute({ refs: [`${NATS}:2.10`] }, h.ctx);
    const [w] = h.written();
    assertEquals(w.spec, "digest");
    assertEquals(w.name, "digest-docker.io-library-nats-2.10");
    assertEquals(w.data.digest, DIGEST_B);
    assertEquals(w.data.previousDigest, DIGEST_A);
    assertEquals(w.data.changed, true);
    assertEquals(w.data.pinned, `${NATS}:2.10@${DIGEST_B}`);
  }, {
    stored: {
      "digest-docker.io-library-nats-2.10": {
        digest: DIGEST_A,
        firstSeenAt: "2026-01-01T00:00:00.000Z",
      },
    },
  }));

Deno.test("digest fails on a reference the registry does not have, and writes nothing", () =>
  withStub([[`digest ${NATS}:nope`, MISSING]], async (h) => {
    await assertRejects(
      () => model.methods.digest.execute({ refs: [`${NATS}:nope`] }, h.ctx),
      Error,
      `${NATS}:nope is not in the registry`,
    );
    assertEquals(h.written(), []);
  }));

Deno.test("describe records an image's platform, config, labels, layers and size", () =>
  withStub([
    [`digest ${NATS}:2.10`, ok(DIGEST_B)],
    [
      `manifest ${NATS}@${DIGEST_B}`,
      ok(JSON.stringify({
        mediaType: "application/vnd.oci.image.manifest.v1+json",
        config: { digest: DIGEST_C, size: 10 },
        layers: [{ size: 100 }, { size: 200 }],
        annotations: { "org.opencontainers.image.source": "https://x" },
      })),
    ],
    [
      `config ${NATS}@${DIGEST_B}`,
      ok(JSON.stringify({
        created: "2026-10-01T00:00:00Z",
        os: "linux",
        architecture: "amd64",
        config: { Labels: { team: "a" } },
      })),
    ],
  ], async (h) => {
    await model.methods.describe.execute({ refs: [`${NATS}:2.10`] }, h.ctx);
    const [w] = h.written();
    assertEquals(w.spec, "image");
    assertEquals(w.name, "image-docker.io-library-nats-111111111111");
    assertEquals(w.data.kind, "image");
    assertEquals(w.data.platforms, ["linux/amd64"]);
    assertEquals(w.data.configDigest, DIGEST_C);
    assertEquals(w.data.labels, { team: "a" });
    assertEquals([w.data.layers, w.data.size], [2, 310]);
    assertEquals(h.logs().at(-1), "{ref} is {kind} {digest} for {platforms}");
  }));

Deno.test("describe fails on a manifest that is not JSON, and writes nothing", () =>
  withStub([
    [`digest ${NATS}:2.10`, ok(DIGEST_B)],
    [`manifest ${NATS}@${DIGEST_B}`, ok("<html>")],
  ], async (h) => {
    await assertRejects(
      () => model.methods.describe.execute({ refs: [`${NATS}:2.10`] }, h.ctx),
      Error,
      "output is not JSON",
    );
    assertEquals(h.written(), []);
  }));

const TARGET = "registry.example.org/mirror/docker.io/library/nats:2.10";

Deno.test("copy logs in with the password on stdin, copies by digest and checks the digest after", () =>
  withStub([
    ["auth login registry.example.org", ok("")],
    [`digest ${TARGET}`, [MISSING, ok(DIGEST_B)]],
    [`copy ${NATS}@${DIGEST_B} ${TARGET}`, ok("")],
  ], async (h) => {
    await model.methods.copy.execute(
      { sources: [`${NATS}:2.10@${DIGEST_B}`] },
      h.ctx,
    );
    const login = h.calls[0];
    assertEquals(login.stdin, "s3cret-pw");
    assertEquals(login.args.includes("s3cret-pw"), false);
    assert(login.env.DOCKER_CONFIG, "a docker config of the run's own");
    const [w] = h.written();
    assertEquals(w.spec, "mirror");
    assertEquals(
      w.name,
      "mirror-registry.example.org-mirror-docker.io-library-nats-2.10",
    );
    assertEquals([w.data.action, w.data.target, w.data.digest], [
      "copied",
      TARGET,
      DIGEST_B,
    ]);
    assertEquals(JSON.stringify(h.written()).includes("s3cret-pw"), false);
    assertEquals(h.logs().join("\n").includes("s3cret-pw"), false);
  }, { globalArgs: { username: "robot", password: "s3cret-pw" } }));

Deno.test("copy fails when the target holds another digest after the copy, and writes nothing", () =>
  withStub([
    [`digest ${TARGET}`, [MISSING, ok(DIGEST_C)]],
    [`copy ${NATS}@${DIGEST_B} ${TARGET}`, ok("")],
  ], async (h) => {
    await assertRejects(
      () =>
        model.methods.copy.execute(
          { sources: [`${NATS}:2.10@${DIGEST_B}`] },
          h.ctx,
        ),
      Error,
      `${TARGET} is ${DIGEST_C} after the copy, expected ${DIGEST_B}`,
    );
    assertEquals(h.written(), []);
  }));

const TAGGED = "registry.example.org/mirror/config-prod";

Deno.test("tag moves a tag to the digest and records the digest it held before", () =>
  withStub([
    [`digest ${TAGGED}:stable`, [ok(DIGEST_A), ok(DIGEST_B)]],
    [`tag ${TAGGED}@${DIGEST_B} stable`, ok("")],
  ], async (h) => {
    await model.methods.tag.execute(
      { name: "config-prod", digest: DIGEST_B, tag: "stable" },
      h.ctx,
    );
    const [w] = h.written();
    assertEquals(w.spec, "tagging");
    assertEquals(
      w.name,
      "tagging-registry.example.org-mirror-config-prod-stable",
    );
    assertEquals([w.data.previousDigest, w.data.changed], [DIGEST_A, true]);
  }));

Deno.test("tag fails when crane tag fails, and writes nothing", () =>
  withStub([
    [`digest ${TAGGED}:stable`, MISSING],
    [
      `tag ${TAGGED}@${DIGEST_B} stable`,
      err("MANIFEST_UNKNOWN: no such digest"),
    ],
  ], async (h) => {
    await assertRejects(
      () =>
        model.methods.tag.execute(
          { name: "config-prod", digest: DIGEST_B, tag: "stable" },
          h.ctx,
        ),
      Error,
      `crane tag ${TAGGED}@${DIGEST_B} stable exited 1: MANIFEST_UNKNOWN`,
    );
    assertEquals(h.written(), []);
  }));

const ARTIFACT = "registry.example.org/mirror/config";

Deno.test("blob records a file out of the artifact's layer, parsed as JSON", async () => {
  const layer = await gzip(tar({ "release.json": RELEASE }));
  await withStub([
    [`digest ${ARTIFACT}:v1`, ok(DIGEST_B)],
    [
      `manifest ${ARTIFACT}@${DIGEST_B}`,
      ok(JSON.stringify({
        layers: [{ digest: DIGEST_C, mediaType: "application/x-tar+gzip" }],
      })),
    ],
    [`blob ${ARTIFACT}@${DIGEST_C}`, ok(layer)],
  ], async (h) => {
    await model.methods.blob.execute(
      { ref: `${ARTIFACT}:v1`, path: "release.json", layer: 0 },
      h.ctx,
    );
    const [w] = h.written();
    assertEquals(w.spec, "blob");
    assertEquals(
      w.name,
      "blob-registry.example.org-mirror-config-111111111111-release.json",
    );
    assertEquals(w.data.text, RELEASE);
    assertEquals(w.data.json, JSON.parse(RELEASE));
    assertEquals(w.data.layerDigest, DIGEST_C);
    assertStringIncludes(String(w.data.sha256), "sha256:");
  });
});

Deno.test("blob fails on an index, which is no artifact, and writes nothing", () =>
  withStub([
    [`digest ${ARTIFACT}:v1`, ok(DIGEST_B)],
    [`manifest ${ARTIFACT}@${DIGEST_B}`, ok(JSON.stringify({ manifests: [] }))],
  ], async (h) => {
    await assertRejects(
      () =>
        model.methods.blob.execute(
          { ref: `${ARTIFACT}:v1`, path: "release.json", layer: 0 },
          h.ctx,
        ),
      Error,
      "is an index, not an artifact",
    );
    assertEquals(h.written(), []);
  }));
