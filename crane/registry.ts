/**
 * `@dataverket/crane/registry` — one container registry driven through
 * [crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md):
 * tags resolved to digests, images and indexes described, images copied in
 * by digest, digests given tags, and a file read out of an artifact's layer.
 *
 * A credential, when one is given, reaches crane on stdin into a docker
 * config that exists for one run only; it is never an argument. crane runs as
 * a subprocess in the repository root with arguments as argv arrays, never
 * through a shell.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The registry's arguments. */
export const GlobalArgsSchema = z.object({
  registry: z.string().default("").describe(
    "The registry copy and tag write to and the credential logs in to, host[:port], such as registry.example.org; a reference without a slash is read from <registry>/<namespace>/. Empty for a definition that only reads full references",
  ),
  namespace: z.string().default("").describe(
    "The path copy and tag work under: copy puts an image at <registry>/<namespace>/<source registry>/<path>, tag writes to <registry>/<namespace>/<name>; empty for the registry's root",
  ),
  username: z.string().meta({ sensitive: true }).default("").describe(
    "The credential's user, written as a vault expression; empty to use the container config of the user running swamp",
  ),
  password: z.string().meta({ sensitive: true }).default("").describe(
    "The credential's password or token, written as a vault expression; reaches crane on stdin, never as an argument",
  ),
  insecure: z.boolean().default(false).describe(
    "Allow a registry served over plain HTTP or with a certificate that does not verify; localhost is plain HTTP regardless",
  ),
  craneBinary: z.string().min(1).default("crane"),
});

/** The registry's arguments, parsed. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

const RefsSchema = z.array(z.string().min(1)).min(1).describe(
  "Image references, <repository>:<tag> or <repository>@sha256:<digest>, registry included; one without a slash is taken under <registry>/<namespace>/",
);

/** `digest`'s arguments. */
export const DigestArgsSchema = z.object({
  refs: RefsSchema,
});

/** `describe`'s arguments. */
export const DescribeArgsSchema = z.object({
  refs: RefsSchema,
});

/** `copy`'s arguments. */
export const CopyArgsSchema = z.object({
  sources: z.array(z.string().min(1)).min(1).describe(
    "Images pinned by digest, <repository>:<tag>@sha256:<digest>; each lands at <registry>/<namespace>/<source registry>/<path>:<tag>, docker.io/library/nats for nats, or at @<digest> alone when no tag is given",
  ),
});

/** `tag`'s arguments. */
export const TagArgsSchema = z.object({
  name: z.string().min(1).describe(
    "The repository under the namespace, such as config-prod, or docker.io/library/nats for an image copy put there",
  ),
  digest: z.string().regex(/^sha256:[0-9a-f]{64}$/).describe(
    "The digest the tag is to point at; it must already be in the repository",
  ),
  tag: z.string().min(1).describe("The tag to give it, such as stable"),
});

/** `blob`'s arguments. */
export const BlobArgsSchema = z.object({
  ref: z.string().min(1).describe(
    "The artifact, <repository>:<tag> or <repository>@sha256:<digest>",
  ),
  path: z.string().default("").describe(
    "The file to read out of the layer, such as release.json, when the layer is a tar or tar+gzip; empty records the whole layer as the file",
  ),
  layer: z.number().int().min(0).default(0).describe(
    "Which layer of the artifact, counted from zero; a Flux artifact has one",
  ),
});

type DigestArgs = z.infer<typeof DigestArgsSchema>;
type DescribeArgs = z.infer<typeof DescribeArgsSchema>;
type CopyArgs = z.infer<typeof CopyArgsSchema>;
type TagArgs = z.infer<typeof TagArgsSchema>;
type BlobArgs = z.infer<typeof BlobArgsSchema>;

const DigestSchema = z.object({
  ref: z.string(),
  repository: z.string(),
  name: z.string(),
  tag: z.string(),
  digest: z.string(),
  pinned: z.string(),
  previousDigest: z.string(),
  changed: z.boolean(),
  firstSeenAt: z.iso.datetime(),
  seenAt: z.iso.datetime(),
});

const ChildSchema = z.object({
  digest: z.string(),
  mediaType: z.string(),
  platform: z.string(),
  size: z.number().int(),
});

const ImageSchema = z.object({
  ref: z.string(),
  repository: z.string(),
  name: z.string(),
  tag: z.string(),
  digest: z.string(),
  kind: z.enum(["image", "index"]),
  mediaType: z.string(),
  platforms: z.array(z.string()),
  children: z.array(ChildSchema),
  configDigest: z.string(),
  created: z.string(),
  labels: z.record(z.string(), z.string()),
  annotations: z.record(z.string(), z.string()),
  layers: z.number().int(),
  size: z.number().int(),
  describedAt: z.iso.datetime(),
});

const MirrorSchema = z.object({
  source: z.string(),
  sourceRepository: z.string(),
  target: z.string(),
  repository: z.string(),
  name: z.string(),
  tag: z.string(),
  digest: z.string(),
  action: z.enum(["copied", "unchanged"]),
  copiedAt: z.iso.datetime(),
});

