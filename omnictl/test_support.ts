/**
 * The unit tests' runner stub, in the pattern of swamp's testing guide: a
 * method runs through `createModelTestContext` with a stub runner injected at
 * the `__setRunner` seam of `omnictl.ts`. Each test lists the few answers it
 * needs, keyed by the start of the `omnictl` arguments; a call it did not list
 * fails, so a test cannot pass on a call it never meant to make. It is not a
 * model of Omni. Not shipped.
 *
 * @module
 */
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import { __setRunner, type RunResult } from "./omnictl.ts";
import type { GlobalArgsData, MethodContext } from "./common.ts";

/** A key marker tests look for in what a method logs and writes. */
export const KEY = "TEST-OMNI-KEY-0123456789";

/** Global arguments every test uses. */
export const G: GlobalArgsData = {
  endpoint: "https://omni.example.net",
  serviceAccountKey: KEY,
  insecureSkipTlsVerify: false,
  omnictlPath: "omnictl",
};

/**
 * One answer: printed `stdout`, or an exit `code` with `stderr`; or a
 * function of the call's argv, for an answer that reads or writes a file the
 * call names.
 */
export type Reply =
  | { stdout?: string; code?: number; stderr?: string }
  | ((argv: string[]) => Promise<Partial<RunResult>> | Partial<RunResult>);

/** `[argument prefix, answer]`; the first prefix that starts the call wins. */
export type Routes = [string, Reply][];

/** What a test sees. */
export interface Harness {
  context: MethodContext;
  /** Each call's arguments after the binary, joined by spaces. */
  calls: string[];
  written: () => {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[];
  deleted: string[];
  logs: () => { level: string; message: string; text: string }[];
}

/** One COSI resource as `omnictl get -o json` prints it. */
export const cosi = (
  id: string,
  spec: Record<string, unknown> = {},
  labels: Record<string, unknown> = {},
): string => JSON.stringify({ metadata: { id, labels }, spec });

/** omnictl's text for a resource that does not exist. */
export const NOT_FOUND = { code: 1, stderr: "resource doesn't exist" };

/**
 * Run `body` with the stub runner installed and a swamp test context, then
 * restore the real runner.
 */
export async function withStub(
  routes: Routes,
  body: (h: Harness) => Promise<void>,
): Promise<void> {
  const calls: string[] = [];
  __setRunner(async (argv) => {
    const line = argv.slice(1).join(" ");
    calls.push(line);
    const hit = routes.find(([prefix]) => line.startsWith(prefix));
    if (!hit) throw new Error(`the stub has no answer for ${line}`);
    const r = typeof hit[1] === "function" ? await hit[1](argv) : hit[1];
    return {
      code: r.code ?? 0,
      stdout: r.stdout ?? "",
      stderr: r.stderr ?? "",
    };
  });
  const t = createModelTestContext({ globalArgs: G, repoDir: "/repo" });
  // This version of the test context has no deleteResource; record it here.
  const deleted: string[] = [];
  const context = {
    ...t.context,
    deleteResource: (name: string) => {
      deleted.push(name);
      return Promise.resolve();
    },
  } as unknown as MethodContext;
  try {
    await body({
      context,
      calls,
      deleted,
      written: () =>
        t.getWrittenResources().map((w) => ({
          spec: w.specName,
          name: w.name,
          data: w.data as Record<string, unknown>,
        })),
      logs: () =>
        t.getLogs().map((l) => ({
          level: l.level,
          message: l.message,
          text: `${l.message} ${JSON.stringify(l.args)}`,
        })),
    });
  } finally {
    __setRunner();
  }
}
