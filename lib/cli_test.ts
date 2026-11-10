/**
 * Tests of the shared process layer and of its strict fake. They run once,
 * here in `lib/`, not in every extension. The negative tests come first:
 * each pins one safety property the layer exists for.
 *
 * Needs `--allow-run=sh`: the real spawn is tested against `sh`.
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  __setSleep,
  __setSpawn,
  assertDataName,
  brief,
  cancelledError,
  CHECK_TIMEOUT_MS,
  cliCheck,
  CliError,
  cliError,
  cliProblem,
  DEFAULT_MAX_OUTPUT_BYTES,
  DEFAULT_TIMEOUT_MS,
  describeArgs,
  encodedName,
  isCliError,
  MAX_DATA_NAME_BYTES,
  MAX_TIMEOUT_MS,
  now,
  parseJson,
  pollBudget,
  positionalArg,
  redact,
  runCli,
  safeStderr,
  shown,
  sleep,
  spawnProcess,
  STDERR_LIMIT,
  tryCli,
  valueArg,
  withoutNoise,
} from "./cli.ts";
import { CAPTURE, fakeCli, HOSTILE, knownFlags, withCli } from "./cli_fake.ts";

const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
const PASSWORD = "PLANTED-passw0rd";
const text = (bytes: Uint8Array) => new TextDecoder().decode(bytes);

// ---------------------------------------------------------------------------
// Negative: arguments
// ---------------------------------------------------------------------------

Deno.test("positionalArg refuses what a tool would read as a flag, and line breaks", () => {
  for (
    const bad of [
      "-A",
      "--all",
      "-",
      "--",
      "-o=yaml",
      "--kubeconfig=/etc/passwd",
      "",
      "a\nb",
      "a\rb",
      "a\0b",
      "\n",
    ]
  ) {
    const e = assertThrows(() => positionalArg(bad, "image"), Error);
    assertStringIncludes(e.message, "image ");
    assertStringIncludes(e.message, "is refused");
    assertFalse(e.message.includes("\n"));
  }
  for (const bad of [undefined, null, 7, {}, ["a"], true]) {
    assertThrows(() => positionalArg(bad, "image"), Error, "is refused");
  }
  for (const ok of ["a", "a b", "a-b", "a=-b", "$(id)", "ø", "a;b"]) {
    assertEquals(positionalArg(ok, "x"), ok);
  }
  const long = assertThrows(() => positionalArg("-" + "x".repeat(900), "v"));
  assert((long as Error).message.length < 250);
});

Deno.test("valueArg lets a leading dash through and refuses line breaks", () => {
  for (const ok of ["", "-1", "--x", "a b"]) {
    assertEquals(valueArg(ok, "v"), ok);
  }
  for (const bad of ["a\nb", "a\rb", "a\0b", undefined, 7]) {
    assertThrows(() => valueArg(bad, "note"), Error, "note ");
  }
});

Deno.test("a call needs a binary, text arguments and a time limit above zero", async () => {
  await withCli({ calls: [] }, async (k) => {
    for (const timeoutMs of [0, -1, NaN, Infinity]) {
      await assertRejects(
        () => tryCli("tool", [], { timeoutMs }),
        Error,
        "needs a time limit above zero",
      );
    }
    await assertRejects(() => tryCli("", []), Error, "not a binary");
    await assertRejects(() => tryCli("a\0b", []), Error, "not a binary");
    await assertRejects(
      () => tryCli("tool", ["a\0b"]),
      Error,
      "argument that is not text",
    );
    await assertRejects(
      () => tryCli("tool", [7 as unknown as string]),
      Error,
      "argument that is not text",
    );
    assertEquals(k.calls, []);
  });
});

Deno.test("arguments are passed without a shell", async () => {
  const r = await spawnProcess(
    "sh",
    ["-c", 'printf "%s|" "$@"', "sh", "$(id)", "a b", ";x", "`id`"],
    { timeoutMs: 5000 },
  );
  assertEquals(text(r.stdout), "$(id)|a b|;x|`id`|");
});

// ---------------------------------------------------------------------------
// Negative: what reaches an error
// ---------------------------------------------------------------------------

Deno.test("redact blanks what is shaped like a credential, and little else", () => {
  const dirty = [
    `Authorization: Bearer ${TOKEN}`,
    "Authorization: Basic dXNlcjpwYXNzd29yZA==",
    "sent Basic dXNlcjpwYXNzd29yZA== to the registry",
    `token="abc123" password: ${PASSWORD}`,
    "client-key-data: LS0tLS1CRUdJTg==",
    `Unable to connect to https://admin:${PASSWORD}@api.example.org:6443`,
    `id-token=${TOKEN}`,
    `the token was ${TOKEN} they said`,
    "-----BEGIN PRIVATE KEY-----\nMIIEvQIBADANBg\n-----END PRIVATE KEY-----",
    "client_secret=s3cr3tvalue api-key: k3yvalue",
    "OS_APPLICATION_CREDENTIAL_SECRET=0sSecretValue",
    "login --username u --password fl4gvalue --registry r",
    "COSIGN_PASSWORD='qu0ted' passphrase=phr4se",
  ].join("\n");
  const clean = redact(dirty);
  for (
    const leak of [
      TOKEN,
      "eyJhbGciOi",
      "dXNlcjpwYXNzd29yZA",
      "abc123",
      PASSWORD,
      "LS0tLS1CRUdJTg",
      "MIIEvQIBADANBg",
      "s3cr3tvalue",
      "k3yvalue",
      "0sSecretValue",
      "fl4gvalue",
      "qu0ted",
      "phr4se",
    ]
  ) {
    assertFalse(clean.includes(leak), `${leak} in ${clean}`);
  }
  assertStringIncludes(clean, "https://api.example.org:6443");
  assertStringIncludes(clean, "--username u --password [redacted] --registry");
  assertEquals(clean.split("\n").length, 13, "line breaks are kept");
  for (
    const kept of [
      "s3://bucket/path",
      "http://s3.pg.svc:7070",
      "mail a@b.example",
      "basic auth is not enabled",
      'Error from server (NotFound): secrets "x" not found',
      'cannot list resource "secrets" in API group ""',
      'the server could not find "token"',
      "auth login r --username u --password-stdin",
      "auth login r --password-stdin --username u",
    ]
  ) {
    assertEquals(redact(kept), kept);
  }
  assertEquals(
    redact("https://u:p@host/x and s3://k:s@b/"),
    "https://host/x and s3://b/",
  );
});

Deno.test("a value the caller names as secret is blanked word for word", () => {
  assertEquals(
    redact("key AGE-SECRET-1ABC and again AGE-SECRET-1ABC.", [
      "AGE-SECRET-1ABC",
    ]),
    "key [redacted] and again [redacted].",
  );
  // The longest first, a trimmed form too, and an empty one is no secret.
  assertEquals(
    redact("abcdef abc", ["abc", "abcdef", "", "  abc\n"]),
    "[redacted] [redacted]",
  );
  assertEquals(redact("multi\nline", ["multi\nline\n"]), "[redacted]");
  assertEquals(brief("x hunter2 y", 400, ["hunter2"]), "x [redacted] y");
  assertEquals(
    describeArgs(["login", "hunter2"], ["hunter2"]),
    "login [redacted]",
  );
  assertEquals(
    safeStderr("a hunter2", { secrets: ["hunter2"] }),
    "a [redacted]",
  );
});

Deno.test("brief is one redacted line, cut at the limit; safeStderr keeps lines and is bounded", () => {
  assertEquals(brief(" a\n  b\tc "), "a b c");
  assertEquals(brief("x".repeat(50), 10), "x".repeat(10) + "...");
  assertEquals(brief("x".repeat(1000)).length, 403);
  assertFalse(brief(`password=${PASSWORD}\nnext`).includes(PASSWORD));
  const s = safeStderr(
    `error: one\npassword: ${PASSWORD}\n` + "y".repeat(9000),
  );
  assertFalse(s.includes(PASSWORD));
  assertStringIncludes(s, "error: one\n");
  assertEquals(s.length, STDERR_LIMIT + 3);
  assert(describeArgs(["get", "x".repeat(900)]).length <= 203);
  assertEquals(shown("x".repeat(200)).length, 85);
  assertEquals(shown(7), '"7"');
});

Deno.test("noise lines are dropped by the caller's filter, and the last one kept when there is nothing else", () => {
  const noise = (l: string) => l.startsWith("DEBUG ");
  assertEquals(
    withoutNoise("DEBUG a\nerror: real\nDEBUG b\n", noise),
    "error: real",
  );
  assertEquals(withoutNoise("DEBUG a\nDEBUG b\n", noise), "DEBUG b");
  assertEquals(withoutNoise("a\n\n  \nb\n"), "a\nb");
  assertEquals(withoutNoise("", noise), "");
  assertEquals(safeStderr("DEBUG a\nerror: real", { noise }), "error: real");
});

Deno.test("a failed command is a CliError: kind, exit code, one bounded line, nothing secret", async () => {
  const e = await withCli({
    calls: [{
      bin: "tool",
      args: ["push", "--password", PASSWORD, "img"],
      code: 3,
      fail:
        `DEBUG chatter\nerror: denied for https://u:${PASSWORD}@r.example\n` +
        `Authorization: Bearer ${TOKEN}\n` + "x".repeat(5000),
      stdout: `payload ${PASSWORD}`,
    }],
  }, () =>
    assertRejects(
      () =>
        runCli("tool", ["push", "--password", PASSWORD, "img"], {
          noise: (l) => l.startsWith("DEBUG "),
        }),
      CliError,
    ));
  assertEquals([e.kind, e.code, e.bin, e.name], [
    "failed",
    3,
    "tool",
    "CliError",
  ]);
  assertStringIncludes(
    e.message,
    "tool push --password [redacted] img failed (exit 3): error: denied for https://r.example",
  );
  for (const t of [e.message, e.stderr, String(e), JSON.stringify(e)]) {
    assertFalse(t.includes(PASSWORD), t.slice(0, 200));
    assertFalse(t.includes(TOKEN));
    assertFalse(t.includes("payload"));
    assertFalse(t.includes("DEBUG"));
  }
  assertFalse(e.message.includes("\n"));
  assert(e.message.length < 700, String(e.message.length));
  assert(isCliError(e) && isCliError(e, "timeout", "failed"));
  assertFalse(isCliError(e, "timeout"));
  assertFalse(isCliError(new Error("x")));
});

Deno.test("standard output is not in an error unless asked for, and then redacted and bounded", async () => {
  const call = {
    bin: "tool",
    args: ["x"],
    code: 1,
    stdout: `out ${PASSWORD} password=abc ` + "z".repeat(900),
  };
  await withCli(
    { calls: [call, call, { ...call, fail: "on stderr" }] },
    async () => {
      const silent = await assertRejects(() => runCli("tool", ["x"]), CliError);
      assertStringIncludes(silent.message, "(no error output)");
      assertFalse(silent.message.includes("out "));
      const asked = await assertRejects(
        () =>
          runCli("tool", ["x"], { stdoutInError: true, secrets: [PASSWORD] }),
        CliError,
      );
      assertStringIncludes(
        asked.message,
        "failed (exit 1): out [redacted] password=[redacted] zzz",
      );
      assert(asked.message.length < 500);
      // Standard error wins when there is some.
      const both = await assertRejects(
        () => runCli("tool", ["x"], { stdoutInError: true }),
        CliError,
      );
      assertStringIncludes(both.message, "failed (exit 1): on stderr");
    },
  );
});

Deno.test("the caller can name the command, so arguments that say too much stay out", async () => {
  await withCli({
    calls: [{ bin: "tool", args: ["sign", "--key", "k", "ref"], fail: "boom" }],
  }, async () => {
    const e = await assertRejects(
      () =>
        runCli("tool", ["sign", "--key", "k", "ref"], { what: "tool sign" }),
      CliError,
    );
    assertEquals(e.message, "tool sign failed (exit 1): boom");
  });
});

Deno.test("environment additions reach the process and nothing else", async () => {
  const r = await runCli("sh", ["-c", 'printf "%s" "$PLANTED_VAR"; exit 0'], {
    env: { PLANTED_VAR: PASSWORD },
    timeoutMs: 5000,
  });
  assertEquals(r.stdout, PASSWORD);
  const e = await assertRejects(
    () =>
      runCli("sh", ["-c", "echo failing >&2; exit 2"], {
        env: { PLANTED_VAR: PASSWORD },
        timeoutMs: 5000,
      }),
    CliError,
  );
  assertFalse(JSON.stringify(e).includes(PASSWORD));
  assertFalse(e.message.includes("PLANTED_VAR"));
  // A tool that prints it back is why the caller names it as a secret.
  const echoed = await assertRejects(
    () =>
      runCli("sh", ["-c", 'echo "bad value $PLANTED_VAR" >&2; exit 2'], {
        env: { PLANTED_VAR: PASSWORD },
        secrets: [PASSWORD],
        timeoutMs: 5000,
      }),
    CliError,
  );
  assertStringIncludes(echoed.message, "bad value [redacted]");
  // clearEnv: the environment is what was given and nothing else.
  const cleared = await runCli(
    "sh",
    ["-c", 'printf "%s|%s" "$HOME" "$ONLY"'],
    {
      env: { ONLY: "this", PATH: "/usr/bin:/bin" },
      clearEnv: true,
      timeoutMs: 5000,
    },
  );
  assertEquals(cleared.stdout, "|this");
  const inherited = await runCli(
    "sh",
    ["-c", 'printf "%s|%s" "${HOME:+home}" "$ONLY"'],
    { env: { ONLY: "this" }, timeoutMs: 5000 },
  );
  assertEquals(inherited.stdout, "home|this");
});

// ---------------------------------------------------------------------------
// Negative: failures are named
// ---------------------------------------------------------------------------

Deno.test("a binary that is not there, a hang and a cancelled run each have their kind", async () => {
  const abort = new AbortController();
  await withCli({
    calls: [
      { bin: "tool", args: ["a"], notInstalled: true },
      { bin: "/opt/tool", args: ["a"], notInstalled: true },
      { bin: "tool", args: ["b"], hang: true },
      { bin: "tool", args: ["b"], hang: true },
      { bin: "tool", args: ["c"], hang: "until-cancelled" },
    ],
  }, async (k) => {
    const missing = await assertRejects(() => runCli("tool", ["a"]), CliError);
    assertEquals([missing.kind, missing.code], ["not-installed", null]);
    assertEquals(
      missing.message,
      "tool is not on PATH; install it or put it on the PATH this repository runs with",
    );
    const hinted = await assertRejects(
      () => tryCli("/opt/tool", ["a"], { installHint: "set toolBinary" }),
      CliError,
    );
    assertEquals(hinted.message, "/opt/tool was not found; set toolBinary");
    __setSpawn(() => Promise.reject(new Deno.errors.NotFound("x")));
    const path = await assertRejects(() => tryCli("/opt/tool", []), CliError);
    assertEquals(
      path.message,
      "/opt/tool was not found; install it there or correct the path",
    );
    __setSpawn(k.spawn);

    const hung = await assertRejects(() => runCli("tool", ["b"]), CliError);
    assertEquals(hung.kind, "timeout");
    assertEquals(
      hung.message,
      `tool b failed: no answer within ${
        DEFAULT_TIMEOUT_MS / 1000
      } seconds; the process was stopped`,
    );
    const hung2 = await assertRejects(
      () => runCli("tool", ["b"], { timeoutMs: 1500 }),
      CliError,
    );
    assertStringIncludes(hung2.message, "within 1.5 seconds");

    const p = assertRejects(
      () => runCli("tool", ["c"], { signal: abort.signal }),
      CliError,
    );
    abort.abort();
    const cancelled = await p;
    assertEquals(cancelled.kind, "cancelled");
    assertEquals(cancelled.message, "tool c was cancelled");
  });
  // Any other spawn error is not swallowed or renamed.
  __setSpawn(() => Promise.reject(new Deno.errors.NotCapable("no run")));
  try {
    await assertRejects(() => runCli("tool", []), Deno.errors.NotCapable);
  } finally {
    __setSpawn();
  }
});

Deno.test("tryCli reports a failure without throwing, and cliError turns it into the same error", async () => {
  await withCli({
    calls: [
      {
        bin: "tool",
        args: ["get", "x"],
        code: 4,
        fail: "Error: NotFound\n",
        stdout: "partial",
      },
      { bin: "tool", args: ["get", "y"], out: "ok\n" },
    ],
  }, async () => {
    const r = await tryCli("tool", ["get", "x"]);
    assertEquals(
      [r.success, r.code, r.stdout, r.stderr, r.timedOut, r.cancelled],
      [false, 4, "partial", "Error: NotFound", false, false],
    );
    const e = cliError("tool", ["get", "x"], r);
    assertEquals(e.message, "tool get x failed (exit 4): Error: NotFound");
    const ok = await tryCli("tool", ["get", "y"]);
    assertEquals([ok.success, ok.code, ok.stdout], [true, 0, "ok\n"]);
  });
});

Deno.test("output that is not JSON is a named error that does not show the output", () => {
  assertEquals(parseJson('{"a":1}', "tool get"), { a: 1 });
  assertEquals(parseJson("[]", "tool list"), []);
  const garbage = `<html>login ${PASSWORD}</html>`;
  const e = assertThrows(
    () => parseJson(garbage, "tool get x", "tool"),
    CliError,
  );
  assertEquals([e.kind, e.bin, e.code], ["not-json", "tool", 0]);
  assertEquals(
    e.message,
    `tool get x did not print JSON (${garbage.length} characters of output)`,
  );
  assertStringIncludes(
    assertThrows(() => parseJson(" \n", "tool get"), CliError).message,
    "(no output)",
  );
});

// ---------------------------------------------------------------------------
// Negative: the real process
// ---------------------------------------------------------------------------

Deno.test("a process that does not end is stopped at its time limit", async () => {
  const started = Date.now();
  const r = await spawnProcess("sh", ["-c", "exec sleep 6"], {
    timeoutMs: 300,
    graceMs: 300,
  });
  assertEquals(r.timedOut, true);
  assertEquals(r.cancelled, false);
  assertEquals(r.code, null);
  assert(Date.now() - started < 3000, "it ran to its own end");
});

Deno.test("a process that ignores SIGTERM is killed, and a child holding the pipes does not hold the caller", async () => {
  const started = Date.now();
  // sh ignores TERM; its child sleep inherits the pipes and outlives it.
  const r = await spawnProcess("sh", ["-c", "trap '' TERM; echo up; sleep 6"], {
    timeoutMs: 300,
    graceMs: 300,
  });
  assertEquals(r.timedOut, true);
  assertEquals(text(r.stdout), "up\n");
  assert(Date.now() - started < 4000, "the caller was held");
});

Deno.test("a cancelled run stops the process, and one cancelled before the start spawns nothing", async () => {
  const abort = new AbortController();
  const started = Date.now();
  const p = spawnProcess("sh", ["-c", "exec sleep 6"], {
    timeoutMs: 20_000,
    graceMs: 300,
    signal: abort.signal,
  });
  setTimeout(() => abort.abort(), 100);
  const r = await p;
  assertEquals([r.cancelled, r.timedOut], [true, false]);
  assert(Date.now() - started < 3000);
  assertEquals(
    await spawnProcess("no-such-binary-and-never-spawned", [], {
      timeoutMs: 1000,
      signal: abort.signal,
    }),
    { code: null, stdout: new Uint8Array(), stderr: "", cancelled: true },
  );
});

Deno.test("runCli stops a real process at the caller's limit and reports it as a timeout", async () => {
  const started = Date.now();
  const e = await assertRejects(
    () => runCli("sh", ["-c", "exec sleep 6"], { timeoutMs: 300 }),
    CliError,
  );
  assertEquals(e.kind, "timeout");
  assertStringIncludes(e.message, "no answer within 0.3 seconds");
  assert(Date.now() - started < 5500, "it ran to its own end");
  const f = await assertRejects(
    () =>
      runCli("sh", [
        "-c",
        `echo 'error: bearer ${TOKEN}' >&2; echo out; exit 3`,
      ], {
        timeoutMs: 5000,
        what: "sh script",
      }),
    CliError,
  );
  assertEquals(
    f.message,
    "sh script failed (exit 3): error: bearer [redacted]",
  );
});

Deno.test("standard input reaches the process, bytes come back as bytes, and a process that does not read is no error of ours", async () => {
  const big = JSON.stringify({ a: "x".repeat(200_000) });
  const r = await spawnProcess("sh", ["-c", "cat"], {
    timeoutMs: 5000,
    stdin: big,
  });
  assertEquals([r.code, text(r.stdout), r.stderr], [0, big, ""]);
  const f = await spawnProcess("sh", ["-c", "exit 3"], {
    timeoutMs: 5000,
    stdin: big,
  });
  assertEquals([f.code, f.timedOut], [3, false]);
  const none = await spawnProcess("sh", ["-c", "cat; echo end"], {
    timeoutMs: 5000,
  });
  assertEquals(text(none.stdout), "end\n");
  const blob = await runCli("sh", ["-c", "printf '\\377\\000\\001'"], {
    timeoutMs: 5000,
  });
  assertEquals([...blob.stdoutBytes], [255, 0, 1]);
  const dir = await runCli("sh", ["-c", "pwd"], { cwd: "/", timeoutMs: 5000 });
  assertEquals(dir.stdout, "/\n");
});

// ---------------------------------------------------------------------------
// Negative: polls
// ---------------------------------------------------------------------------

Deno.test("slow reads count against a poll's budget", async () => {
  await withCli({ calls: [] }, async (k) => {
    const budget = pollBudget(20_000);
    let reads = 0;
    while (await budget.wait(5000)) {
      reads++;
      k.advance(7000); // each read takes seven seconds
    }
    // 5 + 7, then 5 + 7 = 24 s used: no third wait. Without the reads
    // counted there would be four.
    assertEquals(reads, 2);
    assertEquals(k.slept, [5000, 5000]);
    assertEquals(budget.usedMs(), 24_000);
    assertEquals(budget.leftMs(), 0);
    assertEquals(await budget.wait(5000), false);
  });
  await withCli({ calls: [] }, async (k) => {
    const budget = pollBudget(12_000);
    const waits: boolean[] = [];
    for (let i = 0; i < 4; i++) waits.push(await budget.wait(5000));
    // The last wait is cut to what is left, and then there is none.
    assertEquals(waits, [true, true, true, false]);
    assertEquals(k.slept, [5000, 5000, 2000]);
    assertEquals(await pollBudget(0).wait(1000), false);
  });
});

Deno.test("a wait ends when the run is cancelled", async () => {
  const abort = new AbortController();
  const p = assertRejects(
    () => sleep(60_000, abort.signal),
    Error,
    "cancelled",
  );
  abort.abort();
  await p;
  await assertRejects(() => sleep(1, abort.signal), Error, "cancelled");
  await sleep(1);
  const asked: number[] = [];
  __setSleep((ms) => {
    asked.push(ms);
    return Promise.resolve();
  });
  try {
    await sleep(60_000);
    assertEquals(asked, [60_000]);
  } finally {
    __setSleep();
  }
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

Deno.test("runCli passes input, environment, directory and limit through, and returns the output", async () => {
  await withCli({
    calls: [{
      bin: "tool",
      args: ["apply", "-f", "-"],
      stdin: { a: 1 },
      env: { TOOL_HOME: "/h" },
      clearEnv: true,
      cwd: "/work",
      timeoutMs: 300_000,
      out: { ok: true },
    }, {
      bin: "tool",
      args: ["login", "--password-stdin"],
      stdin: "plain text\n",
      timeoutMs: DEFAULT_TIMEOUT_MS,
    }],
  }, async (k) => {
    const r = await runCli("tool", ["apply", "-f", "-"], {
      stdin: '{"a":1}',
      env: { TOOL_HOME: "/h" },
      clearEnv: true,
      cwd: "/work",
      timeoutMs: 300_000,
    });
    assertEquals(parseJson(r.stdout, "tool apply"), { ok: true });
    assertEquals([r.success, r.code, r.stderr], [true, 0, ""]);
    await runCli("tool", ["login", "--password-stdin"], {
      stdin: "plain text\n",
    });
    assertEquals(k.calls.length, 2);
    assertEquals(k.calls[0].cwd, "/work");
  });
});

Deno.test("a pre-flight check passes when the binary runs and says what is wrong when it does not", async () => {
  const check = cliCheck({
    bin: (g) => String(g.toolBinary ?? "tool"),
    args: ["version"],
    description: "toolBinary runs and reports its version",
    installHint: "install tool or set toolBinary",
  });
  assertEquals([check.description, check.labels], [
    "toolBinary runs and reports its version",
    ["live"],
  ]);
  await withCli({
    calls: [
      {
        bin: "tool",
        args: ["version"],
        out: "v1",
        timeoutMs: CHECK_TIMEOUT_MS,
      },
      { bin: "/opt/tool", args: ["version"], out: "v1" },
      { bin: "tool", args: ["version"], fail: `boom password=${PASSWORD}` },
      { bin: "tool", args: ["version"], notInstalled: true },
      { bin: "tool", args: ["version"], hang: true },
      { bin: "tool", args: ["version"], code: 2, stdout: "usage on stdout" },
    ],
  }, async () => {
    assertEquals(await check.execute(), { pass: true });
    assertEquals(
      await check.execute({ globalArgs: { toolBinary: "/opt/tool" } }),
      { pass: true },
    );
    assertEquals(await check.execute({}), {
      pass: false,
      errors: ["tool version failed (exit 1): boom password=[redacted]"],
    });
    assertEquals((await check.execute()).errors, [
      "tool was not found; install tool or set toolBinary",
    ]);
    assertStringIncludes(
      (await check.execute()).errors![0],
      "no answer within 20 seconds",
    );
    assertEquals(
      await cliProblem("tool", ["version"]),
      "tool version failed (exit 2): usage on stdout",
    );
  });
  __setSpawn(() => Promise.reject(new Error("no permission")));
  try {
    assertEquals(
      await cliProblem("tool", ["version"]),
      "tool could not be run: no permission",
    );
  } finally {
    __setSpawn();
  }
});

// ---------------------------------------------------------------------------
// The fake is as strict as it says
// ---------------------------------------------------------------------------

Deno.test("the fake refuses a call that was not scripted, in any detail", async () => {
  const spawn = (
    o: Parameters<typeof fakeCli>[0],
    bin: string,
    args: string[],
    opts: Record<string, unknown> = {},
  ) =>
    Promise.resolve().then(() =>
      fakeCli(o).spawn(bin, args, { timeoutMs: 1000, ...opts })
    );
  const one = { bin: "tool", args: ["get", "x"] };
  await assertRejects(
    () => spawn({}, "tool", ["get"]),
    Error,
    "unexpected call",
  );
  await assertRejects(() => spawn({ calls: [one] }, "tool", ["get", "y"]));
  await assertRejects(() => spawn({ calls: [one] }, "tool", ["get"]));
  await assertRejects(() =>
    spawn({ calls: [one] }, "tool", ["get", "x", "-v"])
  );
  await assertRejects(() => spawn({ calls: [one] }, "other", ["get", "x"]));
  await assertRejects(
    () => spawn({ calls: [one] }, "tool", ["get", "x"], { stdin: "{}" }),
    Error,
    "standard input",
  );
  await assertRejects(
    () => spawn({ calls: [{ ...one, stdin: { a: 1 } }] }, "tool", ["get", "x"]),
    Error,
    "standard input",
  );
  await assertRejects(
    () =>
      spawn({ calls: [{ ...one, stdin: { a: 1 } }] }, "tool", ["get", "x"], {
        stdin: '{"a":2}',
      }),
  );
  await assertRejects(
    () =>
      spawn({ calls: [{ ...one, env: { A: "1" } }] }, "tool", ["get", "x"], {
        env: { A: "1", B: "2" },
      }),
    Error,
    "environment",
  );
  await assertRejects(
    () => spawn({ calls: [{ ...one, cwd: "/a" }] }, "tool", ["get", "x"]),
  );
  await assertRejects(
    () => spawn({ calls: [{ ...one, clearEnv: true }] }, "tool", ["get", "x"]),
  );
  await assertRejects(
    () => spawn({ calls: [{ ...one, timeoutMs: 5 }] }, "tool", ["get", "x"]),
  );
  await assertRejects(
    () => spawn({ calls: [one] }, "tool", ["get", "x"], { timeoutMs: 0 }),
    Error,
    "no time limit",
  );
  assertThrows(
    () => fakeCli({ calls: [one] }).done(),
    Error,
    "scripted calls left unused",
  );
  const ok = await spawn({ calls: [one] }, "tool", ["get", "x"]);
  assertEquals([ok.code, text(ok.stdout)], [0, ""]);
});

Deno.test("the fake captures, answers through a handler, and refuses flags a grammar does not know", async () => {
  await withCli({
    calls: [{ bin: "tool", args: ["patch", "-p", CAPTURE], out: "done" }],
    grammar: { tool: knownFlags(["-p", "-n", "--type="]) },
    handler: (call) =>
      call.bin === "tool" && call.args[0] === "version"
        ? { out: "v1" }
        : undefined,
  }, async (k) => {
    assertEquals((await runCli("tool", ["version"])).stdout, "v1");
    assertEquals(
      (await runCli("tool", ["patch", "-p", '{"a":1}'])).stdout,
      "done",
    );
    assertEquals(k.captured, ['{"a":1}']);
    await assertRejects(
      () => runCli("tool", ["get", "--all"]),
      Error,
      "unknown flag --all",
    );
    await assertRejects(
      () => runCli("tool", ["get", "--types=x"]),
      Error,
      "unknown flag --types=x",
    );
    // Known flags, but neither scripted nor handled.
    await assertRejects(
      () => runCli("tool", ["get", "-n", "x", "--type=a", "--", "-free"]),
      Error,
      "unexpected call",
    );
    assertEquals(k.calls.length, 2);
  });
  for (const bad of HOSTILE.filter((h) => h.startsWith("-"))) {
    assertThrows(() =>
      knownFlags(["-n"])({ bin: "tool", args: ["get", bad], timeoutMs: 1 })
    );
  }
});

Deno.test("the fake captures standard input where the script says so, and refuses a call that gives none", async () => {
  await withCli({
    calls: [
      { bin: "tool", args: ["patch", "-f", "-"], stdin: CAPTURE, out: "ok" },
      { bin: "tool", args: ["patch", "-f", "-"], stdin: CAPTURE, out: "ok" },
    ],
  }, async (k) => {
    await runCli("tool", ["patch", "-f", "-"], { stdin: '{"at":"now"}' });
    assertEquals(k.captured, ['{"at":"now"}']);
    await assertRejects(
      () => runCli("tool", ["patch", "-f", "-"]),
      Error,
      "no standard input to capture",
    );
  });
});

Deno.test("a wait that is cancelled rejects with a CliError of kind cancelled, and its message is unchanged", async () => {
  const abort = new AbortController();
  const during = assertRejects(() => sleep(60_000, abort.signal), CliError);
  abort.abort();
  const before = await assertRejects(() => sleep(1, abort.signal), CliError);
  for (const e of [await during, before, cancelledError()]) {
    assertEquals([e.kind, e.message, e.code, e.stderr], [
      "cancelled",
      "cancelled",
      null,
      "",
    ]);
    assert(isCliError(e, "cancelled"));
    assert(e instanceof Error);
  }
  // A poll: the wait between two reads ends the loop with the same error,
  // with the real sleep and with the fake's.
  await assertRejects(
    () => pollBudget(60_000).wait(5000, abort.signal),
    CliError,
    "cancelled",
  );
  await withCli({ calls: [] }, async (k) => {
    const e = await assertRejects(
      () => pollBudget(60_000).wait(5000, abort.signal),
      CliError,
    );
    assert(isCliError(e, "cancelled"));
    assertEquals(k.slept, []);
  });
});

Deno.test("a time limit longer than a timer can count is refused before a spawn", async () => {
  await withCli({ calls: [] }, async (k) => {
    await assertRejects(
      () => tryCli("tool", ["build"], { timeoutMs: MAX_TIMEOUT_MS + 1 }),
      Error,
      "longer than a timer can count",
    );
    assertEquals(k.calls.length, 0);
  });
});

// ---------------------------------------------------------------------------
// Additions: the output bound, the clock, data names, appliesTo
// ---------------------------------------------------------------------------

const ENDLESS =
  "while :; do echo aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa; done";

Deno.test("a process that prints without end is stopped at the output bound, and nothing past it is kept", async () => {
  const started = Date.now();
  const r = await spawnProcess("sh", ["-c", ENDLESS], {
    timeoutMs: 20_000,
    graceMs: 300,
    maxOutputBytes: 100_000,
  });
  assertEquals([r.tooLarge, r.timedOut, r.cancelled], [true, false, false]);
  assertEquals(r.stdout.length, 100_000);
  assertEquals(r.stderr, "");
  assert(Date.now() - started < 5000, "it was not stopped at the bound");
  // One bound for both streams together.
  const both = await spawnProcess(
    "sh",
    ["-c", `${ENDLESS} & while :; do echo eeeeeeeeeeeeeee >&2; done`],
    { timeoutMs: 20_000, graceMs: 300, maxOutputBytes: 50_000 },
  );
  assertEquals(both.tooLarge, true);
  assert(both.stdout.length > 0 && both.stderr.length > 0);
  assertEquals(both.stdout.length + both.stderr.length, 50_000);
});

Deno.test("a process that goes on after its output was cut is stopped, even when it ignores SIGTERM", async () => {
  const started = Date.now();
  // It ignores the closed pipe and SIGTERM: only SIGKILL ends it.
  const r = await spawnProcess(
    "sh",
    ["-c", `trap '' PIPE TERM; ${ENDLESS} 2>/dev/null`],
    { timeoutMs: 20_000, graceMs: 300, maxOutputBytes: 10_000 },
  );
  assertEquals([r.tooLarge, r.timedOut], [true, false]);
  assertEquals(r.stdout.length, 10_000);
  assert(Date.now() - started < 5000, "the process was left running");
});

Deno.test("output up to the bound is read whole, and without a bound everything is", async () => {
  const exact = await spawnProcess("sh", ["-c", "printf 0123456789"], {
    timeoutMs: 5000,
    maxOutputBytes: 10,
  });
  assertEquals(exact, {
    code: 0,
    stdout: new TextEncoder().encode("0123456789"),
    stderr: "",
    timedOut: false,
    cancelled: false,
  });
  const over = await spawnProcess("sh", ["-c", "printf 0123456789; sleep 6"], {
    timeoutMs: 20_000,
    graceMs: 300,
    maxOutputBytes: 9,
  });
  assertEquals([over.tooLarge, text(over.stdout)], [true, "012345678"]);
  const big = "x".repeat(300_000);
  const free = await spawnProcess("sh", ["-c", "cat"], {
    timeoutMs: 5000,
    stdin: big,
  });
  assertEquals([free.tooLarge, free.stdout.length], [undefined, 300_000]);
});

Deno.test("runCli names an output past the bound as too-large; tryCli returns the marked result", async () => {
  const e = await assertRejects(
    () =>
      runCli("sh", ["-c", ENDLESS], {
        timeoutMs: 20_000,
        maxOutputBytes: 5000,
        what: "sh loop",
      }),
    CliError,
  );
  assertEquals([e.kind, e.code, e.bin], ["too-large", null, "sh"]);
  assertStringIncludes(
    e.message,
    "sh loop failed: more than 5000 bytes of output; the process was stopped",
  );
  assertFalse(e.message.includes("aaaa"));
  assert(isCliError(e, "too-large"));
  const r = await tryCli("sh", ["-c", ENDLESS], {
    timeoutMs: 20_000,
    maxOutputBytes: 5000,
  });
  assertEquals([r.success, r.tooLarge, r.timedOut, r.cancelled], [
    false,
    true,
    false,
    false,
  ]);
  assertEquals(r.stdoutBytes.length, 5000);
  assertEquals(r.stdout.length, 5000);
  assertEquals(cliError("sh", [], r, { what: "sh loop" }).kind, "too-large");
  // A normal answer has no mark at all.
  const ok = await tryCli("sh", ["-c", "echo hi"], { timeoutMs: 5000 });
  assertEquals("tooLarge" in ok, false);
});

Deno.test("every call has an output bound: 64 MiB unless it sets its own, and never zero", async () => {
  assertEquals(DEFAULT_MAX_OUTPUT_BYTES, 64 * 1024 * 1024);
  await withCli({
    calls: [
      { bin: "tool", args: ["a"], maxOutputBytes: DEFAULT_MAX_OUTPUT_BYTES },
      { bin: "tool", args: ["b"], maxOutputBytes: 1000 },
      { bin: "tool", args: ["c"], maxOutputBytes: Infinity },
    ],
  }, async (k) => {
    await runCli("tool", ["a"]);
    await runCli("tool", ["b"], { maxOutputBytes: 1000 });
    await runCli("tool", ["c"], { maxOutputBytes: Infinity });
    assertEquals(k.calls.map((c) => c.maxOutputBytes), [
      DEFAULT_MAX_OUTPUT_BYTES,
      1000,
      Infinity,
    ]);
    for (const bad of [0, -1, NaN, "9" as unknown as number]) {
      await assertRejects(
        () => tryCli("tool", ["d"], { maxOutputBytes: bad }),
        Error,
        "output bound above zero",
      );
    }
    assertEquals(k.calls.length, 3);
  });
});

Deno.test("the fake scripts an over-long output: by its real length, or by a mark", async () => {
  await withCli({
    calls: [
      { bin: "tool", args: ["a"], out: "x".repeat(50) },
      { bin: "tool", args: ["a"], out: "x".repeat(50) },
      {
        bin: "tool",
        args: ["b"],
        code: 2,
        stdout: "o".repeat(8),
        fail: "eeeeee",
      },
      { bin: "tool", args: ["c"], out: "short", tooLarge: true },
      { bin: "tool", args: ["d"], maxOutputBytes: 7, out: "1234567" },
    ],
  }, async () => {
    assertEquals(
      (await runCli("tool", ["a"], { maxOutputBytes: 50 })).stdout.length,
      50,
    );
    const cut = await tryCli("tool", ["a"], { maxOutputBytes: 20 });
    assertEquals([cut.tooLarge, cut.success, cut.code, cut.stdout], [
      true,
      false,
      null,
      "x".repeat(20),
    ]);
    const both = await tryCli("tool", ["b"], { maxOutputBytes: 10 });
    assertEquals([both.tooLarge, both.stdout, both.stderr], [
      true,
      "oooooooo",
      "ee",
    ]);
    const marked = await assertRejects(() => runCli("tool", ["c"]), CliError);
    assertEquals(marked.kind, "too-large");
    assertStringIncludes(marked.message, `${DEFAULT_MAX_OUTPUT_BYTES} bytes`);
    assertEquals(
      (await runCli("tool", ["d"], { maxOutputBytes: 7 })).stdout,
      "1234567",
    );
  });
  // The bound a scripted call expects is checked.
  await assertRejects(() =>
    Promise.resolve().then(() =>
      fakeCli({ calls: [{ bin: "tool", args: [], maxOutputBytes: 7 }] }).spawn(
        "tool",
        [],
        { timeoutMs: 1000, maxOutputBytes: 8 },
      )
    )
  );
});

Deno.test("now is the clock a test controls", async () => {
  const real = now();
  assert(Math.abs(real - Date.now()) < 1000);
  await withCli({ calls: [] }, async (k) => {
    const start = now();
    k.advance(1500);
    assertEquals(now() - start, 1500);
    const budget = pollBudget(10_000);
    await budget.wait(2000);
    assertEquals(now() - start, 1500, "a fake wait moves no clock");
    assertEquals(budget.usedMs(), 2000);
  });
  assert(now() >= real);
});

/** The reverse of `encodedName`; it exists only if the encoding is injective. */
function decodedName(name: string): string {
  let text = "";
  for (let i = 0; i < name.length;) {
    if (name[i] !== "_") {
      text += name[i++];
    } else if (name[i + 1] === "u") {
      text += String.fromCharCode(parseInt(name.slice(i + 2, i + 6), 16));
      i += 6;
    } else {
      const bytes: number[] = [];
      while (name[i] === "_" && name[i + 1] !== "u") {
        bytes.push(parseInt(name.slice(i + 1, i + 3), 16));
        i += 3;
      }
      text += new TextDecoder().decode(new Uint8Array(bytes));
    }
  }
  return text;
}

