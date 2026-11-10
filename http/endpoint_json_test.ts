import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  __setFetcher,
  argumentProblem,
  checks,
  type Context,
  cut,
  GlobalArgsSchema,
  type Health,
  isJsonContentType,
  jsonEqual,
  judgeJson,
  MAX_JSON_BYTES,
  MAX_JSON_DEPTH,
  MAX_MISMATCHES,
  model,
  scanJson,
} from "./endpoint.ts";

const REPO = import.meta.dirname!;
const AGENT = "swamp @dataverket/http";

function context(over: Record<string, unknown> = {}) {
  const written: Record<string, unknown>[] = [];
  const logs: string[] = [];
  const log = (m: string, p?: Record<string, unknown>) =>
    logs.push(`${m} ${JSON.stringify(p ?? {})}`);
  const ctx: Context = {
    globalArgs: GlobalArgsSchema.parse({ url: "http://127.0.0.1:1/", ...over }),
    repoDir: REPO,
    logger: { info: log, warning: log },
    writeResource: (_spec, name, data) => {
      // The record must be what the schema says, nothing more or less.
      written.push(model.resources.health.schema.strict().parse(data));
      return Promise.resolve({ name });
    },
  };
  return { ctx, written, logs };
}

async function health(over: Record<string, unknown>) {
  const { ctx, written, logs } = context(over);
  await model.methods.health.execute({}, ctx);
  assertEquals(written.length, 1);
  return { h: written[0] as Health, logs };
}

type Route = () => Response | Promise<Response>;

/**
 * A local server as strict as the type's promise: it answers only a GET of a
 * path it was given, with Accept any, the default User-Agent, no body, and
 * no credential, cookie or other header. Anything else is a 500 and fails the
 * test that caused it.
 */
async function withStrictServer(
  routes: Record<string, Route>,
  fn: (base: string, hits: string[]) => Promise<void>,
) {
  const violations: string[] = [];
  const hits: string[] = [];
  const allowed = new Set([
    "accept",
    "user-agent",
    "host",
    "accept-encoding",
    "accept-language",
  ]);
  const ac = new AbortController();
  const server = Deno.serve(
    {
      hostname: "127.0.0.1",
      port: 0,
      signal: ac.signal,
      onListen: () => {},
      onError: () => new Response("server error", { status: 500 }),
    },
    (req) => {
      const url = new URL(req.url);
      const path = url.pathname + url.search;
      const refuse = (why: string) => {
        violations.push(`${req.method} ${path}: ${why}`);
        return new Response(why, { status: 500 });
      };
      if (req.method !== "GET") return refuse("not a GET");
      if (req.body !== null) return refuse("a request body");
      if (req.headers.get("accept") !== "*/*") return refuse("accept");
      if (req.headers.get("user-agent") !== AGENT) return refuse("user-agent");
      for (const name of req.headers.keys()) {
        if (!allowed.has(name)) return refuse(`header ${name}`);
      }
      const route = routes[path];
      if (route === undefined) return refuse("no such path");
      hits.push(path);
      return route();
    },
  );
  const base = `http://127.0.0.1:${server.addr.port}`;
  try {
    await fn(base, hits);
  } finally {
    ac.abort();
    await server.finished;
  }
  assertEquals(violations, [], "the strict server refused a request");
}

const JSON_TYPE = { "content-type": "application/json" };
const json =
  (body: unknown, headers: Record<string, string> = JSON_TYPE) => () =>
    new Response(typeof body === "string" ? body : JSON.stringify(body), {
      headers,
    });
const raw =
  (bytes: Uint8Array, headers: Record<string, string> = JSON_TYPE) => () =>
    new Response(bytes as BodyInit, { headers });

const DISCOVERY = {
  issuer: "https://id.example.org",
  authorization_endpoint: "https://id.example.org/oauth/v2/authorize",
  jwks_uri: "https://id.example.org/oauth/v2/keys",
  scopes_supported: ["openid", "profile"],
  claims: { nested: { n: 1, flag: true, none: null }, list: [1, "1", null] },
  count: 3,
};

/** A raw TCP server, for answers Deno.serve would never send. */
async function withRawServer(
  answer: (conn: Deno.Conn) => Promise<void>,
  fn: (base: string) => Promise<void>,
) {
  const listener = Deno.listen({ hostname: "127.0.0.1", port: 0 });
  const port = (listener.addr as Deno.NetAddr).port;
  const serving = (async () => {
    for await (const conn of listener) {
      try {
        const buf = new Uint8Array(4096);
        await conn.read(buf);
        await answer(conn);
      } catch {
        // the client went away
      } finally {
        try {
          conn.close();
        } catch {
          // closed already
        }
      }
    }
  })();
  try {
    await fn(`http://127.0.0.1:${port}`);
  } finally {
    listener.close();
    await serving;
  }
}

// ---------------------------------------------------------------- happy

