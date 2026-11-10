/**
 * `@dataverket/http/endpoint` — one HTTP or HTTPS URL, asked whether it
 * answers: the status, whether the TLS chain verified, how fast, where
 * redirects led, and whether the body holds what it should: a text
 * (`bodyContains`), or JSON fields with exactly the values named (`bodyJson`).
 *
 * `health` records the answer and never fails for an endpoint that is down
 * or wrong: `ok` is false and `error` says why, so a workflow asserts over
 * many endpoints and names every one that failed. Only a bad definition
 * fails the method.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** The endpoint's arguments. */
export const GlobalArgsSchema = z.object({
  url: z.string().min(1).describe("The URL to GET, http or https"),
  expectStatus: z.number().int().min(100).max(599).default(200).describe(
    "The status the final answer must have for ok",
  ),
  followRedirects: z.boolean().default(true).describe(
    "Follow redirects, at most maxRedirects, and judge the final answer; false judges the first",
  ),
  maxRedirects: z.number().int().min(0).max(20).default(5),
  bodyContains: z.string().default("").describe(
    "Text the final answer's body must hold for ok; empty checks nothing",
  ),
  bodyJson: z.preprocess((value, ctx) => {
    // A record drops a key named __proto__ without a word, which would leave
    // an assertion that asks less than was written; it is refused here,
    // before the record is built.
    if (
      typeof value === "object" && value !== null &&
      Object.hasOwn(value, "__proto__")
    ) {
      ctx.addIssue(
        "bodyJson holds a field named __proto__, which cannot be asserted",
      );
      return z.NEVER;
    }
    return value;
  }, z.record(z.string(), z.unknown())).default({}).describe(
    "Fields the final answer's JSON body must hold with exactly these values for ok: a nested object names nested fields, other fields of the body are ignored, an array must be equal as a whole; empty checks nothing. A field named __proto__ cannot be asserted",
  ),
  bodyJsonShowValues: z.boolean().default(false).describe(
    "Record the expected and the actual value of a bodyJson field that differs, each cut at 200 characters; false records the field and the kind of difference only, so nothing from the body reaches the record",
  ),
  timeoutMs: z.number().int().min(100).max(120000).default(10000).describe(
    "How long the whole request may take before it counts as unreachable",
  ),
  caFile: z.string().default("").describe(
    "A CA certificate (PEM) the chain must verify against, absolute or relative to the repository root; empty uses the system store",
  ),
  userAgent: z.string().default("swamp @dataverket/http").describe(
    "The User-Agent header sent",
  ),
});

/** The endpoint's arguments, parsed. */
export type GlobalArgs = z.infer<typeof GlobalArgsSchema>;

/** The kinds of JSON value, and `missing` for a field the body does not have. */
const JSON_TYPES = [
  "string",
  "number",
  "boolean",
  "null",
  "object",
  "array",
  "missing",
] as const;

/** Why a `bodyJson` assertion did not hold. */
const JSON_REASONS = [
  "content-type",
  "too-large",
  "not-utf8",
  "too-deep",
  "not-json",
  "duplicate-key",
  "not-object",
  "missing",
  "type",
  "value",
] as const;

const JsonMismatchSchema = z.object({
  path: z.string().describe(
    'The field as a JSON Pointer (RFC 6901), "/issuer" or "/a/b"; "" is the whole body',
  ),
  reason: z.enum(JSON_REASONS).describe(
    "The whole body: content-type, too-large, not-utf8, too-deep, not-json, duplicate-key, not-object. One field: missing, type (another kind of value), value (same kind, another value)",
  ),
  expectedType: z.enum(JSON_TYPES).nullable(),
  actualType: z.enum(JSON_TYPES).nullable(),
  expected: z.string().nullable().describe(
    "The expected value as JSON text, cut at 200 characters; null unless bodyJsonShowValues",
  ),
  actual: z.string().nullable().describe(
    "The actual value as JSON text, cut at 200 characters; null unless bodyJsonShowValues",
  ),
});

