import { assertEquals } from "jsr:@std/assert@1.0.13";
import { canonicalAddress, redactToken } from "./api.ts";

Deno.test("redactToken masks every occurrence and tolerates an empty token", () => {
  assertEquals(
    redactToken("sha: abc12345 and again abc12345", "abc12345"),
    "sha: [REDACTED] and again [REDACTED]",
  );
  assertEquals(redactToken("nothing to mask", ""), "nothing to mask");
  assertEquals(redactToken("untouched", "absentxx"), "untouched");
  // a token too short to be a credential must not be masked out of prose:
  // "t" appears in "Not Found", and masking it would corrupt the message
  assertEquals(redactToken("Not Found", "t"), "Not Found");
  assertEquals(redactToken("Not Found", "abc"), "Not Found");
});
Deno.test("canonicalAddress makes .../repo and .../repo.git one remote", () => {
  assertEquals(
    canonicalAddress("https://x:y@Git.example.com/acme/own.git/"),
    canonicalAddress("https://git.example.com/acme/own"),
  );
  assertEquals(
    canonicalAddress("https://git.example.com/acme/own.git") ===
      canonicalAddress("https://git.example.com/acme/other"),
    false,
  );
});
