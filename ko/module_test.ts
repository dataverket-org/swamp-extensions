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
  absolute,
  argumentProblem,
  BuildArgsSchema,
  checks,
  commandName,
  type CommandResult,
  type Context,
  GlobalArgsSchema,
  imageValues,
  model,
  parseRef,
  pinnedImages,
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

const DIGEST_A =
  "sha256:4b9874bd1e5a1ee8ae9a5819237de1088fa7307d419e61cb4281e849a39a0405";
const DIGEST_B =
  "sha256:9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08";
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

Deno.test("imageValues, unpinnedImages and pinnedImages list every image: value once, by digest or not", () => {
  const yaml = `
containers:
  - name: a
    image: registry.example.org/team/hello@${DIGEST_A}
  - name: b
    image: "docker.io/library/busybox:1.37"
  - image: docker.io/library/busybox:1.37 # again
  - image: "registry.example.org/team/hello@${DIGEST_A}"
initContainers:
  - image: 'registry.example.org/team/init:v1'
  - image: docker.io/library/postgres:17@${DIGEST_B}
`;
  assertEquals(imageValues(yaml), [
    `registry.example.org/team/hello@${DIGEST_A}`,
    "docker.io/library/busybox:1.37",
    "registry.example.org/team/init:v1",
    `docker.io/library/postgres:17@${DIGEST_B}`,
  ]);
  assertEquals(unpinnedImages(yaml), [
    "docker.io/library/busybox:1.37",
    "registry.example.org/team/init:v1",
  ]);
  assertEquals(pinnedImages(yaml), [
    `registry.example.org/team/hello@${DIGEST_A}`,
    `docker.io/library/postgres:17@${DIGEST_B}`,
  ]);
  assertEquals(unpinnedImages("image: a@" + DIGEST_A), []);
  assertEquals(pinnedImages("image: a:latest"), []);
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
      assertEquals(b.files.length, 1);
      assertEquals(b.files[0].spec, "buildRecord");
      assertEquals(JSON.parse(b.files[0].text), b.written[2].data);
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
      assertEquals(r.written[0].data.builtCount, 1);
      assertEquals(
        (r.written[0].data.images as { builtHere: boolean }[])[0].builtHere,
        true,
      );
      assertEquals(r.written[0].data.unpinned, [
        "docker.io/library/busybox:1.37",
      ]);
      assertStringIncludes(r.files[0].text, "@sha256:");
      assert(!r.files[0].text.includes("ko://"));

      // The rendered manifests resolved again: nothing to build, every
      // pinned image listed as not built here, the file passed through.
      await Deno.writeTextFile(`${tmp}/rendered.yaml`, r.files[0].text);
      const again = context(over);
      await resolve(
        { files: [`${tmp}/rendered.yaml`], push: false },
        again.ctx,
      );
      assertEquals(again.written[0].data.imageCount, 1);
      assertEquals(again.written[0].data.builtCount, 0);
      assertEquals(
        (again.written[0].data.images as { digest: string }[])[0].digest,
        (r.written[0].data.images as { digest: string }[])[0].digest,
      );
    } finally {
      await Deno.remove(tmp, { recursive: true });
    }
  },
});

// ───── the methods, through createModelTestContext with a stub exec ─────

const ok = (stdout = ""): CommandResult => ({ code: 0, stdout, stderr: "" });

/** One answer: a result, or a function of the call's arguments for one that must write ko's --image-refs file. */
type Answer = CommandResult | ((args: string[]) => Promise<CommandResult>);

/**
 * Routes: `[<bin> <argument prefix>, answer]`; the first route whose prefix
 * starts the call answers it. A call no route answers fails.
 */
type Routes = [string, Answer][];

/** An answer that records `refs` in the --image-refs file, as ko does, and prints `stdout`. */
const recording = (refs: string[], stdout: string): Answer => async (args) => {
  const file = args[args.indexOf("--image-refs") + 1];
  await Deno.writeTextFile(file, refs.map((r) => r + "\n").join(""));
  return ok(stdout);
};

async function withStub(
  routes: Routes,
  body: (h: {
    ctx: Context;
    calls: string[];
    written: () => Written[];
    files: () => { spec: string; name: string; text: string }[];
    logs: () => string[];
  }) => Promise<void>,
  over: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  const restore = __setExec((bin, args) => {
    const line = [bin, ...args].join(" ");
    calls.push(line);
    const r = routes.find(([prefix]) => line.startsWith(prefix));
    if (!r) {
      return Promise.reject(new Error(`the stub has no answer for ${line}`));
    }
    return typeof r[1] === "function" ? r[1](args) : Promise.resolve(r[1]);
  });
  const t = createModelTestContext({
    globalArgs: GlobalArgsSchema.parse({
      dir: "fixtures/hello",
      repo: "registry.example.org/team",
      ...over,
    }),
    repoDir: REPO,
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
      files: () =>
        t.getWrittenFiles().map((f) => ({
          spec: f.specName,
          name: f.name,
          text: new TextDecoder().decode(f.content),
        })),
      logs: () => t.getLogs().map((l) => l.message),
    });
  } finally {
    restore();
  }
}

