import { assertEquals } from "jsr:@std/assert@1";
import type { Spawn } from "./_helpers.ts";

/** A spawn that answers one scripted call at a time and refuses anything else. */
export function script(
  calls: Array<{ bin: string; args: string[]; out: string; fail?: string }>,
): { spawn: Spawn; done: () => void } {
  let i = 0;
  const spawn: Spawn = (bin, args) => {
    const c = calls[i++];
    if (!c) throw new Error(`unexpected spawn: ${bin} ${args.join(" ")}`);
    assertEquals({ bin, args }, { bin: c.bin, args: c.args });
    return Promise.resolve(
      c.fail
        ? { success: false, stdout: "", stderr: c.fail }
        : { success: true, stdout: c.out, stderr: "" },
    );
  };
  return { spawn, done: () => assertEquals(i, calls.length, "calls left") };
}

/** A HelmRelease as kubectl prints it, trimmed to what the parser reads. */
export const hrItem = {
  metadata: { name: "kps", namespace: "monitoring" },
  spec: {
    chart: {
      spec: {
        chart: "kube-prometheus-stack",
        version: "65.x",
        sourceRef: { kind: "HelmRepository", name: "prom", namespace: "flux" },
      },
    },
  },
  status: {
    conditions: [{ type: "Ready", status: "True", reason: "Ok", message: "" }],
    history: [{
      chartVersion: "65.1.0",
      appVersion: "v0.77",
      status: "deployed",
    }],
    lastAttemptedRevision: "65.1.0",
    observedGeneration: 3,
  },
};

/** A method context that records writes and log lines. */
export function ctx(globalArgs: { namespace: string; context?: string }) {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];
  return {
    written,
    logs,
    context: {
      globalArgs,
      logger: { info: (m: string) => logs.push(m) },
      writeResource: (spec: string, name: string, data: unknown) => {
        written.push({ spec, name, data });
        return Promise.resolve({ name });
      },
    },
  };
}