/** One field of the body that differs from `bodyJson`, or one reason the body could not be judged. */
export type JsonMismatch = z.infer<typeof JsonMismatchSchema>;

const HealthSchema = z.object({
  url: z.string(),
  finalUrl: z.string(),
  reachable: z.boolean(),
  status: z.number().int().nullable(),
  ok: z.boolean(),
  tls: z.enum(["verified", "plain", "failed"]).nullable().describe(
    "verified: HTTPS against caFile or the system store; plain: HTTP; failed: the chain did not verify",
  ),
  latencyMs: z.number().int().nullable(),
  redirects: z.number().int(),
  bodyMatched: z.boolean().nullable().describe(
    "Whether the body held bodyContains; null when nothing was asked",
  ),
  jsonMatched: z.boolean().nullable().describe(
    "Whether the body held every bodyJson field with exactly its value; null when nothing was asked or nothing answered",
  ),
  jsonMismatches: z.array(JsonMismatchSchema).describe(
    "The fields that differ, at most 20; empty when jsonMatched is not false",
  ),
  jsonMismatchCount: z.number().int().describe(
    "How many fields differ; more than jsonMismatches holds when the list was cut",
  ),
  error: z.string().nullable(),
  checkedAt: z.iso.datetime(),
});

/** One health record. */
export type Health = z.infer<typeof HealthSchema>;

/** The parts of swamp's method context the endpoint uses. */
export type Context = {
  globalArgs: GlobalArgs;
  repoDir: string;
  signal?: AbortSignal;
  logger: {
    info: (msg: string, props?: Record<string, unknown>) => void;
    warning: (msg: string, props?: Record<string, unknown>) => void;
  };
  writeResource: (
    specName: string,
    name: string,
    data: Record<string, unknown>,
  ) => Promise<{ name: string }>;
};