/** Texts built to collide: every string up to four of these pieces. */
function generated(): string[] {
  const pieces = [
    ".",
    "_",
    "-",
    "a",
    "A",
    "0",
    "/",
    "\\",
    "\0",
    " ",
    "é",
    "2e",
    "_2e",
    ":",
    "\ud800",
  ];
  let level = [""];
  const all: string[] = [];
  for (let n = 0; n < 4; n++) {
    level = level.flatMap((s) => pieces.map((p) => s + p));
    all.push(...level);
  }
  return [...new Set([...all, ...HOSTILE, "�", "😀", "\ude00\ud83d"])];
}

Deno.test("encodedName writes every other character as its bytes, and dots so that none leads or doubles", () => {
  const cases: Array<[string, string]> = [
    [
      "registry.example.org/team/app:v1.2",
      "registry.example.org_2fteam_2fapp_3av1.2",
    ],
    ["a_b", "a_5fb"],
    ["/srv/repo", "_2fsrv_2frepo"],
    [".", "_2e"],
    ["..", "_2e."],
    ["...", "_2e._2e"],
    [".git", "_2egit"],
    ["a..b", "a._2eb"],
    ["a...b", "a._2e.b"],
    ["a.b.c", "a.b.c"],
    ["../etc", "_2e._2fetc"],
    ["a/../b", "a_2f._2e_2fb"],
    ["a/.b", "a_2f.b"],
    ["é", "_c3_a9"],
    ["😀", "_f0_9f_98_80"],
    ["a\0b\\c", "a_00b_5cc"],
    ["A-z.0", "A-z.0"],
    ["\ud800", "_ud800"],
    ["�", "_ef_bf_bd"],
    ["", ""],
  ];
  for (const [text, name] of cases) assertEquals(encodedName(text), name, text);
});

