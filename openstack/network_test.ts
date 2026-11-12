import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeNetwork } from "./network.ts";
import { fail, NOT_FOUND, withStub } from "./test_support.ts";
import { NETWORK_EXTERNAL, NETWORK_SHOW } from "./fixtures.ts";

Deno.test("normalizeNetwork exposes the external flag and subnets", () => {
  const n = normalizeNetwork(NETWORK_SHOW);
  assertEquals(n.name, "private-net");
  assertEquals(n.external, false);
  assertEquals(n.mtu, 1442);
  assertEquals(n.subnetIds, ["e1e8839f-8154-40d8-84d3-38c01020b27e"]);
  assertEquals(n.portSecurityEnabled, true);
  assertEquals(n.providerNetworkType, "");
  assertEquals(normalizeNetwork(NETWORK_EXTERNAL).external, true);
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;
const ID = NETWORK_SHOW.id;

Deno.test("list shows each external network and writes one record each", () =>
  withStub([
    ["network list -c ID --external", { json: [{ ID: NETWORK_EXTERNAL.id }] }],
    [`network show ${NETWORK_EXTERNAL.id}`, { json: NETWORK_EXTERNAL }],
  ], async (h) => {
    await M.list.execute({ external: true }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.external]), [[
      "network",
      "network-ext-net",
      true,
    ]]);
    assertEquals(h.logs().at(-1)?.message, "stored {count} networks");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub([["network list", fail("Unauthorized (HTTP 401)")]], async (h) => {
    await assertRejects(
      () => M.list.execute({}, h.context),
      Error,
      "network list failed (exit 1)",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("get writes the network it reads", () =>
  withStub(
    [["network show private-net", { json: NETWORK_SHOW }]],
    async (h) => {
      await M.get.execute({ network: "private-net" }, h.context);
      assertEquals(h.written().map((w) => [w.spec, w.name, w.data.mtu]), [[
        "network",
        "network-private-net",
        1442,
      ]]);
    },
  ));

Deno.test("get fails on a missing network, and writes nothing", () =>
  withStub([["network show nope", NOT_FOUND]], async (h) => {
    await assertRejects(
      () => M.get.execute({ network: "nope" }, h.context),
      Error,
      "network show nope failed",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create makes a missing network with its flags and writes it", () =>
  withStub([
    ["network show private-net", NOT_FOUND],
    [
      "network create --no-share --disable-port-security --mtu 1400 --tag t private-net",
      { json: { id: ID } },
    ],
    [`network show ${ID}`, { json: NETWORK_SHOW }],
  ], async (h) => {
    await M.create.execute({
      name: "private-net",
      shared: false,
      portSecurity: false,
      mtu: 1400,
      tags: ["t"],
    }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name]), [[
      "network",
      "network-private-net",
    ]]);
  }));

Deno.test("create reuses an existing network of the same name", () =>
  withStub(
    [["network show private-net", { json: NETWORK_SHOW }]],
    async (h) => {
      await M.create.execute({ name: "private-net" }, h.context);
      assertEquals(h.written().map((w) => w.name), ["network-private-net"]);
      assertEquals(h.calls.some((c) => c.startsWith("network create")), false);
    },
  ));

Deno.test("create fails when the CLI refuses, and writes nothing", () =>
  withStub([
    ["network show private-net", NOT_FOUND],
    [
      "network create",
      fail("Quota exceeded for resources: ['network'] (HTTP 409)"),
    ],
  ], async (h) => {
    await assertRejects(
      () => M.create.execute({ name: "private-net" }, h.context),
      Error,
      "Quota exceeded",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("update renames, drops the old record and writes the new one", () =>
  withStub([
    ["network show private-net", { json: NETWORK_SHOW }],
    [`network set --name lan --mtu 1400 ${ID}`, { stdout: "" }],
    [`network show ${ID}`, {
      json: { ...NETWORK_SHOW, name: "lan", mtu: 1400 },
    }],
  ], async (h) => {
    await M.update.execute(
      { network: "private-net", name: "lan", mtu: 1400 },
      h.context,
    );
    assertEquals(h.deleted(), ["network-private-net"]);
    assertEquals(h.written().map((w) => [w.name, w.data.mtu]), [[
      "network-lan",
      1400,
    ]]);
  }));

Deno.test("update fails when the set fails, and changes nothing stored", () =>
  withStub([
    ["network show private-net", { json: NETWORK_SHOW }],
    ["network set", fail("Forbidden (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () => M.update.execute({ network: "private-net", mtu: 9000 }, h.context),
      Error,
      "network set failed",
    );
    assertEquals(h.deleted(), []);
    assertEquals(h.written(), []);
  }));

Deno.test("delete deletes the network and drops its stored resource", () =>
  withStub([
    ["network show private-net", { json: NETWORK_SHOW }],
    [`network delete ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.delete.execute({ network: "private-net" }, h.context);
    assertEquals(h.deleted(), ["network-private-net"]);
  }));

Deno.test("delete fails on a network in use, and drops nothing", () =>
  withStub([
    ["network show private-net", { json: NETWORK_SHOW }],
    [
      "network delete",
      fail(
        "Unable to complete operation on network. There are one or more ports still in use on the network. (HTTP 409)",
      ),
    ],
  ], async (h) => {
    await assertRejects(
      () => M.delete.execute({ network: "private-net" }, h.context),
      Error,
      "still in use",
    );
    assertEquals(h.deleted(), []);
  }));
