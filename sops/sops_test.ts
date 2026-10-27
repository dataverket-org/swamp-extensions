import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { CommonConfig, sopsAgeDir, sopsEnv } from "./sops.ts";
import { vault } from "./files.ts";
import { haveTools, scratchAge } from "./test_support.ts";

const tools = await haveTools();

/** A config as the provider sees it, with the schema's defaults applied. */
function cfg(over: Record<string, string>) {
  return CommonConfig.parse({ agePublicKey: "age1x", ...over });
}

/**
 * An existence check that answers for one path only and refuses any other:
 * the test fails on a lookup it did not expect rather than passing by luck.
 */
function onlyFile(path: string, present: boolean) {
  const asked: string[] = [];
  const exists = (p: string) => {
    asked.push(p);
    if (p !== path) {
      return Promise.reject(new Error(`unexpected lookup of ${p}`));
    }
    return Promise.resolve(present);
  };
  return { exists, asked };
}

Deno.test("sopsAgeDir follows sops: XDG_CONFIG_HOME, then the home's config directory", () => {
  assertEquals(
    sopsAgeDir({ XDG_CONFIG_HOME: "/x", HOME: "/h" }, "linux"),
    "/x/sops/age",
  );
  assertEquals(
    sopsAgeDir({ XDG_CONFIG_HOME: "/x", HOME: "/h" }, "darwin"),
    "/x/sops/age",
  );
  assertEquals(sopsAgeDir({ HOME: "/h" }, "linux"), "/h/.config/sops/age");
  assertEquals(
    sopsAgeDir({ HOME: "/h" }, "darwin"),
    "/h/Library/Application Support/sops/age",
  );
  assertEquals(
    sopsAgeDir({ XDG_CONFIG_HOME: "", HOME: "/h" }, "linux"),
    "/h/.config/sops/age",
  );
  assertEquals(sopsAgeDir({}, "linux"), undefined);
});

Deno.test("ageKeyName names the file beside keys.txt when it exists", async () => {
  // XDG_CONFIG_HOME is honoured on every OS, so the expected path does not
  // depend on the host; the HOME fallbacks are covered by the sopsAgeDir test.
  const f = onlyFile("/x/sops/age/swamp-infra.txt", true);
  const env = await sopsEnv(
    cfg({ ageKeyName: "swamp-infra" }),
    { HOME: "/h", XDG_CONFIG_HOME: "/x", PATH: "/bin" },
    f.exists,
  );
  assertEquals(env.SOPS_AGE_KEY_FILE, "/x/sops/age/swamp-infra.txt");
  assertEquals(env.PATH, "/bin");
  assertEquals(f.asked, ["/x/sops/age/swamp-infra.txt"]);
});

Deno.test("ageKeyName leaves the environment alone when the file is absent", async () => {
  const f = onlyFile("/x/sops/age/swamp-infra.txt", false);
  const env = await sopsEnv(
    cfg({ ageKeyName: "swamp-infra" }),
    { HOME: "/h", XDG_CONFIG_HOME: "/x" },
    f.exists,
  );
  assertEquals("SOPS_AGE_KEY_FILE" in env, false);
  assertEquals(f.asked, ["/x/sops/age/swamp-infra.txt"]);
});

Deno.test("a SOPS_AGE_KEY_FILE the caller exported wins over ageKeyName, with no lookup", async () => {
  const f = onlyFile("never", false);
  const env = await sopsEnv(
    cfg({ ageKeyName: "swamp-infra" }),
    { HOME: "/h", SOPS_AGE_KEY_FILE: "/mine.txt" },
    f.exists,
  );
  assertEquals(env.SOPS_AGE_KEY_FILE, "/mine.txt");
  assertEquals(f.asked, []);
});

Deno.test("no home and no XDG_CONFIG_HOME: nothing to look in, nothing set", async () => {
  const f = onlyFile("never", false);
  const env = await sopsEnv(
    cfg({ ageKeyName: "k" }),
    { PATH: "/bin" },
    f.exists,
  );
  assertEquals("SOPS_AGE_KEY_FILE" in env, false);
  assertEquals(f.asked, []);
});

