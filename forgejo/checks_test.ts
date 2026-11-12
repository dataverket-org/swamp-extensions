import { assertEquals, assertStringIncludes } from "jsr:@std/assert@1.0.13";
import { apiUrlProblem, extension, scopeRefusal } from "./checks.ts";
import type { GlobalArgs } from "./api.ts";
import { harness } from "./stub_test.ts";

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
Deno.test("scopeRefusal is a 403 naming a scope and nothing else", () => {
  assertEquals(
    scopeRefusal(403, { message: "required scope(s) read:user" }),
    true,
  );
  assertEquals(scopeRefusal(403, { raw: "missing scope" }), true);
  assertEquals(scopeRefusal(403, { message: "forbidden" }), false);
  assertEquals(
    scopeRefusal(401, { message: "required scope(s) read:user" }),
    false,
  );
  assertEquals(scopeRefusal(403, {}), false);
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

// ───── the checks, through createModelTestContext with a stub client ─────

const accepted = checks["forgejo-token-accepted"];

Deno.test("forgejo-token-accepted passes when the forge names the login", async () => {
  const h = harness({
    ["GET /api/v1/user"]: { status: 200, body: { login: "bo" } },
  });
  assertEquals((await accepted.execute(h.context)).pass, true);
});

Deno.test("forgejo-token-accepted passes a 403 that names a scope: the token was accepted", async () => {
  const h = harness({
    ["GET /api/v1/user"]: {
      status: 403,
      body: {
        message:
          "token does not have at least one of required scope(s): [read:user]",
      },
    },
  });
  assertEquals((await accepted.execute(h.context)).pass, true);
});

Deno.test("forgejo-token-accepted fails a 401 with the forge's message", async () => {
  const h = harness({
    ["GET /api/v1/user"]: {
      status: 401,
      body: { message: "access token does not exist [sha: [REDACTED]]" },
    },
  });
  const r = await accepted.execute(h.context);
  assertEquals(r.pass, false);
  assertStringIncludes(r.errors![0], "HTTP 401: access token does not exist");
});

Deno.test("forgejo-token-accepted fails a forge that cannot be reached, naming why", async () => {
  const h = harness({});
  const r = await accepted.execute(h.context);
  assertEquals(r.pass, false);
  assertStringIncludes(
    JSON.stringify(r),
    "the stub has no answer for GET /api/v1/user",
  );
});
