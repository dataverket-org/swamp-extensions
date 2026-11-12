/**
 * `@dataverket/renovate/local`: Renovate run in its local mode over
 * repository directories on disk, and the updates it would propose recorded
 * as data.
 *
 * `lookup` takes one directory or a list. For each it starts one container
 * of the Renovate image with the directory mounted read-only, with
 * `--platform=local --dry-run=lookup --report-type=logging`, reads the
 * report Renovate prints, and writes one record. Nothing is written to a
 * repository, no forge is contacted and no token is used. A directory that
 * is missing, has no Renovate configuration, or whose run fails is a
 * recorded state; it does not stop the other directories.
 *
 * Every process is started by the shared layer in `../lib/cli.ts`, which
 * gives each one a time limit and makes its error text safe to repeat.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import {
  assertDataName,
  brief,
  cliCheck,
  cliError,
  type CliResult,
  encodedName,
  now,
  positionalArg,
  runCli,
  shown,
  tryCli,
} from "../lib/cli.ts";

// ---------------------------------------------------------------------------
// Limits
// ---------------------------------------------------------------------------

/** The longest time limit an argument may ask for: an hour, in seconds. */
export const MAX_TIMEOUT_SECONDS = 3600;

/** How long a container engine call that only asks a question may take. */
export const QUERY_TIMEOUT_MS = 30_000;

/** How long removing a container that outlived its time limit may take. */
export const REMOVE_TIMEOUT_MS = 30_000;

/** The most repositories one run takes. */
export const MAX_REPOS = 200;

/**
 * The most bytes Renovate may print. Its report is one line of its log, and
 * at debug the log of a large repository is a few megabytes; a container
 * that prints more than this is stopped.
 */
export const MAX_OUTPUT_BYTES = 32 * 1024 * 1024;

/** The most proposed updates kept in one record; the counts are never cut. */
export const MAX_UPDATES = 500;

/** The most unresolved or skipped dependencies kept in one record. */
export const MAX_DEPENDENCY_NOTES = 100;

/** The most Renovate problems kept in one record. */
export const MAX_WARNINGS = 50;

/** The most Renovate log lines of one repository passed on to swamp's log. */
export const MAX_LOG_LINES = 100;

/** The data name of the record of a whole run. */
export const INVENTORY_NAME = "inventory_all";

/** Where the repository is mounted in the container. */
const MOUNT_TARGET = "/repo";

// ---------------------------------------------------------------------------
// Arguments
// ---------------------------------------------------------------------------

/**
 * The words the engines read as a network mode instead of a network's name.
 * `host`, `container:<name>` and `ns:<path>` put the container in a network
 * that is not its own, and the options of `slirp4netns` and `pasta` can open
 * the host's loopback to it. A lookup that only reads should not be able to
 * hand a repository's configuration any of that, so no mode but `none` is
 * taken, and no value with `:` options.
 */
export const NETWORK_MODES = [
  "host",
  "container",
  "ns",
  "private",
  "bridge",
  "default",
  "slirp4netns",
  "pasta",
];

/** The type's arguments. */
export const GlobalArgsSchema = z.object({
  image: z.string().min(1).max(500).regex(
    /^[A-Za-z0-9][A-Za-z0-9._\/:@-]*$/,
    "write an image reference, such as ghcr.io/renovatebot/renovate:<version>",
  ).describe(
    "The Renovate container image. It is the Renovate version, so there is no default: name a version tag or a digest. A tag that moves, such as latest, gives results that change without a change here",
  ),
  containerBinary: z.string().min(1).default("podman").describe(
    "The container command: podman or docker, by name from PATH or as a path",
  ),
  timeoutSeconds: z.number().int().min(10).max(MAX_TIMEOUT_SECONDS).default(
    300,
  ).describe(
    "How long Renovate may run on one repository before its container is stopped and the repository is recorded as failed; at most an hour",
  ),
  pull: z.enum(["missing", "never"]).default("missing").describe(
    "missing: pull the image once, before the first repository, when the engine does not hold it. never: fail instead",
  ),
  pullTimeoutSeconds: z.number().int().min(10).max(MAX_TIMEOUT_SECONDS)
    .default(600).describe(
      "How long that pull may take; the image is about 1.4 GB. At most an hour",
    ),
  logLevel: z.enum(["info", "debug"]).default("info").describe(
    "How much of Renovate's log reaches this method's log: with info its warnings and errors, with debug its other lines too. Renovate itself always runs at debug, where it says which configuration file it read",
  ),
  passProxy: z.boolean().default(false).describe(
    "Podman only. false: the host's proxy variables (http_proxy, https_proxy, ftp_proxy, no_proxy) are kept out of the container. true: Podman passes them in, for a machine that reaches the registries through a proxy; a password in a proxy URL is then blanked in everything kept",
  ),
  network: z.string().min(1).max(200).regex(
    /^[A-Za-z0-9][A-Za-z0-9_.-]*$/,
    "write none, or the plain name of a network you made: no mode and no options",
  ).refine((n) => !NETWORK_MODES.includes(n.toLowerCase()), {
    message:
      "host, container, ns, private, bridge, default, slirp4netns and pasta are modes of the engine, not networks of yours; a mode can give the container the host's own network, so only none is taken",
  }).optional().describe(
    "Given to the engine as --network: none, or the plain name of a network you made, for example one with restricted egress. A mode such as host or container:<name>, and any value with options, is refused: those can widen what a repository's configuration reaches. Left out, the engine's default network. none makes every lookup fail",
  ),
});

/** The type's arguments, parsed. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** The arguments of `lookup`. */
export const LookupArgsSchema = z.object({
  repo: z.string().optional().describe(
    "One repository directory, absolute or relative to the swamp repository root. Give repo or repos, not both",
  ),
  repos: z.array(z.string()).optional().describe(
    `A list of repository directories, each absolute or relative to the swamp repository root; at most ${MAX_REPOS}. Give repo or repos, not both`,
  ),
});

/** The arguments of `lookup`, parsed. */
export type LookupArgs = z.infer<typeof LookupArgsSchema>;

// ---------------------------------------------------------------------------
// Records
// ---------------------------------------------------------------------------

/** The update types Renovate names, each a key of `updateCounts`. */
export const UPDATE_TYPES = [
  "major",
  "minor",
  "patch",
  "digest",
  "pin",
  "pinDigest",
  "bump",
  "rollback",
  "replacement",
  "lockFileMaintenance",
] as const;

const UpdateCountsSchema = z.object({
  major: z.number().int(),
  minor: z.number().int(),
  patch: z.number().int(),
  digest: z.number().int(),
  pin: z.number().int(),
  pinDigest: z.number().int(),
  bump: z.number().int(),
  rollback: z.number().int(),
  replacement: z.number().int(),
  lockFileMaintenance: z.number().int(),
  other: z.number().int().describe(
    "Updates of a type this version does not know, or with none",
  ),
});

