/**
 * Tests of the shared kubectl layer's pure functions: names, arguments,
 * the reading of kubectl's output and error text, conditions, data names and
 * the inventory record. They run once, here in `lib/`, not in every
 * extension.
 */
import {
  assert,
  assertEquals,
  assertFalse,
  assertStringIncludes,
  assertThrows,
} from "jsr:@std/assert@1.0.13";
import { KILL_GRACE_MS } from "./cli.ts";
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
  expectObject,
  findCondition,
  getArgs,
  inventoryName,
  InventorySchema,
  isClientGoLogLine,
  isOwnedBy,
  KUBECTL_CALL_LIMIT_MS,
  KUBECTL_KILL_AFTER_MS,
  kubectlArgs,
  kubectlCallLimitMs,
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
  requireNamespace,
  str,
  strings,
  strOrNull,
} from "./kubectl.ts";
import { HOSTILE, list, LOG_LINE, SAID } from "./test_inputs.ts";

const R = "widgets.example.org";

const PASSWORD = "PLANTED-passw0rd";

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

Deno.test("parseKubectlJson and kubectlFailure can be used apart from the runner", () => {
  assertEquals(parseKubectlJson('{"a":1}', ["get"]), { a: 1 });
  const said = SAID.notFound(R, "x").trim();
  const e = kubectlFailure(["get", R, "x"], said);
  assertEquals(e.kind, "not-found");
  assertEquals(e.message, `kubectl get ${R} x failed: ${said}`);
  assertEquals(e.stderr, said);
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
