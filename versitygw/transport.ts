/**
 * `@dataverket/versitygw` — the transport: where the root key pair comes from,
 * SigV4 signing, one request to the admin or the S3 API, and the S3 XML error
 * body turned into an {@link S3Error}.
 *
 * versitygw has no read-only admin role, so every admin call, reads included,
 * signs with the root key pair. The definition names where the pair is, never
 * the pair itself: a key file the operator's session writes, or the process
 * environment. Both values are masked in every error text this module builds.
 *
 * One injectable seam, {@link __setFetch}, lets tests answer from recorded
 * gateway responses without a gateway.
 *
 * @module
 */
import { AwsClient } from "npm:aws4fetch@1.0.20";
import { XMLParser, XMLValidator } from "npm:fast-xml-parser@5.11.2";

/** What the transport needs from the global arguments. */
export interface Endpoint {
  adminUrl: string;
  s3Url: string;
  region: string;
  caFile?: string;
  rootKeyFile?: string;
  rootKeyEnv?: boolean;
  accessKeyName: string;
  secretKeyName: string;
  httpTimeoutMs: number;
}

/** The root key pair, read at call time and held only for one execution. */
export interface RootKey {
  access: string;
  secret: string;
}

/** A parsed S3 or admin API error. */
export class S3Error extends Error {
  /** The S3 error code, e.g. `SignatureDoesNotMatch`. */
  readonly code: string;
  /** The HTTP status the gateway answered with. */
  readonly status: number;

  constructor(code: string, message: string, status: number) {
    super(message);
    this.name = "S3Error";
    this.code = code;
    this.status = status;
  }
}

/** One answer, as the recorded fixtures hold it. */
export interface RawResponse {
  status: number;
  contentType: string;
  body: string;
}

/** The fetch the transport uses; replaceable for tests. */
export type Fetcher = (
  request: Request,
  init: { client?: Deno.HttpClient; signal?: AbortSignal },
) => Promise<Response>;

let testFetch: Fetcher | undefined;

/** Install a fake fetch (tests only); call with no argument to restore. */
export function __setFetch(fetcher?: Fetcher): void {
  testFetch = fetcher;
}

function expandHome(path: string): string {
  if (path !== "~" && !path.startsWith("~/")) return path;
  const home = Deno.env.get("HOME");
  if (!home) throw new Error(`cannot expand ~ in ${path}: HOME is not set`);
  return home + path.slice(1);
}

/**
 * Parse `NAME=value` lines, the subset of a dotenv file a shell writes: blank
 * lines and `#` comments skipped, an optional `export `, one pair of matching
 * quotes stripped. Nothing is expanded.
 */
export function parseKeyFile(text: string): Map<string, string> {
  const values = new Map<string, string>();
  for (const raw of text.split(/\r?\n/)) {
    const line = raw.trim();
    if (!line || line.startsWith("#")) continue;
    const match = /^(?:export\s+)?([A-Za-z_][A-Za-z0-9_]*)=(.*)$/.exec(line);
    if (!match) continue;
    let value = match[2].trim();
    if (
      value.length >= 2 &&
      (value[0] === '"' || value[0] === "'") && value.at(-1) === value[0]
    ) {
      value = value.slice(1, -1);
    }
    values.set(match[1], value);
  }
  return values;
}

/**
 * Read the root key pair from the one source the definition names. The error
 * texts name the source and the variable, never a value.
 */
