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
  argumentProblem,
  BuildArgsSchema,
  checks,
  commandName,
  type CommandResult,
  type Context,
  GlobalArgsSchema,
  model,
  parseRef,
  ResolveArgsSchema,
  unpinnedImages,
} from "./module.ts";

/** Runs build with arguments as a caller writes them, defaults applied. */
function build(a: z.input<typeof BuildArgsSchema>, ctx: Context) {
  return model.methods.build.execute(BuildArgsSchema.parse(a), ctx);
}

/** Runs resolve with arguments as a caller writes them, defaults applied. */
function resolve(a: z.input<typeof ResolveArgsSchema>, ctx: Context) {
  return model.methods.resolve.execute(ResolveArgsSchema.parse(a), ctx);
}

/** This extension's directory doubles as the repository root in tests. */
const REPO = import.meta.dirname!;
const MODULE = `${REPO}/fixtures/hello`;

type Call = {
  bin: string;
  args: string[];
  cwd: string;
  env: Record<string, string>;
};

const PACKAGES: Record<string, string> = {
  "example.org/hello/cmd/hello": "main",
  "example.org/hello/cmd/other": "main",
  "example.org/hello/internal/greet": "greet",
};

function listed(pattern: string): string[] {
  const all = Object.keys(PACKAGES);
  const rel = pattern.replace(/^\.\/?/, "");
  if (rel === "..." || rel === "") return all;
  if (rel.endsWith("/...")) {
    const prefix = `example.org/hello/${rel.slice(0, -4)}/`;
    return all.filter((p) => p.startsWith(prefix));
  }
  return all.filter((p) => p === `example.org/hello/${rel}`);
}

const DIGEST_A =
  "sha256:4b9874bd1e5a1ee8ae9a5819237de1088fa7307d419e61cb4281e849a39a0405";
const DIGEST_B =
  "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
const DIGEST_C =
  "sha256:2cf24dba5fb0a30e26e83b2ac5b9e29e1b161e5c1fa7425e73043362938b9824";

/**
 * A fake go and ko. `refFor` says what ko records for an import path, by
 * command name; `resolveOut` is what ko resolve prints.
 */
function fake(opts: {
  refFor?: (command: string, args: string[]) => string;
  resolveOut?: string;
  resolveRefs?: string[];
  fail?: string;
}) {
  const calls: Call[] = [];
  const restore = __setExec(
    async (bin, args, o): Promise<CommandResult> => {
      calls.push({ bin, args, cwd: o.cwd, env: o.env });
      const ok = (stdout = "") => ({ code: 0, stdout, stderr: "" });
      const line = args.join(" ");
      if (opts.fail && line.startsWith(opts.fail)) {
        return { code: 2, stdout: "", stderr: `${opts.fail}: boom` };
      }
      if (bin === "go" && line === "list -m") return ok("example.org/hello\n");
      if (bin === "go" && line === "list -m -f {{.GoVersion}}") {
        return ok("1.25\n");
      }
      if (bin === "go" && line === "version") {
        return ok("go version go1.27.3 darwin/arm64\n");
      }
      if (bin === "go" && args[0] === "list" && args[1] === "-f") {
        const out = args.slice(3).flatMap(listed).map((p) =>
          `${p} ${PACKAGES[p]}`
        );
        return ok(out.join("\n") + "\n");
      }
      if (bin === "ko" && line === "version") return ok("0.19.1\n");
      if (bin === "ko" && args[0] === "build") {
        const refsFile = args[args.indexOf("--image-refs") + 1];
        const importPath = args[args.length - 1];
        const command = importPath.split("/").pop()!;
        const ref = opts.refFor
          ? opts.refFor(command, args)
          : `registry.example.org/team/${command}:latest@${DIGEST_A}`;
        // A multi-platform build records each image, then the index it prints.
        const multi = args.includes("--platform") &&
          args[args.indexOf("--platform") + 1].includes(",");
        const children = multi
          ? [
            `${parseRef(ref).repository}@${DIGEST_B}`,
            `${parseRef(ref).repository}@${DIGEST_C}`,
          ]
          : [];
        await Deno.writeTextFile(
          refsFile,
          [...children, ref].join("\n") + "\n",
        );
        return ok(`2026/10/28 20:00:00 Building ${importPath}\n${ref}\n`);
      }
      if (bin === "ko" && args[0] === "resolve") {
        const refsFile = args[args.indexOf("--image-refs") + 1];
        await Deno.writeTextFile(
          refsFile,
          (opts.resolveRefs ?? []).join("\n") + "\n",
        );
        return ok(opts.resolveOut ?? "");
      }
      return { code: 99, stdout: "", stderr: `unexpected ${bin} ${line}` };
    },
  );
  return { calls, restore };
}

