/**
 * What must not happen, for every type and both methods: a name shaped like a
 * flag or a shell fragment reaching kubectl, a failed call leaving a record,
 * a credential in an error, a log line or a record.
 */
import {
  assertEquals,
  assertInstanceOf,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  KUBECTL_KILL_AFTER_MS,
  kubectlCliCheck,
  KubectlError,
  REQUEST_TIMEOUT_FLAG,
} from "../lib/kubectl.ts";
import {
  forbiddenList,
  HOSTILE,
  SAID,
  withKubectl,
} from "../lib/kubectl_fake.ts";
import { model as gateway } from "./gateway.ts";
import { model as gatewayclass } from "./gatewayclass.ts";
import { model as httproute } from "./httproute.ts";
import {
  acceptedClass,
  ctx,
  type FakeCluster,
  healthyGateway,
  healthyRoute,
  withCluster,
} from "./test_support.ts";

type Ctx = ReturnType<typeof ctx>;
type Run = (c: Ctx) => Promise<unknown>;

const FULL: FakeCluster = {
  objects: {
    gateways: [healthyGateway()],
    httproutes: [healthyRoute()],
    gatewayclasses: [acceptedClass()],
  },
};

/** Every method of every type, with arguments that are fine. */
const EVERY: Array<{ id: string; run: Run }> = [
  {
    id: "gateway list",
    run: (c) => gateway.methods.list.execute({}, c.context),
  },
  {
    id: "gateway get",
    run: (c) =>
      gateway.methods.get.execute(
        { name: "edge", namespace: "infra" },
        c.context,
      ),
  },
  {
    id: "httproute list",
    run: (c) => httproute.methods.list.execute({}, c.context),
  },
  {
    id: "httproute get",
    run: (c) =>
      httproute.methods.get.execute(
        { name: "app", namespace: "apps" },
        c.context,
      ),
  },
  {
    id: "gatewayclass list",
    run: (c) => gatewayclass.methods.list.execute({}, c.context),
  },
  {
    id: "gatewayclass get",
    run: (c) =>
      gatewayclass.methods.get.execute({ name: "example" }, c.context),
  },
];

/** Run every method against a cluster that fails one way; nothing is written. */
async function everyMethodFails(
  cluster: FakeCluster,
  kind: string,
  messageHolds: string,
  only: (id: string) => boolean = () => true,
): Promise<string[]> {
  const messages: string[] = [];
  for (const m of EVERY.filter((m) => only(m.id))) {
    await withCluster(cluster, async (k) => {
      const c = ctx();
      const e = await assertRejects(() => m.run(c), KubectlError);
      assertEquals(e.kind, kind, m.id);
      assertStringIncludes(e.message, messageHolds, m.id);
      assertEquals(c.written, [], `${m.id} wrote after a failed call`);
      assertEquals(k.calls.length, 1, `${m.id} retried`);
      messages.push(e.message);
    });
  }
  return messages;
}

Deno.test("every method works against the full fake (the baseline the negatives vary)", async () => {
  for (const m of EVERY) {
    await withCluster(FULL, async (k) => {
      const c = ctx();
      await m.run(c);
      assertEquals(c.written.length > 0, true, m.id);
      assertEquals(k.calls.length, 1, m.id);
    });
  }
});

Deno.test("a cluster without the Gateway API is missing-crd, named per resource", async () => {
  const messages = await everyMethodFails(
    { missingResources: ["gateways", "httproutes", "gatewayclasses"] },
    "missing-crd",
    "The Gateway API CRDs are not installed",
  );
  assertStringIncludes(messages[0], "gateways.gateway.networking.k8s.io");
  assertStringIncludes(messages[2], "httproutes.gateway.networking.k8s.io");
  assertStringIncludes(messages[4], "gatewayclasses.gateway.networking.k8s.io");
});

Deno.test("one missing CRD fails only its own type", async () => {
  await withCluster(
    { ...FULL, missingResources: ["httproutes"] },
    async () => {
      const ok = ctx();
      await gateway.methods.list.execute({}, ok.context);
      assertEquals(ok.written.length, 2);
      const e = await assertRejects(
        () => httproute.methods.list.execute({}, ctx().context),
        KubectlError,
      );
      assertEquals(e.kind, "missing-crd");
    },
  );
});

Deno.test("an RBAC refusal is a named error and nothing is written", async () => {
  await everyMethodFails(
    { failWith: SAID.forbidden("list", "gateways.gateway.networking.k8s.io") },
    "forbidden",
    "refused by RBAC",
  );
});

