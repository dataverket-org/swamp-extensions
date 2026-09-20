/**
 * `@dataverket/sops` — one SOPS-encrypted JSON file per secret.
 *
 * `put` encrypts `{"value": …}` to the configured recipients into
 * `<secretsDir>/<key>.enc.json`, which needs the recipients' public keys and
 * nothing else: a writer can add a secret for readers whose identities it
 * does not hold. A key with `/` in it becomes a directory path. `get`
 * decrypts one file, `list` walks the directory, `delete` removes the file.
 * Changing recipients means `sops updatekeys` per file, by a reader.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { dirname, join, relative } from "jsr:@std/path@1.0.8";
import {
  assertKey,
  CommonConfig,
  encryptJson,
  extractValue,
  fileExists,
} from "./sops.ts";

const SUFFIX = ".enc.json";

/** Configuration of a per-file vault. */
export const FilesConfig = CommonConfig.extend({
  secretsDir: z.string().min(1).describe(
    "Directory holding one <key>.enc.json per secret, relative to the repository",
  ),
});
/** {@link FilesConfig} */
export type FilesConfigData = z.infer<typeof FilesConfig>;

/** A key must stay inside the directory: no absolute paths, no `..` segments. */
export function assertPathKey(key: string): string {
  assertKey(key);
  if (
    key.startsWith("/") || key.endsWith("/") ||
    key.split("/").some((s) => s === "" || s === "." || s === "..")
  ) {
    throw new Error(`Invalid secret key: ${JSON.stringify(key)}`);
  }
  return key;
}

/** The provider behind `@dataverket/sops`. */
export class SopsAgeFilesProvider {
  readonly #name: string;
  readonly #cfg: FilesConfigData;

  constructor(name: string, cfg: FilesConfigData) {
    this.#name = name;
    this.#cfg = cfg;
  }

  getName(): string {
    return this.#name;
  }

  #path(key: string): string {
    return join(this.#cfg.secretsDir, `${assertPathKey(key)}${SUFFIX}`);
  }

  async get(secretKey: string): Promise<string> {
    const path = this.#path(secretKey);
    if (!(await fileExists(path))) {
      throw new Error(`Secret not found: ${secretKey}`);
    }
    return await extractValue(this.#cfg, path, "value");
  }

  async put(secretKey: string, secretValue: string): Promise<void> {
    const path = this.#path(secretKey);
    await Deno.mkdir(dirname(path), { recursive: true });
    await encryptJson(this.#cfg, { value: secretValue }, path);
  }

  async list(): Promise<string[]> {
    const keys: string[] = [];
    const walk = async (dir: string) => {
      for await (const e of Deno.readDir(dir)) {
        const p = join(dir, e.name);
        if (e.isDirectory) await walk(p);
        else if (e.isFile && e.name.endsWith(SUFFIX)) {
          const rel = relative(this.#cfg.secretsDir, p);
          keys.push(rel.slice(0, -SUFFIX.length).replaceAll("\\", "/"));
        }
      }
    };
    try {
      await walk(this.#cfg.secretsDir);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) return [];
      throw err;
    }
    return keys.sort();
  }

  async delete(secretKey: string): Promise<void> {
    const path = this.#path(secretKey);
    if (!(await fileExists(path))) return;
    await Deno.remove(path);
  }
}

/** `@dataverket/sops`: one SOPS-encrypted file per secret; a writer needs only the recipients' public keys. */
export const vault = {
  type: "@dataverket/sops",
  name: "SOPS + age, one file per secret",
  description:
    "One SOPS-encrypted JSON file per secret under a directory; put needs only the recipients' public keys, so a writer can store a value it cannot read back. get decrypts one file, list walks the directory, delete removes the file.",
  configSchema: FilesConfig,
  createProvider: (
    name: string,
    config: Record<string, unknown>,
  ): SopsAgeFilesProvider =>
    new SopsAgeFilesProvider(name, FilesConfig.parse(config)),
};