type Written = {
  spec: string;
  name: string;
  data: Record<string, unknown>;
  tags?: Record<string, string>;
};

function context(over: Record<string, unknown> = {}) {
  const written: Written[] = [];
  const files: { spec: string; name: string; text: string }[] = [];
  const logs: string[] = [];
  const ctx: Context = {
    globalArgs: GlobalArgsSchema.parse({
      dir: "fixtures/hello",
      repo: "registry.example.org/team",
      ...over,
    }),
    repoDir: REPO,
    logger: { info: (msg) => logs.push(msg) },
    writeResource: (spec, name, data, overrides) => {
      written.push({ spec, name, data, tags: overrides?.tags });
      return Promise.resolve({ name });
    },
    createFileWriter: (spec, name) => ({
      writeText: (text) => {
        files.push({ spec, name, text });
        return Promise.resolve({ name });
      },
    }),
  };
  return { ctx, written, files, logs };
}

Deno.test("parseRef splits registry, tarball and daemon references", () => {
  assertEquals(
    parseRef(`registry.example.org/team/hello:abc123@${DIGEST_A}`),
    {
      repository: "registry.example.org/team/hello",
      tag: "abc123",
      digest: DIGEST_A,
    },
  );
  assertEquals(
    parseRef(`hello-575b16b898e7df983ad90afce059b0b5:latest@${DIGEST_A}`),
    {
      repository: "hello-575b16b898e7df983ad90afce059b0b5",
      tag: "latest",
      digest: DIGEST_A,
    },
  );
  assertEquals(parseRef(`localhost:5000/hello@${DIGEST_A}`), {
    repository: "localhost:5000/hello",
    tag: "",
    digest: DIGEST_A,
  });
  // The daemon publisher tags the loaded image with its digest's hex.
  assertEquals(parseRef(`ko.local/hello:${DIGEST_A.slice(7)}`), {
    repository: "ko.local/hello",
    tag: "",
    digest: DIGEST_A,
  });
  assertEquals(parseRef("ko.local/hello:latest"), {
    repository: "ko.local/hello",
    tag: "latest",
    digest: "",
  });
});

Deno.test("unpinnedImages lists every image: value without a digest, once", () => {
  const yaml = `
containers:
  - name: a
    image: registry.example.org/team/hello@${DIGEST_A}
  - name: b
    image: "docker.io/library/busybox:1.37"
  - image: docker.io/library/busybox:1.37 # again
initContainers:
  - image: 'registry.example.org/team/init:v1'
`;
  assertEquals(unpinnedImages(yaml), [
    "docker.io/library/busybox:1.37",
    "registry.example.org/team/init:v1",
  ]);
  assertEquals(unpinnedImages("image: a@" + DIGEST_A), []);
});

Deno.test("absolute and commandName", () => {
  assertEquals(absolute("/repo", "fixtures/hello"), "/repo/fixtures/hello");
  assertEquals(absolute("/repo/", "./x"), "/repo/x");
  assertEquals(absolute("/repo", "/abs"), "/abs");
  assertEquals(absolute("/repo", ""), "");
  assertEquals(
    commandName("example.org/hello", "example.org/hello/cmd/hello"),
    "cmd/hello",
  );
  assertEquals(commandName("example.org/hello", "example.org/hello"), "hello");
  assertEquals(
    commandName("example.org/hello", "other.org/x/cmd/y"),
    "other.org/x/cmd/y",
  );
});

Deno.test("the arguments check refuses a repo with a scheme and a bad platform", () => {
  assertEquals(argumentProblem({ repo: "registry.example.org/team" }), null);
  assertEquals(argumentProblem({ repo: "ko.local", platforms: ["all"] }), null);
  assertStringIncludes(
    argumentProblem({ repo: "https://registry.example.org/team" })!,
    "no scheme",
  );
  assertStringIncludes(
    argumentProblem({ platforms: ["linux amd64"] })!,
    "os/arch",
  );
});

