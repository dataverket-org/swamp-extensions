/**
 * The unit tests' runner stub, in the pattern of swamp's testing guide: a
 * method runs through `createModelTestContext` with a stub runner injected at
 * the `__setRunner` seam of `cli.ts`. Each test lists the few answers it
 * needs, keyed by the start of the `openstack` arguments; a call it did not
 * list fails, so a test cannot pass on a call it never meant to make. It is
 * not a model of OpenStack. The live suite in `smoke/` is the proof against a
 * real cloud. Not shipped.
 *
 * @module
 */
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import { __setRunner } from "./cli.ts";
import {
  __setPollInterval,
  type GlobalArgs,
  type ModelContext,
} from "./common.ts";

/** Global arguments every test uses; a clouds.yaml entry named `example`. */
export const G: GlobalArgs = {
  cloud: "example",
  openstackPath: "openstack",
  concurrency: 2,
};

/**
 * One answer of the stub: `json` is printed as the command's output, or the
 * command exits with `code` and `stderr`. `stdout` prints text as it is.
 */
export interface Reply {
  json?: unknown;
  stdout?: string;
  code?: number;
  stderr?: string;
}

/** A non-zero exit with `stderr`, as the CLI fails. */
export const fail = (stderr: string, code = 1): Reply => ({ code, stderr });

/** The stderr python-openstackclient prints for a missing resource. */
export const NOT_FOUND: Reply = fail("No Server found for missing");

/**
 * Routes: `[argument prefix, answer]`. The first route whose prefix starts
 * the call's arguments (joined by spaces, without the binary) answers it. An
 * array of answers is used in turn, its last one repeating, for a poll.
 */
export type Routes = [string, Reply | Reply[]][];

/** What a test sees: the context, the calls, and what the method wrote. */
export interface Harness {
  context: ModelContext;
  /** Each call's arguments, joined by spaces, without the binary. */
  calls: string[];
  written: () => {
    spec: string;
    name: string;
    data: Record<string, unknown>;
  }[];
  deleted: () => string[];
  logs: () => { level: string; message: string }[];
}

/**
 * Run `body` with the stub runner installed and a swamp test context, then
 * restore the real runner and the poll interval.
 */
export async function withStub(
  routes: Routes,
  body: (h: Harness) => Promise<void>,
  globalArgs: Partial<GlobalArgs> = {},
): Promise<void> {
  const calls: string[] = [];
  const used = new Map<number, number>();
  __setRunner((argv) => {
    const line = argv.slice(1).join(" ");
    calls.push(line);
    const i = routes.findIndex(([prefix]) => line.startsWith(prefix));
    if (i < 0) {
      return Promise.reject(new Error(`the stub has no answer for ${line}`));
    }
    const answer = routes[i][1];
    let r: Reply;
    if (Array.isArray(answer)) {
      const n = used.get(i) ?? 0;
      used.set(i, n + 1);
      r = answer[Math.min(n, answer.length - 1)];
    } else {
      r = answer;
    }
    return Promise.resolve({
      code: r.code ?? 0,
      stdout: r.stdout ?? (r.json === undefined ? "" : JSON.stringify(r.json)),
      stderr: r.stderr ?? "",
    });
  });
  __setPollInterval(0);
  const t = createModelTestContext({
    globalArgs: { ...G, ...globalArgs },
    repoDir: "/repo",
  });
  // This version of the test context has no deleteResource; the method's
  // tombstones are recorded here.
  const deleted: string[] = [];
  const context = {
    ...t.context,
    deleteResource: (name: string) => {
      deleted.push(name);
      return Promise.resolve();
    },
  } as unknown as ModelContext;
  try {
    await body({
      context,
      calls,
      written: () =>
        t.getWrittenResources().map((w) => ({
          spec: w.specName,
          name: w.name,
          data: w.data as Record<string, unknown>,
        })),
      deleted: () => [...deleted],
      logs: () =>
        t.getLogs().map((l) => ({ level: l.level, message: l.message })),
    });
  } finally {
    __setRunner();
    __setPollInterval();
  }
}
