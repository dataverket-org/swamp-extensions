/**
 * Test support for `@dataverket/renovate/local`: a strict grammar of the
 * container commands the type runs, on the shared fake of
 * `../lib/cli_fake.ts`; a fake machine that answers them; Renovate output as
 * the real one prints it; repository directories on a real temporary disk;
 * and a method context that keeps what was logged and written. Test-only;
 * the model does not import it.
 *
 * @module
 */
import { CHECK_TIMEOUT_MS } from "../lib/cli.ts";
import {
  type Answer,
  type FakeCli,
  type FakeTime,
  type Grammar,
  type SpawnedCall,
  withCli,
} from "../lib/cli_fake.ts";
import {
  type Context,
  type GlobalArgs,
  GlobalArgsSchema,
  model,
  QUERY_TIMEOUT_MS,
  REMOVE_TIMEOUT_MS,
} from "./local.ts";

/** The image every test names. */
export const IMAGE = "registry.example/renovate:44.0.0";

/** A marker no record, log line or error may ever hold. */
export const PLANTED = "hunter2-planted-secret";

function refuse(bin: string, why: string, args: string[]): never {
  throw new Error(`fake ${bin}: ${why} (${bin} ${args.join(" ")})`);
}

const same = (a: string[], b: string[]) =>
  JSON.stringify(a) === JSON.stringify(b);

const NAME = /^renovate-local-[0-9a-f]{12}$/;
const IMAGE_REF = /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/;
const MOUNT = /^type=bind,source=(\/[^,]*),target=\/repo,readonly$/;

/** What a run was asked to do, read back from its arguments. */
export type Run = {
  name: string;
  directory: string;
  userns?: string;
  /** Podman's own limit, in seconds; absent on another engine. */
  timeout?: number;
  /** `--http-proxy=<value>`; absent on another engine. */
  httpProxy?: string;
  network?: string;
  logLevel: string;
  image: string;
};

/** The parts of a `run` command line, or a refusal of anything else. */
export function parseRun(bin: string, a: string[]): Run {
  const no = (why: string) => refuse(bin, why, a);
  let i = 0;
  const take = (...words: string[]) => {
    for (const w of words) if (a[i++] !== w) no(`expected ${w} at ${i - 1}`);
  };
  take("run", "--rm", "--pull=never", "--name");
  const name = a[i++] ?? "";
  if (!NAME.test(name)) no("the container has no name of this type");
  let timeout: number | undefined;
  if (a[i] === "--timeout") {
    if (!/^[1-9][0-9]*$/.test(a[i + 1] ?? "")) no("--timeout is no number");
    timeout = Number(a[i + 1]);
    i += 2;
  }
  let httpProxy: string | undefined;
  const proxy = /^--http-proxy=(true|false)$/.exec(a[i] ?? "");
  if (proxy) {
    httpProxy = proxy[1];
    i++;
  }
  let network: string | undefined;
  if (a[i] === "--network") {
    network = a[i + 1];
    if (!/^[A-Za-z0-9][A-Za-z0-9_.:=,\/-]*$/.test(network ?? "")) {
      no("--network is not a network");
    }
    i += 2;
  }
  let userns: string | undefined;
  if (a[i] === "--userns") {
    userns = a[i + 1];
    if (!/^keep-id:uid=\d+$/.test(userns ?? "")) no("--userns is not keep-id");
    i += 2;
  }
  take("--mount");
  const mount = MOUNT.exec(a[i++] ?? "");
  if (!mount) no("the mount is not one read-only bind of an absolute path");
  // Renovate always runs at debug: only there does it say which
  // configuration file it read.
  take("--workdir", "/repo", "--env", "LOG_LEVEL=debug");
  take("--env", "LOG_FORMAT=json");
  const image = a[i++] ?? "";
  if (!IMAGE_REF.test(image)) no("the image is not an image reference");
  take("--platform=local", "--dry-run=lookup", "--report-type=logging");
  if (i !== a.length) no("arguments after the last one this type gives");
  return {
    name,
    directory: mount![1],
    userns,
    timeout,
    httpProxy,
    network,
    logLevel: "debug",
    image,
  };
}