Deno.test("module-found passes for the fixture and names what is missing", async () => {
  const ok = await checks["module-found"].execute({
    globalArgs: { dir: "fixtures/hello" },
    repoDir: REPO,
  });
  assertEquals(ok, { pass: true });
  const noMod = await checks["module-found"].execute({
    globalArgs: { dir: "fixtures" },
    repoDir: REPO,
  });
  assertEquals(noMod.pass, false);
  assertStringIncludes(noMod.errors![0], "no go.mod");
  const gone = await checks["module-found"].execute({
    globalArgs: { dir: "nowhere" },
    repoDir: REPO,
  });
  assertStringIncludes(gone.errors![0], "does not exist");
});

Deno.test("ko-installed reports a binary that cannot run", async () => {
  const f = fake({});
  try {
    const res = await checks["ko-installed"].execute({
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
    const res = await checks["ko-installed"].execute({
      globalArgs: { koBinary: "nope" },
      repoDir: REPO,
      logger: { info: () => {} },
    });
    assertEquals(res.pass, false);
    assertStringIncludes(res.errors![0], "nope could not be run");
  } finally {
    restore();
  }
});

Deno.test("describe records versions, commands and the base image from .ko.yaml", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context();
    await model.methods.describe.execute({}, ctx);
    assertEquals(written.length, 1);
    const m = written[0];
    assertEquals(m.spec, "module");
    assertEquals(m.data.modulePath, "example.org/hello");
    assertEquals(m.data.goVersion, "1.25");
    assertEquals(m.data.koVersion, "0.19.1");
    assertEquals(m.data.commands, [
      "example.org/hello/cmd/hello",
      "example.org/hello/cmd/other",
    ]);
    assertEquals(m.data.configFile, `${MODULE}/.ko.yaml`);
    assertEquals(m.data.baseImage, "cgr.dev/chainguard/static:latest");
    assertEquals(m.data.baseImageSource, "config");
    // Every command ran in the module's directory with the repo in its env.
    assert(f.calls.every((c) => c.cwd === MODULE));
    assert(
      f.calls.every((c) =>
        c.env.KO_DOCKER_REPO === "registry.example.org/team"
      ),
    );
  } finally {
    f.restore();
  }
});

Deno.test("describe prefers the baseImage argument over the config", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context({
      baseImage: "example.org/base@" + DIGEST_B,
    });
    await model.methods.describe.execute({}, ctx);
    assertEquals(written[0].data.baseImageSource, "argument");
    assertEquals(written[0].data.baseImage, "example.org/base@" + DIGEST_B);
    assertEquals(
      f.calls[0].env.KO_DEFAULTBASEIMAGE,
      "example.org/base@" + DIGEST_B,
    );
  } finally {
    f.restore();
  }
});

Deno.test("build expands patterns to main packages, runs ko once per command and records each image", async () => {
  const f = fake({
    refFor: (command) =>
      `registry.example.org/team/${command}:abc123@${
        command === "hello" ? DIGEST_A : DIGEST_B
      }`,
  });
  try {
    const { ctx, written } = context({
      platforms: ["linux/amd64", "linux/arm64"],
      cache: ".cache/ko",
    });
    await build(
      {
        importPaths: ["./cmd/..."],
        tags: ["abc123"],
        ociLayout: "/tmp/out/images",
      },
      ctx,
    );
    const builds = f.calls.filter((c) =>
      c.bin === "ko" && c.args[0] === "build"
    );
    assertEquals(builds.length, 2);
    const argv = builds[0].args;
    assertEquals(argv.slice(0, -3), [
      "build",
      "--oci-layout-path",
      "/tmp/out/images",
      "--base-import-paths",
      "--platform",
      "linux/amd64,linux/arm64",
      "--sbom",
      "spdx",
      "--tags",
      "abc123",
    ]);
    assertEquals(argv[argv.length - 3], "--image-refs");
    assertEquals(argv[argv.length - 1], "example.org/hello/cmd/hello");
    assertEquals(
      builds[1].args[builds[1].args.length - 1],
      "example.org/hello/cmd/other",
    );
    assertEquals(builds[0].env.KOCACHE, `${REPO}/.cache/ko`);
    // The library package was listed but not built.
    assert(
      !builds.some((c) => c.args.includes("example.org/hello/internal/greet")),
    );

    assertEquals(written.map((w) => `${w.spec}/${w.name}`), [
      "image/image-cmd-hello",
      "image/image-cmd-other",
      "build/build",
    ]);
    const hello = written[0].data;
    assertEquals(hello.command, "cmd/hello");
    assertEquals(
      hello.ref,
      `registry.example.org/team/hello:abc123@${DIGEST_A}`,
    );
    assertEquals(hello.repository, "registry.example.org/team/hello");
    assertEquals(hello.tag, "abc123");
    assertEquals(hello.digest, DIGEST_A);
    assertEquals(hello.tags, ["abc123"]);
    assertEquals(hello.pushed, true);
    assertEquals(hello.local, false);
    assertEquals(hello.tarball, "");
    assertEquals(hello.ociLayout, "/tmp/out/images");
    assertEquals(hello.children, [
      `registry.example.org/team/hello@${DIGEST_B}`,
      `registry.example.org/team/hello@${DIGEST_C}`,
    ]);
    const buildRecord = written[2].data;
    assertEquals(buildRecord.count, 2);
    assertEquals(buildRecord.digests, [DIGEST_A, DIGEST_B]);
    assertEquals(buildRecord.id, hello.buildId);
    assertEquals(written[0].tags, { build: buildRecord.id as string });
  } finally {
    f.restore();
  }
});

