import { inRepo, resolvePaths } from "./gateway.ts";
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  __setFetch,
  type Endpoint,
  expectOk,
  joinUrl,
  parseError,
  parseKeyFile,
  readRootKey,
  S3Error,
  send,
  sign,
} from "./transport.ts";
import {
  fixture,
  globalArgs,
  installFetch,
  keyFile,
  ROOT_ACCESS,
  ROOT_SECRET,
} from "./test_support.ts";

const AWS_KEY = {
  access: "AKIAIOSFODNN7EXAMPLE",
  secret: "wJalrXUtnFEMI/K7MDENG/bPxRfiCYEXAMPLEKEY",
};
const EMPTY_SHA =
  "e3b0c44298fc1c149afbf4c8996fb92427ae41e4649b934ca495991b7852b855";

// The two GET examples in AWS's "Signature Calculations for the Authorization
// Header" for S3, which carry no header aws4fetch declines to sign.
for (
  const [url, signature] of [
    [
      "https://examplebucket.s3.amazonaws.com/?lifecycle",
      "fea454ca298b7da1c68078a5d1bdbfbbe0d65c699e0f91ac7a200a0136783543",
    ],
    [
      "https://examplebucket.s3.amazonaws.com/?max-keys=2&prefix=J",
      "34b48302e7b5fa45bde8084f4b7868a86f0a534bc59db6670ed5711ef69dc6f7",
    ],
  ]
) {
  Deno.test(`sign reproduces the AWS S3 vector for ${url}`, async () => {
    const request = new Request(url, {
      headers: { "x-amz-content-sha256": EMPTY_SHA },
    });
    const signed = await sign(
      request,
      AWS_KEY,
      "us-east-1",
      "20130524T000000Z",
    );
    assertEquals(
      signed.headers.get("authorization"),
      "AWS4-HMAC-SHA256 Credential=AKIAIOSFODNN7EXAMPLE/20130524/us-east-1/s3/aws4_request, " +
        `SignedHeaders=host;x-amz-content-sha256;x-amz-date, Signature=${signature}`,
    );
  });
}

Deno.test("sign always sends x-amz-content-sha256, which the admin API requires", async () => {
  const signed = await sign(
    new Request("http://127.0.0.1:7071/list-users", { method: "PATCH" }),
    { access: ROOT_ACCESS, secret: ROOT_SECRET },
    "us-east-1",
  );
  assertEquals(signed.headers.has("x-amz-content-sha256"), true);
  assertEquals(signed.headers.has("x-amz-date"), true);
});

Deno.test("parseError reports a wrong region as IncorrectRegion", () => {
  const error = parseError(
    fixture("admin-wrong-region"),
    "PATCH /list-users",
    "eu-north-1",
  );
  assertEquals(error.code, "IncorrectRegion");
  assertEquals(error.status, 400);
  assertStringIncludes(error.message, "expects region us-east-1");
  assertStringIncludes(error.message, "signs with eu-north-1");
});

Deno.test("parseError keeps the gateway's code and message", () => {
  for (
    const [name, code] of [
      ["admin-unsigned", "AccessDenied"],
      ["admin-wrong-secret", "SignatureDoesNotMatch"],
      ["admin-unknown-key", "InvalidAccessKeyId"],
      ["admin-not-admin", "XAdminAccessDenied"],
      ["bucket-missing-versioning", "NoSuchBucket"],
    ]
  ) {
    const error = parseError(fixture(name), "call", "us-east-1");
    assertEquals(error.code, code, name);
    assertEquals(
      error.message.includes("<"),
      false,
      `${name}: no XML in the message`,
    );
  }
});

Deno.test("parseError leaves a body that is not XML as the message", () => {
  const error = parseError(
    { status: 502, contentType: "text/plain", body: "bad gateway" },
    "GET /x",
    "us-east-1",
  );
  assertEquals(error.code, "HTTP502");
  assertEquals(error.message, "GET /x: HTTP 502 HTTP502: bad gateway");
});

