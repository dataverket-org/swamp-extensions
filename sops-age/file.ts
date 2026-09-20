/**
 * `@dataverket/sops-age` — one SOPS-encrypted JSON file holding every secret.
 *
 * The file is what `@zocc/sops-age` writes, so an existing vault switches to
 * this type by changing `type` in its config. What changes is how the file is
 * touched: `put` runs `sops set` on one key, so every other value stays
 * byte-identical and a diff names the key that changed; `get` extracts one
 * value; `list` reads the key names, which sops leaves in plaintext, without
 * decrypting; `delete` runs `sops unset`. Writing needs an identity that can
 * unwrap the file's data key, so every writer is a recipient.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  assertKey,
  CommonConfig,
  encryptJson,
  extractValue,
  fileExists,
  indexOf,
  plaintextKeys,
  sops,
} from "./sops.ts";

/** Configuration of a single-file vault. */
export const FileConfig = CommonConfig.extend({
  secretsFile: z.string().min(1).describe(
    "Path to the SOPS-encrypted JSON file, relative to the repository",
  ),
});
/** {@link FileConfig} */
export type FileConfigData = z.infer<typeof FileConfig>;

/** The provider behind `@dataverket/sops-age`. */
export class SopsAgeFileProvider {
  readonly #name: string;
  readonly #cfg: FileConfigData;

  constructor(name: string, cfg: FileConfigData) {
    this.#name = name;
    this.#cfg = cfg;
  }

  getName(): string {
    return this.#name;
  }

  async get(secretKey: string): Promise<string> {
    assertKey(secretKey);
    if (!(await this.#has(secretKey))) {
      throw new Error(`Secret not found: ${secretKey}`);
    }
    return await extractValue(this.#cfg, this.#cfg.secretsFile, secretKey);
  }

  async put(secretKey: string, secretValue: string): Promise<void> {
    assertKey(secretKey);
    if (!(await fileExists(this.#cfg.secretsFile))) {
      await encryptJson(
        this.#cfg,
        { [secretKey]: secretValue },
        this.#cfg.secretsFile,
      );
      return;
    }
    await sops(this.#cfg, [
      "set",
      "--input-type",
      "json",
      "--output-type",
      "json",
      "--value-stdin",
      this.#cfg.secretsFile,
      indexOf(secretKey),
    ], JSON.stringify(secretValue));
  }

  async list(): Promise<string[]> {
    if (!(await fileExists(this.#cfg.secretsFile))) return [];
    return await plaintextKeys(this.#cfg.secretsFile);
  }

  async delete(secretKey: string): Promise<void> {
    assertKey(secretKey);
    if (!(await this.#has(secretKey))) return;
    await sops(this.#cfg, [
      "unset",
      "--input-type",
      "json",
      "--output-type",
      "json",
      this.#cfg.secretsFile,
      indexOf(secretKey),
    ]);
  }

  async #has(key: string): Promise<boolean> {
    return (await this.list()).includes(key);
  }
}

/** `@dataverket/sops-age`: every secret in one SOPS-encrypted JSON file, changed one value at a time. */
export const vault = {
  type: "@dataverket/sops-age",
  name: "SOPS + age, one file",
  description:
    "Every secret in one SOPS-encrypted JSON file, as @zocc/sops-age lays it out; put changes one value with sops set and leaves the rest untouched, list needs no key, delete is sops unset. Writers must be recipients.",
  configSchema: FileConfig,
  createProvider: (
    name: string,
    config: Record<string, unknown>,
  ): SopsAgeFileProvider =>
    new SopsAgeFileProvider(name, FileConfig.parse(config)),
};