Deno.test("build into the daemon passes --local and reads the digest from the tag", async () => {
  const hex = DIGEST_A.slice(7);
  const f = fake({ refFor: (command) => `ko.local/${command}:${hex}` });
  try {
    const { ctx, written } = context({ repo: "ko.local" });
    await build(
      {
        importPaths: ["./cmd/hello"],
        tags: ["abc123"],
        push: false,
        local: true,
      },
      ctx,
    );
    const argv = f.calls.find((c) => c.args[0] === "build")!.args;
    assert(argv.includes("--local"));
    assert(argv.includes("--push=false"));
    assertEquals(written[0].data.digest, DIGEST_A);
    assertEquals(written[0].data.tag, "");
    assertEquals(written[0].data.local, true);
    assertEquals(written[0].data.pushed, false);
    assertEquals(written[0].data.children, []);
  } finally {
    f.restore();
  }
});

Deno.test("build without a registry and without pushing still records a digest", async () => {
  const f = fake({ refFor: (command) => `${command}-5f1e:latest@${DIGEST_A}` });
  try {
    const { ctx, written } = context({ repo: "", naming: "default" });
    await build({
      importPaths: ["./cmd/hello"],
      push: false,
    }, ctx);
    const argv = f.calls.find((c) => c.args[0] === "build")!.args;
    assert(argv.includes("--push=false"));
    assert(!argv.includes("--base-import-paths"));
    assertEquals(written[0].data.digest, DIGEST_A);
    assertEquals(written[0].data.pushed, false);
  } finally {
    f.restore();
  }
});

