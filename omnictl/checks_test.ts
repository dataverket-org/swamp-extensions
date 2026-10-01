import { assert, assertEquals } from "jsr:@std/assert@1.0.13";
import { checks, explainAuthFailure, PROBE_TYPE } from "./checks.ts";
import type { GlobalArgsData } from "./common.ts";
import { model as clusterModel } from "./cluster.ts";
import { model as inventoryModel } from "./inventory.ts";
import { __setRunner, type RunResult } from "./omnictl.ts";

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

/** A runner that answers the probe read and fails the test on anything else. */
function strictRunner(probe: RunResult, calls: string[][]) {
  return (argv: string[]) => {
    calls.push(argv);
    if (
      argv.length === 5 && argv[1] === "get" && argv[2] === PROBE_TYPE &&
      argv[3] === "-o" && argv[4] === "json"
    ) {
      return Promise.resolve(probe);
    }
    throw new Error(`unexpected omnictl call: ${argv.join(" ")}`);
  };
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

Deno.test("omni-authenticates passes on one probe read", async () => {
  const calls: string[][] = [];
  __setRunner(strictRunner({ code: 0, stdout: "", stderr: "" }, calls));
  try {
    assertEquals(
      await run("omni-authenticates", { ...base, serviceAccountKey: KEY }),
      { pass: true },
    );
    assertEquals(calls.length, 1);
  } finally {
    __setRunner();
  }
});

Deno.test("omni-authenticates says an expired key file has expired, naming the file and not the key", async () => {
  await withKeyFile(`${KEY}\n`, async (path) => {
    const calls: string[][] = [];
    __setRunner(
      strictRunner({ code: 1, stdout: "", stderr: EXPIRED_STDERR }, calls),
    );
    try {
      const r = await run("omni-authenticates", {
        ...base,
        serviceAccountKeyFile: path,
      });
      assertEquals(r.pass, false);
      const e = r.errors![0];
      assert(e.startsWith(`the key in ${path} has expired`), e);
      assert(e.includes("mint a new service account key"), e);
      assert(e.includes("no valid signing keys"), e);
      assert(!e.includes(KEY), "the key leaked");
    } finally {
      __setRunner();
    }
  });
});

Deno.test("omni-authenticates passes other failures through with the key redacted", async () => {
  const calls: string[][] = [];
  __setRunner(
    strictRunner({
      code: 1,
      stdout: "",
      stderr: `PermissionDenied: rejected key ${KEY}`,
    }, calls),
  );
  try {
    const r = await run("omni-authenticates", {
      ...base,
      serviceAccountKey: KEY,
    });
    assertEquals(r.pass, false);
    const e = r.errors![0];
    assert(e.includes("PermissionDenied"), e);
    assert(!e.includes("expired"), e);
    assert(!e.includes(KEY), "the key leaked");
  } finally {
    __setRunner();
  }
});

Deno.test("omni-authenticates makes no omnictl call when the key does not resolve", async () => {
  const calls: string[][] = [];
  __setRunner(strictRunner({ code: 0, stdout: "", stderr: "" }, calls));
  try {
    const r = await run("omni-authenticates", {
      ...base,
      serviceAccountKeyFile: "/nonexistent/operator.key",
    });
    assertEquals(r.pass, false);
    assert(r.errors![0].includes("/nonexistent/operator.key"), r.errors![0]);
    assertEquals(calls.length, 0);
  } finally {
    __setRunner();
  }
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