export function readRootKey(endpoint: Endpoint): RootKey {
  const { rootKeyFile, rootKeyEnv, accessKeyName, secretKeyName } = endpoint;
  if (rootKeyFile && rootKeyEnv) {
    throw new Error("give rootKeyFile or rootKeyEnv, not both");
  }
  let lookup: (name: string) => string | undefined;
  let source: string;
  if (rootKeyFile) {
    const path = expandHome(rootKeyFile);
    let text: string;
    try {
      text = Deno.readTextFileSync(path);
    } catch (err) {
      if (err instanceof Deno.errors.NotFound) {
        throw new Error(`rootKeyFile: ${path} does not exist`);
      }
      if (err instanceof Deno.errors.PermissionDenied) {
        throw new Error(`rootKeyFile: ${path} is not readable`);
      }
      throw new Error(`rootKeyFile: ${path} could not be read`);
    }
    const values = parseKeyFile(text);
    lookup = (name) => values.get(name);
    source = `rootKeyFile ${path}`;
  } else if (rootKeyEnv) {
    lookup = (name) => Deno.env.get(name);
    source = "the environment";
  } else {
    throw new Error("no root key source: set rootKeyFile or rootKeyEnv");
  }
  const access = lookup(accessKeyName) ?? "";
  const secret = lookup(secretKeyName) ?? "";
  if (!access) throw new Error(`${accessKeyName} is not set in ${source}`);
  if (!secret) throw new Error(`${secretKeyName} is not set in ${source}`);
  return { access, secret };
}

/** Mask every occurrence of each value in `text`. */
export function redact(text: string, values: string[]): string {
  let out = text;
  for (const value of values) {
    if (value) out = out.split(value).join("[REDACTED]");
  }
  return out;
}

const parser = new XMLParser({
  ignoreAttributes: false,
  attributeNamePrefix: "@",
  removeNSPrefix: true,
  parseTagValue: false,
  parseAttributeValue: false,
  trimValues: true,
  htmlEntities: true,
  isArray: (name) =>
    [
      "Accounts",
      "Buckets",
      "Grant",
      "CORSRule",
      "AllowedMethod",
      "AllowedOrigin",
      "AllowedHeader",
      "ExposeHeader",
      "Tag",
    ].includes(name),
});

/**
 * Parse an XML body into plain objects; element text stays a string. A body
 * that is not well-formed XML is an error, which names no part of the body.
 */
export function parseXml(body: string): Record<string, unknown> {
  if (!body.trim()) throw new Error("expected XML, got an empty body");
  if (XMLValidator.validate(body) !== true) {
    throw new Error("expected XML, got a body that is not well-formed");
  }
  return parser.parse(body) as Record<string, unknown>;
}

/** The one top-level element of `body`, which must be `name`. */
export function parseRoot(body: string, name: string): Record<string, unknown> {
  const doc = parseXml(body);
  const top = Object.keys(doc).filter((key) => !key.startsWith("?"));
  if (top.length !== 1 || top[0] !== name) {
    throw new Error(
      `expected <${name}>, got <${top.join(", <") || "nothing"}>`,
    );
  }
  const root = doc[name];
  return typeof root === "object" && root !== null
    ? root as Record<string, unknown>
    : {};
}

/**
 * Turn a non-2xx answer into an {@link S3Error}. A wrong region comes back as
 * `AuthorizationHeaderMalformed` carrying the region the gateway expects; it
 * is reported as `IncorrectRegion`, which is what an operator has to fix.
 */
export function parseError(
  response: RawResponse,
  what: string,
  region: string,
): S3Error {
  let code = `HTTP${response.status}`;
  // A body that is not an S3 error is quoted only when it is not XML: an
  // XML document in an error answer may be anything, including the account
  // list, and is described by its length instead.
  const body = response.body.trim();
  let message = body.startsWith("<")
    ? `a ${body.length}-byte body that is not an S3 error`
    : body.slice(0, 200);
  try {
    const parsed = parseXml(response.body).Error as
      | Record<string, unknown>
      | undefined;
    if (parsed && typeof parsed.Code === "string") {
      code = parsed.Code;
      message = typeof parsed.Message === "string" ? parsed.Message : "";
      if (
        code === "AuthorizationHeaderMalformed" &&
        typeof parsed.Region === "string" && parsed.Region !== region
      ) {
        code = "IncorrectRegion";
        message =
          `the gateway expects region ${parsed.Region}; the definition signs with ${region}`;
      }
    }
  } catch {
    // Not XML: keep the start of the body as the message.
  }
  return new S3Error(
    code,
    `${what}: HTTP ${response.status} ${code}${message ? `: ${message}` : ""}`,
    response.status,
  );
}

/**
 * Sign a request with SigV4 for service `s3`, as the gateway checks it on both
 * APIs: `x-amz-content-sha256` is always sent. `datetime` (`YYYYMMDDTHHMMSSZ`)
 * is for test vectors only.
 */
