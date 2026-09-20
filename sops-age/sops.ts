/**
 * `@dataverket/sops-age` — the `sops` subprocess both providers share.
 *
 * Every call is an argument vector, never a shell string. A secret value is
 * handed to sops on stdin (`sops set --value-stdin`) or through a plaintext
 * file in a private temporary directory that is removed afterwards; it is
 * never an argument. Decryption uses whatever sops would use anyway (the
 * `SOPS_AGE_KEY_FILE` of the caller, the default key file, an age plugin);
 * `ageKeyFile` overrides that only when set.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** What both providers need to know about the key material and the binary. */
export const CommonConfig = z.object({
  ageKeyFile: z.string().default("").describe(
    "age identity file for decryption (SOPS_AGE_KEY_FILE); empty keeps the caller's environment",
  ),
  agePublicKey: z.string().min(1).describe(
    "age recipients for encryption, comma separated; every value is encrypted to all of them",
  ),
  sopsPath: z.string().default("sops").describe(
    "Path to the sops binary; override when it is not on PATH",
  ),
});
/** {@link CommonConfig} */
export type CommonConfigData = z.infer<typeof CommonConfig>;

/** Captured outcome of one sops invocation. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** Spawns sops; replaceable for tests. */
export type Runner = (
  argv: string[],
  env: Record<string, string>,
  stdin?: string,
) => Promise<RunResult>;

let testRunner: Runner | undefined;
/** Install a fake runner (tests only); call with no argument to restore. */
export function __setRunner(runner?: Runner): void {
  testRunner = runner;
}

const defaultRunner: Runner = async (argv, env, stdin) => {
  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    env,
    stdin: stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
  });
  let child: Deno.ChildProcess;
  try {
    child = command.spawn();
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) {
      throw new Error(
        `${argv[0]} binary not found; install sops or set sopsPath`,
      );
    }
    throw err;
  }
  if (stdin !== undefined) {
    const w = child.stdin.getWriter();
    await w.write(new TextEncoder().encode(stdin));
    await w.close();
  }
  const out = await child.output();
  return {
    code: out.code,
    stdout: new TextDecoder().decode(out.stdout),
    stderr: new TextDecoder().decode(out.stderr),
  };
};

/** The subprocess environment: the caller's, with the key file overridden when configured. */
export function sopsEnv(cfg: CommonConfigData): Record<string, string> {
  const env = Deno.env.toObject();
  if (cfg.ageKeyFile !== "") env.SOPS_AGE_KEY_FILE = cfg.ageKeyFile;
  return env;
}

/** Run sops; a non-zero exit throws with its stderr, labelled by subcommand. */
export async function sops(
  cfg: CommonConfigData,
  args: string[],
  stdin?: string,
): Promise<string> {
  const r = await (testRunner ?? defaultRunner)(
    [cfg.sopsPath, ...args],
    sopsEnv(cfg),
    stdin,
  );
  if (r.code !== 0) {
    throw new Error(
      `sops ${args[0]} failed (exit ${r.code}): ${
        (r.stderr || r.stdout).trim() || "no output"
      }`,
    );
  }
  return r.stdout;
}

/** The JSON index sops takes for one top-level key. */
export function indexOf(key: string): string {
  return `[${JSON.stringify(key)}]`;
}

/**
 * Encrypt `plain` (a JSON object) to the configured recipients into `target`,
 * through a plaintext file in a private temporary directory, mode 0700,
 * removed afterwards. Public keys only: no identity is needed.
 */
export async function encryptJson(
  cfg: CommonConfigData,
  plain: Record<string, string>,
  target: string,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "sops-age-" });
  const path = `${dir}/plain.json`;
  try {
    await Deno.writeTextFile(path, JSON.stringify(plain, null, 2), {
      mode: 0o600,
    });
    await sops(cfg, [
      "encrypt",
      "--age",
      cfg.agePublicKey,
      "--input-type",
      "json",
      "--output-type",
      "json",
      "--output",
      target,
      path,
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true }).catch(() => {});
  }
}

/** Decrypt one top-level string value of a sops JSON file. */
export async function extractValue(
  cfg: CommonConfigData,
  file: string,
  key: string,
): Promise<string> {
  return await sops(cfg, [
    "decrypt",
    "--input-type",
    "json",
    "--output-type",
    "json",
    "--extract",
    indexOf(key),
    file,
  ]);
}

/** The top-level keys of a sops JSON file, read without decrypting. */
export async function plaintextKeys(file: string): Promise<string[]> {
  const raw = JSON.parse(await Deno.readTextFile(file));
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`${file} is not a JSON object`);
  }
  return Object.keys(raw).filter((k) => k !== "sops").sort();
}

/** True when the path names an existing regular file. */
export async function fileExists(path: string): Promise<boolean> {
  try {
    return (await Deno.stat(path)).isFile;
  } catch (err) {
    if (err instanceof Deno.errors.NotFound) return false;
    throw err;
  }
}

/** A secret key must be non-empty and free of control characters. */
export function assertKey(key: string): string {
  const control = [...key].some((ch) => {
    const c = ch.charCodeAt(0);
    return c < 0x20 || c === 0x7f;
  });
  if (key === "" || control) {
    throw new Error(`Invalid secret key: ${JSON.stringify(key)}`);
  }
  return key;
}
