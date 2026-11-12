import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  __setFetcher,
  absolute,
  argumentProblem,
  checks,
  type Context,
  errorText,
  failureKind,
  GlobalArgsSchema,
  type Health,
  model,
} from "./endpoint.ts";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";

/** This extension's directory doubles as the repository root in tests. */
const REPO = import.meta.dirname!;

function context(over: Record<string, unknown> = {}) {
  const t = createModelTestContext({
    globalArgs: GlobalArgsSchema.parse({ url: "http://127.0.0.1:1/", ...over }),
    repoDir: REPO,
  });
  const ctx = t.context as unknown as Context;
  return {
    ctx,
    get written() {
      return t.getWrittenResources().map((w) =>
        w.data as Record<string, unknown>
      );
    },
    logs: () => t.getLogs().map((l) => `${l.level}: ${l.message}`),
    names: () => t.getWrittenResources().map((w) => `${w.specName}/${w.name}`),
  };
}

async function health(c: ReturnType<typeof context>) {
  await model.methods.health.execute({}, c.ctx);
  return c.written[0] as Health;
}

/** A stub fetcher answering each URL it is given, and the URLs it saw. */
function stubFetch(answers: Record<string, () => Response>) {
  const seen: { url: string; caFile: string; ua: string }[] = [];
  const restore = __setFetcher((url, init, caFile) => {
    seen.push({ url, caFile, ua: init.headers["user-agent"] });
    const answer = answers[url];
    if (!answer) {
      return Promise.reject(new Error(`the stub has no answer for ${url}`));
    }
    return Promise.resolve(answer());
  });
  return { seen, restore };
}

Deno.test("helpers: absolute, argumentProblem, failureKind", () => {
  assertEquals(absolute("/r", "ca.pem"), "/r/ca.pem");
  assertEquals(absolute("/r", "/abs"), "/abs");
  assertEquals(absolute("/r", ""), "");
  assertEquals(argumentProblem({ url: "https://example.org/" }), null);
  assertStringIncludes(argumentProblem({ url: "nope" })!, "not a URL");
  assertStringIncludes(
    argumentProblem({ url: "ftp://x/" })!,
    "not http or https",
  );
  assertStringIncludes(
    argumentProblem({ url: "https://x/", caFile: "a\nb" })!,
    "newline",
  );
  assertEquals(
    failureKind("TypeError: invalid peer certificate: UnknownIssuer", true),
    {
      tls: "failed",
      error: "invalid peer certificate: UnknownIssuer",
    },
  );
  assertEquals(failureKind("error sending request: connection refused", true), {
    tls: null,
    error: "error sending request: connection refused",
  });
  assertEquals(failureKind("certificate", false).tls, null);
  const wrapped = new TypeError("fetch failed", {
    cause: new Error(
      "error sending request: client error (Connect): invalid peer certificate: UnknownIssuer",
    ),
  });
  assertEquals(
    errorText(wrapped),
    "fetch failed: error sending request: client error (Connect): invalid peer certificate: UnknownIssuer",
  );
  assertEquals(failureKind(errorText(wrapped), true).tls, "failed");
});

Deno.test("checks: arguments and ca-readable", async () => {
  assertEquals(
    await checks.arguments.execute({
      globalArgs: { url: "https://example.org/" },
    }),
    { pass: true },
  );
  assertEquals(
    (await checks.arguments.execute({ globalArgs: { url: "x" } })).pass,
    false,
  );
  assertEquals(
    await checks["ca-readable"].execute({
      globalArgs: { url: "https://x/" },
      repoDir: REPO,
    }),
    { pass: true },
  );
  const missing = await checks["ca-readable"].execute({
    globalArgs: { url: "https://x/", caFile: "nowhere.pem" },
    repoDir: REPO,
  });
  assertStringIncludes(missing.errors![0], "could not be read");
  const notPem = await checks["ca-readable"].execute({
    globalArgs: { url: "https://x/", caFile: "deno.json" },
    repoDir: REPO,
  });
  assertStringIncludes(notPem.errors![0], "no certificate PEM");
});

Deno.test("nothing listening is unreachable with the connection error", async () => {
  const c = context({ url: "http://127.0.0.1:1/", timeoutMs: 3000 });
  const h = await health(c);
  assertEquals(h.reachable, false);
  assertEquals(h.ok, false);
  assertEquals(h.status, null);
  assertEquals(h.tls, null);
  assert(h.error !== null && h.error !== "");
});

