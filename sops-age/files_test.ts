import {
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  assertVaultConformance,
  assertVaultExportConformance,
} from "jsr:@swamp-club/swamp-testing";
import { assertPathKey, vault } from "./files.ts";
import { haveTools, scratchAge } from "./test_support.ts";

const tools = await haveTools();

Deno.test("export conforms", () => {
  assertVaultExportConformance(vault, {
    validConfigs: [{ secretsDir: "vaults/produced", agePublicKey: "age1x" }],
    invalidConfigs: [{}, { secretsDir: "", agePublicKey: "age1x" }],
  });
});

Deno.test("keys stay inside the directory", () => {
  assertEquals(
    assertPathKey("omni/service_account_key"),
    "omni/service_account_key",
  );
  for (const bad of ["", "/abs", "a/../b", "a//b", "./a", "a/"]) {
    assertThrows(() => assertPathKey(bad), Error, "Invalid secret key");
  }
});

Deno.test({
  name:
    "per file: put with public keys only, get with the identity, list walks, delete removes",
  ignore: !tools,
  fn: async () => {
    const a = await scratchAge();
    try {
      const dir = `${a.dir}/produced`;
      const writer = vault.createProvider("w", {
        secretsDir: dir,
        ageKeyFile: `${a.dir}/none.txt`,
        agePublicKey: a.recipient,
      });
      await writer.put("cluster/app_credential", "s3cret");
      await writer.put("top", "t");
      assertEquals(await writer.list(), ["cluster/app_credential", "top"]);
      await assertRejects(() => writer.get("top"), Error);
      const reader = vault.createProvider("r", {
        secretsDir: dir,
        ageKeyFile: a.keyFile,
        agePublicKey: a.recipient,
      });
      assertEquals(await reader.get("cluster/app_credential"), "s3cret");
      await writer.put("top", "t2");
      assertEquals(await reader.get("top"), "t2");
      await writer.delete("top");
      assertEquals(await reader.list(), ["cluster/app_credential"]);
      await assertRejects(() => reader.get("top"), Error, "not found");
      await assertVaultConformance(reader);
    } finally {
      await a.cleanup();
    }
  },
});
