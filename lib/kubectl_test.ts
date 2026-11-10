/**
 * Tests of the shared kubectl layer and of its strict fake. They run once,
 * here in `lib/`, not in every extension. The negative tests come first:
 * each pins one safety property the layer exists for. What the process
 * layer guarantees (the kill at the time limit, redaction, the argument
 * guard) is tested in `cli_test.ts`; here it is tested that kubectl calls
 * go through it.
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import {
  __setSpawn,
  cancelledError,
  CliError,
  KILL_GRACE_MS,
  pollBudget,
} from "./cli.ts";
import {
  annotation,
  arr,
  assertDistinctDataNames,
  bool,
  boolOrNull,
  buildInventory,
  checkName,
  checkNamespace,
  classifyStderr,
  cliArgs,
  conditionState,
  conditionTrue,
  dataName,
  describeKubectlArgs,
  expectObject,
  findCondition,
  getArgs,
  inventoryName,
  InventorySchema,
  isCancelled,
  isClientGoLogLine,
  isKubectlError,
  isOwnedBy,
  KUBECTL_CALL_LIMIT_MS,
  KUBECTL_KILL_AFTER_MS,
  kubectlArgs,
  kubectlCallLimitMs,
  kubectlCheck,
  kubectlCliCheck,
  KubectlError,
  type KubectlFailure,
  kubectlFailure,
  KubectlGlobalArgsSchema,
  kubectlKillAfterMs,
  kubectlOpts,
  label,
  listArgs,
  listItems,
  listNamespace,
  nonEmpty,
  num,
  numOrNull,
  obj,
  ownerName,
  parseKubectlJson,
  readConditions,
  readMeta,
  requestTimeoutOf,
  requireNamespace,
  runKubectl,
  runKubectlText,
  str,
  strings,
  strOrNull,
} from "./kubectl.ts";
import { fakeCli, withCli } from "./cli_fake.ts";
import {
  type Answer,
  CAPTURE,
  fakeKubectl,
  forbiddenList,
  HOSTILE,
  list,
  LOG_LINE,
  SAID,
  type TextCommand,
  withKubectl,
} from "./kubectl_fake.ts";

const R = "widgets.example.org";
const TOKEN = "eyJhbGciOiJSUzI1NiJ9.eyJzdWIiOiJ4In0.c2lnbmF0dXJl";
const PASSWORD = "PLANTED-passw0rd";

/** Run one kubectl call against one scripted answer and return its error. */
async function failing(
  answer: Answer,
  args = ["get", R, "-A"],
): Promise<KubectlError> {
  return await withKubectl(
    { calls: [{ args, ...answer }] },
    () => assertRejects(() => runKubectl(args), KubectlError),
  );
}

// ---------------------------------------------------------------------------
// Negative: names and namespaces
// ---------------------------------------------------------------------------

Deno.test("checkName refuses everything that is not a Kubernetes object name", () => {
  for (const bad of [...HOSTILE, "x".repeat(254)]) {
    const e = assertThrows(() => checkName(bad, "widget name"), Error);
    assertStringIncludes(e.message, "is not a Kubernetes object name");
    assertStringIncludes(e.message, "widget name ");
    assert(e.message.length < 320, `refusal of ${bad.slice(0, 20)} is long`);
  }
  for (const bad of [undefined, null, 7, {}, ["a"], true]) {
    assertThrows(() => checkName(bad), Error, "not a Kubernetes object name");
  }
  for (const ok of ["a", "0", "pg-1", "a.b-c.d", "x".repeat(253)]) {
    assertEquals(checkName(ok), ok);
  }
});

Deno.test("checkNamespace refuses everything that is not a namespace name", () => {
  for (const bad of [...HOSTILE, "a.b", "x".repeat(64)]) {
    const e = assertThrows(() => checkNamespace(bad), Error);
    assertStringIncludes(e.message, "is not a Kubernetes namespace name");
    assert(e.message.length < 320);
  }
  for (const bad of [undefined, null, 7, {}]) {
    assertThrows(() => checkNamespace(bad), Error, "namespace name");
  }
  for (const ok of ["a", "kube-system", "x".repeat(63)]) {
    assertEquals(checkNamespace(ok), ok);
  }
});

Deno.test("the argument builders check what they are given, so a flag cannot be passed as a name", () => {
  for (const bad of HOSTILE) {
    assertThrows(() => getArgs(R, bad, "ns"), Error, "object name");
    assertThrows(() => getArgs(R, bad, null), Error, "object name");
    assertThrows(() => getArgs(R, "ok", bad), Error, "namespace name");
    if (bad !== "") {
      assertThrows(() => listArgs(R, bad), Error, "namespace name");
    }
    assertThrows(() => listArgs(bad, "ns"), Error, "resource");
  }
  assertEquals(getArgs(R, "a", "ns"), ["get", R, "a", "-n", "ns"]);
  assertEquals(getArgs(R, "a", null), ["get", R, "a"]);
  assertEquals(listArgs(R, "ns"), ["get", R, "-n", "ns"]);
  assertEquals(listArgs(R, ""), ["get", R, "-A"]);
  assertEquals(listArgs(R, null), ["get", R]);
});

Deno.test("name=--all and its kind never reach a spawn", async () => {
  await withKubectl({ calls: [] }, async (k) => {
    for (const bad of HOSTILE) {
      await assertRejects(
        async () => await runKubectl(getArgs(R, bad, "ns")),
        Error,
        "is not a Kubernetes object name",
      );
      await assertRejects(
        async () =>
          await runKubectl(getArgs(R, "ok", requireNamespace("get", bad, ""))),
        Error,
      );
      await assertRejects(
        async () => await runKubectl(listArgs(R, listNamespace(bad, "-A"))),
        Error,
      );
    }
    assertEquals(k.calls, []);
  });
});

Deno.test("an empty namespace argument counts as not given", () => {
  // swamp fills a missing method argument from the global argument, whose
  // default is the empty string.
  assertEquals(listNamespace("", ""), "");
  assertEquals(listNamespace("", "pg"), "pg");
  assertEquals(listNamespace(undefined, "pg"), "pg");
  assertEquals(listNamespace("other", "pg"), "other");
  assertEquals(listNamespace(undefined, undefined), "");
  assertEquals(requireNamespace("get", "", "pg"), "pg");
  assertEquals(requireNamespace("get", undefined, "pg"), "pg");
  assertEquals(requireNamespace("get", "other", "pg"), "other");
  for (const [a, g] of [["", ""], [undefined, ""], [undefined, undefined]]) {
    const e = assertThrows(() => requireNamespace("suspend", a, g), Error);
    assertStringIncludes(e.message, "namespace is required for suspend");
  }
  assertThrows(() => listNamespace("-A", ""), Error, "namespace name");
  assertThrows(() => listNamespace(undefined, "a b"), Error, "namespace name");
  assertThrows(() => requireNamespace("get", "--all", "pg"), Error);
  assertThrows(() => requireNamespace("get", "", "--all"), Error);
});

// ---------------------------------------------------------------------------
// Negative: what reaches an error
// ---------------------------------------------------------------------------

Deno.test("client-go log lines are noise, whatever their level", () => {
  for (const level of ["E", "W", "I", "F"]) {
    assert(isClientGoLogLine(`${level}1110 10:48:48.424103 1 x.go:1] n`));
  }
  assert(isClientGoLogLine(LOG_LINE));
  for (
    const own of [
      "error: You must be logged in to the server (Unauthorized)",
      "Error from server (NotFound): x",
      "E1110 is not a log line",
      " E1110 10:48:48.1 indented",
      "",
    ]
  ) {
    assertFalse(isClientGoLogLine(own), own);
  }
});

Deno.test("a truncated message still holds kubectl's sentence when log lines came first", async () => {
  const e = await failing({
    fail: LOG_LINE.repeat(40) +
      "error: You must be logged in to the server (Unauthorized)\n",
  });
  assertEquals(e.kind, "unauthorized");
  assertStringIncludes(e.message, "You must be logged in to the server");
  assertFalse(e.message.includes("memcache.go"));
  assertFalse(e.stderr.includes("memcache.go"));
  assert(e.message.length < 700, String(e.message.length));
  // Only log lines: the last one is all there is, and it still sorts.
  const only = await failing({ fail: LOG_LINE.repeat(5) });
  assertEquals(only.kind, "unreachable");
  assertEquals(only.stderr, LOG_LINE.trim());
  assertStringIncludes(only.message, "connection refused");
});

