import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1";
import { __setSpawn } from "./_helpers.ts";
import { isMissingCrd, model as source, parseSource } from "./source.ts";
import { ctx, script } from "./test_support.ts";

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

Deno.test("isMissingCrd recognises both kubectl phrasings only", () => {
  assertEquals(
    isMissingCrd("error: the server doesn't have a resource type"),
    true,
  );
  assertEquals(isMissingCrd("no matches for kind OCIRepository"), true);
  assertEquals(isMissingCrd("forbidden"), false);
});

Deno.test("source list skips a missing CRD, records the rest, and rethrows anything else", async () => {
  const s = script([
    {
      bin: "kubectl",
      args: [
        "get",
        "gitrepositories.source.toolkit.fluxcd.io",
        "-n",
        "flux-system",
        "-o",
        "json",
      ],
      out: JSON.stringify({
        items: [{
          metadata: { name: "r", namespace: "flux-system" },
          spec: { url: "https://git.example.com/r" },
        }],
      }),
    },
    {
      bin: "kubectl",
      args: [
        "get",
        "helmrepositories.source.toolkit.fluxcd.io",
        "-n",
        "flux-system",
        "-o",
        "json",
      ],
      out: "",
      fail:
        'error: the server doesn\'t have a resource type "helmrepositories"',
    },
    {
      bin: "kubectl",
      args: [
        "get",
        "ocirepositories.source.toolkit.fluxcd.io",
        "-n",
        "flux-system",
        "-o",
        "json",
      ],
      out: JSON.stringify({ items: [] }),
    },
  ]);
  const c = ctx({ namespace: "flux-system" });
  __setSpawn(s.spawn);
  try {
    const r = await source.methods.list.execute({}, c.context);
    assertEquals(r.dataHandles.length, 1);
    assertEquals(c.written[0].name, "GitRepository--flux-system--r");
    assertEquals(c.logs.some((l) => l.includes("Skipping {kind}")), true);
    s.done();
  } finally {
    __setSpawn();
  }
  const fail = script([{
    bin: "kubectl",
    args: [
      "get",
      "ocirepositories.source.toolkit.fluxcd.io",
      "-A",
      "-o",
      "json",
    ],
    out: "",
    fail: "forbidden",
  }]);
  const c2 = ctx({ namespace: "" });
  __setSpawn(fail.spawn);
  try {
    const e = await assertRejects(
      () => source.methods.list.execute({ kind: "OCIRepository" }, c2.context),
      Error,
    );
    assertStringIncludes(e.message, "forbidden");
    assertEquals(c2.written, []);
    fail.done();
  } finally {
    __setSpawn();
  }
});
