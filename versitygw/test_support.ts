/**
 * Test helpers: the gateway answers recorded from a throwaway versitygw
 * v1.8.0, a fake fetch that replays them, and a fake method context that keeps
 * what a method writes and logs.
 *
 * The fixtures' root key pair and every account secret are throwaway values;
 * the tests assert those values reach no record, log line or error.
 *
 * @module
 */
import { __setFetch, type RawResponse } from "./transport.ts";
import type { DataHandle, GlobalArgs, ModelContext } from "./gateway.ts";

/** The throwaway gateway's root key pair, as the fixtures were signed with. */
export const ROOT_ACCESS = "fixtureroot";
export const ROOT_SECRET = "fixturerootsecret0000";

/** Every account secret the throwaway gateway held starts with this. */
export const SECRET_MARK = "FIXTURE-SECRET";

/** One recorded answer. */
export interface Fixture extends RawResponse {
  method: string;
  path: string;
}

const dir = new URL("./fixtures/", import.meta.url);

/** Load one fixture by file name, without `.json`. */
export function fixture(name: string): Fixture {
  return JSON.parse(Deno.readTextFileSync(new URL(`${name}.json`, dir)));
}

/** Every fixture, keyed by `"METHOD /path?query"`, the default ones only. */
export function recorded(): Map<string, Fixture> {
  const all = new Map<string, Fixture>();
  for (const entry of Deno.readDirSync(dir)) {
    if (!entry.name.endsWith(".json")) continue;
    // Error variants of admin calls are loaded by name when a test wants them.
    if (/^admin-(unsigned|wrong|unknown|not)/.test(entry.name)) continue;
    const f = fixture(entry.name.slice(0, -5));
    all.set(`${f.method} ${f.path}`, f);
  }
  return all;
}

/** What the fake fetch saw. */
export interface Seen {
  line: string;
  signed: boolean;
}

/**
 * Answer each request from `answers`, keyed like {@link recorded}; a request
 * nobody recorded fails the test. `override` answers first, for error cases.
 */
export function installFetch(
  override?: (line: string) => Fixture | undefined,
): { seen: Seen[]; restore(): void } {
  const answers = recorded();
  const seen: Seen[] = [];
  __setFetch((request) => {
    const url = new URL(request.url);
    // aws4fetch writes a bare `?versioning` as `?versioning=`.
    const line = `${request.method} ${url.pathname}${
      url.search.replace(/=$/, "")
    }`;
    const signed = (request.headers.get("authorization") ?? "").includes(
      `Credential=${ROOT_ACCESS}/`,
    );
    seen.push({ line, signed });
    const answer = override?.(line) ?? answers.get(line);
    if (!answer) return Promise.reject(new Error(`no fixture for ${line}`));
    return Promise.resolve(
      new Response(answer.body, {
        status: answer.status,
        headers: { "content-type": answer.contentType },
      }),
    );
  });
  return { seen, restore: () => __setFetch() };
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
export interface FakeContext {
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
