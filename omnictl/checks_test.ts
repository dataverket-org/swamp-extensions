import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { checks, explainAuthFailure } from "./checks.ts";
import type { GlobalArgsData } from "./common.ts";
import { model as clusterModel } from "./cluster.ts";
import { model as inventoryModel } from "./inventory.ts";

const KEY = "s3cret-key-material";

const base: GlobalArgsData = {
  endpoint: "https://omni.example.net",
  insecureSkipTlsVerify: false,
  omnictlPath: "omnictl",
};

const EXPIRED_STDERR =
  "Error: failed to sign message: gopenpgp: error in signing: openpgp: invalid argument: no valid signing keys";

/** Runs `body` with a key file in a temporary directory, then removes it. */
async function withKeyFile(
  content: string,
  body: (path: string) => Promise<void>,
): Promise<void> {
  const dir = await Deno.makeTempDir({ prefix: "omnictl-check-" });
  const path = `${dir}/operator.key`;
  try {
    await Deno.writeTextFile(path, content);
    await body(path);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}

const run = (name: keyof typeof checks, globalArgs: GlobalArgsData) =>
  checks[name].execute({ globalArgs });

Deno.test("both models carry the two pre-flight checks", () => {
  for (const m of [clusterModel, inventoryModel]) {
    assertEquals(Object.keys(m.checks).sort(), [
      "omni-authenticates",
      "service-account-key",
    ]);
  }
  assertEquals(checks["service-account-key"].labels, ["policy"]);
  assertEquals(checks["omni-authenticates"].labels, ["live"]);
});

Deno.test("service-account-key passes for a value and for a readable key file", async () => {
  assertEquals(
    await run("service-account-key", { ...base, serviceAccountKey: KEY }),
    { pass: true },
  );
  await withKeyFile(`${KEY}\n`, async (path) => {
    assertEquals(
      await run("service-account-key", {
        ...base,
        serviceAccountKeyFile: path,
      }),
      { pass: true },
    );
  });
});

Deno.test("service-account-key fails, naming the problem and never the key", async () => {
  const cases: [string, GlobalArgsData, string][] = [
    ["neither", base, "set serviceAccountKeyFile or serviceAccountKey"],
    [
      "both",
      {
        ...base,
        serviceAccountKey: KEY,
        serviceAccountKeyFile: "/nonexistent/operator.key",
      },
      "not both",
    ],
    [
      "missing file",
      { ...base, serviceAccountKeyFile: "/nonexistent/operator.key" },
      "/nonexistent/operator.key",
    ],
    [
      "plain http",
      { ...base, endpoint: "http://omni.example.net", serviceAccountKey: KEY },
      "endpoint",
    ],
  ];
  for (const [name, g, expected] of cases) {
    const r = await run("service-account-key", g);
    assertEquals(r.pass, false, name);
    assertEquals(r.errors?.length, 1, name);
    assert(r.errors![0].includes(expected), `${name}: ${r.errors![0]}`);
    assert(!r.errors![0].includes(KEY), `${name}: the key leaked`);
  }
  await withKeyFile("", async (path) => {
    const r = await run("service-account-key", {
      ...base,
      serviceAccountKeyFile: path,
    });
    assertEquals(r.pass, false, "empty file");
    assert(r.errors![0].includes(path), r.errors![0]);
  });
});

Deno.test("explainAuthFailure names the argument when the key is a value", () => {
  const e = explainAuthFailure(EXPIRED_STDERR, {
    ...base,
    serviceAccountKey: KEY,
  });
  assert(e.startsWith("the key in serviceAccountKey has expired"), e);
  assertEquals(
    explainAuthFailure("connection refused", base),
    "connection refused",
  );
});
