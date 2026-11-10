import { MAX_DATA_NAME_BYTES } from "../lib/cli.ts";
import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  absolutePath,
  CONFIG_FILES,
  configFile,
  dataName,
  findings,
  GlobalArgsSchema,
  INVENTORY_NAME,
  isPullProgress,
  logLines,
  LookupArgsSchema,
  model,
  UPDATE_TYPES,
} from "./local.ts";
import {
  dep,
  globalArgs,
  IMAGE,
  kept,
  output,
  repository,
  update,
  warning,
  withDisk,
  withEngine,
} from "./test_support.ts";

const lookup = model.methods.lookup.execute;

Deno.test("one repository: a container run, a record, an inventory", async () => {
  await withDisk(async (disk) => {
    const dir = await disk.repo("app", {
      "renovate.json": "{}",
      ".git/HEAD": "ref: refs/heads/main\n",
    });
    const g = globalArgs();
    const k = kept(disk.root, g);
    const stdout = output(repository([
      dep({
        updates: [update(), update({ updateType: "major", newValue: "4.0.0" })],
      }),
      dep({ depName: "nginx", currentValue: "1.31.8" }),
    ]));
    await withEngine({ runs: { [dir]: { out: stdout } } }, g, async (m) => {
      const res = await lookup({ repo: "app" }, k.ctx);
      assertEquals(res.dataHandles.map((h) => h.name), [
        "repo-app",
        INVENTORY_NAME,
      ]);
      assertEquals(m.calls.map((c) => c.args[0]), [
        "--version",
        "info",
        "image",
        "run",
      ]);
      assertEquals(m.runs[0].userns, "keep-id:uid=12021");
      assertEquals(m.runs[0].image, IMAGE);
      assertEquals(m.runs[0].httpProxy, "false");
    });
    const r = k.record("repo-app");
    assertEquals(r.path, "app");
    assertEquals(r.directory, dir);
    assertEquals(r.status, "ok");
    assertEquals(r.ok, true);
    assertEquals(r.failure, null);
    assertEquals(r.reason, null);
    assertEquals(r.lookupComplete, true);
    assertEquals(r.upToDate, false);
    assertEquals(r.renovateVersion, "44.0.0");
    assertEquals(r.configFile, "renovate.json");
    assertEquals(r.configRead, "renovate.json");
    assertEquals(r.packageFileCount, 1);
    assertEquals(r.lookedUpCount, 2);
    assertEquals(r.git, true);
    assertEquals(r.dependencyCount, 2);
    assertEquals(r.outdatedCount, 1);
    assertEquals(r.updateCount, 2);
    const counts = r.updateCounts as Record<string, number>;
    assertEquals(counts.major, 1);
    assertEquals(counts.minor, 1);
    assertEquals(counts.patch, 0);
    const updates = r.updates as Array<Record<string, unknown>>;
    assertEquals(updates[0], {
      depName: "alpine",
      packageName: "alpine",
      datasource: "docker",
      manager: "dockerfile",
      packageFile: "Dockerfile",
      depType: "final",
      currentValue: "3.18.0",
      currentVersion: "3.18.0",
      currentDigest: null,
      newValue: "3.24.4",
      newVersion: "3.24.4",
      newDigest: null,
      updateType: "minor",
      isBreaking: false,
      releaseTimestamp: "2026-11-08T14:24:43.040Z",
      newVersionAgeInDays: 2,
    });
    const inv = k.record(INVENTORY_NAME);
    assertEquals(inv.count, 1);
    assertEquals(inv.okCount, 1);
    assertEquals(inv.outdatedCount, 1);
    assertEquals(inv.upToDateCount, 0);
    assertEquals(inv.engine, "podman 4.9.3");
    assertEquals(inv.renovateVersion, "44.0.0");
    assertEquals((inv.updateCounts as Record<string, number>).major, 1);
    assertEquals((inv.items as Array<Record<string, unknown>>)[0], {
      path: "app",
      dataName: "repo-app",
      status: "ok",
      ok: true,
      lookupComplete: true,
      upToDate: false,
      lookedUpCount: 2,
      updateCount: 2,
      majorCount: 1,
      reason: null,
    });
  });
});