Deno.test("bodyJson: the issuer of a discovery document matches exactly; other fields are ignored", async () => {
  await withStrictServer({ "/d": json(DISCOVERY) }, async (base) => {
    const { h, logs } = await health({
      url: `${base}/d`,
      bodyJson: { issuer: "https://id.example.org" },
    });
    assertEquals(h.ok, true);
    assertEquals(h.jsonMatched, true);
    assertEquals(h.jsonMismatches, []);
    assertEquals(h.jsonMismatchCount, 0);
    assertEquals(h.bodyMatched, null);
    assertEquals(h.error, null);
    assert(logs.some((l) => l.includes("answered")));
  });
});

Deno.test("bodyJson: nothing asked leaves jsonMatched null and reads no body", async () => {
  let pulled = 0;
  const endless = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(65536));
        },
      }),
      { headers: JSON_TYPE },
    );
  await withStrictServer({ "/": endless }, async (base) => {
    const { h } = await health({ url: `${base}/` });
    assertEquals(h.ok, true);
    assertEquals(h.jsonMatched, null);
    assertEquals(h.jsonMismatches, []);
    assertEquals(h.jsonMismatchCount, 0);
    const explicit = await health({ url: `${base}/`, bodyJson: {} });
    assertEquals(explicit.h.jsonMatched, null);
    assertEquals(explicit.h.ok, true);
  });
  assert(pulled < 200, `an endless body was read: ${pulled} chunks`);
});

Deno.test("bodyJson: nested objects are a subset, arrays and scalars exact, every kind of value", async () => {
  await withStrictServer({ "/d": json(DISCOVERY) }, async (base) => {
    const { h } = await health({
      url: `${base}/d`,
      bodyJson: {
        count: 3,
        scopes_supported: ["openid", "profile"],
        claims: {
          nested: { flag: true, none: null },
          list: [1, "1", null],
        },
      },
    });
    assertEquals(h.jsonMatched, true, String(h.error));
    assertEquals(h.ok, true);
  });
});

Deno.test("bodyJson: a +json content type with parameters, a BOM and number spellings of one value", async () => {
  const bom = new Uint8Array([
    0xef,
    0xbb,
    0xbf,
    ...new TextEncoder().encode('{"n":1.0,"m":1e2}'),
  ]);
  await withStrictServer({
    "/p": json({ a: 1 }, {
      "content-type": "Application/Problem+JSON; charset=utf-8",
    }),
    "/bom": raw(bom),
  }, async (base) => {
    assertEquals(
      (await health({ url: `${base}/p`, bodyJson: { a: 1 } })).h.ok,
      true,
    );
    assertEquals(
      (await health({ url: `${base}/bom`, bodyJson: { n: 1, m: 100 } })).h.ok,
      true,
    );
  });
});

Deno.test("bodyJson and bodyContains together: one request, both judged, each can fail alone", async () => {
  await withStrictServer({ "/d": json(DISCOVERY) }, async (base, hits) => {
    const both = await health({
      url: `${base}/d`,
      bodyContains: "authorization_endpoint",
      bodyJson: { issuer: "https://id.example.org" },
    });
    assertEquals(both.h.ok, true);
    assertEquals(both.h.bodyMatched, true);
    assertEquals(both.h.jsonMatched, true);
    assertEquals(hits.length, 1);
    const textFails = await health({
      url: `${base}/d`,
      bodyContains: "no such text",
      bodyJson: { issuer: "https://id.example.org" },
    });
    assertEquals(textFails.h.ok, false);
    assertEquals(textFails.h.bodyMatched, false);
    assertEquals(textFails.h.jsonMatched, true);
    assertStringIncludes(String(textFails.h.error), "body does not hold");
    const jsonFails = await health({
      url: `${base}/d`,
      bodyContains: "authorization_endpoint",
      bodyJson: { issuer: "https://id.example.org/" },
    });
    assertEquals(jsonFails.h.ok, false);
    assertEquals(jsonFails.h.bodyMatched, true);
    assertEquals(jsonFails.h.jsonMatched, false);
    assertStringIncludes(String(jsonFails.h.error), "body JSON: /issuer");
    assertEquals(hits.length, 3);
  });
});

Deno.test("bodyJson: a redirect is followed and the final JSON judged", async () => {
  await withStrictServer({
    "/old": () =>
      new Response(null, { status: 302, headers: { location: "/d" } }),
    "/d": json(DISCOVERY),
  }, async (base, hits) => {
    const { h } = await health({
      url: `${base}/old`,
      bodyJson: { issuer: "https://id.example.org" },
    });
    assertEquals(h.ok, true);
    assertEquals(h.redirects, 1);
    assertEquals(h.finalUrl, `${base}/d`);
    assertEquals(hits, ["/old", "/d"]);
    // not followed: the redirect itself is judged, and it is not JSON
    const first = await health({
      url: `${base}/old`,
      followRedirects: false,
      expectStatus: 302,
      bodyJson: { issuer: "https://id.example.org" },
    });
    assertEquals(first.h.ok, false);
    assertEquals(first.h.jsonMismatches[0].reason, "content-type");
  });
});

// ------------------------------------------------------------- negative

