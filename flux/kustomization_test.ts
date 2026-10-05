import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { __setSpawn } from "./_helpers.ts";
import { model as kustomization, parseKustomization } from "./kustomization.ts";
import { ctx, script } from "./test_support.ts";

Deno.test("parseKustomization reads path, prune, revisions and defaults", () => {
  const r = parseKustomization({
    metadata: { name: "flux-system", namespace: "flux-system" },
    spec: {
      path: "./clusters/prod",
      prune: true,
      interval: "10m0s",
      sourceRef: { kind: "GitRepository", name: "flux-system" },
    },
    status: {
      conditions: [{
        type: "Ready",
        status: "False",
        reason: "BuildFailed",
        message: "kustomize build failed",
      }],
      lastAppliedRevision: "main@sha1:aaa",
      lastAttemptedRevision: "main@sha1:bbb",
    },
  });
  assertEquals(r.path, "./clusters/prod");
  assertEquals(r.prune, true);
  assertEquals(r.ready, false);
  assertEquals(r.readyReason, "BuildFailed");
  assertEquals(r.lastAppliedRevision, "main@sha1:aaa");
  assertEquals(r.lastAttemptedRevision, "main@sha1:bbb");
  const d = parseKustomization({ metadata: { name: "k", namespace: "n" } });
  assertEquals(d.path, "./");
  assertEquals(d.prune, false);
  assertEquals(d.conditions, []);
});

Deno.test("a single-object method without a namespace refuses before spawning", async () => {
  const s = script([]);
  const c = ctx({ namespace: "" });
  __setSpawn(s.spawn);
  try {
    const e = await assertRejects(
      () => kustomization.methods.suspend.execute({ name: "k" }, c.context),
      Error,
    );
    assertStringIncludes(e.message, "namespace is required for suspend");
    assertEquals(c.written, []);
  } finally {
    __setSpawn();
  }
});

Deno.test("a failing flux command is an error and nothing is written", async () => {
  const s = script([{
    bin: "flux",
    args: ["suspend", "kustomization", "k", "-n", "n"],
    out: "",
    fail: 'kustomization "k" not found',
  }]);
  const c = ctx({ namespace: "n" });
  __setSpawn(s.spawn);
  try {
    const e = await assertRejects(
      () => kustomization.methods.suspend.execute({ name: "k" }, c.context),
      Error,
    );
    assertStringIncludes(e.message, "flux suspend failed");
    assertEquals(c.written, []);
    s.done();
  } finally {
    __setSpawn();
  }
});

Deno.test("kubectl output that is not JSON fails list by name", async () => {
  const s = script([{
    bin: "kubectl",
    args: [
      "get",
      "kustomizations.kustomize.toolkit.fluxcd.io",
      "-A",
      "-o",
      "json",
    ],
    out: "Unable to connect to the server",
  }]);
  const c = ctx({ namespace: "" });
  __setSpawn(s.spawn);
  try {
    const e = await assertRejects(
      () => kustomization.methods.list.execute({}, c.context),
      Error,
    );
    assertStringIncludes(e.message, "did not print JSON");
    assertEquals(c.written, []);
    s.done();
  } finally {
    __setSpawn();
  }
});
