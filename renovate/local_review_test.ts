/**
 * Tests that pin what the independent review of 2026.11.10.1 found: data
 * names swamp refuses, host files that are not files, proxy settings that
 * reach the container, a repository where nothing was looked up, a
 * configuration Renovate did not read, the engine's own time limit, log
 * lines lost to the cap, and one directory under two names.
 */
import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { isCliError, runCli } from "../lib/cli.ts";
import { type Answer, HOSTILE } from "../lib/cli_fake.ts";
import {
  CONFIG_FILES,
  configFile,
  dataName,
  GlobalArgsSchema,
  INVENTORY_NAME,
  MAX_LOG_LINES,
  model,
  outcome,
  proxySecrets,
  targets,
} from "./local.ts";
import {
  CONFIG_LINES,
  configLines,
  dep,
  globalArgs,
  IMAGE,
  type Kept,
  kept,
  type Machine,
  output,
  PLANTED,
  repository,
  storable,
  update,
  warning,
  withDisk,
  withEngine,
} from "./test_support.ts";

const lookup = model.methods.lookup.execute;
const FRESH = output(repository([dep()]));

async function one(
  answer: Answer,
  check: (
    r: Record<string, unknown>,
    k: Kept,
    m: Machine,
  ) => void | Promise<void>,
  g = globalArgs(),
  world: Record<string, unknown> = {},
): Promise<void> {
  await withDisk(async (disk) => {
    const dir = await disk.repo("a");
    const k = kept(disk.root, g);
    await withEngine({ ...world, runs: { [dir]: answer } }, g, async (m) => {
      await lookup({ repo: "a" }, k.ctx);
      await check(k.record("repo-a"), k, m);
    });
  });
}

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