Deno.test("nothing secret in kubectl's error output reaches the error", async () => {
  const e = await failing({
    fail:
      `Unable to connect to the server: Get "https://admin:${PASSWORD}@api.example.org:6443": dial tcp: lookup api.example.org: no such host\n` +
      `Authorization: Bearer ${TOKEN}\n` + "x".repeat(5000),
  });
  for (const text of [e.message, e.stderr, String(e), JSON.stringify(e)]) {
    assertFalse(text.includes(PASSWORD));
    assertFalse(text.includes(TOKEN));
  }
  assertFalse(e.message.includes("\n"));
  assert(e.message.length < 700);
  assertEquals(e.kind, "unreachable");
});

Deno.test("standard output is never copied into an error", async () => {
  const garbage = `<html>login ${PASSWORD} token ${TOKEN}</html>`;
  const e = await failing({ out: garbage });
  assertEquals(e.kind, "not-json");
  assertStringIncludes(e.message, `kubectl get ${R} -A did not print JSON`);
  assertStringIncludes(e.message, `${garbage.length} characters of output`);
  assertFalse(e.message.includes("html"));
  assertFalse(e.message.includes(PASSWORD));
  assertStringIncludes((await failing({ out: "  \n" })).message, "(no output)");
  // A failed call's standard output is not shown either.
  const f = await failing({ fail: "error: boom", stdout: garbage });
  assertFalse(f.message.includes("html"));
  assertFalse(f.stderr.includes("html"));
  const silent = await failing({ code: 1, stdout: garbage });
  assertStringIncludes(silent.message, "(no error output)");
});

Deno.test("a patch body is not named in an error, and what is named is bounded", async () => {
  const body = JSON.stringify({ status: { note: PASSWORD } });
  const args = ["patch", R, "a", "-n", "ns", "--type=merge", "-p", body];
  const e = await withKubectl(
    {
      calls: [{
        args: [...args.slice(0, -1), CAPTURE],
        fail: SAID.conflict(R, "a"),
      }],
    },
    async (k) => {
      const err = await assertRejects(() => runKubectl(args), KubectlError);
      assertEquals(k.captured, [body]);
      assertEquals(k.kubectl[0].patch, body);
      return err;
    },
  );
  assertEquals(e.kind, "conflict");
  assertFalse(e.message.includes(PASSWORD));
  assertStringIncludes(e.message, "-p <patch> failed");
  assertEquals(
    describeKubectlArgs(["patch", "--patch", body]),
    "patch --patch <patch>",
  );
  assertEquals(
    describeKubectlArgs(["patch", `--patch=${body}`]),
    "patch --patch=<patch>",
  );
  assert(describeKubectlArgs(["get", "x".repeat(900)]).length <= 203);
});

// ---------------------------------------------------------------------------
// Negative: failures are named
// ---------------------------------------------------------------------------

Deno.test("classifyStderr sorts kubectl's sentences", () => {
  const sentence = (stderr: string) =>
    stderr.split("\n").filter((l) => l !== "" && !isClientGoLogLine(l)).join(
      "\n",
    );
  const cases: Array<[string, KubectlFailure]> = [
    [SAID.notFound(R, "x"), "not-found"],
    [SAID.forbidden("list", R), "forbidden"],
    [SAID.forbidden("get", R, "ns"), "forbidden"],
    [
      'error: widgets.example.org "x" is forbidden: User "u" cannot',
      "forbidden",
    ],
    [SAID.unauthorized, "unauthorized"],
    [sentence(SAID.badToken), "unauthorized"],
    [
      "error: the server has asked for the client to provide credentials",
      "unauthorized",
    ],
    [
      "Unable to connect to the server: getting credentials: exec: executable kubelogin not found",
      "unauthorized",
    ],
    [SAID.missingCrd("widgets"), "missing-crd"],
    [SAID.noKind("Widget", "example.org/v1"), "missing-crd"],
    [
      "Error from server (NotFound): the server could not find the requested resource",
      "missing-crd",
    ],
    [SAID.conflict(R, "x"), "conflict"],
    [SAID.alreadyExists(R, "x"), "conflict"],
    [SAID.requestTimeout, "timeout"],
    ['error: Get "https://x:6443/api": context deadline exceeded', "timeout"],
    [
      "Unable to connect to the server: dial tcp 192.0.2.1:6443: i/o timeout",
      "timeout",
    ],
    ["Error from server (Timeout): the server was unable to return", "timeout"],
    [sentence(SAID.refused), "unreachable"],
    [LOG_LINE, "unreachable"],
    [
      "Unable to connect to the server: dial tcp: lookup x: no such host",
      "unreachable",
    ],
    [
      "Unable to connect to the server: tls: failed to verify certificate: x509: certificate signed by unknown authority",
      "unreachable",
    ],
    ["error: stat /no/such/file: no such file or directory", "other"],
    ["Error from server (BadRequest): the body is not valid", "other"],
    ["", "other"],
  ];
  for (const [stderr, kind] of cases) {
    assertEquals(classifyStderr(stderr), kind, stderr);
  }
});

Deno.test("every failure of a call is a KubectlError with its kind and a message that names the command", async () => {
  const cases: Array<[string, KubectlFailure, string]> = [
    [SAID.notFound(R, "x"), "not-found", '"x" not found'],
    [SAID.forbidden("list", R), "forbidden", "is forbidden"],
    [SAID.unauthorized, "unauthorized", "did not accept the credentials"],
    [SAID.missingCrd("widgets"), "missing-crd", "CRDs that define it"],
    [SAID.conflict(R, "x"), "conflict", "has been modified"],
    [SAID.requestTimeout, "timeout", "no answer in time"],
    [SAID.refused, "unreachable", "could not be reached"],
    ["error: boom", "other", "failed: error: boom"],
    ["", "other", "(no error output)"],
  ];
  for (const [fail, kind, text] of cases) {
    const e = await failing({ fail });
    assertEquals(e.kind, kind, fail);
    assertEquals(e.name, "KubectlError");
    assertStringIncludes(e.message, `kubectl get ${R} -A failed: `);
    assertStringIncludes(e.message, text);
    assertFalse(e.message.includes("\n"));
    assert(isKubectlError(e));
    assert(isKubectlError(e, "conflict", kind));
    assertEquals(isKubectlError(e, "cancelled"), false);
  }
  assertEquals(isKubectlError(new Error("x")), false);
});

Deno.test("an expired or wrong token is unauthorized, though kubectl does not print (Unauthorized)", async () => {
  assertFalse(SAID.badToken.includes("(Unauthorized)"));
  const e = await failing({ fail: SAID.badToken });
  assertEquals(e.kind, "unauthorized");
  assertStringIncludes(e.message, "expired or wrong");
  assertStringIncludes(e.message, "You must be logged in to the server");
  assertFalse(e.message.includes("memcache.go"));
});

Deno.test("a refused list is forbidden, though kubectl printed an empty List on standard output", async () => {
  const e = await failing(forbiddenList(R));
  assertEquals(e.kind, "forbidden");
  assertStringIncludes(e.message, 'cannot list resource "widgets"');
  // And the first line is what a caller may keep as a note.
  assertStringIncludes(
    e.stderr.split("\n")[0],
    "Error from server (Forbidden)",
  );
});

Deno.test("a kubectl that does not answer is a timeout, and one that is cancelled is cancelled", async () => {
  const t = await failing({ hang: true });
  assertEquals(t.kind, "timeout");
  assertStringIncludes(
    t.message,
    `no answer within ${KUBECTL_KILL_AFTER_MS / 1000} seconds`,
  );
  const abort = new AbortController();
  const c = await withKubectl(
    { calls: [{ args: ["get", R, "-A"], hang: "until-cancelled" }] },
    async () => {
      const p = assertRejects(
        () => runKubectl(["get", R, "-A"], { signal: abort.signal }),
        KubectlError,
      );
      abort.abort();
      return await p;
    },
  );
  assertEquals(c.kind, "cancelled");
  // Already cancelled: the fake is asked, and answers as a dead process.
  const again = await withKubectl(
    { calls: [{ args: ["get", R, "-A"], out: {} }] },
    () =>
      assertRejects(
        () => runKubectl(["get", R, "-A"], { signal: abort.signal }),
        KubectlError,
      ),
  );
  assertEquals(again.kind, "cancelled");
});

Deno.test("every kubectl process has the request timeout and a kill a little later", async () => {
  assertEquals(KUBECTL_KILL_AFTER_MS, 35_000);
  await withCli({
    calls: [{
      bin: "kubectl",
      args: ["--request-timeout=30s", "get", R, "-A", "-o", "json"],
      timeoutMs: 35_000,
      out: list([]),
    }, {
      bin: "kubectl",
      args: ["--request-timeout=30s", "apply", "-f", "x.yaml"],
      timeoutMs: 35_000,
      out: "applied\n",
    }],
  }, async () => {
    await runKubectl(["get", R, "-A"]);
    await runKubectlText(["apply", "-f", "x.yaml"]);
  });
});

