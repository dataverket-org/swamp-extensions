/**
 * What the three Salmon types share: the slice of swamp's method context they
 * use, and a command runner that throws with the command's stderr.
 *
 * @module
 */

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

/** A command's outcome. */
export interface CommandResult {
  code: number;
  stdout: string;
  stderr: string;
}

/** Runs a command; the caller decides what a non-zero exit means. */
export async function exec(
  bin: string,
  args: string[],
  opts: { signal?: AbortSignal; stdin?: string } = {},
): Promise<CommandResult> {
  const child = new Deno.Command(bin, {
    args,
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
    signal: opts.signal,
  }).spawn();
  if (opts.stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(opts.stdin));
    await w.close();
  }
  const out = await child.output();
  const decoder = new TextDecoder();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

/** Runs a command and returns its stdout, throwing when it fails. */
export async function run(
  bin: string,
  args: string[],
  opts: { signal?: AbortSignal; stdin?: string } = {},
): Promise<string> {
  const res = await exec(bin, args, opts);
  if (res.code !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} exited ${res.code}: ${res.stderr.trim()}`,
    );
  }
  return res.stdout;
}

/** Resolves after `ms` milliseconds. */
export function sleep(ms: number): Promise<void> {
  return new Promise((r) => setTimeout(r, ms));
}

/** The container id of one service of a compose project, or "" if none runs. */
export async function serviceContainer(
  project: string,
  service: string,
  signal?: AbortSignal,
): Promise<string> {
  return (await run("docker", [
    "ps",
    "-q",
    "--filter",
    `label=com.docker.compose.project=${project}`,
    "--filter",
    `label=com.docker.compose.service=${service}`,
  ], { signal })).trim();
}