/**
 * The container engine as this type drives it: six commands, word for word,
 * each with the time limit that is its own, no input and no environment.
 */
export function engineGrammar(
  bin: string,
  limits: { runMs: number; pullMs: number },
): Grammar {
  return (call) => {
    const a = call.args;
    const no = (why: string) => refuse(bin, why, a);
    if (call.env !== undefined || call.clearEnv !== undefined) {
      no("a call takes no environment of its own");
    }
    if (call.stdin !== undefined) {
      no("input given to a command that reads none");
    }
    if (call.cwd !== undefined) no("a call takes no working directory");
    const limit = (ms: number) => {
      if (call.timeoutMs !== ms) no(`time limit ${call.timeoutMs}, not ${ms}`);
    };
    if (same(a, ["--version"])) {
      if (call.timeoutMs !== CHECK_TIMEOUT_MS) limit(QUERY_TIMEOUT_MS);
      return;
    }
    if (same(a, ["info", "--format", "{{.Host.Security.Rootless}}"])) {
      return limit(QUERY_TIMEOUT_MS);
    }
    if (
      a.length === 5 &&
      same(a.slice(0, 4), ["image", "inspect", "--format", "{{.Config.User}}"])
    ) {
      if (!IMAGE_REF.test(a[4])) no("the image is not an image reference");
      return limit(QUERY_TIMEOUT_MS);
    }
    if (a.length === 2 && a[0] === "pull") {
      if (!IMAGE_REF.test(a[1])) no("the image is not an image reference");
      return limit(limits.pullMs);
    }
    if (a.length === 3 && a[0] === "rm" && a[1] === "--force") {
      if (!NAME.test(a[2])) no("rm of a container this type did not name");
      return limit(REMOVE_TIMEOUT_MS);
    }
    if (a[0] === "run") {
      parseRun(bin, a);
      return limit(limits.runMs);
    }
    no("unknown command");
  };
}

/** The fake machine: what the engine is and how each directory's run ends. */
export type World = {
  /** What `--version` prints. Rootless Podman when left out. */
  version?: string;
  /** What `info` prints for rootless; `true` when left out. */
  rootless?: string;
  /** What `image inspect` prints, or its failure. `12021` when left out. */
  inspect?: Answer[];
  /** The answer of `pull`; a success when left out. */
  pull?: Answer;
  /** The answer of `run`, by the directory mounted. */
  runs?: Record<string, Answer>;
  /** The answer of `rm --force`; a success when left out. */
  rm?: Answer;
  /** The binary is not there. */
  notInstalled?: boolean;
  /** Called as each run starts, for a test that cancels in between. */
  onRun?: (run: Run) => void;
};

/** What a test holds besides the fake: the runs that were started. */
export type Machine = FakeCli & FakeTime & { runs: Run[] };

/** Run `body` on a fake machine with the strict grammar. */
export function withEngine<T>(
  world: World,
  g: GlobalArgs,
  body: (m: Machine) => Promise<T>,
): Promise<T> {
  const bin = g.containerBinary;
  const runs: Run[] = [];
  const inspects = [...(world.inspect ?? [])];
  const handler = (call: SpawnedCall): Answer | undefined => {
    if (call.bin !== bin) return undefined;
    if (world.notInstalled) return { notInstalled: true };
    const a = call.args;
    if (a[0] === "--version") {
      return { out: world.version ?? "podman version 4.9.3\n" };
    }
    if (a[0] === "info") return { out: `${world.rootless ?? "true"}\n` };
    if (a[0] === "image") return inspects.shift() ?? { out: "12021\n" };
    if (a[0] === "pull") return world.pull ?? {};
    if (a[0] === "rm") return world.rm ?? { out: `${a[2]}\n` };
    if (a[0] === "run") {
      const run = parseRun(bin, a);
      runs.push(run);
      world.onRun?.(run);
      const answer = world.runs?.[run.directory];
      if (answer === undefined) {
        throw new Error(`fake ${bin}: no answer for a run on ${run.directory}`);
      }
      return answer;
    }
    return undefined;
  };
  return withCli({
    handler,
    grammar: {
      [bin]: engineGrammar(bin, {
        runMs: g.timeoutSeconds * 1000,
        pullMs: g.pullTimeoutSeconds * 1000,
      }),
    },
  }, (k) => body({ ...k, runs }));
}

