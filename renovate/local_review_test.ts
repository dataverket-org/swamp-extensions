/**
 * Tests that pin what the independent review of 2026.11.10.1 found: data
 * names swamp refuses, host files that are not files, proxy settings that
 * reach the container, a repository where nothing was looked up, a
 * configuration Renovate did not read, the engine's own time limit, log
 * lines lost to the cap, and one directory under two names.
 */
import { assert, assertEquals, assertThrows } from "jsr:@std/assert@1.0.13";
import { isCliError, runCli } from "../lib/cli.ts";
import { HOSTILE } from "../lib/test_inputs.ts";
import {
  CONFIG_FILES,
  configFile,
  dataName,
  GlobalArgsSchema,
  INVENTORY_NAME,
  outcome,
  proxySecrets,
  targets,
} from "./local.ts";
import {
  CONFIG_LINES,
  configLines,
  dep,
  IMAGE,
  repository,
  storable,
  withDisk,
} from "./test_support.ts";

/** `work`, or a failure after `ms`: a read that never ends fails the test. */
function within<T>(ms: number, work: Promise<T>): Promise<T> {
  let timer: ReturnType<typeof setTimeout>;
  return Promise.race([
    work,
    new Promise<T>((_, reject) => {
      timer = setTimeout(() => reject(new Error(`not done in ${ms} ms`)), ms);
    }),
  ]).finally(() => clearTimeout(timer));
}

// ---------------------------------------------------------------------------
// B1: data names swamp stores
// ---------------------------------------------------------------------------

Deno.test("every data name is one swamp stores: no .., no slash, no backslash, no null byte", () => {
  const paths = [
    "..",
    "../x",
    "../../x",
    "deep/er/../../fix/empty",
    "fix/my..repo",
    "...",
    "....",
    "a..",
    "a...b",
    ".a..b.",
    "a.b",
    "a/./b",
    "a\\b",
    "a\\..\\b",
    "..a",
    "a._2e",
    "a.",
    "/..",
    ...HOSTILE.filter((h) => h !== "" && !/[\0\r\n]/.test(h) && h.length < 80),
  ];
  const names = paths.map(dataName);
  for (const [i, n] of names.entries()) {
    assert(storable(n), `${paths[i]} -> ${n}`);
    assert(/^[A-Za-z0-9._-]+$/.test(n), n);
  }
  // Still one name per path.
  assertEquals(new Set(names).size, new Set(paths).size);
  assertEquals(dataName("fix/my..repo"), "repo-fix_2fmy._2erepo");
  assertEquals(dataName("../x"), "repo-_2e._2fx");
  assertEquals(dataName(".."), "repo-_2e.");
  assertEquals(dataName("..."), "repo-_2e._2e");
  assertEquals(dataName("a.b.c"), "repo-a.b.c");
});

Deno.test("targets holds every name to swamp's rule before anything starts", () => {
  for (
    const t of targets({ repos: ["..", "a/../b", "x..y", "a\\b"] }, "/r/s")
  ) {
    assert(storable(t.dataName), t.dataName);
  }
});

// ---------------------------------------------------------------------------
// B2: host files that are not files
// ---------------------------------------------------------------------------

Deno.test("a configuration name that is a symlink, a directory or a device is not a configuration, and is never read", async () => {
  await withDisk(async (disk) => {
    const names = ["renovate.json", ".renovaterc", "package.json"];
    for (const name of names) {
      const zero = await disk.repo(`zero-${name}`, {});
      await Deno.symlink("/dev/zero", `${zero}/${name}`);
      assertEquals(await within(2000, configFile(zero)), null, name);

      const real = await disk.repo(`link-${name}`, {
        "elsewhere": '{"renovate":{}}',
      });
      await Deno.symlink(`${real}/elsewhere`, `${real}/${name}`);
      assertEquals(await within(2000, configFile(real)), null, name);

      const dir = await disk.repo(`dir-${name}`, {});
      await Deno.mkdir(`${dir}/${name}`);
      assertEquals(await within(2000, configFile(dir)), null, name);
    }
  });
});

Deno.test("a FIFO in a configuration's place does not hold the method", async () => {
  await withDisk(async (disk) => {
    for (const name of ["renovate.json", "package.json"]) {
      const dir = await disk.repo(`fifo-${name}`, {});
      try {
        await runCli("mkfifo", [`${dir}/${name}`], { timeoutMs: 5000 });
      } catch (err) {
        if (isCliError(err, "not-installed")) return;
        throw err;
      }
      assertEquals(await within(2000, configFile(dir)), null, name);
    }
  });
});

Deno.test("package.json is read to its bound and no further", async () => {
  await withDisk(async (disk) => {
    const pad = " ".repeat(1024 * 1024);
    const big = await disk.repo("big", {
      "package.json": `{"renovate":{},"pad":"${pad}"}`,
    });
    assertEquals(await configFile(big), null);
    const fits = await disk.repo("fits", {
      "package.json": `{"renovate":{},"pad":"${pad.slice(0, 1000)}"}`,
    });
    assertEquals(await configFile(fits), "package.json");
  });
});

const PROXY_VARS = [
  "http_proxy",
  "https_proxy",
  "ftp_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "FTP_PROXY",
  "NO_PROXY",
];