Deno.test("a list: one run per repository, in order, one after another", async () => {
  await withDisk(async (disk) => {
    const a = await disk.repo("a");
    const b = await disk.repo("sub/b with space");
    const c = await disk.repo("c");
    const g = globalArgs();
    const k = kept(disk.root, g);
    const fresh = output(repository([dep()]));
    let running = 0;
    await withEngine(
      {
        runs: { [a]: { out: fresh }, [b]: { out: fresh }, [c]: { out: fresh } },
        onRun: () => {
          // The fake answers at once, so a second run started before the
          // first record was written would be seen here.
          assertEquals(k.written.length, running++);
        },
      },
      g,
      async (m) => {
        await lookup({ repos: ["a", "sub/b with space", c] }, k.ctx);
        assertEquals(m.runs.map((r) => r.directory), [a, b, c]);
        // One version, one info and one inspect for the whole list.
        assertEquals(m.calls.length, 6);
        assertEquals(new Set(m.runs.map((r) => r.name)).size, 3);
      },
    );
    assertEquals(k.written.map((w) => w.name), [
      "repo-a",
      "repo-sub_2fb_20with_20space",
      dataName(c),
      INVENTORY_NAME,
    ]);
    const inv = k.record(INVENTORY_NAME);
    assertEquals(inv.count, 3);
    assertEquals(inv.upToDateCount, 3);
    assertEquals(k.record("repo-a").upToDate, true);
    assertEquals(k.record("repo-a").git, false);
  });
});

Deno.test("the engine decides the user mapping", async () => {
  const cases: Array<[string, Record<string, unknown>, string | undefined]> = [
    ["rootless podman, numeric user", {}, "keep-id:uid=12021"],
    ["user and group", { inspect: [{ out: "1000:0\n" }] }, "keep-id:uid=1000"],
    ["a user by name", { inspect: [{ out: "ubuntu\n" }] }, undefined],
    ["no user", { inspect: [{ out: "\n" }] }, undefined],
    ["rootful podman", { rootless: "false" }, undefined],
    [
      "docker",
      { version: "Docker version 27.3.1, build ce12230\n" },
      undefined,
    ],
    ["something else", { version: "nerdctl version 2.0.0\n" }, undefined],
  ];
  for (const [name, world, userns] of cases) {
    await withDisk(async (disk) => {
      const dir = await disk.repo("a");
      const g = globalArgs();
      const k = kept(disk.root, g);
      await withEngine(
        {
          ...world,
          runs: { [dir]: { out: output(repository([dep()])) } },
        },
        g,
        async (m) => {
          await lookup({ repo: dir }, k.ctx);
          assertEquals(m.runs[0].userns, userns, name);
          // Only Podman is asked whether it is rootless.
          assertEquals(
            m.calls.some((c) => c.args[0] === "info"),
            !("version" in world),
            name,
          );
        },
      );
    });
  }
});

Deno.test("an image that is not held is pulled once, then inspected again", async () => {
  await withDisk(async (disk) => {
    const a = await disk.repo("a");
    const b = await disk.repo("b");
    const g = globalArgs({ pullTimeoutSeconds: 900 });
    const k = kept(disk.root, g);
    const out = output(repository([dep()]));
    await withEngine(
      {
        inspect: [{ fail: "Error: image not known", code: 125 }, {
          out: "12021\n",
        }],
        runs: { [a]: { out }, [b]: { out } },
      },
      g,
      async (m) => {
        await lookup({ repos: [a, b] }, k.ctx);
        assertEquals(m.calls.map((c) => c.args[0]), [
          "--version",
          "info",
          "image",
          "pull",
          "image",
          "run",
          "run",
        ]);
        assertEquals(m.calls[3].timeoutMs, 900_000);
      },
    );
  });
});

