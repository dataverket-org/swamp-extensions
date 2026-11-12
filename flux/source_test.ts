import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { instanceName } from "./push_artifact.ts";
import { KIND_TO_RESOURCE, model, parseSource } from "./source.ts";
import { forbidden, harness, list } from "./stub_test.ts";

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

Deno.test("source names and artifact names cannot be the same name on one model", () => {
  // An artifact name always holds the escaped "/" of its repository, and a
  // Kubernetes name holds no underscore.
  const artifact = instanceName("GitRepository--apps/podinfo", "v1");
  assertEquals(artifact.includes("_2f"), true);
  assertEquals(/_/.test("GitRepository--apps--podinfo"), false);
});

// ───── the methods, through createModelTestContext with a stub spawn ─────

const M = model.methods;
const GIT = KIND_TO_RESOURCE.GitRepository;
const HELM = KIND_TO_RESOURCE.HelmRepository;
const OCI = KIND_TO_RESOURCE.OCIRepository;
const git = {
  apiVersion: "source.toolkit.fluxcd.io/v1",
  kind: "GitRepository",
  metadata: { name: "repo", namespace: "flux-system" },
  spec: { url: "https://bot:hunter2@git.example.com/org/repo" },
  status: { conditions: [{ type: "Ready", status: "True" }] },
};

Deno.test("list records each source under <kind>--<namespace>--<name>, skips a kind whose CRD is missing, and stores no credential", async () => {
  using h = harness({
    [`kubectl get ${GIT} -n flux-system`]: { stdout: list([git]) },
    [`kubectl get ${HELM} -n flux-system`]: { stdout: list([]) },
    [`kubectl get ${OCI} -n flux-system`]: {
      code: 1,
      stderr:
        `error: the server doesn't have a resource type "ocirepositories"`,
    },
  }, { globalArgs: { namespace: "flux-system" } });
  await M.list.execute({}, h.context);
  const w = h.written();
  assertEquals(w.map((x) => [x.spec, x.name]), [[
    "source",
    "GitRepository--flux-system--repo",
  ]]);
  assertEquals(JSON.stringify(w).includes("hunter2"), false);
  assertEquals(
    h.logs().includes("Skipping {kind}: CRD not installed"),
    true,
  );
});

Deno.test("list passes on a refused read of the kind asked for and records nothing", async () => {
  using h = harness({
    [`kubectl get ${GIT} -A`]: forbidden("list", GIT),
  });
  await assertRejects(
    () => M.list.execute({ kind: "GitRepository" }, h.context),
    Error,
    "forbidden",
  );
  assertEquals(h.written(), []);
});
