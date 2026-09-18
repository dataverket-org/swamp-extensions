import { assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizePort } from "./port.ts";
import { idRows, PORT_SHOW } from "./fixtures.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

const ID = PORT_SHOW.id;

Deno.test("normalizePort flattens fixed IPs and allowed address pairs", () => {
  const p = normalizePort(PORT_SHOW);
  assertEquals(p.name, "web-01-eth0");
  assertEquals(p.fixedIps, [{
    subnetId: "e1e8839f-8154-40d8-84d3-38c01020b27e",
    ipAddress: "192.0.2.10",
  }]);
  assertEquals(p.ipAddresses, ["192.0.2.10"]);
  assertEquals(p.deviceId, "55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8");
  assertEquals(p.allowedAddressPairs, [{
    ipAddress: "192.0.2.198",
    macAddress: "fa:16:3e:6c:83:8c",
  }]);
  assertEquals(p.securityGroupIds, ["0ae8b48c-7db0-4903-ba95-5a2a081ea6c9"]);
});

Deno.test("an unnamed port is stored under its id", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "port list -c ID --server web-01") return idRows(ID);
    if (l === `port show ${ID}`) return { ...PORT_SHOW, name: "" };
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({ server: "web-01" }, context);
    assertEquals(written[0].name, `port-${ID}`);
  } finally {
    fake.restore();
  }
});

Deno.test("create passes fixed IPs, security groups and allowed addresses", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "port show web-01-eth0") return notFound("port", "web-01-eth0");
    if (
      l ===
        "port create --network private-net --fixed-ip subnet=private-subnet,ip-address=192.0.2.10 --security-group ssh --enable-port-security --allowed-address ip-address=192.0.2.198 web-01-eth0"
    ) return PORT_SHOW;
    if (l === `port show ${ID}`) return PORT_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "web-01-eth0",
      network: "private-net",
      fixedIps: [{ subnet: "private-subnet", ipAddress: "192.0.2.10" }],
      securityGroups: ["ssh"],
      portSecurity: true,
      allowedAddresses: [{ ipAddress: "192.0.2.198" }],
    }, context);
    assertEquals(written[0].name, "port-web-01-eth0");
  } finally {
    fake.restore();
  }
});

Deno.test("create with an empty security group list means no security group", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "port show lb-vip") return notFound("port", "lb-vip");
    if (
      l ===
        "port create --network private-net --no-security-group --disable-port-security lb-vip"
    ) return PORT_SHOW;
    if (l === `port show ${ID}`) return PORT_SHOW;
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.create.execute({
      name: "lb-vip",
      network: "private-net",
      securityGroups: [],
      portSecurity: false,
    }, context);
  } finally {
    fake.restore();
  }
});

Deno.test("create rejects a fixedIp with neither subnet nor address, and comma-carrying values", async () => {
  const fake = installFake((
    args,
  ) => (line({ args, env: {} }) === "port show p"
    ? notFound("port", "p")
    : undefined)
  );
  const { context } = makeContext();
  try {
    await assertRejects(
      () =>
        model.methods.create.execute({
          name: "p",
          network: "n",
          fixedIps: [{}],
        }, context),
      Error,
      "needs a subnet or an ipAddress",
    );
    await assertRejects(
      () =>
        model.methods.create.execute({
          name: "p",
          network: "n",
          fixedIps: [{ ipAddress: "1,2" }],
        }, context),
      Error,
      "must not contain a comma",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("update replaces security groups and allowed addresses by clearing first", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `port show ${ID}`) return PORT_SHOW;
    if (
      l ===
        `port set --no-security-group --security-group a --security-group b --no-allowed-address ${ID}`
    ) return "";
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.update.execute({
      port: ID,
      securityGroups: ["a", "b"],
      allowedAddresses: [],
    }, context);
    assertEquals(fake.calls.length, 3);
  } finally {
    fake.restore();
  }
});

Deno.test("delete drops the resource", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `port show ${ID}`) return PORT_SHOW;
    if (l === `port delete ${ID}`) return "";
    return undefined;
  });
  const { context, deleted } = makeContext();
  try {
    await model.methods.delete.execute({ port: ID }, context);
    assertEquals(deleted, ["port-web-01-eth0"]);
  } finally {
    fake.restore();
  }
});
