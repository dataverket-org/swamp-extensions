/**
 * Test helpers: a fake API caller and a fake method context, so every model can
 * be exercised without an instance to talk to.
 *
 * @module
 */
import {
  __resetTokenCache,
  __setCaller,
  type ApiCall,
  type Json,
} from "./api.ts";
import { __resetOrgCache } from "./lookup.ts";
import { ORG } from "./fixtures.ts";
import type { DataHandle, GlobalArgs, ModelContext } from "./common.ts";

/** One `writeResource` call a method made. */
export interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
}

/** A context plus the writes and log lines it collected. */
export interface FakeContext {
  context: ModelContext;
  written: Written[];
  logs: string[];
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
  };
  return { context, written, logs };
}

/** What a fake handler may answer with. */
export type FakeResponse = Json | { status: number; body: Json } | undefined;

/** A fake API caller, with the calls it saw and a way to put the real one back. */
export interface Fake {
  calls: ApiCall[];
  restore(): void;
}

/** One request as a handler matches it: `"POST /management/v1/projects"`. */
export function line(call: ApiCall): string {
  return `${call.method} ${call.path}`;
}

/**
 * Install a fake API caller. The handler answers each call by returning a body,
 * or `undefined` to fail the test with the call it did not expect — so a method
 * that talks to an endpoint it should not have is a failure, not a silent pass.
 */
export function installFake(
  handler: (call: ApiCall, calls: readonly ApiCall[]) => FakeResponse,
): Fake {
  const calls: ApiCall[] = [];
  __resetTokenCache();
  __resetOrgCache();
  __setCaller((_globalArgs, call) => {
    const seen = [...calls];
    calls.push(call);
    let answer = handler(call, seen);
    // Resolving the organization is a step almost every v2 user call takes, so
    // the fake answers it unless a test wants to say something else about it.
    if (answer === undefined && line(call) === "GET /management/v1/orgs/me") {
      answer = { org: ORG };
    }
    if (answer === undefined) {
      return Promise.reject(
        new Error(`unexpected call: ${line(call)}`),
      );
    }
    if (
      typeof answer === "object" && answer !== null && "status" in answer &&
      "body" in answer
    ) {
      const typed = answer as { status: number; body: Json };
      if (typed.status >= 400) {
        return Promise.reject(
          new Error(
            `Zitadel API ${line(call)} -> HTTP ${typed.status}: ${
              String(typed.body.message ?? "")
            }`,
          ),
        );
      }
      return Promise.resolve(typed);
    }
    return Promise.resolve({ status: 200, body: answer as Json });
  });
  return {
    calls,
    restore() {
      __setCaller(null);
      __resetTokenCache();
      __resetOrgCache();
    },
  };
}

/** A v1 `_search` response page. */
export function page(rows: Json[]): Json {
  return { result: rows, details: { totalResult: String(rows.length) } };
}

/** An HTTP 404 the lookups treat as "not there". */
export function notFound(what: string): { status: number; body: Json } {
  return { status: 404, body: { message: `${what} not found` } };
}