Deno.test("bodyJson: a longer issuer that a substring would accept is a value mismatch", async () => {
  const evil = { ...DISCOVERY, issuer: "https://id.example.org.evil.example" };
  await withStrictServer({ "/d": json(evil) }, async (base) => {
    const text = await health({
      url: `${base}/d`,
      bodyContains: "https://id.example.org",
    });
    assertEquals(text.h.ok, true, "the substring match accepts it");
    const { h, logs } = await health({
      url: `${base}/d`,
      bodyJson: { issuer: "https://id.example.org" },
    });
    assertEquals(h.ok, false);
    assertEquals(h.reachable, true);
    assertEquals(h.status, 200);
    assertEquals(h.jsonMatched, false);
    assertEquals(h.jsonMismatchCount, 1);
    assertEquals(h.jsonMismatches, [{
      path: "/issuer",
      reason: "value",
      expectedType: "string",
      actualType: "string",
      expected: null,
      actual: null,
    }]);
    assertEquals(
      h.error,
      "body JSON: /issuer does not have the expected value",
    );
    // nothing from the body reaches the record or a log line by default
    assert(!JSON.stringify(h).includes("evil"));
    assert(!logs.join("\n").includes("evil"));
  });
});

Deno.test("bodyJson: bodyJsonShowValues records expected and actual, cut at 200 characters", async () => {
  const long = "s".repeat(5000);
  await withStrictServer({
    "/d": json({ issuer: "https://other.example.org", token: long }),
  }, async (base) => {
    const { h } = await health({
      url: `${base}/d`,
      bodyJson: { issuer: "https://id.example.org", token: "x" },
      bodyJsonShowValues: true,
    });
    assertEquals(h.jsonMatched, false);
    assertEquals(h.jsonMismatchCount, 2);
    assertEquals(h.jsonMismatches[0].expected, '"https://id.example.org"');
    assertEquals(h.jsonMismatches[0].actual, '"https://other.example.org"');
    assertEquals(
      h.error,
      'body JSON: /issuer is "https://other.example.org", expected "https://id.example.org" (and 1 more)',
    );
    const actual = h.jsonMismatches[1].actual!;
    assert(actual.length < 260, `actual is ${actual.length} long`);
    assertStringIncludes(actual, "more characters)");
    assert(JSON.stringify(h).length < 2000);
  });
});

Deno.test('bodyJson: a wrong type is not a value: "1" is not 1, null is not false, 0 is not false', async () => {
  await withStrictServer({
    "/d": json({ a: "1", b: 1, c: null, d: 0, e: {}, f: [], g: "true" }),
  }, async (base) => {
    const { h } = await health({
      url: `${base}/d`,
      bodyJson: { a: 1, b: "1", c: false, d: false, e: [], f: {}, g: true },
    });
    assertEquals(h.ok, false);
    assertEquals(h.jsonMismatchCount, 7);
    assertEquals(
      h.jsonMismatches.map((
        m,
      ) => [m.path, m.reason, m.expectedType, m.actualType]),
      [
        ["/a", "type", "number", "string"],
        ["/b", "type", "string", "number"],
        ["/c", "type", "boolean", "null"],
        ["/d", "type", "boolean", "number"],
        ["/e", "type", "array", "object"],
        ["/f", "type", "object", "array"],
        ["/g", "type", "boolean", "string"],
      ],
    );
    assertEquals(
      h.error,
      "body JSON: /a is string, expected number (and 6 more)",
    );
  });
});

Deno.test("bodyJson: a missing field, top level and nested, and null is not missing", async () => {
  await withStrictServer({ "/d": json(DISCOVERY) }, async (base) => {
    const { h } = await health({
      url: `${base}/d`,
      bodyJson: {
        end_session_endpoint: "https://id.example.org/logout",
        claims: { nested: { absent: null, none: null } },
      },
    });
    assertEquals(h.ok, false);
    assertEquals(
      h.jsonMismatches.map((m) => [m.path, m.reason, m.actualType]),
      [
        ["/end_session_endpoint", "missing", "missing"],
        ["/claims/nested/absent", "missing", "missing"],
      ],
    );
    assertEquals(
      h.error,
      "body JSON: /end_session_endpoint is missing (and 1 more)",
    );
  });
});

Deno.test("bodyJson: arrays are exact: order, length, element type, and objects inside them", async () => {
  await withStrictServer({
    "/d": json({ a: ["x", "y"], o: [{ k: 1, extra: 2 }] }),
  }, async (base) => {
    for (
      const expected of [
        { a: ["y", "x"] },
        { a: ["x"] },
        { a: ["x", "y", "z"] },
        { a: ["x", 1] },
        { a: [] },
        { o: [{ k: 1 }] },
      ]
    ) {
      const { h } = await health({ url: `${base}/d`, bodyJson: expected });
      assertEquals(h.jsonMatched, false, JSON.stringify(expected));
      assertEquals(h.jsonMismatches[0].reason, "value");
    }
    const exact = await health({
      url: `${base}/d`,
      bodyJson: { a: ["x", "y"], o: [{ extra: 2, k: 1 }] },
    });
    assertEquals(exact.h.jsonMatched, true);
  });
});