Deno.test("a refused list is a failure although kubectl prints an empty List", async () => {
  // kubectl exits 1 and still prints a List with no items. Read as an
  // answer, it would be stored as "this cluster has no Gateways".
  const refused = forbiddenList("gateways.gateway.networking.k8s.io");
  const messages = await everyMethodFails(
    { failWith: refused.fail, failStdout: refused.stdout },
    "forbidden",
    "refused by RBAC",
    (id) => id.endsWith(" list"),
  );
  assertEquals(messages.length, 3);
});

Deno.test("expired credentials are a named error, tried once", async () => {
  for (const said of [SAID.unauthorized, SAID.badToken]) {
    await everyMethodFails(
      { failWith: said },
      "unauthorized",
      "did not accept the credentials",
    );
  }
});

Deno.test("a cluster that does not answer in time is a timeout that names the limit", async () => {
  await everyMethodFails(
    { hang: true },
    "timeout",
    "no answer within 35 seconds",
  );
  await everyMethodFails(
    { failWith: SAID.requestTimeout },
    "timeout",
    "no answer in time",
  );
});

Deno.test("a cluster that cannot be reached is unreachable, in kubectl's one sentence", async () => {
  const messages = await everyMethodFails(
    { failWith: SAID.refused },
    "unreachable",
    "could not be reached (The connection to the server 127.0.0.1:1 was refused",
  );
  for (const m of messages) assertEquals(m.includes("memcache.go"), false, m);
});

Deno.test("output that is not JSON is a named error, for text, nothing, and half an answer", async () => {
  for (
    const out of [
      "Unable to connect to the server",
      "",
      '{"items":[{"metadata":',
      "<html>502 Bad Gateway</html>",
    ]
  ) {
    await everyMethodFails(
      { stdoutOverride: out },
      "not-json",
      "did not print JSON",
    );
  }
});

Deno.test("JSON of the wrong shape is an error, not an empty or half record", async () => {
  for (
    const out of [
      "null",
      "[]",
      "{}",
      '"text"',
      '{"items":{}}',
      "42",
      // A list without a kind, and a Status answer, are not lists.
      '{"items":[]}',
      '{"kind":"Status","status":"Failure","items":[]}',
      '{"kind":"List","items":["text"]}',
    ]
  ) {
    await everyMethodFails({ stdoutOverride: out }, "other", "kubectl");
  }
  // A list holding an object without a name fails whole: nothing is written.
  for (const kind of ["Gateway", "HTTPRoute", "GatewayClass"]) {
    const messages = await everyMethodFails(
      {
        stdoutOverride: JSON.stringify({
          kind: "List",
          items: [{ kind, metadata: {} }],
        }),
      },
      "other",
      "without a name",
      (id) => id === `${kind.toLowerCase()} list`,
    );
    assertEquals(messages.length, 1, kind);
  }
});

Deno.test("a missing kubectl binary is a named error", async () => {
  await everyMethodFails(
    { noBinary: true },
    "not-installed",
    "kubectl is not on PATH",
  );
});

Deno.test("a missing object fails get by name and leaves no record", async () => {
  const gets: Array<{ id: string; run: Run }> = [
    {
      id: "gateway",
      run: (c) =>
        gateway.methods.get.execute(
          { name: "ghost", namespace: "infra" },
          c.context,
        ),
    },
    {
      id: "gateway in another namespace",
      run: (c) =>
        gateway.methods.get.execute(
          { name: "edge", namespace: "apps" },
          c.context,
        ),
    },
    {
      id: "httproute",
      run: (c) =>
        httproute.methods.get.execute(
          { name: "ghost", namespace: "apps" },
          c.context,
        ),
    },
    {
      id: "gatewayclass",
      run: (c) =>
        gatewayclass.methods.get.execute({ name: "ghost" }, c.context),
    },
  ];
  for (const g of gets) {
    await withCluster(FULL, async () => {
      const c = ctx();
      const e = await assertRejects(() => g.run(c), KubectlError);
      assertEquals(e.kind, "not-found", g.id);
      assertStringIncludes(e.message, "not found", g.id);
      assertEquals(c.written, [], g.id);
    });
  }
});

Deno.test("get without a namespace refuses before kubectl is run", async () => {
  for (const m of [gateway, httproute]) {
    for (const args of [{ name: "edge" }, { name: "edge", namespace: "" }]) {
      await withCluster(FULL, async (k) => {
        const c = ctx();
        const e = await assertRejects(
          () => m.methods.get.execute(args, c.context),
          Error,
        );
        assertStringIncludes(e.message, "namespace is required for get");
        assertEquals(k.calls, []);
        assertEquals(c.written, []);
      });
    }
  }
});

