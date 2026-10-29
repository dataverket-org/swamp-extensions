import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import { z } from "npm:zod@4";
import {
  __setExec,
  argumentProblem,
  BlobArgsSchema,
  checks,
  type CommandResult,
  type Context,
  CopyArgsSchema,
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
const DIGEST_B =
  "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const DIGEST_C =
  "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";
const CONFIG_D =
  "sha256:1111111111111111111111111111111111111111111111111111111111111111";
const LAYER_E =
  "sha256:2222222222222222222222222222222222222222222222222222222222222222";

const enc = (s: string) => new TextEncoder().encode(s);

type Call = {
  args: string[];
  env: Record<string, string>;
  stdin?: string;
};

/** A fake registry crane talks to: tags and digests, manifests, configs, blobs. */
type Registry = {
  tags: Record<string, string>;
  manifests: Record<string, unknown>;
  configs: Record<string, unknown>;
  blobs: Record<string, Uint8Array>;
};

function registry(): Registry {
  const image = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.oci.image.config.v1+json",
      size: 1514,
      digest: CONFIG_D,
    },
    layers: [
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        size: 1000,
        digest: LAYER_E,
      },
      {
        mediaType: "application/vnd.oci.image.layer.v1.tar+gzip",
        size: 100,
        digest: DIGEST_C,
      },
    ],
  };
  return {
    tags: {
      "docker.io/library/nats:2.10": DIGEST_A,
      "registry.example.org/team/hello:v1": DIGEST_B,
    },
    manifests: {
      [`docker.io/library/nats@${DIGEST_A}`]: {
        mediaType: "application/vnd.oci.image.index.v1+json",
        manifests: [
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            size: 1416,
            digest: DIGEST_B,
            platform: { architecture: "amd64", os: "linux" },
          },
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            size: 1416,
            digest: DIGEST_C,
            platform: { architecture: "arm64", os: "linux", variant: "v8" },
          },
          {
            mediaType: "application/vnd.oci.image.manifest.v1+json",
            size: 500,
            digest: CONFIG_D,
            platform: { architecture: "unknown", os: "unknown" },
            annotations: {
              "vnd.docker.reference.type": "attestation-manifest",
            },
          },
        ],
        annotations: { "org.opencontainers.image.base.name": "static:latest" },
      },
      [`docker.io/library/nats@${DIGEST_B}`]: image,
      [`docker.io/library/nats@${DIGEST_C}`]: image,
      [`registry.example.org/team/hello@${DIGEST_B}`]: {
        ...image,
        annotations: { "org.opencontainers.image.revision": "abc123" },
      },
    },
    configs: {
      [`docker.io/library/nats@${DIGEST_B}`]: {
        architecture: "amd64",
        os: "linux",
        created: "2026-10-01T00:00:00Z",
        config: { Labels: { "org.opencontainers.image.version": "2.10" } },
      },
      [`registry.example.org/team/hello@${DIGEST_B}`]: {
        architecture: "arm64",
        os: "linux",
        variant: "v8",
        created: "2026-10-02T00:00:00Z",
        config: {},
      },
    },
    blobs: {},
  };
}

