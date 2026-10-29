/**
 * `@dataverket/http/endpoint` — one HTTP or HTTPS URL, asked whether it
 * answers: the status, whether the TLS chain verified, how fast, where
 * redirects led, and whether the body holds what it should.
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
  return null;
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
      const body = g.bodyContains !== "" ? await res.text() : "";
      if (g.bodyContains === "") await res.body?.cancel();
      const latencyMs = Math.round(performance.now() - started);
      const bodyMatched = g.bodyContains === ""
        ? null
        : body.includes(g.bodyContains);
      const statusOk = res.status === g.expectStatus;
      const ok = statusOk && bodyMatched !== false;
      const error = ok
        ? null
        : !statusOk
        ? `status ${res.status}, expected ${g.expectStatus}`
        : `body does not hold ${JSON.stringify(g.bodyContains)}`;
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
      "url is http or https, and caFile and userAgent hold no newline",
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
  version: "2026.10.29.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    health: {
      description:
        "Whether the endpoint answered as expected, over a verified chain, and how fast",
      schema: HealthSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    health: {
      description:
        "GET the URL and record status, TLS, latency, redirects and body match; an endpoint that is down or wrong is recorded, not thrown",
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
