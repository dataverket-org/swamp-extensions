import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1";
import {
  __setSpawn,
  cliArgs,
  cliProblem,
  extractReadyCondition,
  fluxCliCheck,
  listArgs,
  parseKubectlJson,
  requireNamespace,
  runFlux,
  runKubectl,
} from "./_helpers.ts";
import { model as helmrelease } from "./helmrelease.ts";
import { model as kustomization } from "./kustomization.ts";
import { kubectlCliCheck } from "./_helpers.ts";
import { model as source } from "./source.ts";
import { extension as reset } from "./reset.ts";
import { script } from "./test_support.ts";

const VERSION = "2026.10.05.1";

Deno.test("the three types carry the fork's name, version and upgrade", () => {
  assertEquals(helmrelease.type, "@dataverket/flux/helmrelease");
  assertEquals(kustomization.type, "@dataverket/flux/kustomization");
  assertEquals(source.type, "@dataverket/flux/source");
  for (const m of [helmrelease, kustomization, source]) {
    assertEquals(m.version, VERSION);
    assertEquals(m.upgrades.at(-1)!.toVersion, m.version);
    assertEquals(m.upgrades.at(-1)!.upgradeAttributes({ namespace: "x" }), {
      namespace: "x",
    });
  }
  assertEquals(reset.type, helmrelease.type);
});

Deno.test("the method names are upstream's", () => {
  assertEquals(Object.keys(helmrelease.methods).sort(), [
    "list",
    "reconcile",
    "resume",
    "suspend",
  ]);
  assertEquals(Object.keys(kustomization.methods).sort(), [
    "list",
    "reconcile",
    "resume",
    "suspend",
  ]);
  assertEquals(Object.keys(source.methods), ["list"]);
  assertEquals(Object.keys(reset.methods[0]), ["reset"]);
});

Deno.test("cliArgs puts kubeconfig and context before the command", () => {
  assertEquals(cliArgs(["get", "x"]), ["get", "x"]);
  assertEquals(cliArgs(["get", "x"], { kubeconfig: "/k", context: "c" }), [
    "--kubeconfig",
    "/k",
    "--context",
    "c",
    "get",
    "x",
  ]);
  assertEquals(cliArgs(["get"], { context: "c" }), ["--context", "c", "get"]);
});

Deno.test("listArgs scopes to one namespace or all", () => {
  assertEquals(listArgs("r", "ns"), ["get", "r", "-n", "ns"]);
  assertEquals(listArgs("r", ""), ["get", "r", "-A"]);
});

Deno.test("parseKubectlJson names the command when the output is not JSON", () => {
  assertEquals(parseKubectlJson('{"a":1}', ["get"]), { a: 1 });
  const e = assertThrows(
    () => parseKubectlJson("Unable to connect", ["get", "hr"]),
    Error,
  );
  assertStringIncludes(e.message, "kubectl get hr did not print JSON");
  assertStringIncludes(e.message, "Unable to connect");
  assertStringIncludes(
    assertThrows(() => parseKubectlJson("", ["get"]), Error).message,
    "(empty)",
  );
});

Deno.test("extractReadyCondition reads Ready and nothing else", () => {
  assertEquals(
    extractReadyCondition([
      { type: "Healthy", status: "True" },
      { type: "Ready", status: "True", reason: "R", message: "m" },
    ]),
    { ready: true, reason: "R", message: "m" },
  );
  assertEquals(extractReadyCondition([{ type: "Ready", status: "False" }]), {
    ready: false,
    reason: "Unknown",
    message: "",
  });
  assertEquals(extractReadyCondition([]), {
    ready: false,
    reason: "Unknown",
    message: "",
  });
});

Deno.test("requireNamespace prefers the argument and refuses by name", () => {
  assertEquals(requireNamespace("x", "a", "b"), "a");
  assertEquals(requireNamespace("x", undefined, "b"), "b");
  assertStringIncludes(
    assertThrows(() => requireNamespace("suspend", undefined, ""), Error)
      .message,
    "namespace is required for suspend",
  );
});

Deno.test("runKubectl appends -o json and names the failure", async () => {
  const s = script([
    { bin: "kubectl", args: ["get", "hr", "-A", "-o", "json"], out: "[]" },
    {
      bin: "kubectl",
      args: ["--context", "c", "get", "hr", "-o", "json"],
      out: "",
      fail: "forbidden",
    },
  ]);
  __setSpawn(s.spawn);
  try {
    assertEquals(await runKubectl(["get", "hr", "-A"]), []);
    const e = await assertRejects(
      () => runKubectl(["get", "hr"], { context: "c" }),
      Error,
    );
    assertStringIncludes(e.message, "kubectl get hr failed: forbidden");
    s.done();
  } finally {
    __setSpawn();
  }
});

Deno.test("runFlux returns stdout and surfaces stderr on failure", async () => {
  const s = script([
    { bin: "flux", args: ["reconcile", "x"], out: "ok\n" },
    { bin: "flux", args: ["suspend", "x"], out: "", fail: "not found" },
  ]);
  __setSpawn(s.spawn);
  try {
    assertEquals(await runFlux(["reconcile", "x"]), "ok\n");
    const e = await assertRejects(() => runFlux(["suspend", "x"]), Error);
    assertStringIncludes(e.message, "flux suspend failed: not found");
    s.done();
  } finally {
    __setSpawn();
  }
});

Deno.test("the shared CLI checks name a missing binary and surface a failing one", async () => {
  __setSpawn(() => Promise.reject(new Deno.errors.NotFound("nope")));
  try {
    const r = await fluxCliCheck.execute();
    assertEquals(r.pass, false);
    assertStringIncludes(r.errors![0], "flux is not on PATH");
  } finally {
    __setSpawn();
  }
  const s = script([
    { bin: "kubectl", args: ["version", "--client"], out: "", fail: "boom" },
    { bin: "kubectl", args: ["version", "--client"], out: "v1.31" },
    { bin: "kubectl", args: ["version", "--client"], out: "v1.31" },
  ]);
  __setSpawn(s.spawn);
  try {
    const r = await kubectlCliCheck.execute();
    assertEquals(r.pass, false);
    assertStringIncludes(r.errors![0], "kubectl version --client failed: boom");
    assertEquals((await kubectlCliCheck.execute()).pass, true);
    assertEquals(
      await cliProblem("kubectl", ["version", "--client"]),
      undefined,
    );
    s.done();
  } finally {
    __setSpawn();
  }
});

Deno.test("kustomization and source carry the CLI checks; helmrelease gets them from reset", () => {
  assertEquals(Object.keys(kustomization.checks), [
    "flux-cli-available",
    "kubectl-cli-available",
  ]);
  assertEquals(Object.keys(source.checks), ["kubectl-cli-available"]);
  assertEquals(Object.keys(reset.checks[0]), [
    "flux-cli-available",
    "kubectl-cli-available",
  ]);
});