Deno.test("build refuses to push with no repo, before running anything", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context({ repo: "" });
    const err = await assertRejects(() =>
      build({ importPaths: ["./cmd/hello"] }, ctx)
    );
    assertStringIncludes(String(err), "repo is empty");
    assertEquals(f.calls.length, 0);
    assertEquals(written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("build refuses a bad tag, a comma in ldflags and bare naming with two commands", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context();
    const bad = await assertRejects(() =>
      build({
        importPaths: ["./cmd/hello"],
        tags: ["v1 beta"],
      }, ctx)
    );
    assertStringIncludes(String(bad), "is not an image tag");
    const comma = await assertRejects(() =>
      build(
        { importPaths: ["./cmd/hello"], ldflags: ["-X a=b,c"] },
        ctx,
      )
    );
    assertStringIncludes(String(comma), "holds a comma");
    assertEquals(f.calls.length, 0);

    const bare = context({ naming: "bare" });
    const err = await assertRejects(() =>
      build({ importPaths: ["./cmd/..."] }, bare.ctx)
    );
    assertStringIncludes(String(err), "needs one command, got 2");
    assertEquals(f.calls.some((c) => c.args[0] === "build"), false);
    assertEquals(written.length + bare.written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("build refuses a tarball of several platforms, before running anything", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context({
      platforms: ["linux/amd64", "linux/arm64"],
    });
    const err = await assertRejects(() =>
      build({ importPaths: ["./cmd/hello"], tarball: "out/images.tar" }, ctx)
    );
    assertStringIncludes(String(err), "a tarball holds one platform");
    assertEquals(f.calls.length, 0);
    assertEquals(written.length, 0);
    const all = context({ platforms: ["all"] });
    await assertRejects(() =>
      build({ importPaths: ["./cmd/hello"], tarball: "x.tar" }, all.ctx)
    );
    const one = context({ platforms: ["linux/arm64"] });
    await build(
      { importPaths: ["./cmd/hello"], tarball: "x.tar", push: false },
      one.ctx,
    );
    assertEquals(one.written.length, 2);
  } finally {
    f.restore();
  }
});

Deno.test("build refuses a tarball for several commands, and a tarball or layout with the daemon", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context();
    const two = await assertRejects(() =>
      build({
        importPaths: ["./cmd/..."],
        tarball: "out/images.tar",
        push: false,
      }, ctx)
    );
    assertStringIncludes(String(two), "one command's image");
    assertEquals(f.calls.some((c) => c.args[0] === "build"), false);
    const local = context({ repo: "ko.local" });
    const t = await assertRejects(() =>
      build(
        { importPaths: ["./cmd/hello"], tarball: "x.tar", local: true },
        local.ctx,
      )
    );
    assertStringIncludes(String(t), "tarball is ignored");
    const l = await assertRejects(() =>
      build(
        { importPaths: ["./cmd/hello"], ociLayout: "x", push: false },
        local.ctx,
      )
    );
    assertStringIncludes(String(l), "ociLayout is ignored");
    const upper = context();
    const u = await assertRejects(() =>
      build({
        importPaths: ["./cmd/hello"],
        ociLayout: "/tmp/Out/layout",
        push: false,
      }, upper.ctx)
    );
    assertStringIncludes(String(u), "lowercase letters");
    assertEquals(written.length + local.written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("describe records a module without a main package", async () => {
  const restore = __setExec((bin, args) => {
    const ok = (stdout: string) =>
      Promise.resolve({ code: 0, stdout, stderr: "" });
    if (bin === "ko") return ok("0.19.1\n");
    if (args.join(" ") === "list -m") return ok("example.org/lib\n");
    if (args.join(" ") === "list -m -f {{.GoVersion}}") return ok("1.25\n");
    if (args[0] === "version") return ok("go version go1.27.3 darwin/arm64\n");
    return ok("example.org/lib/greet greet\n");
  });
  try {
    const { ctx, written } = context();
    await model.methods.describe.execute({}, ctx);
    assertEquals(written[0].data.commands, []);
  } finally {
    restore();
  }
});

Deno.test("build fails when the reference ko prints is not one it recorded", async () => {
  const restore = __setExec(async (bin, args) => {
    if (bin === "go") {
      return args[1] === "-m"
        ? { code: 0, stdout: "example.org/hello\n", stderr: "" }
        : { code: 0, stdout: "example.org/hello/cmd/hello main\n", stderr: "" };
    }
    await Deno.writeTextFile(
      args[args.indexOf("--image-refs") + 1],
      "a@" + DIGEST_A + "\n",
    );
    return { code: 0, stdout: "something else\n", stderr: "" };
  });
  try {
    const { ctx, written } = context();
    const err = await assertRejects(() =>
      build({ importPaths: ["./cmd/hello"] }, ctx)
    );
    assertStringIncludes(
      String(err),
      'printed "something else" but recorded 1',
    );
    assertEquals(written.length, 0);
  } finally {
    restore();
  }
});

Deno.test("build fails when no package is a main package", async () => {
  const f = fake({});
  try {
    const { ctx, written } = context();
    const err = await assertRejects(() =>
      build({ importPaths: ["./internal/greet"] }, ctx)
    );
    assertStringIncludes(String(err), "is a main package");
    assertStringIncludes(
      String(err),
      "example.org/hello/internal/greet (greet)",
    );
    assertEquals(written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("a failing ko reports its argv, directory and stderr, and nothing is written", async () => {
  const f = fake({ fail: "build" });
  try {
    const { ctx, written } = context();
    const err = await assertRejects(() =>
      build({ importPaths: ["./cmd/hello"] }, ctx)
    );
    assertStringIncludes(String(err), "ko build --base-import-paths");
    assertStringIncludes(String(err), `exited 2 in ${MODULE}: build: boom`);
    assertEquals(written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("resolve records the rendered manifests, the images and what is not pinned", async () => {
  const out = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - name: hello
          image: registry.example.org/team/hello:abc123@${DIGEST_A}
        - name: sidecar
          image: docker.io/library/busybox:1.37
`;
  const f = fake({
    resolveOut: out,
    resolveRefs: [`registry.example.org/team/hello:abc123@${DIGEST_A}`],
  });
  try {
    const { ctx, written, files } = context();
    await resolve(
      {
        files: ["fixtures/hello/deploy"],
        recursive: true,
        selector: "app=hello",
        tags: ["abc123"],
        labels: ["org.opencontainers.image.revision=abc123"],
      },
      ctx,
    );
    const argv = f.calls.find((c) => c.args[0] === "resolve")!.args;
    assertEquals(argv.slice(0, 5), [
      "resolve",
      "-f",
      `${MODULE}/deploy`,
      "-R",
      "-l",
    ]);
    assertEquals(argv[5], "app=hello");
    assert(argv.includes("--image-label"));
    assertEquals(files, [{ spec: "manifests", name: "manifests", text: out }]);
    const r = written[0];
    assertEquals(r.spec, "resolution");
    assertEquals(r.data.images, [{
      ref: `registry.example.org/team/hello:abc123@${DIGEST_A}`,
      repository: "registry.example.org/team/hello",
      tag: "abc123",
      digest: DIGEST_A,
    }]);
    assertEquals(r.data.imageCount, 1);
    assertEquals(r.data.unpinned, ["docker.io/library/busybox:1.37"]);
    assertEquals(r.data.allPinned, false);
    assertEquals(r.data.manifest, "manifests");
    assertEquals(r.data.pushed, true);
  } finally {
    f.restore();
  }
});

Deno.test("resolve fails before writing when ko fails", async () => {
  const f = fake({ fail: "resolve" });
  try {
    const { ctx, written, files } = context();
    await assertRejects(() =>
      resolve({ files: ["fixtures/hello/deploy"] }, ctx)
    );
    assertEquals(written.length, 0);
    assertEquals(files.length, 0);
  } finally {
    f.restore();
  }
});

// The real ko and go against the fixture, pushing nowhere. Needs ko on PATH
// (or KO_BINARY) and, the first time with KOCACHE set, the network for the
// base image. KO_E2E=1 enables it.
const e2e = Deno.env.get("KO_E2E") === "1";

Deno.test({
  name:
    "e2e: build to a layout and a tarball, and resolve a manifest, without a registry",
  ignore: !e2e,
  fn: async () => {
    const tmp = await Deno.makeTempDir({ prefix: "ko-e2e-" });
    try {
      const over = {
        repo: "",
        koBinary: Deno.env.get("KO_BINARY") ?? "ko",
        cache: Deno.env.get("KOCACHE") ?? `${tmp}/cache`,
        sbom: "none",
      };
      const d = context(over);
      await model.methods.describe.execute({}, d.ctx);
      assertEquals(d.written[0].data.modulePath, "example.org/hello");
      assertStringIncludes(String(d.written[0].data.koVersion), "0.19");

      // ko holds a layout path to a repository's characters: lowercase only,
      // which the default temp directory on macOS is not.
      const lay = await Deno.makeTempDir({ dir: "/tmp", prefix: "ko-e2e-" });
      const b = context(over);
      await build(
        {
          importPaths: ["./cmd/..."],
          tags: ["e2e"],
          push: false,
          ociLayout: `${lay}/layout`,
        },
        b.ctx,
      );
      assertEquals(b.written.length, 3);
      for (const w of b.written.slice(0, 2)) {
        assert(
          /^sha256:[0-9a-f]{64}$/.test(String(w.data.digest)),
          String(w.data.ref),
        );
      }
      const index = JSON.parse(
        await Deno.readTextFile(`${lay}/layout/index.json`),
      );
      assertEquals(index.manifests.length, 2, "the layout holds both images");
      await Deno.remove(lay, { recursive: true });

      const t = context(over);
      await build(
        {
          importPaths: ["./cmd/hello"],
          tags: ["e2e"],
          push: false,
          tarball: `${tmp}/images.tar`,
        },
        t.ctx,
      );
      const tar = await Deno.stat(`${tmp}/images.tar`);
      assert(tar.size > 1024 * 1024, "the tarball holds the image");

      const r = context(over);
      await resolve(
        { files: ["fixtures/hello/deploy/deployment.yaml"], push: false },
        r.ctx,
      );
      assertEquals(r.written[0].data.imageCount, 1);
      assertEquals(r.written[0].data.unpinned, [
        "docker.io/library/busybox:1.37",
      ]);
      assertStringIncludes(r.files[0].text, "@sha256:");
      assert(!r.files[0].text.includes("ko://"));
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});