Deno.test("a kubectl that is not installed says so, and other spawn errors pass through", async () => {
  const e = await failing({ notInstalled: true });
  assertEquals(e.kind, "not-installed");
  assertStringIncludes(e.message, "kubectl is not on PATH");
  __setSpawn(() => Promise.reject(new Deno.errors.NotCapable("no run")));
  try {
    await assertRejects(
      () => runKubectl(["get", R, "-A"]),
      Deno.errors.NotCapable,
    );
  } finally {
    __setSpawn();
  }
});

Deno.test("the runner owns the cluster flags, the request timeout and the output format", () => {
  for (
    const own of [
      "--request-timeout=1s",
      "--request-timeout",
      "--kubeconfig",
      "--kubeconfig=/k",
      "--context",
      "-o",
      "-o=yaml",
      "--output=yaml",
    ]
  ) {
    assertThrows(() => kubectlArgs(["get", R, own]), Error, "may not hold");
  }
  // A text call may choose its output, and nothing else of the runner's.
  assertEquals(
    kubectlArgs(["config", "view", "-o", "jsonpath={.x}"], {}, false),
    [
      "--request-timeout=30s",
      "config",
      "view",
      "-o",
      "jsonpath={.x}",
    ],
  );
  for (const own of ["--request-timeout=1s", "--kubeconfig", "--context=x"]) {
    assertThrows(
      () => kubectlArgs(["get", own], {}, false),
      Error,
      "may not hold",
    );
  }
});

Deno.test("answers of the wrong shape are refused", () => {
  const item = { kind: "Widget", metadata: { name: "a", namespace: "ns" } };
  assertEquals(listItems(list([]), "get"), []);
  assertEquals(listItems(list([item]), "get", "Widget"), [item]);
  assertEquals(listItems({ kind: "WidgetList", items: [item] }, "x"), [item]);
  for (
    const bad of [
      {},
      [],
      null,
      "x",
      { items: [] },
      { kind: "List" },
      { kind: "List", items: {} },
      { kind: "Status", items: [] },
      item,
    ]
  ) {
    const e = assertThrows(() => listItems(bad, "kubectl get w"), KubectlError);
    assertStringIncludes(e.message, "kubectl get w did not return a list");
    assertEquals(e.kind, "other");
  }
  assertThrows(
    () => listItems(list([item, null]), "get"),
    KubectlError,
    "item 1 is not an object",
  );
  assertThrows(
    () => listItems(list([item, { kind: "Gadget" }]), "get", "Widget"),
    KubectlError,
    'item 1 is of kind "Gadget", not Widget',
  );

  const want = { kind: "Widget", name: "a", namespace: "ns" };
  assertEquals(expectObject(item, want), item);
  assertEquals(
    expectObject({ kind: "Widget", metadata: { name: "a" } }, {
      ...want,
      namespace: null,
    }).kind,
    "Widget",
  );
  for (
    const bad of [
      null,
      list([item]),
      { ...item, kind: "Gadget" },
      { kind: "Widget", metadata: { name: "b", namespace: "ns" } },
      { kind: "Widget", metadata: { name: "a", namespace: "other" } },
      { kind: "Status", status: "Failure" },
    ]
  ) {
    const e = assertThrows(() => expectObject(bad, want), KubectlError);
    assertStringIncludes(e.message, "did not return Widget ns/a");
  }

  assertThrows(
    () => readMeta({}, false, "Widget"),
    KubectlError,
    "a Widget without a name",
  );
  assertThrows(
    () => readMeta({ metadata: { name: "a" } }, true, "Widget"),
    KubectlError,
    "without a name or namespace",
  );
  assertThrows(() => readMeta({ metadata: { name: 7 } }, false), KubectlError);
});

// ---------------------------------------------------------------------------
// Negative: data names
// ---------------------------------------------------------------------------

Deno.test("two objects that would share a data name refuse the list", () => {
  assertDistinctDataNames("Widget", [
    { namespace: "a", name: "b" },
    { namespace: "a", name: "c" },
    { namespace: "a", name: "b" },
    { namespace: null, name: "b" },
  ]);
  assertThrows(
    () =>
      assertDistinctDataNames("Widget", [
        { namespace: "a", name: "b--c" },
        { namespace: "a--b", name: "c" },
      ]),
    Error,
    "Widget a/b--c and a--b/c would both be stored as a--b--c",
  );
  assertThrows(
    () =>
      assertDistinctDataNames(
        "WidgetClass",
        [{ namespace: null, name: "ok" }, {
          namespace: null,
          name: "inventory",
        }],
        ["ok"],
      ),
    Error,
    "WidgetClass ok would be stored as ok",
  );
  // An object named like the inventory is no collision: the inventory's own
  // name holds an underscore, which no Kubernetes name can.
  assertDistinctDataNames(
    "WidgetClass",
    [{ namespace: null, name: "inventory" }, { namespace: null, name: "all" }],
    [inventoryName(null), inventoryName("all")],
  );
});

Deno.test("data names are predictable and hold only portable characters", () => {
  assertEquals(dataName("pg", "one"), "pg--one");
  assertEquals(dataName("pg", "a.b"), "pg--a.b");
  assertEquals(dataName(null, "one"), "one");
  assertEquals(dataName("", "one"), "one");
  assertEquals(inventoryName(null), "inventory_all");
  assertEquals(inventoryName(""), "inventory_all");
  assertEquals(inventoryName("pg"), "inventory_ns_pg");
  assertEquals(inventoryName("all"), "inventory_ns_all");
  for (const n of HOSTILE) {
    for (const d of [dataName("pg", n), dataName(null, n), dataName(n, "a")]) {
      assert(/^[A-Za-z0-9._-]+$/.test(d), JSON.stringify(d));
      assertFalse(d.endsWith("."), d);
    }
  }
  // A namespaced object's data name always holds "--" and an inventory's
  // never does, unless the namespace does; then the underscore tells them
  // apart, since no Kubernetes name holds one.
  assertFalse(inventoryName(null).includes("--"));
  assert(inventoryName("a--b").includes("_"));
});

// ---------------------------------------------------------------------------
// Happy paths
// ---------------------------------------------------------------------------

Deno.test("the global arguments are namespace, kubeconfig and context, and nothing else", () => {
  assertEquals(Object.keys(KubectlGlobalArgsSchema.shape), [
    "namespace",
    "kubeconfig",
    "context",
  ]);
  assertEquals(KubectlGlobalArgsSchema.parse({}), { namespace: "" });
  assertEquals(
    KubectlGlobalArgsSchema.parse({
      namespace: "a",
      kubeconfig: "/k",
      context: "c",
    }),
    { namespace: "a", kubeconfig: "/k", context: "c" },
  );
  for (const key of ["namespace", "kubeconfig", "context"] as const) {
    assert((KubectlGlobalArgsSchema.shape[key].description ?? "").length > 20);
  }
  const signal = new AbortController().signal;
  const globalArgs = KubectlGlobalArgsSchema.parse({
    namespace: "a",
    kubeconfig: "/k",
    context: "c",
  });
  assertEquals(kubectlOpts({ globalArgs, signal }), {
    kubeconfig: "/k",
    context: "c",
    signal,
  });
});

Deno.test("cliArgs puts the cluster flags first; kubectlArgs adds the timeout and -o json", () => {
  assertEquals(cliArgs(["get", "x"]), ["get", "x"]);
  assertEquals(cliArgs(["get", "x"], { kubeconfig: "/k", context: "c" }), [
    "--kubeconfig",
    "/k",
    "--context",
    "c",
    "get",
    "x",
  ]);
  assertEquals(cliArgs(["get"], { context: "c" }), ["--context", "c", "get"]);
  assertEquals(kubectlArgs(["get", "x"]), [
    "--request-timeout=30s",
    "get",
    "x",
    "-o",
    "json",
  ]);
  assertEquals(kubectlArgs(["get", "x"], { kubeconfig: "/k", context: "c" }), [
    "--kubeconfig",
    "/k",
    "--context",
    "c",
    "--request-timeout=30s",
    "get",
    "x",
    "-o",
    "json",
  ]);
});

