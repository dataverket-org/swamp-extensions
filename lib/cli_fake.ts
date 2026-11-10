/**
 * A strict fake of the process layer for unit tests. Every spawn must be
 * the next scripted call, word for word, or one the handler answers; a
 * binary's grammar, when given, refuses what the real tool would refuse.
 * Anything else throws, which fails the test that caused it. Calls are
 * recorded; an answer can be output, an exit code with error text, a
 * process that hangs, or a binary that is not there.
 *
 * Shared: an extension's tests import it as `../lib/cli_fake.ts`, and its
 * own `test_support.ts` holds its fixtures and builds on this. No entry
 * point imports it, so it is never part of a published extension.
 *
 * @module
 */
import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  __setClock,
  __setSleep,
  __setSpawn,
  cancelledError,
  type Spawn,
  type SpawnResult,
} from "./cli.ts";

/** Stands in a scripted argument list where any value goes; it is captured. */
export const CAPTURE = "<captured>";

/** How a call is answered. With none of the fields set: success, no output. */
export interface Answer {
  /**
   * Printed on success: text as it is, bytes as they are, anything else as
   * JSON.
   */
  out?: unknown;
  /** Standard error of a failed call. */
  fail?: string;
  /** The exit code of a failed call; 1 when left out. */
  code?: number;
  /** Standard output of a failed call; some tools print some even then. */
  stdout?: string;
  /**
   * The process does not answer. `true`: the time limit ends it.
   * `"until-cancelled"`: it runs until the signal aborts.
   */
  hang?: boolean | "until-cancelled";
  /** The binary is not there. */
  notInstalled?: boolean;
  /**
   * The process wrote more than the call's output bound and was stopped.
   * Set it to script that without a fixture of that size; an answer whose
   * output is in fact longer than the bound of the call is cut and marked
   * the same way by the fake itself.
   */
  tooLarge?: boolean;
}

/** One scripted call: what is expected, and the answer. */
export interface Expected extends Answer {
  bin: string;
  /** Every argument, exactly; `CAPTURE` where any value goes. */
  args: string[];
  /**
   * The standard input the call must be given: a string is compared as
   * text, anything else with the input parsed as JSON. A call that is given
   * input the script does not expect is refused, and so is the reverse.
   * `CAPTURE` accepts any input and captures it, for a body that holds a
   * time or another value the test cannot know in advance.
   */
  stdin?: unknown;
  /** When given, the environment additions must be exactly these. */
  env?: Record<string, string>;
  /** When given, whether the environment is cleared must match. */
  clearEnv?: boolean;
  /** When given, the working directory must be this. */
  cwd?: string;
  /** When given, the time limit must be this. */
  timeoutMs?: number;
  /** When given, the output bound must be this. */
  maxOutputBytes?: number;
}

/** A call as it was spawned. */
export interface SpawnedCall {
  bin: string;
  args: string[];
  stdin?: string;
  env?: Record<string, string>;
  clearEnv?: boolean;
  cwd?: string;
  timeoutMs: number;
  maxOutputBytes?: number;
}

/**
 * Checks one binary's call as the real tool would and throws to refuse it.
 * It may return the arguments the script is matched against, for a layer
 * that adds flags of its own to every call.
 */
export type Grammar = (call: SpawnedCall) => string[] | void;

/** How the fake is set up. */
export interface FakeCliOptions {
  /** The calls expected, in order. */
  calls?: Expected[];
  /** Grammars by binary name; a binary without one is matched as spawned. */
  grammar?: Record<string, Grammar>;
  /**
   * Answers a call that is not the next scripted one: a fake tool. Return
   * undefined to refuse the call.
   */
  handler?: (call: SpawnedCall, matchArgs: string[]) => Answer | undefined;
}

/** What a test holds on to. */
export interface FakeCli {
  spawn: Spawn;
  /** Every call that was answered, in order. */
  calls: SpawnedCall[];
  /** The values that stood where the script said `CAPTURE`. */
  captured: string[];
  /** Fails when scripted calls are left unused. */
  done: () => void;
}

