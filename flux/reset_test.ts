import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1";
import {
  __setSpawn,
  cliProblem,
  extension,
  resetArgs,
  summarize,
} from "./reset.ts";

Deno.test("resetArgs pins the flux invocation", () => {
  assertEquals(resetArgs({ name: "cert-manager", namespace: "cert-manager" }), [
    "reconcile",
    "helmrelease",
    "cert-manager",
    "-n",
    "cert-manager",
    "--reset",
  ]);
  assertEquals(
    resetArgs({ name: "a", namespace: "b", withSource: true }).at(-1),
    "--with-source",
  );
});

Deno.test("summarize reads readiness, history and counters", () => {
  const r = summarize(
    {
      status: {
        installFailures: 1,
        history: [{ status: "failed" }],
        conditions: [{
          type: "Ready",
          status: "False",
          reason: "InstallFailed",
          message: "timeout",
        }],
      },
    },
    "cert-manager",
    "cert-manager",
  );
  assertEquals(r.ready, false);
  assertEquals(r.readyReason, "InstallFailed");
  assertEquals(r.deployStatus, "failed");
  assertEquals(r.installFailures, 1);
  assertEquals(r.upgradeFailures, 0);
});

const fluxChecks = extension.checks[0];

Deno.test("the CLI checks pass when the binary runs", async () => {
  const seen: { bin: string; args: string[] }[] = [];
  __setSpawn((bin, args) => {
    seen.push({ bin, args });
    return Promise.resolve({ success: true, stdout: "v2.3.0", stderr: "" });
  });
  try {
    assertEquals(
      (await fluxChecks["flux-cli-available"].execute({})).pass,
      true,
    );
    assertEquals(
      (await fluxChecks["kubectl-cli-available"].execute({})).pass,
      true,
    );
    assertEquals(seen[0], { bin: "flux", args: ["--version"] });
    assertEquals(seen[1], { bin: "kubectl", args: ["version", "--client"] });
  } finally {
    __setSpawn();
  }
});

Deno.test("a binary missing from PATH fails with a message naming it", async () => {
  __setSpawn(() => Promise.reject(new Deno.errors.NotFound("nope")));
  try {
    const r = await fluxChecks["flux-cli-available"].execute({});
    assertEquals(r.pass, false);
    assertStringIncludes(r.errors![0], "flux is not on PATH");
  } finally {
    __setSpawn();
  }
});

Deno.test("a binary that runs and fails surfaces its own stderr", async () => {
  __setSpawn(() =>
    Promise.resolve({ success: false, stdout: "", stderr: "boom" })
  );
  try {
    const r = await fluxChecks["kubectl-cli-available"].execute({});
    assertEquals(r.pass, false);
    assertStringIncludes(r.errors![0], "boom");
    assertStringIncludes(r.errors![0], "kubectl version --client");
  } finally {
    __setSpawn();
  }
});

Deno.test("cliProblem is what the checks agree on, so the two cannot drift", async () => {
  __setSpawn(() => Promise.resolve({ success: true, stdout: "", stderr: "" }));
  try {
    assertEquals(await cliProblem("flux", ["--version"]), undefined);
  } finally {
    __setSpawn();
  }
});
