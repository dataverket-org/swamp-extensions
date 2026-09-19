/**
 * Test doubles for `@dataverket/talosctl`: a scripted fake talosctl runner and
 * a recording method context. Not shipped.
 *
 * @module
 */
import { __setRunner, type RunResult } from "./talosctl.ts";
import type { DataHandle, GlobalArgs, ModelContext } from "./node.ts";

/** A script answers each invocation by its argument list (binary excluded). */
export type Script = (args: string[]) => string | RunResult | undefined;

/** A successful invocation printing `stdout`. */
export function ok(stdout = ""): RunResult {
  return { code: 0, stdout, stderr: "" };
}
/** A failed invocation. */
export function fail(stderr: string, code = 1): RunResult {
  return { code, stdout: "", stderr };
}

/** Install `script` and record every call's args and env. */
export function installFake(script: Script): {
  calls: { args: string[]; env: Record<string, string> }[];
  restore(): void;
} {
  const calls: { args: string[]; env: Record<string, string> }[] = [];
  __setRunner((argv, opts) => {
    const args = argv.slice(1);
    calls.push({ args, env: opts.env });
    const a = script(args);
    if (a === undefined) {
      return Promise.reject(new Error(`unexpected talosctl ${args.join(" ")}`));
    }
    return Promise.resolve(typeof a === "string" ? ok(a) : a);
  });
  return { calls, restore: () => __setRunner() };
}

/** A recording {@link ModelContext}. */
export function makeContext(g: Partial<GlobalArgs> = {}): {
  context: ModelContext;
  written: { spec: string; name: string; data: Record<string, unknown> }[];
} {
  const written: {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  const context: ModelContext = {
    globalArgs: { insecure: false, talosctlPath: "talosctl", ...g },
    logger: { info() {}, warning() {} },
    writeResource(spec, name, data): Promise<DataHandle> {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
  };
  return { context, written };
}