Deno.test("runKubectl reads a list and an object from the cluster it was given", async () => {
  const item = { kind: "Widget", metadata: { name: "a", namespace: "ns" } };
  await withKubectl({
    kubeconfig: "/k",
    context: "c",
    clusterScoped: ["widgetclasses.example.org"],
    calls: [
      { args: ["get", R, "-A"], out: list([item]) },
      { args: ["get", R, "a", "-n", "ns"], out: item },
      { args: ["get", "widgetclasses.example.org"], out: list([]) },
      { args: ["get", R, "-n", "ns", "-l", "app=a,tier!=b"], out: list([]) },
    ],
  }, async (k) => {
    const opts = { kubeconfig: "/k", context: "c" };
    assertEquals(
      listItems(await runKubectl(listArgs(R, ""), opts), "list", "Widget"),
      [item],
    );
    assertEquals(await runKubectl(getArgs(R, "a", "ns"), opts), item);
    await runKubectl(listArgs("widgetclasses.example.org", null), opts);
    await runKubectl([...listArgs(R, "ns"), "-l", "app=a,tier!=b"], opts);
    assertEquals(k.calls[0].args, [
      "--kubeconfig",
      "/k",
      "--context",
      "c",
      "--request-timeout=30s",
      "get",
      R,
      "-A",
      "-o",
      "json",
    ]);
    assertEquals(k.kubectl[1].name, "a");
    assertEquals(k.kubectl[1].namespace, "ns");
    assertEquals(k.kubectl[3].selector, "app=a,tier!=b");
  });
});

Deno.test("a body goes to create -f - and to patch on standard input", async () => {
  const body = { apiVersion: "example.org/v1", kind: "Widget" };
  const patch = [
    "patch",
    R,
    "a",
    "-n",
    "ns",
    "--subresource=status",
    "--type=merge",
    "--patch-file=/dev/stdin",
  ];
  await withKubectl({
    calls: [
      { args: ["create", "-f", "-", "-n", "ns"], stdin: body, out: body },
      { args: patch, stdin: { status: {} }, out: body },
    ],
  }, async (k) => {
    assertEquals(
      await runKubectl(["create", "-f", "-", "-n", "ns"], {
        stdin: JSON.stringify(body),
      }),
      body,
    );
    await runKubectl(patch, { stdin: '{"status":{}}' });
    assertEquals(k.kubectl[1].patch, '{"status":{}}');
  });
});

Deno.test("runKubectlText returns what was printed, with the same failures, for another binary too", async () => {
  await withCli({
    calls: [{
      bin: "/opt/kubectl",
      args: [
        "--context",
        "kind-x",
        "--request-timeout=30s",
        "get",
        "--raw",
        "/readyz",
      ],
      out: "ok",
    }, {
      bin: "kubectl",
      args: [
        "--request-timeout=30s",
        "get",
        "serviceaccount",
        "sa",
        "-n",
        "ns",
      ],
      fail: SAID.notFound("serviceaccounts", "sa"),
    }],
  }, async () => {
    assertEquals(
      await runKubectlText(["get", "--raw", "/readyz"], {
        context: "kind-x",
        bin: "/opt/kubectl",
      }),
      "ok",
    );
    const e = await assertRejects(
      () => runKubectlText(["get", "serviceaccount", "sa", "-n", "ns"]),
      KubectlError,
    );
    assertEquals(e.kind, "not-found");
  });
});

Deno.test("parseKubectlJson and kubectlFailure can be used apart from the runner", () => {
  assertEquals(parseKubectlJson('{"a":1}', ["get"]), { a: 1 });
  const said = SAID.notFound(R, "x").trim();
  const e = kubectlFailure(["get", R, "x"], said);
  assertEquals(e.kind, "not-found");
  assertEquals(e.message, `kubectl get ${R} x failed: ${said}`);
  assertEquals(e.stderr, said);
});

Deno.test("a second binary is scripted beside kubectl, word for word", async () => {
  await withKubectl({
    context: "c",
    calls: [
      { bin: "flux", args: ["--context", "c", "reconcile", "x"], out: "ok\n" },
      { args: ["get", R, "x", "-n", "ns"], out: { kind: "Widget" } },
    ],
  }, async (k) => {
    const { runCli } = await import("./cli.ts");
    const r = await runCli(
      "flux",
      cliArgs(["reconcile", "x"], { context: "c" }),
    );
    assertEquals(r.stdout, "ok\n");
    await runKubectl(getArgs(R, "x", "ns"), { context: "c" });
    assertEquals(k.calls.map((c) => c.bin), ["flux", "kubectl"]);
    assertEquals(k.kubectl.length, 1);
  });
});

Deno.test("the kubectl check passes when it runs and names what is wrong when it does not", async () => {
  await withKubectl({ calls: [] }, async () => {
    assertEquals(await kubectlCliCheck.execute(), { pass: true });
    assertEquals(kubectlCliCheck.labels, ["live"]);
  });
  await withKubectl({
    calls: [
      { args: ["version", "--client"], fail: `boom password=${PASSWORD}` },
      { args: ["version", "--client"], notInstalled: true },
      { args: ["version", "--client"], hang: true },
    ],
  }, async () => {
    assertEquals(await kubectlCliCheck.execute(), {
      pass: false,
      errors: [
        "kubectl version --client failed (exit 1): boom password=[redacted]",
      ],
    });
    assertStringIncludes(
      (await kubectlCliCheck.execute()).errors![0],
      "kubectl is not on PATH",
    );
    assertStringIncludes(
      (await kubectlCliCheck.execute({})).errors![0],
      "no answer within 20 seconds",
    );
  });
});

Deno.test("the readers return what is there and a fallback for everything else", () => {
  const junk = [undefined, null, 7, "s", true, [1], { a: 1 }, NaN];
  assertEquals(junk.map(obj), [{}, {}, {}, {}, {}, {}, { a: 1 }, {}]);
  assertEquals(junk.map(arr), [[], [], [], [], [], [1], [], []]);
  assertEquals(junk.map((v) => str(v)), ["", "", "", "s", "", "", "", ""]);
  assertEquals(str(7, "x"), "x");
  assertEquals([strOrNull("s"), strOrNull(""), strOrNull(7)], ["s", "", null]);
  assertEquals([nonEmpty(""), nonEmpty("a"), nonEmpty(7)], [null, "a", null]);
  assertEquals(junk.map((v) => num(v)), [0, 0, 7, 0, 0, 0, 0, 0]);
  assertEquals([num("7", -1), numOrNull(0), numOrNull(NaN)], [-1, 0, null]);
  assertEquals([numOrNull(Infinity), numOrNull("7")], [null, null]);
  assertEquals([bool(true), bool("true"), bool(1, true)], [true, false, true]);
  assertEquals([boolOrNull(false), boolOrNull("x")], [false, null]);
  assertEquals(strings(["a", 1, null, "b"]), ["a", "b"]);
  assertEquals(strings("a"), []);
});

Deno.test("conditions are narrowed, broken entries dropped, and messages redacted", () => {
  assertEquals(readConditions(undefined), []);
  assertEquals(readConditions("nope"), []);
  assertEquals(readConditions({ type: "Ready" }), []);
  const c = readConditions([
    null,
    "x",
    { status: "True" },
    { type: "" },
    { type: "Ready", extra: "x" },
    {
      type: "Archiving",
      status: "False",
      reason: "Failing",
      message: `failed against https://k:${PASSWORD}@s3.example.org`,
      lastTransitionTime: "2026-11-10T09:00:00Z",
      observedGeneration: 4,
    },
    { type: "Odd", status: "Unknown", reason: "", message: "" },
  ]);
  assertEquals(c, [
    {
      type: "Ready",
      status: "Unknown",
      reason: null,
      message: null,
      lastTransitionTime: null,
      observedGeneration: null,
    },
    {
      type: "Archiving",
      status: "False",
      reason: "Failing",
      message: "failed against https://s3.example.org",
      lastTransitionTime: "2026-11-10T09:00:00Z",
      observedGeneration: 4,
    },
    {
      type: "Odd",
      status: "Unknown",
      reason: "",
      message: "",
      lastTransitionTime: null,
      observedGeneration: null,
    },
  ]);
  assertEquals(findCondition(c, "Archiving")?.reason, "Failing");
  assertEquals(findCondition(c, "Missing"), undefined);
  const s = readConditions([
    { type: "A", status: "True" },
    { type: "B", status: "False" },
    { type: "C", status: "Unknown" },
  ]);
  assertEquals(
    ["A", "B", "C", "D"].map((t) => conditionState(s, t)),
    [true, false, null, null],
  );
  assertEquals(
    ["A", "B", "C", "D"].map((t) => conditionTrue(s, t)),
    [true, false, false, false],
  );
});

