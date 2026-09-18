/**
 * Test doubles for the `@dataverket/openstack` models: a scripted fake for
 * the CLI runner and a recording method context. Not shipped.
 *
 * @module
 */
import { __setRunner, type RunResult } from "./cli.ts";
import type { DataHandle, GlobalArgs, ModelContext } from "./common.ts";

/** Global arguments every test uses; a clouds.yaml entry named `example`. */
export const globalArgs: GlobalArgs = {
  cloud: "example",
  openstackPath: "openstack",
  concurrency: 2,
};

/** One recorded CLI invocation (`args` excludes the binary and `-f json`). */
export interface Call {
  args: string[];
  env: Record<string, string>;
}

/**
 * A script answers each CLI invocation. Return a JSON-serialisable value for
 * a successful `-f json` call, a {@link RunResult} for full control, or
 * `undefined` to fail the test with an "unexpected call" error.
 */
export type Script = (args: string[]) => unknown;

function isRunResult(v: unknown): v is RunResult {
  return typeof v === "object" && v !== null && "code" in v && "stdout" in v;
}

/** A successful invocation printing `value` as JSON (or text). */
export function ok(value: unknown = ""): RunResult {
  return {
    code: 0,
    stdout: typeof value === "string" ? value : JSON.stringify(value),
    stderr: "",
  };
}

/** A failed invocation with `stderr`. */
export function fail(stderr: string, code = 1): RunResult {
  return { code, stdout: "", stderr };
}

/** The CLI's "not found" complaint for a noun and target. */
export function notFound(noun: string, target: string): RunResult {
  return fail(`No ${noun} with a name or ID of '${target}' exists.`);
}

/** Install `script` as the CLI runner and record every call. */
export function installFake(script: Script): {
  calls: Call[];
  restore(): void;
} {
  const calls: Call[] = [];
  __setRunner((argv, opts) => {
    const args = argv.slice(1);
    if (args.length >= 2 && args.at(-2) === "-f" && args.at(-1) === "json") {
      args.splice(-2, 2);
    }
    calls.push({ args, env: opts.env });
    const answer = script(args);
    if (answer === undefined) {
      return Promise.reject(
        new Error(`unexpected openstack call: ${args.join(" ")}`),
      );
    }
    return Promise.resolve(isRunResult(answer) ? answer : ok(answer));
  });
  return { calls, restore: () => __setRunner() };
}

/** Space-joined args of a call, for readable assertions. */
export function line(call: Call): string {
  return call.args.join(" ");
}

/** A recording {@link ModelContext}. */
export function makeContext(overrides: Partial<GlobalArgs> = {}): {
  context: ModelContext;
  written: { spec: string; name: string; data: Record<string, unknown> }[];
  deleted: string[];
  logs: { level: string; message: string }[];
} {
  const written: {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[] = [];
  const deleted: string[] = [];
  const logs: { level: string; message: string }[] = [];
  const log = (level: string) => (message: string) => {
    logs.push({ level, message });
  };
  const context: ModelContext = {
    globalArgs: { ...globalArgs, ...overrides },
    logger: { debug: log("debug"), info: log("info"), warning: log("warning") },
    repoDir: "/repo",
    writeResource(spec, name, data): Promise<DataHandle> {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    deleteResource(name): Promise<void> {
      deleted.push(name);
      return Promise.resolve();
    },
  };
  return { context, written, deleted, logs };
}
