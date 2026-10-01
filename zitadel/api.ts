/**
 * `@dataverket/zitadel` — the authenticated transport every model type shares:
 * a JWT private-key service account, a short-lived access token, and the two
 * API surfaces this extension speaks.
 *
 * The service user's machine key JSON is signed into an RS256 assertion and
 * exchanged at `/oauth/v2/token` (jwt-bearer grant) for an access token that is
 * cached in memory until shortly before it expires. No long-lived bearer token
 * is ever stored, and the key material is read at call time — from a vault
 * value (`keyJson`) or from a file the definition names (`keyJsonFile`).
 *
 * Signing uses the Web Crypto global, so the extension has no dependency to
 * resolve at score time. Zitadel issues PKCS#1 keys and Web Crypto imports only
 * PKCS#8, so {@link importSigningKey} wraps PKCS#1 in the PKCS#8 envelope.
 *
 * Two surfaces are in play. Users are the v2 user service (`/v2/users/…`),
 * which is the supported surface on Zitadel v4 and the only one that reaches
 * keys, PATs, metadata and password reset. Projects, applications, roles,
 * grants and org members stay on the v1 Management API (`/management/v1/…`),
 * where their v2 equivalents are still beta.
 *
 * @module
 */

/** A raw JSON object as Zitadel returns it. */
export type Json = Record<string, unknown>;

/** One API request: verb + path relative to `apiUrl` + optional JSON body. */
export interface ApiCall {
  /** HTTP verb. */
  method: "GET" | "POST" | "PUT" | "PATCH" | "DELETE";
  /** Path relative to `apiUrl`, e.g. `/management/v1/projects/_search`. */
  path: string;
  /** Optional JSON request body. */
  body?: unknown;
}

/** The parsed result of an {@link ApiCall}. */
export interface ApiResult {
  /** HTTP status code. */
  status: number;
  /** Parsed JSON response body (`{}` when the response was empty). */
  body: Json;
}

/**
 * The authenticated-call seam the models use, swappable in tests. Global
 * arguments are typed loosely as {@link Json} so this exported type stays free
 * of the zod-inferred (slow) argument type; the real implementation narrows.
 */
export type CallerFn = (globalArgs: Json, call: ApiCall) => Promise<ApiResult>;

let callerOverride: CallerFn | null = null;

/** Test-only seam: substitute the API caller, or pass `null` to restore it. */
export function __setCaller(fn: CallerFn | null): void {
  callerOverride = fn;
}

/** Parsed Zitadel machine-key JSON. */
export interface KeyJson {
  /** Key id, used as the assertion's `kid`. */
  keyId: string;
  /** RSA private key, PEM-encoded (PKCS#1 or PKCS#8). */
  key: string;
  /** Service user id — the assertion's `iss`/`sub`. */
  userId?: string;
  /** Older keys carry the subject as `clientId` instead. */
  clientId?: string;
}

/** Parse and validate a machine-key JSON blob. Never echoes the key material. */
export function parseKeyJson(raw: string): KeyJson {
  let parsed: Partial<KeyJson>;
  try {
    parsed = JSON.parse(raw) as Partial<KeyJson>;
  } catch {
    throw new Error("keyJson is not valid JSON");
  }
  const subject = parsed.userId ?? parsed.clientId;
  if (!parsed.keyId || !parsed.key || !subject) {
    throw new Error("keyJson is missing keyId, key or userId");
  }
  return {
    keyId: parsed.keyId,
    key: parsed.key,
    userId: parsed.userId,
    clientId: parsed.clientId,
  };
}

/** Base64url without padding, for the JWT segments. */
function b64url(input: Uint8Array | string): string {
  const bytes = typeof input === "string"
    ? new TextEncoder().encode(input)
    : input;
  let binary = "";
  for (const byte of bytes) binary += String.fromCharCode(byte);
  return btoa(binary).replace(/\+/g, "-").replace(/\//g, "_").replace(
    /=+$/,
    "",
  );
}

/** Decode a base64 string Zitadel used for a `bytes` field into text. */
export function fromBase64(value: string): string {
  const binary = atob(value);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return new TextDecoder().decode(bytes);
}

/** Encode text as base64 for a Zitadel `bytes` field (metadata values). */
export function toBase64(value: string): string {
  let binary = "";
  for (const byte of new TextEncoder().encode(value)) {
    binary += String.fromCharCode(byte);
  }
  return btoa(binary);
}

/** Strip trailing slashes from the instance URL. */
export function baseUrl(apiUrl: string): string {
  return apiUrl.replace(/\/+$/, "");
}

