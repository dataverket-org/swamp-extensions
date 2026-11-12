import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeSecurityGroup } from "./security_group.ts";
import { fail, NOT_FOUND, withStub } from "./test_support.ts";
import { SECURITY_GROUP_SHOW } from "./fixtures.ts";

Deno.test("normalizeSecurityGroup keeps rules inline with nullable ports", () => {
  const g = normalizeSecurityGroup(SECURITY_GROUP_SHOW);
  assertEquals(g.name, "ssh");
  assertEquals(g.stateful, true);
  assertEquals(g.shared, false);
  assertEquals(g.rules.length, 2);
  assertEquals(g.rules[0], {
    id: "2a57f453-55e5-427d-9103-d17ebf52a9bf",
    direction: "ingress",
    ethertype: "IPv4",
    protocol: "tcp",
    portRangeMin: 22,
    portRangeMax: 22,
    remoteIpPrefix: "198.51.100.0/24",
    remoteGroupId: "",
    description: "office",
  });
  assertEquals(g.rules[1].protocol, "");
  assertEquals(g.rules[1].portRangeMin, null);
});

// ───── the methods, through createModelTestContext with a stub runner ─────

const M = model.methods;
const SG = SECURITY_GROUP_SHOW;
const ID = SG.id;
const SHOW_ID: [string, { json: unknown }] = [
  `security group show ${ID}`,
  { json: SG },
];

Deno.test("list keeps the named group and writes it", () =>
  withStub([
    ["security group list -c ID", { json: [{ ID }, { ID: "other" }] }],
    SHOW_ID,
    ["security group show other", {
      json: { ...SG, id: "other", name: "web" },
    }],
  ], async (h) => {
    await M.list.execute({ name: "ssh" }, h.context);
    assertEquals(
      h.written().map((w) => [w.spec, w.name, w.data.rules]),
      [[
        "securityGroup",
        "securitygroup-ssh",
        normalizeSecurityGroup(SG).rules,
      ]],
    );
    assertEquals(h.logs().at(-1)?.message, "stored {count} security groups");
  }));

Deno.test("list fails when the CLI does, and writes nothing", () =>
  withStub(
    [["security group list", fail("Unauthorized (HTTP 401)")]],
    async (h) => {
      await assertRejects(
        () => M.list.execute({}, h.context),
        Error,
        "security group list failed (exit 1)",
      );
      assertEquals(h.written(), []);
    },
  ));

Deno.test("get writes the group it reads", () =>
  withStub([["security group show ssh", { json: SG }]], async (h) => {
    await M.get.execute({ securityGroup: "ssh" }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name, w.data.id]), [[
      "securityGroup",
      "securitygroup-ssh",
      ID,
    ]]);
  }));

