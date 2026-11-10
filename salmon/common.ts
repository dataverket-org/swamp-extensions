/**
 * What the Salmon types share: the slice of swamp's method context they use
 * and the docker calls of more than one method. Every process is spawned by
 * the shared layer in `../lib/cli.ts`, which gives each one a time limit and
 * makes its error text safe to repeat.
 *
 * @module
 */
import { runCli } from "../lib/cli.ts";

/** A handle to a record a method wrote. */
export interface DataHandle {
  name: string;
}

/** The parts of swamp's method context these types use. */
export interface MethodContext<G> {
  globalArgs: G;
  signal?: AbortSignal;
  logger: { info(msg: string, props?: Record<string, unknown>): void };
  writeResource(
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<DataHandle>;
}

/** The container engine's command line, run by name from PATH. */
export const DOCKER = "docker";

/** How long a docker call that only asks a question may take. */
export const DOCKER_QUERY_TIMEOUT_MS = 30_000;

/** The container id of one service of a compose project, or "" if none runs. */
export async function serviceContainer(
  project: string,
  service: string,
  signal?: AbortSignal,
): Promise<string> {
  const res = await runCli(DOCKER, [
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ], { signal, timeoutMs: DOCKER_QUERY_TIMEOUT_MS, what: "docker ps" });
  return res.stdout.trim();
}

/** What is said of an issuer URL that holds a user or a password. */
export const NO_USERINFO =
  "must not hold a user or password: an issuer identifier never carries credentials";

/** True for a URL without a user and a password part. */
export function withoutUserinfo(url: string): boolean {
  try {
    const u = new URL(url);
    return u.username === "" && u.password === "";
  } catch {
    return false;
  }
}

/**
 * How long each HTTP request to Salmon may take, the answer's body included.
 * An object so a test can shorten them.
 */
export const FETCH_LIMITS = {
  /** One probe of discovery while the stack starts. */
  probeMs: 5_000,
  /** The discovery document, read by the token-exchange check. */
  discoveryMs: 15_000,
  /** The token exchange itself. */
  exchangeMs: 30_000,
};

/** An HTTP answer, read to its end. */
export interface Answered {
  ok: boolean;
  status: number;
  text: string;
}

/**
 * One HTTP request with a time limit that also covers reading the body, so a
 * server that accepts the connection and then says nothing cannot hold a
 * method. Stopped when `signal` aborts too. At the limit it rejects with
 * `no answer within N seconds`.
 */
export async function fetchWithin(
  url: string,
  init: RequestInit,
  limitMs: number,
  signal?: AbortSignal,
): Promise<Answered> {
  const stop = new AbortController();
  let late = false;
  const timer = setTimeout(() => {
    late = true;
    stop.abort();
  }, limitMs);
  const onAbort = () => stop.abort();
  if (signal?.aborted) stop.abort();
  signal?.addEventListener("abort", onAbort, { once: true });
  try {
    const res = await fetch(url, { ...init, signal: stop.signal });
    return { ok: res.ok, status: res.status, text: await res.text() };
  } catch (err) {
    if (late) {
      throw new Error(`no answer within ${limitMs / 1000} seconds`);
    }
    if (signal?.aborted) throw new Error("cancelled");
    throw err;
  } finally {
    clearTimeout(timer);
    signal?.removeEventListener("abort", onAbort);
  }
}