Deno.test("ageKeyFile is passed verbatim and overrides the caller's, with no lookup", async () => {
  const f = onlyFile("never", false);
  const env = await sopsEnv(
    cfg({ ageKeyFile: "~/k.txt" }),
    { HOME: "/h", SOPS_AGE_KEY_FILE: "/mine.txt" },
    f.exists,
  );
  assertEquals(env.SOPS_AGE_KEY_FILE, "~/k.txt");
  assertEquals(f.asked, []);
});

Deno.test("neither set: the caller's environment, untouched", async () => {
  const f = onlyFile("never", false);
  const before = { HOME: "/h", SOPS_AGE_KEY_FILE: "/mine.txt" };
  assertEquals(await sopsEnv(cfg({}), before, f.exists), before);
  assertEquals(f.asked, []);
});

Deno.test("ageKeyName is a file name: no path, no dot names, no control characters", () => {
  for (const ok of ["swamp-infra", "cluster.prod", "a b", "k"]) {
    assertEquals(cfg({ ageKeyName: ok }).ageKeyName, ok);
  }
  for (const bad of ["a/b", "/abs", "..", ".", "a\\b", "a\nb", "\x7f"]) {
    assertEquals(
      CommonConfig.safeParse({ agePublicKey: "age1x", ageKeyName: bad })
        .success,
      false,
      JSON.stringify(bad),
    );
  }
});

Deno.test("ageKeyFile and ageKeyName together are refused", () => {
  assertEquals(
    CommonConfig.safeParse({
      agePublicKey: "age1x",
      ageKeyName: "k",
      ageKeyFile: "/k.txt",
    }).success,
    false,
  );
});

/**
 * Runs `fn` with the process environment pointing sops's key directory at a
 * scratch directory and no exported key file, then restores both. The live
 * tests below must not pick up the developer's own keys.
 */
async function withKeyDir(dir: string, fn: () => Promise<void>) {
  const xdg = Deno.env.get("XDG_CONFIG_HOME");
  const keyFile = Deno.env.get("SOPS_AGE_KEY_FILE");
  Deno.env.set("XDG_CONFIG_HOME", dir);
  Deno.env.delete("SOPS_AGE_KEY_FILE");
  try {
    await fn();
  } finally {
    if (xdg === undefined) Deno.env.delete("XDG_CONFIG_HOME");
    else Deno.env.set("XDG_CONFIG_HOME", xdg);
    if (keyFile !== undefined) Deno.env.set("SOPS_AGE_KEY_FILE", keyFile);
  }
}

Deno.test({
  name: "live: get decrypts with the identity ageKeyName finds beside keys.txt",
  ignore: !tools,
  fn: async () => {
    const a = await scratchAge();
    try {
      const keyDir = `${a.dir}/config/sops/age`;
      await Deno.mkdir(keyDir, { recursive: true });
      await Deno.copyFile(a.keyFile, `${keyDir}/swamp-test.txt`);
      await withKeyDir(`${a.dir}/config`, async () => {
        const p = vault.createProvider("named", {
          secretsDir: `${a.dir}/secrets`,
          ageKeyName: "swamp-test",
          agePublicKey: a.recipient,
        });
        await p.put("k", "v");
        assertEquals(await p.get("k"), "v");
      });
    } finally {
      await a.cleanup();
    }
  },
});

Deno.test({
  name: "live: ageKeyName naming a file that is not there decrypts nothing",
  ignore: !tools,
  fn: async () => {
    const a = await scratchAge();
    try {
      await Deno.mkdir(`${a.dir}/config/sops/age`, { recursive: true });
      await withKeyDir(`${a.dir}/config`, async () => {
        const p = vault.createProvider("missing", {
          secretsDir: `${a.dir}/secrets`,
          ageKeyName: "swamp-test",
          agePublicKey: a.recipient,
        });
        await p.put("k", "v");
        await assertRejects(() => p.get("k"), Error, "sops decrypt failed");
      });
    } finally {
      await a.cleanup();
    }
  },
});