const TaggingSchema = z.object({
  ref: z.string(),
  repository: z.string(),
  name: z.string(),
  tag: z.string(),
  digest: z.string(),
  previousDigest: z.string(),
  changed: z.boolean(),
  taggedAt: z.iso.datetime(),
});

const BlobSchema = z.object({
  ref: z.string(),
  repository: z.string(),
  digest: z.string(),
  layerDigest: z.string(),
  layerMediaType: z.string(),
  path: z.string(),
  text: z.string(),
  json: z.unknown(),
  sha256: z.string(),
  size: z.number().int(),
  readAt: z.iso.datetime(),
});

type Digest = z.infer<typeof DigestSchema>;
type Child = z.infer<typeof ChildSchema>;
type Image = z.infer<typeof ImageSchema>;
type Mirror = z.infer<typeof MirrorSchema>;
type Tagging = z.infer<typeof TaggingSchema>;
type Blob = z.infer<typeof BlobSchema>;

/** A data handle, as swamp returns it. */
export type Handle = { name: string };

/** The parts of swamp's method context the registry uses. */
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
  ) => Promise<Handle>;
  readResource?: (
    instanceName: string,
  ) => Promise<Record<string, unknown> | null>;
};

/** A command's outcome; stdout is bytes, since a blob is one. */
export type CommandResult = {
  code: number;
  stdout: Uint8Array;
  stderr: string;
};