Deno.test("readMeta reads the identity and leaves annotations where they are", () => {
  const item = {
    apiVersion: "example.org/v1",
    kind: "Widget",
    metadata: {
      name: "a",
      namespace: "ns",
      uid: "u-1",
      generation: 3,
      resourceVersion: "2028",
      creationTimestamp: "2026-11-10T09:41:41Z",
      labels: { app: "a" },
      annotations: {
        "example.org/revision": "4",
        "kubectl.kubernetes.io/last-applied-configuration":
          `{"password":"${PASSWORD}"}`,
      },
      ownerReferences: [
        { kind: "Other", name: "o", uid: "u-o" },
        { kind: "Owner", name: "p", uid: "u-p" },
      ],
    },
  };
  const meta = readMeta(item, true, "Widget");
  assertEquals(meta, {
    apiVersion: "example.org/v1",
    kind: "Widget",
    name: "a",
    namespace: "ns",
    uid: "u-1",
    generation: 3,
    resourceVersion: "2028",
    createdAt: "2026-11-10T09:41:41Z",
  });
  assertFalse(JSON.stringify(meta).includes(PASSWORD));
  assertEquals(readMeta({ metadata: { name: "c" } }, false), {
    apiVersion: "",
    kind: "",
    name: "c",
    namespace: "",
    uid: "",
    generation: null,
    resourceVersion: null,
    createdAt: null,
  });
  assertEquals(annotation(item, "example.org/revision"), "4");
  assertEquals(annotation(item, "missing"), null);
  assertEquals(annotation({}, "x"), null);
  assertEquals(label(item, "app"), "a");
  assertEquals(label(item, "missing"), null);
  assertEquals(ownerName(item, "Owner"), "p");
  assertEquals(ownerName(item, "Missing"), null);
  assertEquals(ownerName({}, "Owner"), null);
  assertEquals(isOwnedBy(item, "Owner", { uid: "u-p", name: "other" }), true);
  assertEquals(isOwnedBy(item, "Owner", { uid: "u-x", name: "p" }), false);
  assertEquals(isOwnedBy(item, "Owner", { uid: "", name: "p" }), true);
  assertEquals(isOwnedBy(item, "Missing", { uid: "u-p", name: "p" }), false);
  assertEquals(isOwnedBy({}, "Owner", { uid: "u-p", name: "p" }), false);
});

Deno.test("buildInventory counts, keeps what an extension adds, and fits the schema", () => {
  const items = [
    {
      namespace: "ns",
      name: "a",
      dataName: dataName("ns", "a"),
      healthy: true,
      reason: null,
      state: "Ready",
    },
    {
      namespace: "ns",
      name: "b",
      dataName: dataName("ns", "b"),
      healthy: false,
      reason: "Ready=False (Failing)",
      state: "Failing",
    },
  ];
  const inv = buildInventory("ns", items, "2026-11-10T00:00:00.000Z");
  assertEquals(inv, {
    namespace: "ns",
    count: 2,
    healthyCount: 1,
    unhealthyCount: 1,
    items,
    observedAt: "2026-11-10T00:00:00.000Z",
  });
  assertEquals(inv.items[1].state, "Failing");
  assertEquals(InventorySchema.parse(inv).count, 2);
  const empty = buildInventory("", [], "2026-11-10T00:00:00.000Z");
  assertEquals([empty.namespace, empty.count, empty.unhealthyCount], [
    null,
    0,
    0,
  ]);
  assertEquals(buildInventory(null, [], "t").namespace, null);
});

// ---------------------------------------------------------------------------
// The fake is as strict as it says
// ---------------------------------------------------------------------------

Deno.test("the fake refuses what the real kubectl would refuse, and what the script did not expect", async () => {
  const run = (
    args: string[],
    o: Parameters<typeof fakeKubectl>[0] = {},
    spawnOpts: {
      timeoutMs?: number;
      stdin?: string;
      env?: Record<string, string>;
    } = {},
  ) =>
    Promise.resolve().then(() =>
      fakeKubectl({ calls: [{ args: [] }], ...o }).spawn("kubectl", args, {
        timeoutMs: KUBECTL_KILL_AFTER_MS,
        ...spawnOpts,
      })
    );
  const T = "--request-timeout=30s";
  const J = ["-o", "json"];
  const P = ["patch", R, "a", "-n", "ns"];
  const refused: Array<[Promise<unknown>, string]> = [
    [run(["get", R, "-A", ...J]), "must start with"],
    [run(["--request-timeout=5s", "get", R, "-A", ...J]), "must start with"],
    [run(["--context", "prod", T, "get", R, "-A", ...J]), "must start with"],
    [run([T, "get", R, "-A", ...J], { context: "test" }), "must start with"],
    [run([T, "get", R, "-A"]), "must end with -o json"],
    [run([T, "get", R, "-A", "-o", "yaml"]), "must end with -o json"],
    [run([T, "get", R, "--all", "-n", "ns", ...J]), "unknown flag for get"],
    [run([T, "get", R, "-n", "--all", ...J]), "is no namespace"],
    [run([T, "get", R, "Upper", "-n", "ns", ...J]), "is no object name"],
    [run([T, "get", R, "a", "b", "-n", "ns", ...J]), "unexpected argument"],
    [run([T, "get", R, "-n", "a", "-n", "b", ...J]), "flag given twice"],
    [run([T, "get", R, "-A", "-n", "ns", ...J]), "-A together with -n"],
    [run([T, "get", R, "a", "-A", ...J]), "-A together with a name"],
    [run([T, "get", R, "a", ...J]), "without -n or -A"],
    [run([T, "get", R, "-A", ...J], { clusterScoped: [R] }), "cluster-scoped"],
    [run([T, "get", R, "-n", "ns", "-l", "-x", ...J]), "is no selector"],
    [run([T, "get", "-n", "ns", ...J]), "needs a resource"],
    [run([T, "delete", R, "a", "-n", "ns", ...J]), "does not know the verb"],
    [run([T, "patch", R, "-n", "ns", "-p", "{}", ...J]), "patch needs a name"],
    [run([T, ...P, ...J]), "exactly one of"],
    [run([T, ...P, "--type=odd", "-p", "{}", ...J]), "unknown flag"],
    [run([T, ...P, "--patch-file=/etc/x", ...J]), "only known as /dev/stdin"],
    [run([T, "create", "-f", "x.yaml", ...J]), "only known as create -f -"],
    [run([T, "create", "-f", "-", ...J]), "without input"],
    [run([T, "get", R, "-A", ...J], {}, { stdin: "{}" }), "does not read"],
    [
      run([T, "get", R, "-A", ...J], {}, { timeoutMs: 1000 }),
      "must be stopped after",
    ],
    [run([T, "get", R, "-A", ...J], {}, { env: { A: "1" } }), "no environment"],
    [run(["version", "--client"], {}, { timeoutMs: 1000 }), "own time limit"],
    [run([T, "get", R, "-A", ...J], { calls: [] }), "unexpected call"],
  ];
  for (const [p, text] of refused) {
    await assertRejects(() => p, Error, text);
  }
  // Another command than the scripted one, another binary, other input.
  await assertRejects(() =>
    run([T, "get", R, "-A", ...J], {
      calls: [{ args: ["get", R, "-n", "ns"] }],
    })
  );
  await assertRejects(() =>
    Promise.resolve().then(() =>
      fakeKubectl({ calls: [{ args: ["x"] }] }).spawn("flux", ["x"], {
        timeoutMs: 1000,
      })
    )
  );
  await assertRejects(() =>
    run([T, "create", "-f", "-", ...J], {
      calls: [{ args: ["create", "-f", "-"], stdin: { a: 1 } }],
    }, { stdin: '{"a":2}' })
  );
  // Calls left over fail the test that scripted them.
  assertThrows(
    () => fakeKubectl({ calls: [{ args: ["get", R, "-A"] }] }).done(),
    Error,
    "scripted calls left unused",
  );
  // The plain fake does not know kubectl; it matches word for word.
  assertThrows(
    () => fakeCli({ calls: [] }).spawn("kubectl", ["get"], { timeoutMs: 1 }),
    Error,
    "unexpected call",
  );
});