/**
 * The claims of the service account's JWT-bearer assertion: the service user is
 * both issuer and subject, the audience is the instance, and it lives an hour.
 * Pure, so the shape can be asserted without touching crypto.
 */
export function jwtAssertionClaims(
  keyJson: Json,
  apiUrl: string,
  nowSec: number,
): Json {
  const key = parseKeyJson(JSON.stringify(keyJson));
  const subject = key.userId ?? key.clientId;
  return {
    iss: subject,
    sub: subject,
    aud: baseUrl(apiUrl),
    iat: nowSec,
    exp: nowSec + 3600,
  };
}

/**
 * Decode a PEM block's base64 body to DER bytes; flags whether it is PKCS#8.
 * A failure here is a malformed key, and says so — without the key in it.
 */
function pemToDer(pem: string): { der: Uint8Array; isPkcs8: boolean } {
  const isPkcs8 = /BEGIN PRIVATE KEY/.test(pem);
  const body = pem
    .replace(/-----BEGIN [^-]+-----/g, "")
    .replace(/-----END [^-]+-----/g, "")
    .replace(/\s+/g, "");
  let binary: string;
  try {
    binary = atob(body);
  } catch {
    throw new Error(
      "the service user's key is not a PEM private key: its base64 body " +
        "does not decode",
    );
  }
  const der = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) der[i] = binary.charCodeAt(i);
  return { der, isPkcs8 };
}

/** DER length octets: short form below 128, long form above. */
function derLen(n: number): number[] {
  if (n < 0x80) return [n];
  const out: number[] = [];
  for (let v = n; v > 0; v = Math.floor(v / 256)) out.unshift(v & 0xff);
  return [0x80 | out.length, ...out];
}

/**
 * Wrap a PKCS#1 `RSAPrivateKey` DER in the PKCS#8 `PrivateKeyInfo` envelope
 * so Web Crypto accepts a Zitadel-issued key. Deterministic byte surgery.
 */
function pkcs1ToPkcs8(pkcs1: Uint8Array): Uint8Array {
  // AlgorithmIdentifier: SEQUENCE { OID 1.2.840.113549.1.1.1, NULL }
  const algorithmId = [
    0x30,
    0x0d,
    0x06,
    0x09,
    0x2a,
    0x86,
    0x48,
    0x86,
    0xf7,
    0x0d,
    0x01,
    0x01,
    0x01,
    0x05,
    0x00,
  ];
  const version = [0x02, 0x01, 0x00];
  const octetString = [0x04, ...derLen(pkcs1.length), ...pkcs1];
  const body = [...version, ...algorithmId, ...octetString];
  return new Uint8Array([0x30, ...derLen(body.length), ...body]);
}

/**
 * Import a PEM RSA private key (PKCS#1 or PKCS#8) as an RS256 signing key.
 * Web Crypto reports a bad key as a bare `DataError`, so the failure is
 * rewritten to say which key it was — and never what was in it.
 */
export async function importSigningKey(pemKey: string): Promise<CryptoKey> {
  const { der, isPkcs8 } = pemToDer(pemKey);
  const pkcs8 = isPkcs8 ? der : pkcs1ToPkcs8(der);
  // Copy into a plain ArrayBuffer: a Uint8Array<ArrayBufferLike> is not a
  // BufferSource, since it could be backed by a SharedArrayBuffer.
  const buffer = new ArrayBuffer(pkcs8.byteLength);
  new Uint8Array(buffer).set(pkcs8);
  try {
    return await crypto.subtle.importKey(
      "pkcs8",
      buffer,
      { name: "RSASSA-PKCS1-v1_5", hash: "SHA-256" },
      false,
      ["sign"],
    );
  } catch {
    throw new Error(
      "the service user's key is not an RSA private key Web Crypto accepts",
    );
  }
}

async function signAssertion(
  key: KeyJson,
  apiUrl: string,
  nowSec: number,
): Promise<string> {
  const header = b64url(
    JSON.stringify({ alg: "RS256", kid: key.keyId, typ: "JWT" }),
  );
  const payload = b64url(
    JSON.stringify(jwtAssertionClaims({ ...key }, apiUrl, nowSec)),
  );
  const input = `${header}.${payload}`;
  const signature = await crypto.subtle.sign(
    "RSASSA-PKCS1-v1_5",
    await importSigningKey(key.key),
    new TextEncoder().encode(input),
  );
  return `${input}.${b64url(new Uint8Array(signature))}`;
}

