import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import {
  assertVaultConformance,
  assertVaultExportConformance,
} from "jsr:@swamp-club/swamp-testing";
import { vault } from "./file.ts";
import { haveTools, scratchAge } from "./test_support.ts";

const tools = await haveTools();

Deno.test("export conforms", () => {
  assertVaultExportConformance(vault, {
    validConfigs: [{ secretsFile: "v.enc.json", agePublicKey: "age1x" }],
    invalidConfigs: [{}, { secretsFile: "", agePublicKey: "age1x" }],
  });
});

Deno.test({
  name:
    "one file: put creates, set changes one value, get extracts, list needs no key, delete unsets",
  ignore: !tools,
  fn: async () => {
    const a = await scratchAge();
    try {
      const file = `${a.dir}/vault.enc.json`;
      const p = vault.createProvider("t", {
        secretsFile: file,
        ageKeyFile: a.keyFile,
        agePublicKey: a.recipient,
      });
      await p.put("forgejo/api_token", "one");
      await p.put("omni/key", "two");
      const before = JSON.parse(await Deno.readTextFile(file));
      await p.put("omni/key", "three");
      const after = JSON.parse(await Deno.readTextFile(file));
      assertEquals(after["forgejo/api_token"], before["forgejo/api_token"]);
      assertEquals(after["omni/key"] === before["omni/key"], false);
      assertEquals(await p.get("omni/key"), "three");
      assertEquals(await p.get("forgejo/api_token"), "one");
      // list without any identity: hide the key file
      const blind = vault.createProvider("blind", {
        secretsFile: file,
        ageKeyFile: `${a.dir}/none.txt`,
        agePublicKey: a.recipient,
      });
      assertEquals(await blind.list(), ["forgejo/api_token", "omni/key"]);
      await assertRejects(() => blind.get("omni/key"), Error);
      await p.delete("forgejo/api_token");
      assertEquals(await p.list(), ["omni/key"]);
      await assertRejects(() => p.get("forgejo/api_token"), Error, "not found");
      await assertVaultConformance(p);
    } finally {
      await a.cleanup();
    }
  },
});
