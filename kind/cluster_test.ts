import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  __setExec,
  type CommandResult,
  type Context,
  GlobalArgsSchema,
  model,
} from "./cluster.ts";

type Call = { bin: string; args: string[] };

/** A fake kind and kubectl: `clusters` is what `kind get clusters` lists. */
function fake(opts: { clusters: string[]; readyz?: boolean }) {
  const calls: Call[] = [];
  const restore = __setExec((bin, args): Promise<CommandResult> => {
    calls.push({ bin, args });
    const ok = (stdout = "") =>
      Promise.resolve({ code: 0, stdout, stderr: "" });
    const line = args.join(" ");
    if (line === "get clusters") return ok(opts.clusters.join("\n") + "\n");
    if (line.startsWith("create cluster")) {
      opts.clusters.push(args[args.indexOf("--name") + 1]);
      return ok();
    }
    if (line.startsWith("delete cluster")) return ok();
    if (line.endsWith("get --raw /readyz")) {
      return opts.readyz === false
        ? Promise.resolve({ code: 1, stdout: "", stderr: "connection refused" })
        : ok("ok");
    }
    if (line.startsWith("config view")) return ok("https://127.0.0.1:51271");
    if (line.includes(" apply -f ")) return ok();
    return Promise.resolve({
      code: 99,
      stdout: "",
      stderr: `unexpected ${line}`,
    });
  });
  return { calls, restore };
}

function context(over: Record<string, unknown> = {}) {
  const written: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const ctx: Context = {
    globalArgs: GlobalArgsSchema.parse({
      clusterName: "t",
      configPath: "kind.yaml",
      manifests: ["a.yaml"],
      ...over,
    }),
    repoDir: "/repo",
    logger: { info: (msg) => logs.push(msg) },
    writeResource: (_spec, name, data) => {
      written.push(data);
      return Promise.resolve({ name });
    },
  };
  return { ctx, written, logs };
}

Deno.test("ensure creates a missing cluster and applies the manifests", async () => {
  const f = fake({ clusters: [] });
  try {
    const { ctx, written } = context();
    await model.methods.ensure.execute({}, ctx);
    assertEquals(
      f.calls.filter((c) => c.args[0] === "create").map((c) => c.args),
      [[
        "create",
        "cluster",
        "--name",
        "t",
        "--config",
        "kind.yaml",
        "--wait",
        "120s",
      ]],
    );
    assertEquals(written[0].created, true);
    assertEquals(written[0].context, "kind-t");
    assertEquals(written[0].apiServer, "https://127.0.0.1:51271");
    assertEquals(written[0].manifestsApplied, ["a.yaml"]);
  } finally {
    f.restore();
  }
});

Deno.test("ensure leaves an existing cluster and still applies the manifests", async () => {
  const f = fake({ clusters: ["other", "t"] });
  try {
    const { ctx, written } = context();
    await model.methods.ensure.execute({}, ctx);
    assertEquals(f.calls.some((c) => c.args[0] === "create"), false);
    assertEquals(f.calls.some((c) => c.args.includes("apply")), true);
    assertEquals(written[0].created, false);
  } finally {
    f.restore();
  }
});

Deno.test("ensure fails before writing when the API server is unreachable", async () => {
  const f = fake({ clusters: ["t"], readyz: false });
  try {
    const { ctx, written } = context();
    const err = await assertRejects(() =>
      model.methods.ensure.execute({}, ctx)
    );
    assertStringIncludes(String(err), "docker start t-control-plane");
    assertEquals(written.length, 0);
  } finally {
    f.restore();
  }
});

Deno.test("get records a missing cluster without creating it", async () => {
  const f = fake({ clusters: [] });
  try {
    const { ctx, written } = context();
    await model.methods.get.execute({}, ctx);
    assertEquals(f.calls.map((c) => c.args.join(" ")), ["get clusters"]);
    assertEquals(written[0].exists, false);
    assertEquals(written[0].apiServer, "");
  } finally {
    f.restore();
  }
});

Deno.test("delete succeeds when the cluster is already gone", async () => {
  const f = fake({ clusters: [] });
  try {
    const { ctx, written } = context();
    await model.methods.delete.execute({}, ctx);
    assertEquals(f.calls.some((c) => c.args[0] === "delete"), false);
    assertEquals(written[0].exists, false);
  } finally {
    f.restore();
  }
});

Deno.test("a failing command reports its argv and stderr", async () => {
  const restore = __setExec(() =>
    Promise.resolve({ code: 1, stdout: "", stderr: "docker is not running" })
  );
  try {
    const { ctx } = context();
    const err = await assertRejects(() => model.methods.get.execute({}, ctx));
    assertStringIncludes(
      String(err),
      "kind get clusters exited 1: docker is not running",
    );
  } finally {
    restore();
  }
});