/** Proposed updates, counted by type. */
export type UpdateCounts = z.infer<typeof UpdateCountsSchema>;

const text = z.string().nullable();

const UpdateSchema = z.object({
  depName: text,
  packageName: text,
  datasource: text,
  manager: z.string(),
  packageFile: text.describe("The file the dependency is in"),
  depType: text,
  currentValue: text.describe("The version as written in the file"),
  currentVersion: text.describe("The version Renovate resolved it to"),
  currentDigest: text,
  newValue: text,
  newVersion: text,
  newDigest: text,
  updateType: text.describe("major, minor, patch, digest, pin and so on"),
  isBreaking: z.boolean().nullable(),
  releaseTimestamp: text.describe("When the new version was released"),
  newVersionAgeInDays: z.number().nullable(),
});

const NoteSchema = z.object({
  depName: text,
  datasource: text,
  manager: z.string(),
  packageFile: text,
  reason: z.string(),
});

const WarningSchema = z.object({
  level: z.enum(["warn", "error", "fatal"]),
  message: z.string(),
  detail: z.string().describe("The problem's own fields, one line; may be ''"),
});

/** What became of one repository. */
export const STATUSES = [
  "ok",
  "failed",
  "nothing-looked-up",
  "config-not-read",
  "no-config",
  "not-a-directory",
] as const;

const RepositorySchema = z.object({
  path: z.string().describe("The directory as it was given"),
  directory: z.string().describe("Its absolute path, as it was mounted"),
  dataName: z.string(),
  status: z.enum(STATUSES).describe(
    "ok: Renovate ran to its end with the repository's configuration, its report was read and at least one dependency was looked up. failed: it ran and did not end well, see failure and reason. nothing-looked-up: it ran and looked up no dependency at all. config-not-read: a configuration file is there and Renovate did not read it, so it ran on its defaults. no-config: the directory has no Renovate configuration file, Renovate was not run. not-a-directory: the path is missing or no directory, Renovate was not run",
  ),
  ok: z.boolean().describe("status is ok"),
  failure: z.string().nullable().describe(
    "For failed, which way: timeout, exit, too-large, no-report, report-shape or result. Else null",
  ),
  reason: z.string().nullable().describe(
    "One line that says why status is not ok; null when it is",
  ),
  lookupComplete: z.boolean().describe(
    "ok, and every dependency Renovate tried to look up was looked up: none unresolved, none skipped for want of a GitHub token, none unreadable",
  ),
  upToDate: z.boolean().describe(
    "lookupComplete and no update proposed. False whenever that cannot be said",
  ),
  image: z.string(),
  renovateVersion: text,
  configFile: text.describe(
    "The first Renovate configuration file found in the directory, before Renovate ran",
  ),
  configRead: text.describe(
    "The configuration file Renovate says it read; null when it read none",
  ),
  git: z.boolean().describe(
    "The directory holds .git: Renovate then reads the files Git tracks, as they are on disk. Without it, every file",
  ),
  ranAt: z.iso.datetime(),
  durationMs: z.number().int(),
  packageFileCount: z.number().int().describe(
    "Package files Renovate found dependencies in",
  ),
  dependencyCount: z.number().int(),
  lookedUpCount: z.number().int().describe(
    "Dependencies Renovate looked up and got an answer for: not skipped, not unresolved",
  ),
  outdatedCount: z.number().int().describe(
    "Dependencies with at least one proposed update",
  ),
  updateCount: z.number().int(),
  updateCounts: UpdateCountsSchema,
  unresolvedCount: z.number().int().describe(
    "Dependencies whose lookup failed",
  ),
  skippedCount: z.number().int().describe(
    "Dependencies Renovate did not look up, for any reason",
  ),
  tokenRequiredCount: z.number().int().describe(
    "Of those, the ones skipped because the lookup needs a GitHub token",
  ),
  unreadableCount: z.number().int().describe(
    "Entries of the report that did not have the shape of a dependency",
  ),
  updates: z.array(UpdateSchema),
  unresolved: z.array(NoteSchema),
  skipped: z.array(NoteSchema),
  warnings: z.array(WarningSchema).describe(
    "The problems Renovate reports for the repository",
  ),
  warningCount: z.number().int(),
  truncated: z.boolean().describe(
    "A list above was cut at its bound; the counts are whole",
  ),
});

/** One stored repository record. */
export type Repository = z.infer<typeof RepositorySchema>;

const InventoryItemSchema = z.object({
  path: z.string(),
  dataName: z.string().describe("The data name of the repository's record"),
  status: z.enum(STATUSES),
  ok: z.boolean(),
  lookupComplete: z.boolean(),
  upToDate: z.boolean(),
  lookedUpCount: z.number().int(),
  updateCount: z.number().int(),
  majorCount: z.number().int(),
  reason: z.string().nullable(),
});

const InventorySchema = z.object({
  image: z.string(),
  engine: z.string().describe("The container engine and its version"),
  renovateVersion: text,
  count: z.number().int(),
  okCount: z.number().int(),
  failedCount: z.number().int(),
  nothingLookedUpCount: z.number().int(),
  configNotReadCount: z.number().int(),
  noConfigCount: z.number().int(),
  notADirectoryCount: z.number().int(),
  upToDateCount: z.number().int(),
  outdatedCount: z.number().int().describe(
    "Repositories with at least one proposed update",
  ),
  incompleteCount: z.number().int().describe(
    "Repositories that are ok and whose lookup is not complete",
  ),
  updateCount: z.number().int(),
  updateCounts: UpdateCountsSchema,
  items: z.array(InventoryItemSchema),
  observedAt: z.iso.datetime(),
  durationMs: z.number().int(),
});

/** One stored inventory. */
export type Inventory = z.infer<typeof InventorySchema>;

