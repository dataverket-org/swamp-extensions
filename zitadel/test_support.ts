/**
 * Test helpers: global arguments, a method context that records what a
 * method writes, and the stub caller the method tests inject.
 *
 * @module
 */
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import { __setCaller, type ApiCall, type Json } from "./api.ts";
import type { DataHandle, GlobalArgs, ModelContext } from "./common.ts";
import { __resetOrgCache } from "./lookup.ts";

/** One `writeResource` call a method made. */
interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

/** A context plus the writes and log lines it collected. */
interface FakeContext {
  context: ModelContext;
  written: Written[];
  logs: string[];
  /** Instance names a method tombstoned with `deleteResource`. */
  forgotten: string[];
}

/** Global arguments good enough for a method that never reaches the network. */
export function fakeGlobalArgs(
  overrides: Partial<GlobalArgs> = {},
): GlobalArgs {
  return {
    apiUrl: "https://zitadel.example.org",
    keyJson:
      '{"keyId":"1","key":"-----BEGIN RSA PRIVATE KEY-----","userId":"9"}',
    httpTimeoutMs: 30000,
    tokenScope: "openid profile urn:zitadel:iam:org:project:id:zitadel:aud",
    ...overrides,
  } as GlobalArgs;
}

/** A method context that records what a method writes and logs. */
export function makeContext(overrides: Partial<GlobalArgs> = {}): FakeContext {
  const written: Written[] = [];
  const logs: string[] = [];
  const forgotten: string[] = [];
  const log = (level: string) => (message: string) => {
    logs.push(`${level}: ${message}`);
  };
  const context: ModelContext = {
    globalArgs: fakeGlobalArgs(overrides),
    logger: {
      debug: log("debug"),
      info: log("info"),
      warning: log("warning"),
    },
    writeResource(
      spec: string,
      name: string,
      data: Record<string, unknown>,
    ): Promise<DataHandle> {
      written.push({ spec, name, data });
      return Promise.resolve({ name });
    },
    deleteResource(instanceName: string): Promise<void> {
      forgotten.push(instanceName);
      return Promise.resolve();
    },
  };
  return { context, written, logs, forgotten };
}

/**
 * The method tests' stub client, in the pattern of swamp's testing guide: a
 * method's `execute` runs through `createModelTestContext` with a stub caller
 * injected at the `__setCaller` seam. Each test lists the few answers it
 * needs, keyed `"METHOD path"`; a list of answers is used in order, one per
 * call. A call the test did not list is an error, so a test cannot pass on a
 * call it never meant to make. The stub is not a model of Zitadel: the live
 * suite in `smoke/` is the proof against a real instance.
 */
export type Reply =
  | Json
  | { status: number; message: string }
  | ((c: ApiCall) => Json);

/** An answer that fails the call as the real caller fails it. */
export function fail(
  status: number,
  message = "stub failure",
): { status: number; message: string } {
  return { status, message };
}

function isFailure(r: Reply): r is { status: number; message: string } {
  return typeof r === "object" && r !== null && "status" in r &&
    "message" in r && typeof r.status === "number" &&
    Object.keys(r).length === 2;
}

/** A marker planted in the credential; no record or log may carry it. */
export const PLANTED = "PLANTED-ZITADEL-KEY-7f3c9a";

/** Global arguments for a method test; the credential carries {@link PLANTED}. */
export const G = {
  apiUrl: "https://zitadel.example.org",
  keyJson: JSON.stringify({ keyId: "1", key: PLANTED, userId: "9" }),
  httpTimeoutMs: 1000,
  tokenScope: "openid",
};

/**
 * A context with the stub caller installed, and what the method did. Bind it
 * with `using`: leaving the scope restores the real caller, also when the
 * test throws.
 */
export function harness(
  routes: Record<string, Reply | Reply[]>,
  globalArgs: Record<string, unknown> = {},
) {
  const calls: ApiCall[] = [];
  const queues = new Map<string, Reply[]>();
  for (const [key, value] of Object.entries(routes)) {
    queues.set(key, Array.isArray(value) ? [...value] : [value]);
  }
  __resetOrgCache();
  __setCaller((_g, c) => {
    calls.push(c);
    const key = `${c.method} ${c.path}`;
    const queue = queues.get(key);
    if (!queue || queue.length === 0) {
      return Promise.reject(new Error(`the stub has no answer for ${key}`));
    }
    const reply = queue.length > 1 ? queue.shift()! : queue[0];
    if (typeof reply === "function") {
      return Promise.resolve({ status: 200, body: reply(c) });
    }
    if (isFailure(reply)) {
      return Promise.reject(
        new Error(
          `Zitadel API ${key} -> HTTP ${reply.status}: ${reply.message}`,
        ),
      );
    }
    return Promise.resolve({ status: 200, body: reply as Json });
  });
  const t = createModelTestContext({
    globalArgs: { ...G, ...globalArgs },
  });
  const deleted: string[] = [];
  const context = {
    ...t.context,
    deleteResource: (name: string) => {
      deleted.push(name);
      return Promise.resolve();
    },
  } as unknown as ModelContext;
  return {
    context,
    calls,
    /** Calls that change something. */
    writes: () =>
      calls.filter((c) => c.method !== "GET" && !/[/_]search$/.test(c.path)),
    written: () =>
      t.getWrittenResources().map((w) => ({
        spec: w.specName,
        name: w.name,
        data: w.data as Record<string, unknown>,
      })),
    logs: () =>
      t.getLogs().map((l) =>
        `${l.level}: ${l.message} ${JSON.stringify(l.args ?? [])}`
      ),
    /** Instance names the method tombstoned. */
    forgotten: deleted,
    /** Restores the real caller. */
    [Symbol.dispose]: () => __setCaller(null),
  };
}

/** Assert that no log line carries `secret`, a value the method emitted. */
export function assertNotLogged(
  h: ReturnType<typeof harness>,
  secret: string,
): void {
  if (h.logs().join("\n").includes(secret)) {
    throw new Error("an emitted secret reached a log line");
  }
}

/** Assert that nothing a method wrote or logged carries the planted key. */
export function assertNoPlanted(h: ReturnType<typeof harness>): void {
  const seen = JSON.stringify(h.written()) + h.logs().join("\n");
  if (seen.includes(PLANTED)) {
    throw new Error("the planted credential reached a record or a log");
  }
}