/** A fake crane over a fake registry. */
function fake(reg: Registry, opts: { fail?: string } = {}) {
  const calls: Call[] = [];
  const restore = __setExec(
    (bin, args, o): Promise<CommandResult> => {
      calls.push({ args, env: o.env, stdin: o.stdin });
      const ok = (stdout: string | Uint8Array = "") =>
        Promise.resolve({
          code: 0,
          stdout: typeof stdout === "string" ? enc(stdout) : stdout,
          stderr: "",
        });
      const fail = (code: number, stderr: string) =>
        Promise.resolve({ code, stdout: new Uint8Array(), stderr });
      if (bin !== "crane") return fail(127, `${bin}: not found`);
      const argv = args.filter((a) => a !== "--insecure");
      const line = argv.join(" ");
      if (opts.fail && line.startsWith(opts.fail)) {
        return fail(2, `${opts.fail}: boom`);
      }
      const digestOf = (ref: string) =>
        ref.includes("@") ? ref.slice(ref.indexOf("@") + 1) : reg.tags[ref];
      switch (argv[0]) {
        case "version":
          return ok("0.22.1\n");
        case "auth":
          return ok(`logged in via ${o.env.DOCKER_CONFIG}/config.json\n`);
        case "digest": {
          const d = digestOf(argv[1]);
          if (!d) {
            return fail(
              1,
              `Error: GET http://x/v2/manifests/x: MANIFEST_UNKNOWN: manifest unknown; map[Tag:x]`,
            );
          }
          return ok(`${d}\n`);
        }
        case "manifest": {
          const m = reg.manifests[argv[1]];
          return m ? ok(JSON.stringify(m)) : fail(1, "MANIFEST_UNKNOWN");
        }
        case "config": {
          const c = reg.configs[argv[1]];
          return c ? ok(JSON.stringify(c)) : fail(1, "MANIFEST_UNKNOWN");
        }
        case "blob": {
          const b = reg.blobs[argv[1]];
          return b ? ok(b) : fail(1, "BLOB_UNKNOWN: blob unknown");
        }
        case "copy": {
          const d = digestOf(argv[1]);
          if (!d) return fail(1, "MANIFEST_UNKNOWN");
          reg.tags[argv[2]] = d;
          return ok();
        }
        case "tag": {
          const d = digestOf(argv[1]);
          const repo = argv[1].slice(0, argv[1].indexOf("@"));
          reg.tags[`${repo}:${argv[2]}`] = d;
          return ok();
        }
      }
      return fail(99, `unexpected crane ${line}`);
    },
  );
  return { calls, restore };
}

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