const INJECTIONS = [
  "",
  " ",
  "-A",
  "--all-namespaces",
  "-o=yaml",
  "--kubeconfig=/etc/passwd",
  "--raw=/api/v1/secrets",
  "edge -n kube-system",
  "edge;id",
  "edge|id",
  "$(id)",
  "`id`",
  "edge\nsecrets",
  "edge/../secrets",
  "secrets/edge",
  "Edge",
  "edge,secrets",
  "edge*",
  "\u0000",
];

/** The values of this suite and of the shared one, each once. */
const BAD_NAMES = [...new Set([...INJECTIONS, ...HOSTILE])];

Deno.test("a name shaped like a flag or a shell fragment never reaches kubectl", async () => {
  for (const bad of BAD_NAMES) {
    const runs: Run[] = [
      (c) =>
        gateway.methods.get.execute(
          { name: bad, namespace: "infra" },
          c.context,
        ),
      (c) =>
        httproute.methods.get.execute(
          { name: bad, namespace: "apps" },
          c.context,
        ),
      (c) => gatewayclass.methods.get.execute({ name: bad }, c.context),
    ];
    for (const run of runs) {
      await withCluster(FULL, async (k) => {
        const c = ctx();
        const e = await assertRejects(() => run(c), Error);
        assertStringIncludes(e.message, "not a Kubernetes object name");
        assertEquals(k.calls, [], JSON.stringify(bad));
        assertEquals(c.written, []);
      });
    }
  }
});

Deno.test("a namespace shaped like a flag or a shell fragment never reaches kubectl", async () => {
  // The empty string is not a bad namespace: it means "not given".
  for (const bad of BAD_NAMES.filter((b) => b !== "")) {
    const runs: Run[] = [
      (c) => gateway.methods.list.execute({ namespace: bad }, c.context),
      (c) => httproute.methods.list.execute({ namespace: bad }, c.context),
      (c) =>
        gateway.methods.get.execute(
          { name: "edge", namespace: bad },
          c.context,
        ),
      (c) =>
        httproute.methods.get.execute(
          { name: "app", namespace: bad },
          c.context,
        ),
      // From the definition instead of the argument.
      (_c) => gateway.methods.list.execute({}, ctx({ namespace: bad }).context),
      (_c) =>
        httproute.methods.get.execute(
          { name: "app" },
          ctx({ namespace: bad }).context,
        ),
    ];
    for (const run of runs) {
      await withCluster(FULL, async (k) => {
        const c = ctx();
        const e = await assertRejects(() => run(c), Error);
        assertStringIncludes(e.message, "not a Kubernetes namespace name");
        assertEquals(k.calls, [], JSON.stringify(bad));
        assertEquals(c.written, []);
      });
    }
  }
});

Deno.test("a namespace with a dot is refused although a name may hold one", async () => {
  await withCluster(FULL, async (k) => {
    const c = ctx();
    const e = await assertRejects(
      () => gateway.methods.list.execute({ namespace: "a.b" }, c.context),
      Error,
    );
    assertStringIncludes(e.message, "not a Kubernetes namespace name");
    assertEquals(k.calls, []);
  });
});

Deno.test("two objects under one data name refuse the whole list before any write", async () => {
  const a = healthyGateway();
  (a.metadata as Record<string, unknown>).namespace = "a";
  (a.metadata as Record<string, unknown>).name = "b--c";
  const b = healthyGateway();
  (b.metadata as Record<string, unknown>).namespace = "a--b";
  (b.metadata as Record<string, unknown>).name = "c";
  await withCluster({ objects: { gateways: [a, b] } }, async () => {
    const c = ctx();
    const e = await assertRejects(
      () => gateway.methods.list.execute({}, c.context),
      Error,
    );
    assertStringIncludes(e.message, "would both be stored as a--b--c");
    assertEquals(c.written, []);
  });
  const r1 = healthyRoute();
  (r1.metadata as Record<string, unknown>).namespace = "a";
  (r1.metadata as Record<string, unknown>).name = "b--c";
  const r2 = healthyRoute();
  (r2.metadata as Record<string, unknown>).namespace = "a--b";
  (r2.metadata as Record<string, unknown>).name = "c";
  await withCluster({ objects: { httproutes: [r1, r2] } }, async () => {
    const c = ctx();
    const e = await assertRejects(
      () => httproute.methods.list.execute({}, c.context),
      Error,
    );
    assertStringIncludes(e.message, "would both be stored as a--b--c");
    assertEquals(c.written, []);
  });
});

