/**
 * What the tests of this extension add to the shared strict fake kubectl of
 * `../lib/kubectl_fake.ts`: a method context that records what was written
 * and logged, the planted marker values, and one wrapper that runs a test
 * body against a script of expected kubectl calls.
 */
import type { FakeTime } from "../lib/cli_fake.ts";
import {
  type Answer,
  type ExpectedKubectl,
  type FakeKubectl,
  type KubectlCall,
  SAID,
  withKubectl,
} from "../lib/kubectl_fake.ts";

export {
  type Answer,
  forbiddenList,
  HOSTILE,
  list,
  SAID,
} from "../lib/kubectl_fake.ts";
export { getArgs, listArgs as listCall } from "../lib/kubectl.ts";

/** kubectl's error text for an object that does not exist. */
export const notFound = SAID.notFound;

/** kubectl's error text for a request RBAC refuses. */
export const forbidden = SAID.forbidden;

/** The global arguments of a test's definition. */
export interface TestGlobalArgs {
  namespace: string;
  context?: string;
  kubeconfig?: string;
}

/** A method context that records writes and log lines. */
export function ctx(globalArgs: TestGlobalArgs, signal?: AbortSignal) {
  const written: Array<{ spec: string; name: string; data: unknown }> = [];
  const logs: string[] = [];
  const log = (m: string, props?: Record<string, string>) => {
    logs.push(
      m.replace(/\{(\w+)\}/g, (_, k: string) => props?.[k] ?? `{${k}}`),
    );
  };
  return {
    written,
    logs,
    context: {
      globalArgs,
      signal,
      logger: { info: log, warning: log },
      // deno-lint-ignore no-explicit-any
      writeResource: (spec: string, name: string, data: any) => {
        written.push({ spec, name, data });
        return Promise.resolve({ spec, name });
      },
    },
  };
}

/** Everything a test run produced, as one string, to search for a secret. */
export function everything(
  c: { written: unknown; logs: string[] },
  ...errors: unknown[]
): string {
  return JSON.stringify(c.written) + "\n" + c.logs.join("\n") + "\n" +
    errors.map((e) => e instanceof Error ? e.message : String(e)).join("\n");
}

/** Marker values a fixture plants where a credential reference would be. */
export const PLANTED = {
  secretName: "PLANTED-secret-name",
  secretKey: "PLANTED-secret-key",
  password: "PLANTED-passw0rd",
  token: "PLANTEDtoken0123456789",
  commandOutput: "PLANTED-command-output",
};

/**
 * Run `body` against the strict fake kubectl with `calls` scripted, a sleep
 * that returns at once and a clock that only moves when told to; then check
 * that every scripted call was made. The fake demands the kubeconfig and
 * context of `globalArgs` on every call. `more.handler` answers the calls
 * that are not scripted, with the fake in hand, so a test can move the clock
 * as a slow call would, or cancel the run, before it answers.
 */
export function withScript(
  calls: ExpectedKubectl[],
  globalArgs: TestGlobalArgs,
  body: (
    c: ReturnType<typeof ctx>,
    k: FakeKubectl & FakeTime,
  ) => Promise<void>,
  more: {
    signal?: AbortSignal;
    handler?: (
      call: KubectlCall,
      k: FakeKubectl & FakeTime,
    ) => Answer | undefined;
  } = {},
): Promise<void> {
  let fake: (FakeKubectl & FakeTime) | undefined;
  return withKubectl({
    kubeconfig: globalArgs.kubeconfig,
    context: globalArgs.context,
    calls,
    handler: (call) => more.handler?.(call, fake!),
  }, async (k) => {
    fake = k;
    await body(ctx(globalArgs, more.signal), k);
  });
}
