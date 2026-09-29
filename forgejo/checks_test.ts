import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { apiUrlProblem, extension } from "./checks.ts";
import type { GlobalArgs } from "./api.ts";

const checks = extension.checks[0];
const g = (o: Partial<GlobalArgs>) => ({ globalArgs: o as GlobalArgs });

Deno.test("apiUrlProblem names the base URL mistakes and passes a good one", () => {
  assertEquals(apiUrlProblem("https://forge.example.com"), undefined);
  assertEquals(apiUrlProblem("https://forge.example.com/forge"), undefined);
  assertStringIncludes(apiUrlProblem("")!, "is not set");
  assertStringIncludes(apiUrlProblem(undefined)!, "is not set");
  assertStringIncludes(apiUrlProblem("not a url")!, "is not a URL");
  assertStringIncludes(
    apiUrlProblem("ftp://forge.example.com")!,
    "not http(s)",
  );
  // the mistake the schema warns about: every path already starts with /api/v1
  assertStringIncludes(
    apiUrlProblem("https://forge.example.com/api/v1")!,
    "without /api/v1",
  );
  assertStringIncludes(
    apiUrlProblem("https://forge.example.com/api/v1/")!,
    "without /api/v1",
  );
});

Deno.test("forgejo-api-url-shape passes a base URL and fails a doubled one", async () => {
  const ok = await checks["forgejo-api-url-shape"].execute(
    g({ apiUrl: "https://forge.example.com", token: "t" }),
  );
  assertEquals(ok.pass, true);
  const bad = await checks["forgejo-api-url-shape"].execute(
    g({ apiUrl: "https://forge.example.com/api/v1", token: "t" }),
  );
  assertEquals(bad.pass, false);
});

Deno.test("forgejo-token-accepted reports the forge's own refusal, without the token", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ message: "token does not exist" }), {
        status: 401,
      }),
    );
  try {
    const r = await checks["forgejo-token-accepted"].execute(
      g({ apiUrl: "https://forge.example.com", token: "s3cret-token" }),
    );
    assertEquals(r.pass, false);
    assertStringIncludes(r.errors![0], "token does not exist");
    assertEquals(r.errors![0].includes("s3cret-token"), false);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("forgejo-token-accepted passes when the forge names the login", async () => {
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ login: "someone" }), { status: 200 }),
    );
  try {
    const r = await checks["forgejo-token-accepted"].execute(
      g({ apiUrl: "https://forge.example.com", token: "t" }),
    );
    assertEquals(r.pass, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("forgejo-token-accepted leaves a bad URL to the shape check and needs a token", async () => {
  // no fetch installed: reaching the network here would throw
  const skipped = await checks["forgejo-token-accepted"].execute(
    g({ apiUrl: "https://forge.example.com/api/v1", token: "t" }),
  );
  assertEquals(skipped.pass, true);
  const noToken = await checks["forgejo-token-accepted"].execute(
    g({ apiUrl: "https://forge.example.com" }),
  );
  assertEquals(noToken.pass, false);
  assertStringIncludes(noToken.errors![0], "token is not set");
});

Deno.test("the checks work with httpTimeoutMs absent, as a check receives it", async () => {
  // a check gets the definition as written, without the schema's 30000
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(JSON.stringify({ login: "someone" }), { status: 200 }),
    );
  try {
    const args = { apiUrl: "https://forge.example.com", token: "t" };
    assertEquals(Object.hasOwn(args, "httpTimeoutMs"), false);
    const r = await checks["forgejo-token-accepted"].execute(g(args));
    assertEquals(r.pass, true);
  } finally {
    globalThis.fetch = original;
  }
});

Deno.test("a token the forge echoes back never reaches the output", async () => {
  // Forgejo answers a bad credential with
  // `access token does not exist [sha: <the token>]`, so the value comes back
  // inside the body. Every caller goes through fetchCaller, so masking it
  // there covers the methods as well as this check.
  const token = "gt0-real-looking-token";
  const original = globalThis.fetch;
  globalThis.fetch = () =>
    Promise.resolve(
      new Response(
        JSON.stringify({
          message: `access token does not exist [sha: ${token}]`,
        }),
        { status: 401 },
      ),
    );
  try {
    const r = await checks["forgejo-token-accepted"].execute(
      g({ apiUrl: "https://forge.example.com", token }),
    );
    assertEquals(r.pass, false);
    assertEquals(r.errors![0].includes(token), false);
    assertStringIncludes(r.errors![0], "[REDACTED]");
  } finally {
    globalThis.fetch = original;
  }
});