Deno.test("expectOk masks the key pair in the error it throws", () => {
  const g = globalArgs();
  const body =
    `<Error><Code>X</Code><Message>${ROOT_ACCESS} ${ROOT_SECRET}</Message></Error>`;
  const error = assertThrows(
    () =>
      expectOk({ status: 403, contentType: "", body }, "call", g, {
        access: ROOT_ACCESS,
        secret: ROOT_SECRET,
      }),
    S3Error,
  );
  assertEquals(error.message.includes(ROOT_SECRET), false);
  assertEquals(error.message.includes(ROOT_ACCESS), false);
});

Deno.test("parseKeyFile reads the dotenv subset a shell writes", () => {
  const values = parseKeyFile(
    "# c\n\nexport A=1\nB='two words'\nC=\"3\"\n not a line\nD=x=y\n",
  );
  assertEquals(Object.fromEntries(values), {
    A: "1",
    B: "two words",
    C: "3",
    D: "x=y",
  });
});

Deno.test("readRootKey reads the named file", () => {
  const file = keyFile();
  try {
    assertEquals(readRootKey(globalArgs({ rootKeyFile: file.path })), {
      access: ROOT_ACCESS,
      secret: ROOT_SECRET,
    });
  } finally {
    file.cleanup();
  }
});

Deno.test("readRootKey reads the environment under the names given", () => {
  Deno.env.set("VGW_TEST_A", ROOT_ACCESS);
  Deno.env.set("VGW_TEST_S", ROOT_SECRET);
  try {
    const key = readRootKey(
      globalArgs({
        rootKeyEnv: true,
        accessKeyName: "VGW_TEST_A",
        secretKeyName: "VGW_TEST_S",
      }),
    );
    assertEquals(key.secret, ROOT_SECRET);
  } finally {
    Deno.env.delete("VGW_TEST_A");
    Deno.env.delete("VGW_TEST_S");
  }
});

Deno.test("readRootKey refuses no source, two sources, and a missing variable", () => {
  const file = keyFile();
  try {
    assertThrows(() => readRootKey(globalArgs()), Error, "no root key source");
    assertThrows(
      () =>
        readRootKey(globalArgs({ rootKeyFile: file.path, rootKeyEnv: true })),
      Error,
      "give one root key source, not rootKeyFile and rootKeyEnv",
    );
    const error = assertThrows(
      () =>
        readRootKey(
          globalArgs({ rootKeyFile: file.path, secretKeyName: "NOPE" }),
        ),
      Error,
      "NOPE is not set",
    );
    assertEquals(error.message.includes(ROOT_SECRET), false);
    assertThrows(
      () => readRootKey(globalArgs({ rootKeyFile: `${file.path}.missing` })),
      Error,
      "does not exist",
    );
  } finally {
    file.cleanup();
  }
});

Deno.test("joinUrl keeps a path prefix on the base URL", () => {
  assertEquals(
    joinUrl("http://h:7071/admin/", "/list-users"),
    "http://h:7071/admin/list-users",
  );
  assertEquals(joinUrl("http://h", "/b", "acl"), "http://h/b?acl");
});

Deno.test("send signs admin calls and not the health check", async () => {
  const fake = installFetch();
  const g: Endpoint = globalArgs();
  const key = { access: ROOT_ACCESS, secret: ROOT_SECRET };
  try {
    await send(g, key, { api: "admin", method: "PATCH", path: "/list-users" });
    await send(g, undefined, {
      api: "s3",
      method: "GET",
      path: "/health",
      unsigned: true,
    });
    assertEquals(fake.seen, [
      { line: "PATCH /list-users", signed: true },
      { line: "GET /health", signed: false },
    ]);
  } finally {
    fake.restore();
  }
});

Deno.test("send masks the key pair in a transport failure", async () => {
  __setFetch(() =>
    Promise.reject(new Error(`refused for ${ROOT_ACCESS}:${ROOT_SECRET}`))
  );
  try {
    const error = await assertRejects(() =>
      send(globalArgs(), { access: ROOT_ACCESS, secret: ROOT_SECRET }, {
        api: "admin",
        method: "PATCH",
        path: "/list-users",
      })
    );
    assertEquals((error as Error).message.includes(ROOT_SECRET), false);
    assertStringIncludes((error as Error).message, "[REDACTED]");
  } finally {
    __setFetch();
  }
});