Deno.test("bodyJson: a body that is not JSON, empty, or JSON with a tail, is not-json and never thrown", async () => {
  await withStrictServer({
    "/html": json("<html>issuer</html>"),
    "/empty": json(""),
    "/tail": json('{"issuer":"a"} x'),
    "/single": json("{'issuer':'a'}"),
    "/nan": json('{"issuer":NaN}'),
    "/none": () => new Response(null, { status: 204, headers: JSON_TYPE }),
  }, async (base) => {
    for (const path of ["/html", "/empty", "/tail", "/single", "/nan"]) {
      const { h } = await health({
        url: `${base}${path}`,
        bodyJson: { issuer: "a" },
        bodyJsonShowValues: true,
      });
      assertEquals(h.ok, false, path);
      assertEquals(h.reachable, true);
      assertEquals(h.jsonMismatches.length, 1);
      assertEquals(h.jsonMismatches[0].reason, "not-json", path);
      assertEquals(h.jsonMismatches[0].path, "");
      assertEquals(h.jsonMismatches[0].actual, null);
      assertEquals(h.error, "body JSON: the body is not JSON");
    }
    const none = await health({
      url: `${base}/none`,
      expectStatus: 204,
      bodyJson: { issuer: "a" },
    });
    assertEquals(none.h.jsonMismatches[0].reason, "not-json");
  });
});

Deno.test("bodyJson: an array or a scalar at the top level is not-object", async () => {
  await withStrictServer({
    "/array": json([{ issuer: "a" }]),
    "/string": json('"issuer"'),
    "/number": json("1"),
    "/null": json("null"),
    "/true": json("true"),
  }, async (base) => {
    for (
      const [path, type] of [
        ["/array", "array"],
        ["/string", "string"],
        ["/number", "number"],
        ["/null", "null"],
        ["/true", "boolean"],
      ]
    ) {
      const { h } = await health({
        url: `${base}${path}`,
        bodyJson: { issuer: "a" },
      });
      assertEquals(h.ok, false);
      assertEquals(h.jsonMismatches[0].reason, "not-object");
      assertEquals(h.jsonMismatches[0].actualType, type);
      assertEquals(h.error, `body JSON: the body is ${type}, not an object`);
    }
  });
});

Deno.test("bodyJson: a wrong, missing or hostile content type is recorded and the body is not read", async () => {
  let pulled = 0;
  const endlessHtml = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(65536));
        },
      }),
      { headers: { "content-type": "text/html" } },
    );
  await withStrictServer({
    "/text": json(DISCOVERY, { "content-type": "text/plain; charset=utf-8" }),
    "/endless": endlessHtml,
    "/none": () => new Response(new TextEncoder().encode('{"issuer":"a"}')),
    "/odd": json(DISCOVERY, {
      "content-type": 'x"<script>/json; secret=hunter2',
    }),
    "/almost": json(DISCOVERY, { "content-type": "application/jsonx" }),
    "/suffix": json(DISCOVERY, { "content-type": "text/json+xml" }),
  }, async (base) => {
    const text = await health({
      url: `${base}/text`,
      bodyJson: { issuer: "https://id.example.org" },
    });
    assertEquals(text.h.ok, false);
    assertEquals(text.h.jsonMatched, false);
    assertEquals(text.h.jsonMismatches[0].reason, "content-type");
    assertEquals(text.h.error, "body JSON: the answer is text/plain, not JSON");
    // what the probe itself takes from the body, counted between fetch and probe
    let taken = 0;
    const restore = __setFetcher(async (url, init) => {
      const res = await fetch(url, { ...init, redirect: "manual" });
      const reader = res.body!.getReader();
      const counted = new ReadableStream<Uint8Array>({
        async pull(c) {
          const { done, value } = await reader.read();
          if (done) return c.close();
          taken += value.byteLength;
          c.enqueue(value);
        },
        cancel: (reason) => reader.cancel(reason),
      }, { highWaterMark: 0 });
      return new Response(counted, {
        status: res.status,
        headers: res.headers,
      });
    });
    let endless;
    try {
      endless = await health({ url: `${base}/endless`, bodyJson: { a: 1 } });
    } finally {
      restore();
    }
    assertEquals(taken, 0, "a body that is not JSON was read");
    assertEquals(
      endless.h.error,
      "body JSON: the answer is text/html, not JSON",
    );
    const none = await health({
      url: `${base}/none`,
      bodyJson: { issuer: "a" },
    });
    assertEquals(
      none.h.error,
      "body JSON: the answer is no content type, not JSON",
    );
    const odd = await health({ url: `${base}/odd`, bodyJson: { issuer: "a" } });
    assertEquals(
      odd.h.error,
      "body JSON: the answer is an unreadable content type, not JSON",
    );
    assert(!JSON.stringify(odd.h).includes("hunter2"));
    for (const path of ["/almost", "/suffix"]) {
      const { h } = await health({ url: `${base}${path}`, bodyJson: { a: 1 } });
      assertEquals(h.jsonMismatches[0].reason, "content-type", path);
    }
  });
  assert(pulled < 200, `a body that is not JSON was read: ${pulled} chunks`);
});