Deno.test("the fake can stand for a cluster through a handler", async () => {
  const objects = [
    { kind: "Widget", metadata: { name: "a", namespace: "ns" } },
    { kind: "Widget", metadata: { name: "b", namespace: "other" } },
  ];
  await withKubectl({
    handler: (call) => {
      if (call.resource !== R) return { fail: SAID.missingCrd("x") };
      const inScope = objects.filter((o) =>
        call.allNamespaces || o.metadata.namespace === call.namespace
      );
      if (call.name === undefined) return { out: list(inScope) };
      const found = inScope.find((o) => o.metadata.name === call.name);
      return found ? { out: found } : { fail: SAID.notFound(R, call.name) };
    },
  }, async (k) => {
    assertEquals(
      listItems(await runKubectl(listArgs(R, "")), "list").length,
      2,
    );
    assertEquals(await runKubectl(getArgs(R, "a", "ns")), objects[0]);
    const e = await assertRejects(
      () => runKubectl(getArgs(R, "a", "other")),
      KubectlError,
    );
    assertEquals(e.kind, "not-found");
    const m = await assertRejects(
      () => runKubectl(listArgs("gadgets.example.org", "")),
      KubectlError,
    );
    assertEquals(m.kind, "missing-crd");
    assertEquals(k.calls.length, 4);
    // The handler is not reached by a call that fails the grammar.
    await assertRejects(
      () => runKubectl(["get", R, "--all", "-n", "ns"]),
      Error,
      "unknown flag",
    );
    assertEquals(k.calls.length, 4);
  });
});

// ---------------------------------------------------------------------------
// Additions: the caller's secrets, the check for another binary, text calls
// ---------------------------------------------------------------------------

const OPAQUE = "zq81-opaque-value-no-pattern-knows";

Deno.test("a value the caller names as secret reaches no error of a kubectl call, JSON or text", async () => {
  const said =
    `error: webhook denied the request: bad value ${OPAQUE} in field x\n`;
  const secrets = [OPAQUE];
  await withKubectl({
    textCommands: [{ words: ["annotate"], positionals: [3, 3], names: false }],
    calls: [
      { args: ["get", R, "-n", "ns", "-l", `v=${OPAQUE}`], fail: said },
      {
        args: ["get", R, "-n", "ns", "-l", `v=${OPAQUE}`],
        fail: said,
        stdout: `partial ${OPAQUE}`,
      },
      { args: ["get", R, "-n", "ns", "-l", `v=${OPAQUE}`], out: OPAQUE },
      { args: ["get", R, "-n", "ns", "-l", `v=${OPAQUE}`], hang: true },
      {
        text: true,
        args: ["annotate", R, "a", `v=${OPAQUE}`],
        fail: said,
        stdout: `partial ${OPAQUE}`,
      },
    ],
  }, async () => {
    const args = ["get", R, "-n", "ns", "-l", `v=${OPAQUE}`];
    // Without the option the value is where kubectl put it: the test bites.
    const plain = await assertRejects(() => runKubectl(args), KubectlError);
    assertStringIncludes(plain.message, OPAQUE);
    const errors = [
      await assertRejects(() => runKubectl(args, { secrets }), KubectlError),
      await assertRejects(() => runKubectl(args, { secrets }), KubectlError),
      await assertRejects(() => runKubectl(args, { secrets }), KubectlError),
      await assertRejects(
        () => runKubectlText(["annotate", R, "a", `v=${OPAQUE}`], { secrets }),
        KubectlError,
      ),
    ];
    assertEquals(errors.map((e) => e.kind), [
      "other",
      "not-json",
      "timeout",
      "other",
    ]);
    for (const e of errors) {
      for (const text of [e.message, e.stderr, String(e), JSON.stringify(e)]) {
        assertFalse(text.includes(OPAQUE), text);
        assertFalse(text.includes("partial"), text);
      }
    }
    assertStringIncludes(errors[0].message, "bad value [redacted] in field x");
    assertStringIncludes(errors[0].message, "-l v=[redacted] failed");
    assertStringIncludes(errors[3].message, "kubectl annotate");
  });
  assertEquals(
    describeKubectlArgs(["get", OPAQUE], [OPAQUE]),
    "get [redacted]",
  );
  assertFalse(
    kubectlFailure(["get", OPAQUE], "error: x", [OPAQUE]).message.includes(
      OPAQUE,
    ),
  );
  assertFalse(
    assertThrows(
      () => parseKubectlJson("no", ["get", OPAQUE], [OPAQUE]),
      KubectlError,
    ).message.includes(OPAQUE),
  );
});

Deno.test("kubectlCheck runs the binary a type names, and kubectl when it names none", async () => {
  const check = kubectlCheck((g) => String(g.kubectlBinary ?? "kubectl"));
  assertEquals(check.description, kubectlCliCheck.description);
  assertEquals(check.labels, ["live"]);
  await withKubectl({ bin: "/opt/kubectl", calls: [] }, async (k) => {
    assertEquals(
      await check.execute({ globalArgs: { kubectlBinary: "/opt/kubectl" } }),
      { pass: true },
    );
    assertEquals(await kubectlCheck("/opt/kubectl").execute(), { pass: true });
    assertEquals(k.calls.map((c) => c.bin), ["/opt/kubectl", "/opt/kubectl"]);
    // The fake of another binary does not answer for plain kubectl.
    for (
      const other of [
        await check.execute({ globalArgs: {} }),
        await kubectlCliCheck.execute(),
      ]
    ) {
      assertEquals(other.pass, false);
      assertStringIncludes(other.errors![0], "kubectl could not be run");
      assertStringIncludes(other.errors![0], "unexpected call");
    }
  });
  await withKubectl({
    calls: [{ args: ["version", "--client"], notInstalled: true }],
  }, async (k) => {
    assertEquals(await kubectlCheck().execute({ globalArgs: {} }), {
      pass: false,
      errors: [
        "kubectl is not on PATH; install it or put it on the PATH this repository runs with",
      ],
    });
    assertEquals(await check.execute(), { pass: true });
    assertEquals(k.calls.map((c) => c.bin), ["kubectl", "kubectl"]);
  });
  await withKubectl({
    bin: "/opt/kubectl",
    calls: [{ args: ["version", "--client"], notInstalled: true }],
  }, async () => {
    assertStringIncludes(
      (await check.execute({ globalArgs: { kubectlBinary: "/opt/kubectl" } }))
        .errors![0],
      "/opt/kubectl was not found",
    );
  });
});

/** The text commands of two adopters, as their tests would declare them. */
const TEXT: TextCommand[] = [
  {
    words: ["create", "serviceaccount"],
    valueFlags: ["-n"],
    positionals: [1, 1],
  },
  {
    words: ["create", "token"],
    valueFlags: ["-n"],
    flags: ["--duration=", "--audience="],
    required: ["-n", "--duration="],
    positionals: [1, 1],
  },
  {
    words: ["apply"],
    valueFlags: ["-f"],
    required: ["-f"],
    stdin: true,
  },
  {
    words: ["config", "view"],
    flags: ["--minify"],
    valueFlags: ["-o"],
  },
  { words: ["get"], valueFlags: ["--raw"], required: ["--raw"] },
];

Deno.test("text calls are scripted in the kubectl fake, beside JSON calls, for another binary too", async () => {
  await withKubectl({
    bin: "/opt/kubectl",
    kubeconfig: "/k",
    context: "kind-x",
    textCommands: TEXT,
    calls: [
      { args: ["get", "serviceaccounts", "sa", "-n", "ns"], out: {} },
      { text: true, args: ["create", "serviceaccount", "sa", "-n", "ns"] },
      {
        text: true,
        args: [
          "create",
          "token",
          "sa",
          "-n",
          "ns",
          "--duration=10m",
          "--audience=salmon",
        ],
        out: "opaque.token.value\n",
      },
      { text: true, args: ["apply", "-f", "/repo/m.yaml"], out: "applied\n" },
      { text: true, args: ["apply", "-f", "-"], stdin: "kind: X\n" },
      {
        text: true,
        args: ["config", "view", "--minify", "-o", "jsonpath={.x}"],
        out: "https://127.0.0.1:6443",
      },
      { text: true, args: ["get", "--raw", "/readyz"], out: "ok" },
      {
        text: true,
        args: ["get", "--raw", "/readyz"],
        fail: SAID.refused,
      },
    ],
  }, async (k) => {
    const opts = { bin: "/opt/kubectl", kubeconfig: "/k", context: "kind-x" };
    await runKubectl(["get", "serviceaccounts", "sa", "-n", "ns"], opts);
    assertEquals(
      await runKubectlText(
        ["create", "serviceaccount", "sa", "-n", "ns"],
        opts,
      ),
      "",
    );
    assertEquals(
      await runKubectlText([
        "create",
        "token",
        "sa",
        "-n",
        "ns",
        "--duration=10m",
        "--audience=salmon",
      ], opts),
      "opaque.token.value\n",
    );
    await runKubectlText(["apply", "-f", "/repo/m.yaml"], opts);
    await runKubectlText(["apply", "-f", "-"], { ...opts, stdin: "kind: X\n" });
    assertEquals(
      await runKubectlText(
        ["config", "view", "--minify", "-o", "jsonpath={.x}"],
        opts,
      ),
      "https://127.0.0.1:6443",
    );
    assertEquals(await runKubectlText(["get", "--raw", "/readyz"], opts), "ok");
    const down = await assertRejects(
      () => runKubectlText(["get", "--raw", "/readyz"], opts),
      KubectlError,
    );
    assertEquals(down.kind, "unreachable");

    assertEquals(k.calls.every((c) => c.bin === "/opt/kubectl"), true);
    assertEquals(k.calls[2].args, [
      "--kubeconfig",
      "/k",
      "--context",
      "kind-x",
      "--request-timeout=30s",
      "create",
      "token",
      "sa",
      "-n",
      "ns",
      "--duration=10m",
      "--audience=salmon",
    ]);
    assertEquals(k.kubectl[0].text, undefined);
    const token = k.kubectl[2];
    assertEquals(
      [token.text, token.verb, token.name, token.namespace, token.positionals],
      [true, "create", "sa", "ns", ["sa"]],
    );
    assertEquals(token.flags, {
      "-n": "ns",
      "--duration": "10m",
      "--audience": "salmon",
    });
    assertEquals(k.kubectl[5].flags, {
      "--minify": true,
      "-o": "jsonpath={.x}",
    });
  });
});