Deno.test("readRootKey takes the pair as values, and only as a whole pair", () => {
  assertEquals(
    readRootKey(
      globalArgs({ rootAccessKey: ROOT_ACCESS, rootSecretKey: ROOT_SECRET }),
    ),
    { access: ROOT_ACCESS, secret: ROOT_SECRET },
  );
  const half = assertThrows(
    () => readRootKey(globalArgs({ rootAccessKey: ROOT_ACCESS })),
    Error,
    "rootAccessKey is set but rootSecretKey is not",
  );
  assertEquals(half.message.includes(ROOT_ACCESS), false);
  assertThrows(
    () => readRootKey(globalArgs({ rootSecretKey: ROOT_SECRET })),
    Error,
    "rootSecretKey is set but rootAccessKey is not",
  );
  const both = assertThrows(
    () =>
      readRootKey(
        globalArgs({
          rootKeyEnv: true,
          rootAccessKey: ROOT_ACCESS,
          rootSecretKey: ROOT_SECRET,
        }),
      ),
    Error,
    "not rootKeyEnv and rootAccessKey and rootSecretKey",
  );
  assertEquals(both.message.includes(ROOT_SECRET), false);
});

Deno.test("a value with whitespace or an empty value is refused by name, never by value", () => {
  const newline = assertThrows(
    () =>
      readRootKey(
        globalArgs({
          rootAccessKey: `${ROOT_ACCESS}\n`,
          rootSecretKey: ROOT_SECRET,
        }),
      ),
    Error,
    "rootAccessKey contains whitespace",
  );
  assertEquals(newline.message.includes(ROOT_ACCESS), false);
  assertThrows(
    () =>
      readRootKey(
        globalArgs({ rootAccessKey: "", rootSecretKey: ROOT_SECRET }),
      ),
    Error,
    "rootAccessKey is empty",
  );
  assertThrows(
    () =>
      readRootKey(
        globalArgs({ rootKeyEnv: true, rootAccessKey: "", rootSecretKey: "" }),
      ),
    Error,
    "give one root key source",
  );
});

Deno.test("a key the signer rejects is masked in the error", async () => {
  // The file source is not checked for whitespace; the signer's own error,
  // which quotes the header it built, must still come out masked.
  __setFetch(() => Promise.reject(new Error("not reached")));
  try {
    const key = { access: `${ROOT_ACCESS}\u0000`, secret: ROOT_SECRET };
    const error = await assertRejects(() =>
      send(globalArgs(), key, {
        api: "admin",
        method: "PATCH",
        path: "/list-buckets",
      })
    );
    const message = (error as Error).message;
    assertEquals(message.includes(ROOT_ACCESS), false, message);
    assertEquals(message.includes(ROOT_SECRET), false, message);
  } finally {
    __setFetch();
  }
});

Deno.test("inRepo takes a relative path from the repository and leaves the rest", () => {
  assertEquals(inRepo("certs/ca.crt", "/srv/repo"), "/srv/repo/certs/ca.crt");
  assertEquals(inRepo("certs/ca.crt", "/srv/repo/"), "/srv/repo/certs/ca.crt");
  assertEquals(inRepo("/etc/ca.crt", "/srv/repo"), "/etc/ca.crt");
  assertEquals(inRepo("~/ca.crt", "/srv/repo"), "~/ca.crt");
  assertEquals(inRepo("certs/ca.crt", undefined), "certs/ca.crt");
  assertEquals(inRepo(undefined, "/srv/repo"), undefined);
  assertEquals(
    resolvePaths({ caFile: "a.crt", rootKeyFile: "k.env", other: 1 }, "/r"),
    { caFile: "/r/a.crt", rootKeyFile: "/r/k.env", other: 1 },
  );
});
