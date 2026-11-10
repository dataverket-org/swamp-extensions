import { MAX_DATA_NAME_BYTES } from "../lib/cli.ts";
import {
  assert,
  assertEquals,
  assertMatch,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { type Answer, HOSTILE, withCli } from "../lib/cli_fake.ts";
import {
  dataName,
  findings,
  GlobalArgsSchema,
  INVENTORY_NAME,
  MAX_DEPENDENCY_NOTES,
  MAX_OUTPUT_BYTES,
  MAX_REPOS,
  MAX_UPDATES,
  MAX_WARNINGS,
  model,
  targets,
} from "./local.ts";
import {
  dep,
  type Disk,
  globalArgs,
  IMAGE,
  type Kept,
  kept,
  type Machine,
  output,
  PLANTED,
  repository,
  update,
  warning,
  withDisk,
  withEngine,
  type World,
} from "./test_support.ts";

const lookup = model.methods.lookup.execute;
const FRESH = output(repository([dep()]));

/** One repository `a` whose run ends with `answer`; returns its record. */
async function one(
  answer: Answer,
  check: (
    r: Record<string, unknown>,
    k: Kept,
    m: Machine,
  ) => void | Promise<void>,
  g = globalArgs(),
): Promise<void> {
  await withDisk(async (disk) => {
    const dir = await disk.repo("a");
    const k = kept(disk.root, g);
    await withEngine({ runs: { [dir]: answer } }, g, async (m) => {
      await lookup({ repo: "a" }, k.ctx);
      await check(k.record("repo-a"), k, m);
    });
  });
}

/** A record that says nothing can be said: never ok, never up to date. */
function assertFailed(r: Record<string, unknown>, failure: string) {
  assertEquals(r.status, "failed");
  assertEquals(r.failure, failure);
  assertEquals(r.ok, false);
  assertEquals(r.lookupComplete, false);
  assertEquals(r.upToDate, false);
  assert(typeof r.reason === "string" && r.reason !== "");
}

// ---------------------------------------------------------------------------
// The run itself
// ---------------------------------------------------------------------------

Deno.test("a run that hangs past its limit: stopped, removed by name, recorded, the next one runs", async () => {
  await withDisk(async (disk) => {
    const a = await disk.repo("a");
    const b = await disk.repo("b");
    const g = globalArgs({ timeoutSeconds: 45 });
    const k = kept(disk.root, g);
    await withEngine(
      { runs: { [a]: { hang: true }, [b]: { out: FRESH } } },
      g,
      async (m) => {
        const res = await lookup({ repos: ["a", "b"] }, k.ctx);
        assertEquals(res.dataHandles.length, 3);
        const run = m.calls.find((c) => c.args[0] === "run");
        assertEquals(run?.timeoutMs, 45_000);
        // The container of the stopped client is removed, and only that one.
        const removed = m.calls.filter((c) => c.args[0] === "rm");
        assertEquals(removed.map((c) => c.args), [[
          "rm",
          "--force",
          m.runs[0].name,
        ]]);
        assertEquals(m.runs.length, 2);
      },
    );
    assertFailed(k.record("repo-a"), "timeout");
    assertStringIncludes(
      String(k.record("repo-a").reason),
      "within 45 seconds",
    );
    assertStringIncludes(String(k.record("repo-a").reason), "timeoutSeconds");
    assertEquals(k.record("repo-b").status, "ok");
    const inv = k.record(INVENTORY_NAME);
    assertEquals([inv.count, inv.okCount, inv.failedCount], [2, 1, 1]);
  });
});

Deno.test("a container that cannot be removed after its limit does not take the run down", async () => {
  await withDisk(async (disk) => {
    const a = await disk.repo("a");
    const k = kept(disk.root);
    await withEngine(
      {
        runs: { [a]: { hang: true } },
        rm: { fail: "Error: cannot remove container: permission denied" },
      },
      k.ctx.globalArgs,
      async () => {
        await lookup({ repo: "a" }, k.ctx);
      },
    );
    assertFailed(k.record("repo-a"), "timeout");
    assert(k.logs.some((l) => l.includes("may still run")));
  });
});

Deno.test("a missing binary: said with the argument that names it, nothing recorded", async () => {
  await withDisk(async (disk) => {
    await disk.repo("a");
    for (const bin of ["podman", "/opt/none/docker"]) {
      const g = globalArgs({ containerBinary: bin });
      const k = kept(disk.root, g);
      await withEngine({ notInstalled: true }, g, async (m) => {
        const err = await assertRejects(() => lookup({ repo: "a" }, k.ctx));
        assertStringIncludes((err as Error).message, `${bin} was not found`);
        assertStringIncludes((err as Error).message, "containerBinary");
        assertEquals(m.calls.length, 1);
      });
      assertEquals(k.written, []);
    }
  });
});

Deno.test("an image that cannot be pulled: the run is refused before any repository, the error is safe", async () => {
  await withDisk(async (disk) => {
    await disk.repo("a");
    const g = globalArgs();
    const k = kept(disk.root, g);
    await withEngine(
      {
        inspect: [{ fail: "Error: image not known", code: 125 }],
        pull: {
          fail:
            `Trying to pull ${IMAGE}...\nError: initializing source docker://${IMAGE}: reading manifest: denied, token=${PLANTED} https://user:${PLANTED}@registry.example/v2/`,
          code: 125,
        },
      },
      g,
      async (m) => {
        const err = await assertRejects(() => lookup({ repo: "a" }, k.ctx));
        const message = (err as Error).message;
        assertStringIncludes(message, `podman pull ${IMAGE} failed (exit 125)`);
        assertStringIncludes(message, "reading manifest: denied");
        assert(!message.includes("Trying to pull"), message);
        assert(!message.includes(PLANTED), message);
        assertEquals(m.runs, []);
      },
    );
    assertEquals(k.written, []);
    assert(!k.everything().includes(PLANTED));
  });
});

Deno.test("pull never: an image that is not held is refused without a pull", async () => {
  await withDisk(async (disk) => {
    await disk.repo("a");
    const g = globalArgs({ pull: "never" });
    const k = kept(disk.root, g);
    await withEngine(
      {
        inspect: [{ fail: `Error: ${IMAGE}: image not known`, code: 125 }],
      },
      g,
      async (m) => {
        const err = await assertRejects(() => lookup({ repo: "a" }, k.ctx));
        assertStringIncludes((err as Error).message, "pull is never");
        assertStringIncludes((err as Error).message, "image not known");
        assert(!m.calls.some((c) => c.args[0] === "pull"));
      },
    );
    assertEquals(k.written, []);
  });
});

Deno.test("a pull that hangs is stopped at pullTimeoutSeconds", async () => {
  await withDisk(async (disk) => {
    await disk.repo("a");
    const g = globalArgs({ pullTimeoutSeconds: 20 });
    const k = kept(disk.root, g);
    await withEngine(
      {
        inspect: [{ fail: "Error: image not known", code: 125 }],
        pull: { hang: true },
      },
      g,
      async (m) => {
        const err = await assertRejects(() => lookup({ repo: "a" }, k.ctx));
        assertStringIncludes((err as Error).message, "within 20 seconds");
        assertEquals(m.runs, []);
      },
    );
  });
});

Deno.test("an engine question that hangs is not taken for a missing image", async () => {
  await withDisk(async (disk) => {
    await disk.repo("a");
    const k = kept(disk.root);
    await withEngine(
      { inspect: [{ hang: true }] },
      k.ctx.globalArgs,
      async (m) => {
        const err = await assertRejects(() => lookup({ repo: "a" }, k.ctx));
        assertStringIncludes((err as Error).message, "no answer within 30");
        assert(!m.calls.some((c) => c.args[0] === "pull"));
      },
    );
  });
});

Deno.test("a non-zero exit with stderr: recorded with what was said", async () => {
  await one({
    code: 125,
    fail: `Error: statfs /x: no such file or directory\npassword: ${PLANTED}\n`,
  }, (r, k) => {
    assertFailed(r, "exit");
    assertStringIncludes(String(r.reason), "exit 125");
    assertStringIncludes(String(r.reason), "statfs /x: no such file");
    assert(!k.everything().includes(PLANTED));
  });
});

Deno.test("a non-zero exit that only logged: the last loud log lines are the reason", async () => {
  await one({
    code: 1,
    fail: "",
    stdout: output(null, {
      extra: [
        JSON.stringify({ level: 60, msg: "Initialization error" }),
        JSON.stringify({ level: 50, msg: "Error fetching git version" }),
      ],
    }),
  }, (r) => {
    assertFailed(r, "exit");
    assertStringIncludes(String(r.reason), "exit 1");
    assertStringIncludes(String(r.reason), "Initialization error");
    assertEquals(r.renovateVersion, "44.0.0");
  });
});

Deno.test("an exit with nothing said still has a reason", async () => {
  await one({ code: 137 }, (r) => {
    assertFailed(r, "exit");
    assertStringIncludes(String(r.reason), "exit 137: (no error output)");
  });
});

// ---------------------------------------------------------------------------
// What Renovate printed
// ---------------------------------------------------------------------------

Deno.test("output that is not JSON: no report, never up to date, the text is not repeated", async () => {
  await one({ out: `<html>502 Bad Gateway ${PLANTED}</html>\n` }, (r, k) => {
    assertFailed(r, "no-report");
    assertStringIncludes(String(r.reason), "0 log lines, 1 lines that are not");
    assert(!k.everything().includes(PLANTED));
    assert(!k.everything().includes("Bad Gateway"));
  });
});

Deno.test("no output at all, and a log without the report", async () => {
  await one({ out: "" }, (r) => assertFailed(r, "no-report"));
  await one({ out: output(null) }, (r) => {
    assertFailed(r, "no-report");
    assertEquals(r.renovateVersion, "44.0.0");
  });
});

Deno.test("a report of another shape is a failure, not an empty repository", async () => {
  const report = (r: unknown) =>
    [
      JSON.stringify({ msg: "Repository finished", level: 30 }),
      JSON.stringify({ msg: "Printing report", level: 30, report: r }),
    ].join("\n");
  const shapes: unknown[] = [
    {},
    { repositories: null },
    { repositories: [] },
    { repositories: {} },
    { repositories: { local: {} } },
    { repositories: { local: { packageFiles: null } } },
    { repositories: { local: { packageFiles: [] } } },
    { repositories: { local: "x" } },
    {
      repositories: {
        a: repository([]),
        b: repository([]),
      },
    },
  ];
  for (const shape of shapes) {
    await one({ out: report(shape) }, (r) => {
      assertFailed(r, "report-shape");
      assertEquals(r.dependencyCount, 0);
    });
  }
  // A report that is not an object is no report.
  for (const shape of [null, "text", 7, []]) {
    await one({ out: report(shape) }, (r) => assertFailed(r, "no-report"));
  }
});

Deno.test("entries with fields missing are unreadable: counted, and never up to date", async () => {
  const cases: Array<[string, Record<string, unknown>, number, number]> = [
    ["a manager that is no list", { packageFiles: { npm: {} } }, 0, 1],
    ["a file that is no object", { packageFiles: { npm: ["x"] } }, 0, 1],
    ["a file without deps", { packageFiles: { npm: [{}] } }, 0, 1],
    [
      "a dependency that is no object",
      {
        packageFiles: { npm: [{ deps: [null, 7] }] },
      },
      0,
      2,
    ],
    [
      "a dependency without updates",
      {
        packageFiles: { npm: [{ deps: [{ depName: "x" }] }] },
      },
      1,
      1,
    ],
    [
      "updates that are no list",
      {
        packageFiles: { npm: [{ deps: [{ depName: "x", updates: {} }] }] },
      },
      1,
      1,
    ],
    [
      "an update that is no object",
      {
        packageFiles: { npm: [{ deps: [{ updates: ["1.0.0"] }] }] },
      },
      1,
      1,
    ],
  ];
  for (const [name, repo, dependencies, unreadable] of cases) {
    await one({ out: output(repo) }, (r) => {
      // Nothing readable was looked up, so not even ok.
      assertEquals(r.status, "nothing-looked-up", name);
      assertEquals(r.dependencyCount, dependencies, name);
      assertEquals(r.unreadableCount, unreadable, name);
      assertEquals(r.lookupComplete, false, name);
      assertEquals(r.upToDate, false, name);
    });
    // Beside a dependency that was looked up: ok, and still not complete.
    const files = repo.packageFiles as Record<string, unknown>;
    await one({
      out: output({
        packageFiles: { ...files, dockerfile: [{ deps: [dep()] }] },
      }),
    }, (r) => {
      assertEquals(r.status, "ok", name);
      assertEquals(r.unreadableCount, unreadable, name);
      assertEquals(r.lookupComplete, false, name);
      assertEquals(r.upToDate, false, name);
    });
  }
});

Deno.test("a dependency with every field missing or of another type still gives a record", async () => {
  await one({
    out: output({
      packageFiles: {
        npm: [{
          packageFile: 7,
          deps: [{
            depName: { a: 1 },
            datasource: null,
            updates: [{ updateType: "sideways", newValue: ["x"] }, {}],
          }],
        }],
      },
      problems: "none",
    }),
  }, (r) => {
    assertEquals(r.status, "ok");
    assertEquals(r.updateCount, 2);
    const counts = r.updateCounts as Record<string, number>;
    assertEquals(counts.other, 2);
    assertEquals(counts.major + counts.minor + counts.patch, 0);
    const updates = r.updates as Array<Record<string, unknown>>;
    assertEquals(updates[0].depName, null);
    assertEquals(updates[0].packageFile, "7");
    assertEquals(updates[0].newValue, null);
    assertEquals(updates[0].updateType, "sideways");
    assertEquals(updates[1].updateType, null);
    assertEquals(r.upToDate, false);
    assertEquals(r.warnings, []);
  });
});

Deno.test("a huge report: the lists are cut, the counts are whole, truncated says so", async () => {
  const deps = Array.from({ length: MAX_UPDATES + 100 }, (_, i) =>
    dep({
      depName: `dep-${i}`,
      updates: [update()],
      warnings: [{ topic: "x", message: `Failed to look up dep-${i}` }],
      skipReason: "github-token-required",
    }));
  const problems = Array.from({ length: MAX_WARNINGS + 30 }, (_, i) => ({
    level: 40,
    msg: `problem ${i}`,
  }));
  deps.push(dep({ depName: "looked-up" }));
  await one({ out: output(repository(deps, { problems })) }, (r) => {
    assertEquals(r.status, "ok");
    assertEquals(r.updateCount, MAX_UPDATES + 100);
    assertEquals(r.unresolvedCount, MAX_UPDATES + 100);
    assertEquals(r.skippedCount, MAX_UPDATES + 100);
    assertEquals(r.warningCount, MAX_WARNINGS + 30);
    assertEquals((r.updates as unknown[]).length, MAX_UPDATES);
    assertEquals((r.unresolved as unknown[]).length, MAX_DEPENDENCY_NOTES);
    assertEquals((r.skipped as unknown[]).length, MAX_DEPENDENCY_NOTES);
    assertEquals((r.warnings as unknown[]).length, MAX_WARNINGS);
    assertEquals(r.truncated, true);
  });
});

Deno.test("a long value from Renovate is cut", async () => {
  await one({
    out: output(repository([
      dep({
        depName: "n".repeat(5000),
        updates: [update({ newValue: "v".repeat(5000) })],
        warnings: [{ message: "m".repeat(5000) }],
      }),
    ], {
      problems: [{ level: 50, msg: "p".repeat(5000), a: "d".repeat(5000) }],
    })),
  }, (r) => {
    assert(JSON.stringify(r).length < 5000, String(JSON.stringify(r).length));
  });
});

Deno.test("output larger than what is read is not parsed", async () => {
  const big = output(repository([dep()]), {
    extra: [warning("a warning before the flood")],
  }) + "x".repeat(MAX_OUTPUT_BYTES);
  await one({ out: big }, (r, k, m) => {
    assertFailed(r, "too-large");
    // The client was stopped for it, so its container is removed by name.
    assertEquals(m.calls.at(-1)?.args, ["rm", "--force", m.runs[0].name]);
    assertStringIncludes(String(r.reason), String(MAX_OUTPUT_BYTES));
    assertStringIncludes(String(r.reason), "was stopped");
    // Nothing of an output that was cut is read, for the log either.
    assert(!k.logs.some((l) => l.includes(": renovate ")), k.logs.join());
    assert(k.everything().length < 10_000);
  });
});

Deno.test("Renovate exits zero for a configuration it refuses: the result word decides", async () => {
  await one({
    out: output({ problems: [], branches: [], packageFiles: {} }, {
      result: "config-validation",
      extra: [
        warning("Repository has invalid config", {
          err: {
            validationSource: "renovate.json",
            validationError: "Invalid JSON (parsing failed)",
            validationMessage: "JSON5: invalid end of input at 2:1",
            message: "config-validation",
            stack: `Error: config-validation\n    at x (file:///${PLANTED})`,
          },
        }),
      ],
    }),
  }, (r, k) => {
    assertFailed(r, "result");
    assertStringIncludes(String(r.reason), "config-validation");
    assertStringIncludes(String(r.reason), "Repository has invalid config");
    assertStringIncludes(String(r.reason), "Invalid JSON (parsing failed)");
    // A stack trace is never kept.
    assert(!k.everything().includes(PLANTED));
  });
});

Deno.test("a registry that cannot be reached: failed, although Renovate exits zero with an empty report", async () => {
  await one({
    out: output({
      problems: [{ level: 40, msg: "Host error", hostType: "npm" }],
      branches: [],
      packageFiles: {},
      status: "onboarded",
    }, { result: "external-host-error" }),
  }, (r) => {
    assertFailed(r, "result");
    assertStringIncludes(String(r.reason), "external-host-error");
    assertEquals((r.warnings as unknown[]).length, 1);
  });
});

Deno.test("a status in the report alone also means Renovate ended in an error", async () => {
  await one({
    out: output({ packageFiles: {}, status: "disabled" }),
  }, (r) => {
    assertFailed(r, "result");
    assertStringIncludes(String(r.reason), "disabled");
  });
});

Deno.test("a lookup that failed for some dependencies is ok and not complete", async () => {
  await one({
    out: output(repository([
      dep(),
      dep({
        depName: "registry.invalid/none",
        warnings: [{
          topic: "registry.invalid/none",
          message: "Failed to look up docker package registry.invalid/none",
        }],
      }),
    ], {
      problems: [{
        level: 40,
        msg: "Error obtaining docker token",
        err: { message: "getaddrinfo ENOTFOUND registry.invalid" },
      }],
    })),
  }, (r) => {
    assertEquals(r.status, "ok");
    assertEquals(r.updateCount, 0);
    assertEquals(r.unresolvedCount, 1);
    assertEquals(r.lookupComplete, false);
    assertEquals(r.upToDate, false);
    assertEquals(r.unresolved, [{
      depName: "registry.invalid/none",
      datasource: "docker",
      manager: "dockerfile",
      packageFile: "Dockerfile",
      reason: "Failed to look up docker package registry.invalid/none",
    }]);
    assertEquals(r.warnings, [{
      level: "warn",
      message: "Error obtaining docker token",
      detail: "message: getaddrinfo ENOTFOUND registry.invalid",
    }]);
  });
});

Deno.test("a dependency skipped for want of a GitHub token keeps the repository from being up to date; another skip does not", async () => {
  await one({
    out: output(repository([
      dep({
        depName: "actions/checkout",
        datasource: "github-tags",
        skipReason: "github-token-required",
      }),
      dep({ depName: "ubuntu", skipReason: "invalid-version" }),
      dep(),
    ])),
  }, (r) => {
    assertEquals(r.status, "ok");
    assertEquals(r.skippedCount, 2);
    assertEquals(r.tokenRequiredCount, 1);
    assertEquals(r.lookupComplete, false);
    assertEquals(r.upToDate, false);
  });
  await one({
    out: output(repository([
      dep({ depName: "ubuntu", skipReason: "invalid-version" }),
      dep(),
    ])),
  }, (r) => {
    assertEquals(r.skippedCount, 1);
    assertEquals(r.lookupComplete, true);
    assertEquals(r.upToDate, true);
  });
});

// ---------------------------------------------------------------------------
// Secrets
// ---------------------------------------------------------------------------

Deno.test("a secret in Renovate's output reaches no record and no log line", async () => {
  const url = `https://user:${PLANTED}@registry.example/v2/`;
  await one({
    out: output(
      repository([
        dep({
          depName: `x token=${PLANTED}`,
          currentValue: `Bearer ${PLANTED}`,
          packageName: url,
          updates: [
            update({ newValue: url, newDigest: `password: ${PLANTED}` }),
          ],
          warnings: [{ message: `Failed: Authorization: Basic ${PLANTED}` }],
          skipReason: `api_key=${PLANTED}`,
        }),
        dep(),
      ], {
        problems: [{
          level: 50,
          msg: `Request failed with token=${PLANTED}`,
          url,
          hostRules: [{ token: PLANTED }],
          auth: { value: PLANTED },
          tokens: [PLANTED, 7],
          err: {
            message: `secret=${PLANTED}`,
            options: { headers: { authorization: `Bearer ${PLANTED}` } },
            stack: PLANTED,
          },
        }],
      }),
      {
        extra: [
          warning(`Rate limited, token=${PLANTED}`, { password: PLANTED }),
        ],
      },
    ),
  }, (r, k) => {
    assertEquals(r.status, "ok");
    assertEquals(r.updateCount, 1);
    assertEquals(r.warningCount, 1);
    assert(!k.everything().includes(PLANTED), k.everything());
  });
});

Deno.test("a secret in the environment reaches no container, argument or record", async () => {
  const names = [
    "GITHUB_COM_TOKEN",
    "RENOVATE_TOKEN",
    "RENOVATE_GITHUB_COM_TOKEN",
    "GITHUB_TOKEN",
  ];
  const before = names.map((n) => Deno.env.get(n));
  for (const n of names) Deno.env.set(n, PLANTED);
  try {
    await one({ out: FRESH }, (_r, k, m) => {
      for (const c of m.calls) {
        // No call names a variable to pass on, and none adds one.
        assertEquals(c.env, undefined);
        assertEquals(c.clearEnv, undefined);
        const envs = c.args.filter((_, i) => c.args[i - 1] === "--env");
        for (const e of envs) assertMatch(e, /^LOG_(LEVEL|FORMAT)=[a-z]+$/);
        assert(!c.args.some((a) => /^(-e|--env-file|--env-host)/.test(a)));
        assert(!c.args.join(" ").includes(PLANTED));
      }
      assert(!k.everything().includes(PLANTED));
    });
  } finally {
    names.forEach((n, i) =>
      before[i] === undefined ? Deno.env.delete(n) : Deno.env.set(n, before[i]!)
    );
  }
});

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

/** A machine on which any process at all fails the test. */
function noProcess<T>(body: () => Promise<T>): Promise<T> {
  return withCli({}, body);
}

Deno.test("a path shaped like a flag, empty or with a line break is refused before anything runs", async () => {
  const refused = HOSTILE.filter((h) =>
    h === "" || h.startsWith("-") || /[\0\r\n]/.test(h)
  );
  assert(refused.length >= 7);
  await withDisk(async (disk) => {
    await disk.repo("good");
    for (const path of [...refused, "--", "-", "a\0b", "a\rb"]) {
      for (const args of [{ repo: path }, { repos: ["good", path] }]) {
        const k = kept(disk.root);
        await noProcess(async () => {
          const err = await assertRejects(() => lookup(args, k.ctx));
          assertStringIncludes((err as Error).message, "is refused");
        });
        assertEquals(k.written, []);
      }
    }
  });
});

Deno.test("a value that is not text is refused", async () => {
  await withDisk(async (disk) => {
    for (const bad of [7, null, {}, ["a"], true]) {
      const k = kept(disk.root);
      await noProcess(async () => {
        await assertRejects(() =>
          // deno-lint-ignore no-explicit-any
          lookup({ repos: [bad as any] }, k.ctx)
        );
      });
    }
    const k = kept(disk.root);
    await noProcess(async () => {
      const err = await assertRejects(() =>
        // deno-lint-ignore no-explicit-any
        lookup({ repos: "a" as any }, k.ctx)
      );
      assertStringIncludes((err as Error).message, "repos is not a list");
    });
  });
});

Deno.test("every other hostile path is a path: one argument, never a shell, and not a directory here", async () => {
  const paths = HOSTILE.filter((h) =>
    h !== "" && !h.startsWith("-") && !/[\0\r\n]/.test(h) &&
    h.length <= 80 && h !== "../etc"
  );
  await withDisk(async (disk) => {
    const k = kept(disk.root);
    await withEngine({}, k.ctx.globalArgs, async (m) => {
      await lookup({ repos: paths }, k.ctx);
      assertEquals(m.runs, []);
    });
    for (const p of paths) {
      const r = k.record(dataName(p));
      assertEquals(r.path, p);
      assertEquals(r.status, "not-a-directory");
      assertEquals(r.upToDate, false);
    }
    assertEquals(k.record(INVENTORY_NAME).notADirectoryCount, paths.length);
  });
});

Deno.test("a hostile directory name that exists is mounted as one argument", async () => {
  await withDisk(async (disk) => {
    const names = [
      "a b",
      "a;rm -rf x",
      "$(id)",
      "`id`",
      "a|b",
      "a&b",
      "a>b",
      "ø",
      "a:b",
      "a=b",
      "type=bind",
    ];
    const runs: World["runs"] = {};
    for (const n of names) runs[await disk.repo(n)] = { out: FRESH };
    const k = kept(disk.root);
    await withEngine({ runs }, k.ctx.globalArgs, async (m) => {
      await lookup({ repos: names }, k.ctx);
      assertEquals(m.runs.map((r) => r.directory), Object.keys(runs));
    });
    assertEquals(k.record(INVENTORY_NAME).okCount, names.length);
  });
});

Deno.test("a path with a comma or a double quote is refused: the mount would end at it", async () => {
  await withDisk(async (disk) => {
    for (const name of ["a,target=/etc", 'a"b', '"a']) {
      await disk.repo(name);
      const k = kept(disk.root);
      await noProcess(async () => {
        const err = await assertRejects(() => lookup({ repo: name }, k.ctx));
        assertStringIncludes((err as Error).message, "comma or a double quote");
      });
      assertEquals(k.written, []);
    }
    // Also when only the repository root holds one.
    assertThrows(() => targets({ repo: "a" }, "/srv/x,y"), Error, "comma");
    assertThrows(() => targets({ repo: "a" }, '/srv/x"y'), Error, "comma");
  });
});

Deno.test("a path whose data name is too long is refused before anything runs", async () => {
  await withDisk(async (disk) => {
    const k = kept(disk.root);
    const long = "a".repeat(MAX_DATA_NAME_BYTES + 1);
    const slashes = "a/".repeat(100) + "a";
    for (const path of [long, slashes]) {
      await noProcess(async () => {
        const err = await assertRejects(() =>
          lookup({ repos: ["ok", path] }, k.ctx)
        );
        assertStringIncludes((err as Error).message, "more than the 255");
        assert((err as Error).message.length < 500);
      });
    }
    assertEquals(k.written, []);
  });
});

Deno.test("a path that is missing, a file, or without configuration is a recorded state", async () => {
  await withDisk(async (disk) => {
    const good = await disk.repo("good");
    await disk.repo("bare", { "Dockerfile": "FROM alpine:3.18.0\n" });
    await disk.repo("forgejo-only", { ".forgejo/renovate.json": "{}" });
    await disk.repo("pkg", { "package.json": '{"name":"x"}' });
    await disk.repo("pkg-bad", { "package.json": "{" });
    await disk.repo("dir-named-config/renovate.json", { "x": "" });
    await disk.repo("holder", { "file": "x" });
    const k = kept(disk.root);
    await withEngine(
      { runs: { [good]: { out: FRESH } } },
      k.ctx.globalArgs,
      async (m) => {
        const res = await lookup({
          repos: [
            "missing",
            "holder/file",
            "bare",
            "forgejo-only",
            "pkg",
            "pkg-bad",
            "dir-named-config",
            "good",
          ],
        }, k.ctx);
        assertEquals(res.dataHandles.length, 9);
        // Renovate ran once: for the one directory with a configuration.
        assertEquals(m.runs.map((r) => r.directory), [good]);
      },
    );
    assertEquals(k.record("repo-missing").status, "not-a-directory");
    assertStringIncludes(
      String(k.record("repo-missing").reason),
      "does not exist",
    );
    assertEquals(k.record("repo-holder_2ffile").status, "not-a-directory");
    assertStringIncludes(
      String(k.record("repo-holder_2ffile").reason),
      "is not a directory",
    );
    for (
      const n of ["bare", "forgejo-only", "pkg", "pkg-bad", "dir-named-config"]
    ) {
      const r = k.record(`repo-${n}`);
      assertEquals(r.status, "no-config", n);
      assertEquals([r.ok, r.lookupComplete, r.upToDate], [false, false, false]);
      assertEquals(r.failure, null);
      assertStringIncludes(String(r.reason), "no Renovate configuration");
      assertEquals(r.renovateVersion, null);
    }
    const inv = k.record(INVENTORY_NAME);
    assertEquals(
      [
        inv.count,
        inv.okCount,
        inv.failedCount,
        inv.noConfigCount,
        inv.notADirectoryCount,
      ],
      [8, 1, 0, 5, 2],
    );
    assertEquals(inv.upToDateCount, 1);
  });
});

// ---------------------------------------------------------------------------
// The list
// ---------------------------------------------------------------------------

Deno.test("one repository fails while the others succeed: all are recorded and the method succeeds", async () => {
  await withDisk(async (disk) => {
    const a = await disk.repo("a");
    const b = await disk.repo("b");
    const c = await disk.repo("c");
    const k = kept(disk.root);
    await withEngine(
      {
        runs: {
          [a]: { out: output(repository([dep({ updates: [update()] })])) },
          [b]: { code: 1, fail: "boom" },
          [c]: { out: FRESH },
        },
      },
      k.ctx.globalArgs,
      async (m) => {
        const res = await lookup({ repos: ["a", "b", "c"] }, k.ctx);
        assertEquals(res.dataHandles.map((h) => h.name), [
          "repo-a",
          "repo-b",
          "repo-c",
          INVENTORY_NAME,
        ]);
        assertEquals(m.runs.length, 3);
      },
    );
    assertEquals(k.record("repo-a").status, "ok");
    assertFailed(k.record("repo-b"), "exit");
    assertEquals(k.record("repo-c").upToDate, true);
    const inv = k.record(INVENTORY_NAME);
    assertEquals(
      [
        inv.count,
        inv.okCount,
        inv.failedCount,
        inv.upToDateCount,
        inv.outdatedCount,
      ],
      [3, 2, 1, 1, 1],
    );
    const items = inv.items as Array<Record<string, unknown>>;
    assertEquals(items.map((i) => i.status), ["ok", "failed", "ok"]);
    assertStringIncludes(String(items[1].reason), "boom");
  });
});

Deno.test("cancelled between two repositories: the first record stays, no further run, no inventory", async () => {
  await withDisk(async (disk) => {
    const a = await disk.repo("a");
    await disk.repo("b");
    await disk.repo("c");
    const stop = new AbortController();
    const k = kept(disk.root, globalArgs(), {
      signal: stop.signal,
      onWrite: () => stop.abort(),
    });
    await withEngine(
      { runs: { [a]: { out: FRESH } } },
      k.ctx.globalArgs,
      async (m) => {
        const err = await assertRejects(() =>
          lookup({ repos: ["a", "b", "c"] }, k.ctx)
        );
        assertStringIncludes(
          (err as Error).message,
          "cancelled after 1 of 3 repositories",
        );
        assertEquals(m.runs.length, 1);
      },
    );
    assertEquals(k.written.map((w) => w.name), ["repo-a"]);
  });
});

Deno.test("cancelled while Renovate runs: the container is removed, nothing more is written", async () => {
  await withDisk(async (disk) => {
    const a = await disk.repo("a");
    const b = await disk.repo("b");
    const stop = new AbortController();
    const k = kept(disk.root, globalArgs(), { signal: stop.signal });
    await withEngine(
      {
        runs: { [a]: { out: FRESH }, [b]: { hang: "until-cancelled" } },
        onRun: (run) => {
          if (run.directory === b) queueMicrotask(() => stop.abort());
        },
      },
      k.ctx.globalArgs,
      async (m) => {
        const err = await assertRejects(() =>
          lookup({ repos: ["a", "b"] }, k.ctx)
        );
        assertStringIncludes((err as Error).message, "cancelled after 1 of 2");
        // The removal is not tied to the cancelled run's signal: it ran.
        assertEquals(m.calls.at(-1)?.args, ["rm", "--force", m.runs[1].name]);
        // ... and to its end: a removal cut short by the same signal is said.
        assert(!k.logs.some((l) => l.includes("may still run")), k.logs.join());
      },
    );
    assertEquals(k.written.map((w) => w.name), ["repo-a"]);
  });
});

Deno.test("cancelled before it starts: no repository is run", async () => {
  await withDisk(async (disk) => {
    await disk.repo("a");
    const stop = new AbortController();
    stop.abort();
    const k = kept(disk.root, globalArgs(), { signal: stop.signal });
    await withEngine({}, k.ctx.globalArgs, async (m) => {
      await assertRejects(() => lookup({ repo: "a" }, k.ctx));
      assertEquals(m.runs, []);
    });
    assertEquals(k.written, []);
  });
});

Deno.test("both, neither, empty, too many: refused before anything runs", async () => {
  await withDisk(async (disk) => {
    await disk.repo("a");
    const cases: Array<[Record<string, unknown>, string]> = [
      [{ repo: "a", repos: ["a"] }, "not both"],
      [{ repo: "a", repos: [] }, "not both"],
      [{}, "give repo, one directory, or repos"],
      [{ repos: [] }, "repos is empty"],
      [{ repo: '["a"]' }, "give a list as repos"],
      [{ repo: "[a, b]" }, "give a list as repos"],
      [{ repo: " [] " }, "give a list as repos"],
      [
        { repos: Array.from({ length: MAX_REPOS + 1 }, (_, i) => `r${i}`) },
        `more than the ${MAX_REPOS}`,
      ],
    ];
    for (const [args, said] of cases) {
      const k = kept(disk.root);
      await noProcess(async () => {
        const err = await assertRejects(() => lookup(args, k.ctx));
        assertStringIncludes((err as Error).message, said);
      });
      assertEquals(k.written, []);
    }
  });
});

Deno.test("the same directory twice, under any spelling, is refused before anything runs", async () => {
  await withDisk(async (disk: Disk) => {
    const a = await disk.repo("a");
    for (
      const repos of [
        ["a", "a"],
        ["a", "a/"],
        ["a", "./a"],
        ["a", "b/../a"],
        ["a", "a//"],
        ["a", a],
        ["b", "a", "c", "a"],
        // Also a directory that does not exist: its two records would
        // otherwise be written under one name, or under two.
        ["nowhere", "nowhere/"],
        ["nowhere", "./nowhere"],
      ]
    ) {
      const k = kept(disk.root);
      await noProcess(async () => {
        const err = await assertRejects(() => lookup({ repos }, k.ctx));
        assertStringIncludes((err as Error).message, "same directory twice");
      });
      assertEquals(k.written, []);
    }
  });
});

// ---------------------------------------------------------------------------
// The definition's arguments
// ---------------------------------------------------------------------------

Deno.test("an image that is not an image reference is refused by the schema", () => {
  for (
    const image of [
      "",
      "-v",
      "--privileged",
      "a b",
      "img;id",
      "$(id)",
      "img\n--privileged",
      "x".repeat(501),
    ]
  ) {
    assertThrows(
      () => GlobalArgsSchema.parse({ image }),
      Error,
      undefined,
      image,
    );
  }
  for (
    const image of [
      IMAGE,
      "ghcr.io/renovatebot/renovate:44.226.2",
      "renovate/renovate@sha256:" + "a".repeat(64),
      "localhost:5000/r:1",
    ]
  ) GlobalArgsSchema.parse({ image });
});

Deno.test("time limits have bounds, and nothing quieter than info is offered", () => {
  for (
    const bad of [
      { timeoutSeconds: 0 },
      { timeoutSeconds: 9 },
      { timeoutSeconds: 3601 },
      { timeoutSeconds: 1.5 },
      { timeoutSeconds: -1 },
      { pullTimeoutSeconds: 0 },
      { pullTimeoutSeconds: 3601 },
      { logLevel: "warn" },
      { logLevel: "trace" },
      { pull: "always" },
      { containerBinary: "" },
    ]
  ) {
    assertThrows(
      () => GlobalArgsSchema.parse({ image: IMAGE, ...bad }),
      Error,
      undefined,
      JSON.stringify(bad),
    );
  }
});

Deno.test("findings: null only when there is nothing to read", () => {
  assertEquals(findings({}), null);
  assertEquals(findings({ packageFiles: "x" }), null);
  assertEquals(findings({ packageFiles: {} })?.dependencyCount, 0);
});

Deno.test("arguments swamp did not check are checked by the method, without their values", async () => {
  await withDisk(async (disk) => {
    await disk.repo("a");
    const cases: Array<[unknown, string]> = [
      [{}, "the image argument is not set"],
      [undefined, "the image argument is not set"],
      [{ containerBinary: "podman" }, "the image argument is not set"],
      [{ image: `--env=X=${PLANTED}` }, "image: "],
      [{ image: IMAGE, timeoutSeconds: 999_999 }, "timeoutSeconds: "],
      [{ image: IMAGE, timeoutSeconds: "300" }, "timeoutSeconds: "],
      [{ image: IMAGE, logLevel: "warn" }, "logLevel: "],
      [{ image: IMAGE, pullTimeoutSeconds: 0 }, "pullTimeoutSeconds: "],
    ];
    for (const [given, said] of cases) {
      const k = kept(disk.root);
      // deno-lint-ignore no-explicit-any
      const ctx = { ...k.ctx, globalArgs: given as any };
      await noProcess(async () => {
        const err = await assertRejects(() => lookup({ repo: "a" }, ctx));
        assertStringIncludes((err as Error).message, said);
        assert(!(err as Error).message.includes(PLANTED));
      });
      assertEquals(k.written, []);
    }
  });
});

Deno.test("defaults are filled in when swamp hands over only what was set", async () => {
  await withDisk(async (disk) => {
    const dir = await disk.repo("a");
    const k = kept(disk.root);
    // deno-lint-ignore no-explicit-any
    const ctx = { ...k.ctx, globalArgs: { image: IMAGE } as any };
    await withEngine(
      { runs: { [dir]: { out: FRESH } } },
      globalArgs(),
      async (m) => {
        await lookup({ repo: "a" }, ctx);
        assertEquals(m.calls[0].bin, "podman");
        assertEquals(m.calls.at(-1)?.timeoutMs, 300_000);
      },
    );
  });
});

Deno.test("each list says by itself that it was cut", async () => {
  const many = (n: number, over: Record<string, unknown>) =>
    Array.from({ length: n }, (_, i) => dep({ depName: `d${i}`, ...over }));
  const cases: Array<[string, Record<string, unknown>]> = [
    [
      "updates",
      repository(many(MAX_UPDATES + 1, { updates: [update()] })),
    ],
    [
      "unresolved",
      repository(
        many(MAX_DEPENDENCY_NOTES + 1, { warnings: [{ message: "x" }] }),
      ),
    ],
    [
      "skipped",
      repository(many(MAX_DEPENDENCY_NOTES + 1, { skipReason: "unsupported" })),
    ],
    [
      "warnings",
      repository([], {
        problems: Array.from(
          { length: MAX_WARNINGS + 1 },
          () => ({ level: 40, msg: "p" }),
        ),
      }),
    ],
  ];
  for (const [name, repo] of cases) {
    await one({ out: output(repo) }, (r) => {
      assertEquals(r.truncated, true, name);
    });
  }
  // At the bound, nothing was cut.
  await one({
    out: output(repository(many(MAX_UPDATES, { updates: [update()] }))),
  }, (r) => {
    assertEquals(r.truncated, false);
    assertEquals((r.updates as unknown[]).length, MAX_UPDATES);
  });
});

Deno.test("the report is never passed on as a log line, at debug either", async () => {
  await one({
    out: output(repository([dep({ depName: "only-in-the-report" })])),
  }, (r, k) => {
    assertEquals(r.dependencyCount, 1);
    assert(k.logs.some((l) => l.includes("renovate log: Repository finished")));
    assert(!k.logs.join("\n").includes("Printing report"));
    assert(!k.logs.join("\n").includes("only-in-the-report"));
  }, globalArgs({ logLevel: "debug" }));
});
