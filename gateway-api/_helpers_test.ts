/**
 * The helpers of this domain. What the shared layer does (the runner, the
 * name checks, redaction, the condition readers) is tested once, in
 * `../lib/`; here are the parts built on it, and the names this extension's
 * README promises.
 */
import {
  assertEquals,
  assertRejects,
  assertStringIncludes,
} from "jsr:@std/assert@1.0.13";
import {
  dataName,
  inventoryName,
  InventorySchema,
  kubectlCliCheck,
  KubectlError,
  KubectlGlobalArgsSchema,
  readConditions,
} from "../lib/kubectl.ts";
import { LOG_LINE, SAID } from "../lib/kubectl_fake.ts";
import {
  conditionsCurrent,
  listInventory,
  ListInventorySchema,
  readGatewayApi,
  readGroupKinds,
  reasonLine,
  reasonSummary,
} from "./_helpers.ts";
import { model as gateway } from "./gateway.ts";
import { model as gatewayclass } from "./gatewayclass.ts";
import { model as httproute } from "./httproute.ts";
import { withCluster } from "./test_support.ts";

const RES = "gateways.gateway.networking.k8s.io";

/** One read against a cluster that answers every call with this stderr. */
async function failure(stderr: string): Promise<KubectlError> {
  return await withCluster({ failWith: stderr }, () =>
    assertRejects(
      () => readGatewayApi(["get", RES, "-A"], RES, { globalArgs: {} }),
      KubectlError,
    ));
}

Deno.test("conditionsCurrent compares observed generations to the object's", () => {
  const at = (g: number | null) =>
    readConditions([{ type: "A", status: "True", observedGeneration: g }]);
  assertEquals(conditionsCurrent(3, at(3)), true);
  assertEquals(conditionsCurrent(3, at(2)), false);
  assertEquals(conditionsCurrent(3, at(null)), null);
  assertEquals(conditionsCurrent(null, at(2)), null);
  assertEquals(conditionsCurrent(3, []), null);
});

Deno.test("readGroupKinds defaults the group and drops what has no kind", () => {
  assertEquals(
    readGroupKinds([
      { kind: "HTTPRoute" },
      { group: "", kind: "Service" },
      { group: "x" },
      "text",
      null,
    ]),
    [
      { group: "gateway.networking.k8s.io", kind: "HTTPRoute" },
      // The core group is the empty string and must stay one.
      { group: "", kind: "Service" },
    ],
  );
  assertEquals(readGroupKinds(undefined), []);
});

Deno.test("absent CRDs are missing-crd, worded as the Gateway API not being installed", async () => {
  for (
    const said of [
      SAID.missingCrd("gateways"),
      SAID.noKind("Gateway", "gateway.networking.k8s.io/v1"),
      "Error from server (NotFound): the server could not find the requested resource\n",
    ]
  ) {
    const e = await failure(said);
    assertEquals(e.kind, "missing-crd", said);
    assertStringIncludes(e.message, "The Gateway API CRDs are not installed");
    assertStringIncludes(e.message, `does not serve ${RES}`);
    assertStringIncludes(e.message, `kubectl get ${RES} -A failed`);
  }
});

Deno.test("a refusal is forbidden, names the verbs needed and keeps kubectl's sentence", async () => {
  const e = await failure(SAID.forbidden("list", RES));
  assertEquals(e.kind, "forbidden");
  assertStringIncludes(e.message, "refused by RBAC");
  assertStringIncludes(e.message, `needs get and list on ${RES}`);
  assertStringIncludes(e.message, 'cannot list resource "gateways"');
  assertEquals(e.message.includes("\n"), false);
});

Deno.test("every other failure passes through with the shared layer's kind and words", async () => {
  const notFound = await failure(SAID.notFound(RES, "x"));
  assertEquals(notFound.kind, "not-found");
  assertStringIncludes(notFound.message, "not found");
  for (const said of [SAID.unauthorized, SAID.badToken]) {
    const e = await failure(said);
    assertEquals(e.kind, "unauthorized");
    assertStringIncludes(e.message, "did not accept the credentials");
  }
  const closed = await failure(SAID.refused);
  assertEquals(closed.kind, "unreachable");
  assertStringIncludes(closed.message, "could not be reached");
  assertStringIncludes(closed.message, "was refused - did you specify");
  assertEquals(closed.message.includes("memcache.go"), false);
  // Log lines only: the last one is all there is, and it is kept.
  const noise = await failure(LOG_LINE.repeat(5));
  assertEquals(noise.kind, "unreachable");
  assertStringIncludes(noise.message, "connection refused");
  // A dial that ran out of time is a timeout, not unreachable.
  const slow = await failure(
    "Unable to connect to the server: dial tcp 192.0.2.1:6443: i/o timeout\n",
  );
  assertEquals(slow.kind, "timeout");
  const other = await failure(
    "error: stat /no/such/file: no such file or directory\n",
  );
  assertEquals(other.kind, "other");
  assertStringIncludes(other.message, "no such file");
  assertStringIncludes((await failure("")).message, "(no error output)");
});

