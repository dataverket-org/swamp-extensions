import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { forbiddenList, list, SAID, withKubectl } from "../lib/kubectl_fake.ts";
import { isKubectlError } from "../lib/kubectl.ts";
import { instanceName } from "./push_artifact.ts";
import { KIND_TO_RESOURCE, model as source, parseSource } from "./source.ts";
import { ctx } from "./test_support.ts";

const GIT = KIND_TO_RESOURCE.GitRepository;
const HELM = KIND_TO_RESOURCE.HelmRepository;
const OCI = KIND_TO_RESOURCE.OCIRepository;

const repo = (kind: string, name: string, namespace: string) => ({
  kind,
  metadata: { name, namespace },
  spec: { url: `https://git.example.com/${name}` },
});

Deno.test("parseSource keeps the kind, ref and artifact", () => {
  const r = parseSource({
    metadata: { name: "repo", namespace: "flux-system" },
    spec: {
      url: "https://git.example.com/org/repo",
      interval: "1h0m0s",
      ref: { branch: "main" },
    },
    status: {
      artifact: {
        revision: "main@sha1:abc",
        digest: "sha256:def",
        size: 1234,
      },
      conditions: [{ type: "Ready", status: "True" }],
    },
  }, "GitRepository");
  assertEquals(r.kind, "GitRepository");
  assertEquals(r.ref, { branch: "main" });
  assertEquals(r.artifact?.revision, "main@sha1:abc");
  assertEquals(r.artifact?.size, 1234);
  assertEquals(r.ready, true);
  const none = parseSource(
    { metadata: { name: "x", namespace: "y" } },
    "OCIRepository",
  );
  assertEquals(none.url, "");
  assertEquals(none.artifact, undefined);
});

Deno.test("source list skips a kind whose CRD is missing, however kubectl says it, and records the rest under the published names", async () => {
  for (
    const missing of [
      SAID.missingCrd("helmrepositories"),
      SAID.noKind("HelmRepository", "source.toolkit.fluxcd.io/v1"),
    ]
  ) {
    const c = ctx({ namespace: "flux-system" });
    await withKubectl({
      calls: [
        {
          args: ["get", GIT, "-n", "flux-system"],
          out: list([repo("GitRepository", "r", "flux-system")]),
        },
        { args: ["get", HELM, "-n", "flux-system"], fail: missing },
        {
          args: ["get", OCI, "-n", "flux-system"],
          out: list([repo("OCIRepository", "o", "flux-system")]),
        },
      ],
    }, async () => {
      const r = await source.methods.list.execute({}, c.context);
      assertEquals(r.dataHandles.length, 2);
    });
    assertEquals(c.written.map((w) => [w.spec, w.name]), [
      ["source", "GitRepository--flux-system--r"],
      ["source", "OCIRepository--flux-system--o"],
    ]);
    assertEquals(c.logs.some((l) => l.includes("Skipping {kind}")), true);
    assertEquals(Object.keys(c.written[0].data as object).sort(), [
      "artifact",
      "conditions",
      "interval",
      "kind",
      "name",
      "namespace",
      "observedGeneration",
      "ready",
      "readyMessage",
      "readyReason",
      "ref",
      "suspended",
      "url",
    ]);
  }
  assertEquals(Object.keys(source.resources.source.schema.shape).length, 13);
});

Deno.test("NEG a source URL with a user or a password in it is stored without them, and so is a message that quotes it", async () => {
  const c = ctx({ namespace: "" });
  await withKubectl({
    calls: [{
      args: ["get", GIT, "-A"],
      out: list([{
        kind: "GitRepository",
        metadata: { name: "r", namespace: "n" },
        spec: { url: "https://bot:hunter2@git.example.org/team/repo.git" },
        status: {
          conditions: [{
            type: "Ready",
            status: "False",
            reason: "GitOperationFailed",
            message:
              "failed to clone https://bot:hunter2@git.example.org/team/repo.git: authentication required",
          }],
        },
      }, {
        kind: "GitRepository",
        metadata: { name: "s", namespace: "n" },
        spec: { url: "ssh://git@git.example.org/team/repo.git" },
      }]),
    }],
  }, async () => {
    await source.methods.list.execute({ kind: "GitRepository" }, c.context);
  });
  assertEquals(JSON.stringify(c.written).includes("hunter2"), false);
  const [first, second] = c.written.map((w) => w.data as { url: string });
  assertEquals(first.url, "https://git.example.org/team/repo.git");
  assertEquals(second.url, "ssh://git.example.org/team/repo.git");
});

Deno.test("source names and artifact names cannot be the same name on one model", () => {
  // An artifact name always holds the escaped "/" of its repository, and a
  // Kubernetes name holds no underscore.
  const artifact = instanceName("GitRepository--apps/podinfo", "v1");
  assertEquals(artifact.includes("_2f"), true);
  assertEquals(/_/.test("GitRepository--apps--podinfo"), false);
});

Deno.test("source list with kind reads that kind only, in every namespace when none is set", async () => {
  const c = ctx({ namespace: "", context: "c" });
  await withKubectl({
    context: "c",
    calls: [{ args: ["get", OCI, "-A"], out: list([]) }],
  }, async () => {
    await source.methods.list.execute({ kind: "OCIRepository" }, c.context);
  });
  assertEquals(c.written, []);
});

Deno.test("NEG anything but a missing CRD is rethrown: refused, logged out, unreachable, not a list", async () => {
  for (
    const [answer, kind] of [
      [forbiddenList(OCI), "forbidden"],
      [{ fail: SAID.unauthorized }, "unauthorized"],
      [{ fail: SAID.refused }, "unreachable"],
      [{ hang: true }, "timeout"],
      [{ out: "<html>" }, "not-json"],
      [{ out: { kind: "Status" } }, "other"],
      [{ out: list([repo("GitRepository", "r", "n")]) }, "other"],
    ] as const
  ) {
    const c = ctx({ namespace: "" });
    await withKubectl({
      calls: [{ args: ["get", OCI, "-A"], ...answer }],
    }, async () => {
      const e = await assertRejects(
        () => source.methods.list.execute({ kind: "OCIRepository" }, c.context),
        Error,
      );
      assertEquals(isKubectlError(e) && e.kind, kind);
    });
    assertEquals(c.written, []);
  }
});

Deno.test("NEG a namespace that is a flag is refused before kubectl runs, and a colliding pair before its kind is written", async () => {
  await withKubectl({}, async () => {
    for (const namespace of ["-A", "--all-namespaces", "a b"]) {
      await assertRejects(
        () =>
          source.methods.list.execute(
            { namespace },
            ctx({ namespace: "" }).context,
          ),
        Error,
        "is not a Kubernetes namespace name",
      );
    }
  });
  const c = ctx({ namespace: "" });
  await withKubectl({
    calls: [{
      args: ["get", GIT, "-A"],
      out: list([
        repo("GitRepository", "b--c", "a"),
        repo("GitRepository", "c", "a--b"),
      ]),
    }],
  }, async () => {
    await assertRejects(
      () => source.methods.list.execute({ kind: "GitRepository" }, c.context),
      Error,
      "GitRepository a/b--c and a--b/c would both be stored as a--b--c",
    );
  });
  assertEquals(c.written, []);
});
