// A throwaway local server for the smoke suite of @dataverket/http: one path
// per answer `bodyJson` must accept or refuse. It answers a plain GET only,
// as the type promises to send, and a 500 for anything else.
//
//   deno run --allow-net=127.0.0.1 server.ts [port]
const port = Number(Deno.args[0] ?? "18080");
const enc = new TextEncoder();
const JSON_TYPE = { "content-type": "application/json" };
const ISSUER = "https://id.example.org";
const discovery = (issuer: string) => ({
  issuer,
  authorization_endpoint: `${issuer}/oauth/v2/authorize`,
  jwks_uri: `${issuer}/oauth/v2/keys`,
  scopes_supported: ["openid", "profile", "email"],
  token_endpoint_auth_methods_supported: ["none", "private_key_jwt"],
  limits: { max_age: 3600, strict: true, note: null },
});
const json = (body: unknown, headers: Record<string, string> = JSON_TYPE) =>
  new Response(typeof body === "string" ? body : JSON.stringify(body), {
    headers,
  });

/** A body that starts and then never ends in time: `ms` before its last byte. */
function slow(ms: number): Response {
  let timer: ReturnType<typeof setTimeout> | undefined;
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(JSON.stringify(discovery(ISSUER)).slice(0, -1)));
        timer = setTimeout(() => {
          try {
            c.enqueue(enc.encode("}"));
            c.close();
          } catch {
            // the client gave up
          }
        }, ms);
      },
      cancel() {
        clearTimeout(timer);
      },
    }),
    { headers: JSON_TYPE },
  );
}

/** A body that breaks off after its first part, as a dropped connection does. */
function cutShort(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      start(c) {
        c.enqueue(enc.encode(JSON.stringify(discovery(ISSUER)).slice(0, 40)));
        setTimeout(() => c.error(new Error("cut")), 50);
      },
    }),
    { headers: JSON_TYPE },
  );
}

/** A body without end, 64 KiB of spaces at a time. */
function endless(): Response {
  return new Response(
    new ReadableStream<Uint8Array>({
      pull(c) {
        c.enqueue(new Uint8Array(65536).fill(0x20));
      },
    }),
    { headers: JSON_TYPE },
  );
}

const routes: Record<string, () => Response> = {
  "/discovery": () => json(discovery(ISSUER)),
  "/longer": () => json(discovery(`${ISSUER}.attacker.example`)),
  "/moved": () =>
    new Response(null, { status: 302, headers: { location: "/discovery" } }),
  "/html": () =>
    new Response(`<html>${ISSUER}</html>`, {
      headers: { "content-type": "text/html" },
    }),
  "/text-plain": () =>
    json(discovery(ISSUER), { "content-type": "text/plain" }),
  "/not-json": () => json(`{"issuer": ${ISSUER}`),
  "/array": () => json([discovery(ISSUER)]),
  "/scalar": () => json(JSON.stringify(ISSUER)),
  "/twice": () =>
    json(`{"issuer":"https://other.example","issuer":"${ISSUER}"}`),
  "/proto": () => json(`{"__proto__":{"issuer":"${ISSUER}"}}`),
  "/deep": () => json('{"a":'.repeat(100) + "1" + "}".repeat(100)),
  "/huge": () => json({ issuer: ISSUER, pad: "x".repeat(2 * 1024 * 1024) }),
  "/endless": endless,
  "/not-utf8": () =>
    new Response(
      new Uint8Array([
        ...enc.encode('{"issuer":"'),
        0xff,
        ...enc.encode('"}'),
      ]),
      { headers: JSON_TYPE },
    ),
  "/slow": () => slow(4000),
  "/cut": cutShort,
  "/down": () =>
    new Response('{"status":"down"}', { status: 503, headers: JSON_TYPE }),
};

Deno.serve({ hostname: "127.0.0.1", port }, (req) => {
  const url = new URL(req.url);
  const route = routes[url.pathname];
  if (req.method !== "GET" || req.body !== null || route === undefined) {
    return new Response("refused", { status: 500 });
  }
  for (const name of ["authorization", "cookie", "proxy-authorization"]) {
    if (req.headers.has(name)) return new Response("refused", { status: 500 });
  }
  return route();
});
