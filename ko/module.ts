/**
 * `@dataverket/ko/module` — one Go module built into container images by
 * [ko](https://ko.build): no Dockerfile, no container daemon, one image per
 * `main` package, pushed to a registry or kept local.
 *
 * `describe` records what ko would work with. `build` builds the module's
 * commands and records every image with its digest, and the build record
 * as a JSON file too, for an attestation to carry. `resolve` does the same
 * for the `ko://` references in a set of manifests and records the rendered
 * manifests, for whatever applies them, with every image pinned by digest in
 * them, ko-built or not, listed.
 *
 * ko and go are the interfaces being driven; both run as subprocesses in the
 * module's directory with arguments as argv arrays, never through a shell.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** ko 0.19's own default base image, used when neither `.ko.yaml` nor `baseImage` names one. */
export const KO_DEFAULT_BASE_IMAGE = "cgr.dev/chainguard/static:latest";

/** How ko names an image under `repo`. */
export const NAMING = [
  "default",
  "preserve-import-paths",
  "base-import-paths",
  "bare",
] as const;

/** The module's arguments. */
export const GlobalArgsSchema = z.object({
  dir: z.string().min(1).default(".").describe(
    "The Go module's directory, absolute or relative to the repository root",
  ),
  repo: z.string().default("").describe(
    "Where images go, as ko's KO_DOCKER_REPO: a registry path such as registry.example.org/team, or ko.local for the local container daemon. Needed to push; may be empty for a build that pushes nowhere",
  ),
  naming: z.enum(NAMING).default("base-import-paths").describe(
    "How an image is named under repo: base-import-paths is <repo>/<command>, preserve-import-paths is <repo>/<full import path>, bare is <repo> itself (one command only), default is ko's own <repo>/<command>-<md5 of the import path>",
  ),
  platforms: z.array(z.string().min(1)).default([]).describe(
    "Platforms to build for, os/arch[/variant], or all for every platform of the base image; empty is ko's default, linux/amd64",
  ),
  sbom: z.enum(["spdx", "none"]).default("spdx").describe(
    "The SBOM generated and pushed beside each image",
  ),
  baseImage: z.string().default("").describe(
    "Base image for every command, overriding .ko.yaml; pin it by digest for reproducible builds",
  ),
  configPath: z.string().default("").describe(
    "A .ko.yaml to use instead of the module's own, relative to the repository root",
  ),
  cache: z.string().default("").describe(
    "Directory where ko caches base images (KOCACHE), relative to the repository root; with a base image pinned by digest, builds then need the network once",
  ),
  insecureRegistry: z.boolean().default(false).describe(
    "Allow a registry served over plain HTTP",
  ),
  koBinary: z.string().min(1).default("ko"),
  goBinary: z.string().min(1).default("go"),
});

/** The module's arguments, parsed. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const PublishArgsSchema = z.object({
  tags: z.array(z.string().min(1)).default([]).describe(
    "Tags for every image; ko tags latest when empty",
  ),
  push: z.boolean().default(true).describe(
    "Push to repo; false builds without a registry and still records each digest",
  ),
  local: z.boolean().default(false).describe(
    "Load into the local container daemon instead of pushing; a repo of ko.local does the same",
  ),
  tarball: z.string().default("").describe(
    "Also write every image to this tarball, relative to the repository root",
  ),
  ociLayout: z.string().default("").describe(
    "Also write every image to this OCI layout directory, relative to the repository root",
  ),
  ldflags: z.array(z.string()).default([]).describe(
    "ldflags for go build, overriding .ko.yaml; one flag per entry, without commas",
  ),
  labels: z.array(z.string()).default([]).describe(
    "Labels for every image, key=value",
  ),
});

/** `build`'s arguments. */
export const BuildArgsSchema = PublishArgsSchema.extend({
  importPaths: z.array(z.string().min(1)).min(1).default(["."]).describe(
    "Packages to build, relative to the module (./cmd/api) or as patterns (./cmd/...); every package they name must be a main package",
  ),
});

