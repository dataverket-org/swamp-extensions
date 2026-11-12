import {
  __setSpawn,
  MAX_DATA_NAME_BYTES,
  type SpawnResult,
} from "../lib/cli.ts";
import {
  assert,
  assertEquals,
  assertRejects,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { createModelTestContext } from "jsr:@swamp-club/swamp-testing@0.20260917.35";
import {
  absolutePath,
  CONFIG_FILES,
  configFile,
  dataName,
  findings,
  GlobalArgsSchema,
  INVENTORY_NAME,
  isPullProgress,
  logLines,
  lookup,
  LookupArgsSchema,
  model,
  UPDATE_TYPES,
} from "./local.ts";
import {
  configLines,
  dep,
  IMAGE,
  repository,
  update,
  withDisk,
} from "./test_support.ts";

Deno.test("dataName: injective, a file name, never . or ..", () => {
  assertEquals(dataName("app"), "repo-app");
  assertEquals(dataName("apps/web"), "repo-apps_2fweb");
  assertEquals(dataName("apps/web/"), "repo-apps_2fweb");
  assertEquals(dataName("/srv/git/my_app"), "repo-_2fsrv_2fgit_2fmy_5fapp");
  assertEquals(dataName("."), "repo-_2e");
  assertEquals(dataName(".."), "repo-_2e.");
  assertEquals(dataName("../x"), "repo-_2e._2fx");
  assertEquals(dataName("/"), "repo-_2f");
  assertEquals(dataName("ø"), "repo-_c3_b8");
  assertEquals(dataName("a b"), "repo-a_20b");
  const paths = [
    "a/b",
    "a_2fb",
    "a_b",
    "a-b",
    "a.b",
    "a b",
    "A/b",
    "a//b",
    "./a/b",
    ".a",
    "_2ea",
    "inventory_all",
    "inventory/all",
  ];
  const names = paths.map(dataName);
  assertEquals(new Set(names).size, paths.length);
  for (const n of names) {
    assert(/^[A-Za-z0-9._-]+$/.test(n), n);
    assert(n !== INVENTORY_NAME && n !== "." && n !== "..", n);
  }
  // An underscore in a name is always the start of an escape, so no path
  // is stored under the inventory's name.
  assert(!/_(?![0-9a-f]{2})/.test(names.join("")));
  for (const n of names) assert(n.startsWith("repo-"), n);
});

Deno.test("absolutePath: against the repository root, tidied", () => {
  assertEquals(absolutePath("/r", "a"), "/r/a");
  assertEquals(absolutePath("/r", "./a//b/"), "/r/a/b");
  assertEquals(absolutePath("/r", "../a"), "/a");
  assertEquals(absolutePath("/r", "/x/y/../z"), "/x/z");
  assertEquals(absolutePath("/r", "."), "/r");
  assertEquals(absolutePath("/r", "/"), "/");
});

Deno.test("configFile: the names Renovate reads in local mode", async () => {
  await withDisk(async (disk) => {
    for (const name of CONFIG_FILES) {
      const dir = await disk.repo(`has-${dataName(name)}`, { [name]: "{}" });
      assertEquals(await configFile(dir), name);
    }
    const key = await disk.repo("pkg-key", {
      "package.json": '{"name":"x","renovate":{}}',
    });
    assertEquals(await configFile(key), "package.json");
    const first = await disk.repo("two", {
      ".renovaterc": "{}",
      "renovate.json": "{}",
    });
    assertEquals(await configFile(first), "renovate.json");
  });
});

Deno.test("the arguments are plain schemas the CLI can coerce into", () => {
  assertEquals(LookupArgsSchema.parse({ repo: "a" }), { repo: "a" });
  assertEquals(LookupArgsSchema.parse({ repos: ["a", "b"] }), {
    repos: ["a", "b"],
  });
  const g = GlobalArgsSchema.parse({ image: IMAGE });
  assertEquals(g.containerBinary, "podman");
  assertEquals(g.timeoutSeconds, 300);
  assertEquals(g.pull, "missing");
  assertEquals(g.pullTimeoutSeconds, 600);
  assertEquals(g.logLevel, "info");
  // The image is the Renovate version: there is no default.
  assertThrows(() => GlobalArgsSchema.parse({}));
});

Deno.test("the pre-flight check names lookup, and lookup is not a read", () => {
  const check = model.checks["container-binary-available"];
  assertEquals(check.appliesTo, ["lookup"]);
  for (const name of check.appliesTo ?? []) assert(name in model.methods);
  assertEquals(model.methods.lookup.kind, "action");
});

Deno.test("findings: every update type has its own count", () => {
  const f = findings(repository([
    dep({ updates: UPDATE_TYPES.map((t) => update({ updateType: t })) }),
  ]));
  assert(f !== null);
  for (const t of UPDATE_TYPES) assertEquals(f.updateCounts[t], 1, t);
  assertEquals(f.updateCounts.other, 0);
  assertEquals(f.updateCount, UPDATE_TYPES.length);
  assertEquals(f.outdatedCount, 1);
});

Deno.test("isPullProgress: progress is noise, the error is not", () => {
  for (
    const l of [
      "Trying to pull registry.example/renovate:1...",
      "Getting image source signatures",
      "Copying blob sha256:abc",
      "Copying config sha256:abc",
      "Writing manifest to image destination",
      "44.0.0: Pulling from renovatebot/renovate",
    ]
  ) assert(isPullProgress(l), l);
  for (
    const l of [
      "Error: initializing source docker://registry.example/x:1: reading manifest: denied",
      "Error response from daemon: manifest unknown",
    ]
  ) assert(!isPullProgress(l), l);
});

Deno.test("logLines: JSON objects are lines, anything else is counted", () => {
  const { lines, other } = logLines('{"a":1}\nnot json\n\n[1]\n"x"\n{"b":2}\n');
  assertEquals(lines, [{ a: 1 }, { b: 2 }]);
  assertEquals(other, 3);
});

Deno.test("a data name at the limit is taken", () => {
  assertEquals(dataName("a".repeat(MAX_DATA_NAME_BYTES - 5)).length, 255);
});

// ───── lookup, through createModelTestContext with a stub spawn ─────

const out = (stdout: string, code = 0, stderr = ""): SpawnResult => ({
  code,
  stdout: new TextEncoder().encode(stdout),
  stderr,
});

/**
 * Routes: `[<bin> <argument prefix>, answer]`; the first route whose prefix
 * starts the call answers it. A call no route answers fails.
 */
type Routes = [string, SpawnResult][];

/** Runs `body` with the stub spawn of `../lib/cli.ts` and a swamp test context. */
async function withStub(
  routes: Routes,
  root: string,
  body: (h: {
    // deno-lint-ignore no-explicit-any
    context: any;
    calls: string[];
    written: () => {
      spec: string;
      name: string;
      data: Record<string, unknown>;
    }[];
    logs: () => string[];
  }) => Promise<void>,
  globalArgs: Record<string, unknown> = {},
) {
  const calls: string[] = [];
  __setSpawn((bin, args) => {
    const line = [bin, ...args].join(" ");
    calls.push(line);
    const r = routes.find(([prefix]) => line.startsWith(prefix));
    if (!r) {
      return Promise.reject(new Error(`the stub has no answer for ${line}`));
    }
    return Promise.resolve(r[1]);
  });
  const t = createModelTestContext({
    globalArgs: { image: IMAGE, ...globalArgs },
    repoDir: root,
  });
  try {
    await body({
      context: t.context,
      calls,
      written: () =>
        t.getWrittenResources().map((w) => ({
          spec: w.specName,
          name: w.name,
          data: w.data as Record<string, unknown>,
        })),
      logs: () => t.getLogs().map((l) => l.message),
    });
  } finally {
    __setSpawn();
  }
}

const ENGINE: Routes = [
  ["podman --version", out("podman version 4.9.3\n")],
  ["podman info --format", out("true\n")],
  [`podman image inspect --format {{.Config.User}} ${IMAGE}`, out("1000\n")],
];

/** What Renovate prints for one repository with one proposed minor update. */
const RENOVATE_RUN = [
  { level: 30, msg: "Renovate started", renovateVersion: "44.226.2" },
  ...configLines("renovate.json"),
  { level: 40, msg: "Package lookup warning" },
  {
    level: 30,
    msg: "Printing report",
    report: {
      repositories: {
        "/repo": repository([dep({ updates: [update()] })]),
      },
    },
  },
].map((l) => JSON.stringify(l)).join("\n") + "\n";

Deno.test("lookup records each repository and the inventory, with Renovate's warnings in the log", () =>
  withDisk(async (d) => {
    await d.repo("app");
    await withStub(
      [...ENGINE, ["podman run --rm --pull=never", out(RENOVATE_RUN)]],
      d.root,
      async (h) => {
        await lookup(LookupArgsSchema.parse({ repo: "app" }), h.context);
        const run = h.calls.find((c) => c.startsWith("podman run"))!;
        assert(
          run.includes(",readonly"),
          "the repository is mounted read-only",
        );
        assert(run.includes("--userns keep-id:uid=1000"));
        const [repo, inv] = h.written();
        assertEquals([repo.spec, repo.name], ["repository", dataName("app")]);
        assertEquals(repo.data.status, "ok");
        assertEquals(repo.data.updateCount, 1);
        assertEquals(repo.data.configRead, "renovate.json");
        assertEquals(repo.data.renovateVersion, "44.226.2");
        assertEquals([inv.spec, inv.name], ["inventory", INVENTORY_NAME]);
        assertEquals([inv.data.count, inv.data.outdatedCount], [1, 1]);
        assert(
          h.logs().includes("{path}: renovate {level}: {message}"),
          "Renovate's warning is passed on",
        );
      },
    );
  }));

Deno.test("lookup records a run that exits non-zero as failed, and the inventory counts it", () =>
  withDisk(async (d) => {
    await d.repo("app");
    await withStub(
      [...ENGINE, [
        "podman run --rm --pull=never",
        out("", 1, "Error: crun: executable file not found"),
      ]],
      d.root,
      async (h) => {
        await lookup(LookupArgsSchema.parse({ repo: "app" }), h.context);
        const [repo, inv] = h.written();
        assertEquals([repo.data.status, repo.data.failure, repo.data.ok], [
          "failed",
          "exit",
          false,
        ]);
        assert(String(repo.data.reason).includes("executable file not found"));
        assertEquals(inv.data.failedCount, 1);
      },
    );
  }));

Deno.test("lookup fails before any container when the image is not held and pull is never, and writes nothing", () =>
  withDisk(async (d) => {
    await d.repo("app");
    await withStub(
      [
        ...ENGINE.slice(0, 2),
        [
          "podman image inspect",
          out("", 125, "Error: no such image"),
        ],
      ],
      d.root,
      async (h) => {
        await assertRejects(
          () => lookup(LookupArgsSchema.parse({ repo: "app" }), h.context),
          Error,
          "is not held by podman and pull is never",
        );
        assertEquals(h.calls.some((c) => c.startsWith("podman run")), false);
        assertEquals(h.written(), []);
      },
      { pull: "never" },
    );
  }));