// ---------------------------------------------------------------------------
// Renovate's output
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** One dependency as Renovate reports it, with what a test changes. */
export function dep(over: Json = {}): Json {
  return {
    depName: "alpine",
    packageName: "alpine",
    currentValue: "3.18.0",
    datasource: "docker",
    depType: "final",
    updates: [],
    versioning: "docker",
    warnings: [],
    currentVersion: "3.18.0",
    ...over,
  };
}

/** One proposed update as Renovate reports it. */
export function update(over: Json = {}): Json {
  return {
    bucket: "non-major",
    newVersion: "3.24.4",
    newValue: "3.24.4",
    releaseTimestamp: "2026-11-08T14:24:43.040Z",
    newVersionAgeInDays: 2,
    newMajor: 3,
    newMinor: 24,
    newPatch: 4,
    updateType: "minor",
    isBreaking: false,
    branchName: "renovate/alpine-3.x",
    ...over,
  };
}

/** The report's entry of one repository, from its dependencies. */
export function repository(deps: Json[], over: Json = {}): Json {
  return {
    problems: [],
    branches: [],
    packageFiles: {
      dockerfile: [{ deps, packageFile: "Dockerfile" }],
    },
    ...over,
  };
}

function line(msg: string, more: Json = {}, level = 30): string {
  return JSON.stringify({
    name: "renovate",
    hostname: "0123456789ab",
    pid: 4,
    level,
    logContext: "f0384f39-1fa4-47d2-91bb-de579ad97e24",
    ...more,
    msg,
    time: "2026-11-10T17:39:44.747Z",
    v: 0,
  });
}

/**
 * What Renovate 44.226.2 really logs about the repository configuration, one
 * debug run per form, captured in `testdata/config_lines.json`: the fake
 * prints these and nothing made up, so a reader that only understands one
 * form fails here as it would live.
 */
export const CONFIG_LINES: {
  renovateVersion: string;
  forms: Record<string, Json[]>;
  none: Json[];
} = JSON.parse(
  Deno.readTextFileSync(
    new URL("./testdata/config_lines.json", import.meta.url),
  ),
);

/** The lines for one form; null is a configuration Renovate did not read. */
export function configLines(form: string | null): Json[] {
  if (form === null) return CONFIG_LINES.none;
  const lines = CONFIG_LINES.forms[form];
  if (lines === undefined) throw new Error(`no captured lines for ${form}`);
  return lines;
}

/**
 * What Renovate 44 prints for one repository in local mode with
 * `LOG_FORMAT=json` and `--report-type=logging`.
 */
export function output(
  repo: Json | null,
  o: {
    result?: string;
    version?: string;
    extra?: string[];
    /** The form Renovate read its configuration from; null for none. */
    config?: string | null;
  } = {},
): string {
  const version = o.version ?? "44.0.0";
  const config = o.config === undefined ? "renovate.json" : o.config;
  return [
    line("Renovate started", { renovateVersion: version }),
    line("Repository started", {
      repository: "local",
      renovateVersion: version,
    }),
    ...configLines(config).map((l) => JSON.stringify(l)),
    ...(o.extra ?? []),
    line("Repository finished", {
      repository: "local",
      durationMs: 4579,
      ...(o.result === undefined
        ? {}
        : { result: o.result, status: "onboarded", exitCode: 5 }),
    }),
    ...(repo === null ? [] : [
      line("Printing report", {
        report: { problems: [], repositories: { local: repo } },
      }),
    ]),
    line('Renovate was run at log level "info".'),
  ].join("\n") + "\n";
}