/** `resolve`'s arguments. */
export const ResolveArgsSchema = PublishArgsSchema.extend({
  files: z.array(z.string().min(1)).min(1).describe(
    "Manifests whose ko:// image references are built, published and replaced by digests; files or directories, relative to the repository root",
  ),
  recursive: z.boolean().default(false).describe(
    "Descend into the directories named in files",
  ),
  selector: z.string().default("").describe(
    "Only resources matching this label selector",
  ),
});

type PublishArgs = z.infer<typeof PublishArgsSchema>;
type BuildArgs = z.infer<typeof BuildArgsSchema>;
type ResolveArgs = z.infer<typeof ResolveArgsSchema>;

const ModuleSchema = z.object({
  dir: z.string(),
  modulePath: z.string(),
  goVersion: z.string(),
  goToolVersion: z.string(),
  koVersion: z.string(),
  configFile: z.string(),
  baseImage: z.string(),
  baseImageSource: z.enum(["argument", "config", "ko-default"]),
  commands: z.array(z.string()),
  checkedAt: z.iso.datetime(),
});

const ImageSchema = z.object({
  importPath: z.string(),
  command: z.string(),
  ref: z.string(),
  repository: z.string(),
  tag: z.string(),
  digest: z.string(),
  tags: z.array(z.string()),
  platforms: z.array(z.string()),
  pushed: z.boolean(),
  local: z.boolean(),
  tarball: z.string(),
  ociLayout: z.string(),
  children: z.array(z.string()),
  buildId: z.string(),
  builtAt: z.iso.datetime(),
});

const BuildSchema = z.object({
  id: z.string(),
  dir: z.string(),
  repo: z.string(),
  naming: z.enum(NAMING),
  importPaths: z.array(z.string()),
  count: z.number().int(),
  refs: z.array(z.string()),
  digests: z.array(z.string()),
  pushed: z.boolean(),
  local: z.boolean(),
  tarball: z.string(),
  ociLayout: z.string(),
  sbom: z.enum(["spdx", "none"]),
  builtAt: z.iso.datetime(),
});

const ResolvedImageSchema = z.object({
  ref: z.string(),
  repository: z.string(),
  tag: z.string(),
  digest: z.string(),
  builtHere: z.boolean(),
});

const ResolutionSchema = z.object({
  id: z.string(),
  dir: z.string(),
  repo: z.string(),
  files: z.array(z.string()),
  images: z.array(ResolvedImageSchema),
  imageCount: z.number().int(),
  builtCount: z.number().int(),
  unpinned: z.array(z.string()),
  allPinned: z.boolean(),
  manifest: z.string(),
  pushed: z.boolean(),
  local: z.boolean(),
  resolvedAt: z.iso.datetime(),
});

type Module = z.infer<typeof ModuleSchema>;
type Image = z.infer<typeof ImageSchema>;
type Build = z.infer<typeof BuildSchema>;
type ResolvedImage = z.infer<typeof ResolvedImageSchema>;
type Resolution = z.infer<typeof ResolutionSchema>;

/** A data handle, as swamp returns it. */
export type Handle = { name: string };

/** A file writer, the part of swamp's that `resolve` uses. */
export type FileWriter = { writeText: (text: string) => Promise<Handle> };

/** The parts of swamp's method context the module uses. */
export type Context = {
  globalArgs: GlobalArgs;
  repoDir: string;
  signal?: AbortSignal;
  traceHeaders?: Readonly<Record<string, string>>;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
    overrides?: { tags?: Record<string, string> },
  ) => Promise<Handle>;
  createFileWriter?: (specName: string, name: string) => FileWriter;
};

/** A command's outcome. */
export type CommandResult = { code: number; stdout: string; stderr: string };

/** Where and with what a command runs. */
export type ExecOptions = { cwd: string; env: Record<string, string> };

/** Runs one command. Replaced in tests. */
export type Exec = (
  bin: string,
  args: string[],
  opts: ExecOptions,
  ctx: Context,
) => Promise<CommandResult>;