Deno.test("bodyJson: a body past the cap is too-large; an endless one is cut off, not downloaded", async () => {
  const pad = "x".repeat(MAX_JSON_BYTES);
  const big = JSON.stringify({ issuer: "a", pad });
  const atCap = JSON.stringify({ issuer: "a", pad: "" });
  const exactly = atCap.slice(0, -2) +
    "x".repeat(MAX_JSON_BYTES - atCap.length) + '"}';
  assertEquals(exactly.length, MAX_JSON_BYTES);
  let pulled = 0;
  const endless = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        pull(c) {
          pulled++;
          c.enqueue(new Uint8Array(65536).fill(0x20));
        },
      }),
      { headers: JSON_TYPE },
    );
  await withStrictServer({
    "/big": json(big),
    "/exactly": json(exactly),
    "/endless": endless,
  }, async (base) => {
    const { h } = await health({
      url: `${base}/big`,
      bodyJson: { issuer: "a" },
    });
    assertEquals(h.ok, false);
    assertEquals(h.reachable, true);
    assertEquals(h.jsonMismatches[0].reason, "too-large");
    assertEquals(
      h.error,
      `body JSON: the body is larger than ${MAX_JSON_BYTES} bytes`,
    );
    const fits = await health({
      url: `${base}/exactly`,
      bodyJson: { issuer: "a" },
    });
    assertEquals(fits.h.ok, true, String(fits.h.error));
    // with bodyContains the whole body is read, as before, and the JSON is still too large
    const both = await health({
      url: `${base}/big`,
      bodyContains: "issuer",
      bodyJson: { issuer: "a" },
    });
    assertEquals(both.h.bodyMatched, true);
    assertEquals(both.h.jsonMismatches[0].reason, "too-large");
    const cutOff = await health({
      url: `${base}/endless`,
      bodyJson: { issuer: "a" },
      timeoutMs: 5000,
    });
    assertEquals(cutOff.h.reachable, true);
    assertEquals(cutOff.h.jsonMismatches[0].reason, "too-large");
  });
  assert(pulled < 200, `an endless body was downloaded: ${pulled} chunks`);
});

Deno.test("bodyJson: invalid UTF-8 is not-utf8, also where a lenient decoder would produce the expected text", async () => {
  const enc = new TextEncoder();
  const bad = new Uint8Array([
    ...enc.encode('{"issuer":"a'),
    0xff,
    ...enc.encode('"}'),
  ]);
  const overlong = new Uint8Array([
    ...enc.encode('{"issuer":"'),
    0xc0,
    0xaf,
    ...enc.encode('"}'),
  ]);
  const lone = new Uint8Array([
    ...enc.encode('{"issuer":"'),
    0xed,
    0xa0,
    0x80,
    ...enc.encode('"}'),
  ]);
  const utf16 = new Uint8Array([0xff, 0xfe, 0x7b, 0x00, 0x7d, 0x00]);
  await withStrictServer({
    "/bad": raw(bad),
    "/overlong": raw(overlong),
    "/lone": raw(lone),
    "/utf16": raw(utf16),
  }, async (base) => {
    for (const path of ["/bad", "/overlong", "/lone", "/utf16"]) {
      const { h } = await health({
        url: `${base}${path}`,
        bodyJson: { issuer: "a\ufffd" },
      });
      assertEquals(h.ok, false, path);
      assertEquals(h.jsonMismatches[0].reason, "not-utf8", path);
      assertEquals(h.error, "body JSON: the body is not UTF-8");
    }
    // bodyContains keeps its lenient decoding beside it
    const both = await health({
      url: `${base}/bad`,
      bodyContains: "issuer",
      bodyJson: { issuer: "a" },
    });
    assertEquals(both.h.bodyMatched, true);
    assertEquals(both.h.jsonMatched, false);
  });
});

Deno.test("bodyJson: a key held twice is refused whichever value comes last, escaped spellings included", async () => {
  await withStrictServer({
    "/last-good": json(
      '{"issuer":"https://evil.example","issuer":"https://id.example.org"}',
    ),
    "/last-bad": json(
      '{"issuer":"https://id.example.org","issuer":"https://evil.example"}',
    ),
    "/escaped": json(
      '{"issuer":"https://id.example.org","\\u0069ssuer":"https://evil.example"}',
    ),
    "/nested": json(
      '{"issuer":"https://id.example.org","x":[{"a":{"k":1,"k":2}}]}',
    ),
    "/fine": json(
      '{"issuer":"https://id.example.org","a":{"k":1},"b":{"k":1},"c":[{"k":1},{"k":2}],"s":"{\\"k\\":1,\\"k\\":2}"}',
    ),
  }, async (base) => {
    for (const path of ["/last-good", "/last-bad", "/escaped", "/nested"]) {
      const { h } = await health({
        url: `${base}${path}`,
        bodyJson: { issuer: "https://id.example.org" },
      });
      assertEquals(h.ok, false, path);
      assertEquals(h.jsonMismatches[0].reason, "duplicate-key", path);
      assertEquals(h.jsonMismatches[0].actual, null);
      assertEquals(h.error, "body JSON: the body holds a key twice");
      assert(!JSON.stringify(h).includes("evil"));
    }
    const shown = await health({
      url: `${base}/nested`,
      bodyJson: { issuer: "https://id.example.org" },
      bodyJsonShowValues: true,
    });
    assertEquals(shown.h.jsonMismatches[0].actual, "/x/0/a/k");
    assertEquals(
      shown.h.error,
      "body JSON: the body holds a key twice at /x/0/a/k",
    );
    const fine = await health({
      url: `${base}/fine`,
      bodyJson: { issuer: "https://id.example.org" },
    });
    assertEquals(fine.h.ok, true, String(fine.h.error));
  });
});