Deno.test("a text call is checked as strictly as a JSON call", async () => {
  const T = "--request-timeout=30s";
  const run = (
    args: string[],
    o: Parameters<typeof fakeKubectl>[0] = {},
    spawnOpts: {
      timeoutMs?: number;
      stdin?: string;
      env?: Record<string, string>;
    } = {},
    bin = "kubectl",
  ) =>
    Promise.resolve().then(() =>
      fakeKubectl({
        textCommands: TEXT,
        calls: [{ text: true, args: args.slice(args.indexOf(T) + 1) }],
        ...o,
      }).spawn(bin, args, { timeoutMs: KUBECTL_KILL_AFTER_MS, ...spawnOpts })
    );
  const SA = ["create", "serviceaccount", "sa", "-n", "ns"];
  const TOKEN_ARGS = ["create", "token", "sa", "-n", "ns", "--duration=10m"];
  // The declared calls pass; that is what the refusals below differ from.
  assertEquals((await run([T, ...SA])).code, 0);
  assertEquals((await run([T, ...TOKEN_ARGS])).code, 0);
  const refused: Array<[() => Promise<unknown>, string]> = [
    // The cluster, the request timeout and the kill time, as for JSON.
    [() => run(SA), "must start with"],
    [() => run(["--request-timeout=5s", ...SA]), "must start with"],
    [() => run(["--context", "prod", T, ...SA]), "must start with"],
    [() => run([T, ...SA], { context: "kind-x" }), "must start with"],
    [() => run([T, ...SA], {}, { timeoutMs: 1000 }), "must be stopped after"],
    [
      () => run([T, ...SA], {}, { timeoutMs: 3_600_000 }),
      "must be stopped after",
    ],
    [() => run([T, ...SA], {}, { env: { A: "1" } }), "no environment"],
    // Commands and flags the test did not declare.
    [
      () => run([T, "delete", "serviceaccount", "sa", "-n", "ns"]),
      "textCommands",
    ],
    [() => run([T, "create", "secret", "generic", "x"]), "textCommands"],
    [() => run([T, ...SA], { textCommands: [] }), "textCommands"],
    [() => run([T, ...SA], { textCommands: undefined }), "textCommands"],
    [() => run([T, ...SA, "--all"]), "unknown flag for create serviceaccount"],
    [() => run([T, ...SA, "--dry-run=client"]), "unknown flag"],
    [() => run([T, ...TOKEN_ARGS, "--bound-object-kind=Pod"]), "unknown flag"],
    [() => run([T, ...TOKEN_ARGS, "--durations=1h"]), "unknown flag"],
    [() => run([T, "config", "view", "--raw"]), "unknown flag for config view"],
    // Shape: names, counts, required flags, values.
    [
      () => run([T, "create", "serviceaccount", "-n", "ns"]),
      "takes 1 argument",
    ],
    [() => run([T, ...SA, "extra"]), "takes 1 argument"],
    [
      () => run([T, "create", "serviceaccount", "Upper", "-n", "ns"]),
      "no object name",
    ],
    [
      () => run([T, "create", "serviceaccount", "sa", "-n", "--all"]),
      "no namespace",
    ],
    [
      () => run([T, "create", "serviceaccount", "sa", "-n"]),
      "-n needs a value",
    ],
    [() => run([T, ...SA, "-n", "other"]), "flag given twice"],
    [() => run([T, "create", "token", "sa", "-n", "ns"]), "needs --duration="],
    [() => run([T, "create", "token", "sa", "--duration=1h"]), "needs -n"],
    [() => run([T, "apply"]), "apply needs -f"],
    [() => run([T, "apply", "-f", "a.yaml", "b.yaml"]), "takes 0 argument"],
    [() => run([T, "apply", "-f", "-"]), "was given none"],
    [() => run([T, ...SA], {}, { stdin: "x" }), "does not read"],
    // Another binary than the one the test set.
    [() => run([T, ...SA], {}, {}, "/opt/kubectl"), ""],
    [() => run([T, ...SA], { bin: "/opt/kubectl" }), ""],
  ];
  for (const [call, text] of refused) {
    await assertRejects(call, Error, text);
  }
  // A text entry does not stand for a JSON call, nor a JSON entry for a
  // text call, though the command is the same.
  await assertRejects(() =>
    run([T, ...SA, "-o", "json"], {
      calls: [{ text: true, args: SA }],
    })
  );
  await assertRejects(() => run([T, ...SA], { calls: [{ args: SA }] }));
  // Declared, but not the scripted call.
  await assertRejects(() =>
    run([T, ...SA], {
      calls: [{ text: true, args: ["create", "serviceaccount", "other"] }],
    })
  );
  // The handler sees a text call only after it passed.
  const seen: string[] = [];
  const k = fakeKubectl({
    textCommands: TEXT,
    handler: (call) => {
      seen.push(`${call.text ? "text" : "json"} ${call.command.join(" ")}`);
      return { out: "ok" };
    },
  });
  await k.spawn("kubectl", [T, "get", "--raw", "/readyz"], {
    timeoutMs: KUBECTL_KILL_AFTER_MS,
  });
  await assertRejects(
    () =>
      Promise.resolve().then(() =>
        k.spawn("kubectl", [T, "get", "--raw", "/readyz", "--all"], {
          timeoutMs: KUBECTL_KILL_AFTER_MS,
        })
      ),
    Error,
    "unknown flag",
  );
  assertEquals(seen, ["text get --raw /readyz"]);
});

// ---------------------------------------------------------------------------
// Additions: a call's own time limit, the worst case of a call, cancellation
// ---------------------------------------------------------------------------

Deno.test("a call can ask for a longer request timeout, and the process stop moves with it", async () => {
  assertEquals(requestTimeoutOf(), 30);
  assertEquals(requestTimeoutOf({}), 30);
  assertEquals(requestTimeoutOf({ requestTimeoutSeconds: 120 }), 120);
  assertEquals(kubectlKillAfterMs(), KUBECTL_KILL_AFTER_MS);
  assertEquals(kubectlKillAfterMs({ requestTimeoutSeconds: 120 }), 125_000);
  assertEquals(
    kubectlArgs(["apply", "-f", "m.yaml"], {
      context: "c",
      requestTimeoutSeconds: 120,
    }, false),
    ["--context", "c", "--request-timeout=120s", "apply", "-f", "m.yaml"],
  );
  // The spawn itself, word for word: the flag and the kill time together.
  await withCli({
    calls: [{
      bin: "kubectl",
      args: ["--request-timeout=120s", "apply", "-f", "m.yaml"],
      timeoutMs: 125_000,
      out: "applied\n",
    }, {
      bin: "kubectl",
      args: ["--request-timeout=600s", "get", R, "-A", "-o", "json"],
      timeoutMs: 605_000,
      out: list([]),
    }, {
      bin: "kubectl",
      args: ["--request-timeout=1s", "get", R, "-A", "-o", "json"],
      timeoutMs: 6000,
      hang: true,
    }, {
      bin: "kubectl",
      args: ["--request-timeout=30s", "get", R, "-A", "-o", "json"],
      timeoutMs: 35_000,
      out: list([]),
    }],
  }, async () => {
    assertEquals(
      await runKubectlText(["apply", "-f", "m.yaml"], {
        requestTimeoutSeconds: 120,
      }),
      "applied\n",
    );
    await runKubectl(["get", R, "-A"], { requestTimeoutSeconds: 600 });
    const e = await assertRejects(
      () => runKubectl(["get", R, "-A"], { requestTimeoutSeconds: 1 }),
      KubectlError,
    );
    assertEquals(e.kind, "timeout");
    assertStringIncludes(e.message, "no answer within 6 seconds");
    await runKubectl(["get", R, "-A"], { requestTimeoutSeconds: undefined });
  });
});

