/**
 * Test helpers: the gateway answers recorded from a throwaway versitygw
 * v1.8.0, read as input by the parser tests, a method context that keeps
 * what a method writes and logs, and the stub fetch the method tests inject.
 *
 * The fixtures' root key pair and every account secret are throwaway values;
 * the tests assert those values reach no record, log line or error.
 *
 * @module
 */
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import { __setFetch, type RawResponse } from "./transport.ts";
import type { DataHandle, GlobalArgs, ModelContext } from "./gateway.ts";

/** The throwaway gateway's root key pair, as the fixtures were signed with. */
export const ROOT_ACCESS = "fixtureroot";

export const ROOT_SECRET = "fixturerootsecret0000";

/** Every account secret the throwaway gateway held starts with this. */
export const SECRET_MARK = "FIXTURE-SECRET";

/** One recorded answer. */
interface Fixture extends RawResponse {
  method: string;
  path: string;
}

const dir = new URL("./fixtures/", import.meta.url);

/** Load one fixture by file name, without `.json`. */
export function fixture(name: string): Fixture {
  return JSON.parse(Deno.readTextFileSync(new URL(`${name}.json`, dir)));
}

/** A key file holding the fixtures' root key pair; removed by `cleanup`. */
export function keyFile(): { path: string; cleanup(): void } {
  const path = Deno.makeTempFileSync({ suffix: ".env" });
  Deno.writeTextFileSync(
    path,
    `# root\nROOT_ACCESS_KEY=${ROOT_ACCESS}\nROOT_SECRET_KEY=${ROOT_SECRET}\n`,
  );
  return { path, cleanup: () => Deno.removeSync(path) };
}

/** Global arguments pointing at the throwaway gateway's recorded answers. */
export function globalArgs(overrides: Partial<GlobalArgs> = {}): GlobalArgs {
  return {
    backend: "versitygw",
    adminUrl: "http://127.0.0.1:17071",
    s3Url: "http://127.0.0.1:17070",
    region: "us-east-1",
    healthPath: "/health",
    rootKeyEnv: false,
    accessKeyName: "ROOT_ACCESS_KEY",
    secretKeyName: "ROOT_SECRET_KEY",
    httpTimeoutMs: 5000,
    concurrency: 4,
    ...overrides,
  };
}

/** The fields swamp 20260930's data query accepts, from its own error text. */
const QUERY_FIELDS = [
  "attributes",
  "content",
  "contentType",
  "createdAt",
  "dataType",
  "id",
  "isLatest",
  "jobName",
  "lifetime",
  "modelName",
  "modelType",
  "name",
  "ns",
  "ownerRef",
  "ownerType",
  "size",
  "source",
  "specName",
  "stepName",
  "streaming",
  "tags",
  "version",
  "workflowName",
  "workflowRunId",
];

/** One `writeResource` call. */
export interface Written {
  spec: string;
  name: string;
  data: Record<string, unknown>;
  tags: Record<string, string>;
}

/** A context plus what it collected. */
interface FakeContext {
  context: ModelContext;
  written: Written[];
  logs: string[];
}

/** Fill `{name}` placeholders the way the swamp logger does. */
function render(message: string, props: Record<string, unknown> = {}): string {
  return message.replace(/\{(\w+)\}/g, (_, k) => String(props[k]));
}

/**
 * A method context. `queryData` understands the one predicate `check` sends,
 * and sees every version written through this context.
 */
export function makeContext(
  g: GlobalArgs,
  written: Written[] = [],
): FakeContext {
  const logs: string[] = [];
  const context: ModelContext = {
    globalArgs: g,
    definition: { name: "vgw" },
    logger: {
      info: (m, p) => logs.push(`info: ${render(m, p)}`),
      warning: (m, p) => logs.push(`warning: ${render(m, p)}`),
    },
    writeResource(spec, name, data, overrides): Promise<DataHandle> {
      written.push({ spec, name, data, tags: overrides?.tags ?? {} });
      return Promise.resolve({ name });
    },
    readResource(name) {
      const last = written.findLast((w) => w.name === name);
      return Promise.resolve(last ? last.data : null);
    },
    queryData(predicate) {
      // The fields swamp's query accepts; anything else fails there too.
      const allowed = new Set(QUERY_FIELDS);
      for (
        const [, field] of predicate.matchAll(
          /([A-Za-z]+)(?:\.\w+)*\s*(?:==|>)/g,
        )
      ) {
        if (!allowed.has(field)) {
          return Promise.reject(
            new Error(`Unknown field "${field}" in query predicate.`),
          );
        }
      }
      if (!predicate.includes('modelName == "vgw"')) {
        return Promise.reject(new Error("query does not name this model"));
      }
      const id = /tags\.inventory == "([^"]+)"/.exec(predicate)?.[1];
      return Promise.resolve(
        written.filter((w) => w.tags.inventory === id).map((w) => ({
          name: w.name,
          specName: w.spec,
          attributes: w.data,
          tags: w.tags,
        })),
      );
    },
  };
  return { context, written, logs };
}

