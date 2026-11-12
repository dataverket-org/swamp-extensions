/**
 * The unit tests' stub, in the pattern of swamp's testing guide: a method
 * runs its `execute` through `createModelTestContext`, and kubectl and flux
 * are a stub spawn installed through `__setSpawn` of `../lib/cli.ts`. Each test lists
 * the few commands it needs and what each answers; a command it did not list
 * is an error, so a test cannot pass on a call it never meant to make. A
 * listed command that ends in ` *` stands for every command it begins, for a
 * path the method makes itself. The
 * stub is not a model of the cluster. The live suite in `smoke/` is the
 * proof against a real one; these tests pin what a method writes and
 * refuses.
 *
 * @module
 */
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import { __setSpawn, type SpawnOptions } from "../lib/cli.ts";

/** One command as the stub saw it. */
export interface Call {
  /** The binary and its arguments without the runner's own flags. */
  key: string;
  args: string[];
  stdin?: string;
}

/**
 * One answer: what the command prints and how it exits, or a function of
 * the call. A `stdout` that is not a string is printed as JSON.
 */
export type Reply =
  | { stdout?: unknown; stderr?: string; code?: number }
  | ((c: Call) => { stdout?: unknown; stderr?: string; code?: number });

/**
 * The command as a test names it: the binary and its arguments, without the
 * flags the kubectl runner adds to every call (the request timeout, the
 * cluster flags and the trailing `-o json`).
 */
export function keyOf(bin: string, args: string[]): string {
  const rest: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const a = args[i];
    if (a.startsWith("--request-timeout=")) continue;
    if (a === "--kubeconfig" || a === "--context") {
      i++;
      continue;
    }
    rest.push(a);
  }
  if (rest.at(-2) === "-o" && rest.at(-1) === "json") rest.splice(-2);
  return [bin, ...rest].join(" ");
}

/**
 * A swamp method context with the stub spawn installed, and what the method
 * wrote and logged. Declare it with `using`: the real spawn is put back when
 * the test ends.
 */
export function harness(
  routes: Record<string, Reply>,
  opts: {
    globalArgs?: Record<string, unknown>;
    storedResources?: Record<string, Record<string, unknown>>;
    repoDir?: string;
  } = {},
) {
  const calls: Call[] = [];
  __setSpawn((bin: string, args: string[], o: SpawnOptions) => {
    const key = keyOf(bin, args);
    const call = { key, args, stdin: o.stdin };
    calls.push(call);
    const r = routes[key] ??
      Object.entries(routes).find(([k]) =>
        k.endsWith(" *") && key.startsWith(k.slice(0, -1))
      )?.[1];
    if (r === undefined) {
      return Promise.reject(new Error(`the stub has no answer for ${key}`));
    }
    const a = typeof r === "function" ? r(call) : r;
    const out = a.stdout === undefined
      ? ""
      : typeof a.stdout === "string"
      ? a.stdout
      : JSON.stringify(a.stdout);
    return Promise.resolve({
      code: a.code ?? 0,
      stdout: new TextEncoder().encode(out),
      stderr: a.stderr ?? "",
    });
  });
  const t = createModelTestContext({
    globalArgs: opts.globalArgs ?? { namespace: "" },
    storedResources: opts.storedResources ?? {},
    ...(opts.repoDir === undefined ? {} : { repoDir: opts.repoDir }),
  });
  return {
    // deno-lint-ignore no-explicit-any
    context: t.context as any,
    calls,
    written: () =>
      t.getWrittenResources().map((w) => ({
        spec: w.specName,
        name: w.name,
        data: w.data as Record<string, unknown>,
      })),
    logs: () => t.getLogs().map((l) => l.message),
    [Symbol.dispose]: () => __setSpawn(),
  };
}

/** A List as kubectl prints it. */
export function list(items: unknown[]): Record<string, unknown> {
  return { apiVersion: "v1", kind: "List", items };
}

/** What kubectl prints on standard error for a missing object. */
export function notFound(resource: string, name: string) {
  return {
    code: 1,
    stderr: `Error from server (NotFound): ${resource} "${name}" not found`,
  };
}

/** What kubectl prints on standard error when RBAC refuses. */
export function forbidden(verb: string, resource: string) {
  return {
    code: 1,
    stderr:
      `Error from server (Forbidden): ${resource} is forbidden: User "u" cannot ${verb} resource "${resource}"`,
  };
}
