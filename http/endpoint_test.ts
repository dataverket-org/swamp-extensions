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

/** This extension's directory doubles as the repository root in tests. */
const REPO = import.meta.dirname!;

function context(over: Record<string, unknown> = {}) {
  const written: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const ctx: Context = {
    globalArgs: GlobalArgsSchema.parse({ url: "http://127.0.0.1:1/", ...over }),
    repoDir: REPO,
    logger: { info: (m) => logs.push(m), warning: (m) => logs.push(m) },
    writeResource: (_spec, name, data) => {
      written.push(data);
      return Promise.resolve({ name });
    },
  };
  return { ctx, written, logs };
}

/** A real local server, so the probe is exercised through fetch itself. */
async function withServer(
  handler: (req: Request) => Response | Promise<Response>,
  fn: (base: string) => Promise<void>,
) {
  const ac = new AbortController();
  const server = Deno.serve(
    { hostname: "127.0.0.1", port: 0, signal: ac.signal, onListen: () => {} },
    handler,
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  try {
    await fn(base);
  } finally {
    ac.abort();
    await server.finished;
  }
}

async function health(ctx: Context, written: Record<string, unknown>[]) {
  await model.methods.health.execute({}, ctx);
  return written[0] as Health;
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

Deno.test("an endpoint that answers as expected is ok, plain HTTP, latency recorded", async () => {
  await withServer(() => new Response("hello world"), async (base) => {
    const { ctx, written, logs } = context({
      url: `${base}/`,
      bodyContains: "world",
    });
    const h = await health(ctx, written);
    assertEquals(h.ok, true);
    assertEquals(h.reachable, true);
    assertEquals(h.status, 200);
    assertEquals(h.tls, "plain");
    assertEquals(h.redirects, 0);
    assertEquals(h.bodyMatched, true);
    assertEquals(h.error, null);
    assertEquals(h.finalUrl, `${base}/`);
    assert(typeof h.latencyMs === "number" && h.latencyMs >= 0);
    assert(logs.some((l) => l.includes("answered")));
  });
});

Deno.test("a wrong status and a missing body text are recorded as not ok, never thrown", async () => {
  await withServer((req) => {
    const url = new URL(req.url);
    return url.pathname === "/missing"
      ? new Response("gone", { status: 404 })
      : new Response("nothing here");
  }, async (base) => {
    const a = context({ url: `${base}/missing` });
    const ha = await health(a.ctx, a.written);
    assertEquals(ha.ok, false);
    assertEquals(ha.status, 404);
    assertEquals(ha.error, "status 404, expected 200");
    const b = context({ url: `${base}/`, bodyContains: "welcome" });
    const hb = await health(b.ctx, b.written);
    assertEquals(hb.ok, false);
    assertEquals(hb.status, 200);
    assertEquals(hb.bodyMatched, false);
    assertStringIncludes(String(hb.error), "body does not hold");
    const c = context({ url: `${base}/missing`, expectStatus: 404 });
    assertEquals((await health(c.ctx, c.written)).ok, true);
  });
});

Deno.test("redirects are followed and counted, or not followed when told", async () => {
  await withServer((req) => {
    const url = new URL(req.url);
    if (url.pathname === "/a") return Response.redirect(`${url.origin}/b`, 302);
    if (url.pathname === "/b") return Response.redirect(`${url.origin}/c`, 301);
    return new Response("end");
  }, async (base) => {
    const f = context({ url: `${base}/a` });
    const hf = await health(f.ctx, f.written);
    assertEquals(hf.ok, true);
    assertEquals(hf.redirects, 2);
    assertEquals(hf.finalUrl, `${base}/c`);
    const n = context({
      url: `${base}/a`,
      followRedirects: false,
      expectStatus: 302,
    });
    const hn = await health(n.ctx, n.written);
    assertEquals(hn.ok, true);
    assertEquals(hn.redirects, 0);
    const capped = context({ url: `${base}/a`, maxRedirects: 1 });
    const hc = await health(capped.ctx, capped.written);
    assertEquals(hc.redirects, 1);
    assertEquals(hc.status, 301);
    assertEquals(hc.ok, false);
  });
});

Deno.test("nothing listening is unreachable with the connection error", async () => {
  const { ctx, written } = context({
    url: "http://127.0.0.1:1/",
    timeoutMs: 3000,
  });
  const h = await health(ctx, written);
  assertEquals(h.reachable, false);
  assertEquals(h.ok, false);
  assertEquals(h.status, null);
  assertEquals(h.tls, null);
  assert(h.error !== null && h.error !== "");
});

Deno.test("an answer slower than timeoutMs is unreachable and says so", async () => {
  await withServer(async () => {
    await new Promise((r) => setTimeout(r, 1500));
    return new Response("late");
  }, async (base) => {
    const { ctx, written } = context({ url: `${base}/`, timeoutMs: 300 });
    const h = await health(ctx, written);
    assertEquals(h.reachable, false);
    assertEquals(h.error, "no answer within 300 ms");
  });
});

Deno.test("a chain that does not verify is recorded as tls failed", async () => {
  const restore = __setFetcher(() =>
    Promise.reject(new TypeError("invalid peer certificate: UnknownIssuer"))
  );
  try {
    const { ctx, written } = context({ url: "https://example.org/" });
    const h = await health(ctx, written);
    assertEquals(h.reachable, false);
    assertEquals(h.tls, "failed");
    assertStringIncludes(String(h.error), "UnknownIssuer");
  } finally {
    restore();
  }
});

Deno.test("a caFile that cannot be read fails the method before anything is recorded", async () => {
  const { ctx, written } = context({
    url: "https://example.org/",
    caFile: "nowhere.pem",
  });
  const err = await assertRejects(() => model.methods.health.execute({}, ctx));
  assertStringIncludes(String(err), "could not be read");
  assertEquals(written.length, 0);
});

Deno.test("a bad url fails the method before anything is recorded", async () => {
  const { ctx, written } = context();
  ctx.globalArgs = { ...ctx.globalArgs, url: "nope" };
  await assertRejects(() => model.methods.health.execute({}, ctx));
  assertEquals(written.length, 0);
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
    const { ctx, written } = context({ url });
    const h = await health(ctx, written);
    assertEquals(h.ok, true, String(h.error));
    assertEquals(h.tls, "verified");
    const bad = context({ url: "https://self-signed.badssl.com/" });
    const hb = await health(bad.ctx, bad.written);
    assertEquals(hb.reachable, false);
    assertEquals(hb.tls, "failed");
  },
});