/** A warning line as Renovate logs it. */
export function warning(msg: string, more: Json = {}): string {
  return line(msg, { repository: "local", ...more }, 40);
}

// ---------------------------------------------------------------------------
// Directories and the method context
// ---------------------------------------------------------------------------

/** A temporary swamp repository root with repository directories in it. */
export type Disk = {
  root: string;
  /** Make a directory under the root, with the files named. */
  repo: (name: string, files?: Record<string, string>) => Promise<string>;
};

/** Run `body` with a temporary directory that is removed afterwards. */
export async function withDisk<T>(body: (d: Disk) => Promise<T>): Promise<T> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "renovate-test-" }),
  );
  try {
    return await body({
      root,
      repo: async (name, files = { "renovate.json": "{}" }) => {
        const dir = `${root}/${name}`;
        await Deno.mkdir(dir, { recursive: true });
        for (const [file, content] of Object.entries(files)) {
          const path = `${dir}/${file}`;
          await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
            recursive: true,
          });
          await Deno.writeTextFile(path, content);
        }
        return dir;
      },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/** The global arguments as swamp hands them over, defaults filled in. */
export function globalArgs(over: Record<string, unknown> = {}): GlobalArgs {
  return GlobalArgsSchema.parse({ image: IMAGE, ...over });
}

/**
 * swamp's rule for a data name: it refuses one that holds `..`, `/`, `\\` or
 * a null byte; and a name is a file name, so at most 255 bytes and not empty.
 */
export function storable(name: string): boolean {
  return name !== "" && !/\.\.|[\/\\\0]/.test(name) &&
    new TextEncoder().encode(name).length <= 255;
}

/** A method context that keeps what the method logged and wrote. */
export type Kept = {
  ctx: Context;
  logs: string[];
  written: Array<{ spec: string; name: string; data: Record<string, unknown> }>;
  /** The data written under one name, checked against its schema. */
  record: (name: string) => Record<string, unknown>;
  /** Everything kept, as one text to search for a planted value. */
  everything: () => string;
};

/**
 * A context whose `writeResource` refuses a record its schema would refuse,
 * as swamp does.
 */
export function kept(
  root: string,
  g: GlobalArgs = globalArgs(),
  o: {
    signal?: AbortSignal;
    onWrite?: (name: string) => void;
    /** Throws to refuse a write, as a data store that fails would. */
    refuseWrite?: (name: string) => void;
  } = {},
): Kept {
  const logs: string[] = [];
  const written: Kept["written"] = [];
  const schemas = model.resources as Record<
    string,
    { schema: { strict: () => { parse: (v: unknown) => unknown } } }
  >;
  return {
    logs,
    written,
    record: (name) => {
      const found = written.findLast((w) => w.name === name);
      if (!found) throw new Error(`no record named ${name} was written`);
      return found.data;
    },
    everything: () => JSON.stringify({ logs, written }),
    ctx: {
      globalArgs: g,
      repoDir: root,
      signal: o.signal,
      logger: {
        info: (msg, props = {}) => {
          logs.push(
            msg.replace(/\{(\w+)\}/g, (_, key) => String(props[key])),
          );
        },
      },
      writeResource: (spec, name, data) => {
        if (!(spec in schemas)) throw new Error(`no resource spec ${spec}`);
        if (!storable(name)) {
          throw new Error(
            `swamp refuses the data name ${JSON.stringify(name)}`,
          );
        }
        o.refuseWrite?.(name);
        schemas[spec].schema.strict().parse(data);
        written.push({ spec, name, data });
        o.onWrite?.(name);
        return Promise.resolve({ name });
      },
    },
  };
}