interface CachedToken {
  token: string;
  expSec: number;
}

const tokenCache = new Map<string, CachedToken>();

/** Test-only seam: forget every cached access token. */
export function __resetTokenCache(): void {
  tokenCache.clear();
}

async function fetchWithTimeout(
  url: string,
  init: RequestInit,
  timeoutMs: number,
): Promise<Response> {
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), timeoutMs);
  try {
    return await fetch(url, { ...init, signal: controller.signal });
  } finally {
    clearTimeout(timer);
  }
}

/** The global arguments the transport reads, narrowed structurally. */
interface Transport {
  apiUrl: string;
  keyJson?: string;
  keyJsonFile?: string;
  orgId?: string;
  httpTimeoutMs: number;
  tokenScope: string;
}

function transport(globalArgs: Json): Transport {
  return {
    apiUrl: String(globalArgs.apiUrl ?? ""),
    keyJson: typeof globalArgs.keyJson === "string"
      ? globalArgs.keyJson
      : undefined,
    keyJsonFile: typeof globalArgs.keyJsonFile === "string"
      ? globalArgs.keyJsonFile
      : undefined,
    orgId: typeof globalArgs.orgId === "string" && globalArgs.orgId
      ? globalArgs.orgId
      : undefined,
    httpTimeoutMs: Number(globalArgs.httpTimeoutMs ?? 30000),
    tokenScope: String(
      globalArgs.tokenScope ??
        "openid profile urn:zitadel:iam:org:project:id:zitadel:aud",
    ),
  };
}

/**
 * Expand a leading `~/` from `HOME`, so a definition can name a key file the
 * way an operator does. Any other path is returned unchanged.
 */
export function expandHome(path: string): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = Deno.env.get("HOME");
  if (!home) throw new Error(`cannot expand ~ in ${path}: HOME is not set`);
  return home + path.slice(1);
}

/**
 * Read the service user's key JSON: the vault value when the definition gives
 * one, otherwise the file it names. Exactly one of the two must be set.
 */
export async function readKeyJson(globalArgs: Json): Promise<string> {
  const g = transport(globalArgs);
  if (g.keyJson && g.keyJsonFile) {
    throw new Error("give keyJson or keyJsonFile, not both");
  }
  if (g.keyJson) return g.keyJson;
  if (!g.keyJsonFile) {
    throw new Error("no credential: set keyJson (from a vault) or keyJsonFile");
  }
  const path = expandHome(g.keyJsonFile);
  try {
    return await Deno.readTextFile(path);
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    throw new Error(`cannot read keyJsonFile ${g.keyJsonFile}: ${message}`);
  }
}

/** Mint (or reuse) an access token for the service user. */
export async function getToken(globalArgs: Json): Promise<string> {
  const g = transport(globalArgs);
  const key = parseKeyJson(await readKeyJson(globalArgs));
  const nowSec = Math.floor(Date.now() / 1000);
  const cacheKey = `${baseUrl(g.apiUrl)}|${key.keyId}`;
  const cached = tokenCache.get(cacheKey);
  if (cached && cached.expSec - 60 > nowSec) return cached.token;

  const form = new URLSearchParams({
    grant_type: "urn:ietf:params:oauth:grant-type:jwt-bearer",
    scope: g.tokenScope,
    assertion: await signAssertion(key, g.apiUrl, nowSec),
  });
  const response = await fetchWithTimeout(
    `${baseUrl(g.apiUrl)}/oauth/v2/token`,
    {
      method: "POST",
      headers: { "content-type": "application/x-www-form-urlencoded" },
      body: form.toString(),
    },
    g.httpTimeoutMs,
  );
  const text = await response.text();
  if (response.status >= 400) {
    throw new Error(
      `Zitadel token exchange failed: HTTP ${response.status}: ${text}`,
    );
  }
  const parsed = JSON.parse(text) as {
    access_token?: string;
    expires_in?: number;
  };
  if (!parsed.access_token) {
    throw new Error("token exchange returned no access_token");
  }
  tokenCache.set(cacheKey, {
    token: parsed.access_token,
    expSec: nowSec + (parsed.expires_in ?? 3600),
  });
  return parsed.access_token;
}

/** Transient statuses worth one more try, with the wait Zitadel asks for. */
const RETRYABLE = new Set([429, 503]);

/** Seconds a `retry-after` header asks for, bounded to something sane. */
function retryAfterMs(response: Response, attempt: number): number {
  const header = response.headers.get("retry-after");
  const seconds = header === null ? NaN : Number(header);
  const wait = Number.isFinite(seconds) ? seconds * 1000 : 2 ** attempt * 500;
  return Math.min(Math.max(wait, 250), 30000);
}