/** The parts of swamp's method context the type uses. */
export type Context = {
  globalArgs: GlobalArgs;
  repoDir: string;
  signal?: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

// ---------------------------------------------------------------------------
// Paths and data names
// ---------------------------------------------------------------------------

/** What every repository record's name starts with. */
export const RECORD_PREFIX = "repo-";

/**
 * The data name of a repository's record: `repo-` and the path as given,
 * less trailing slashes, through the shared encoder. Letters, digits and `-`
 * stay, every other character is written as `_` and two hex digits per
 * byte, so `/` is `_2f` and `_` is `_5f`; a `.` stays unless it starts the
 * path or follows a `.`, where it is `_2e`. Two different paths never share
 * a name, and a caller can build the name from the path it passes. The name
 * is the path's, not the directory's: two spellings of one directory are two
 * names.
 *
 * The prefix keeps the records apart from everything else stored for the
 * definition, by construction: the inventory, and the records swamp writes
 * itself on every run, whose names start with `report-`. Without it the
 * path `report-swamp-method-summary` was overwritten by swamp's own report.
 */
export function dataName(path: string): string {
  return RECORD_PREFIX + encodedName(path.replace(/\/+$/, "") || "/");
}

/** `path` made absolute against `root` and tidied, without reading a disk. */
export function absolutePath(root: string, path: string): string {
  const parts: string[] = [];
  for (
    const p of (path.startsWith("/") ? path : `${root}/${path}`).split("/")
  ) {
    if (p === "" || p === ".") continue;
    if (p === "..") parts.pop();
    else parts.push(p);
  }
  return `/${parts.join("/")}`;
}

/** One repository of a run, checked. */
export type Target = { path: string; directory: string; dataName: string };

/**
 * The repositories of one run, or a named refusal before anything is
 * started: both or neither of `repo` and `repos`, a `repo` written as a
 * list, an empty list, too many,
 * a path that is empty, shaped like a flag or holds a line break, a
 * directory with a comma or a double quote, which the engine's `--mount`
 * cannot take, a data name that is too long, and the
 * same directory twice.
 */
export function targets(args: LookupArgs, repoDir: string): Target[] {
  if (args.repo !== undefined && args.repos !== undefined) {
    throw new Error(
      "give repo or repos, not both: repo is one directory, repos is a list",
    );
  }
  if (args.repo === undefined && args.repos === undefined) {
    throw new Error(
      "give repo, one directory, or repos, a list of directories",
    );
  }
  if (typeof args.repo === "string" && /^\s*\[.*\]\s*$/s.test(args.repo)) {
    throw new Error(
      `repo ${
        shown(args.repo)
      } is refused: it is written as a list; give a list as repos`,
    );
  }
  const given = args.repos ?? [args.repo as string];
  if (!Array.isArray(given)) {
    throw new Error("repos is not a list: give it as a list of directories");
  }
  if (given.length === 0) {
    throw new Error("repos is empty: name at least one directory");
  }
  if (given.length > MAX_REPOS) {
    throw new Error(
      `repos names ${given.length} directories, more than the ${MAX_REPOS} one run takes; split the list`,
    );
  }
  const seen = new Map<string, string>();
  return given.map((raw) => {
    const path = positionalArg(raw, "repository path");
    // A lone surrogate can only come in through JSON. It has no bytes of
    // its own, and what is written with it cannot be read back as JSON.
    if (!path.isWellFormed()) {
      throw new Error(
        `repository path ${
          JSON.stringify(path.toWellFormed().slice(0, 80))
        } is refused: it is not well-formed Unicode (it holds half of a surrogate pair)`,
      );
    }
    const directory = absolutePath(repoDir, path);
    if (/[,"]/.test(directory)) {
      throw new Error(
        `repository path ${shown(path)} is refused: its directory ${
          shown(directory)
        } holds a comma or a double quote, which the container engine's --mount cannot take`,
      );
    }
    const name = dataName(path);
    // Before anything starts: a name the data store refuses would lose the
    // record of a lookup that has already run.
    assertDataName(name, `the record of ${shown(path)}`);
    const other = seen.get(directory);
    if (other !== undefined) {
      throw new Error(
        `repos names the same directory twice: ${shown(other)} and ${
          shown(path)
        } are both ${shown(directory)}`,
      );
    }
    seen.set(directory, path);
    return { path, directory, dataName: name };
  });
}

// ---------------------------------------------------------------------------
// What is on disk
// ---------------------------------------------------------------------------

/**
 * The files Renovate reads its configuration from in local mode, in its
 * order (Renovate 44, `lib/config/app-strings.ts`). `package.json` counts
 * only when it has a `renovate` key. A file under `.forgejo/` or `.gitea/`
 * is not read in local mode.
 */
export const CONFIG_FILES = [
  "renovate.json",
  "renovate.jsonc",
  "renovate.json5",
  ".github/renovate.json",
  ".github/renovate.jsonc",
  ".github/renovate.json5",
  ".gitlab/renovate.json",
  ".gitlab/renovate.jsonc",
  ".gitlab/renovate.json5",
  ".renovaterc",
  ".renovaterc.json",
  ".renovaterc.jsonc",
  ".renovaterc.json5",
];

/** The largest `package.json` that is read for its `renovate` key. */
const MAX_PACKAGE_JSON_BYTES = 1024 * 1024;

/**
 * True for a regular file. A symbolic link, a directory, a FIFO or a device
 * in a configuration's place is not one, and is never opened: a link can
 * point at something that never ends, and a FIFO holds whoever opens it.
 */
async function isRegularFile(path: string): Promise<boolean> {
  try {
    const info = await Deno.lstat(path);
    return info.isFile && !info.isSymlink;
  } catch {
    return false;
  }
}

async function exists(path: string): Promise<boolean> {
  try {
    await Deno.lstat(path);
    return true;
  } catch {
    return false;
  }
}

/**
 * The text of a regular file of at most `max` bytes, or null: for a file
 * that is larger, is not a regular file, or cannot be read. Never more than
 * `max` and one byte are read, whatever the file turns out to be.
 */
export async function boundedText(
  path: string,
  max: number,
): Promise<string | null> {
  if (!(await isRegularFile(path))) return null;
  let file: Deno.FsFile;
  try {
    file = await Deno.open(path, { read: true });
  } catch {
    return null;
  }
  try {
    // Between the check and the open the name can have changed hands.
    if (!(await file.stat()).isFile) return null;
    const buffer = new Uint8Array(max + 1);
    let filled = 0;
    while (filled < buffer.length) {
      const n = await file.read(buffer.subarray(filled));
      if (n === null) break;
      filled += n;
    }
    return filled > max
      ? null
      : new TextDecoder().decode(buffer.subarray(0, filled));
  } catch {
    return null;
  } finally {
    file.close();
  }
}

/**
 * The first Renovate configuration file of a directory, or null. Only a
 * regular file counts. Whether Renovate reads it is Renovate's to say: see
 * `configRead` in the record.
 */
export async function configFile(directory: string): Promise<string | null> {
  for (const name of CONFIG_FILES) {
    if (await isRegularFile(`${directory}/${name}`)) return name;
  }
  const text = await boundedText(
    `${directory}/package.json`,
    MAX_PACKAGE_JSON_BYTES,
  );
  if (text === null) return null;
  try {
    const parsed = JSON.parse(text);
    if (
      parsed !== null && typeof parsed === "object" && "renovate" in parsed
    ) return "package.json";
  } catch {
    // Not JSON: not a configuration.
  }
  return null;
}

/** Why a path cannot be scanned, or null when it is a directory. */
async function notADirectory(directory: string): Promise<string | null> {
  try {
    return (await Deno.stat(directory)).isDirectory
      ? null
      : `${directory} is not a directory`;
  } catch (err) {
    return err instanceof Deno.errors.NotFound
      ? `${directory} does not exist`
      : `${directory} cannot be read (${
        err instanceof Error ? err.name : "error"
      })`;
  }
}

// ---------------------------------------------------------------------------
// The container engine
// ---------------------------------------------------------------------------

const INSTALL_HINT =
  "install Podman or Docker, or set the containerBinary argument to where it is";

/** What the engine is, as far as a run needs to know. */
export type Engine = {
  bin: string;
  /** `podman 4.9.3`, `docker 27.3.1`, or what `--version` printed. */
  name: string;
  /** Podman: it takes `--timeout` and `--http-proxy`. */
  podman: boolean;
  /** Rootless Podman: the container's user is mapped to the caller. */
  keepId: boolean;
};

/**
 * True for a line of a pull's progress report. On a failed pull they come
 * before the sentence that says what is wrong.
 */
export function isPullProgress(line: string): boolean {
  return /^(Trying to pull|Getting image source signatures|Copying (blob|config)|Writing manifest|Storing signatures|Resolved "|[0-9a-f]{12}: |[\w.\/:-]+: Pulling from|Digest: |Status: )/
    .test(line.trim());
}

/** Ask the engine what it is. A binary that is not there throws. */
export async function engine(ctx: Context): Promise<Engine> {
  const bin = ctx.globalArgs.containerBinary;
  const opts = {
    signal: ctx.signal,
    timeoutMs: QUERY_TIMEOUT_MS,
    installHint: INSTALL_HINT,
  };
  const version = (await runCli(bin, ["--version"], opts)).stdout.trim();
  const podman = /^podman version (\S+)/i.exec(version);
  const docker = /^Docker version ([^,\s]+)/.exec(version);
  if (!podman) {
    return {
      bin,
      name: docker ? `docker ${docker[1]}` : brief(version, 80) || "unknown",
      podman: false,
      keepId: false,
    };
  }
  const rootless = await runCli(
    bin,
    ["info", "--format", "{{.Host.Security.Rootless}}"],
    { ...opts, what: `${bin} info` },
  );
  return {
    bin,
    name: `podman ${podman[1]}`,
    podman: true,
    keepId: rootless.stdout.trim() === "true",
  };
}

/**
 * The numeric user the image runs as, or null: with rootless Podman that
 * user is mapped to the caller, so it can read a directory only the caller
 * can read. Pulls the image first when the engine does not hold it and
 * `pull` allows it. An image that is not there and cannot be pulled throws.
 */
export async function imageUser(
  ctx: Context,
  e: Engine,
): Promise<string | null> {
  const g = ctx.globalArgs;
  const image = positionalArg(g.image, "image");
  const inspect = ["image", "inspect", "--format", "{{.Config.User}}", image];
  const opts = {
    signal: ctx.signal,
    timeoutMs: QUERY_TIMEOUT_MS,
    what: `${e.bin} image inspect`,
  };
  let held = await tryCli(e.bin, inspect, opts);
  if (held.cancelled || held.timedOut) {
    throw cliError(e.bin, inspect, held, opts);
  }
  if (!held.success) {
    if (g.pull === "never") {
      throw new Error(
        `the image ${image} is not held by ${e.bin} and pull is never: pull it first, or set pull to missing (${
          brief(held.stderr, 200) || "no error output"
        })`,
      );
    }
    ctx.logger.info(
      "{image} is not held by {bin}; pulling it, within {seconds} seconds",
      { image, bin: e.bin, seconds: g.pullTimeoutSeconds },
    );
    await runCli(e.bin, ["pull", image], {
      signal: ctx.signal,
      timeoutMs: g.pullTimeoutSeconds * 1000,
      what: `${e.bin} pull ${image}`,
      noise: isPullProgress,
    });
    held = await runCli(e.bin, inspect, opts);
  }
  const user = /^(\d+)(:|$)/.exec(held.stdout.trim());
  return user ? user[1] : null;
}

function containerName(): string {
  const bytes = crypto.getRandomValues(new Uint8Array(6));
  return `renovate-local-${
    [...bytes].map((b) => b.toString(16).padStart(2, "0")).join("")
  }`;
}

/**
 * How long after the client's time limit the engine itself stops the
 * container, in seconds: late enough that the client's limit is the one
 * that normally ends a run and names it a timeout.
 */
export const ENGINE_TIMEOUT_MARGIN_SECONDS = 30;

/**
 * The arguments of one run: the repository read-only, the report printed.
 * Renovate always runs at debug: only there does it say which configuration
 * file it read. Podman also gets a time limit of its own, which holds when
 * the client is gone, and is told whether to pass the host's proxy
 * variables in; left to itself it passes them, with any password in them.
 */
export function runArgs(
  g: GlobalArgs,
  e: Engine,
  user: string | null,
  directory: string,
  name: string,
): string[] {
  return [
    "run",
    "--rm",
    "--pull=never",
    "--name",
    name,
    ...(e.podman
      ? [
        "--timeout",
        String(g.timeoutSeconds + ENGINE_TIMEOUT_MARGIN_SECONDS),
        `--http-proxy=${g.passProxy ? "true" : "false"}`,
      ]
      : []),
    ...(g.network === undefined ? [] : ["--network", g.network]),
    ...(e.keepId && user !== null ? ["--userns", `keep-id:uid=${user}`] : []),
    "--mount",
    `type=bind,source=${directory},target=${MOUNT_TARGET},readonly`,
    "--workdir",
    MOUNT_TARGET,
    "--env",
    "LOG_LEVEL=debug",
    "--env",
    "LOG_FORMAT=json",
    g.image,
    "--platform=local",
    "--dry-run=lookup",
    "--report-type=logging",
  ];
}

/** The proxy variables Podman passes into a container with `--http-proxy`. */
export const PROXY_VARIABLES = [
  "http_proxy",
  "https_proxy",
  "ftp_proxy",
  "no_proxy",
  "HTTP_PROXY",
  "HTTPS_PROXY",
  "FTP_PROXY",
  "NO_PROXY",
];

/**
 * The passwords in the host's proxy variables, as written and decoded, and
 * each with its user as `user:password`: what must be blanked in anything
 * kept from a container that was given those variables.
 */
export function proxySecrets(): string[] {
  const secrets = new Set<string>();
  for (const name of PROXY_VARIABLES) {
    let value: string | undefined;
    try {
      value = Deno.env.get(name);
    } catch {
      // No permission to read the environment: as if it were not set.
    }
    const userinfo = /^[a-z][a-z0-9+.-]*:\/\/([^\/?#@]*)@/i.exec(value ?? "");
    const colon = userinfo ? userinfo[1].indexOf(":") : -1;
    if (!userinfo || colon < 0) continue;
    const password = userinfo[1].slice(colon + 1);
    if (password === "") continue;
    secrets.add(password);
    secrets.add(userinfo[1]);
    try {
      secrets.add(decodeURIComponent(password));
      secrets.add(decodeURIComponent(userinfo[1]));
    } catch {
      // Not percent-encoded text: the form as written is all there is.
    }
  }
  return [...secrets];
}

/**
 * Remove a container whose client was stopped. The engine's client passes
 * SIGTERM on, and the container ends; a client that had to be killed leaves
 * its container running, so it is removed by name. Not tied to the run's
 * signal: it must also happen when the run is cancelled.
 */
async function removeContainer(ctx: Context, e: Engine, name: string) {
  try {
    const res = await tryCli(e.bin, ["rm", "--force", name], {
      timeoutMs: REMOVE_TIMEOUT_MS,
      what: `${e.bin} rm`,
    });
    if (
      !res.success && !/no such container|no container with/i.test(res.stderr)
    ) {
      ctx.logger.info(
        "The container {name} may still run: {bin} rm did not succeed",
        { name, bin: e.bin },
      );
    }
  } catch {
    // The engine could not be run again; the time limit's failure stands.
  }
}

// ---------------------------------------------------------------------------
// Renovate's output
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

function isObject(v: unknown): v is Json {
  return v !== null && typeof v === "object" && !Array.isArray(v);
}

/**
 * A string of the report, redacted and bounded, or null. `secrets` are
 * blanked word for word, besides what is shaped like a credential.
 */
function safe(v: unknown, max: number, secrets: string[]): string | null {
  if (typeof v === "string") return brief(v, max, secrets);
  if (typeof v === "number" && Number.isFinite(v)) return String(v);
  return null;
}

function bool(v: unknown): boolean | null {
  return typeof v === "boolean" ? v : null;
}

function num(v: unknown): number | null {
  return typeof v === "number" && Number.isFinite(v) ? v : null;
}

/** The JSON log lines of Renovate's output; other lines are counted. */
export function logLines(stdout: string): { lines: Json[]; other: number } {
  const lines: Json[] = [];
  let other = 0;
  for (const line of stdout.split("\n")) {
    if (line.trim() === "") continue;
    try {
      const parsed = JSON.parse(line);
      if (isObject(parsed)) lines.push(parsed);
      else other++;
    } catch {
      other++;
    }
  }
  return { lines, other };
}

const LEVELS: Array<[number, "fatal" | "error" | "warn"]> = [
  [60, "fatal"],
  [50, "error"],
  [40, "warn"],
];

function levelName(level: unknown): "fatal" | "error" | "warn" | null {
  const n = typeof level === "number" ? level : 0;
  return LEVELS.find(([min]) => n >= min)?.[1] ?? null;
}

const LOG_FIELDS = new Set([
  "name",
  "hostname",
  "pid",
  "level",
  "logContext",
  "msg",
  "time",
  "v",
  "repository",
  "renovateVersion",
  "err",
  "report",
]);

const ERR_FIELDS = [
  "validationSource",
  "validationError",
  "validationMessage",
  "code",
  "message",
];

/** The small fields of a problem or a log line, as one bounded line. */
function detail(entry: Json, secrets: string[]): string {
  const parts: string[] = [];
  const add = (key: string, value: unknown) => {
    if (parts.length >= 12) return;
    if (typeof value === "string" || typeof value === "number") {
      parts.push(`${key}: ${String(value).slice(0, 200)}`);
    } else if (
      Array.isArray(value) && value.every((v) => typeof v === "string")
    ) {
      parts.push(`${key}: ${value.slice(0, 10).join(", ").slice(0, 200)}`);
    }
  };
  for (const [key, value] of Object.entries(entry)) {
    if (!LOG_FIELDS.has(key)) add(key, value);
  }
  if (isObject(entry.err)) {
    for (const key of ERR_FIELDS) add(key, entry.err[key]);
  }
  return brief(parts.join("; "), 400, secrets);
}

function emptyCounts(): UpdateCounts {
  return {
    major: 0,
    minor: 0,
    patch: 0,
    digest: 0,
    pin: 0,
    pinDigest: 0,
    bump: 0,
    rollback: 0,
    replacement: 0,
    lockFileMaintenance: 0,
    other: 0,
  };
}

/** What a report says of one repository. */
export type Findings = Pick<
  Repository,
  | "packageFileCount"
  | "dependencyCount"
  | "lookedUpCount"
  | "outdatedCount"
  | "updateCount"
  | "updateCounts"
  | "unresolvedCount"
  | "skippedCount"
  | "tokenRequiredCount"
  | "unreadableCount"
  | "updates"
  | "unresolved"
  | "skipped"
  | "warnings"
  | "warningCount"
  | "truncated"
>;

function noFindings(): Findings {
  return {
    packageFileCount: 0,
    dependencyCount: 0,
    lookedUpCount: 0,
    outdatedCount: 0,
    updateCount: 0,
    updateCounts: emptyCounts(),
    unresolvedCount: 0,
    skippedCount: 0,
    tokenRequiredCount: 0,
    unreadableCount: 0,
    updates: [],
    unresolved: [],
    skipped: [],
    warnings: [],
    warningCount: 0,
    truncated: false,
  };
}

/**
 * Read the part of Renovate's report that is about one repository. Nothing
 * here trusts the shape: an entry that is not what it should be is counted
 * as unreadable, which keeps the repository from being called up to date.
 * Returns null when there is no `packageFiles` object to read at all.
 */
export function findings(
  repository: Json,
  secrets: string[] = [],
): Findings | null {
  if (!isObject(repository.packageFiles)) return null;
  const str = (v: unknown, max = 300) => safe(v, max, secrets);
  const f = noFindings();
  const note = (list: Findings["skipped"], entry: Findings["skipped"][0]) => {
    if (list.length < MAX_DEPENDENCY_NOTES) list.push(entry);
    else f.truncated = true;
  };
  for (const [manager, files] of Object.entries(repository.packageFiles)) {
    if (!Array.isArray(files)) {
      f.unreadableCount++;
      continue;
    }
    for (const file of files) {
      if (!isObject(file) || !Array.isArray(file.deps)) {
        f.unreadableCount++;
        continue;
      }
      f.packageFileCount++;
      const packageFile = str(file.packageFile);
      for (const dep of file.deps) {
        if (!isObject(dep)) {
          f.unreadableCount++;
          continue;
        }
        f.dependencyCount++;
        const about = {
          depName: str(dep.depName),
          datasource: str(dep.datasource),
          manager: brief(manager, 100, secrets),
          packageFile,
        };
        if (typeof dep.skipReason === "string") {
          f.skippedCount++;
          if (dep.skipReason === "github-token-required") {
            f.tokenRequiredCount++;
          }
          note(f.skipped, {
            ...about,
            reason: brief(dep.skipReason, 100, secrets),
          });
        }
        const failed = Array.isArray(dep.warnings)
          ? dep.warnings.filter(isObject)
          : [];
        if (failed.length > 0) {
          f.unresolvedCount++;
          note(f.unresolved, {
            ...about,
            reason: str(failed[0].message) ?? "the lookup failed",
          });
        }
        if (!Array.isArray(dep.updates)) {
          // Renovate gives every dependency a list, empty when there is
          // nothing newer. Without one, nothing is known about it.
          f.unreadableCount++;
          continue;
        }
        const updates = dep.updates.filter(isObject);
        f.unreadableCount += dep.updates.length - updates.length;
        // Looked up: Renovate asked a registry about it and got an answer.
        if (
          typeof dep.skipReason !== "string" && failed.length === 0 &&
          updates.length === dep.updates.length
        ) f.lookedUpCount++;
        if (updates.length > 0) f.outdatedCount++;
        for (const u of updates) {
          f.updateCount++;
          const type = typeof u.updateType === "string" ? u.updateType : "";
          const known = (UPDATE_TYPES as readonly string[]).includes(type);
          f.updateCounts[known ? type as keyof UpdateCounts : "other"]++;
          if (f.updates.length >= MAX_UPDATES) {
            f.truncated = true;
            continue;
          }
          f.updates.push({
            ...about,
            packageName: str(dep.packageName),
            depType: str(dep.depType),
            currentValue: str(dep.currentValue),
            currentVersion: str(dep.currentVersion),
            currentDigest: str(dep.currentDigest),
            newValue: str(u.newValue),
            newVersion: str(u.newVersion),
            newDigest: str(u.newDigest),
            updateType: str(u.updateType, 100),
            isBreaking: bool(u.isBreaking),
            releaseTimestamp: str(u.releaseTimestamp, 100),
            newVersionAgeInDays: num(u.newVersionAgeInDays),
          });
        }
      }
    }
  }
  const problems = Array.isArray(repository.problems)
    ? repository.problems.filter(isObject)
    : [];
  for (const p of problems) {
    const level = levelName(p.level);
    if (level === null) continue;
    f.warningCount++;
    if (f.warnings.length >= MAX_WARNINGS) {
      f.truncated = true;
      continue;
    }
    f.warnings.push({
      level,
      message: str(p.msg, 400) ?? "",
      detail: detail(p, secrets),
    });
  }
  return f;
}

/**
 * The configuration Renovate says it read, or null. It says so only at
 * debug, and differently for the two kinds (Renovate 44.226.2, one run per
 * form, kept in `testdata/config_lines.json`):
 *
 * - a configuration file: `Found <file> config file`, then
 *   `Repository config` with the file's name in the field `fileName`;
 * - a `renovate` key in `package.json`: `Found package.json config file`,
 *   then `package.json>renovate config`, with no `fileName`.
 *
 * Any one of those lines is taken, so a later Renovate that rewords one of
 * them is still read. One that rewords all of them makes every repository
 * `config-not-read`: wrong, and loud. The record carries the Renovate
 * version beside it.
 */
function readConfiguration(
  lines: Json[],
  str: (v: unknown, max?: number) => string | null,
): string | null {
  let found: string | null = null;
  for (const l of lines) {
    if (l.msg === "Repository config" && typeof l.fileName === "string") {
      return str(l.fileName, 200);
    }
    if (l.msg === "package.json>renovate config") return "package.json";
    const said = typeof l.msg === "string"
      ? /^Found (\S+) config file$/.exec(l.msg)
      : null;
    if (said && found === null) found = str(said[1], 200);
  }
  return found;
}

/** How one run of Renovate ended, read from what it printed. */
export type Outcome = {
  renovateVersion: string | null;
  /** The configuration file Renovate says it read, or null. */
  configRead: string | null;
  failure: string | null;
  reason: string | null;
  findings: Findings;
};

/**
 * Sort one finished container run. `ok` needs all of: exit code zero, a
 * report in the output, the repository in the report, and no result word on
 * Renovate's `Repository finished` line. Renovate exits zero for a
 * configuration it refuses and for a registry it cannot reach, and names
 * those only there.
 */
export function outcome(
  res: CliResult,
  timeoutSeconds: number,
  secrets: string[] = [],
): Outcome {
  const str = (v: unknown, max = 300) => safe(v, max, secrets);
  const failed = (
    failure: string,
    reason: string,
    more: Partial<Outcome> = {},
  ): Outcome => ({
    renovateVersion: null,
    configRead: null,
    findings: noFindings(),
    ...more,
    failure,
    reason: brief(reason, 600, secrets),
  });
  if (res.timedOut) {
    return failed(
      "timeout",
      `Renovate did not finish within ${timeoutSeconds} seconds and its container was stopped; raise timeoutSeconds when the repository needs longer`,
    );
  }
  if (res.tooLarge) {
    return failed(
      "too-large",
      `Renovate printed more than ${MAX_OUTPUT_BYTES} bytes and its container was stopped; nothing of it was read`,
    );
  }
  const { lines, other } = logLines(res.stdout);
  const version = lines.map((l) => str(l.renovateVersion, 60)).find((v) => v) ??
    null;
  const configRead = readConfiguration(lines, str);
  const loud = lines.filter((l) => levelName(l.level) !== null);
  const said = (max: number) =>
    loud.slice(-max).map((l) => {
      const d = detail(l, secrets);
      return `${str(l.msg, 200) ?? "(no message)"}${d ? ` (${d})` : ""}`;
    }).join("; ");
  if (res.code !== 0) {
    return failed(
      "exit",
      `exit ${res.code ?? "by signal"}: ${
        brief(res.stderr, 400, secrets) || said(2) || "(no error output)"
      }`,
      { renovateVersion: version, configRead },
    );
  }
  const printed = lines.findLast((l) =>
    l.msg === "Printing report" && isObject(l.report)
  );
  if (printed === undefined) {
    return failed(
      "no-report",
      `Renovate exited 0 and printed no report (${lines.length} log lines, ${other} lines that are not JSON)${
        said(2) ? `: ${said(2)}` : ""
      }`,
      { renovateVersion: version, configRead },
    );
  }
  const report = printed.report as Json;
  const repositories = isObject(report.repositories)
    ? Object.values(report.repositories).filter(isObject)
    : [];
  const found = repositories.length === 1
    ? findings(repositories[0], secrets)
    : null;
  if (found === null) {
    return failed(
      "report-shape",
      `Renovate's report does not have the shape this version reads: ${
        repositories.length === 1
          ? "the repository has no packageFiles"
          : `${repositories.length} repositories where one is expected`
      }`,
      { renovateVersion: version, configRead },
    );
  }
  const finished = lines.findLast((l) => l.msg === "Repository finished");
  const result = str(finished?.result, 100) ?? str(repositories[0].status, 100);
  if (finished?.result !== undefined || repositories[0].status !== undefined) {
    return failed(
      "result",
      `Renovate ended the repository with ${result ?? "an error"}${
        said(3) ? `: ${said(3)}` : ""
      }`,
      { renovateVersion: version, configRead, findings: found },
    );
  }
  return {
    renovateVersion: version,
    configRead,
    failure: null,
    reason: null,
    findings: found,
  };
}

/**
 * Pass Renovate's own log lines on to swamp's log, in their order, redacted
 * and bounded: its warnings and errors always, and with `logLevel: debug`
 * the other lines too. Each of the two has its own bound, so a flood of
 * quiet lines cannot push a warning out.
 */
function passOn(
  ctx: Context,
  path: string,
  stdout: string,
  secrets: string[],
) {
  const { lines } = logLines(stdout);
  let loud = 0;
  let quiet = 0;
  let dropped = 0;
  for (const l of lines) {
    if (l.msg === "Printing report") continue;
    const level = levelName(l.level);
    if (level === null && ctx.globalArgs.logLevel !== "debug") continue;
    if ((level === null ? quiet++ : loud++) >= MAX_LOG_LINES) {
      dropped++;
      continue;
    }
    ctx.logger.info("{path}: renovate {level}: {message}", {
      path,
      level: level ?? "log",
      message: safe(l.msg, 300, secrets) ?? "",
    });
  }
  if (dropped > 0) {
    ctx.logger.info("{path}: {more} more Renovate log lines not shown", {
      path,
      more: dropped,
    });
  }
}

// ---------------------------------------------------------------------------
// One repository, and the run
// ---------------------------------------------------------------------------

/** The error of a run that was cancelled. */
function cancelled(done: number, total: number): Error {
  return new Error(
    `cancelled after ${done} of ${total} repositories; their records are written, the inventory is not`,
  );
}

/**
 * Look one repository up and build its record. Only a cancelled run and a
 * container engine that cannot be started throw.
 */
async function lookupOne(
  ctx: Context,
  e: Engine,
  user: string | null,
  t: Target,
  progress: [number, number],
  secrets: string[],
): Promise<Repository> {
  const g = ctx.globalArgs;
  const started = now();
  const base = {
    path: t.path,
    directory: t.directory,
    dataName: t.dataName,
    image: g.image,
    renovateVersion: null,
    configFile: null,
    configRead: null,
    git: false,
    ranAt: new Date().toISOString(),
  };
  const notRun = (
    status: "no-config" | "not-a-directory",
    reason: string,
  ): Repository => ({
    ...base,
    ...noFindings(),
    status,
    ok: false,
    failure: null,
    reason,
    lookupComplete: false,
    upToDate: false,
    durationMs: now() - started,
  });
  const missing = await notADirectory(t.directory);
  if (missing !== null) return notRun("not-a-directory", missing);
  const config = await configFile(t.directory);
  if (config === null) {
    return notRun(
      "no-config",
      `${t.directory} has no Renovate configuration file (${
        CONFIG_FILES.slice(0, 3).join(", ")
      }, ... or a renovate key in package.json); Renovate was not run`,
    );
  }
  const git = await exists(`${t.directory}/.git`);
  const name = containerName();
  const args = runArgs(g, e, user, t.directory, name);
  // Said before it starts: when swamp itself is killed, this is the name a
  // person looks for.
  ctx.logger.info("{path}: starting the container {name}", {
    path: t.path,
    name,
  });
  const res = await tryCli(e.bin, args, {
    signal: ctx.signal,
    timeoutMs: g.timeoutSeconds * 1000,
    what: `${e.bin} run`,
    installHint: INSTALL_HINT,
    secrets,
    maxOutputBytes: MAX_OUTPUT_BYTES,
  });
  // The client was stopped; whether its container went with it is not known.
  if (res.timedOut || res.cancelled || res.tooLarge) {
    await removeContainer(ctx, e, name);
  }
  if (res.cancelled) throw cancelled(...progress);
  if (!res.tooLarge) passOn(ctx, t.path, res.stdout, secrets);
  const o = outcome(res, g.timeoutSeconds, secrets);
  const f = o.findings;
  // In this order: a run that failed says nothing else; a configuration
  // that was not read makes everything Renovate proposed beside the point;
  // and with nothing looked up there is nothing to be up to date about.
  let status: Repository["status"] = "ok";
  let reason = o.reason;
  if (o.failure !== null) {
    status = "failed";
  } else if (o.configRead === null) {
    status = "config-not-read";
    reason =
      `${config} is there, but Renovate read no configuration file and ran on its defaults, so what it proposes is not what the file asks for. In a directory with .git Renovate reads only the files Git tracks: a configuration Git does not track is not read`;
  } else if (f.lookedUpCount === 0) {
    status = "nothing-looked-up";
    reason =
      `Renovate found ${f.dependencyCount} dependencies in ${f.packageFileCount} package files and looked up none (${f.skippedCount} skipped, ${f.unresolvedCount} unresolved), so nothing can be said about updates; see enabledManagers, ignorePaths and packageRules in ${o.configRead}`;
  }
  const ok = status === "ok";
  const lookupComplete = ok && f.unresolvedCount === 0 &&
    f.tokenRequiredCount === 0 && f.unreadableCount === 0;
  return {
    ...base,
    ...f,
    status,
    ok,
    failure: o.failure,
    reason,
    lookupComplete,
    upToDate: lookupComplete && f.updateCount === 0,
    renovateVersion: o.renovateVersion,
    configFile: config,
    configRead: o.configRead,
    git,
    durationMs: now() - started,
  };
}

/** The record of a whole run, from the records of its repositories. */
export function inventory(
  g: GlobalArgs,
  e: Engine,
  records: Repository[],
  observedAt: string,
  durationMs: number,
): Inventory {
  const count = (pick: (r: Repository) => boolean) =>
    records.filter(pick).length;
  const updateCounts = emptyCounts();
  for (const r of records) {
    for (const key of Object.keys(updateCounts) as Array<keyof UpdateCounts>) {
      updateCounts[key] += r.updateCounts[key];
    }
  }
  return {
    image: g.image,
    engine: e.name,
    renovateVersion: records.map((r) => r.renovateVersion).find((v) => v) ??
      null,
    count: records.length,
    okCount: count((r) => r.ok),
    failedCount: count((r) => r.status === "failed"),
    nothingLookedUpCount: count((r) => r.status === "nothing-looked-up"),
    configNotReadCount: count((r) => r.status === "config-not-read"),
    noConfigCount: count((r) => r.status === "no-config"),
    notADirectoryCount: count((r) => r.status === "not-a-directory"),
    upToDateCount: count((r) => r.upToDate),
    outdatedCount: count((r) => r.updateCount > 0),
    incompleteCount: count((r) => r.ok && !r.lookupComplete),
    updateCount: records.reduce((n, r) => n + r.updateCount, 0),
    updateCounts,
    items: records.map((r) => ({
      path: r.path,
      dataName: r.dataName,
      status: r.status,
      ok: r.ok,
      lookupComplete: r.lookupComplete,
      upToDate: r.upToDate,
      lookedUpCount: r.lookedUpCount,
      updateCount: r.updateCount,
      majorCount: r.updateCounts.major,
      reason: r.reason,
    })),
    observedAt,
    durationMs,
  };
}

/**
 * Refuse a list in which two paths are one directory on disk: a symbolic
 * link to a directory of the list, or to a directory above it. `targets`
 * has compared the paths as text; this compares where they lead. A path
 * that does not exist leads nowhere and is left to be recorded.
 */
async function refuseSameDirectory(list: Target[]): Promise<void> {
  const seen = new Map<string, string>();
  for (const t of list) {
    let real: string;
    try {
      real = await Deno.realPath(t.directory);
    } catch {
      continue;
    }
    const other = seen.get(real);
    if (other !== undefined) {
      throw new Error(
        `repos names the same directory twice: ${shown(other)} and ${
          shown(t.path)
        } are both ${shown(real)}`,
      );
    }
    seen.set(real, t.path);
  }
}

/**
 * The definition's arguments, checked here too: swamp accepts a definition
 * that leaves out an argument without a default, and the bounds must hold
 * whatever handed the values over. The refusal names the argument and what
 * is wrong with it, never its value.
 */
export function checkedGlobalArgs(given: unknown): GlobalArgs {
  if (
    given === null || typeof given !== "object" ||
    (given as Record<string, unknown>).image === undefined
  ) {
    throw new Error(
      "the image argument is not set: name the Renovate image with its version, such as ghcr.io/renovatebot/renovate:<version>",
    );
  }
  const parsed = GlobalArgsSchema.safeParse(given);
  if (!parsed.success) {
    throw new Error(
      `the definition's arguments are refused: ${
        parsed.error.issues.slice(0, 5).map((i) =>
          `${i.path.join(".") || "arguments"}: ${brief(i.message, 150)}`
        ).join("; ")
      }`,
    );
  }
  return parsed.data;
}

/** The `lookup` method. */
export async function lookup(args: LookupArgs, context: Context) {
  // Every argument is checked before anything is started.
  const g = checkedGlobalArgs(context.globalArgs);
  const ctx = { ...context, globalArgs: g };
  const list = targets(args, ctx.repoDir);
  await refuseSameDirectory(list);
  const secrets = g.passProxy ? proxySecrets() : [];
  const started = now();
  const e = await engine(ctx);
  const user = await imageUser(ctx, e);
  if (g.passProxy && !e.podman) {
    ctx.logger.info(
      "passProxy is set and {engine} is not Podman: nothing is passed for it. Only Podman has a switch for the host's proxy variables; Docker passes what its own configuration names",
      { engine: e.name },
    );
  }
  ctx.logger.info(
    "Looking up {count} repositories with {image} on {engine}, one after another, each within {seconds} seconds",
    {
      count: list.length,
      image: g.image,
      engine: e.name,
      seconds: g.timeoutSeconds,
    },
  );
  const records: Repository[] = [];
  const handles: Array<{ name: string }> = [];
  for (const t of list) {
    if (ctx.signal?.aborted) throw cancelled(records.length, list.length);
    let record: Repository;
    try {
      record = await lookupOne(ctx, e, user, t, [
        records.length,
        list.length,
      ], secrets);
      // Written at once: a later repository that takes the run down does
      // not take this record with it.
      handles.push(await ctx.writeResource("repository", t.dataName, record));
    } catch (err) {
      if (ctx.signal?.aborted || records.length === 0) throw err;
      // No inventory is written for part of a list: it would read as the
      // whole of it. The error says how far the run came.
      throw new Error(
        `${
          err instanceof Error ? err.message : String(err)
        }; the run stopped after ${records.length} of ${list.length} repositories: their records are written, the inventory is not`,
        { cause: err },
      );
    }
    records.push(record);
    ctx.logger.info(
      record.ok
        ? "{path}: {updates} updates ({major} major), {lookedUp} of {dependencies} dependencies looked up, {unresolved} unresolved, {token} that need a GitHub token"
        : "{path}: {status}: {reason}",
      {
        path: t.path,
        status: record.status,
        reason: record.reason,
        updates: record.updateCount,
        major: record.updateCounts.major,
        lookedUp: record.lookedUpCount,
        dependencies: record.dependencyCount,
        unresolved: record.unresolvedCount,
        token: record.tokenRequiredCount,
      },
    );
  }
  const all = inventory(
    g,
    e,
    records,
    new Date().toISOString(),
    now() - started,
  );
  handles.push(await ctx.writeResource("inventory", INVENTORY_NAME, all));
  ctx.logger.info(
    "{count} repositories: {upToDate} up to date, {outdated} with updates, {failed} failed, {unsure} where nothing can be said, {skipped} not run",
    {
      count: all.count,
      upToDate: all.upToDateCount,
      outdated: all.outdatedCount,
      failed: all.failedCount,
      unsure: all.nothingLookedUpCount + all.configNotReadCount,
      skipped: all.noConfigCount + all.notADirectoryCount,
    },
  );
  return { dataHandles: handles };
}

/** Model definition for Renovate in local mode. */
export const model = {
  type: "@dataverket/renovate/local",
  version: "2026.11.12.1",
  upgrades: [
    {
      toVersion: "2026.11.12.1",
      description: "Tests only; global arguments unchanged",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  checks: {
    "container-binary-available": cliCheck({
      bin: (g) =>
        typeof g.containerBinary === "string" ? g.containerBinary : "podman",
      args: ["--version"],
      description:
        "The container binary runs and reports its version; lookup starts one Renovate container per repository with it",
      installHint: INSTALL_HINT,
      appliesTo: ["lookup"],
    }),
  },
  resources: {
    repository: {
      description:
        "One repository directory: whether Renovate ran, whether its lookup was complete, whether the repository is up to date, the proposed updates and their counts by type, and Renovate's warnings",
      schema: RepositorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    inventory: {
      description:
        "One run: every repository it was given with its status and counts, and the totals",
      schema: InventorySchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    lookup: {
      // Not a read: it starts containers, may pull an image and can take
      // minutes, so swamp runs the pre-flight check before it.
      kind: "action" as const,
      description:
        "Run Renovate in local mode on one repository directory or a list, one container each, one after another, and record the updates it would propose; a repository that fails is recorded and does not stop the others",
      arguments: LookupArgsSchema,
      execute: lookup,
    },
  },
};