Deno.test("bodyJson: __proto__, constructor and other inherited names are fields like any other", async () => {
  await withStrictServer({
    "/plain": json('{"issuer":"a"}'),
    "/proto": json(
      '{"__proto__":{"issuer":"a","admin":true},"constructor":"c","toString":1}',
    ),
  }, async (base) => {
    // an inherited property is not a field of the body
    for (
      const key of [
        "constructor",
        "toString",
        "hasOwnProperty",
        "valueOf",
        "__defineGetter__",
      ]
    ) {
      const expected = JSON.parse(`{"${key}":{}}`);
      const { h } = await health({ url: `${base}/plain`, bodyJson: expected });
      assertEquals(h.jsonMatched, false, key);
      assertEquals(h.jsonMismatches[0].reason, "missing", key);
      assertEquals(h.jsonMismatches[0].path, `/${key}`);
    }
    // a body's __proto__ key does not become the prototype of what is compared
    const viaProto = await health({
      url: `${base}/proto`,
      bodyJson: { issuer: "a" },
    });
    assertEquals(viaProto.h.jsonMismatches[0].reason, "missing");
    const admin = await health({
      url: `${base}/proto`,
      bodyJson: { admin: true },
    });
    assertEquals(admin.h.jsonMismatches[0].reason, "missing");
    // constructor and toString are still own fields that can be asserted
    const own = await health({
      url: `${base}/proto`,
      bodyJson: { constructor: "c", toString: 1 },
    });
    assertEquals(own.h.jsonMatched, true, String(own.h.error));
    const wrong = await health({
      url: `${base}/proto`,
      bodyJson: { constructor: "d" },
    });
    assertEquals(wrong.h.jsonMismatches[0].path, "/constructor");
    assertEquals(({} as Record<string, unknown>).admin, undefined);
    assertEquals(({} as Record<string, unknown>).issuer, undefined);
  });
});

Deno.test("bodyJson: nesting up to the limit is judged, deeper is too-deep, a megabyte of brackets does not crash", async () => {
  const nest = (n: number) => '{"a":'.repeat(n) + "1" + "}".repeat(n);
  const expectNest = (n: number) => {
    let v: unknown = 1;
    for (let i = 0; i < n; i++) v = { a: v };
    return v as Record<string, unknown>;
  };
  await withStrictServer({
    "/30": json(nest(30)),
    "/at": json(nest(MAX_JSON_DEPTH)),
    "/over": json(nest(MAX_JSON_DEPTH + 1)),
    "/arrays": json(
      '{"issuer":"a","x":' + "[".repeat(100000) + "]".repeat(100000) + "}",
    ),
    "/open": json("[".repeat(MAX_JSON_BYTES - 10)),
  }, async (base) => {
    const deep = await health({ url: `${base}/30`, bodyJson: expectNest(30) });
    assertEquals(deep.h.ok, true, String(deep.h.error));
    const at = await health({ url: `${base}/at`, bodyJson: { a: { a: {} } } });
    assertEquals(at.h.ok, true, String(at.h.error));
    for (const path of ["/over", "/arrays", "/open"]) {
      const { h } = await health({
        url: `${base}${path}`,
        bodyJson: { issuer: "a" },
      });
      assertEquals(h.ok, false, path);
      assertEquals(h.jsonMismatches[0].reason, "too-deep", path);
      assertEquals(
        h.error,
        `body JSON: the body is nested deeper than ${MAX_JSON_DEPTH} levels`,
      );
    }
  });
});

Deno.test("bodyJson: more differing fields than the list holds are counted, the list is cut at 20", async () => {
  const expected: Record<string, unknown> = {};
  for (let i = 0; i < 50; i++) expected[`k${i}`] = i;
  await withStrictServer({ "/d": json({}) }, async (base) => {
    const { h } = await health({ url: `${base}/d`, bodyJson: expected });
    assertEquals(h.jsonMismatches.length, MAX_MISMATCHES);
    assertEquals(h.jsonMismatchCount, 50);
    assertEquals(h.error, "body JSON: /k0 is missing (and 49 more)");
  });
});