/**
 * A grammar from a list of flags: any argument that starts with `-` must be
 * one of `flags`, or `name=value` for a flag listed as `name=`. An argument
 * after `--` is not looked at.
 */
export function knownFlags(flags: string[]): Grammar {
  return (call) => {
    for (const a of call.args) {
      if (a === "--") return;
      if (!a.startsWith("-")) continue;
      const ok = flags.some((f) => f.endsWith("=") ? a.startsWith(f) : a === f);
      if (!ok) {
        throw new Error(
          `fake ${call.bin}: unknown flag ${a} (${call.bin} ${
            call.args.join(" ")
          })`,
        );
      }
    }
  };
}

function toBytes(out: unknown): Uint8Array {
  if (out instanceof Uint8Array) return out;
  return new TextEncoder().encode(
    out === undefined
      ? ""
      : typeof out === "string"
      ? out
      : JSON.stringify(out),
  );
}

/** Cut an answer to the output bound of its call, as the real spawn does. */
function bounded(r: SpawnResult, a: Answer, max = Infinity): SpawnResult {
  const err = new TextEncoder().encode(r.stderr);
  if (!a.tooLarge && r.stdout.length + err.length <= max) return r;
  const out = r.stdout.slice(0, Math.min(r.stdout.length, max));
  return {
    code: null,
    stdout: out,
    stderr: new TextDecoder().decode(
      err.slice(0, Math.max(0, Math.min(err.length, max - out.length))),
    ),
    tooLarge: true,
  };
}

function answer(
  a: Answer,
  signal?: AbortSignal,
  max?: number,
): Promise<SpawnResult> {
  const none = { code: null, stdout: new Uint8Array(), stderr: "" };
  if (a.notInstalled) {
    return Promise.reject(new Deno.errors.NotFound("No such file"));
  }
  if (signal?.aborted) return Promise.resolve({ ...none, cancelled: true });
  if (a.hang === "until-cancelled") {
    if (!signal) throw new Error("fake: a hang with no signal to end it");
    return new Promise((resolve) =>
      signal.addEventListener(
        "abort",
        () => resolve({ ...none, cancelled: true }),
        { once: true },
      )
    );
  }
  if (a.hang) return Promise.resolve({ ...none, timedOut: true });
  if (a.fail !== undefined || a.code !== undefined) {
    return Promise.resolve(bounded(
      { code: a.code ?? 1, stdout: toBytes(a.stdout), stderr: a.fail ?? "" },
      a,
      max,
    ));
  }
  return Promise.resolve(
    bounded({ code: 0, stdout: toBytes(a.out), stderr: "" }, a, max),
  );
}

function sameArgs(script: string[], got: string[]): boolean {
  return script.length === got.length &&
    script.every((a, i) => a === CAPTURE || a === got[i]);
}