Deno.test("a request timeout out of range is refused before anything is spawned", async () => {
  await withKubectl({ calls: [] }, async (k) => {
    for (
      const bad of [
        0,
        -30,
        601,
        86_400,
        1.5,
        NaN,
        Infinity,
        "30" as unknown as number,
        null as unknown as number,
      ]
    ) {
      const opts = { requestTimeoutSeconds: bad };
      for (
        const call of [
          () => runKubectl(["get", R, "-A"], opts),
          () => runKubectlText(["apply", "-f", "m.yaml"], opts),
          () => Promise.resolve(kubectlCallLimitMs(opts)),
        ]
      ) {
        await assertRejects(
          async () => await call(),
          Error,
          "requestTimeoutSeconds",
        );
      }
    }
    assertEquals(k.calls, []);
  });
});

Deno.test("the fake checks the limit a scripted call expects, so another limit cannot pass by accident", async () => {
  const apply = ["apply", "-f", "m.yaml"];
  const textCommands = [{ words: ["apply"], valueFlags: ["-f"] }];
  await withKubectl({
    textCommands,
    calls: [
      { text: true, args: apply, requestTimeoutSeconds: 120, out: "ok" },
      { args: ["get", R, "-A"], requestTimeoutSeconds: 60, out: list([]) },
      { args: ["get", R, "-A"], out: list([]) },
      { args: ["get", R, "-A"], requestTimeoutSeconds: 30, out: list([]) },
    ],
  }, async (k) => {
    await runKubectlText(apply, { requestTimeoutSeconds: 120 });
    await runKubectl(["get", R, "-A"], { requestTimeoutSeconds: 60 });
    await runKubectl(["get", R, "-A"]);
    await runKubectl(["get", R, "-A"], { requestTimeoutSeconds: 30 });
    assertEquals(k.kubectl.map((c) => c.requestTimeoutSeconds), [
      120,
      60,
      30,
      30,
    ]);
    assertEquals(k.calls.map((c) => c.timeoutMs), [
      125_000,
      65_000,
      35_000,
      35_000,
    ]);
  });
  const one = (
    expected: { requestTimeoutSeconds?: number },
    opts: { requestTimeoutSeconds?: number },
  ) =>
    withKubectl({
      textCommands,
      calls: [{ text: true, args: apply, ...expected }],
    }, () => runKubectlText(apply, opts));
  // A default script, a call with its own limit; and each other mismatch.
  await assertRejects(() => one({}, { requestTimeoutSeconds: 120 }));
  await assertRejects(() => one({ requestTimeoutSeconds: 120 }, {}));
  await assertRejects(() =>
    one({ requestTimeoutSeconds: 120 }, { requestTimeoutSeconds: 121 })
  );
  await assertRejects(() =>
    one({ requestTimeoutSeconds: 30 }, {
      requestTimeoutSeconds: 31,
    })
  );
  // The flag and the kill time must belong together.
  const spawn = (flag: string, timeoutMs: number) =>
    Promise.resolve().then(() =>
      fakeKubectl({
        textCommands,
        calls: [{ text: true, args: apply, requestTimeoutSeconds: 120 }],
      }).spawn("kubectl", [flag, ...apply], { timeoutMs })
    );
  assertEquals((await spawn("--request-timeout=120s", 125_000)).code, 0);
  await assertRejects(
    () => spawn("--request-timeout=120s", 35_000),
    Error,
    "must start with --request-timeout=30s",
  );
  await assertRejects(
    () => spawn("--request-timeout=30s", 125_000),
    Error,
    "must start with --request-timeout=120s",
  );
  for (const timeoutMs of [125_500, 5000, 606_000, 3_600_000]) {
    await assertRejects(
      () => spawn("--request-timeout=120s", timeoutMs),
      Error,
      "must be stopped after",
    );
  }
  // A handler answers a call with its own limit only when the test lists it.
  const handled = (requestTimeouts?: number[]) =>
    withKubectl(
      { textCommands, requestTimeouts, handler: () => ({ out: "ok" }) },
      async () => {
        assertEquals(await runKubectlText(apply), "ok");
        return await runKubectlText(apply, { requestTimeoutSeconds: 120 });
      },
    );
  assertEquals(await handled([120]), "ok");
  await assertRejects(() => handled(), Error, "requestTimeouts");
  await assertRejects(() => handled([60]), Error, "requestTimeouts");
});

Deno.test("the worst case of one call is its limit plus the time it takes to stop the process", () => {
  assertEquals(KUBECTL_CALL_LIMIT_MS, 39_000);
  assertEquals(
    KUBECTL_CALL_LIMIT_MS,
    KUBECTL_KILL_AFTER_MS + 2 * KILL_GRACE_MS,
  );
  assertEquals(kubectlCallLimitMs(), KUBECTL_CALL_LIMIT_MS);
  assertEquals(kubectlCallLimitMs({}), 39_000);
  assertEquals(kubectlCallLimitMs({ requestTimeoutSeconds: 120 }), 129_000);
  assertEquals(
    kubectlCallLimitMs({ requestTimeoutSeconds: 600 }),
    kubectlKillAfterMs({ requestTimeoutSeconds: 600 }) + 2 * KILL_GRACE_MS,
  );
  // It takes the options of the call as they are.
  assertEquals(
    kubectlCallLimitMs({
      ...kubectlOpts({ globalArgs: { context: "c" } }),
      requestTimeoutSeconds: 45,
    }),
    54_000,
  );
});

Deno.test("a cancelled run is recognised wherever it was noticed: in kubectl, in a wait, in another command", async () => {
  const abort = new AbortController();
  abort.abort();
  const inKubectl = await withKubectl(
    { calls: [{ args: ["get", R, "-A"] }] },
    () =>
      assertRejects(
        () => runKubectl(["get", R, "-A"], { signal: abort.signal }),
        KubectlError,
      ),
  );
  const inWait = await withKubectl(
    { calls: [] },
    () =>
      assertRejects(
        () => pollBudget(60_000).wait(5000, abort.signal),
        CliError,
      ),
  );
  assert(isKubectlError(inKubectl, "cancelled"));
  assertFalse(isKubectlError(inWait, "cancelled"));
  for (const e of [inKubectl, inWait, cancelledError()]) {
    assert(isCancelled(e));
    assertStringIncludes(e.message, "cancelled");
  }
  for (
    const other of [
      new Error("cancelled"),
      new KubectlError("timeout", "x"),
      new CliError("failed", "cancelled", { bin: "x" }),
      "cancelled",
      null,
      undefined,
    ]
  ) {
    assertFalse(isCancelled(other));
  }
  // The shape of the adopters' poll loops: the wait is outside the try, so
  // a run cancelled between two reads ends the loop without a read, and
  // the catch around the read still passes a cancelled read on.
  let reads = 0;
  const loop = async (signal: AbortSignal) => {
    const budget = pollBudget(60_000);
    while (await budget.wait(5000, signal)) {
      try {
        reads++;
        await runKubectl(["get", R, "-A"], { signal });
      } catch (err) {
        if (isKubectlError(err, "cancelled")) throw err;
        return "swallowed";
      }
    }
    return "ended";
  };
  const ended = await withKubectl(
    { calls: [] },
    () => assertRejects(() => loop(abort.signal), Error, "cancelled"),
  );
  assert(isCancelled(ended));
  assertEquals(reads, 0);
});

Deno.test("only the server's own refusal, or kubectl's own sentence, is forbidden", () => {
  for (
    const yes of [
      SAID.forbidden("list", R),
      `${LOG_LINE}Error from server (Forbidden): pods "x" is forbidden: violates PodSecurity`,
      "error: first line\nError from server (Forbidden): second line",
      'Error from server (Forbidden): error when creating "m.yaml": admission webhook denied the request',
      'error: widgets.example.org "x" is forbidden: User "u" cannot get',
    ]
  ) {
    assertEquals(classifyStderr(yes), "forbidden", yes);
  }
  for (
    const no of [
      'error: unknown flag "Error from server (Forbidden)"',
      "error: the answer was (Forbidden) somewhere in a sentence",
      "Error from server (BadRequest): the reason (Forbidden) is not known",
      " Error from server (Forbidden): indented, so not kubectl's own line",
    ]
  ) {
    assertEquals(classifyStderr(no), "other", no);
  }
});
