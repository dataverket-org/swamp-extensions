/** A throwaway age identity and a scratch directory for the integration tests. */
export async function scratchAge(): Promise<
  {
    dir: string;
    keyFile: string;
    recipient: string;
    cleanup: () => Promise<void>;
  }
> {
  const dir = await Deno.makeTempDir({ prefix: "sops-vault-test-" });
  const keyFile = `${dir}/key.txt`;
  const gen = await new Deno.Command("age-keygen", {
    args: ["-o", keyFile],
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (!gen.success) {
    throw new Error(
      `age-keygen failed: ${new TextDecoder().decode(gen.stderr)}`,
    );
  }
  const text = await Deno.readTextFile(keyFile);
  const recipient = text.match(/age1[a-z0-9]+/)?.[0];
  if (!recipient) throw new Error("no recipient in generated key");
  return {
    dir,
    keyFile,
    recipient,
    cleanup: () => Deno.remove(dir, { recursive: true }),
  };
}

/** Whether sops and age-keygen are on PATH; the integration tests need both. */
export async function haveTools(): Promise<boolean> {
  for (const bin of ["sops", "age-keygen"]) {
    try {
      const r = await new Deno.Command(bin, {
        args: ["--version"],
        stdout: "null",
        stderr: "null",
      }).output();
      if (!r.success) return false;
    } catch {
      return false;
    }
  }
  return true;
}