/** Where and with what a command runs; stdin carries a credential. */
export type ExecOptions = {
  cwd: string;
  env: Record<string, string>;
  stdin?: string;
};

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
  // crane is the interface being driven; see README "Commands".
  // swamp-quality-ignore deno-command
  const child = new Deno.Command(bin, {
    args,
    cwd: opts.cwd,
    env: opts.env,
    stdin: opts.stdin === undefined ? "null" : "piped",
    stdout: "piped",
    stderr: "piped",
    signal: ctx.signal,
  }).spawn();
  if (opts.stdin !== undefined) {
    const writer = child.stdin.getWriter();
    await writer.write(new TextEncoder().encode(opts.stdin));
    await writer.close();
  }
  const out = await child.output();
  return {
    code: out.code,
    stdout: out.stdout,
    stderr: new TextDecoder().decode(out.stderr),
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

const DIGEST = /^sha256:[0-9a-f]{64}$/;
const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const REPOSITORY_PATH =
  /^[a-z0-9]+(?:[._-]+[a-z0-9]+)*(?:\/[a-z0-9]+(?:[._-]+[a-z0-9]+)*)*$/;
const REGISTRY = /^[A-Za-z0-9.-]+(?::[0-9]+)?$/;
/** How crane says a manifest or repository is not there. */
const NOT_FOUND = /MANIFEST_UNKNOWN|NAME_UNKNOWN|NOT_FOUND|\b404\b/;

/** A reference split into its parts; a tag and a digest may both be present. */
export type Ref = {
  repository: string;
  name: string;
  tag: string;
  digest: string;
};

/** Splits `<repository>[:<tag>][@<digest>]`, or says why it is not one. */
export function parseRef(ref: string): Ref | string {
  if (ref === "" || /\s/.test(ref) || ref.includes("://")) {
    return `${
      JSON.stringify(ref)
    } is not an image reference: no scheme, no whitespace`;
  }
  const at = ref.indexOf("@");
  const digest = at >= 0 ? ref.slice(at + 1) : "";
  if (at >= 0 && !DIGEST.test(digest)) {
    return `${JSON.stringify(ref)} has a digest that is not sha256:<64 hex>`;
  }
  const named = at >= 0 ? ref.slice(0, at) : ref;
  const slash = named.lastIndexOf("/");
  const colon = named.lastIndexOf(":");
  let repository = named;
  let tag = "";
  if (colon > slash) {
    repository = named.slice(0, colon);
    tag = named.slice(colon + 1);
    if (!TAG.test(tag)) {
      return `${JSON.stringify(ref)} has a tag that is not an image tag`;
    }
  }
  if (repository === "" || repository.endsWith("/")) {
    return `${JSON.stringify(ref)} names no repository`;
  }
  const name = repository.slice(repository.lastIndexOf("/") + 1);
  return { repository, name, tag, digest };
}

/** The reference as crane is given it: by digest when one is known, else by tag. */
export function refString(r: Ref): string {
  if (r.digest !== "") return `${r.repository}@${r.digest}`;
  return r.tag !== "" ? `${r.repository}:${r.tag}` : r.repository;
}

/** `<registry>/<namespace>/<name>`, with an empty namespace left out. */
export function repositoryUnder(g: GlobalArgs, name: string): string {
  return [g.registry, g.namespace, name].filter((p) => p !== "").join("/");
}

/** Docker Hub's other names for itself, as a reference may give them. */
const DOCKER_HUB = new Set([
  "docker.io",
  "index.docker.io",
  "registry-1.docker.io",
]);

/**
 * Where copy puts a source under the namespace: its whole repository with its
 * registry, `<registry>/<path>`, the path a registry mirror is asked for, so a
 * Talos or containerd mirror of each upstream is one prefix of the namespace.
 * A bare name is Docker Hub's, whose official images are under library/, as
 * containerd asks for them, and index.docker.io and registry-1.docker.io are
 * docker.io. A registry's port joins its host with an underscore, since a
 * repository path has no colon and a host name no underscore, so two sources
 * never share a path. An Error says why there is none.
 */
export function sourcePath(repository: string): string | Error {
  const slash = repository.indexOf("/");
  const first = slash >= 0 ? repository.slice(0, slash) : "";
  const hosted = first.includes(".") || first.includes(":") ||
    first === "localhost";
  let host = hosted ? first.toLowerCase() : "docker.io";
  let path = hosted ? repository.slice(slash + 1) : repository;
  if (DOCKER_HUB.has(host)) {
    host = "docker.io";
    if (!path.includes("/")) path = `library/${path}`;
  }
  const full = `${host.replace(":", "_")}/${path}`;
  if (!REPOSITORY_PATH.test(full)) {
    return new Error(
      `${JSON.stringify(repository)} cannot be mirrored: ${
        JSON.stringify(full)
      } is not a repository path`,
    );
  }
  return full;
}

/** What is wrong with the arguments as written, or null. */
export function argumentProblem(
  g: z.input<typeof GlobalArgsSchema>,
): string | null {
  const registry = g.registry ?? "";
  if (registry !== "" && !REGISTRY.test(registry)) {
    return `registry ${
      JSON.stringify(registry)
    } is not a host[:port]: no scheme, no path, no whitespace`;
  }
  const namespace = g.namespace ?? "";
  if (namespace !== "" && !REPOSITORY_PATH.test(namespace)) {
    return `namespace ${
      JSON.stringify(namespace)
    } is not a repository path: lowercase letters, digits, separators . _ - and /`;
  }
  const username = g.username ?? "";
  const password = g.password ?? "";
  for (
    const [name, value] of [["username", username], ["password", password]]
  ) {
    if (value.includes("${{")) {
      return `${name} holds an unevaluated expression; a check on an auto-definition sees the text a workflow wrote, run the workflow instead`;
    }
  }
  if ((username === "") !== (password === "")) {
    return "username and password come together: both from the vault, or neither";
  }
  return null;
}

/** The sanitized repository and 12 hex of a digest, as record names use them. */
function hex12(digest: string): string {
  return digest.slice("sha256:".length, "sha256:".length + 12);
}

function sanitized(text: string): string {
  return text.replace(/[^A-Za-z0-9_.-]+/g, "-");
}

/** `<spec>-<repository>-<tag or 12 hex of the digest>`: unique per image, in any repository. */
export function imageInstance(spec: string, r: Ref): string {
  const by = r.tag !== "" ? sanitized(r.tag) : hex12(r.digest);
  return `${spec}-${sanitized(r.repository)}-${by}`;
}

/** Temporary files a method needs, removed when it is done. */
class Scratch {
  readonly paths: string[] = [];
  async dir(prefix: string): Promise<string> {
    const path = await Deno.makeTempDir({ prefix });
    this.paths.push(path);
    return path;
  }
  async clean(): Promise<void> {
    for (const p of this.paths) {
      await Deno.remove(p, { recursive: true }).catch(() => {});
    }
  }
}

/** A session with crane: its environment, and the docker config a credential was logged in to. */
type Session = { env: Record<string, string> };

function baseEnv(ctx: Context): Record<string, string> {
  const env: Record<string, string> = {};
  if (ctx.traceHeaders?.traceparent) {
    env.TRACEPARENT = ctx.traceHeaders.traceparent;
  }
  if (ctx.traceHeaders?.tracestate) {
    env.TRACESTATE = ctx.traceHeaders.tracestate;
  }
  return env;
}

const text = (b: Uint8Array) => new TextDecoder().decode(b);

async function run(
  args: string[],
  ctx: Context,
  session: Session,
  stdin?: string,
): Promise<CommandResult> {
  const g = ctx.globalArgs;
  const argv = g.insecure ? [...args, "--insecure"] : args;
  return await exec(
    g.craneBinary,
    argv,
    { cwd: ctx.repoDir, env: session.env, stdin },
    ctx,
  );
}

function failure(args: string[], res: CommandResult): Error {
  return new Error(
    `crane ${args.join(" ")} exited ${res.code}: ${
      res.stderr.trim() || text(res.stdout).trim()
    }`,
  );
}

async function mustRun(
  args: string[],
  ctx: Context,
  session: Session,
  stdin?: string,
): Promise<Uint8Array> {
  const res = await run(args, ctx, session, stdin);
  if (res.code !== 0) throw failure(args, res);
  return res.stdout;
}

/**
 * Opens a session: with a credential, a docker config of its own that holds
 * only this login, made with the password on crane's stdin; without one, the
 * container config of the user running swamp.
 */
async function open(ctx: Context, scratch: Scratch): Promise<Session> {
  const g = ctx.globalArgs;
  const session: Session = { env: baseEnv(ctx) };
  if (g.username === "") return session;
  if (g.registry === "") {
    throw new Error(
      "username is set but registry is empty: nothing to log in to",
    );
  }
  const dir = await scratch.dir("crane-docker-config-");
  session.env.DOCKER_CONFIG = dir;
  await mustRun(
    ["auth", "login", g.registry, "--username", g.username, "--password-stdin"],
    ctx,
    session,
    g.password,
  );
  ctx.logger.info("Logged in to {registry} for this run", {
    registry: g.registry,
  });
  return session;
}

/** A reference as given, a bare name completed under the registry and namespace. */
function resolveRef(ctx: Context, ref: string): Ref {
  const g = ctx.globalArgs;
  const full = ref.includes("/") ? ref : repositoryUnder(g, ref);
  if (!ref.includes("/") && g.registry === "") {
    throw new Error(
      `${JSON.stringify(ref)} has no registry and the definition names none`,
    );
  }
  const parsed = parseRef(full);
  if (typeof parsed === "string") throw new Error(parsed);
  return parsed;
}

/** The digest `ref` resolves to, "" when the manifest is not there, or a thrown error for anything else. */
async function digestOf(
  ref: string,
  ctx: Context,
  session: Session,
): Promise<string> {
  const args = ["digest", ref];
  const res = await run(args, ctx, session);
  if (res.code === 0) {
    const digest = text(res.stdout).trim();
    if (!DIGEST.test(digest)) {
      throw new Error(`crane digest ${ref} printed ${JSON.stringify(digest)}`);
    }
    return digest;
  }
  if (NOT_FOUND.test(res.stderr)) return "";
  throw failure(args, res);
}

function parseJson(what: string, bytes: Uint8Array): Record<string, unknown> {
  let parsed: unknown;
  try {
    parsed = JSON.parse(text(bytes));
  } catch {
    throw new Error(`${what} is not JSON: ${text(bytes).slice(0, 200)}`);
  }
  if (parsed === null || typeof parsed !== "object" || Array.isArray(parsed)) {
    throw new Error(`${what} is not a JSON object`);
  }
  return parsed as Record<string, unknown>;
}

type Descriptor = {
  mediaType?: string;
  size?: number;
  digest?: string;
  platform?: { os?: string; architecture?: string; variant?: string };
  annotations?: Record<string, string>;
};

type Manifest = {
  mediaType?: string;
  manifests?: Descriptor[];
  config?: Descriptor;
  layers?: Descriptor[];
  annotations?: Record<string, string>;
};

/** `os/arch[/variant]` of a descriptor, or "" without a platform. */
export function platformOf(d: Descriptor): string {
  const p = d.platform;
  if (!p || !p.os || !p.architecture) return "";
  return [p.os, p.architecture, p.variant].filter((x) => x).join("/");
}

/** Whether a manifest is an index: it lists manifests, or its media type says so. */
export function isIndex(m: Manifest): boolean {
  return Array.isArray(m.manifests) ||
    /index|manifest\.list/.test(m.mediaType ?? "");
}

function stringRecord(o: unknown): Record<string, string> {
  const out: Record<string, string> = {};
  if (o && typeof o === "object") {
    for (const [k, v] of Object.entries(o as Record<string, unknown>)) {
      out[k] = typeof v === "string" ? v : JSON.stringify(v);
    }
  }
  return out;
}

function imageBytes(m: Manifest): number {
  return (m.config?.size ?? 0) +
    (m.layers ?? []).reduce((n, l) => n + (l.size ?? 0), 0);
}

async function manifestOf(
  ref: string,
  ctx: Context,
  session: Session,
): Promise<Manifest> {
  return parseJson(
    `crane manifest ${ref} output`,
    await mustRun(["manifest", ref], ctx, session),
  ) as Manifest;
}

/** The repository's platform images in an index: every child with a platform that is not unknown. */
function platformChildren(m: Manifest): Descriptor[] {
  return (m.manifests ?? []).filter((d) => {
    const p = platformOf(d);
    return p !== "" && !p.startsWith("unknown/");
  });
}

/**
 * Reads `ref`'s manifest, and for an index every platform image's, and the
 * config of the image or of the index's first platform image.
 */
async function describeOne(
  ref: Ref,
  ctx: Context,
  session: Session,
): Promise<Image> {
  const given = refString(ref);
  const digest = await digestOf(given, ctx, session);
  if (digest === "") throw new Error(`${given} is not in the registry`);
  const pinned = `${ref.repository}@${digest}`;
  const manifest = await manifestOf(pinned, ctx, session);
  const index = isIndex(manifest);
  const children: Child[] = [];
  let configRef = pinned;
  let configDigest = manifest.config?.digest ?? "";
  let layers = 0;
  let size = 0;
  if (index) {
    for (const d of manifest.manifests ?? []) {
      children.push({
        digest: d.digest ?? "",
        mediaType: d.mediaType ?? "",
        platform: platformOf(d),
        size: d.size ?? 0,
      });
    }
    const platforms = platformChildren(manifest);
    if (platforms.length === 0) {
      throw new Error(`${pinned} is an index with no platform image`);
    }
    for (const d of platforms) {
      const child = await manifestOf(
        `${ref.repository}@${d.digest}`,
        ctx,
        session,
      );
      if (d === platforms[0]) configDigest = child.config?.digest ?? "";
      layers += (child.layers ?? []).length;
      size += imageBytes(child);
    }
    configRef = `${ref.repository}@${platforms[0].digest}`;
  } else {
    layers = (manifest.layers ?? []).length;
    size = imageBytes(manifest);
  }
  const config = parseJson(
    `crane config ${configRef} output`,
    await mustRun(["config", configRef], ctx, session),
  ) as {
    created?: string;
    os?: string;
    architecture?: string;
    variant?: string;
    config?: { Labels?: Record<string, string> };
  };
  const platforms = index
    ? platformChildren(manifest).map(platformOf)
    : [platformOf({ platform: config })].filter((p) => p !== "");
  return {
    ref: given,
    repository: ref.repository,
    name: ref.name,
    tag: ref.tag,
    digest,
    kind: index ? "index" : "image",
    mediaType: manifest.mediaType ?? "",
    platforms,
    children,
    configDigest,
    created: config.created ?? "",
    labels: stringRecord(config.config?.Labels),
    annotations: stringRecord(manifest.annotations),
    layers,
    size,
    describedAt: new Date().toISOString(),
  };
}

/** One entry of a tar archive. */
export type TarEntry = { name: string; type: string; data: Uint8Array };

function octal(bytes: Uint8Array): number {
  const s = text(bytes).replace(/\0.*$/s, "").trim();
  return s === "" ? 0 : parseInt(s, 8);
}

function cstring(bytes: Uint8Array): string {
  return text(bytes).replace(/\0.*$/s, "");
}

/** The entries of a tar archive, ustar and pax, in order; `./` prefixes dropped. */
export function* tarEntries(bytes: Uint8Array): Generator<TarEntry> {
  let offset = 0;
  let longName = "";
  let paxPath = "";
  while (offset + 512 <= bytes.length) {
    const header = bytes.subarray(offset, offset + 512);
    if (header.every((b) => b === 0)) break;
    const size = octal(header.subarray(124, 136));
    const type = String.fromCharCode(header[156]) || "0";
    const magic = cstring(header.subarray(257, 263));
    const prefix = magic.startsWith("ustar")
      ? cstring(header.subarray(345, 500))
      : "";
    let name = cstring(header.subarray(0, 100));
    if (prefix !== "") name = `${prefix}/${name}`;
    const data = bytes.subarray(offset + 512, offset + 512 + size);
    offset += 512 + Math.ceil(size / 512) * 512;
    if (type === "L") {
      longName = cstring(data);
      continue;
    }
    if (type === "x") {
      for (const record of text(data).split("\n")) {
        const m = record.match(/^\d+ path=(.*)$/);
        if (m) paxPath = m[1];
      }
      continue;
    }
    if (type === "g") continue;
    if (paxPath !== "") name = paxPath;
    else if (longName !== "") name = longName;
    paxPath = "";
    longName = "";
    yield { name: name.replace(/^(\.\/)+/, ""), type, data };
  }
}

async function gunzip(bytes: Uint8Array): Promise<Uint8Array> {
  const stream = new Blob([bytes as BlobPart]).stream().pipeThrough(
    new DecompressionStream("gzip"),
  );
  return new Uint8Array(await new Response(stream).arrayBuffer());
}

function isGzip(bytes: Uint8Array): boolean {
  return bytes.length > 2 && bytes[0] === 0x1f && bytes[1] === 0x8b;
}

function isTar(bytes: Uint8Array): boolean {
  return bytes.length >= 512 &&
    cstring(bytes.subarray(257, 263)).startsWith("ustar");
}

/** `path` out of a layer: a tar, gzipped or not, or the whole blob when path is empty. */
export async function fileFromLayer(
  blob: Uint8Array,
  path: string,
): Promise<Uint8Array> {
  if (path === "") return blob;
  const bytes = isGzip(blob) ? await gunzip(blob) : blob;
  if (!isTar(bytes)) {
    throw new Error(
      `the layer is not a tar archive, so ${
        JSON.stringify(path)
      } cannot be read out of it; leave path empty to record the whole layer`,
    );
  }
  const want = path.replace(/^(\.\/)+/, "");
  const seen: string[] = [];
  for (const entry of tarEntries(bytes)) {
    if (entry.type !== "0" && entry.type !== "\0") continue;
    if (entry.name === want) return entry.data;
    seen.push(entry.name);
  }
  throw new Error(
    `${JSON.stringify(path)} is not in the layer; it holds: ${
      seen.join(", ") || "nothing"
    }`,
  );
}

async function sha256Hex(bytes: Uint8Array): Promise<string> {
  const hash = await crypto.subtle.digest("SHA-256", bytes as BufferSource);
  return Array.from(new Uint8Array(hash)).map((b) =>
    b.toString(16).padStart(2, "0")
  ).join("");
}

/** A check's outcome. */
export type CheckResult = { pass: boolean; errors?: string[] };

type CheckContext = {
  globalArgs: z.input<typeof GlobalArgsSchema>;
  repoDir?: string;
  signal?: AbortSignal;
  logger: Context["logger"];
};

function checkContext(context: CheckContext): Context {
  return {
    ...context,
    globalArgs: GlobalArgsSchema.parse(context.globalArgs),
    repoDir: context.repoDir ?? ".",
    writeResource: () => Promise.reject(new Error("not in a check")),
  };
}

/** The URL of a registry's `/v2/` endpoint: plain HTTP for localhost, as crane treats it. */
export function pingUrl(registry: string, insecure: boolean): string[] {
  const host = registry.replace(/:\d+$/, "");
  const local = host === "localhost" || host === "127.0.0.1" ||
    host === "[::1]" || host.endsWith(".localhost");
  if (local) return [`http://${registry}/v2/`];
  return insecure
    ? [`https://${registry}/v2/`, `http://${registry}/v2/`]
    : [`https://${registry}/v2/`];
}

/** Pre-flight checks, run before `copy` and `tag`. */
export const checks = {
  "arguments": {
    description:
      "registry is a host[:port], namespace a repository path, and username and password come together",
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
  "crane-installed": {
    description: "craneBinary runs and reports its version",
    labels: ["local", "live"],
    execute: async (context: CheckContext): Promise<CheckResult> => {
      const ctx = checkContext(context);
      const bin = ctx.globalArgs.craneBinary;
      try {
        const res = await exec(bin, ["version"], {
          cwd: ctx.repoDir,
          env: baseEnv(ctx),
        }, ctx);
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
            }); install crane, https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md, or set craneBinary`,
          ],
        };
      }
    },
  },
  "registry-reachable": {
    description:
      "registry answers on /v2/, with any status; an answer that asks for credentials counts",
    labels: ["live"],
    execute: async (context: CheckContext): Promise<CheckResult> => {
      const g = GlobalArgsSchema.parse(context.globalArgs);
      if (g.registry === "") {
        return {
          pass: false,
          errors: ["registry is empty: copy and tag need one to write to"],
        };
      }
      const errors: string[] = [];
      for (const url of pingUrl(g.registry, g.insecure)) {
        try {
          const res = await fetch(url, {
            method: "GET",
            redirect: "manual",
            signal: context.signal ?? AbortSignal.timeout(15_000),
          });
          await res.body?.cancel();
          return { pass: true };
        } catch (err) {
          errors.push(
            `${url}: ${err instanceof Error ? err.message : String(err)}`,
          );
        }
      }
      return { pass: false, errors };
    },
  },
};

/** Model definition for one container registry driven through crane. */
export const model = {
  type: "@dataverket/crane/registry",
  version: "2026.10.29.2",
  globalArguments: GlobalArgsSchema,
  upgrades: [
    {
      toVersion: "2026.10.29.2",
      description:
        "copy puts an image at its source registry and whole path under the namespace; no schema change",
      upgradeAttributes: (
        old: Record<string, unknown>,
      ): Record<string, unknown> => old,
    },
  ],
  checks,
  resources: {
    digest: {
      description:
        "One tag resolved: its digest now, the digest it held last time, and since when it has been this one",
      schema: DigestSchema,
      lifetime: "infinite" as const,
      garbageCollection: 30,
    },
    image: {
      description:
        "One image or index described: media type, platforms, config, labels, annotations, layers and size",
      schema: ImageSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    mirror: {
      description:
        "One image copied in by digest, or found already there with that digest",
      schema: MirrorSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    tagging: {
      description:
        "One tag pointed at a digest, with the digest it held before",
      schema: TaggingSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    blob: {
      description:
        "One file read out of an artifact's layer: its text, as JSON when it parses, and its sha256",
      schema: BlobSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    digest: {
      description:
        "Resolve every reference to its digest and record each with the digest it had last time and since when it has been this one",
      kind: "read" as const,
      arguments: DigestArgsSchema,
      execute: async (args: DigestArgs, ctx: Context) => {
        const refs = args.refs.map((r) => resolveRef(ctx, r));
        const scratch = new Scratch();
        try {
          const session = await open(ctx, scratch);
          ctx.logger.info("Resolving {count} references", {
            count: refs.length,
          });
          const handles: Handle[] = [];
          const seenAt = new Date().toISOString();
          for (const ref of refs) {
            const given = refString(ref);
            const digest = await digestOf(given, ctx, session);
            if (digest === "") {
              throw new Error(`${given} is not in the registry`);
            }
            const instance = imageInstance("digest", ref);
            const previous = ctx.readResource
              ? (await ctx.readResource(instance)) as Digest | null
              : null;
            const previousDigest = previous?.digest ?? "";
            const changed = previousDigest !== digest;
            const record: Digest = {
              ref: given,
              repository: ref.repository,
              name: ref.name,
              tag: ref.tag,
              digest,
              pinned: `${ref.repository}${
                ref.tag !== "" ? `:${ref.tag}` : ""
              }@${digest}`,
              previousDigest,
              changed,
              firstSeenAt: changed || !previous?.firstSeenAt
                ? seenAt
                : String(previous.firstSeenAt),
              seenAt,
            };
            ctx.logger.info("{ref} is {digest}, {state}", {
              ref: given,
              digest,
              state: previousDigest === ""
                ? "seen for the first time"
                : changed
                ? `changed from ${previousDigest}`
                : `unchanged since ${record.firstSeenAt}`,
            });
            handles.push(await ctx.writeResource("digest", instance, record));
          }
          return { dataHandles: handles };
        } finally {
          await scratch.clean();
        }
      },
    },
    describe: {
      description:
        "Record what every reference is: an image or an index, its platforms, media type, created time, labels, annotations, layers and size",
      kind: "read" as const,
      arguments: DescribeArgsSchema,
      execute: async (args: DescribeArgs, ctx: Context) => {
        const refs = args.refs.map((r) => resolveRef(ctx, r));
        const scratch = new Scratch();
        try {
          const session = await open(ctx, scratch);
          ctx.logger.info("Describing {count} references", {
            count: refs.length,
          });
          const handles: Handle[] = [];
          for (const ref of refs) {
            const record = await describeOne(ref, ctx, session);
            ctx.logger.info("{ref} is {kind} {digest} for {platforms}", {
              ref: record.ref,
              kind: record.kind === "index" ? "an index" : "an image",
              digest: record.digest,
              platforms: record.platforms.join(", "),
            });
            handles.push(
              await ctx.writeResource(
                "image",
                imageInstance("image", {
                  ...ref,
                  digest: record.digest,
                  tag: "",
                }),
                record,
              ),
            );
          }
          return { dataHandles: handles };
        } finally {
          await scratch.clean();
        }
      },
    },
    copy: {
      description:
        "Copy every source, pinned by digest, to <registry>/<namespace>/<source registry>/<path>:<tag>, the path a registry mirror is asked for; one already there with that digest is left unchanged; the digest is checked after",
      arguments: CopyArgsSchema,
      execute: async (args: CopyArgs, ctx: Context) => {
        const g = ctx.globalArgs;
        if (g.registry === "") {
          throw new Error("registry is empty: name the registry to copy into");
        }
        const sources = args.sources.map((s) => {
          const parsed = parseRef(s);
          if (typeof parsed === "string") throw new Error(parsed);
          if (parsed.digest === "") {
            throw new Error(
              `${
                JSON.stringify(s)
              } is not pinned by digest: copy <repository>:<tag>@sha256:<digest>, a tag can move`,
            );
          }
          const name = sourcePath(parsed.repository);
          if (name instanceof Error) throw name;
          return { ...parsed, name, given: s };
        });
        // Two sources at one target, or under one record name, would leave one
        // record for two images: refused before anything is copied.
        const seen = new Map<string, string>();
        for (const source of sources) {
          const repository = repositoryUnder(g, source.name);
          const by = source.tag !== "" ? `:${source.tag}` : `@${source.digest}`;
          for (
            const key of [
              `target ${repository}${by}`,
              `record ${imageInstance("mirror", { ...source, repository })}`,
            ]
          ) {
            const other = seen.get(key);
            if (other !== undefined) {
              throw new Error(
                `${JSON.stringify(other)} and ${
                  JSON.stringify(source.given)
                } land at the same ${key}: copy them in two runs, or one of them`,
              );
            }
            seen.set(key, source.given);
          }
        }
        const scratch = new Scratch();
        try {
          const session = await open(ctx, scratch);
          ctx.logger.info(
            "Copying {count} images into {registry}/{namespace}",
            {
              count: sources.length,
              registry: g.registry,
              namespace: g.namespace,
            },
          );
          const handles: Handle[] = [];
          for (const source of sources) {
            const repository = repositoryUnder(g, source.name);
            const target = source.tag !== ""
              ? `${repository}:${source.tag}`
              : `${repository}@${source.digest}`;
            const existing = await digestOf(target, ctx, session);
            let action: Mirror["action"] = "unchanged";
            if (existing !== source.digest) {
              await mustRun(["copy", refString(source), target], ctx, session);
              const got = await digestOf(target, ctx, session);
              if (got !== source.digest) {
                throw new Error(
                  `${target} is ${
                    got || "not there"
                  } after the copy, expected ${source.digest}`,
                );
              }
              action = "copied";
            }
            ctx.logger.info("{target}: {action}", { target, action });
            const record: Mirror = {
              source: refString(source),
              sourceRepository: source.repository,
              target,
              repository,
              name: source.name,
              tag: source.tag,
              digest: source.digest,
              action,
              copiedAt: new Date().toISOString(),
            };
            handles.push(
              await ctx.writeResource(
                "mirror",
                imageInstance("mirror", { ...source, repository }),
                record,
              ),
            );
          }
          return { dataHandles: handles };
        } finally {
          await scratch.clean();
        }
      },
    },
    tag: {
      description:
        "Point <registry>/<namespace>/<name>:<tag> at a digest already in the repository, and record the digest the tag held before",
      arguments: TagArgsSchema,
      execute: async (args: TagArgs, ctx: Context) => {
        const g = ctx.globalArgs;
        if (g.registry === "") {
          throw new Error("registry is empty: name the registry to tag in");
        }
        if (!TAG.test(args.tag)) {
          throw new Error(
            `tag ${
              JSON.stringify(args.tag)
            } is not an image tag: letters, digits, _ . - and at most 128 of them`,
          );
        }
        if (!REPOSITORY_PATH.test(args.name)) {
          throw new Error(
            `name ${JSON.stringify(args.name)} is not a repository path`,
          );
        }
        const repository = repositoryUnder(g, args.name);
        const ref = `${repository}:${args.tag}`;
        const scratch = new Scratch();
        try {
          const session = await open(ctx, scratch);
          ctx.logger.info("Tagging {digest} as {ref}", {
            digest: args.digest,
            ref,
          });
          const previousDigest = await digestOf(ref, ctx, session);
          const changed = previousDigest !== args.digest;
          if (changed) {
            await mustRun(
              ["tag", `${repository}@${args.digest}`, args.tag],
              ctx,
              session,
            );
            const got = await digestOf(ref, ctx, session);
            if (got !== args.digest) {
              throw new Error(
                `${ref} is ${
                  got || "not there"
                } after tagging, expected ${args.digest}`,
              );
            }
          }
          ctx.logger.info("{ref}: {state}", {
            ref,
            state: !changed
              ? "already there"
              : previousDigest === ""
              ? "new"
              : `moved from ${previousDigest}`,
          });
          const record: Tagging = {
            ref,
            repository,
            name: args.name,
            tag: args.tag,
            digest: args.digest,
            previousDigest,
            changed,
            taggedAt: new Date().toISOString(),
          };
          const handle = await ctx.writeResource(
            "tagging",
            imageInstance("tagging", {
              repository,
              name: args.name,
              tag: args.tag,
              digest: args.digest,
            }),
            record,
          );
          return { dataHandles: [handle] };
        } finally {
          await scratch.clean();
        }
      },
    },
    blob: {
      description:
        "Read one file out of an artifact's layer, a tar or tar+gzip such as a Flux artifact's, and record its text, as JSON when it parses, with its sha256",
      kind: "read" as const,
      arguments: BlobArgsSchema,
      execute: async (args: BlobArgs, ctx: Context) => {
        const ref = resolveRef(ctx, args.ref);
        const scratch = new Scratch();
        try {
          const session = await open(ctx, scratch);
          const given = refString(ref);
          ctx.logger.info("Reading {path} out of layer {layer} of {ref}", {
            path: args.path || "the whole layer",
            layer: args.layer,
            ref: given,
          });
          const digest = await digestOf(given, ctx, session);
          if (digest === "") throw new Error(`${given} is not in the registry`);
          const pinned = `${ref.repository}@${digest}`;
          const manifest = await manifestOf(pinned, ctx, session);
          if (isIndex(manifest)) {
            throw new Error(
              `${pinned} is an index, not an artifact; name one of its images by digest`,
            );
          }
          const layers = manifest.layers ?? [];
          const layer = layers[args.layer];
          if (!layer?.digest) {
            throw new Error(
              `${pinned} has ${layers.length} layers, no layer ${args.layer}`,
            );
          }
          const bytes = await mustRun(
            ["blob", `${ref.repository}@${layer.digest}`],
            ctx,
            session,
          );
          const file = await fileFromLayer(bytes, args.path);
          const content = text(file);
          let json: unknown = null;
          try {
            json = JSON.parse(content);
          } catch {
            // not JSON: text alone is recorded
          }
          const record: Blob = {
            ref: given,
            repository: ref.repository,
            digest,
            layerDigest: layer.digest,
            layerMediaType: layer.mediaType ?? "",
            path: args.path,
            text: content,
            json,
            sha256: "sha256:" + await sha256Hex(file),
            size: file.length,
            readAt: new Date().toISOString(),
          };
          ctx.logger.info("Read {size} bytes of {path} from {ref}", {
            size: file.length,
            path: args.path || "the layer",
            ref: pinned,
          });
          const name = args.path === ""
            ? "layer"
            : sanitized(args.path.split("/").pop() ?? args.path);
          const handle = await ctx.writeResource(
            "blob",
            `${imageInstance("blob", { ...ref, tag: "", digest })}-${name}`,
            record,
          );
          return { dataHandles: [handle] };
        } finally {
          await scratch.clean();
        }
      },
    },
  },
};
