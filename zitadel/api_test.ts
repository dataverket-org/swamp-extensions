import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  credentialKind,
  expandHome,
  fromBase64,
  getToken,
  importSigningKey,
  jwtAssertionClaims,
  parseKeyJson,
  readKeyJson,
  systemAssertionClaims,
  toBase64,
} from "./api.ts";

Deno.test("parseKeyJson accepts a key whose subject is clientId", () => {
  const key = parseKeyJson(
    '{"keyId":"1","key":"-----BEGIN RSA PRIVATE KEY-----","clientId":"7"}',
  );
  assertEquals(key.keyId, "1");
  assertEquals(key.clientId, "7");
});

Deno.test("parseKeyJson refuses a key without a subject, saying no more", () => {
  const error = assertThrows(
    () => parseKeyJson('{"keyId":"1","key":"secret-material"}'),
    Error,
  );
  assert(!error.message.includes("secret-material"));
});

Deno.test("jwtAssertionClaims names the service user and expires in an hour", () => {
  const claims = jwtAssertionClaims(
    { keyId: "1", key: "-----BEGIN RSA PRIVATE KEY-----", userId: "9" },
    "https://zitadel.example.org/",
    1000,
  );
  assertEquals(claims.iss, "9");
  assertEquals(claims.sub, "9");
  assertEquals(claims.aud, "https://zitadel.example.org");
  assertEquals(claims.exp, 4600);
});

Deno.test("base64 round-trips a key JSON blob", () => {
  const text = '{"type":"serviceaccount","keyId":"1"}';
  assertEquals(fromBase64(toBase64(text)), text);
});

