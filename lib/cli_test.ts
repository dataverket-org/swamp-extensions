/**
 * Tests of the shared process layer. They run once, here in `lib/`, not in
 * every extension: its pure functions, and the real spawn against `sh`.
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
  assertDataName,
  brief,
  CliError,
  cliError,
  describeArgs,
  encodedName,
  isCliError,
  MAX_DATA_NAME_BYTES,
  parseJson,
  positionalArg,
  redact,
  runCli,
  safeStderr,
  shown,
  spawnProcess,
  STDERR_LIMIT,
  tryCli,
  valueArg,
  withoutNoise,
} from "./cli.ts";
import { HOSTILE } from "./test_inputs.ts";

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
