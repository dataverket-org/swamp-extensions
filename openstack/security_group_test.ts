import { assertEquals } from "jsr:@std/assert@1.0.13";
import { model, normalizeSecurityGroup } from "./security_group.ts";
import { idRows, SECURITY_GROUP_SHOW } from "./fixtures.ts";
import {
  fail,
  installFake,
  line,
  makeContext,
  notFound,
} from "./test_support.ts";

const ID = SECURITY_GROUP_SHOW.id;

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

Deno.test("list fans out and filters by exact name client-side", async () => {
  const other = {
    ...SECURITY_GROUP_SHOW,
    id: "45938ba2-1902-4fa7-926e-37f0f4556002",
    name: "default",
  };
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "security group list -c ID") return idRows(ID, other.id);
    if (l === `security group show ${ID}`) return SECURITY_GROUP_SHOW;
    if (l === `security group show ${other.id}`) return other;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({ name: "default" }, context);
    assertEquals(written.map((w) => w.name), ["securitygroup-default"]);
  } finally {
    fake.restore();
  }
});

Deno.test("create builds flags, reuses an existing group", async () => {
  let created = false;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "security group show ssh") {
      return created ? SECURITY_GROUP_SHOW : notFound("security group", "ssh");
    }
    if (
      l ===
        "security group create --description ssh from the office --stateless --tag t ssh"
    ) {
      created = true;
      return SECURITY_GROUP_SHOW;
    }
    if (l === `security group show ${ID}`) return SECURITY_GROUP_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "ssh",
      description: "ssh from the office",
      stateless: true,
      tags: ["t"],
    }, context);
    await model.methods.create.execute(
      { name: "ssh", stateless: false },
      context,
    );
    assertEquals(written.length, 2);
    assertEquals(fake.calls.length, 4);
  } finally {
    fake.restore();
  }
});

Deno.test("addRule builds the rule create invocation and tolerates an existing identical rule", async () => {
  let attempts = 0;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "security group show ssh" || l === `security group show ${ID}`) {
      return SECURITY_GROUP_SHOW;
    }
    if (
      l ===
        `security group rule create --ingress --protocol tcp --dst-port 22 --remote-ip 198.51.100.0/24 --description office ${ID}`
    ) {
      attempts++;
      return attempts === 1 ? SECURITY_GROUP_SHOW.rules[0] : fail(
        "ConflictException: 409: Client Error for url: https://neutron.example.net/v2.0/security-group-rules, Security group rule already exists. Rule id is 2a57f453-55e5-427d-9103-d17ebf52a9bf.",
      );
    }
    return undefined;
  });
  const { context, written, logs } = makeContext();
  try {
    const rule = {
      securityGroup: "ssh",
      direction: "ingress" as const,
      protocol: "tcp",
      portRange: "22",
      remoteIp: "198.51.100.0/24",
      description: "office",
    };
    await model.methods.addRule.execute(rule, context);
    await model.methods.addRule.execute(rule, context);
    assertEquals(attempts, 2);
    assertEquals(written.length, 2);
    assertEquals(
      logs.filter((l) => l.message.includes("already exists")).length,
      1,
    );
  } finally {
    fake.restore();
  }
});

Deno.test("removeRule tolerates a rule that is already gone", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "security group show ssh" || l === `security group show ${ID}`) {
      return SECURITY_GROUP_SHOW;
    }
    if (l === "security group rule delete gone") {
      return fail("No SecurityGroupRule found for gone");
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.removeRule.execute({
      securityGroup: "ssh",
      rule: "gone",
    }, context);
    assertEquals(written.length, 1);
  } finally {
    fake.restore();
  }
});

Deno.test("delete drops the stored group", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "security group show ssh") return SECURITY_GROUP_SHOW;
    if (l === `security group delete ${ID}`) return "";
    return undefined;
  });
  const { context, deleted } = makeContext();
  try {
    await model.methods.delete.execute({ securityGroup: "ssh" }, context);
    assertEquals(deleted, ["securitygroup-ssh"]);
  } finally {
    fake.restore();
  }
});