Deno.test("logLevel debug reaches the container and passes log lines on, bounded", async () => {
  await withDisk(async (disk) => {
    const dir = await disk.repo("a");
    const g = globalArgs({ logLevel: "debug", timeoutSeconds: 60 });
    const k = kept(disk.root, g);
    const extra = Array.from(
      { length: 150 },
      (_, i) =>
        JSON.stringify({ level: 20, msg: `debug line ${i}`, repository: "x" }),
    );
    await withEngine(
      {
        runs: { [dir]: { out: output(repository([dep()]), { extra }) } },
      },
      g,
      async (m) => {
        await lookup({ repo: dir }, k.ctx);
        assertEquals(m.runs[0].logLevel, "debug");
        assertEquals(m.calls.at(-1)?.timeoutMs, 60_000);
      },
    );
    const passed = k.logs.filter((l) => l.includes("renovate log:"));
    assertEquals(passed.length, 100);
    assert(k.logs.some((l) => l.includes("more Renovate log lines not shown")));
    // The report itself is never a log line.
    assert(!k.logs.some((l) => l.includes("Printing report")));
  });
});

Deno.test("at info only Renovate's warnings are passed on", async () => {
  await withDisk(async (disk) => {
    const dir = await disk.repo("a");
    const k = kept(disk.root);
    await withEngine(
      {
        runs: {
          [dir]: {
            out: output(repository([dep()]), {
              extra: [
                warning("GitHub token is required for some dependencies"),
              ],
            }),
          },
        },
      },
      k.ctx.globalArgs,
      async () => {
        await lookup({ repo: dir }, k.ctx);
      },
    );
    const passed = k.logs.filter((l) => l.includes(": renovate "));
    assertEquals(passed.length, 1);
    assertStringIncludes(passed[0], "renovate warn: GitHub token is required");
  });
});

Deno.test("dataName: injective, a file name, never . or ..", () => {
  assertEquals(dataName("app"), "repo-app");
  assertEquals(dataName("apps/web"), "repo-apps_2fweb");
  assertEquals(dataName("apps/web/"), "repo-apps_2fweb");
  assertEquals(dataName("/srv/git/my_app"), "repo-_2fsrv_2fgit_2fmy_5fapp");
  assertEquals(dataName("."), "repo-_2e");
  assertEquals(dataName(".."), "repo-_2e.");
  assertEquals(dataName("../x"), "repo-_2e._2fx");
  assertEquals(dataName("/"), "repo-_2f");
  assertEquals(dataName("ø"), "repo-_c3_b8");
  assertEquals(dataName("a b"), "repo-a_20b");
  const paths = [
    "a/b",
    "a_2fb",
    "a_b",
    "a-b",
    "a.b",
    "a b",
    "A/b",
    "a//b",
    "./a/b",
    ".a",
    "_2ea",
    "inventory_all",
    "inventory/all",
  ];
  const names = paths.map(dataName);
  assertEquals(new Set(names).size, paths.length);
  for (const n of names) {
    assert(/^[A-Za-z0-9._-]+$/.test(n), n);
    assert(n !== INVENTORY_NAME && n !== "." && n !== "..", n);
  }
  // An underscore in a name is always the start of an escape, so no path
  // is stored under the inventory's name.
  assert(!/_(?![0-9a-f]{2})/.test(names.join("")));
  for (const n of names) assert(n.startsWith("repo-"), n);
});

Deno.test("absolutePath: against the repository root, tidied", () => {
  assertEquals(absolutePath("/r", "a"), "/r/a");
  assertEquals(absolutePath("/r", "./a//b/"), "/r/a/b");
  assertEquals(absolutePath("/r", "../a"), "/a");
  assertEquals(absolutePath("/r", "/x/y/../z"), "/x/z");
  assertEquals(absolutePath("/r", "."), "/r");
  assertEquals(absolutePath("/r", "/"), "/");
});