Deno.test("importSigningKey imports a PKCS#8 PEM for RS256", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    btoa(binary).replace(/(.{64})/g, "$1\n")
  }\n-----END PRIVATE KEY-----`;
  const key = await importSigningKey(pem);
  assertEquals(key.type, "private");
});

Deno.test("a key that is not a PEM is named as such, without its contents", async () => {
  const pem =
    "-----BEGIN RSA PRIVATE KEY-----\nSECRETMARKER\n-----END RSA PRIVATE KEY-----";
  const error = await assertRejects(() => importSigningKey(pem), Error);
  assert(/service user's key/.test(error.message), error.message);
  assert(
    !error.message.includes("SECRETMARKER"),
    "the key leaked into the error",
  );
});

/** Run `fn` with `HOME` set to `home` (or unset), restoring it afterwards. */
async function withHome(
  home: string | undefined,
  fn: () => Promise<void> | void,
): Promise<void> {
  const before = Deno.env.get("HOME");
  if (home === undefined) Deno.env.delete("HOME");
  else Deno.env.set("HOME", home);
  try {
    await fn();
  } finally {
    if (before === undefined) Deno.env.delete("HOME");
    else Deno.env.set("HOME", before);
  }
}

Deno.test("expandHome expands a leading ~/ and nothing else", async () => {
  await withHome("/home/kari", () => {
    assertEquals(
      expandHome("~/.config/zitadel/k.json"),
      "/home/kari/.config/zitadel/k.json",
    );
    assertEquals(expandHome("~"), "/home/kari");
    assertEquals(expandHome("/etc/k.json"), "/etc/k.json");
    assertEquals(expandHome("keys/k.json"), "keys/k.json");
    // Another user's home and a ~ further in are not ours to guess at.
    assertEquals(expandHome("~ola/k.json"), "~ola/k.json");
    assertEquals(expandHome("/srv/~/k.json"), "/srv/~/k.json");
  });
});

Deno.test("expandHome refuses ~ when HOME is not set", async () => {
  await withHome(undefined, () => {
    assertThrows(() => expandHome("~/k.json"), Error, "HOME is not set");
    assertEquals(expandHome("/etc/k.json"), "/etc/k.json");
  });
});

Deno.test("readKeyJson reads a key file named with ~/", async () => {
  const home = await Deno.makeTempDir();
  try {
    await Deno.writeTextFile(`${home}/k.json`, '{"keyId":"1"}');
    await withHome(home, async () => {
      assertEquals(
        await readKeyJson({ apiUrl: "x", keyJsonFile: "~/k.json" }),
        '{"keyId":"1"}',
      );
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("readKeyJson names the path it was given when the file is missing", async () => {
  const home = await Deno.makeTempDir();
  try {
    await withHome(home, async () => {
      const error = await assertRejects(
        () =>
          readKeyJson({ apiUrl: "x", keyJsonFile: "~/does-not-exist.json" }),
        Error,
      );
      assert(
        error.message.includes("cannot read keyJsonFile ~/does-not-exist.json"),
        error.message,
      );
    });
  } finally {
    await Deno.remove(home, { recursive: true });
  }
});

Deno.test("readKeyJson refuses a vault value and a file together", async () => {
  await assertRejects(
    () => readKeyJson({ apiUrl: "x", keyJson: "{}", keyJsonFile: "~/k.json" }),
    Error,
    "not both",
  );
});

Deno.test("credentialKind names exactly one credential and what a system key needs", () => {
  assertEquals(credentialKind({ apiUrl: "x", keyJson: "{}" }), "keyJson");
  assertEquals(
    credentialKind({ apiUrl: "x", accessTokenFile: "~/t" }),
    "accessTokenFile",
  );
  assertEquals(
    credentialKind({ apiUrl: "x", systemKeyFile: "/k.pem", systemUser: "ops" }),
    "systemKeyFile",
  );
  assertThrows(
    () => credentialKind({ apiUrl: "x" }),
    Error,
    "no credential",
  );
  assertThrows(
    () =>
      credentialKind({ apiUrl: "x", keyJsonFile: "a", accessTokenFile: "b" }),
    Error,
    "not both keyJsonFile and accessTokenFile",
  );
  assertThrows(
    () => credentialKind({ apiUrl: "x", systemKeyFile: "/k.pem" }),
    Error,
    "needs systemUser",
  );
});

Deno.test("systemAssertionClaims makes the configured name issuer and subject, the instance the audience", () => {
  const claims = systemAssertionClaims(
    "operators",
    "https://id.example.org/",
    1000,
  );
  assertEquals(claims.iss, "operators");
  assertEquals(claims.sub, "operators");
  assertEquals(claims.aud, "https://id.example.org");
  assertEquals(claims.exp, 4600);
});

Deno.test("getToken sends a bearer from accessTokenFile as it is, trimmed, and refuses an empty file", async () => {
  const dir = await Deno.makeTempDir();
  const file = `${dir}/me.token`;
  await Deno.writeTextFile(file, "  token-as-written \n");
  try {
    assertEquals(
      await getToken({
        apiUrl: "https://id.example.org",
        accessTokenFile: file,
      }),
      "token-as-written",
    );
    await Deno.writeTextFile(file, "\n");
    await assertRejects(
      () =>
        getToken({ apiUrl: "https://id.example.org", accessTokenFile: file }),
      Error,
      "is empty",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("getToken signs a System API assertion with the key file and caches it", async () => {
  const pair = await crypto.subtle.generateKey(
    {
      name: "RSASSA-PKCS1-v1_5",
      modulusLength: 2048,
      publicExponent: new Uint8Array([1, 0, 1]),
      hash: "SHA-256",
    },
    true,
    ["sign", "verify"],
  );
  const pkcs8 = new Uint8Array(
    await crypto.subtle.exportKey("pkcs8", pair.privateKey),
  );
  let binary = "";
  for (const byte of pkcs8) binary += String.fromCharCode(byte);
  const pem = `-----BEGIN PRIVATE KEY-----\n${
    btoa(binary).match(/.{1,64}/g)!.join("\n")
  }\n-----END PRIVATE KEY-----\n`;
  const dir = await Deno.makeTempDir();
  const file = `${dir}/system.pem`;
  await Deno.writeTextFile(file, pem);
  const args = {
    apiUrl: "https://id.example.org",
    systemKeyFile: file,
    systemUser: "operators",
  };
  try {
    const token = await getToken(args);
    const [header, payload] = token.split(".");
    const decode = (s: string) =>
      JSON.parse(atob(s.replace(/-/g, "+").replace(/_/g, "/")));
    assertEquals(decode(header).alg, "RS256");
    assertEquals(decode(payload).sub, "operators");
    assertEquals(decode(payload).aud, "https://id.example.org");
    assertEquals(await getToken(args), token);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