/** Makes `path` absolute against `root` when it is relative; "" stays "". */
export function absolute(root: string, path: string): string {
  if (path === "" || path.startsWith("/")) return path;
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\.\/+/, "")}`;
}

/** What is wrong with the arguments as written, or null. */
export function argumentProblem(
  g: z.input<typeof GlobalArgsSchema>,
): string | null {
  let parsed: URL;
  try {
    parsed = new URL(g.url ?? "");
  } catch {
    return `url ${JSON.stringify(g.url ?? "")} is not a URL`;
  }
  if (parsed.protocol !== "http:" && parsed.protocol !== "https:") {
    return `url ${JSON.stringify(g.url)} is not http or https`;
  }
  if (/[\n\r]/.test(g.caFile ?? "")) return "caFile holds a newline";
  if (/[\n\r]/.test(g.userAgent ?? "")) return "userAgent holds a newline";
  const expected: unknown = g.bodyJson === undefined ? {} : g.bodyJson;
  if (!isObject(expected)) return "bodyJson is not an object of fields";
  return expectedProblem(expected, "", 1);
}

/** The largest body `bodyJson` judges; a larger one is recorded as too-large. */
export const MAX_JSON_BYTES = 1024 * 1024;
/** The deepest nesting of objects and arrays `bodyJson` judges in a body. */
export const MAX_JSON_DEPTH = 64;
/** The deepest nesting `bodyJson` itself may have. */
export const MAX_EXPECTED_DEPTH = 32;
/** How many differing fields a record lists. */
export const MAX_MISMATCHES = 20;
/** Where a value or a path echoed into a record is cut. */
export const MAX_ECHO = 200;

type JsonType = (typeof JSON_TYPES)[number];

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function jsonType(v: unknown): JsonType {
  if (v === null) return "null";
  if (Array.isArray(v)) return "array";
  const t = typeof v;
  if (t === "string" || t === "number" || t === "boolean") return t;
  return "object";
}

/** One key as a JSON Pointer token (RFC 6901). */
function pointerToken(key: string): string {
  return key.replace(/~/g, "~0").replace(/\//g, "~1");
}

/** Cuts `text` at `max` characters, never inside a surrogate pair, and says how much is gone. */
export function cut(text: string, max = MAX_ECHO): string {
  if (text.length <= max) return text;
  let end = max;
  const last = text.charCodeAt(end - 1);
  if (last >= 0xd800 && last <= 0xdbff) end--;
  return `${text.slice(0, end)}... (${text.length - end} more characters)`;
}

/** What in `bodyJson` is not a JSON value, or nested too deep; null when all of it is. */
function expectedProblem(
  v: unknown,
  path: string,
  depth: number,
): string | null {
  const at = cut(path === "" ? "bodyJson" : `bodyJson ${path}`);
  if (v === null || typeof v === "string" || typeof v === "boolean") {
    return null;
  }
  if (typeof v === "number") {
    return Number.isFinite(v) ? null : `${at} is not a finite number`;
  }
  if (typeof v !== "object") return `${at} is not a JSON value`;
  if (depth > MAX_EXPECTED_DEPTH) {
    return `bodyJson is nested deeper than ${MAX_EXPECTED_DEPTH} levels`;
  }
  if (Array.isArray(v)) {
    for (let i = 0; i < v.length; i++) {
      const problem = expectedProblem(v[i], `${path}/${i}`, depth + 1);
      if (problem) return problem;
    }
    return null;
  }
  const proto = Object.getPrototypeOf(v);
  if (proto !== null && proto !== Object.prototype) {
    return `${at} is not a JSON value`;
  }
  for (const key of Object.keys(v)) {
    // Schema validation drops a key of this name at the top level without a
    // word, which would leave an assertion that asks less than was written,
    // so the name is refused wherever it can still be seen.
    if (key === "__proto__") {
      return `${at} holds a field named __proto__, which cannot be asserted`;
    }
    const problem = expectedProblem(
      (v as Record<string, unknown>)[key],
      `${path}/${pointerToken(key)}`,
      depth + 1,
    );
    if (problem) return problem;
  }
  return null;
}

/**
 * Walks JSON text once without building it, for the two things `JSON.parse`
 * does not report: nesting deeper than `maxDepth`, and an object that holds
 * the same key twice, where parsers disagree on which value counts. The text
 * need not be valid; `JSON.parse` decides that afterwards.
 */
export function scanJson(
  text: string,
  maxDepth = MAX_JSON_DEPTH,
): { tooDeep: boolean; duplicate: string | null } {
  type Frame = {
    keys: Set<string> | null;
    expectKey: boolean;
    at: string;
    index: number;
  };
  const stack: Frame[] = [];
  const open = (keys: Set<string> | null): boolean => {
    if (stack.length >= maxDepth) return false;
    stack.push({ keys, expectKey: keys !== null, at: "", index: 0 });
    return true;
  };
  const n = text.length;
  let i = 0;
  while (i < n) {
    const c = text[i];
    if (c === '"') {
      let j = i + 1;
      while (j < n && text[j] !== '"') j += text[j] === "\\" ? 2 : 1;
      const top = stack[stack.length - 1];
      if (top !== undefined && top.keys !== null && top.expectKey) {
        let key: unknown;
        try {
          key = JSON.parse(text.slice(i, j + 1));
        } catch {
          return { tooDeep: false, duplicate: null };
        }
        if (typeof key !== "string") return { tooDeep: false, duplicate: null };
        if (top.keys.has(key)) {
          const parents = stack.slice(0, -1).map((f) =>
            f.keys === null ? String(f.index) : pointerToken(f.at)
          );
          return {
            tooDeep: false,
            duplicate: `/${[...parents, pointerToken(key)].join("/")}`,
          };
        }
        top.keys.add(key);
        top.at = key;
        top.expectKey = false;
      }
      i = j + 1;
      continue;
    }
    if (c === "{") {
      if (!open(new Set())) return { tooDeep: true, duplicate: null };
    } else if (c === "[") {
      if (!open(null)) return { tooDeep: true, duplicate: null };
    } else if (c === "}" || c === "]") {
      stack.pop();
    } else if (c === ",") {
      const top = stack[stack.length - 1];
      if (top !== undefined) {
        if (top.keys !== null) top.expectKey = true;
        else top.index++;
      }
    }
    i++;
  }
  return { tooDeep: false, duplicate: null };
}

/** Exact equality of two JSON values: same kind, same value, same keys, same order in arrays. */
export function jsonEqual(a: unknown, b: unknown): boolean {
  const type = jsonType(a);
  if (type !== jsonType(b)) return false;
  if (type === "array") {
    const x = a as unknown[], y = b as unknown[];
    return x.length === y.length && x.every((v, i) => jsonEqual(v, y[i]));
  }
  if (type === "object") {
    const x = a as Record<string, unknown>, y = b as Record<string, unknown>;
    const keys = Object.keys(x);
    return keys.length === Object.keys(y).length &&
      keys.every((k) => Object.hasOwn(y, k) && jsonEqual(x[k], y[k]));
  }
  return a === b;
}

/** The verdict of `bodyJson` over one body. */
export type JsonVerdict = {
  matched: boolean;
  mismatches: JsonMismatch[];
  count: number;
};

function wholeBody(
  reason: JsonMismatch["reason"],
  actualType: JsonType | null = null,
  actual: string | null = null,
): JsonVerdict {
  return {
    matched: false,
    mismatches: [{
      path: "",
      reason,
      expectedType: "object",
      actualType,
      expected: null,
      actual,
    }],
    count: 1,
  };
}

/** Whether a Content-Type header names JSON: application/json or any +json type. */
export function isJsonContentType(header: string | null): boolean {
  const essence = (header ?? "").split(";")[0].trim().toLowerCase();
  return essence === "application/json" ||
    /^[a-z0-9!#$&^_.+-]+\/[a-z0-9!#$&^_.+-]+\+json$/.test(essence);
}

/** The media type of a Content-Type header when it is a plain token pair, for an error text. */
function mediaType(header: string | null): string {
  if (header === null || header.trim() === "") return "no content type";
  const essence = header.split(";")[0].trim().toLowerCase();
  return /^[a-z0-9!#$&^_.+-]{1,60}\/[a-z0-9!#$&^_.+-]{1,60}$/.test(essence)
    ? essence
    : "an unreadable content type";
}

/**
 * Judges a body against `expected`. Objects are compared as a subset, field
 * by field, so the body may hold more; every other value must be exactly
 * equal, arrays as a whole. Values are echoed only when `showValues`.
 */
export function judgeJson(
  bytes: Uint8Array | null,
  contentType: string | null,
  expected: Record<string, unknown>,
  showValues: boolean,
): JsonVerdict {
  if (!isJsonContentType(contentType)) return wholeBody("content-type");
  if (bytes === null || bytes.byteLength > MAX_JSON_BYTES) {
    return wholeBody("too-large");
  }
  let text: string;
  try {
    text = new TextDecoder("utf-8", { fatal: true }).decode(bytes);
  } catch {
    return wholeBody("not-utf8");
  }
  const scan = scanJson(text);
  if (scan.tooDeep) return wholeBody("too-deep");
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return wholeBody("not-json");
  }
  if (scan.duplicate !== null) {
    return wholeBody(
      "duplicate-key",
      null,
      showValues ? cut(scan.duplicate) : null,
    );
  }
  if (!isObject(body)) return wholeBody("not-object", jsonType(body));
  const mismatches: JsonMismatch[] = [];
  let count = 0;
  const echo = (v: unknown) => showValues ? cut(JSON.stringify(v)) : null;
  const differ = (
    path: string,
    reason: JsonMismatch["reason"],
    want: unknown,
    got: unknown,
    missing = false,
  ) => {
    count++;
    if (mismatches.length >= MAX_MISMATCHES) return;
    mismatches.push({
      path: cut(path),
      reason,
      expectedType: jsonType(want),
      actualType: missing ? "missing" : jsonType(got),
      expected: echo(want),
      actual: missing ? null : echo(got),
    });
  };
  const walk = (
    want: Record<string, unknown>,
    got: Record<string, unknown>,
    path: string,
  ) => {
    for (const key of Object.keys(want)) {
      const at = `${path}/${pointerToken(key)}`;
      const w = want[key];
      if (!Object.hasOwn(got, key)) {
        differ(at, "missing", w, undefined, true);
        continue;
      }
      const g = got[key];
      if (jsonType(w) !== jsonType(g)) differ(at, "type", w, g);
      else if (isObject(w)) walk(w, g as Record<string, unknown>, at);
      else if (!jsonEqual(w, g)) differ(at, "value", w, g);
    }
  };
  walk(expected, body, "");
  return { matched: count === 0, mismatches, count };
}

/** One sentence for `error` from a failed verdict and the answer's Content-Type. */
export function jsonErrorText(
  verdict: JsonVerdict,
  contentType: string | null,
): string {
  const m = verdict.mismatches[0];
  const more = verdict.count > 1 ? ` (and ${verdict.count - 1} more)` : "";
  const field = m.path === "" ? "the body" : m.path;
  switch (m.reason) {
    case "content-type":
      return `body JSON: the answer is ${mediaType(contentType)}, not JSON`;
    case "too-large":
      return `body JSON: the body is larger than ${MAX_JSON_BYTES} bytes`;
    case "not-utf8":
      return "body JSON: the body is not UTF-8";
    case "too-deep":
      return `body JSON: the body is nested deeper than ${MAX_JSON_DEPTH} levels`;
    case "not-json":
      return "body JSON: the body is not JSON";
    case "duplicate-key":
      return `body JSON: the body holds a key twice${
        m.actual === null ? "" : ` at ${m.actual}`
      }`;
    case "not-object":
      return `body JSON: the body is ${m.actualType}, not an object`;
    case "missing":
      return `body JSON: ${field} is missing${more}`;
    case "type":
      return `body JSON: ${field} is ${m.actualType}, expected ${m.expectedType}${more}`;
    default:
      return m.actual === null
        ? `body JSON: ${field} does not have the expected value${more}`
        : `body JSON: ${field} is ${m.actual}, expected ${m.expected}${more}`;
  }
}

/**
 * Reads a body once. With `cap`, reading stops at the first byte past it and
 * null is returned, so a huge or endless body costs at most `cap` bytes.
 */
export async function readBody(
  res: Response,
  cap: number | null,
): Promise<Uint8Array | null> {
  if (res.body === null) return new Uint8Array(0);
  const reader = res.body.getReader();
  const chunks: Uint8Array[] = [];
  let total = 0;
  for (;;) {
    const { done, value } = await reader.read();
    if (done) break;
    total += value.byteLength;
    if (cap !== null && total > cap) {
      await reader.cancel().catch(() => {});
      return null;
    }
    chunks.push(value);
  }
  const bytes = new Uint8Array(total);
  let offset = 0;
  for (const chunk of chunks) {
    bytes.set(chunk, offset);
    offset += chunk.byteLength;
  }
  return bytes;
}

const CERT_ERROR =
  /certificate|tls|ssl|handshake|self[- ]signed|unknown issuer|hostname/i;

/** An error's message with every cause's appended, so the reason fetch wraps is kept. */
export function errorText(err: unknown): string {
  const parts: string[] = [];
  let cur: unknown = err;
  for (let i = 0; i < 5 && cur !== undefined && cur !== null; i++) {
    parts.push(cur instanceof Error ? cur.message : String(cur));
    cur = cur instanceof Error ? cur.cause : undefined;
  }
  return parts.filter((p) => p !== "").join(": ");
}

/** Classifies a fetch failure: a chain that did not verify, or nothing answering. */
export function failureKind(
  message: string,
  https: boolean,
): { tls: Health["tls"]; error: string } {
  const text = message.replace(/^TypeError:\s*/, "").replace(
    /^fetch failed:\s*/,
    "",
  )
    .trim();
  if (https && CERT_ERROR.test(text)) return { tls: "failed", error: text };
  return { tls: null, error: text };
}

/** Performs one GET, following redirects by hand so they can be counted. */
export type Fetcher = (
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
  caFile: string,
) => Promise<Response>;

async function denoFetch(
  url: string,
  init: { headers: Record<string, string>; signal: AbortSignal },
  caFile: string,
): Promise<Response> {
  if (caFile === "") {
    return await fetch(url, { ...init, redirect: "manual" });
  }
  let pem: string;
  try {
    pem = await Deno.readTextFile(caFile);
  } catch {
    throw new Error(`caFile ${caFile} could not be read`);
  }
  const client = Deno.createHttpClient({ caCerts: [pem] });
  try {
    return await fetch(url, { ...init, redirect: "manual", client });
  } finally {
    client.close();
  }
}

let fetcher: Fetcher = denoFetch;

/** Swaps the fetcher; returns a function that restores it. */
export function __setFetcher(fake: Fetcher): () => void {
  const prev = fetcher;
  fetcher = fake;
  return () => {
    fetcher = prev;
  };
}

/** Asks the endpoint once and returns what to record. */
export async function probe(ctx: Context): Promise<Health> {
  const g = ctx.globalArgs;
  const caFile = absolute(ctx.repoDir, g.caFile);
  const https = g.url.startsWith("https:");
  const base: Omit<
    Health,
    | "finalUrl"
    | "reachable"
    | "status"
    | "ok"
    | "tls"
    | "latencyMs"
    | "redirects"
    | "bodyMatched"
    | "jsonMatched"
    | "jsonMismatches"
    | "jsonMismatchCount"
    | "error"
  > = { url: g.url, checkedAt: new Date().toISOString() };
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), g.timeoutMs);
  const onOuter = () => controller.abort();
  ctx.signal?.addEventListener("abort", onOuter);
  const started = performance.now();
  let current = g.url;
  let redirects = 0;
  try {
    for (;;) {
      const res = await fetcher(current, {
        headers: { "user-agent": g.userAgent, accept: "*/*" },
        signal: controller.signal,
      }, caFile);
      const location = res.headers.get("location");
      if (
        g.followRedirects && location !== null && res.status >= 300 &&
        res.status < 400 && redirects < g.maxRedirects
      ) {
        await res.body?.cancel();
        current = new URL(location, current).toString();
        redirects++;
        continue;
      }
      // The body is read once, for both assertions. bodyContains reads all
      // of it, as it always has; bodyJson alone stops past MAX_JSON_BYTES and
      // reads nothing when the content type already says it is not JSON.
      const wantText = g.bodyContains !== "";
      const wantJson = Object.keys(g.bodyJson).length > 0;
      const contentType = res.headers.get("content-type");
      const readIt = wantText || (wantJson && isJsonContentType(contentType));
      const bytes = readIt
        ? await readBody(res, wantText ? null : MAX_JSON_BYTES)
        : null;
      if (!readIt) await res.body?.cancel();
      const latencyMs = Math.round(performance.now() - started);
      const bodyMatched = wantText
        ? new TextDecoder().decode(bytes!).includes(g.bodyContains)
        : null;
      const verdict = wantJson
        ? judgeJson(bytes, contentType, g.bodyJson, g.bodyJsonShowValues)
        : null;
      const statusOk = res.status === g.expectStatus;
      const ok = statusOk && bodyMatched !== false &&
        verdict?.matched !== false;
      const error = ok
        ? null
        : !statusOk
        ? `status ${res.status}, expected ${g.expectStatus}`
        : bodyMatched === false
        ? `body does not hold ${JSON.stringify(g.bodyContains)}`
        : jsonErrorText(verdict!, contentType);
      return {
        ...base,
        finalUrl: current,
        reachable: true,
        status: res.status,
        ok,
        tls: current.startsWith("https:") ? "verified" : "plain",
        latencyMs,
        redirects,
        bodyMatched,
        jsonMatched: verdict?.matched ?? null,
        jsonMismatches: verdict?.mismatches ?? [],
        jsonMismatchCount: verdict?.count ?? 0,
        error,
      };
    }
  } catch (err) {
    const latencyMs = Math.round(performance.now() - started);
    const message = errorText(err);
    if (message.startsWith("caFile ")) throw err;
    const timedOut = controller.signal.aborted && !ctx.signal?.aborted;
    const kind = timedOut
      ? { tls: null, error: `no answer within ${g.timeoutMs} ms` }
      : failureKind(message, https);
    return {
      ...base,
      finalUrl: current,
      reachable: false,
      status: null,
      ok: false,
      tls: kind.tls,
      latencyMs,
      redirects,
      bodyMatched: null,
      jsonMatched: null,
      jsonMismatches: [],
      jsonMismatchCount: 0,
      error: kind.error,
    };
  } finally {
    clearTimeout(timer);
    ctx.signal?.removeEventListener("abort", onOuter);
  }
}

/** A check's outcome. */
export type CheckResult = { pass: boolean; errors?: string[] };

/** Pre-flight checks; `health` is a read, so they run by hand with `swamp model validate`. */
export const checks = {
  "arguments": {
    description:
      "url is http or https, caFile and userAgent hold no newline, and bodyJson holds JSON values only",
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
  "ca-readable": {
    description: "caFile, when set, can be read and looks like a PEM",
    labels: ["local"],
    execute: async (
      context: {
        globalArgs: z.input<typeof GlobalArgsSchema>;
        repoDir?: string;
      },
    ): Promise<CheckResult> => {
      const caFile = absolute(
        context.repoDir ?? ".",
        context.globalArgs.caFile ?? "",
      );
      if (caFile === "") return { pass: true };
      try {
        const text = await Deno.readTextFile(caFile);
        if (!text.includes("-----BEGIN CERTIFICATE-----")) {
          return {
            pass: false,
            errors: [`${caFile} holds no certificate PEM`],
          };
        }
        return { pass: true };
      } catch {
        return { pass: false, errors: [`${caFile} could not be read`] };
      }
    },
  },
};

/** Model definition for one HTTP endpoint. */
export const model = {
  type: "@dataverket/http/endpoint",
  version: "2026.11.10.1",
  upgrades: [
    {
      toVersion: "2026.11.10.1",
      description:
        "bodyJson and bodyJsonShowValues are new, empty and false by default; the health record gains jsonMatched, jsonMismatches and jsonMismatchCount. No existing argument changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    health: {
      description:
        "Whether the endpoint answered as expected, over a verified chain, how fast, and which JSON field of the body differed",
      schema: HealthSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    health: {
      description:
        "GET the URL and record status, TLS, latency, redirects, body text match and JSON field match; an endpoint that is down or wrong is recorded, not thrown",
      kind: "read" as const,
      arguments: z.object({}),
      execute: async (_args: Record<string, never>, ctx: Context) => {
        const problem = argumentProblem(ctx.globalArgs);
        if (problem) throw new Error(problem);
        ctx.logger.info("Checking {url}", { url: ctx.globalArgs.url });
        const health = await probe(ctx);
        if (health.ok) {
          ctx.logger.info("{url} answered {status} in {latency} ms", {
            url: health.finalUrl,
            status: health.status,
            latency: health.latencyMs,
          });
        } else {
          ctx.logger.warning("{url} not ok: {error}", {
            url: health.finalUrl,
            error: health.error,
          });
        }
        const handle = await ctx.writeResource("health", "health", health);
        return { dataHandles: [handle] };
      },
    },
  },
};
