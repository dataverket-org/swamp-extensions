import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import { findings, GlobalArgsSchema } from "./local.ts";
import { IMAGE } from "./test_support.ts";

// ---------------------------------------------------------------------------
// The definition's arguments
// ---------------------------------------------------------------------------

Deno.test("an image that is not an image reference is refused by the schema", () => {
  for (
    const image of [
      "",
      "-v",
      "--privileged",
      "a b",
      "img;id",
      "$(id)",
      "img\n--privileged",
      "x".repeat(501),
    ]
  ) {
    assertThrows(
      () => GlobalArgsSchema.parse({ image }),
      Error,
      undefined,
      image,
    );
  }
  for (
    const image of [
      IMAGE,
      "ghcr.io/renovatebot/renovate:44.226.2",
      "renovate/renovate@sha256:" + "a".repeat(64),
      "localhost:5000/r:1",
    ]
  ) GlobalArgsSchema.parse({ image });
});

Deno.test("time limits have bounds, and nothing quieter than info is offered", () => {
  for (
    const bad of [
      { timeoutSeconds: 0 },
      { timeoutSeconds: 9 },
      { timeoutSeconds: 3601 },
      { timeoutSeconds: 1.5 },
      { timeoutSeconds: -1 },
      { pullTimeoutSeconds: 0 },
      { pullTimeoutSeconds: 3601 },
      { logLevel: "warn" },
      { logLevel: "trace" },
      { pull: "always" },
      { containerBinary: "" },
    ]
  ) {
    assertThrows(
      () => GlobalArgsSchema.parse({ image: IMAGE, ...bad }),
      Error,
      undefined,
      JSON.stringify(bad),
    );
  }
});

Deno.test("findings: null only when there is nothing to read", () => {
  assertEquals(findings({}), null);
  assertEquals(findings({ packageFiles: "x" }), null);
  assertEquals(findings({ packageFiles: {} })?.dependencyCount, 0);
});