async function denoExec(
  bin: string,
  args: string[],
  opts: ExecOptions,
  ctx: Context,
): Promise<CommandResult> {
  // ko and go are the interfaces being driven; see README "Commands".
  // swamp-quality-ignore deno-command
  const out = await new Deno.Command(bin, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdout: "piped",
    stderr: "piped",
    signal: ctx.signal,
  }).output();
  const decoder = new TextDecoder();
  return {
    code: out.code,
    stdout: decoder.decode(out.stdout),
    stderr: decoder.decode(out.stderr),
  };
}

let exec: Exec = denoExec;

/** Swaps the command runner; returns a function that restores it. */
export function __setExec(fake: Exec): () => void {
  const prev = exec;
  exec = fake;
  return () => {
    exec = prev;
  };
}

/** Makes `path` absolute against `root` when it is relative; "" stays "". */
export function absolute(root: string, path: string): string {
  if (path === "" || path.startsWith("/")) return path;
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\.\/+/, "")}`;
}

/** The characters an image tag may hold, as go-containerregistry checks them. */
const TAG = /^[A-Za-z0-9_.-]{1,128}$/;
const PLATFORM = /^(all|[a-z0-9]+(\/[a-z0-9]+){0,2})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const HEX64 = /^[0-9a-f]{64}$/;

/** What is wrong with the arguments as written, or null. */
export function argumentProblem(
  g: z.input<typeof GlobalArgsSchema>,
): string | null {
  const repo = g.repo ?? "";
  if (/\s/.test(repo) || repo.includes("://")) {
    return `repo ${
      JSON.stringify(repo)
    } is not a registry path: no scheme, no whitespace`;
  }
  for (const p of g.platforms ?? []) {
    if (!PLATFORM.test(p)) {
      return `platform ${JSON.stringify(p)} is not os/arch[/variant] or all`;
    }
  }
  return null;
}

function tagProblem(tags: string[]): string | null {
  for (const t of tags) {
    if (!TAG.test(t)) {
      return `tag ${
        JSON.stringify(t)
      } is not an image tag: letters, digits, _ . - and at most 128 of them`;
    }
  }
  return null;
}

/** Splits an image reference as ko prints it into repository, tag and digest. */
export function parseRef(
  ref: string,
): { repository: string; tag: string; digest: string } {
  const at = ref.indexOf("@");
  let digest = at >= 0 ? ref.slice(at + 1) : "";
  const named = at >= 0 ? ref.slice(0, at) : ref;
  const slash = named.lastIndexOf("/");
  const colon = named.lastIndexOf(":");
  let repository = named;
  let tag = "";
  if (colon > slash) {
    repository = named.slice(0, colon);
    tag = named.slice(colon + 1);
  }
  // The daemon publisher names the loaded image by its digest's hex as a tag.
  if (digest === "" && HEX64.test(tag)) {
    digest = `sha256:${tag}`;
    tag = "";
  }
  return { repository, tag, digest };
}

const PINNED = /@sha256:[0-9a-f]{64}$/;

/** Every distinct `image:` value in a manifest, in order of first appearance. */
export function imageValues(yaml: string): string[] {
  const found: string[] = [];
  for (const m of yaml.matchAll(/^\s*-?\s*image:\s*["']?([^\s"'#]+)/gm)) {
    if (!found.includes(m[1])) found.push(m[1]);
  }
  return found;
}

/** Every `image:` value in a manifest that is not pinned by digest. */
export function unpinnedImages(yaml: string): string[] {
  return imageValues(yaml).filter((v) => !PINNED.test(v));
}

/** Every `image:` value in a manifest that is pinned by digest. */
export function pinnedImages(yaml: string): string[] {
  return imageValues(yaml).filter((v) => PINNED.test(v));
}

function moduleDir(ctx: Context): string {
  return absolute(ctx.repoDir, ctx.globalArgs.dir);
}

function koEnv(ctx: Context): Record<string, string> {
  const g = ctx.globalArgs;
  const env: Record<string, string> = { KO_DOCKER_REPO: g.repo };
  if (g.baseImage !== "") env.KO_DEFAULTBASEIMAGE = g.baseImage;
  if (g.configPath !== "") {
    env.KO_CONFIG_PATH = absolute(ctx.repoDir, g.configPath);
  }
  if (g.cache !== "") env.KOCACHE = absolute(ctx.repoDir, g.cache);
  if (ctx.traceHeaders?.traceparent) {
    env.TRACEPARENT = ctx.traceHeaders.traceparent;
  }
  if (ctx.traceHeaders?.tracestate) {
    env.TRACESTATE = ctx.traceHeaders.tracestate;
  }
  return env;
}

async function run(
  bin: string,
  args: string[],
  ctx: Context,
): Promise<CommandResult> {
  return await exec(bin, args, { cwd: moduleDir(ctx), env: koEnv(ctx) }, ctx);
}

async function mustRun(
  bin: string,
  args: string[],
  ctx: Context,
): Promise<string> {
  const res = await run(bin, args, ctx);
  if (res.code !== 0) {
    throw new Error(
      `${bin} ${args.join(" ")} exited ${res.code} in ${moduleDir(ctx)}: ${
        res.stderr.trim() || res.stdout.trim()
      }`,
    );
  }
  return res.stdout;
}

async function modulePath(ctx: Context): Promise<string> {
  const out = await mustRun(ctx.globalArgs.goBinary, ["list", "-m"], ctx);
  const path = out.trim().split("\n")[0]?.trim() ?? "";
  if (path === "") {
    throw new Error(`go list -m printed no module path in ${moduleDir(ctx)}`);
  }
  return path;
}

/**
 * The main packages `patterns` name, as full import paths. A set with none
 * throws when `required`, as `build` needs; `describe` records an empty list.
 */
async function mainPackages(
  ctx: Context,
  patterns: string[],
  required = true,
): Promise<string[]> {
  const out = await mustRun(ctx.globalArgs.goBinary, [
    "list",
    "-f",
    "{{.ImportPath}} {{.Name}}",
    ...patterns,
  ], ctx);
  const all = out.trim().split("\n").filter((l) => l !== "").map((l) => {
    const [importPath, name] = l.trim().split(/\s+/);
    return { importPath, name };
  });
  const main = all.filter((p) => p.name === "main").map((p) => p.importPath);
  if (required && main.length === 0) {
    throw new Error(
      `none of ${
        patterns.join(", ")
      } is a main package; ko builds commands, found: ${
        all.map((p) => `${p.importPath} (${p.name})`).join(", ") || "nothing"
      }`,
    );
  }
  return main;
}

/** The short name of a command: its import path under the module. */
export function commandName(modulePath: string, importPath: string): string {
  if (importPath === modulePath) return modulePath.split("/").pop() ?? "";
  return importPath.startsWith(`${modulePath}/`)
    ? importPath.slice(modulePath.length + 1)
    : importPath;
}

function publishFlags(ctx: Context, a: PublishArgs): string[] {
  const g = ctx.globalArgs;
  const flags: string[] = [];
  if (!a.push) flags.push("--push=false");
  if (a.local) flags.push("--local");
  if (a.tarball !== "") {
    flags.push("--tarball", absolute(ctx.repoDir, a.tarball));
  }
  if (a.ociLayout !== "") {
    flags.push("--oci-layout-path", absolute(ctx.repoDir, a.ociLayout));
  }
  switch (g.naming) {
    case "preserve-import-paths":
      flags.push("--preserve-import-paths");
      break;
    case "base-import-paths":
      flags.push("--base-import-paths");
      break;
    case "bare":
      flags.push("--bare");
      break;
  }
  if (g.platforms.length > 0) flags.push("--platform", g.platforms.join(","));
  flags.push("--sbom", g.sbom);
  if (a.tags.length > 0) flags.push("--tags", a.tags.join(","));
  for (const f of a.ldflags) flags.push("--ldflags", f);
  for (const l of a.labels) flags.push("--image-label", l);
  if (g.insecureRegistry) flags.push("--insecure-registry");
  return flags;
}

function publishProblem(ctx: Context, a: PublishArgs): string | null {
  const g = ctx.globalArgs;
  const tags = tagProblem(a.tags);
  if (tags) return tags;
  if (a.push && !a.local && g.repo === "") {
    return "repo is empty: name the registry path to push to, or set push: false";
  }
  // The daemon publisher is ko's only publisher when local: a tarball or a
  // layout asked for beside it would never be written.
  if ((a.local || g.repo.startsWith("ko.local")) && a.tarball !== "") {
    return "tarball is ignored by ko when loading into the daemon: drop tarball, or local";
  }
  if ((a.local || g.repo.startsWith("ko.local")) && a.ociLayout !== "") {
    return "ociLayout is ignored by ko when loading into the daemon: drop ociLayout, or local";
  }
  // ko names the layout as if it were a repository, so its path is held to
  // a repository's characters; it writes the layout and then fails otherwise.
  if (
    a.ociLayout !== "" &&
    !/^[a-z0-9_./-]+$/.test(absolute(ctx.repoDir, a.ociLayout))
  ) {
    return `ociLayout ${
      absolute(ctx.repoDir, a.ociLayout)
    } must hold only lowercase letters, digits, _ - . and /, as ko names the layout like a repository`;
  }
  // ko's tarball publisher writes images, not indexes.
  if (
    a.tarball !== "" && (g.platforms.length > 1 || g.platforms.includes("all"))
  ) {
    return `a tarball holds one platform, not ${
      g.platforms.join(",")
    }: build one platform, or use ociLayout`;
  }
  for (const f of a.ldflags) {
    if (f.includes(",")) {
      return `ldflags entry ${
        JSON.stringify(f)
      } holds a comma, which ko splits; put such flags in .ko.yaml`;
    }
  }
  for (const l of a.labels) {
    if (!l.includes("=") || l.includes(",")) {
      return `label ${JSON.stringify(l)} is not key=value without commas`;
    }
  }
  return null;
}

/** Runs ko with `--image-refs` and returns the references it recorded, in order. */
async function koWithRefs(
  ctx: Context,
  flags: string[],
  positional: string[],
): Promise<{ refs: string[]; stdout: string }> {
  const refsFile = await Deno.makeTempFile({ prefix: "ko-refs-" });
  try {
    const stdout = await mustRun(ctx.globalArgs.koBinary, [
      ...flags,
      "--image-refs",
      refsFile,
      ...positional,
    ], ctx);
    // ko opens the file only when it publishes something: a resolve that
    // finds no ko:// reference leaves it as created, empty.
    const text = await Deno.readTextFile(refsFile).catch(() => "");
    const refs = text.split("\n").map((l) => l.trim()).filter((l) => l !== "");
    return { refs, stdout };
  } finally {
    await Deno.remove(refsFile).catch(() => {});
  }
}

async function readConfig(
  ctx: Context,
): Promise<{ file: string; baseImage: string }> {
  const g = ctx.globalArgs;
  const candidates = g.configPath !== ""
    ? [absolute(ctx.repoDir, g.configPath)]
    : [`${moduleDir(ctx)}/.ko.yaml`, `${moduleDir(ctx)}/.ko.yml`];
  for (const file of candidates) {
    let text: string;
    try {
      text = await Deno.readTextFile(file);
    } catch {
      continue;
    }
    const m = text.match(/^\s*defaultBaseImage:\s*["']?([^\s"'#]+)/mi);
    return { file, baseImage: m ? m[1] : "" };
  }
  return { file: "", baseImage: "" };
}

/** What the module's directory lacks for ko to build it, or null. */
export async function moduleProblem(dir: string): Promise<string | null> {
  try {
    const stat = await Deno.stat(dir);
    if (!stat.isDirectory) return `${dir} is not a directory`;
  } catch {
    return `${dir} does not exist`;
  }
  try {
    await Deno.stat(`${dir}/go.mod`);
  } catch {
    return `${dir} has no go.mod; dir must be a Go module`;
  }
  return null;
}

/** A check's outcome. */
export type CheckResult = { pass: boolean; errors?: string[] };

/** Pre-flight checks, run before `build` and `resolve`. */
export const checks = {
  "arguments": {
    description:
      "repo is a registry path without scheme or whitespace, and every platform is os/arch[/variant] or all",
    labels: ["policy"],
    execute: (
      context: { globalArgs: z.input<typeof GlobalArgsSchema> },
    ): Promise<CheckResult> => {
      const problem = argumentProblem(context.globalArgs);
      return Promise.resolve(
        problem ? { pass: false, errors: [problem] } : { pass: true },
      );
    },
  },
  "module-found": {
    description: "dir exists and holds a go.mod",
    labels: ["local"],
    execute: async (
      context: {
        globalArgs: z.input<typeof GlobalArgsSchema>;
        repoDir?: string;
      },
    ): Promise<CheckResult> => {
      const dir = absolute(
        context.repoDir ?? ".",
        context.globalArgs.dir ?? ".",
      );
      const problem = await moduleProblem(dir);
      return problem ? { pass: false, errors: [problem] } : { pass: true };
    },
  },
  "ko-installed": {
    description: "koBinary runs and reports its version",
    labels: ["local", "live"],
    execute: async (
      context: {
        globalArgs: z.input<typeof GlobalArgsSchema>;
        repoDir?: string;
        signal?: AbortSignal;
        logger: Context["logger"];
      },
    ): Promise<CheckResult> => {
      const bin = context.globalArgs.koBinary ?? "ko";
      const cwd = context.repoDir ?? ".";
      try {
        const res = await exec(bin, ["version"], { cwd, env: {} }, {
          ...context,
          globalArgs: GlobalArgsSchema.parse(context.globalArgs),
          repoDir: cwd,
          writeResource: () => Promise.reject(new Error("not in a check")),
        });
        if (res.code !== 0) {
          return {
            pass: false,
            errors: [`${bin} version exited ${res.code}: ${res.stderr.trim()}`],
          };
        }
        return { pass: true };
      } catch (err) {
        return {
          pass: false,
          errors: [
            `${bin} could not be run (${
              err instanceof Error ? err.message : String(err)
            }); install ko, https://ko.build/install/, or set koBinary`,
          ],
        };
      }
    },
  },
};