Deno.test("encodedName is injective and never breaks the data store's rule", () => {
  const texts = generated();
  assert(texts.length > 50_000, String(texts.length));
  const seen = new Map<string, string>();
  for (const t of texts) {
    const name = encodedName(t);
    const other = seen.get(name);
    if (other !== undefined) {
      throw new Error(
        `${JSON.stringify(other)} and ${JSON.stringify(t)} are both ${name}`,
      );
    }
    seen.set(name, t);
    if (
      !/^[A-Za-z0-9._-]*$/.test(name) || name.startsWith(".") ||
      name.includes("..")
    ) {
      throw new Error(`${JSON.stringify(t)} became ${name}`);
    }
    if (decodedName(name) !== t) {
      throw new Error(`${JSON.stringify(t)} does not come back from ${name}`);
    }
    if (t !== "") assertDataName(name, "generated");
  }
  // Where no dot leads or doubles and the text is well-formed, the name is
  // the plain escape of every character outside [A-Za-z0-9.-].
  const plain = (t: string) =>
    t.replace(
      /[^A-Za-z0-9.-]/gu,
      (c) =>
        [...new TextEncoder().encode(c)].map((b) =>
          `_${b.toString(16).padStart(2, "0")}`
        ).join(""),
    );
  let same = 0;
  for (const t of texts) {
    if (t.startsWith(".") || t.includes("..") || !t.isWellFormed()) continue;
    assertEquals(encodedName(t), plain(t), t);
    same++;
  }
  assert(same > 10_000);
});

