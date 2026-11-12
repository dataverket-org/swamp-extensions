import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { harness } from "./stub_test.ts";
import {
  absolute,
  annotationRecord,
  copyKind,
  extension,
  instanceName,
  parsePushOutput,
  parseTarget,
  pushArgs,
  type PushArtifactArgs,
  PushArtifactArgsSchema,
  type PushContext,
} from "./push_artifact.ts";

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
function ctx(repoDir: string, signal?: AbortSignal) {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];
  const details: string[] = [];
  const context: PushContext = {
    // A push uses no cluster: these must never reach flux.
    globalArgs: { namespace: "apps", kubeconfig: "/k", context: "c" },
    signal,
    repoDir,
    logger: {
      info: (m: string, props?: Record<string, string>) => {
        logs.push(m);
        details.push(JSON.stringify(props ?? {}));
      },
    },
    writeResource: (spec, name, data) => {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { written, logs, details, context };
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
    "localhost_3a5002_2fteam_2fconfig_3atest",
  );
});

Deno.test("NEG two different targets never share a data name", () => {
  const targets: [string, string][] = [
    ["reg/team/config", "v1"],
    ["reg/team-config", "v1"],
    ["reg/team_config", "v1"],
    ["reg/team.config", "v1"],
    ["reg/team--config", "v1"],
    ["reg/team", "config--v1"],
    ["reg/team--config--v1", "x"],
    ["reg/team_2fconfig", "v1"],
    ["reg:5000/team", "v1"],
    ["reg-5000/team", "v1"],
    ["reg/team", "v_1"],
    ["reg/team", "v-1"],
    ["reg/team", "v.1"],
    ["reg/team_3av", "1"],
  ];
  const names = targets.map(([r, t]) => instanceName(r, t));
  assertEquals(new Set(names).size, targets.length, names.join("\n"));
  for (const n of names) {
    assertEquals(/^[A-Za-z0-9._-]+$/.test(n), true, n);
  }
});

Deno.test("NEG what flux printed is not repeated with a credential in it when it cannot be used", () => {
  const e1 = assertThrows(
    () =>
      parsePushOutput(
        "✗ GET https://bot:hunter2@registry.example.org/v2/ password=hunter2",
      ),
    Error,
    "did not print JSON",
  );
  assertEquals(e1.message.includes("hunter2"), false);
  const e2 = assertThrows(
    () => parsePushOutput('{"digest":"abc","token":"hunter2"}'),
    Error,
    "no sha256 digest",
  );
  assertEquals(e2.message.includes("hunter2"), false);
  assert(e1.message.length < 250 && e2.message.length < 250);
});

Deno.test("NEG copyKind copies a directory and a regular file and nothing else", () => {
  const e = (isFile: boolean, isDirectory: boolean, isSymlink: boolean) => ({
    isFile,
    isDirectory,
    isSymlink,
  });
  assertEquals(copyKind(e(true, false, false)), "file");
  assertEquals(copyKind(e(false, true, false)), "directory");
  assertEquals(copyKind(e(false, false, true)), "skip");
  // A FIFO, a socket, a device: none of the three.
  assertEquals(copyKind(e(false, false, false)), "skip");
  // Whatever else an entry claims, a link is not followed.
  assertEquals(copyKind(e(true, false, true)), "skip");
  assertEquals(copyKind(e(false, true, true)), "skip");
});

Deno.test("the extension adds push_artifact and a flux check scoped to it on the source type", () => {
  assertEquals(extension.type, "@dataverket/flux/source");
  assertEquals(Object.keys(extension.methods[0]), ["push_artifact"]);
  assertEquals(extension.checks[0]["flux-cli-available"].appliesTo, [
    "push_artifact",
  ]);
  assertEquals(extension.checks[0]["flux-cli-available"].labels, ["live"]);
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

// ───── the method, through createModelTestContext with a stub spawn ─────

const PUSH = `flux push artifact oci://${REPOSITORY}:v1 --path`;

/** A repository root with one directory to push, removed after `fn`. */
async function inRepo(fn: (root: string) => Promise<void>): Promise<void> {
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  try {
    await Deno.mkdir(`${root}/out`);
    await Deno.writeTextFile(`${root}/out/a.yaml`, "kind: ConfigMap\n");
    await fn(root);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

Deno.test("push_artifact pushes a copy with release.json, records the digest and removes the copy", async () => {
  await inRepo(async (root) => {
    let pushedDir = "";
    let releaseJson = "";
    using h = harness({
      [`${PUSH} *`]: (c) => {
        pushedDir = c.args[c.args.indexOf("--path") + 1];
        releaseJson = Deno.readTextFileSync(`${pushedDir}/release.json`);
        return { stdout: printed(REPOSITORY, "v1") };
      },
    }, { repoDir: root });
    await method.execute(
      PushArtifactArgsSchema.parse({
        path: "out",
        target: `oci://${REPOSITORY}:v1`,
        source: SOURCE,
        revision: REVISION,
        metadata: { version: "1.2.3" },
      }),
      h.context,
    );
    assertEquals(JSON.parse(releaseJson), { version: "1.2.3" });
    assert(pushedDir !== `${root}/out`, "the copy is pushed, not the source");
    assertEquals(
      await Deno.stat(pushedDir).then(() => true, () => false),
      false,
    );
    const w = h.written();
    assertEquals(w.map((x) => [x.spec, x.name]), [[
      "artifact",
      instanceName(REPOSITORY, "v1"),
    ]]);
    assertEquals(w[0].data.ref, `${REPOSITORY}@${DIGEST}`);
    assertEquals(w[0].data.path, `${root}/out`);
    assertEquals(w[0].data.releaseJson, true);
    assert(h.logs().includes("Pushed {ref}"));
  });
});

Deno.test("push_artifact throws what flux said when the push fails, records nothing and removes the copy", async () => {
  await inRepo(async (root) => {
    let pushedDir = "";
    using h = harness({
      [`${PUSH} *`]: (c) => {
        pushedDir = c.args[c.args.indexOf("--path") + 1];
        return { code: 1, stderr: "✗ pushing artifact failed: UNAUTHORIZED" };
      },
    }, { repoDir: root });
    await assertRejects(
      () =>
        method.execute(
          PushArtifactArgsSchema.parse({
            path: "out",
            target: `oci://${REPOSITORY}:v1`,
            source: SOURCE,
            revision: REVISION,
            metadata: { version: "1.2.3" },
          }),
          h.context,
        ),
      Error,
      "flux push failed: ✗ pushing artifact failed: UNAUTHORIZED",
    );
    assertEquals(h.written(), []);
    assertEquals(
      await Deno.stat(pushedDir).then(() => true, () => false),
      false,
    );
  });
});