/**
 * One `ko build`. The image's reference is the last line ko prints: for a
 * multi-platform build that is the index, and the per-platform images it
 * also published are the children.
 */
async function buildOne(
  ctx: Context,
  a: BuildArgs,
  importPath: string,
): Promise<{ ref: string; children: string[] }> {
  const { refs, stdout } = await koWithRefs(
    ctx,
    ["build", ...publishFlags(ctx, a)],
    [importPath],
  );
  const ref =
    stdout.trim().split("\n").map((l) => l.trim()).filter((l) => l !== "")
      .pop() ?? "";
  // The recorder normalizes what it writes (index.docker.io/library/x@...),
  // so the printed reference is matched by digest.
  const digest = parseRef(ref).digest;
  if (digest === "" || !refs.some((r) => parseRef(r).digest === digest)) {
    throw new Error(
      `ko build ${importPath} printed ${
        JSON.stringify(ref)
      } but recorded ${refs.length} image references: ${refs.join(", ")}`,
    );
  }
  return { ref, children: refs.filter((r) => parseRef(r).digest !== digest) };
}

/** Model definition for one Go module built by ko. */
export const model = {
  type: "@dataverket/ko/module",
  version: "2026.10.29.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    module: {
      description:
        "The module as ko sees it: path, Go and ko versions, config, base image, commands",
      schema: ModuleSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    image: {
      description: "One image build built: its reference and digest",
      schema: ImageSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    build: {
      description: "One build: every image it produced",
      schema: BuildSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    resolution: {
      description:
        "One resolve: every image pinned by digest in the rendered manifests, built here or not, and whether every image in them is pinned",
      schema: ResolutionSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  files: {
    buildRecord: {
      description:
        "The build record as JSON, the same fields as the build resource, for an attestation to carry as its predicate",
      contentType: "application/json",
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    manifests: {
      description:
        "The manifests resolve rendered, every ko:// reference replaced by an image pinned by digest",
      contentType: "application/yaml",
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    describe: {
      description:
        "Record what ko would work with: module path, Go and ko versions, the config file and base image in effect, and every main package",
      kind: "read" as const,
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const g = ctx.globalArgs;
        const dir = moduleDir(ctx);
        ctx.logger.info("Describing Go module in {dir}", { dir });
        const problem = await moduleProblem(dir);
        if (problem) throw new Error(problem);
        const path = await modulePath(ctx);
        const goVersion = (await mustRun(g.goBinary, [
          "list",
          "-m",
          "-f",
          "{{.GoVersion}}",
        ], ctx)).trim();
        const goToolVersion = (await mustRun(g.goBinary, ["version"], ctx))
          .trim();
        const koVersion = (await mustRun(g.koBinary, ["version"], ctx)).trim();
        const commands = await mainPackages(ctx, ["./..."], false);
        const config = await readConfig(ctx);
        const baseImage = g.baseImage !== ""
          ? { baseImage: g.baseImage, baseImageSource: "argument" as const }
          : config.baseImage !== ""
          ? { baseImage: config.baseImage, baseImageSource: "config" as const }
          : {
            baseImage: KO_DEFAULT_BASE_IMAGE,
            baseImageSource: "ko-default" as const,
          };
        const record: Module = {
          dir,
          modulePath: path,
          goVersion,
          goToolVersion,
          koVersion,
          configFile: config.file,
          ...baseImage,
          commands,
          checkedAt: new Date().toISOString(),
        };
        ctx.logger.info("{module} has {count} commands; ko {ko}", {
          module: path,
          count: commands.length,
          ko: koVersion,
        });
        const handle = await ctx.writeResource("module", "module", record);
        return { dataHandles: [handle] };
      },
    },
    build: {
      description:
        "Build every main package importPaths name into an image, push or keep it as asked, and record each image with its digest, plus the build record, also as a JSON file",
      arguments: BuildArgsSchema,
      execute: async (args: BuildArgs, ctx: Context) => {
        const g = ctx.globalArgs;
        const dir = moduleDir(ctx);
        const problem = (await moduleProblem(dir)) ?? publishProblem(ctx, args);
        if (problem) throw new Error(problem);
        if (!ctx.createFileWriter) {
          throw new Error("build needs createFileWriter in its context");
        }
        const path = await modulePath(ctx);
        const importPaths = await mainPackages(ctx, args.importPaths);
        if (g.naming === "bare" && importPaths.length > 1) {
          throw new Error(
            `naming bare names every image ${g.repo}; it needs one command, got ${importPaths.length}: ${
              importPaths.join(", ")
            }`,
          );
        }
        // ko is run once per command, and its tarball publisher rewrites the
        // file on every run; an OCI layout is appended to instead.
        if (args.tarball !== "" && importPaths.length > 1) {
          throw new Error(
            `a tarball holds one command's image and ko would rewrite it ${importPaths.length} times: build one command, or use ociLayout`,
          );
        }
        const local = args.local || g.repo.startsWith("ko.local");
        const pushed = args.push && !local;
        const id = crypto.randomUUID();
        const builtAt = new Date().toISOString();
        ctx.logger.info(
          "Building {count} commands of {module} with ko, {where}",
          {
            count: importPaths.length,
            module: path,
            where: local
              ? "into the local daemon"
              : pushed
              ? `pushed to ${g.repo}`
              : "pushed nowhere",
          },
        );
        const images: Image[] = [];
        for (const importPath of importPaths) {
          const { ref, children } = await buildOne(ctx, args, importPath);
          const parsed = parseRef(ref);
          if (!DIGEST.test(parsed.digest)) {
            throw new Error(
              `ko build ${importPath} recorded a reference without a digest: ${ref}`,
            );
          }
          images.push({
            importPath,
            command: commandName(path, importPath),
            ref,
            ...parsed,
            tags: args.tags,
            platforms: g.platforms,
            pushed,
            local,
            tarball: absolute(ctx.repoDir, args.tarball),
            ociLayout: absolute(ctx.repoDir, args.ociLayout),
            children,
            buildId: id,
            builtAt,
          });
          ctx.logger.info("Built {ref}", { ref });
        }
        const handles: Handle[] = [];
        for (const image of images) {
          handles.push(
            await ctx.writeResource(
              "image",
              `image-${image.command.replace(/[^A-Za-z0-9_.-]+/g, "-")}`,
              image,
              { tags: { build: id } },
            ),
          );
        }
        const build: Build = {
          id,
          dir,
          repo: g.repo,
          naming: g.naming,
          importPaths,
          count: images.length,
          refs: images.map((i) => i.ref),
          digests: images.map((i) => i.digest),
          pushed,
          local,
          tarball: absolute(ctx.repoDir, args.tarball),
          ociLayout: absolute(ctx.repoDir, args.ociLayout),
          sbom: g.sbom,
          builtAt,
        };
        handles.push(
          await ctx.writeResource("build", "build", build, {
            tags: { build: id },
          }),
        );
        // The same record as a file, for cosign attest to take as a predicate.
        handles.push(
          await ctx.createFileWriter("buildRecord", "buildRecord").writeText(
            JSON.stringify(build, null, 2) + "\n",
          ),
        );
        return { dataHandles: handles };
      },
    },
    resolve: {
      description:
        "Build and publish the ko:// references in files, record the rendered manifests, every image pinned by digest in them, built here or not, and whether any image in them is not pinned",
      arguments: ResolveArgsSchema,
      execute: async (args: ResolveArgs, ctx: Context) => {
        const g = ctx.globalArgs;
        const dir = moduleDir(ctx);
        const problem = (await moduleProblem(dir)) ?? publishProblem(ctx, args);
        if (problem) throw new Error(problem);
        if (!ctx.createFileWriter) {
          throw new Error("resolve needs createFileWriter in its context");
        }
        const local = args.local || g.repo.startsWith("ko.local");
        const pushed = args.push && !local;
        const files = args.files.map((f) => absolute(ctx.repoDir, f));
        ctx.logger.info("Resolving {count} manifests with ko, {where}", {
          count: files.length,
          where: local
            ? "images into the local daemon"
            : pushed
            ? `images pushed to ${g.repo}`
            : "images pushed nowhere",
        });
        const koArgs = ["resolve"];
        for (const f of files) koArgs.push("-f", f);
        if (args.recursive) koArgs.push("-R");
        if (args.selector !== "") koArgs.push("-l", args.selector);
        koArgs.push(...publishFlags(ctx, args));
        const { refs, stdout } = await koWithRefs(ctx, koArgs, []);
        // What ko recorded is what it built here, matched by digest: the
        // recorder normalizes names, and for a multi-platform build it also
        // records the per-platform images, which no manifest names.
        const built = new Set<string>();
        for (const ref of refs) {
          const digest = parseRef(ref).digest;
          if (!DIGEST.test(digest)) {
            throw new Error(
              `ko resolve recorded a reference without a digest: ${ref}`,
            );
          }
          built.add(digest);
        }
        const images: ResolvedImage[] = pinnedImages(stdout).map((ref) => {
          const parsed = parseRef(ref);
          return { ref, ...parsed, builtHere: built.has(parsed.digest) };
        });
        const builtCount = images.filter((i) => i.builtHere).length;
        const unpinned = unpinnedImages(stdout);
        const id = crypto.randomUUID();
        const manifest = await ctx.createFileWriter("manifests", "manifests")
          .writeText(stdout);
        const record: Resolution = {
          id,
          dir,
          repo: g.repo,
          files,
          images,
          imageCount: images.length,
          builtCount,
          unpinned,
          allPinned: unpinned.length === 0,
          manifest: manifest.name,
          pushed,
          local,
          resolvedAt: new Date().toISOString(),
        };
        ctx.logger.info(
          "Resolved {images} images pinned by digest, {built} of them built here; {unpinned} images in the manifests are not pinned",
          {
            images: images.length,
            built: builtCount,
            unpinned: unpinned.length,
          },
        );
        const handle = await ctx.writeResource(
          "resolution",
          "resolution",
          record,
          {
            tags: { resolution: id },
          },
        );
        return { dataHandles: [manifest, handle] };
      },
    },
  },
};