/** One stub answer: a status and an XML body, or a transport failure. */
export type Reply = { status: number; body: string } | Error;

/** An S3 error answer with the code given. */
export function s3Error(status: number, code: string): Reply {
  return {
    status,
    body: `<?xml version="1.0" encoding="UTF-8"?>\n<Error><Code>${code}` +
      `</Code><Message>${code}</Message></Error>`,
  };
}

/** One recorded answer from `fixtures/`, as a stub reply. */
export function recorded(name: string): Reply {
  const { status, body } = fixture(name);
  return { status, body };
}

/**
 * The method tests' stub, in the pattern of swamp's testing guide: a method's
 * `execute` runs through `createModelTestContext` with a stub fetch injected
 * at the transport's `__setFetch` seam. Each test lists the few answers it
 * needs, keyed `"admin PATCH /list-users"` or `"s3 GET /ops?versioning"`; a
 * request it did not list is an error, so a test cannot pass on a request it
 * never meant to make. The root key pair is given as values, the fixtures'
 * throwaway pair. The stub is not a model of the gateway: the live suite in
 * `smoke/` is the proof. Call `restore` when done.
 */
export function harness(
  routes: Record<string, Reply>,
  overrides: Partial<GlobalArgs> = {},
  extra: Record<string, unknown> = {},
) {
  const g = globalArgs({
    rootAccessKey: ROOT_ACCESS,
    rootSecretKey: ROOT_SECRET,
    ...overrides,
  });
  const seen: string[] = [];
  __setFetch((request) => {
    const url = new URL(request.url);
    const api = url.port === "17071" ? "admin" : "s3";
    const key = `${api} ${request.method} ${url.pathname}${url.search}`;
    seen.push(key);
    const reply = routes[key];
    if (reply === undefined) {
      return Promise.reject(new Error(`the stub has no answer for ${key}`));
    }
    if (reply instanceof Error) return Promise.reject(reply);
    return Promise.resolve(
      new Response(reply.body, {
        status: reply.status,
        headers: { "content-type": "application/xml" },
      }),
    );
  });
  const t = createModelTestContext({
    globalArgs: g,
    definition: { name: "vgw" },
  });
  const tags: Record<string, string>[] = [];
  const context = {
    ...t.context,
    writeResource: (
      spec: string,
      name: string,
      data: Record<string, unknown>,
      o?: { tags?: Record<string, string> },
    ) => {
      tags.push(o?.tags ?? {});
      return t.context.writeResource(spec, name, data);
    },
    ...extra,
  } as unknown as ModelContext;
  return {
    context,
    seen,
    written: (): Written[] =>
      t.getWrittenResources().map((w, i) => ({
        spec: w.specName,
        name: w.name,
        data: w.data as Record<string, unknown>,
        tags: tags[i],
      })),
    logs: () =>
      t.getLogs().map((l) =>
        `${l.level}: ${l.message} ${JSON.stringify(l.args ?? [])}`
      ),
    restore: () => __setFetch(),
  };
}

/** Throw when the key pair or an account secret reached a record or a log. */
export function assertNoSecret(
  h: { written(): Written[]; logs(): string[] },
  error?: unknown,
): void {
  const text = JSON.stringify(h.written()) + h.logs().join("\n") +
    (error instanceof Error ? error.message : "");
  for (const secret of [ROOT_SECRET, SECRET_MARK]) {
    if (text.includes(secret)) {
      throw new Error(`a secret reached a record, a log or an error`);
    }
  }
}
