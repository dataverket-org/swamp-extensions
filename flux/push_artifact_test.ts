import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { CAPTURE, withCli } from "../lib/cli_fake.ts";
import { isCliError } from "../lib/cli.ts";
import {
  absolute,
  annotationRecord,
  copyKind,
  extension,
  instanceName,
  MAX_DATA_NAME_BYTES,
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

Deno.test("NEG a target whose data name would be longer than a file name can be is refused before the directory is copied and before flux pushes", async () => {
  assertEquals(MAX_DATA_NAME_BYTES, 255);
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  const before = leftovers();
  try {
    await Deno.mkdir(`${root}/out`);
    // "r/" + pad + ":t": the escaped name is the pad plus 8 bytes.
    const target = (pad: number) => `oci://r/${"a".repeat(pad)}:t`;
    assertEquals(instanceName(`r/${"a".repeat(247)}`, "t").length, 255);
    const { written, context } = ctx(root);
    await withCli({
      calls: [{
        bin: "flux",
        args: pushArgs({
          repository: `r/${"a".repeat(247)}`,
          tag: "t",
          path: `${root}/out`,
          source: SOURCE,
          revision: REVISION,
          annotations: [],
          insecureRegistry: false,
        }),
        out: printed("r/x", "t"),
      }],
    }, async () => {
      // 255 bytes is stored.
      await push({ path: "out", target: target(247) }, context);
      assertEquals(written.length, 1);
      // 256 is not, and neither is a 123 character repository with a 128
      // character tag full of underscores, which is 376 bytes escaped.
      for (
        const t of [
          target(248),
          `oci://${"r".repeat(60)}/${"p".repeat(62)}:${"_".repeat(128)}`,
        ]
      ) {
        const e = await assertRejects(
          () => push({ path: "out", target: t, metadata: {} }, context),
          Error,
          "more than the 255 a data name can be",
        );
        assert(e.message.length < 400);
      }
      assertEquals(written.length, 1);
    });
    assertEquals(leftovers(), before);
  } finally {
    await Deno.remove(root, { recursive: true });
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

Deno.test("NEG a source address with a user or password in it is stored without them", async () => {
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  try {
    await Deno.mkdir(`${root}/out`);
    const { written, context } = ctx(root);
    await withCli({
      handler: ({ bin }) =>
        bin === "flux" ? { out: printed(REPOSITORY, "v1") } : undefined,
    }, async () => {
      await push({
        path: "out",
        target: `oci://${REPOSITORY}:v1`,
        source: "https://bot:hunter2@git.example.com/team/config",
      }, context);
    });
    assertEquals(JSON.stringify(written).includes("hunter2"), false);
    assertEquals(
      (written[0].data as { source: string }).source,
      "https://git.example.com/team/config",
    );
  } finally {
    await Deno.remove(root, { recursive: true });
  }
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

/** The scratch directories push_artifact has left in the temporary directory. */
function leftovers(): string[] {
  const tmp = Deno.env.get("TMPDIR") ?? "/tmp";
  return [...Deno.readDirSync(tmp)].map((e) => e.name).filter((n) =>
    n.startsWith("flux-push-artifact-")
  ).sort();
}

Deno.test("NEG only regular files and directories are copied: a link and a socket are skipped and named, as flux itself skips them", async () => {
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  const before = leftovers();
  let files: string[] = [];
  let listener: Deno.Listener | undefined;
  try {
    await Deno.mkdir(`${root}/out/sub`, { recursive: true });
    await Deno.writeTextFile(`${root}/out/a.yaml`, "a\n");
    await Deno.writeTextFile(`${root}/out/sub/b.yaml`, "b\n");
    await Deno.symlink("/etc/passwd", `${root}/out/link`);
    await Deno.symlink("sub", `${root}/out/dirlink`);
    // Not a file, not a directory, not a link: copying it would fail, and a
    // FIFO in its place would block. Deno can only make one with net
    // permission (`deno test ... --allow-net`); without it the links alone
    // are tested.
    const expected = ["dirlink", "link"];
    try {
      listener = Deno.listen({
        transport: "unix",
        path: `${root}/out/sub/sock`,
      });
      expected.push("sub/sock");
    } catch (err) {
      if (!(err instanceof Deno.errors.NotCapable)) throw err;
    }
    const { written, context, details } = ctx(root);
    await withCli({
      handler: ({ bin, args }) => {
        if (bin !== "flux") return undefined;
        const pushed = args[args.indexOf("--path") + 1];
        const walk = (dir: string, pre = ""): string[] =>
          [...Deno.readDirSync(dir)].flatMap((e) =>
            e.isDirectory
              ? walk(`${dir}/${e.name}`, `${pre}${e.name}/`)
              : [`${pre}${e.name}`]
          );
        files = walk(pushed).sort();
        return { out: printed(REPOSITORY, "v1") };
      },
    }, async () => {
      await push(
        { path: "out", target: `oci://${REPOSITORY}:v1`, metadata: {} },
        context,
      );
    });
    assertEquals(files, ["a.yaml", "release.json", "sub/b.yaml"]);
    assertEquals(written.length, 1);
    const said = details.join("\n");
    for (const skipped of expected) {
      assertStringIncludes(said, skipped);
    }
    assertEquals(leftovers(), before);
  } finally {
    listener?.close();
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("NEG a copy that fails or is cancelled leaves no partial copy behind, and flux does not run", async () => {
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  const before = leftovers();
  try {
    await Deno.mkdir(`${root}/out/sub`, { recursive: true });
    await Deno.writeTextFile(`${root}/out/a.yaml`, "a\n");
    await Deno.writeTextFile(`${root}/out/sub/secret.yaml`, "b\n");
    await Deno.chmod(`${root}/out/sub/secret.yaml`, 0o000);
    const args = {
      path: "out",
      target: `oci://${REPOSITORY}:v1`,
      metadata: {},
    };
    await withCli({}, async () => {
      const unreadable = ctx(root);
      await assertRejects(() => push(args, unreadable.context));
      assertEquals(unreadable.written, []);
      assertEquals(leftovers(), before, "after a failed copy");

      await Deno.chmod(`${root}/out/sub/secret.yaml`, 0o600);
      const controller = new AbortController();
      controller.abort();
      const cancelled = ctx(root, controller.signal);
      await assertRejects(
        () => push(args, cancelled.context),
        Error,
        "cancelled",
      );
      assertEquals(cancelled.written, []);
      assertEquals(leftovers(), before, "after a cancelled copy");
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
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
  try {
    await Deno.mkdir(`${root}/out/nested`, { recursive: true });
    await Deno.writeTextFile(`${root}/out/manifests.yaml`, "kind: ConfigMap\n");
    await Deno.writeTextFile(`${root}/out/nested/other.yaml`, "kind: Secret\n");
    const { written, context, logs } = ctx(root);
    const metadata = {
      images: [{ name: "api", digest: DIGEST }],
      commit: "abc123",
    };
    // The fake flux looks at what it was given while the copy still exists.
    await withCli({
      handler: ({ bin, args, timeoutMs }) => {
        if (bin !== "flux" || timeoutMs !== 330_000) return undefined;
        const pushed = args[args.indexOf("--path") + 1];
        const files = [...Deno.readDirSync(pushed)].map((e) => e.name);
        const release = JSON.parse(
          Deno.readTextFileSync(`${pushed}/release.json`),
        );
        seen.push({ bin, args, pushed, files: files.sort(), release });
        return { out: printed(REPOSITORY, "abc123") };
      },
    }, async () => {
      await push({
        path: "out",
        target: `oci://${REPOSITORY}:abc123`,
        metadata,
        annotations: ["org.opencontainers.image.revision=abc123"],
      }, context);
    });

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
    assertEquals(
      written[0].name,
      "registry.example.org_2fteam_2fconfig_3aabc123",
    );
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
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("push_artifact without metadata pushes the directory itself, by repository and tag", async () => {
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  try {
    await Deno.mkdir(`${root}/out`);
    const { written, context } = ctx(root);
    await withCli({
      calls: [{
        bin: "flux",
        // Word for word: no kubeconfig and no context, though the model has both.
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
        timeoutMs: 330_000,
      }],
    }, async () => {
      await push(
        { path: `${root}/out`, repository: REPOSITORY, tag: "v1" },
        context,
      );
    });
    const data = written[0].data as Record<string, unknown>;
    assertEquals(data.releaseJson, false);
    assertEquals(data.tag, "v1");
    assertEquals(data.annotations, {});
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

Deno.test("push_artifact refuses a bad target, annotation or directory before running flux", async () => {
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  try {
    await Deno.mkdir(`${root}/out`);
    await Deno.writeTextFile(`${root}/file`, "");
    const { written, context } = ctx(root);
    await withCli({}, async () => {
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
    });
    assertEquals(written.length, 0);
  } finally {
    await Deno.remove(root, { recursive: true });
  }
});

/** The scripted push of `out` to `v1` with metadata: the copy's path is captured. */
function pushCall(root: string) {
  const args = pushArgs({
    repository: REPOSITORY,
    tag: "v1",
    path: `${root}/out`,
    source: SOURCE,
    revision: REVISION,
    annotations: [],
    insecureRegistry: false,
  });
  args[args.indexOf("--path") + 1] = CAPTURE;
  return { bin: "flux", args };
}

Deno.test("NEG a flux push that fails, hangs, is cancelled or prints no digest writes nothing and removes the copy", async () => {
  const root = await Deno.makeTempDir({ prefix: "flux-push-test-" });
  const TOKEN = "dckr_pat_s3cr3tvalue";
  try {
    await Deno.mkdir(`${root}/out`);
    for (
      const [answer, phrase, kind] of [
        [
          { fail: "unauthorized: authentication required" },
          "flux push failed: unauthorized",
          "failed",
        ],
        [
          {
            fail:
              `► pushing artifact\n✗ pushing failed: https://user:${TOKEN}@registry.example.org/v2/ denied, password=${TOKEN}`,
          },
          "flux push failed: ✗ pushing failed",
          "failed",
        ],
        [
          { hang: true },
          "flux push failed: no answer within 330 seconds; the process was stopped",
          "timeout",
        ],
        [{ hang: "until-cancelled" }, "flux push was cancelled", "cancelled"],
        [{ notInstalled: true }, "flux is not on PATH", "not-installed"],
        [{ out: "pushed\n" }, "did not print JSON", undefined],
        [{ out: '{"digest":"abc"}' }, "no sha256 digest", undefined],
      ] as const
    ) {
      const controller = new AbortController();
      const { written, context } = ctx(root, controller.signal);
      await withCli({
        calls: [{ ...pushCall(root), ...answer }],
      }, async (k) => {
        const pending = assertRejects(
          () =>
            push(
              { path: "out", target: `oci://${REPOSITORY}:v1`, metadata: {} },
              context,
            ),
          Error,
          phrase,
        );
        if (kind === "cancelled") {
          // Let the copy be made and flux start, then cancel the run.
          while (k.calls.length === 0) {
            await new Promise((r) => setTimeout(r, 1));
          }
          controller.abort();
        }
        const err = await pending;
        assertEquals(isCliError(err) ? err.kind : undefined, kind);
        assert(!err.message.includes(TOKEN), "no credential in the error");
        assertEquals(written.length, 0);
        assertEquals(k.captured.length, 1);
        assert(k.captured[0] !== `${root}/out`, "a copy was pushed");
        await assertRejects(() => Deno.stat(k.captured[0]));
      });
    }
  } finally {
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