export function sign(
  request: Request,
  key: RootKey,
  region: string,
  datetime?: string,
): Promise<Request> {
  const signer = new AwsClient({
    accessKeyId: key.access,
    secretAccessKey: key.secret,
    service: "s3",
    region,
  });
  return signer.sign(request, datetime ? { aws: { datetime } } : undefined);
}

/**
 * An error's message and its causes', joined: fetch rejects with "fetch
 * failed" and keeps why (a refused connection, an unknown issuer) in `cause`.
 */
export function reasons(err: unknown): string {
  const parts: string[] = [];
  let current: unknown = err;
  for (let depth = 0; current !== undefined && depth < 5; depth++) {
    const message = current instanceof Error
      ? current.message
      : String(current);
    if (message && !parts.includes(message)) parts.push(message);
    current = current instanceof Error ? current.cause : undefined;
  }
  return parts.join(": ");
}

/** One request the transport makes. */
export interface Call {
  api: "admin" | "s3";
  method: "GET" | "PATCH";
  /** Path below the API's base URL, starting with `/`. */
  path: string;
  /** Query string without `?`; a bare key such as `versioning` is fine. */
  query?: string;
  /** Unsigned, as `/health` is. */
  unsigned?: boolean;
}

let clientCache: { caFile: string; client: Deno.HttpClient } | undefined;

function httpClient(caFile: string | undefined): Deno.HttpClient | undefined {
  if (!caFile) return undefined;
  if (clientCache?.caFile === caFile) return clientCache.client;
  let pem: string;
  try {
    pem = Deno.readTextFileSync(expandHome(caFile));
  } catch {
    throw new Error(`caFile: ${caFile} could not be read`);
  }
  // One client per CA file: a definition names one, so a change of file
  // means a different model in the same process, and the old client goes.
  clientCache?.client.close();
  clientCache = { caFile, client: Deno.createHttpClient({ caCerts: [pem] }) };
  return clientCache.client;
}

/** Join a base URL (which may carry a path prefix) and a path. */
export function joinUrl(base: string, path: string, query?: string): string {
  const url = base.replace(/\/+$/, "") + path;
  return query ? `${url}?${query}` : url;
}

/**
 * Make one request and return the raw answer. Errors are left to the caller,
 * since some are answers (a bucket without a policy); {@link expectOk} turns
 * the rest into an {@link S3Error}. Transport failures are rethrown with the
 * key pair masked.
 */
export async function send(
  endpoint: Endpoint,
  key: RootKey | undefined,
  call: Call,
  signal?: AbortSignal,
): Promise<RawResponse> {
  const base = call.api === "admin" ? endpoint.adminUrl : endpoint.s3Url;
  const url = joinUrl(base, call.path, call.query);
  let request = new Request(url, { method: call.method });
  if (!call.unsigned) {
    if (!key) throw new Error(`${call.method} ${call.path}: no root key`);
    request = await sign(request, key, endpoint.region);
  }
  const timeout = AbortSignal.timeout(endpoint.httpTimeoutMs);
  const init = {
    client: httpClient(endpoint.caFile),
    signal: signal ? AbortSignal.any([signal, timeout]) : timeout,
  };
  try {
    const response = testFetch
      ? await testFetch(request, init)
      : await fetch(request, init);
    return {
      status: response.status,
      contentType: response.headers.get("content-type") ?? "",
      body: await response.text(),
    };
  } catch (err) {
    const reason = reasons(err);
    throw new Error(
      redact(`${call.method} ${url}: ${reason}`, [
        key?.secret ?? "",
        key?.access ?? "",
      ]),
    );
  }
}

/** The answer if it is 2xx, else its {@link S3Error}, with the key masked. */
export function expectOk(
  response: RawResponse,
  what: string,
  endpoint: Endpoint,
  key?: RootKey,
): RawResponse {
  if (response.status >= 200 && response.status < 300) return response;
  const error = parseError(response, what, endpoint.region);
  const masked = redact(error.message, [key?.secret ?? "", key?.access ?? ""]);
  throw new S3Error(error.code, masked, error.status);
}
