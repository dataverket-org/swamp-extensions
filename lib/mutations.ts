/**
 * Mutation check of the shared layers: each safety property is switched off
 * in a copy of this directory, and the tests must then fail. A mutation the
 * tests survive means the property is not pinned. The files here are never
 * changed; every mutation is made in a temporary copy.
 *
 * Run: `deno task mutations` (all), or with `cli` or `kubectl` to run the
 * mutations of one file.
 */

/** One safety property and the edit that switches it off. */
interface Mutation {
  file: "cli.ts" | "kubectl.ts" | "kubectl_fake.ts";
  property: string;
  find: string;
  replace: string;
}

const MUTATIONS: Mutation[] = [
  {
    file: "cli.ts",
    property: "process stopped at its time limit",
    find: `  timers.push(setTimeout(() => {
    if (!stopping) timedOut = true;
    stop();
  }, opts.timeoutMs));`,
    replace: "",
  },
  {
    file: "cli.ts",
    property: "SIGKILL after SIGTERM is ignored",
    find: `kill("SIGKILL");`,
    replace: "",
  },
  {
    file: "cli.ts",
    property: "pipes let go when a child keeps them open",
    find: `        out.cancel();
        err.cancel();`,
    replace: "",
  },
  {
    file: "cli.ts",
    property: "cancelled run stops the process",
    find: `opts.signal?.addEventListener("abort", onCancel, { once: true });`,
    replace: "",
  },
  {
    file: "cli.ts",
    property: "redaction of credential-shaped text",
    find: `  let out = text;
  const literal`,
    replace: `  if (secrets) return text;
  let out = text;
  const literal`,
  },
  {
    file: "cli.ts",
    property: "redaction of the caller's literal secrets",
    find: `for (const s of literal) out = out.split(s).join("[redacted]");`,
    replace: "",
  },
  {
    file: "cli.ts",
    property: "noise lines dropped",
    find: `const own = lines.filter((l) => !noise(l));`,
    replace: `const own = lines;`,
  },
  {
    file: "cli.ts",
    property: "message is one bounded line",
    find: "return line.length > max ? `${line.slice(0, max)}...` : line;",
    replace: "return line;",
  },
  {
    file: "cli.ts",
    property: "positional argument may not start with a dash",
    find: `value === "" || value.startsWith("-") ||`,
    replace: `value === "" ||`,
  },
  {
    file: "cli.ts",
    property: "arguments may not hold a line break",
    find: `const CONTROL = /[\\0\\r\\n]/;`,
    replace: `const CONTROL = /[\\0]/;`,
  },
  {
    file: "cli.ts",
    property: "standard output kept out of errors by default",
    find: `(opts.stdoutInError ? brief(result.stdout, 400, opts.secrets) : "")`,
    replace: `brief(result.stdout, 400, opts.secrets)`,
  },
  {
    file: "cli.ts",
    property: "exit code decides success",
    find: `success: result.code === 0 && !timedOut && !cancelled,`,
    replace: `success: true,`,
  },
  {
    file: "cli.ts",
    property: "missing binary is named",
    find: `if (err instanceof Deno.errors.NotFound) {
      throw new CliError(`,
    replace: `if (err === undefined) {
      throw new CliError(`,
  },
  {
    file: "cli.ts",
    property: "time limit is required to be above zero",
    find: `if (!(Number.isFinite(timeoutMs) && timeoutMs > 0)) {`,
    replace: `if (timeoutMs === undefined) {`,
  },
  {
    file: "cli.ts",
    property: "slow reads count against a poll",
    find: `used += Math.max(0, now - mark);`,
    replace: `used += 0;`,
  },
  {
    file: "cli.ts",
    property: "output that is not JSON does not show the output",
    find: "`${text.length} characters of output`",
    replace: "text",
  },
  {
    file: "kubectl.ts",
    property: "name check",
    find: `if (typeof value !== "string" || !OBJECT_NAME.test(value)) {`,
    replace: `if (typeof value !== "string") {`,
  },
  {
    file: "kubectl.ts",
    property: "namespace check",
    find: `if (typeof value !== "string" || !NAMESPACE_NAME.test(value)) {`,
    replace: `if (typeof value !== "string") {`,
  },
  {
    file: "kubectl.ts",
    property: "builders check the name themselves",
    find: `  checkResource(resource);
  checkName(name);`,
    replace: `  checkResource(resource);`,
  },
  {
    file: "kubectl.ts",
    property: "empty namespace argument counts as not given",
    find: `const ns = argNamespace || globalNamespace || "";
  return ns === ""`,
    replace: `const ns = argNamespace ?? globalNamespace ?? "";
  return ns === ""`,
  },
  {
    file: "kubectl.ts",
    property: "client-go log lines stripped",
    find: `      noise: isClientGoLogLine,`,
    replace: "",
  },
  {
    file: "kubectl.ts",
    property: "failure classification",
    find: `const kind = classifyStderr(stderr);`,
    replace:
      `const kind: KubectlFailure = stderr === "\\0" ? "timeout" : "other";`,
  },
  {
    file: "kubectl.ts",
    property: "expired token without (Unauthorized) is unauthorized",
    find: `    has(/You must be logged in to the server/) ||
    has(/the server has asked for the client to provide credentials/) ||`,
    replace: "",
  },
  {
    file: "kubectl.ts",
    property: "exit status decides before standard output is read",
    find: `  if (!result.success) {
    throw kubectlFailure(args, result.stderr, opts.secrets);
  }`,
    replace: "",
  },
  {
    file: "kubectl.ts",
    property: "request timeout on every call",
    find: "      `--request-timeout=${requestTimeoutOf(opts)}s`,\n",
    replace: "",
  },
  {
    file: "kubectl.ts",
    property: "kubectl process killed a little after the request timeout",
    find: `      timeoutMs: killAfterMs,
      signal: opts.signal,`,
    replace: `      timeoutMs: 3_600_000,
      signal: opts.signal,`,
  },
  {
    file: "kubectl.ts",
    property: "patch body kept out of errors",
    find: `      named.push(a, "<patch>");
      i++;`,
    replace: `      named.push(a);`,
  },
  {
    file: "kubectl.ts",
    property: "standard output kept out of the not-JSON error",
    find: "`${text.length} characters of output`",
    replace: "text",
  },
  {
    file: "kubectl.ts",
    property: "colliding data names refused",
    find: `if (other !== undefined && other !== id) {`,
    replace: `if (other !== undefined && other === "\\0") {`,
  },
  {
    file: "kubectl.ts",
    property: "an answer that is not a List is refused",
    find: `if (!kind.endsWith("List") || !Array.isArray(list.items)) {`,
    replace: `if (!Array.isArray(list.items)) {`,
  },
  {
    file: "kubectl.ts",
    property: "the caller's secrets blanked in a kubectl error",
    find: `      secrets: opts.secrets,
      noise: isClientGoLogLine,`,
    replace: `      noise: isClientGoLogLine,`,
  },
  {
    file: "kubectl.ts",
    property: "the caller's secrets blanked in the command a message names",
    find: `return brief(named.join(" "), 200, secrets);`,
    replace: `return brief(named.join(" "), 200);`,
  },
  {
    file: "kubectl.ts",
    property: "the check runs the binary the type names",
    find: `  return cliCheck({
    bin,`,
    replace: `  return cliCheck({
    bin: KUBECTL,`,
  },
  {
    file: "kubectl_fake.ts",
    property: "the fake refuses an unknown flag on a text call",
    find: `      refuse(\`unknown flag for \${label}: \${a}\`, args);`,
    replace: `      positional.push(a);`,
  },
  {
    file: "kubectl_fake.ts",
    property: "the fake refuses a text command the test did not declare",
    find: `  if (spec === undefined) {`,
    replace: `  if (spec === undefined && cmd.length === 0) {`,
  },
  {
    file: "kubectl.ts",
    property: "a call's own request timeout sets the flag",
    find: "      `--request-timeout=${requestTimeoutOf(opts)}s`,",
    replace: "      REQUEST_TIMEOUT_FLAG,",
  },
  {
    file: "kubectl.ts",
    property: "a call's own request timeout moves the process stop",
    find: `      timeoutMs: killAfterMs,
      signal: opts.signal,`,
    replace: `      timeoutMs: KUBECTL_KILL_AFTER_MS,
      signal: opts.signal,`,
  },
  {
    file: "kubectl.ts",
    property: "a request timeout out of range is refused",
    find: `    seconds > MAX_REQUEST_TIMEOUT_SECONDS
  ) {
    throw new Error(`,
    replace: `    seconds > 1e12
  ) {
    throw new Error(`,
  },
  {
    file: "kubectl.ts",
    property: "the worst case of a call counts both grace periods",
    find: `  return kubectlKillAfterMs(opts) + 2 * KILL_GRACE_MS;`,
    replace: `  return kubectlKillAfterMs(opts);`,
  },
  {
    file: "kubectl.ts",
    property: "the word Forbidden inside another message is not a refusal",
    find: `has(/^Error from server \\(Forbidden\\)/m)`,
    replace: `has(/\\(Forbidden\\)/)`,
  },
  {
    file: "cli.ts",
    property: "a cancelled wait has the kind cancelled",
    find: `      clearTimeout(timer);
      reject(cancelledError());`,
    replace: `      clearTimeout(timer);
      reject(new Error("cancelled"));`,
  },
  {
    file: "kubectl_fake.ts",
    property: "the fake tells a call with its own limit from a default one",
    find: `  return seconds === REQUEST_TIMEOUT_SECONDS
    ? []`,
    replace: `  return seconds > 0
    ? []`,
  },
  {
    file: "kubectl_fake.ts",
    property: "the fake ties the request timeout flag to the kill time",
    find: "  want.push(`--request-timeout=${seconds}s`);",
    replace:
      "  want.push(rest[want.length] ?? `--request-timeout=${seconds}s`);",
  },
  {
    file: "kubectl.ts",
    property: "condition messages redacted",
    find: `message: message === null ? null : redact(message),`,
    replace: `message,`,
  },
];