/** The real fetch-backed implementation behind {@link call}. */
async function realCaller(globalArgs: Json, c: ApiCall): Promise<ApiResult> {
  const g = transport(globalArgs);
  let body: string | undefined;
  if (c.body !== undefined) body = JSON.stringify(c.body);

  for (let attempt = 0;; attempt++) {
    const headers: Record<string, string> = {
      authorization: `Bearer ${await getToken(globalArgs)}`,
      accept: "application/json",
    };
    if (g.orgId) headers["x-zitadel-orgid"] = g.orgId;
    if (body !== undefined) headers["content-type"] = "application/json";
    const response = await fetchWithTimeout(
      `${baseUrl(g.apiUrl)}${c.path}`,
      { method: c.method, headers, body },
      g.httpTimeoutMs,
    );
    const text = await response.text();
    let parsed: Json = {};
    if (text) {
      try {
        parsed = JSON.parse(text) as Json;
      } catch {
        parsed = { raw: text };
      }
    }
    if (response.status >= 400) {
      if (RETRYABLE.has(response.status) && attempt < 2) {
        const wait = retryAfterMs(response, attempt);
        await new Promise((resolve) => setTimeout(resolve, wait));
        continue;
      }
      const message = typeof parsed.message === "string"
        ? parsed.message
        : text;
      throw new Error(
        `Zitadel API ${c.method} ${c.path} -> HTTP ${response.status}: ${message}`,
      );
    }
    return { status: response.status, body: parsed };
  }
}

/** Call the Zitadel API as the service user. */
export function call(globalArgs: Json, c: ApiCall): Promise<ApiResult> {
  return (callerOverride ?? realCaller)(globalArgs, c);
}

/** A v1 Management API path. */
export function mgmt(path: string): string {
  return `/management/v1${path}`;
}

/** A v2 API path (user and organization services). */
export function v2(path: string): string {
  return `/v2${path}`;
}

/** Percent-encode one path segment. */
export function seg(value: string): string {
  return encodeURIComponent(value);
}

/** Whatever Zitadel put in `result`, as an array. */
export function asArray(value: unknown): Json[] {
  return Array.isArray(value) ? (value as Json[]) : [];
}

/** How many pages a search walks before it gives up rather than truncate. */
const PAGE_GUARD = 1000;

/**
 * Page through a v1 `_search` endpoint and return every result. Zitadel reports
 * `details.totalResult` as a string, so the loop stops on a short page, on the
 * total being reached, or on an empty page.
 */
export async function searchAll(
  globalArgs: Json,
  path: string,
  queries?: Json[],
): Promise<Json[]> {
  const limit = 100;
  let offset = 0;
  const all: Json[] = [];
  for (let guard = 0; guard < PAGE_GUARD; guard++) {
    const body: Json = { query: { offset: String(offset), limit, asc: true } };
    if (queries && queries.length) body.queries = queries;
    const result = await call(globalArgs, { method: "POST", path, body });
    const page = asArray(result.body.result);
    all.push(...page);
    offset += page.length;
    const total = Number(((result.body.details ?? {}) as Json).totalResult);
    if (page.length < limit) return all;
    if (Number.isFinite(total) && all.length >= total) return all;
  }
  throw new Error(
    `${path} returned more than ${
      PAGE_GUARD * limit
    } rows; refusing to report a truncated list`,
  );
}

/**
 * Page through a v2 search endpoint. The v2 services disagree on where paging
 * goes and what the rows are called — user search takes `query` and returns
 * `result`, keys, tokens and metadata take `pagination` — so the caller names
 * both and this adds the offsets.
 */
export async function searchAllV2(
  globalArgs: Json,
  path: string,
  body: Json,
  pageKey: "query" | "pagination" = "pagination",
  resultKey = "result",
): Promise<Json[]> {
  const limit = 100;
  let offset = 0;
  const all: Json[] = [];
  for (let guard = 0; guard < PAGE_GUARD; guard++) {
    const page: Json = {
      ...body,
      [pageKey]: { offset: String(offset), limit, asc: true },
    };
    const result = await call(globalArgs, { method: "POST", path, body: page });
    const rows = asArray(result.body[resultKey]);
    all.push(...rows);
    offset += rows.length;
    if (rows.length < limit) return all;
  }
  throw new Error(
    `${path} returned more than ${
      PAGE_GUARD * limit
    } rows; refusing to report a truncated list`,
  );
}