async function withEnv<T>(
  set: Record<string, string>,
  body: () => Promise<T>,
): Promise<T> {
  const before = PROXY_VARS.map((n) => Deno.env.get(n));
  for (const n of PROXY_VARS) Deno.env.delete(n);
  for (const [n, v] of Object.entries(set)) Deno.env.set(n, v);
  try {
    return await body();
  } finally {
    PROXY_VARS.forEach((n, i) =>
      before[i] === undefined ? Deno.env.delete(n) : Deno.env.set(n, before[i]!)
    );
  }
}

Deno.test("proxySecrets: the password of every proxy URL, as written and decoded", async () => {
  await withEnv({
    HTTPS_PROXY: "http://alice:s3cr%40t-pw@proxy.example:3128",
    http_proxy: "http://bob:other-pw@proxy.example:3128/",
    NO_PROXY: "localhost,.example",
    ftp_proxy: "not a url",
    FTP_PROXY: "http://carol@proxy.example:3128",
  }, () => {
    const secrets = proxySecrets();
    for (
      const s of ["s3cr%40t-pw", "s3cr@t-pw", "alice:s3cr%40t-pw", "other-pw"]
    ) assert(secrets.includes(s), s);
    assert(!secrets.includes("alice"));
    // A user without a password is no secret.
    assert(!secrets.some((s) => s.includes("carol")), secrets.join());
    assert(!secrets.includes("localhost,.example"));
    return Promise.resolve();
  });
  await withEnv({}, () => {
    assertEquals(proxySecrets(), []);
    return Promise.resolve();
  });
});

// ---------------------------------------------------------------------------
// Second review
// ---------------------------------------------------------------------------

Deno.test("the captured lines are what Renovate really logs: every form is captured, and package.json has no Repository config line", () => {
  assertEquals(
    Object.keys(CONFIG_LINES.forms).sort(),
    [...CONFIG_FILES, "package.json"].sort(),
  );
  for (const name of CONFIG_FILES) {
    const lines = configLines(name);
    assert(
      lines.some((l) => l.msg === "Repository config" && l.fileName === name),
      name,
    );
  }
  const pkg = configLines("package.json");
  assert(!pkg.some((l) => l.msg === "Repository config"));
  assert(!pkg.some((l) => "fileName" in l));
  assert(pkg.some((l) => l.msg === "package.json>renovate config"));
  assert(
    !configLines(null).some((l) =>
      /^Found .* config file$/.test(String(l.msg))
    ),
  );
});

Deno.test("each of Renovate's lines about the configuration is enough by itself", () => {
  const read = (lines: Array<Record<string, unknown>>) =>
    outcome({
      success: true,
      code: 0,
      stdout: [
        ...lines,
        { msg: "Repository finished", level: 30 },
        {
          msg: "Printing report",
          level: 30,
          report: { repositories: { local: repository([dep()]) } },
        },
      ].map((l) => JSON.stringify(l)).join("\n"),
      stdoutBytes: new Uint8Array(),
      stderr: "",
      timedOut: false,
      cancelled: false,
    }, 300).configRead;
  assertEquals(
    read([{ msg: "Repository config", fileName: ".renovaterc" }]),
    ".renovaterc",
  );
  assertEquals(
    read([{ msg: "Found .github/renovate.json5 config file" }]),
    ".github/renovate.json5",
  );
  assertEquals(read([{ msg: "package.json>renovate config" }]), "package.json");
  assertEquals(
    read([{ msg: "Found package.json config file" }]),
    "package.json",
  );
  // Lines that say the opposite, or nothing.
  for (
    const msg of [
      "No config file found on disk - skipping",
      "config file not found",
      "No renovate config file found",
      "Config file exists, fileName: renovate.json",
      "Found no closed onboarding PR",
      "Repository config",
    ]
  ) assertEquals(read([{ msg }]), null, msg);
  assertEquals(read([{ msg: "Repository config", fileName: 7 }]), null);
  // A file name on another line is not the configuration.
  assertEquals(read([{ msg: "Reading file", fileName: "x.json" }]), null);
});

Deno.test("network: none or a plain network name; every form that widens what the container reaches is refused", () => {
  for (const network of ["none", "renovate-egress", "my_net.1"]) {
    assertEquals(
      GlobalArgsSchema.parse({ image: IMAGE, network }).network,
      network,
    );
  }
  for (
    const network of [
      "host",
      "Host",
      "container:other",
      "container",
      "ns:/proc/1/ns/net",
      "ns",
      "private",
      "bridge",
      "default",
      "slirp4netns",
      "slirp4netns:allow_host_loopback=true",
      "slirp4netns:cidr=10.9.0.0/24",
      "pasta",
      "pasta:--map-gw",
      "pasta:-T,8080",
      "mynet:ip=10.0.0.5",
      "a,b",
      "a/b",
      "a=b",
    ]
  ) {
    assertThrows(
      () => GlobalArgsSchema.parse({ image: IMAGE, network }),
      Error,
      undefined,
      network,
    );
  }
});

Deno.test("a repository record's name starts with repo-, so no path is stored as one of swamp's own records or as the inventory", () => {
  for (
    const path of [
      "report-swamp-method-summary",
      "report-swamp-method-summary-json",
      "inventory_all",
      "inventory-all",
      "a",
      "..",
      "/",
    ]
  ) {
    const name = dataName(path);
    assert(name.startsWith("repo-"), name);
    assert(storable(name), name);
    assert(name !== INVENTORY_NAME && !name.startsWith("report-"), name);
  }
  assertEquals(
    dataName("report-swamp-method-summary"),
    "repo-report-swamp-method-summary",
  );
  assertEquals(dataName("apps/web"), "repo-apps_2fweb");
  assert(!INVENTORY_NAME.startsWith("repo-"));
});