const here = new URL(".", import.meta.url).pathname;
const only = Deno.args[0];
const chosen = MUTATIONS.filter((m) =>
  only === undefined || m.file === `${only}.ts`
);
const files: string[] = [];
for await (const entry of Deno.readDir(here)) {
  if (entry.isFile && /\.(ts|json|lock)$/.test(entry.name)) {
    files.push(entry.name);
  }
}

/** Run the tests in `dir`; the first failing test's name when they fail. */
async function test(dir: string): Promise<{ ok: boolean; failed?: string }> {
  const out = await new Deno.Command(Deno.execPath(), {
    args: ["test", "--no-check", "--allow-run=sh", "--fail-fast"],
    cwd: dir,
    env: { NO_COLOR: "1" },
    stdout: "piped",
    stderr: "piped",
  }).output();
  const text = new TextDecoder().decode(out.stdout);
  const line = text.split("\n").find((l) => l.includes("... FAILED"));
  return { ok: out.success, failed: line?.replace(/ \.\.\. FAILED.*/, "") };
}

// A mutation only counts as killed when the tests pass without it.
const baseline = await test(here);
if (!baseline.ok) {
  console.log(
    `The tests fail before any mutation (${
      baseline.failed ?? "the run did not start"
    }); nothing was checked.`,
  );
  Deno.exit(1);
}

let survived = 0;
for (const m of chosen) {
  const dir = await Deno.makeTempDir({ prefix: "lib-mutation-" });
  try {
    for (const f of files) await Deno.copyFile(`${here}${f}`, `${dir}/${f}`);
    const source = await Deno.readTextFile(`${dir}/${m.file}`);
    if (!source.includes(m.find)) {
      console.log(`NOT APPLIED  ${m.file}: ${m.property}`);
      survived++;
      continue;
    }
    await Deno.writeTextFile(
      `${dir}/${m.file}`,
      source.replace(m.find, m.replace),
    );
    const run = await test(dir);
    const failed = run.failed;
    if (run.ok) {
      survived++;
      console.log(`SURVIVED     ${m.file}: ${m.property}`);
    } else {
      console.log(
        `killed       ${m.file}: ${m.property}\n             by: ${
          failed ?? "(the run did not start)"
        }`,
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
}
console.log(
  `${chosen.length - survived} of ${chosen.length} mutations killed`,
);
if (survived > 0) Deno.exit(1);
