/**
 * `@dataverket/sops` — the `sops` subprocess: argument vectors, private temp files.
 *
 * Every call is an argument vector, never a shell string. A secret value is
 * handed to sops on stdin (`sops set --value-stdin`) or through a plaintext
 * file in a private temporary directory that is removed afterwards; it is
 * never an argument. Decryption uses whatever sops would use anyway (the
 * `SOPS_AGE_KEY_FILE` of the caller, the default key file, an age plugin);
 * `ageKeyFile` overrides that only when set, and `ageKeyName` names an
 * identity file beside sops's own `keys.txt`, used when it exists.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { join, resolve } from "jsr:@std/path@1.0.8";

/** A file name beside `keys.txt`: one path segment, no dot names, no control characters. */
export function isKeyName(name: string): boolean {
  if (name === "" || name === "." || name === "..") return false;
  return ![...name].some((ch) => {
    const c = ch.charCodeAt(0);
    return ch === "/" || ch === "\\" || c < 0x20 || c === 0x7f;
  });
}

/** What both providers need to know about the key material and the binary. */
export const CommonConfig = z.object({
  ageKeyFile: z.string().default("").describe(
    "age identity file for decryption (SOPS_AGE_KEY_FILE); empty keeps the caller's environment",
  ),
  ageKeyName: z.string().default("").refine(
    (n) => n === "" || isKeyName(n),
    "ageKeyName is a file name, not a path",
  ).describe(
    "age identity <name>.txt in the directory where sops keeps keys.txt ($XDG_CONFIG_HOME/sops/age, else ~/.config/sops/age, or ~/Library/Application Support/sops/age on macOS); used when that file exists and the caller sets no SOPS_AGE_KEY_FILE; a name, never a path, so a vault config carries no operator's home",
  ),
  agePublicKey: z.string().min(1).describe(
    "age recipients for encryption, comma separated; every value is encrypted to all of them",
  ),
  sopsPath: z.string().default("sops").describe(
    "Path to the sops binary; override when it is not on PATH",
  ),
}).refine(
  (c) => c.ageKeyFile === "" || c.ageKeyName === "",
  "ageKeyFile and ageKeyName are alternatives; set one",
);
/** {@link CommonConfig} */
export type CommonConfigData = z.infer<typeof CommonConfig>;

/** Captured outcome of one sops invocation. */
export interface RunResult {
  code: number;
  stdout: string;
  stderr: string;
}
/** How one invocation is spawned. */
export interface RunOptions {
  /** Text handed to sops on stdin; none when undefined. */
  stdin?: string;
  /** Working directory; sops looks for `.sops.yaml` upward from here. */
  cwd?: string;
}
/** Spawns sops; replaceable for tests. */
export type Runner = (
  argv: string[],
  env: Record<string, string>,
  opts?: RunOptions,
) => Promise<RunResult>;

let testRunner: Runner | undefined;
/** Install a fake runner (tests only); call with no argument to restore. */
export function __setRunner(runner?: Runner): void {
  testRunner = runner;
}

const defaultRunner: Runner = async (argv, env, opts = {}) => {
  const { stdin, cwd } = opts;
  const command = new Deno.Command(argv[0], {
    args: argv.slice(1),
    env,
    cwd,
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

/**
 * The directory sops reads `keys.txt` from when nothing names a key file:
 * `$XDG_CONFIG_HOME/sops/age`, else the user's config directory, which is
 * `~/Library/Application Support` on macOS and `~/.config` elsewhere.
 * Undefined when the environment names no home.
 */
export function sopsAgeDir(
  env: Record<string, string>,
  os: string = Deno.build.os,
): string | undefined {
  if (env.XDG_CONFIG_HOME) return join(env.XDG_CONFIG_HOME, "sops", "age");
  if (!env.HOME) return undefined;
  if (os === "darwin") {
    return join(env.HOME, "Library", "Application Support", "sops", "age");
  }
  return join(env.HOME, ".config", "sops", "age");
}

/**
 * The subprocess environment: the caller's, with `SOPS_AGE_KEY_FILE` set
 * from the configuration. `ageKeyFile` is passed verbatim. `ageKeyName`
 * resolves to `<sopsAgeDir>/<name>.txt` and is used only when that file
 * exists and the caller has not set the variable: an exported key file wins,
 * and a host without the file leaves sops to `keys.txt` and its plugins.
 */
export async function sopsEnv(
  cfg: CommonConfigData,
  env: Record<string, string> = Deno.env.toObject(),
  exists: (path: string) => Promise<boolean> = fileExists,
): Promise<Record<string, string>> {
  const out = { ...env };
  if (cfg.ageKeyFile !== "") {
    out.SOPS_AGE_KEY_FILE = cfg.ageKeyFile;
    return out;
  }
  if (cfg.ageKeyName === "" || env.SOPS_AGE_KEY_FILE) return out;
  const dir = sopsAgeDir(env);
  if (dir === undefined) return out;
  const file = join(dir, `${cfg.ageKeyName}.txt`);
  if (await exists(file)) out.SOPS_AGE_KEY_FILE = file;
  return out;
}

/** Run sops; a non-zero exit throws with its stderr, labelled by subcommand. */
export async function sops(
  cfg: CommonConfigData,
  args: string[],
  opts?: RunOptions,
): Promise<string> {
  const r = await (testRunner ?? defaultRunner)(
    [cfg.sopsPath, ...args],
    await sopsEnv(cfg),
    opts,
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
 * removed afterwards. Public keys only: no identity is needed. sops runs
 * with that directory as its working directory and an absolute target, so
 * the caller's `.sops.yaml`, whose creation rules would otherwise have to
 * match the temporary file, is never consulted: the recipients are the
 * configured ones and nothing else.
 */
export async function encryptJson(
  cfg: CommonConfigData,
  plain: Record<string, string>,
  target: string,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "sops-vault-" });
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
      resolve(target),
      path,
    ], { cwd: dir });
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
    resolve(file),
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
