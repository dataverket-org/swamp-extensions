import { assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import { type GlobalArgsData, resolveServiceAccountKey } from "./common.ts";

const base: GlobalArgsData = {
  endpoint: "https://omni.example.net",
  insecureSkipTlsVerify: false,
  omnictlPath: "omnictl",
};

/** Runs `body` with a key file in a temporary directory, then removes it. */
async function withKeyFile(
  content: string,
  body: (path: string) => void,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "omnictl-key-" });
  const path = `${dir}/reader.key`;
  try {
    await Deno.writeTextFile(path, content);
    body(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

Deno.test("the key comes from the file a definition names", async () => {
  await withKeyFile("base64-key-material\n", (path) => {
    assertEquals(
      resolveServiceAccountKey({ ...base, serviceAccountKeyFile: path }),
      "base64-key-material",
    );
  });
});

Deno.test("a leading ~/ in the file path expands from HOME", async () => {
  await withKeyFile("from-home\n", (path) => {
    const home = path.slice(0, path.lastIndexOf("/"));
    const previous = Deno.env.get("HOME");
    Deno.env.set("HOME", home);
    try {
      assertEquals(
        resolveServiceAccountKey({
          ...base,
          serviceAccountKeyFile: "~/reader.key",
        }),
        "from-home",
      );
    } finally {
      if (previous === undefined) Deno.env.delete("HOME");
      else Deno.env.set("HOME", previous);
    }
  });
});

Deno.test("the key as a value still works", () => {
  assertEquals(
    resolveServiceAccountKey({ ...base, serviceAccountKey: "inline-key" }),
    "inline-key",
  );
});

Deno.test("both at once is an error, not a precedence rule", async () => {
  await withKeyFile("from-file", (path) => {
    assertThrows(
      () =>
        resolveServiceAccountKey({
          ...base,
          serviceAccountKeyFile: path,
          serviceAccountKey: "inline-key",
        }),
      Error,
      "not both",
    );
  });
});

Deno.test("neither is an error naming both forms", () => {
  assertThrows(
    () => resolveServiceAccountKey(base),
    Error,
    "set serviceAccountKeyFile or serviceAccountKey",
  );
});

Deno.test("a missing key file fails with the path and not a blank key", () => {
  assertThrows(
    () =>
      resolveServiceAccountKey({
        ...base,
        serviceAccountKeyFile: "/nonexistent/reader.key",
      }),
    Error,
    "/nonexistent/reader.key does not exist",
  );
});

Deno.test("an empty key file is an error, not an empty credential", async () => {
  await withKeyFile("\n", (path) => {
    assertThrows(
      () => resolveServiceAccountKey({ ...base, serviceAccountKeyFile: path }),
      Error,
      "is empty",
    );
  });
});
