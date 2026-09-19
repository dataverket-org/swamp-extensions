import { assertEquals } from "jsr:@std/assert@1.0.13";

/** The layout module is a hand-kept copy of `talosctl/layout.ts`; only the header comment may differ. */
Deno.test("talos_layout.ts body matches talosctl/layout.ts", async () => {
  const body = (t: string) => t.split("@module\n */\n", 2)[1];
  const here = await Deno.readTextFile(
    new URL("./talos_layout.ts", import.meta.url),
  );
  const there = await Deno.readTextFile(
    new URL("../talosctl/layout.ts", import.meta.url),
  );
  assertEquals(body(here), body(there));
});
