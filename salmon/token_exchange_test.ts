import { assertEquals } from "jsr:@std/assert@1.0.13";
import { jwtClaims } from "./token_exchange.ts";

function b64url(s: string): string {
  return btoa(s).replaceAll("+", "-").replaceAll("/", "_").replace(/=+$/, "");
}

Deno.test("claims are read from an unpadded base64url payload", () => {
  const payload = { sub: "trust/x", roles: ["ldap/Registry-Push"], n: "ü?>" };
  const jwt = `${b64url("{}")}.${
    b64url(
      String.fromCharCode(...new TextEncoder().encode(JSON.stringify(payload))),
    )
  }.sig`;
  assertEquals(jwtClaims(jwt), payload);
});