Deno.test("the wording of a failure never carries what looks like a credential", async () => {
  const secret = "eyJhbGciOiJSUzI1NiJ9.c2VjcmV0.c2ln";
  for (
    const said of [
      `Error from server (Forbidden): ${RES} is forbidden: token=${secret} Authorization: Bearer ${secret}\n`,
      `error: the server doesn't have a resource type "gateways" password: ${secret}\n`,
    ]
  ) {
    const e = await failure(said);
    assertEquals(e.message.includes(secret), false, e.message);
    assertEquals(e.stderr.includes(secret), false, e.stderr);
  }
});

Deno.test("data names: objects by namespace and name, classes by name, inventories apart from both", () => {
  assertEquals(dataName("infra", "edge"), "infra--edge");
  assertEquals(dataName(null, "example"), "example");
  assertEquals(inventoryName(null), "inventory_all");
  assertEquals(inventoryName("infra"), "inventory_ns_infra");
  // Portable: nothing a filesystem refuses.
  for (const n of [dataName("a", "b.c"), inventoryName("a-b")]) {
    assertEquals(/^[A-Za-z0-9._-]+$/.test(n), true, n);
  }
});

Deno.test("reasonLine and reasonSummary write what a person reads", () => {
  assertEquals(
    reasonLine("listener https", "ResolvedRefs", "False", "InvalidRef"),
    "listener https: ResolvedRefs=False (InvalidRef)",
  );
  assertEquals(
    reasonLine("gateway", "Accepted", null, null),
    "gateway: Accepted=missing",
  );
  assertEquals(reasonLine("class", null, null, null), "class: no status");
  assertEquals(reasonSummary([]), null);
  assertEquals(reasonSummary(["a"]), "a");
  assertEquals(reasonSummary(["a", "b", "c"]), "a (and 2 more)");
});

Deno.test("listInventory is the shared inventory plus what this domain adds", () => {
  const at = "2026-11-10T00:00:00.000Z";
  const inv = listInventory("ns", [
    {
      namespace: "ns",
      name: "a",
      apiVersion: "g/v1",
      healthy: true,
      reasons: [],
    },
    {
      namespace: "ns",
      name: "b",
      apiVersion: "g/v1beta1",
      healthy: false,
      reasons: ["x", "y"],
    },
    {
      namespace: "ns",
      name: "c",
      apiVersion: "g/v1",
      healthy: false,
      reasons: [],
    },
  ], at);
  ListInventorySchema.parse(inv);
  // Every field of the shared core is there, so a reader written for
  // another extension's inventory reads this one.
  InventorySchema.parse(inv);
  assertEquals(inv.namespace, "ns");
  assertEquals(inv.count, 3);
  assertEquals(inv.healthyCount, 1);
  assertEquals(inv.unhealthyCount, 2);
  assertEquals(inv.allHealthy, false);
  assertEquals(inv.apiVersions, ["g/v1", "g/v1beta1"]);
  assertEquals(inv.items, [
    {
      namespace: "ns",
      name: "a",
      dataName: "ns--a",
      healthy: true,
      reason: null,
    },
    {
      namespace: "ns",
      name: "b",
      dataName: "ns--b",
      healthy: false,
      reason: "x (and 1 more)",
    },
    {
      namespace: "ns",
      name: "c",
      dataName: "ns--c",
      healthy: false,
      reason: "not healthy, no reason given",
    },
  ]);
  assertEquals(inv.unhealthy, [
    { namespace: "ns", name: "b", reasons: ["x", "y"] },
    { namespace: "ns", name: "c", reasons: [] },
  ]);
  const empty = listInventory(null, [], at);
  assertEquals(empty.allHealthy, true);
  assertEquals(empty.count, 0);
  assertEquals(empty.namespace, null);
  // An empty namespace is "all", as the list methods pass it.
  assertEquals(listInventory("", [], at).namespace, null);
});

Deno.test("every type is read-only, versioned alike, and takes exactly the shared global arguments", () => {
  for (const m of [gateway, httproute, gatewayclass]) {
    assertEquals(Object.keys(m.methods).sort(), ["get", "list"]);
    assertEquals(m.version, "2026.11.10.1");
    assertEquals(m.globalArguments, KubectlGlobalArgsSchema);
    assertEquals(Object.keys(m.globalArguments.shape).sort(), [
      "context",
      "kubeconfig",
      "namespace",
    ]);
    assertEquals(m.checks, { "kubectl-cli-available": kubectlCliCheck });
    assertEquals(m.resources.inventory.schema, ListInventorySchema);
    assertEquals(m.type.startsWith("@dataverket/gateway-api/"), true);
  }
});
