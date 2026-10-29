import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import { __setSpawn, type Spawn } from "./_helpers.ts";
import {
  absolute,
  annotationRecord,
  extension,
  instanceName,
  parsePushOutput,
  parseTarget,
  pushArgs,
  type PushArtifactArgs,
  PushArtifactArgsSchema,
  type PushContext,
} from "./push_artifact.ts";
import { script } from "./test_support.ts";

const DIGEST =
  "sha256:5bcbe925869d58f39ea96ecb84ac6ee53b8bd2c0ab21c14574f7beac6c799c82";
const REPOSITORY = "registry.example.org/team/config";
const SOURCE = "https://git.example.com/team/config";
const REVISION = "main@sha1:0123456789abcdef0123456789abcdef01234567";

function printed(repository: string, tag: string, digest = DIGEST): string {
  return JSON.stringify({
    url: `oci://${repository}@${digest}`,
    repository,
    tag,
    digest,
  }) + "\n";
}

/** A method context in a temporary repository root, recording writes and logs. */
function ctx(repoDir: string) {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];
  const context: PushContext = {
    globalArgs: { namespace: "" },
    repoDir,
    logger: { info: (m: string) => logs.push(m) },
    writeResource: (spec, name, data) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { written, logs, context };
}

const method = extension.methods[0].push_artifact;
const push = (a: Partial<PushArtifactArgs>, context: PushContext) =>
  method.execute(
    PushArtifactArgsSchema.parse({ source: SOURCE, revision: REVISION, ...a }),
    context,
  );

Deno.test("parseTarget reads oci://<repository>:<tag>, or repository and tag, and refuses the rest", () => {
  assertEquals(
    parseTarget({ target: `oci://${REPOSITORY}:v1`, repository: "", tag: "" }),
    {
      repository: REPOSITORY,
      tag: "v1",
    },
  );
  assertEquals(
    parseTarget({
      target: "oci://localhost:5002/team/config:test",
      repository: "",
      tag: "",
    }),
    { repository: "localhost:5002/team/config", tag: "test" },
  );
  assertEquals(
    parseTarget({ target: "", repository: REPOSITORY, tag: "v1.2.3" }),
    { repository: REPOSITORY, tag: "v1.2.3" },
  );
  for (
    const [a, phrase] of [
      [
        { target: `oci://${REPOSITORY}:v1`, repository: REPOSITORY, tag: "v1" },
        "not both",
      ],
      [{ target: "", repository: "", tag: "" }, "is required"],
      [{ target: "", repository: REPOSITORY, tag: "" }, "is required"],
      [
        { target: `oci://${REPOSITORY}@${DIGEST}`, repository: "", tag: "" },
        "names a digest",
      ],
      [
        { target: `oci://${REPOSITORY}`, repository: "", tag: "" },
        "is not oci://",
      ],
      [
        { target: `${REPOSITORY}:v1`, repository: "", tag: "" },
        "is not oci://",
      ],
      [{ target: "oci://config:v1", repository: "", tag: "" }, "is not oci://"],
      [
        { target: "", repository: "config", tag: "v1" },
        "is not <registry>/<path>",
      ],
      [{ target: "", repository: REPOSITORY, tag: "a b" }, "is not an OCI tag"],
    ] as [{ target: string; repository: string; tag: string }, string][]
  ) {
    const r = parseTarget(a);
    assertEquals(typeof r, "string", JSON.stringify(a));
    assertStringIncludes(r as string, phrase);
  }
});

Deno.test("pushArgs pins the flux invocation, parsePushOutput reads the digest", () => {
  assertEquals(
    pushArgs({
      repository: REPOSITORY,
      tag: "v1",
      path: "/repo/out",
      source: SOURCE,
      revision: REVISION,
      annotations: ["org.opencontainers.image.licenses=AGPL-3.0-only"],
      insecureRegistry: true,
    }),
    [
      "push",
      "artifact",
      `oci://${REPOSITORY}:v1`,
      "--path",
      "/repo/out",
      "--source",
      SOURCE,
      "--revision",
      REVISION,
      "--reproducible",
      "--output",
      "json",
      "--annotations",
      "org.opencontainers.image.licenses=AGPL-3.0-only",
      "--insecure-registry",
    ],
  );
  assertEquals(parsePushOutput(printed(REPOSITORY, "v1")), {
    url: `oci://${REPOSITORY}@${DIGEST}`,
    repository: REPOSITORY,
    tag: "v1",
    digest: DIGEST,
  });
  assertThrows(
    () => parsePushOutput("pushing...\n"),
    Error,
    "did not print JSON",
  );
  assertThrows(
    () => parsePushOutput('{"digest":"abc"}'),
    Error,
    "no sha256 digest",
  );
  assertEquals(annotationRecord(["a=1", "b=x=y", "a=2"]), { a: "2", b: "x=y" });
  assertEquals(absolute("/repo", "out"), "/repo/out");
  assertEquals(absolute("/repo", "./out"), "/repo/out");
  assertEquals(absolute("/repo", "/abs"), "/abs");
  assertEquals(
    instanceName("localhost:5002/team/config", "test"),
    "localhost-5002-team-config--test",
  );
});