Deno.test("crane-installed reports a binary that cannot run", async () => {
  const f = fake(registry());
  try {
    const res = await checks["crane-installed"].execute({
      globalArgs: {},
      repoDir: REPO,
      logger: { info: () => {} },
    });
    assertEquals(res, { pass: true });
  } finally {
    f.restore();
  }
  const restore = __setExec(() => Promise.reject(new Error("ENOENT")));
  try {
    const res = await checks["crane-installed"].execute({
      globalArgs: { craneBinary: "nope" },
      repoDir: REPO,
      logger: { info: () => {} },
    });
    assertEquals(res.pass, false);
    assertStringIncludes(res.errors![0], "nope could not be run");
  } finally {
    restore();
  }
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

Deno.test("digest resolves every reference, with a bare name under the namespace, and records first and last seen", async () => {
  const reg = registry();
  const f = fake(reg);
  try {
    const stored: Record<string, Record<string, unknown>> = {};
    const { ctx, written } = context({ namespace: "team" }, stored);
    await model.methods.digest.execute(
      { refs: ["docker.io/library/nats:2.10", "hello:v1"] },
      ctx,
    );
    assertEquals(written.map((w) => w.name), [
      "digest-docker.io-library-nats-2.10",
      "digest-registry.example.org-team-hello-v1",
    ]);
    const nats = written[0].data;
    assertEquals(nats.repository, "docker.io/library/nats");
    assertEquals(nats.name, "nats");
    assertEquals(nats.tag, "2.10");
    assertEquals(nats.digest, DIGEST_A);
    assertEquals(nats.pinned, `docker.io/library/nats:2.10@${DIGEST_A}`);
    assertEquals(nats.previousDigest, "");
    assertEquals(nats.changed, true);
    assertEquals(nats.firstSeenAt, nats.seenAt);
    assertEquals(written[1].data.ref, "registry.example.org/team/hello:v1");
    assertEquals(written[1].data.digest, DIGEST_B);
    // No credential: no login, no DOCKER_CONFIG.
    assert(!f.calls.some((c) => c.args[0] === "auth"));
    assert(f.calls.every((c) => c.env.DOCKER_CONFIG === undefined));

    // Seen again, unchanged: firstSeenAt is kept, seenAt moves on.
    const again = context({ namespace: "team" }, stored);
    await model.methods.digest.execute(
      { refs: ["docker.io/library/nats:2.10"] },
      again.ctx,
    );
    const second = again.written[0].data;
    assertEquals(second.previousDigest, DIGEST_A);
    assertEquals(second.changed, false);
    assertEquals(second.firstSeenAt, nats.firstSeenAt);

    // The tag moved: changed, and firstSeenAt starts over.
    reg.tags["docker.io/library/nats:2.10"] = DIGEST_C;
    const moved = context({ namespace: "team" }, stored);
    await model.methods.digest.execute(
      { refs: ["docker.io/library/nats:2.10"] },
      moved.ctx,
    );
    const third = moved.written[0].data;
    assertEquals(third.digest, DIGEST_C);
    assertEquals(third.previousDigest, DIGEST_A);
    assertEquals(third.changed, true);
    assertEquals(third.firstSeenAt, third.seenAt);
  } finally {
    f.restore();
  }
});

Deno.test("digest fails on a missing tag, a bare name without a registry, and a crane that cannot reach the registry", async () => {
  const f = fake(registry(), { fail: "digest ghcr.io" });
  try {
    const { ctx, written } = context();
    const missing = await assertRejects(() =>
      model.methods.digest.execute(
        { refs: ["docker.io/library/nats:nope"] },
        ctx,
      )
    );
    assertStringIncludes(String(missing), "is not in the registry");
    const down = await assertRejects(() =>
      model.methods.digest.execute({ refs: ["ghcr.io/x/y:1"] }, ctx)
    );
    assertStringIncludes(String(down), "crane digest ghcr.io/x/y:1 exited 2");
    const bare = context({ registry: "" });
    const err = await assertRejects(() =>
      model.methods.digest.execute({ refs: ["hello:v1"] }, bare.ctx)
    );
    assertStringIncludes(String(err), "has no registry");
    assertEquals(written.length + bare.written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("a credential is logged in to a docker config of its own, with the password on stdin, and the config is removed", async () => {
  const f = fake(registry());
  try {
    const { ctx, written } = context({
      username: "robot",
      password: "hunter2",
    });
    await model.methods.digest.execute(
      { refs: ["docker.io/library/nats:2.10"] },
      ctx,
    );
    const login = f.calls.find((c) => c.args[0] === "auth")!;
    assertEquals(login.args, [
      "auth",
      "login",
      "registry.example.org",
      "--username",
      "robot",
      "--password-stdin",
    ]);
    assertEquals(login.stdin, "hunter2");
    const dir = login.env.DOCKER_CONFIG;
    assert(dir.includes("crane-docker-config-"));
    assert(f.calls.every((c) => c.env.DOCKER_CONFIG === dir));
    await assertRejects(() => Deno.stat(dir), Deno.errors.NotFound);
    assertEquals(written.length, 1);
    assert(!JSON.stringify(written).includes("hunter2"));
  } finally {
    f.restore();
  }
  const noRegistry = fake(registry());
  try {
    const { ctx } = context({ registry: "", username: "u", password: "p" });
    const err = await assertRejects(() =>
      model.methods.digest.execute(
        { refs: ["docker.io/library/nats:2.10"] },
        ctx,
      )
    );
    assertStringIncludes(String(err), "nothing to log in to");
  } finally {
    noRegistry.restore();
  }
});

Deno.test("insecure adds --insecure to every crane call", async () => {
  const f = fake(registry());
  try {
    const { ctx } = context({ insecure: true });
    await model.methods.digest.execute(
      { refs: ["docker.io/library/nats:2.10"] },
      ctx,
    );
    assert(f.calls.every((c) => c.args.at(-1) === "--insecure"));
  } finally {
    f.restore();
  }
});

Deno.test("describe records an index with its platform images, and an image with its own platform", async () => {
  const f = fake(registry());
  try {
    const { ctx, written } = context();
    await model.methods.describe.execute(
      {
        refs: [
          "docker.io/library/nats:2.10",
          "registry.example.org/team/hello:v1",
        ],
      },
      ctx,
    );
    assertEquals(written.map((w) => w.name), [
      "image-docker.io-library-nats-4b9874bd1e5a",
      "image-registry.example.org-team-hello-9f86d081884c",
    ]);
    const index = written[0].data;
    assertEquals(index.kind, "index");
    assertEquals(index.digest, DIGEST_A);
    assertEquals(index.tag, "2.10");
    assertEquals(index.mediaType, "application/vnd.oci.image.index.v1+json");
    assertEquals(index.platforms, ["linux/amd64", "linux/arm64/v8"]);
    assertEquals((index.children as unknown[]).length, 3);
    assertEquals(index.configDigest, CONFIG_D);
    assertEquals(index.created, "2026-10-01T00:00:00Z");
    assertEquals(index.labels, { "org.opencontainers.image.version": "2.10" });
    assertEquals(index.annotations, {
      "org.opencontainers.image.base.name": "static:latest",
    });
    assertEquals(index.layers, 4);
    assertEquals(index.size, 2 * (1514 + 1100));
    const image = written[1].data;
    assertEquals(image.kind, "image");
    assertEquals(image.platforms, ["linux/arm64/v8"]);
    assertEquals(image.children, []);
    assertEquals(image.configDigest, CONFIG_D);
    assertEquals(image.labels, {});
    assertEquals(image.annotations, {
      "org.opencontainers.image.revision": "abc123",
    });
    assertEquals(image.layers, 2);
    assertEquals(image.size, 1514 + 1100);
    // The config of an index came from its first platform image, never from the index.
    const configs = f.calls.filter((c) => c.args[0] === "config");
    assertEquals(configs[0].args[1], `docker.io/library/nats@${DIGEST_B}`);
  } finally {
    f.restore();
  }
});

Deno.test("copy copies what is not there, leaves what is, checks the digest after, and refuses a tag", async () => {
  const reg = registry();
  const f = fake(reg);
  try {
    const { ctx, written } = context({ username: "u", password: "p" });
    const copy = (sources: string[], c = ctx) =>
      model.methods.copy.execute(CopyArgsSchema.parse({ sources }), c);
    await copy([`docker.io/library/nats:2.10@${DIGEST_A}`]);
    assertEquals(written.length, 1);
    assertEquals(
      written[0].name,
      "mirror-registry.example.org-mirror-docker.io-library-nats-2.10",
    );
    const m = written[0].data;
    assertEquals(m.source, `docker.io/library/nats@${DIGEST_A}`);
    assertEquals(m.sourceRepository, "docker.io/library/nats");
    assertEquals(
      m.target,
      "registry.example.org/mirror/docker.io/library/nats:2.10",
    );
    assertEquals(
      m.repository,
      "registry.example.org/mirror/docker.io/library/nats",
    );
    assertEquals(m.name, "docker.io/library/nats");
    assertEquals(m.tag, "2.10");
    assertEquals(m.digest, DIGEST_A);
    assertEquals(m.action, "copied");
    const argv = f.calls.find((c) => c.args[0] === "copy")!.args;
    assertEquals(argv, [
      "copy",
      `docker.io/library/nats@${DIGEST_A}`,
      "registry.example.org/mirror/docker.io/library/nats:2.10",
    ]);
    assertEquals(
      reg.tags["registry.example.org/mirror/docker.io/library/nats:2.10"],
      DIGEST_A,
    );

    // Already there with that digest: nothing is copied.
    const before = f.calls.length;
    await copy([`docker.io/library/nats:2.10@${DIGEST_A}`]);
    assertEquals(written[1].data.action, "unchanged");
    assert(!f.calls.slice(before).some((c) => c.args[0] === "copy"));

    // There with another digest: copied over.
    reg.tags["registry.example.org/mirror/docker.io/library/nats:2.10"] =
      DIGEST_C;
    await copy([`docker.io/library/nats:2.10@${DIGEST_A}`]);
    assertEquals(written[2].data.action, "copied");

    // Without a tag the target is the digest itself.
    await copy([`docker.io/library/nats@${DIGEST_A}`]);
    assertEquals(
      written[3].data.target,
      `registry.example.org/mirror/docker.io/library/nats@${DIGEST_A}`,
    );
    assertEquals(
      written[3].name,
      "mirror-registry.example.org-mirror-docker.io-library-nats-4b9874bd1e5a",
    );

    const err = await assertRejects(() =>
      copy(["docker.io/library/nats:2.10"])
    );
    assertStringIncludes(String(err), "is not pinned by digest");
    const bare = context({ registry: "" });
    const none = await assertRejects(() =>
      copy([`docker.io/library/nats@${DIGEST_A}`], bare.ctx)
    );
    assertStringIncludes(String(none), "registry is empty");
    assertEquals(bare.written.length, 0);
  } finally {
    f.restore();
  }
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

Deno.test("copy puts every source at its registry and whole path under the namespace", async () => {
  const reg = registry();
  const f = fake(reg);
  try {
    const { ctx, written } = context();
    const copy = (sources: string[]) =>
      model.methods.copy.execute(CopyArgsSchema.parse({ sources }), ctx);
    await copy([
      `docker.io/library/nats:2.10@${DIGEST_A}`,
      `registry.k8s.io/pause:3.10@${DIGEST_B}`,
    ]);
    assertEquals(written.length, 2);
    const [nats, pause] = written.map((w) => w.data);
    assertEquals(
      nats.target,
      "registry.example.org/mirror/docker.io/library/nats:2.10",
    );
    assertEquals(nats.name, "docker.io/library/nats");
    assertEquals(
      written[0].name,
      "mirror-registry.example.org-mirror-docker.io-library-nats-2.10",
    );
    assertEquals(
      pause.target,
      "registry.example.org/mirror/registry.k8s.io/pause:3.10",
    );
    assertEquals(
      reg.tags["registry.example.org/mirror/registry.k8s.io/pause:3.10"],
      DIGEST_B,
    );

    // A bare Docker Hub name lands where containerd asks for it.
    await copy([`nats:2.10@${DIGEST_A}`]);
    assertEquals(
      written[2].data.target,
      "registry.example.org/mirror/docker.io/library/nats:2.10",
    );
    assertEquals(written[2].data.action, "unchanged");

    // A registry's port joins its host with an underscore.
    await copy([`localhost:5001/team/hello:v1@${DIGEST_A}`]);
    assertEquals(
      written[3].data.target,
      "registry.example.org/mirror/localhost_5001/team/hello:v1",
    );

    const before = written.length;
    const err = await assertRejects(() =>
      copy([`ghcr.io/Team/Hello:v1@${DIGEST_A}`])
    );
    assertStringIncludes(String(err), "cannot be mirrored");
    assertEquals(written.length, before);
  } finally {
    f.restore();
  }
});

Deno.test("copy refuses two sources at one target or one record name, before copying anything", async () => {
  const reg = registry();
  const f = fake(reg);
  try {
    const { ctx, written } = context();
    const copy = (sources: string[]) =>
      model.methods.copy.execute(CopyArgsSchema.parse({ sources }), ctx);
    const target = await assertRejects(() =>
      copy([
        `docker.io/nats:2.10@${DIGEST_A}`,
        `docker.io/library/nats:2.10@${DIGEST_A}`,
      ])
    );
    assertStringIncludes(
      String(target),
      "land at the same target registry.example.org/mirror/docker.io/library/nats:2.10",
    );
    // Different targets, one record name: / and - both write as -.
    const record = await assertRejects(() =>
      copy([
        `ghcr.io/foo-bar/baz:v1@${DIGEST_A}`,
        `ghcr.io/foo/bar-baz:v1@${DIGEST_B}`,
      ])
    );
    assertStringIncludes(
      String(record),
      "land at the same record mirror-registry.example.org-mirror-ghcr.io-foo-bar-baz-v1",
    );
    assertEquals(written.length, 0);
    assert(!f.calls.some((c) => c.args[0] === "copy"));
  } finally {
    f.restore();
  }
});

Deno.test("tag writes to a repository copy made, its whole path under the namespace", async () => {
  const reg = registry();
  reg.tags["registry.example.org/mirror/docker.io/library/nats:2.10"] =
    DIGEST_A;
  const f = fake(reg);
  try {
    const { ctx, written } = context();
    await model.methods.tag.execute(
      { name: "docker.io/library/nats", digest: DIGEST_A, tag: "stable" },
      ctx,
    );
    assertEquals(
      written[0].data.ref,
      "registry.example.org/mirror/docker.io/library/nats:stable",
    );
    assertEquals(
      reg.tags["registry.example.org/mirror/docker.io/library/nats:stable"],
      DIGEST_A,
    );
  } finally {
    f.restore();
  }
});

Deno.test("copy fails, and writes nothing, when the digest after the copy is not the source's", async () => {
  const reg = registry();
  const restore = __setExec((_bin, args) => {
    const ok = (s: string) =>
      Promise.resolve({ code: 0, stdout: enc(s), stderr: "" });
    if (args[0] === "digest") {
      return reg.tags[args[1]]
        ? ok(reg.tags[args[1]] + "\n")
        : Promise.resolve({
          code: 1,
          stdout: new Uint8Array(),
          stderr: "MANIFEST_UNKNOWN",
        });
    }
    if (args[0] === "copy") {
      reg.tags[args[2]] = DIGEST_C; // a registry that rewrites what it stores
      return ok("");
    }
    return ok("");
  });
  try {
    const { ctx, written } = context();
    const err = await assertRejects(() =>
      model.methods.copy.execute(
        { sources: [`docker.io/library/nats:2.10@${DIGEST_A}`] },
        ctx,
      )
    );
    assertStringIncludes(String(err), `after the copy, expected ${DIGEST_A}`);
    assertEquals(written.length, 0);
  } finally {
    restore();
  }
});

Deno.test("a failing crane reports its argv and stderr, and nothing is written", async () => {
  const f = fake(registry(), { fail: "copy" });
  try {
    const { ctx, written } = context();
    const err = await assertRejects(() =>
      model.methods.copy.execute(
        { sources: [`docker.io/library/nats:2.10@${DIGEST_A}`] },
        ctx,
      )
    );
    assertStringIncludes(
      String(err),
      `crane copy docker.io/library/nats@${DIGEST_A} registry.example.org/mirror/docker.io/library/nats:2.10 exited 2: copy: boom`,
    );
    assertEquals(written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("tag points a tag at a digest and records what it held before", async () => {
  const reg = registry();
  reg.tags["registry.example.org/mirror/nats:2.10"] = DIGEST_A;
  const f = fake(reg);
  try {
    const { ctx, written } = context();
    await model.methods.tag.execute(
      { name: "nats", digest: DIGEST_A, tag: "stable" },
      ctx,
    );
    assertEquals(
      written[0].name,
      "tagging-registry.example.org-mirror-nats-stable",
    );
    const t = written[0].data;
    assertEquals(t.ref, "registry.example.org/mirror/nats:stable");
    assertEquals(t.repository, "registry.example.org/mirror/nats");
    assertEquals(t.name, "nats");
    assertEquals(t.tag, "stable");
    assertEquals(t.digest, DIGEST_A);
    assertEquals(t.previousDigest, "");
    assertEquals(t.changed, true);
    assertEquals(f.calls.find((c) => c.args[0] === "tag")!.args, [
      "tag",
      `registry.example.org/mirror/nats@${DIGEST_A}`,
      "stable",
    ]);

    // Already there: no crane tag.
    const before = f.calls.length;
    await model.methods.tag.execute(
      { name: "nats", digest: DIGEST_A, tag: "stable" },
      ctx,
    );
    assertEquals(written[1].data.changed, false);
    assertEquals(written[1].data.previousDigest, DIGEST_A);
    assert(!f.calls.slice(before).some((c) => c.args[0] === "tag"));

    // Moved: the old digest is recorded.
    reg.tags["registry.example.org/mirror/nats:2.11"] = DIGEST_B;
    await model.methods.tag.execute(
      { name: "nats", digest: DIGEST_B, tag: "stable" },
      ctx,
    );
    assertEquals(written[2].data.previousDigest, DIGEST_A);
    assertEquals(written[2].data.changed, true);

    const bad = await assertRejects(() =>
      model.methods.tag.execute(
        { name: "nats", digest: DIGEST_A, tag: "a b" },
        ctx,
      )
    );
    assertStringIncludes(String(bad), "is not an image tag");
    const name = await assertRejects(() =>
      model.methods.tag.execute(
        { name: "Nats", digest: DIGEST_A, tag: "x" },
        ctx,
      )
    );
    assertStringIncludes(String(name), "not a repository path");
  } finally {
    f.restore();
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

Deno.test("blob reads a file out of a Flux-like artifact layer and records it as text and JSON", async () => {
  const reg = registry();
  reg.tags["registry.example.org/shop/config-prod:candidate"] = DIGEST_C;
  reg.manifests[`registry.example.org/shop/config-prod@${DIGEST_C}`] = {
    mediaType: "application/vnd.oci.image.manifest.v1+json",
    config: {
      mediaType: "application/vnd.cncf.flux.config.v1+json",
      size: 233,
      digest: CONFIG_D,
    },
    layers: [{
      mediaType: "application/vnd.cncf.flux.content.v1.tar+gzip",
      size: 400,
      digest: LAYER_E,
    }],
  };
  reg.blobs[`registry.example.org/shop/config-prod@${LAYER_E}`] = await gzip(
    tar({ "release.json": RELEASE, "manifests.yaml": "kind: X\n" }),
  );
  const f = fake(reg);
  try {
    const { ctx, written } = context();
    const blob = (a: z.input<typeof BlobArgsSchema>) =>
      model.methods.blob.execute(BlobArgsSchema.parse(a), ctx);
    await blob({
      ref: "registry.example.org/shop/config-prod:candidate",
      path: "release.json",
    });
    assertEquals(
      written[0].name,
      "blob-registry.example.org-shop-config-prod-2cf24dba5fb0-release.json",
    );
    const b = written[0].data;
    assertEquals(b.ref, "registry.example.org/shop/config-prod:candidate");
    assertEquals(b.digest, DIGEST_C);
    assertEquals(b.layerDigest, LAYER_E);
    assertEquals(
      b.layerMediaType,
      "application/vnd.cncf.flux.content.v1.tar+gzip",
    );
    assertEquals(b.path, "release.json");
    assertEquals(b.text, RELEASE);
    assertEquals(b.json, { product: "shop", images: { api: DIGEST_A } });
    assertEquals(b.size, RELEASE.length);
    assert(/^sha256:[0-9a-f]{64}$/.test(String(b.sha256)));
    assertEquals(
      f.calls.find((c) => c.args[0] === "blob")!.args[1],
      `registry.example.org/shop/config-prod@${LAYER_E}`,
    );

    await blob({
      ref: `registry.example.org/shop/config-prod@${DIGEST_C}`,
      path: "manifests.yaml",
    });
    assertEquals(written[1].data.json, null);
    assertEquals(written[1].data.text, "kind: X\n");

    await blob({ ref: "registry.example.org/shop/config-prod:candidate" });
    assertEquals(written[2].name.endsWith("-layer"), true);
    assertEquals(
      written[2].data.size,
      reg.blobs[`registry.example.org/shop/config-prod@${LAYER_E}`].length,
    );

    const noLayer = await assertRejects(() =>
      blob({ ref: "registry.example.org/shop/config-prod:candidate", layer: 3 })
    );
    assertStringIncludes(String(noLayer), "has 1 layers, no layer 3");
    const index = await assertRejects(() =>
      blob({ ref: "docker.io/library/nats:2.10", path: "x" })
    );
    assertStringIncludes(String(index), "is an index, not an artifact");
    assertEquals(written.length, 3);
  } finally {
    f.restore();
  }
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