Deno.test("configFile: the names Renovate reads in local mode", async () => {
  await withDisk(async (disk) => {
    for (const name of CONFIG_FILES) {
      const dir = await disk.repo(`has-${dataName(name)}`, { [name]: "{}" });
      assertEquals(await configFile(dir), name);
    }
    const key = await disk.repo("pkg-key", {
      "package.json": '{"name":"x","renovate":{}}',
    });
    assertEquals(await configFile(key), "package.json");
    const first = await disk.repo("two", {
      ".renovaterc": "{}",
      "renovate.json": "{}",
    });
    assertEquals(await configFile(first), "renovate.json");
  });
});

Deno.test("the arguments are plain schemas the CLI can coerce into", () => {
  assertEquals(LookupArgsSchema.parse({ repo: "a" }), { repo: "a" });
  assertEquals(LookupArgsSchema.parse({ repos: ["a", "b"] }), {
    repos: ["a", "b"],
  });
  const g = GlobalArgsSchema.parse({ image: IMAGE });
  assertEquals(g.containerBinary, "podman");
  assertEquals(g.timeoutSeconds, 300);
  assertEquals(g.pull, "missing");
  assertEquals(g.pullTimeoutSeconds, 600);
  assertEquals(g.logLevel, "info");
  // The image is the Renovate version: there is no default.
  assertThrows(() => GlobalArgsSchema.parse({}));
});

Deno.test("the pre-flight check names lookup, and lookup is not a read", () => {
  const check = model.checks["container-binary-available"];
  assertEquals(check.appliesTo, ["lookup"]);
  for (const name of check.appliesTo ?? []) assert(name in model.methods);
  assertEquals(model.methods.lookup.kind, "action");
});

Deno.test("the pre-flight check runs the binary of the definition", async () => {
  const g = globalArgs({ containerBinary: "/opt/bin/docker" });
  await withEngine({}, g, async (m) => {
    const res = await model.checks["container-binary-available"].execute({
      globalArgs: g,
    });
    assertEquals(res, { pass: true });
    assertEquals(m.calls.map((c) => [c.bin, ...c.args]), [[
      "/opt/bin/docker",
      "--version",
    ]]);
  });
  await withEngine({ notInstalled: true }, g, async () => {
    const res = await model.checks["container-binary-available"].execute({
      globalArgs: g,
    });
    assertEquals(res.pass, false);
    assertStringIncludes(
      res.errors?.[0] ?? "",
      "/opt/bin/docker was not found",
    );
    assertStringIncludes(res.errors?.[0] ?? "", "containerBinary");
  });
});

Deno.test("findings: every update type has its own count", () => {
  const f = findings(repository([
    dep({ updates: UPDATE_TYPES.map((t) => update({ updateType: t })) }),
  ]));
  assert(f !== null);
  for (const t of UPDATE_TYPES) assertEquals(f.updateCounts[t], 1, t);
  assertEquals(f.updateCounts.other, 0);
  assertEquals(f.updateCount, UPDATE_TYPES.length);
  assertEquals(f.outdatedCount, 1);
});

Deno.test("isPullProgress: progress is noise, the error is not", () => {
  for (
    const l of [
      "Trying to pull registry.example/renovate:1...",
      "Getting image source signatures",
      "Copying blob sha256:abc",
      "Copying config sha256:abc",
      "Writing manifest to image destination",
      "44.0.0: Pulling from renovatebot/renovate",
    ]
  ) assert(isPullProgress(l), l);
  for (
    const l of [
      "Error: initializing source docker://registry.example/x:1: reading manifest: denied",
      "Error response from daemon: manifest unknown",
    ]
  ) assert(!isPullProgress(l), l);
});

Deno.test("logLines: JSON objects are lines, anything else is counted", () => {
  const { lines, other } = logLines('{"a":1}\nnot json\n\n[1]\n"x"\n{"b":2}\n');
  assertEquals(lines, [{ a: 1 }, { b: 2 }]);
  assertEquals(other, 3);
});

Deno.test("a data name at the limit is taken", () => {
  assertEquals(dataName("a".repeat(MAX_DATA_NAME_BYTES - 5)).length, 255);
});