const MOD = "example.org/hello";
const LIST_MAIN = `go list -f {{.ImportPath}} {{.Name}}`;

Deno.test("describe records the module, its versions, base image and commands", () =>
  withStub([
    ["go list -m -f", ok("1.25\n")],
    ["go list -m", ok(MOD + "\n")],
    ["go version", ok("go version go1.25.3 linux/amd64\n")],
    ["ko version", ok("0.19.0\n")],
    [
      LIST_MAIN,
      ok(
        `${MOD}/cmd/hello main\n${MOD}/cmd/other main\n${MOD}/internal/greet greet\n`,
      ),
    ],
  ], async (h) => {
    await model.methods.describe.execute({}, h.ctx);
    const [w] = h.written();
    assertEquals([w.spec, w.name], ["module", "module"]);
    assertEquals(w.data.modulePath, MOD);
    assertEquals(w.data.goVersion, "1.25");
    assertEquals(w.data.koVersion, "0.19.0");
    assertEquals(w.data.commands, [`${MOD}/cmd/hello`, `${MOD}/cmd/other`]);
    assertEquals(h.logs().at(-1), "{module} has {count} commands; ko {ko}");
  }));

Deno.test("describe fails when go cannot read the module, and writes nothing", () =>
  withStub([
    ["go list -m", {
      code: 1,
      stdout: "",
      stderr: "go: cannot find main module",
    }],
  ], async (h) => {
    const e = await assertRejects(() =>
      model.methods.describe.execute({}, h.ctx)
    );
    assertStringIncludes(String(e), "go list -m exited 1");
    assertStringIncludes(String(e), "cannot find main module");
    assertEquals(h.written(), []);
  }));

const IMG = `registry.example.org/team/hello`;

Deno.test("build records each image with its digest, the build, and the build record file", () =>
  withStub([
    ["go list -m", ok(MOD + "\n")],
    [LIST_MAIN, ok(`${MOD}/cmd/hello main\n`)],
    [
      "ko build",
      recording([`${IMG}@${DIGEST_A}`], `${IMG}@${DIGEST_A}\n`),
    ],
  ], async (h) => {
    await build({ importPaths: ["./cmd/hello"], tags: ["v1"] }, h.ctx);
    const ko = h.calls.find((c) => c.startsWith("ko build"))!;
    assertStringIncludes(ko, "--tags v1");
    const [image, rec] = h.written();
    assertEquals([image.spec, image.name], ["image", "image-cmd-hello"]);
    assertEquals([image.data.digest, image.data.pushed], [DIGEST_A, true]);
    assertEquals([rec.spec, rec.data.count, rec.data.digests], [
      "build",
      1,
      [DIGEST_A],
    ]);
    const [file] = h.files();
    assertEquals(file.spec, "buildRecord");
    assertEquals(JSON.parse(file.text).digests, [DIGEST_A]);
    assertEquals(h.logs().includes("Built {ref}"), true);
  }));

Deno.test("build fails when ko prints a reference it did not record, and writes nothing", () =>
  withStub([
    ["go list -m", ok(MOD + "\n")],
    [LIST_MAIN, ok(`${MOD}/cmd/hello main\n`)],
    ["ko build", recording([], `${IMG}@${DIGEST_A}\n`)],
  ], async (h) => {
    const e = await assertRejects(() =>
      build({ importPaths: ["./cmd/hello"] }, h.ctx)
    );
    assertStringIncludes(String(e), "but recorded 0 image references");
    assertEquals(h.written(), []);
    assertEquals(h.files(), []);
  }));

const RENDERED = `apiVersion: apps/v1
kind: Deployment
spec:
  template:
    spec:
      containers:
        - image: ${IMG}@${DIGEST_A}
        - image: docker.io/library/nats@${DIGEST_B}
        - image: docker.io/library/redis:7
`;

Deno.test("resolve records the manifests, the pinned images, which were built here, and the unpinned one", () =>
  withStub([
    ["ko resolve -f", recording([`${IMG}@${DIGEST_A}`], RENDERED)],
  ], async (h) => {
    await resolve({ files: ["fixtures/hello/deploy"] }, h.ctx);
    const [file] = h.files();
    assertEquals([file.spec, file.text], ["manifests", RENDERED]);
    const [w] = h.written();
    assertEquals([w.spec, w.name], ["resolution", "resolution"]);
    assertEquals(
      (w.data.images as { builtHere: boolean }[]).map((i) => i.builtHere),
      [true, false],
    );
    assertEquals(w.data.unpinned, ["docker.io/library/redis:7"]);
    assertEquals(w.data.allPinned, false);
  }));

Deno.test("resolve fails when ko does, and writes nothing", () =>
  withStub([
    ["ko resolve -f", {
      code: 1,
      stdout: "",
      stderr: "error: no matches for ko://example.org/nope",
    }],
  ], async (h) => {
    const e = await assertRejects(() =>
      resolve({ files: ["fixtures/hello/deploy"] }, h.ctx)
    );
    assertStringIncludes(String(e), "no matches for ko://example.org/nope");
    assertEquals(h.written(), []);
    assertEquals(h.files(), []);
  }));