Deno.test("bodyJson: keys with slash, tilde, dot, space, quote and newline are addressed without ambiguity", async () => {
  const body = {
    "a.b": 1,
    a: { b: 2 },
    "x/y": 3,
    "t~0": 4,
    " ": 5,
    'q"\n': 6,
    "": 7,
  };
  await withStrictServer({ "/d": json(body) }, async (base) => {
    const same = await health({ url: `${base}/d`, bodyJson: body });
    assertEquals(same.h.jsonMatched, true);
    const { h } = await health({
      url: `${base}/d`,
      bodyJson: {
        "a.b": 2,
        a: { b: 1 },
        "x/y": 0,
        "t~0": 0,
        " ": 0,
        'q"\n': 0,
        "": 0,
      },
    });
    assertEquals(h.jsonMismatches.map((m) => m.path), [
      "/a.b",
      "/a/b",
      "/x~1y",
      "/t~00",
      "/ ",
      '/q"\n',
      "/",
    ]);
  });
});

Deno.test("bodyJson: a wrong status is still the first error, and the JSON is judged beside it", async () => {
  await withStrictServer({
    "/down": () =>
      new Response('{"status":"down"}', { status: 503, headers: JSON_TYPE }),
  }, async (base) => {
    const { h } = await health({
      url: `${base}/down`,
      bodyJson: { status: "up" },
    });
    assertEquals(h.ok, false);
    assertEquals(h.error, "status 503, expected 200");
    assertEquals(h.jsonMatched, false);
    assertEquals(h.jsonMismatches[0].path, "/status");
  });
});

Deno.test("bodyJson: a body cut short is unreachable with the connection error, nothing judged", async () => {
  const enc = new TextEncoder();
  await withRawServer(async (conn) => {
    await conn.write(enc.encode(
      'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ncontent-length: 500\r\n\r\n{"issuer":"https://id.example.org"',
    ));
  }, async (base) => {
    const { h } = await health({
      url: `${base}/`,
      bodyJson: { issuer: "https://id.example.org" },
      timeoutMs: 5000,
    });
    assertEquals(h.ok, false);
    assertEquals(h.reachable, false);
    assertEquals(h.status, null);
    assertEquals(h.jsonMatched, null);
    assertEquals(h.jsonMismatches, []);
    assert(h.error !== null && h.error !== "" && !h.error.includes("within"));
  });
  // chunked and cut before the last chunk
  await withRawServer(async (conn) => {
    await conn.write(enc.encode(
      'HTTP/1.1 200 OK\r\ncontent-type: application/json\r\ntransfer-encoding: chunked\r\n\r\n10\r\n{"issuer":"a"}  \r\n',
    ));
  }, async (base) => {
    const { h } = await health({
      url: `${base}/`,
      bodyJson: { issuer: "a" },
      timeoutMs: 5000,
    });
    assertEquals(h.ok, false, "a cut body must never pass");
    assertEquals(h.reachable, false);
    assertEquals(h.jsonMatched, null);
  });
});

Deno.test("bodyJson: a body slower than timeoutMs is unreachable and says so, even when its start already matches", async () => {
  const enc = new TextEncoder();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const slow = () =>
    new Response(
      new ReadableStream<Uint8Array>({
        start(c) {
          c.enqueue(enc.encode('{"issuer":"https://id.example.org"'));
          timer = setTimeout(() => {
            try {
              c.enqueue(enc.encode("}"));
              c.close();
            } catch {
              // cancelled by the client
            }
          }, 2000);
        },
        cancel() {
          clearTimeout(timer);
        },
      }),
      { headers: JSON_TYPE },
    );
  await withStrictServer({ "/slow": slow }, async (base) => {
    const started = performance.now();
    const { h } = await health({
      url: `${base}/slow`,
      bodyJson: { issuer: "https://id.example.org" },
      timeoutMs: 300,
    });
    assert(performance.now() - started < 1500);
    assertEquals(h.ok, false);
    assertEquals(h.reachable, false);
    assertEquals(h.jsonMatched, null);
    assertEquals(h.error, "no answer within 300 ms");
  });
  clearTimeout(timer);
});

Deno.test("bodyJson: a definition that is not JSON values fails the method before any request", async () => {
  await withStrictServer({}, async (base, hits) => {
    let deep: unknown = 1;
    for (let i = 0; i < 40; i++) deep = { a: deep };
    for (
      const [bad, text] of [
        [{ a: Number.NaN }, "bodyJson /a is not a finite number"],
        [{ a: { b: [1, Infinity] } }, "bodyJson /a/b/1 is not a finite number"],
        [{ a: undefined }, "bodyJson /a is not a JSON value"],
        [{ a: () => 1 }, "bodyJson /a is not a JSON value"],
        [{ a: new Date(0) }, "bodyJson /a is not a JSON value"],
        [{ a: 1n }, "bodyJson /a is not a JSON value"],
        [deep, "nested deeper than 32 levels"],
      ] as [Record<string, unknown>, string][]
    ) {
      const { ctx, written } = context({ url: `${base}/` });
      ctx.globalArgs = { ...ctx.globalArgs, bodyJson: bad };
      const err = await assertRejects(() =>
        model.methods.health.execute({}, ctx)
      );
      assertStringIncludes(String(err), text);
      assertEquals(written.length, 0);
      assertEquals(
        (await checks.arguments.execute({ globalArgs: ctx.globalArgs })).pass,
        false,
      );
    }
    assertEquals(hits, []);
  });
  for (const bad of ["issuer", ["issuer"], 1, null]) {
    assert(
      !GlobalArgsSchema.safeParse({ url: "http://x/", bodyJson: bad }).success,
    );
    assertEquals(
      argumentProblem({ url: "http://x/", bodyJson: bad as never }),
      "bodyJson is not an object of fields",
    );
  }
  assertEquals(
    argumentProblem({ url: "http://x/", bodyJson: { a: [{ b: null }] } }),
    null,
  );
});

