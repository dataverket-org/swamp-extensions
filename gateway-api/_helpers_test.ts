/**
 * The helpers of this domain. What the shared layer does (the runner, the
 * name checks, redaction, the condition readers) is tested once, in
 * `../lib/`; here are the parts built on it, and the names this extension's
 * README promises.
 */
import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  dataName,
  inventoryName,
  InventorySchema,
  kubectlCliCheck,
  KubectlGlobalArgsSchema,
  readConditions,
} from "../lib/kubectl.ts";
import {
  conditionsCurrent,
  listInventory,
  ListInventorySchema,
  readGroupKinds,
  reasonLine,
  reasonSummary,
} from "./_helpers.ts";
import { model as gateway } from "./gateway.ts";
import { model as gatewayclass } from "./gatewayclass.ts";
import { model as httproute } from "./httproute.ts";

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
    assertEquals(m.version, "2026.11.12.1");
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