Deno.test("get fails on a missing group, and writes nothing", () =>
  withStub([["security group show nope", NOT_FOUND]], async (h) => {
    await assertRejects(
      () => M.get.execute({ securityGroup: "nope" }, h.context),
      Error,
      "security group show nope failed",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("create makes a missing group and writes it as shown", () =>
  withStub([
    ["security group show ssh", NOT_FOUND],
    ["security group create --description d --stateless --tag t ssh", {
      json: { id: ID },
    }],
    SHOW_ID,
  ], async (h) => {
    await M.create.execute(
      { name: "ssh", description: "d", stateless: true, tags: ["t"] },
      h.context,
    );
    assertEquals(h.written().map((w) => [w.spec, w.name]), [[
      "securityGroup",
      "securitygroup-ssh",
    ]]);
  }));

Deno.test("create fails when the CLI refuses, and writes nothing", () =>
  withStub([
    ["security group show ssh", NOT_FOUND],
    [
      "security group create",
      fail("Quota exceeded for resources: ['security_group'] (HTTP 409)"),
    ],
  ], async (h) => {
    await assertRejects(
      () => M.create.execute({ name: "ssh", stateless: false }, h.context),
      Error,
      "Quota exceeded",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("update renames, drops the old record and writes the new one", () =>
  withStub([
    ["security group show ssh", { json: SG }],
    [`security group set --name admin ${ID}`, { stdout: "" }],
    [`security group show ${ID}`, { json: { ...SG, name: "admin" } }],
  ], async (h) => {
    await M.update.execute({ securityGroup: "ssh", name: "admin" }, h.context);
    assertEquals(h.deleted(), ["securitygroup-ssh"]);
    assertEquals(h.written().map((w) => w.name), ["securitygroup-admin"]);
  }));

Deno.test("update fails when the set fails, and changes nothing stored", () =>
  withStub([
    ["security group show ssh", { json: SG }],
    ["security group set", fail("Forbidden (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () => M.update.execute({ securityGroup: "ssh", name: "x" }, h.context),
      Error,
      "security group set failed",
    );
    assertEquals(h.deleted(), []);
    assertEquals(h.written(), []);
  }));

Deno.test("delete deletes the group and drops its stored resource", () =>
  withStub([
    ["security group show ssh", { json: SG }],
    [`security group delete ${ID}`, { stdout: "" }],
  ], async (h) => {
    await M.delete.execute({ securityGroup: "ssh" }, h.context);
    assertEquals(h.deleted(), ["securitygroup-ssh"]);
    assertEquals(h.calls.at(-1), `security group delete ${ID}`);
  }));

Deno.test("delete fails on a group in use, and drops nothing", () =>
  withStub([
    ["security group show ssh", { json: SG }],
    ["security group delete", fail("Security Group in use (HTTP 409)")],
  ], async (h) => {
    await assertRejects(
      () => M.delete.execute({ securityGroup: "ssh" }, h.context),
      Error,
      "in use",
    );
    assertEquals(h.deleted(), []);
  }));

Deno.test("addRule creates the rule and stores the group as re-read", () =>
  withStub([
    ["security group show ssh", { json: SG }],
    [
      `security group rule create --ingress --protocol tcp --dst-port 443 --remote-ip 0.0.0.0/0 ${ID}`,
      { json: { id: "r" } },
    ],
    SHOW_ID,
  ], async (h) => {
    await M.addRule.execute({
      securityGroup: "ssh",
      direction: "ingress",
      protocol: "tcp",
      portRange: "443",
      remoteIp: "0.0.0.0/0",
    }, h.context);
    assertEquals(h.written().map((w) => [w.spec, w.name]), [[
      "securityGroup",
      "securitygroup-ssh",
    ]]);
  }));

Deno.test("addRule takes an existing rule as done", () =>
  withStub([
    ["security group show ssh", { json: SG }],
    [
      "security group rule create",
      fail("Security group rule already exists. (HTTP 409)"),
    ],
    SHOW_ID,
  ], async (h) => {
    await M.addRule.execute(
      { securityGroup: "ssh", direction: "ingress" },
      h.context,
    );
    assertEquals(
      h.logs().some((l) =>
        l.message === "rule already exists on security group {name}"
      ),
      true,
    );
    assertEquals(h.written().length, 1);
  }));

Deno.test("addRule fails on any other refusal, and writes nothing", () =>
  withStub([
    ["security group show ssh", { json: SG }],
    ["security group rule create", fail("Bad request (HTTP 400)")],
  ], async (h) => {
    await assertRejects(
      () =>
        M.addRule.execute(
          { securityGroup: "ssh", direction: "egress" },
          h.context,
        ),
      Error,
      "security group rule create failed",
    );
    assertEquals(h.written(), []);
  }));

Deno.test("removeRule deletes the rule and stores the group as re-read", () =>
  withStub([
    ["security group show ssh", { json: SG }],
    ["security group rule delete r1", { stdout: "" }],
    SHOW_ID,
  ], async (h) => {
    await M.removeRule.execute({ securityGroup: "ssh", rule: "r1" }, h.context);
    assertEquals(h.written().map((w) => w.name), ["securitygroup-ssh"]);
  }));

Deno.test("removeRule fails on a refusal other than not found, and writes nothing", () =>
  withStub([
    ["security group show ssh", { json: SG }],
    ["security group rule delete r1", fail("Forbidden (HTTP 403)")],
  ], async (h) => {
    await assertRejects(
      () =>
        M.removeRule.execute({ securityGroup: "ssh", rule: "r1" }, h.context),
      Error,
      "security group rule delete r1 failed",
    );
    assertEquals(h.written(), []);
  }));