Deno.test("bodyJson: a field named __proto__ is refused at every depth, never dropped without a word", async () => {
  // the schema refuses it at the top level, where a record would drop it
  const top = GlobalArgsSchema.safeParse({
    url: "http://x/",
    bodyJson: JSON.parse('{"__proto__":{"admin":true},"issuer":"a"}'),
  });
  assertEquals(top.success, false);
  assertStringIncludes(JSON.stringify(top.error?.issues), "__proto__");
  assertStringIncludes(
    argumentProblem({
      url: "http://x/",
      bodyJson: JSON.parse('{"__proto__":{"admin":true}}'),
    })!,
    "bodyJson holds a field named __proto__",
  );
  // deeper, the method refuses it before any request
  await withStrictServer({}, async (base, hits) => {
    for (
      const nested of [
        '{"a":{"__proto__":1}}',
        '{"a":[{"b":{"__proto__":null}}]}',
      ]
    ) {
      const { ctx, written } = context({
        url: `${base}/`,
        bodyJson: JSON.parse(nested),
      });
      const err = await assertRejects(() =>
        model.methods.health.execute({}, ctx)
      );
      assertStringIncludes(String(err), "a field named __proto__");
      assertEquals(written.length, 0);
    }
    assertEquals(hits, []);
  });
});

// ---------------------------------------------------------------- units

Deno.test("scanJson: duplicates and depth, on valid and on broken text", () => {
  assertEquals(scanJson('{"a":1,"b":{"a":1}}'), {
    tooDeep: false,
    duplicate: null,
  });
  assertEquals(scanJson('{"a":1,"a":1}').duplicate, "/a");
  assertEquals(scanJson('{"a":[1,{"b/c":1,"b/c":2}]}').duplicate, "/a/1/b~1c");
  assertEquals(scanJson('{"a":"\\"","b":"a\\\\","a":1}').duplicate, "/a");
  assertEquals(scanJson('{"a":"x,\\"a\\":1"}').duplicate, null);
  assertEquals(scanJson('{"a":["a","a"],"b":"a"}').duplicate, null);
  assertEquals(
    scanJson('{"__proto__":1,"__proto__":2}').duplicate,
    "/__proto__",
  );
  assertEquals(scanJson("[[[]]]", 3).tooDeep, false);
  assertEquals(scanJson("[[[[]]]]", 3).tooDeep, true);
  assertEquals(scanJson('"[[[[[[[["', 3).tooDeep, false);
  for (
    const broken of [
      "",
      "}",
      "]]]",
      '{"a',
      '{"a\\',
      "{,,,}",
      '{"\\uZZZZ":1}',
      ",",
      '{"a":1}}}{"a":2,"a":3}',
    ]
  ) {
    scanJson(broken);
  }
});

Deno.test("judgeJson, jsonEqual, isJsonContentType, cut", () => {
  const enc = (s: string) => new TextEncoder().encode(s);
  assertEquals(
    judgeJson(enc('{"a":1}'), "application/json", { a: 1 }, false),
    { matched: true, mismatches: [], count: 0 },
  );
  assertEquals(
    judgeJson(null, "application/json", { a: 1 }, true).mismatches[0].reason,
    "too-large",
  );
  assertEquals(
    judgeJson(enc("{}"), null, { a: 1 }, true).mismatches[0].reason,
    "content-type",
  );
  assert(jsonEqual({ a: [1, { b: null }] }, { a: [1, { b: null }] }));
  assert(!jsonEqual({ a: 1 }, { a: 1, b: 2 }));
  assert(!jsonEqual({ a: 1, b: 2 }, { a: 1 }));
  assert(!jsonEqual({ a: 1, b: 2 }, { a: 1, c: 2 }));
  assert(!jsonEqual([], {}));
  assert(!jsonEqual(null, {}));
  assert(!jsonEqual(0, false));
  assert(!jsonEqual("", null));
  assert(!jsonEqual({ constructor: Object }, {}));
  assert(isJsonContentType("application/json"));
  assert(isJsonContentType(" APPLICATION/JSON ;charset=utf-8"));
  assert(isJsonContentType("application/ld+json"));
  for (
    const no of [
      null,
      "",
      "json",
      "text/html",
      "application/json5",
      "application/json, text/html",
      "/+json",
      "a b/c+json",
    ]
  ) {
    assert(!isJsonContentType(no), String(no));
  }
  assertEquals(cut("abc", 3), "abc");
  assertEquals(cut("abcd", 3), "abc... (1 more characters)");
  assertEquals(cut("ab\u{1F600}", 3), "ab... (2 more characters)");
});