Deno.test("the extension adds push_artifact and a flux check scoped to it on the source type", () => {
  assertEquals(extension.type, "@dataverket/flux/source");
  assertEquals(Object.keys(extension.methods[0]), ["push_artifact"]);
  assertEquals(extension.checks[0]["flux-cli-available"].appliesTo, [
    "push_artifact",
  ]);
  assertEquals(extension.checks[0]["flux-cli-available"].labels, ["live"]);
});

Deno.test("push_artifact with metadata pushes a copy holding release.json and leaves the directory alone", async () => {
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  const seen: {
    bin: string;
    args: string[];
    pushed: string;
    files: string[];
    release: unknown;
  }[] = [];
  const spawn: Spawn = async (bin, args) => {
    const pushed = args[args.indexOf("--path") + 1];
    const files: string[] = [];
    for await (const e of Deno.readDir(pushed)) files.push(e.name);
    const release = JSON.parse(
      await Deno.readTextFile(`${pushed}/release.json`),
    );
    seen.push({ bin, args, pushed, files: files.sort(), release });
    return { success: true, stdout: printed(REPOSITORY, "abc123"), stderr: "" };
  };
  __setSpawn(spawn);
  try {
    await Deno.mkdir(`${root}/out/nested`, { recursive: true });
    await Deno.writeTextFile(`${root}/out/manifests.yaml`, "kind: ConfigMap\n");
    await Deno.writeTextFile(`${root}/out/nested/other.yaml`, "kind: Secret\n");
    const { written, context, logs } = ctx(root);
    const metadata = {
      images: [{ name: "api", digest: DIGEST }],
      commit: "abc123",
    };
    await push({
      path: "out",
      target: `oci://${REPOSITORY}:abc123`,
      metadata,
      annotations: ["org.opencontainers.image.revision=abc123"],
    }, context);

    assertEquals(seen.length, 1);
    assertEquals(seen[0].bin, "flux");
    assertEquals(seen[0].args.slice(0, 3), [
      "push",
      "artifact",
      `oci://${REPOSITORY}:abc123`,
    ]);
    // A copy was pushed, with release.json beside the copied tree.
    assertEquals(seen[0].pushed !== `${root}/out`, true);
    assertEquals(seen[0].files, ["manifests.yaml", "nested", "release.json"]);
    assertEquals(seen[0].release, metadata);
    assertEquals(
      await Deno.readTextFile(`${seen[0].pushed}/nested/other.yaml`).catch(() =>
        "gone"
      ),
      "gone",
      "the copy is removed afterwards",
    );
    // The source directory is untouched.
    const names: string[] = [];
    for await (const e of Deno.readDir(`${root}/out`)) names.push(e.name);
    assertEquals(names.sort(), ["manifests.yaml", "nested"]);

    assertEquals(written.length, 1);
    assertEquals(written[0].spec, "artifact");
    assertEquals(written[0].name, "registry.example.org-team-config--abc123");
    const data = written[0].data as Record<string, unknown>;
    assertEquals(data.ref, `${REPOSITORY}@${DIGEST}`);
    assertEquals(data.url, `oci://${REPOSITORY}@${DIGEST}`);
    assertEquals(data.repository, REPOSITORY);
    assertEquals(data.tag, "abc123");
    assertEquals(data.digest, DIGEST);
    assertEquals(data.path, `${root}/out`);
    assertEquals(data.releaseJson, true);
    assertEquals(data.source, SOURCE);
    assertEquals(data.revision, REVISION);
    assertEquals(data.annotations, {
      "org.opencontainers.image.revision": "abc123",
    });
    assertEquals(data.reproducible, true);
    assertEquals(logs[0], "release.json written into a copy of {path}");
    assertEquals(logs.length, 3);
  } finally {
    __setSpawn();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("push_artifact without metadata pushes the directory itself, by repository and tag", async () => {
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  const s = script([{
    bin: "flux",
    args: pushArgs({
      repository: REPOSITORY,
      tag: "v1",
      path: `${root}/out`,
      source: SOURCE,
      revision: REVISION,
      annotations: [],
      insecureRegistry: false,
    }),
    out: printed(REPOSITORY, "v1"),
  }]);
  __setSpawn(s.spawn);
  try {
    await Deno.mkdir(`${root}/out`);
    const { written, context } = ctx(root);
    await push(
      { path: `${root}/out`, repository: REPOSITORY, tag: "v1" },
      context,
    );
    s.done();
    const data = written[0].data as Record<string, unknown>;
    assertEquals(data.releaseJson, false);
    assertEquals(data.tag, "v1");
    assertEquals(data.annotations, {});
  } finally {
    __setSpawn();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("push_artifact refuses a bad target, annotation or directory before running flux", async () => {
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  const s = script([]);
  __setSpawn(s.spawn);
  try {
    await Deno.mkdir(`${root}/out`);
    await Deno.writeTextFile(`${root}/file`, "");
    const { written, context } = ctx(root);
    for (
      const [a, phrase] of [
        [{ path: "out", target: `oci://${REPOSITORY}` }, "is not oci://"],
        [{
          path: "out",
          target: `oci://${REPOSITORY}:v1`,
          annotations: ["novalue"],
        }, "is not key=value"],
        [
          { path: "missing", target: `oci://${REPOSITORY}:v1` },
          "cannot be read",
        ],
        [
          { path: "file", target: `oci://${REPOSITORY}:v1` },
          "is not a directory",
        ],
      ] as [Partial<PushArtifactArgs>, string][]
    ) {
      const err = await assertRejects(() => push(a, context));
      assertStringIncludes(String(err), phrase);
    }
    s.done();
    assertEquals(written.length, 0);
  } finally {
    __setSpawn();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("a failing flux push writes nothing and removes the copy", async () => {
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  let pushed = "";
  __setSpawn((_bin, args) => {
    pushed = args[args.indexOf("--path") + 1];
    return Promise.resolve({
      success: false,
      stdout: "",
      stderr: "unauthorized: authentication required",
    });
  });
  try {
    await Deno.mkdir(`${root}/out`);
    const { written, context } = ctx(root);
    const err = await assertRejects(() =>
      push(
        { path: "out", target: `oci://${REPOSITORY}:v1`, metadata: {} },
        context,
      )
    );
    assertStringIncludes(String(err), "flux push failed: unauthorized");
    assertEquals(written.length, 0);
    await assertRejects(() => Deno.stat(pushed));
  } finally {
    __setSpawn();
    await Deno.remove(root, { recursive: true });
  }
});

// The real flux against a throwaway registry. FLUX_E2E=1 enables it;
// FLUX_E2E_REPOSITORY names the repository, localhost:5002/team/config by
// default, in a registry that needs no credentials.
const e2e = Deno.env.get("FLUX_E2E") === "1";

Deno.test({
  name:
    "e2e: push a directory with release.json, push it again to the same digest, pull it back",
  ignore: !e2e,
  fn: async () => {
    const repository = Deno.env.get("FLUX_E2E_REPOSITORY") ??
      "localhost:5002/team/config";
    const root = await Deno.makeTempDir({ prefix: "flux-push-e2e-" });
    try {
      await Deno.mkdir(`${root}/out`);
      await Deno.writeTextFile(
        `${root}/out/manifests.yaml`,
        "apiVersion: v1\nkind: ConfigMap\n",
      );
      const metadata = { images: [{ name: "api", digest: DIGEST }] };
      const first = ctx(root);
      await push(
        { path: "out", target: `oci://${repository}:test`, metadata },
        first.context,
      );
      const a = first.written[0].data as Record<string, unknown>;
      assertEquals(/^sha256:[0-9a-f]{64}$/.test(String(a.digest)), true);
      assertEquals(a.ref, `${repository}@${a.digest}`);
      assertEquals(a.url, `oci://${repository}@${a.digest}`);
      assertEquals(a.releaseJson, true);

      const again = ctx(root);
      await push(
        { path: "out", target: `oci://${repository}:test`, metadata },
        again.context,
      );
      assertEquals(
        (again.written[0].data as Record<string, unknown>).digest,
        a.digest,
        "reproducible",
      );

      const pulled = `${root}/pulled`;
      await Deno.mkdir(pulled);
      const out = await new Deno.Command("flux", {
        args: [
          "pull",
          "artifact",
          `oci://${repository}:test`,
          "--output",
          pulled,
        ],
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(out.success, true, new TextDecoder().decode(out.stderr));
      assertEquals(
        JSON.parse(await Deno.readTextFile(`${pulled}/release.json`)),
        metadata,
      );
      assertEquals(
        await Deno.readTextFile(`${pulled}/manifests.yaml`),
        "apiVersion: v1\nkind: ConfigMap\n",
      );
      const names: string[] = [];
      for await (const e of Deno.readDir(`${root}/out`)) names.push(e.name);
      assertEquals(
        names,
        ["manifests.yaml"],
        "the source directory is untouched",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
});