Deno.test("a credential in kubectl's output reaches neither the error nor a record", async () => {
  const secret = "eyJhbGciOiJSUzI1NiJ9.c2VjcmV0.c2ln";
  const messages = await everyMethodFails(
    {
      failWith:
        `error: request failed, Authorization: Bearer ${secret}\ntoken: ${secret} password=${secret}`,
    },
    "other",
    "[redacted]",
  );
  for (const m of messages) assertEquals(m.includes(secret), false, m);
  // Standard output that is not JSON is never repeated, only measured.
  const notJson = await everyMethodFails(
    { stdoutOverride: `not json, token=${secret}` },
    "not-json",
    "characters of output",
  );
  for (const m of notJson) {
    assertEquals(m.includes(secret), false, m);
    assertEquals(m.includes("not json"), false, m);
  }
});

Deno.test("a credential a controller copied into a condition message is blanked in the record", async () => {
  const secret = "eyJhbGciOiJSUzI1NiJ9.c2VjcmV0.c2ln";
  const g = healthyGateway();
  (g.status as Record<string, unknown>).conditions = [
    {
      type: "Accepted",
      status: "False",
      reason: "Invalid",
      message: `upstream said: Authorization: Bearer ${secret}`,
    },
  ];
  await withCluster({ objects: { gateways: [g] } }, async () => {
    const c = ctx();
    await gateway.methods.list.execute({}, c.context);
    assertEquals(c.everything().includes(secret), false);
    assertStringIncludes(c.everything(), "[redacted]");
  });
});

Deno.test("nothing a run leaves behind holds the kubeconfig's content or unread fields", async () => {
  const cluster = { kubeconfig: "/path/to/kubeconfig", context: "ctx" };
  for (const m of EVERY) {
    await withCluster({ ...FULL, ...cluster }, async () => {
      const c = ctx(cluster);
      await m.run(c);
      const left = c.everything();
      assertEquals(left.includes("ANNOTATION-SECRET-VALUE"), false, m.id);
      assertEquals(left.includes("/path/to/kubeconfig"), false, m.id);
      assertEquals(left.includes("last-applied-configuration"), false, m.id);
    });
  }
});

Deno.test("a call made with another cluster's flags than the definition's is refused by the fake", async () => {
  // The fake is the check here: it accepts only the flags of its cluster.
  await withCluster({ ...FULL, context: "expected" }, async () => {
    const e = await assertRejects(
      () => gateway.methods.list.execute({}, ctx({ context: "x" }).context),
      Error,
    );
    assertStringIncludes(e.message, "the call must start with");
  });
});

Deno.test("the kubectl check passes when it runs and names a missing binary", async () => {
  for (const m of [gateway, httproute, gatewayclass]) {
    const check = m.checks["kubectl-cli-available"];
    assertEquals(check, kubectlCliCheck);
    await withCluster({}, async (k) => {
      assertEquals(await check.execute(), { pass: true });
      assertEquals(k.calls.map((c) => c.args), [["version", "--client"]]);
    });
  }
  const r = await withKubectl(
    { calls: [{ args: ["version", "--client"], notInstalled: true }] },
    () => kubectlCliCheck.execute(),
  );
  assertEquals(r.pass, false);
  assertStringIncludes(r.errors![0], "kubectl is not on PATH");
  const broken = await withKubectl(
    { calls: [{ args: ["version", "--client"], fail: "exec format error" }] },
    () => kubectlCliCheck.execute(),
  );
  assertEquals(broken.pass, false);
  assertStringIncludes(broken.errors![0], "exec format error");
});

Deno.test("an error is always a KubectlError with a kind a caller can branch on", async () => {
  await withCluster({ failWith: "boom" }, async () => {
    const e = await assertRejects(
      () => gateway.methods.list.execute({}, ctx().context),
    );
    assertInstanceOf(e, KubectlError);
    assertEquals(e.name, "KubectlError");
    assertEquals(e.kind, "other");
  });
});

Deno.test("a cancelled run ends as cancelled and writes nothing", async () => {
  for (const m of EVERY) {
    await withCluster(FULL, async () => {
      const c = ctx();
      c.cancel();
      const e = await assertRejects(() => m.run(c), KubectlError);
      assertEquals(e.kind, "cancelled", m.id);
      assertEquals(c.written, [], m.id);
    });
  }
});

Deno.test("every call carries the request timeout and the process limit of the shared layer", async () => {
  for (const m of EVERY) {
    await withCluster(FULL, async (k) => {
      await m.run(ctx());
      assertEquals(k.calls[0].args[0], REQUEST_TIMEOUT_FLAG, m.id);
      assertEquals(k.calls[0].timeoutMs, KUBECTL_KILL_AFTER_MS, m.id);
      assertEquals(k.kubectl[0].verb, "get", m.id);
    });
  }
});