Deno.test("assertDataName refuses a name the data store cannot hold, with a bounded message", () => {
  for (
    const ok of [
      "a",
      "a.b-c_5f",
      "x".repeat(MAX_DATA_NAME_BYTES),
      "inventory_all",
    ]
  ) {
    assertDataName(ok, "record");
  }
  assertEquals(MAX_DATA_NAME_BYTES, 255);
  const cases: Array<[string, string]> = [
    ["", "it is empty"],
    ["x".repeat(256), "it is 256 bytes, more than the 255"],
    ["é".repeat(128), "it is 256 bytes"],
    [".", "'..' or is '.'"],
    ["..", "'..' or is '.'"],
    ["a..b", "'..' or is '.'"],
    ["a/b", "'/', '\\' or a NUL"],
    ["a\\b", "'/', '\\' or a NUL"],
    ["a\0b", "'/', '\\' or a NUL"],
  ];
  for (const [name, why] of cases) {
    const e = assertThrows(
      () => assertDataName(name, "the record of x"),
      Error,
    );
    assertStringIncludes(e.message, "the record of x ");
    assertStringIncludes(e.message, "cannot be a data name: ");
    assertStringIncludes(e.message, why);
    assert(e.message.length < 250, String(e.message.length));
  }
  assertThrows(
    () => assertDataName(7 as unknown as string, "x"),
    Error,
    "empty",
  );
  // The bound is on bytes: a long text is refused after encoding, not cut.
  const long = encodedName("/".repeat(86));
  assertEquals(long.length, 258);
  assertThrows(() => assertDataName(long, "path"), Error, "258 bytes");
  assertDataName(encodedName("/".repeat(85)), "path");
});

Deno.test("cliCheck carries appliesTo when given, and has none otherwise", async () => {
  const methods = ["lookup", "ensure"];
  const scoped = cliCheck({
    bin: "tool",
    args: ["version"],
    description: "tool runs",
    appliesTo: methods,
  });
  assertEquals(scoped.appliesTo, ["lookup", "ensure"]);
  methods.push("later");
  assertEquals(scoped.appliesTo, ["lookup", "ensure"]);
  assertEquals(Object.keys(scoped), [
    "description",
    "labels",
    "appliesTo",
    "execute",
  ]);
  const plain = cliCheck({ bin: "tool", args: ["version"], description: "d" });
  assertEquals("appliesTo" in plain, false);
  assertEquals(Object.keys(plain), ["description", "labels", "execute"]);
  await withCli({
    calls: [{ bin: "tool", args: ["version"], out: "v1" }],
  }, async () => {
    assertEquals(await scoped.execute(), { pass: true });
  });
});