Deno.test("a caFile that cannot be read fails the method before anything is recorded", async () => {
  const c = context({ url: "https://example.org/", caFile: "nowhere.pem" });
  const err = await assertRejects(() =>
    model.methods.health.execute({}, c.ctx)
  );
  assertStringIncludes(String(err), "could not be read");
  assertEquals(c.written.length, 0);
});

Deno.test("a bad url fails the method before anything is recorded", async () => {
  const c = context();
  c.ctx.globalArgs = { ...c.ctx.globalArgs, url: "nope" };
  await assertRejects(() => model.methods.health.execute({}, c.ctx));
  assertEquals(c.written.length, 0);
});

Deno.test("health records an answer that matches, after a redirect", async () => {
  const stub = stubFetch({
    "https://svc.test/": () =>
      new Response(null, { status: 302, headers: { location: "/ok" } }),
    "https://svc.test/ok": () =>
      new Response('{"status":"up","version":"1"}', {
        status: 200,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    const c = context({
      url: "https://svc.test/",
      bodyContains: "up",
      bodyJson: { status: "up" },
    });
    const h = await health(c);
    assertEquals(c.names(), ["health/health"]);
    assertEquals(
      [h.ok, h.status, h.tls, h.redirects, h.finalUrl],
      [true, 200, "verified", 1, "https://svc.test/ok"],
    );
    assertEquals([h.bodyMatched, h.jsonMatched, h.error], [true, true, null]);
    assertEquals(stub.seen[0].ua, "swamp @dataverket/http");
    assert(c.logs().some((l) => l.startsWith("info: {url} answered")));
  } finally {
    stub.restore();
  }
});

Deno.test("health records a wrong status and a JSON field that differs, and warns", async () => {
  const stub = stubFetch({
    "http://svc.test/": () =>
      new Response('{"status":"down"}', {
        status: 503,
        headers: { "content-type": "application/json" },
      }),
  });
  try {
    const c = context({
      url: "http://svc.test/",
      expectStatus: 503,
      bodyJson: { status: "up" },
    });
    const h = await health(c);
    assertEquals([h.ok, h.reachable, h.tls], [false, true, "plain"]);
    assertEquals([h.jsonMatched, h.jsonMismatchCount], [false, 1]);
    // without bodyJsonShowValues nothing from the body reaches the record
    assertEquals(JSON.stringify(h).includes("down"), false);
    assert(c.logs().some((l) => l.startsWith("warning: {url} not ok")));
  } finally {
    stub.restore();
  }
});

Deno.test("health records a chain that does not verify as tls failed, not as a throw", async () => {
  const stub = stubFetch({
    "https://svc.test/": () => {
      throw new TypeError("invalid peer certificate: UnknownIssuer");
    },
  });
  try {
    const c = context({ url: "https://svc.test/" });
    const h = await health(c);
    assertEquals([h.reachable, h.ok, h.status, h.tls], [
      false,
      false,
      null,
      "failed",
    ]);
    assertStringIncludes(h.error!, "UnknownIssuer");
  } finally {
    stub.restore();
  }
});

Deno.test("health does not follow a redirect when told not to, and judges the first answer", async () => {
  const stub = stubFetch({
    "https://svc.test/": () =>
      new Response(null, { status: 301, headers: { location: "/elsewhere" } }),
  });
  try {
    const c = context({ url: "https://svc.test/", followRedirects: false });
    const h = await health(c);
    assertEquals([h.ok, h.status, h.redirects], [false, 301, 0]);
    assertEquals(h.error, "status 301, expected 200");
    assertEquals(stub.seen.length, 1);
  } finally {
    stub.restore();
  }
});

// The real network: HTTP_E2E=1 checks HTTP_E2E_URL (default https://example.org/)
// over a verified chain, and a host whose chain does not verify.
const e2e = Deno.env.get("HTTP_E2E") === "1";

Deno.test({
  name:
    "e2e: a public https endpoint verifies, a bad chain is recorded as failed",
  ignore: !e2e,
  fn: async () => {
    const url = Deno.env.get("HTTP_E2E_URL") ?? "https://example.org/";
    const h = await health(context({ url }));
    assertEquals(h.ok, true, String(h.error));
    assertEquals(h.tls, "verified");
    const hb = await health(
      context({ url: "https://self-signed.badssl.com/" }),
    );
    assertEquals(hb.reachable, false);
    assertEquals(hb.tls, "failed");
  },
});