Deno.test("a path with .. is looked up and its record is stored", async () => {
  await withDisk(async (disk) => {
    const empty = await disk.repo("fix/empty");
    const dots = await disk.repo("fix/my..repo");
    await Deno.mkdir(`${disk.root}/deep/er`, { recursive: true });
    const k = kept(`${disk.root}/deep`);
    await withEngine(
      { runs: { [empty]: { out: FRESH }, [dots]: { out: FRESH } } },
      k.ctx.globalArgs,
      async () => {
        const res = await lookup({
          repos: ["er/../../fix/empty", "../fix/my..repo"],
        }, k.ctx);
        assertEquals(res.dataHandles.length, 3);
      },
    );
    assertEquals(k.written.map((w) => w.name), [
      "repo-er_2f._2e_2f._2e_2ffix_2fempty",
      "repo-_2e._2ffix_2fmy._2erepo",
      INVENTORY_NAME,
    ]);
    assertEquals(k.record("repo-_2e._2ffix_2fmy._2erepo").directory, dots);
  });
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

Deno.test("a repository whose configuration is a symlink to a device is recorded, not hung", async () => {
  await withDisk(async (disk) => {
    const dir = await disk.repo("a", {});
    await Deno.symlink("/dev/zero", `${dir}/package.json`);
    const k = kept(disk.root);
    await withEngine({}, k.ctx.globalArgs, async (m) => {
      await within(3000, lookup({ repo: "a" }, k.ctx));
      assertEquals(m.runs, []);
    });
    assertEquals(k.record("repo-a").status, "no-config");
  });
});

// ---------------------------------------------------------------------------
// B3: proxy settings
// ---------------------------------------------------------------------------

Deno.test("Podman is told not to pass the host's proxy settings, unless passProxy", async () => {
  await one({ out: FRESH }, (_r, _k, m) => {
    assertEquals(m.runs[0].httpProxy, "false");
  });
  await one({ out: FRESH }, (_r, _k, m) => {
    assertEquals(m.runs[0].httpProxy, "true");
  }, globalArgs({ passProxy: true }));
  // Docker has no such flag.
  for (const passProxy of [false, true]) {
    await one(
      { out: FRESH },
      (_r, _k, m) => {
        assertEquals(m.runs[0].httpProxy, undefined);
        assertEquals(m.runs[0].timeout, undefined);
      },
      globalArgs({ passProxy }),
      { version: "Docker version 27.3.1, build ce12230\n" },
    );
  }
  assertEquals(GlobalArgsSchema.parse({ image: IMAGE }).passProxy, false);
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

Deno.test("with passProxy, the proxy's password is blanked wherever Renovate or the engine repeats it", async () => {
  await withEnv(
    { HTTPS_PROXY: `http://alice:${PLANTED}@proxy.example:3128` },
    async () => {
      const g = globalArgs({ passProxy: true });
      // Not in a shape lib's patterns would catch by themselves.
      const said = `proxy refused the login of alice with ${PLANTED} today`;
      await one({
        out: output(
          repository([
            dep({
              depName: said,
              updates: [update({ newValue: said })],
              warnings: [{ message: said }],
            }),
          ], { problems: [{ level: 50, msg: said, proxy: said }] }),
          { extra: [warning(said, { proxy: said })] },
        ),
      }, (r, k) => {
        assertEquals(r.updateCount, 1);
        assert(!k.everything().includes(PLANTED), k.everything());
      }, g);
      await one({ code: 1, fail: said }, (r, k) => {
        assertEquals(r.failure, "exit");
        assert(!k.everything().includes(PLANTED), k.everything());
      }, g);
      await one({
        out: output(repository([dep()]), {
          result: "external-host-error",
          extra: [warning(said)],
        }),
      }, (r, k) => {
        assertEquals(r.failure, "result");
        assert(!k.everything().includes(PLANTED), k.everything());
      }, g);
    },
  );
});

// ---------------------------------------------------------------------------
// 4: nothing was looked up
// ---------------------------------------------------------------------------

Deno.test("a repository where nothing was looked up is not ok and never up to date", async () => {
  const cases: Array<[string, Record<string, unknown>, number, number]> = [
    ["no package file", repository([], { packageFiles: {} }), 0, 0],
    ["a file without dependencies", repository([]), 1, 0],
    [
      "every dependency disabled",
      repository([
        dep({ skipReason: "disabled" }),
        dep({ depName: "b", skipReason: "disabled" }),
      ]),
      1,
      2,
    ],
    [
      "every lookup failed",
      repository([dep({ warnings: [{ message: "Failed to look up" }] })]),
      1,
      1,
    ],
  ];
  for (const [name, repo, files, deps] of cases) {
    await withDisk(async (disk) => {
      const dir = await disk.repo("a");
      const k = kept(disk.root);
      await withEngine(
        { runs: { [dir]: { out: output(repo) } } },
        k.ctx.globalArgs,
        async () => {
          await lookup({ repo: "a" }, k.ctx);
        },
      );
      const r = k.record("repo-a");
      assertEquals(r.status, "nothing-looked-up", name);
      assertEquals(
        [r.ok, r.lookupComplete, r.upToDate],
        [false, false, false],
        name,
      );
      assertEquals(r.failure, null, name);
      assertEquals(r.lookedUpCount, 0, name);
      assertEquals(r.packageFileCount, files, name);
      assertEquals(r.dependencyCount, deps, name);
      assertStringIncludes(String(r.reason), "looked up none", name);
      const inv = k.record(INVENTORY_NAME);
      assertEquals(inv.nothingLookedUpCount, 1, name);
      assertEquals([inv.okCount, inv.upToDateCount, inv.failedCount], [
        0,
        0,
        0,
      ]);
      const item = (inv.items as Array<Record<string, unknown>>)[0];
      assertEquals(item.lookedUpCount, 0, name);
      assertEquals(item.status, "nothing-looked-up", name);
    });
  }
});

Deno.test("lookedUpCount counts the dependencies Renovate really looked up", async () => {
  await one({
    out: output({
      problems: [],
      packageFiles: {
        dockerfile: [
          { packageFile: "Dockerfile", deps: [dep(), dep({ depName: "b" })] },
          {
            packageFile: "sub/Dockerfile",
            deps: [dep({ skipReason: "disabled" })],
          },
        ],
        npm: [{
          packageFile: "package.json",
          deps: [dep({ warnings: [{ message: "x" }] }), { depName: "bare" }],
        }],
      },
    }),
  }, (r, k) => {
    assertEquals(r.status, "ok");
    assertEquals(r.packageFileCount, 3);
    assertEquals(r.dependencyCount, 5);
    assertEquals(r.lookedUpCount, 2);
    const item = (k.record(INVENTORY_NAME).items as Array<
      Record<string, unknown>
    >)[0];
    assertEquals(item.lookedUpCount, 2);
  });
});

// ---------------------------------------------------------------------------
// 5: a configuration Renovate did not read
// ---------------------------------------------------------------------------

Deno.test("a configuration file Renovate did not read is its own status, with what Renovate proposed on its defaults", async () => {
  await one({
    out: output(repository([dep({ updates: [update()] })]), { config: null }),
  }, (r, k) => {
    assertEquals(r.status, "config-not-read");
    assertEquals([r.ok, r.lookupComplete, r.upToDate], [false, false, false]);
    assertEquals(r.failure, null);
    assertEquals(r.configFile, "renovate.json");
    assertEquals(r.configRead, null);
    assertStringIncludes(String(r.reason), "renovate.json");
    assertStringIncludes(String(r.reason), "Git does not track");
    assertEquals(r.updateCount, 1);
    const inv = k.record(INVENTORY_NAME);
    assertEquals(inv.configNotReadCount, 1);
    assertEquals([inv.okCount, inv.upToDateCount], [0, 0]);
  });
});

Deno.test("configRead is the file Renovate names, which may be another than the first the host saw", async () => {
  await one({
    out: output(repository([dep()]), { config: ".github/renovate.json" }),
  }, (r) => {
    assertEquals(r.status, "ok");
    assertEquals(r.configFile, "renovate.json");
    assertEquals(r.configRead, ".github/renovate.json");
  });
  await one({ out: FRESH }, (r) => {
    assertEquals(r.configRead, "renovate.json");
    assertEquals(r.upToDate, true);
  });
});

// ---------------------------------------------------------------------------
// 6: the container's network
// ---------------------------------------------------------------------------

Deno.test("network: passed to the engine as one value, absent by default, refused when shaped like a flag", async () => {
  await one({ out: FRESH }, (_r, _k, m) => {
    assertEquals(m.runs[0].network, undefined);
  });
  for (
    const network of ["none", "renovate-egress", "net_1.a"]
  ) {
    await one({ out: FRESH }, (_r, _k, m) => {
      assertEquals(m.runs[0].network, network);
    }, globalArgs({ network }));
  }
  for (
    const network of [
      "",
      "--privileged",
      "-v",
      "a b",
      "x\n--privileged",
      "a;b",
      "$(id)",
      "x".repeat(201),
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

// ---------------------------------------------------------------------------
// 8: the engine's own limit, and a name a person can find
// ---------------------------------------------------------------------------

Deno.test("Podman gets its own time limit, a little past the client's, and the container's name is logged before it starts", async () => {
  await withDisk(async (disk) => {
    const dir = await disk.repo("a");
    const g = globalArgs({ timeoutSeconds: 45 });
    const k = kept(disk.root, g);
    let loggedAtStart = false;
    await withEngine(
      {
        runs: { [dir]: { out: FRESH } },
        onRun: (run) => {
          loggedAtStart = k.logs.some((l) => l.includes(run.name));
        },
      },
      g,
      async (m) => {
        await lookup({ repo: "a" }, k.ctx);
        assertEquals(m.runs[0].timeout, 75);
        assertEquals(m.calls.at(-1)?.timeoutMs, 45_000);
      },
    );
    assert(loggedAtStart, k.logs.join("\n"));
  });
});

// ---------------------------------------------------------------------------
// 9: warnings are always passed on
// ---------------------------------------------------------------------------

Deno.test("at debug a warning after more quiet lines than the cap is still passed on", async () => {
  const quiet = Array.from(
    { length: MAX_LOG_LINES + 50 },
    (_, i) => JSON.stringify({ level: 20, msg: `debug line ${i}` }),
  );
  await one({
    out: output(repository([dep()]), {
      extra: [
        ...quiet,
        warning("the late warning"),
        JSON.stringify({
          level: 50,
          msg: "the late error",
        }),
      ],
    }),
  }, (_r, k) => {
    const passed = k.logs.filter((l) => l.includes(": renovate "));
    assert(passed.some((l) => l.includes("renovate warn: the late warning")));
    assert(passed.some((l) => l.includes("renovate error: the late error")));
    assertEquals(
      passed.filter((l) => l.includes("renovate log:")).length,
      MAX_LOG_LINES,
    );
    assert(k.logs.some((l) => l.includes("more Renovate log lines not shown")));
  }, globalArgs({ logLevel: "debug" }));
});

Deno.test("at info only warnings and errors are passed on, although Renovate runs at debug", async () => {
  await one({
    out: output(repository([dep()]), {
      extra: [
        JSON.stringify({ level: 20, msg: "a debug line" }),
        warning("a warning"),
      ],
    }),
  }, (_r, k, m) => {
    assertEquals(m.runs[0].logLevel, "debug");
    const passed = k.logs.filter((l) => l.includes(": renovate "));
    assertEquals(passed.length, 1);
    assertStringIncludes(passed[0], "renovate warn: a warning");
  });
});

Deno.test("the warnings passed on are bounded too", async () => {
  const loud = Array.from(
    { length: MAX_LOG_LINES + 20 },
    (_, i) => warning(`warning ${i}`),
  );
  await one({ out: output(repository([dep()]), { extra: loud }) }, (_r, k) => {
    const passed = k.logs.filter((l) => l.includes("renovate warn:"));
    assertEquals(passed.length, MAX_LOG_LINES);
    assert(k.logs.some((l) => l.includes("20 more Renovate")));
  });
});

// ---------------------------------------------------------------------------
// 10: one directory under two names
// ---------------------------------------------------------------------------

Deno.test("a symlink to a directory of the list is the same directory twice", async () => {
  await withDisk(async (disk) => {
    const a = await disk.repo("a");
    await Deno.symlink(a, `${disk.root}/link`);
    await Deno.mkdir(`${disk.root}/sub`);
    await Deno.symlink(disk.root, `${disk.root}/sub/up`);
    for (const repos of [["a", "link"], ["link", "a"], ["a", "sub/up/a"]]) {
      const k = kept(disk.root);
      await withEngine({}, k.ctx.globalArgs, async (m) => {
        const err = await assertRejects(() => lookup({ repos }, k.ctx));
        assertStringIncludes((err as Error).message, "same directory twice");
        assertEquals(m.calls, []);
      });
      assertEquals(k.written, []);
    }
    // One name for it is fine, also when that name is the symlink.
    const k = kept(disk.root);
    await withEngine(
      { runs: { [`${disk.root}/link`]: { out: FRESH } } },
      k.ctx.globalArgs,
      async () => {
        await lookup({ repos: ["link", "missing", "other-missing"] }, k.ctx);
      },
    );
    assertEquals(k.record("repo-link").status, "ok");
  });
});

// ---------------------------------------------------------------------------
// 11: a run that ends in the middle
// ---------------------------------------------------------------------------

Deno.test("a record that cannot be written ends the run: the earlier records stay and no inventory claims the list", async () => {
  await withDisk(async (disk) => {
    const a = await disk.repo("a");
    const b = await disk.repo("b");
    await disk.repo("c");
    const k = kept(disk.root, globalArgs(), {
      refuseWrite: (name) => {
        if (name === "repo-b") throw new Error("the data store is full");
      },
    });
    await withEngine(
      { runs: { [a]: { out: FRESH }, [b]: { out: FRESH } } },
      k.ctx.globalArgs,
      async (m) => {
        const err = await assertRejects(() =>
          lookup({ repos: ["a", "b", "c"] }, k.ctx)
        );
        assertStringIncludes((err as Error).message, "the data store is full");
        assertStringIncludes((err as Error).message, "1 of 3");
        assertEquals(m.runs.length, 2);
      },
    );
    assertEquals(k.written.map((w) => w.name), ["repo-a"]);
  });
});

// ---------------------------------------------------------------------------
// Second review
// ---------------------------------------------------------------------------

Deno.test("the fake prints what Renovate really logs: every form is captured, and package.json has no Repository config line", () => {
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

Deno.test("every configuration form local mode accepts is read as read: ok, with the form in configRead", async () => {
  for (const form of [...CONFIG_FILES, "package.json"]) {
    await withDisk(async (disk) => {
      const dir = await disk.repo("a", {
        [form]: form === "package.json" ? '{"renovate":{}}' : "{}",
      });
      const k = kept(disk.root);
      await withEngine(
        {
          runs: {
            [dir]: { out: output(repository([dep()]), { config: form }) },
          },
        },
        k.ctx.globalArgs,
        async () => {
          await lookup({ repo: "a" }, k.ctx);
        },
      );
      const r = k.record("repo-a");
      assertEquals(r.status, "ok", form);
      assertEquals(r.configFile, form, form);
      assertEquals(r.configRead, form, form);
      assertEquals(r.upToDate, true, form);
    });
  }
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

Deno.test("a path that is not well-formed Unicode is refused before anything starts", async () => {
  for (const path of ["a\ud800b", "\udfff", "x\ud83d"]) {
    assertThrows(
      () => targets({ repo: path }, "/r"),
      Error,
      "not well-formed Unicode",
    );
    assertThrows(
      () => targets({ repos: ["ok", path] }, "/r"),
      Error,
      "Unicode",
    );
  }
  // A whole pair is a character like any other.
  assertEquals(targets({ repo: "a\ud83d\ude00" }, "/r").length, 1);
  await withDisk(async (disk) => {
    const k = kept(disk.root);
    await withEngine({}, k.ctx.globalArgs, async (m) => {
      await assertRejects(() => lookup({ repo: "a\ud800" }, k.ctx));
      assertEquals(m.calls, []);
    });
  });
});

Deno.test("passProxy on an engine that is not Podman is said, once, not silently ignored", async () => {
  const docker = { version: "Docker version 27.3.1, build ce12230\n" };
  const said = (k: Kept) =>
    k.logs.filter((l) => l.includes("passProxy") && l.includes("Podman"));
  await one(
    { out: FRESH },
    (_r, k) => {
      assertEquals(said(k).length, 1);
    },
    globalArgs({ passProxy: true }),
    docker,
  );
  await one(
    { out: FRESH },
    (_r, k) => {
      assertEquals(said(k), []);
    },
    globalArgs({ passProxy: false }),
    docker,
  );
  await one({ out: FRESH }, (_r, k) => {
    assertEquals(said(k), []);
  }, globalArgs({ passProxy: true }));
});