/** Build the fake. Install its `spawn` with `__setSpawn`, or use `withCli`. */
export function fakeCli(o: FakeCliOptions = {}): FakeCli {
  const script = o.calls ?? [];
  let next = 0;
  const calls: SpawnedCall[] = [];
  const captured: string[] = [];

  const spawn: Spawn = (bin, args, opts) => {
    if (!(Number.isFinite(opts.timeoutMs) && opts.timeoutMs > 0)) {
      throw new Error(`fake ${bin}: no time limit (${opts.timeoutMs})`);
    }
    const call: SpawnedCall = {
      bin,
      args,
      stdin: opts.stdin,
      env: opts.env,
      clearEnv: opts.clearEnv,
      cwd: opts.cwd,
      timeoutMs: opts.timeoutMs,
      maxOutputBytes: opts.maxOutputBytes,
    };
    const matchArgs = o.grammar?.[bin]?.(call) ?? args;
    const e = script[next];
    if (e !== undefined && e.bin === bin && sameArgs(e.args, matchArgs)) {
      next++;
      e.args.forEach((a, i) => {
        if (a === CAPTURE) captured.push(matchArgs[i]);
      });
      if (e.stdin === CAPTURE) {
        if (opts.stdin === undefined) {
          throw new Error(
            `fake: call ${next} was given no standard input to capture`,
          );
        }
        captured.push(opts.stdin);
      } else if (typeof e.stdin === "string" || opts.stdin === undefined) {
        assertEquals(opts.stdin, e.stdin, `standard input of call ${next}`);
      } else {
        assertEquals(
          JSON.parse(opts.stdin),
          e.stdin,
          `standard input of call ${next}`,
        );
      }
      if (e.env !== undefined) {
        assertEquals(opts.env ?? {}, e.env, `environment of call ${next}`);
      }
      if (e.clearEnv !== undefined) {
        assertEquals(opts.clearEnv ?? false, e.clearEnv, "clearEnv");
      }
      if (e.cwd !== undefined) assertEquals(opts.cwd, e.cwd, "cwd");
      if (e.timeoutMs !== undefined) {
        assertEquals(opts.timeoutMs, e.timeoutMs, "time limit");
      }
      if (e.maxOutputBytes !== undefined) {
        assertEquals(opts.maxOutputBytes, e.maxOutputBytes, "output bound");
      }
      calls.push(call);
      return answer(e, opts.signal, opts.maxOutputBytes);
    }
    const handled = o.handler?.(call, matchArgs);
    if (handled !== undefined) {
      calls.push(call);
      return answer(handled, opts.signal, opts.maxOutputBytes);
    }
    if (e === undefined) {
      throw new Error(
        `fake: unexpected call: ${bin} ${matchArgs.join(" ")}`,
      );
    }
    // Not the next scripted call: fail with both shown side by side.
    assertEquals(
      { bin, args: matchArgs },
      { bin: e.bin, args: e.args },
      `call ${next + 1} is not the scripted one`,
    );
    throw new Error("fake: unreachable");
  };

  return {
    spawn,
    calls,
    captured,
    done: () => assertEquals(next, script.length, "scripted calls left unused"),
  };
}

/** What `withCli` hands to the test body. */
export interface FakeTime {
  /** Every wait that was asked for, in milliseconds. */
  slept: number[];
  /** Move the fake clock, as a slow command would. */
  advance: (ms: number) => void;
}

/**
 * Run `body` with `spawn` installed, a sleep that returns at once and a
 * clock that only moves when told to; then call `done`, and restore the
 * real spawn, sleep and clock whatever happened.
 */
export async function withFake<F extends { spawn: Spawn; done: () => void }, T>(
  fake: F,
  body: (k: F & FakeTime) => Promise<T>,
): Promise<T> {
  const slept: number[] = [];
  let now = 0;
  __setSpawn(fake.spawn);
  __setSleep((ms, signal) => {
    if (signal?.aborted) return Promise.reject(cancelledError());
    slept.push(ms);
    return Promise.resolve();
  });
  __setClock(() => now);
  try {
    const result = await body({
      ...fake,
      slept,
      advance: (ms) => {
        now += ms;
      },
    });
    fake.done();
    return result;
  } finally {
    __setSpawn();
    __setSleep();
    __setClock();
  }
}

/** `withFake` for a `fakeCli` built from `o`. */
export function withCli<T>(
  o: FakeCliOptions,
  body: (k: FakeCli & FakeTime) => Promise<T>,
): Promise<T> {
  return withFake(fakeCli(o), body);
}

/** Values shaped like a flag, a shell fragment, a path or plain nonsense. */
export const HOSTILE = [
  "-A",
  "--all",
  "--all-namespaces",
  "-o=yaml",
  "--kubeconfig=/etc/passwd",
  "a b",
  "a;rm -rf /",
  "$(id)",
  "`id`",
  "a|b",
  "a&b",
  "a>b",
  "../etc",
  "a/b",
  "Upper",
  "a\nb",
  "a\tb",
  "ø",
  "a_b",
  ".a",
  "a.",
  "-a",
  "a-",
  "",
  " ",
  "a".repeat(254),
];
