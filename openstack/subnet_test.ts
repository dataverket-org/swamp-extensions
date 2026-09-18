import { assertEquals } from "jsr:@std/assert@1.0.13";
import { model, normalizeSubnet } from "./subnet.ts";
import { idRows, SUBNET_SHOW } from "./fixtures.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

const ID = SUBNET_SHOW.id;

Deno.test("normalizeSubnet keeps pools, DNS servers and host routes", () => {
  const s = normalizeSubnet(SUBNET_SHOW);
  assertEquals(s.cidr, "192.0.2.0/24");
  assertEquals(s.ipVersion, 4);
  assertEquals(s.gatewayIp, "192.0.2.1");
  assertEquals(s.enableDhcp, true);
  assertEquals(s.allocationPools, [{
    start: "192.0.2.100",
    end: "192.0.2.200",
  }]);
  assertEquals(s.dnsNameservers, ["198.51.100.53", "198.51.100.54"]);
  assertEquals(s.hostRoutes, [{
    destination: "203.0.113.0/24",
    nexthop: "192.0.2.254",
  }]);
});

Deno.test("list filters by network and stores subnet-<name>", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "subnet list -c ID --network private-net --ip-version 4") {
      return idRows(ID);
    }
    if (l === `subnet show ${ID}`) return SUBNET_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute(
      { network: "private-net", ipVersion: 4 },
      context,
    );
    assertEquals(written.map((w) => w.name), ["subnet-private-subnet"]);
  } finally {
    fake.restore();
  }
});

Deno.test("create passes range, gateway, pools, DNS and routes as structured flags", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "subnet show private-subnet") {
      return notFound("subnet", "private-subnet");
    }
    if (
      l ===
        "subnet create --network private-net --subnet-range 192.0.2.0/24 --ip-version 4 --dhcp --gateway 192.0.2.1 --dns-nameserver 198.51.100.53 --allocation-pool start=192.0.2.100,end=192.0.2.200 --host-route destination=203.0.113.0/24,gateway=192.0.2.254 private-subnet"
    ) return SUBNET_SHOW;
    if (l === `subnet show ${ID}`) return SUBNET_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "private-subnet",
      network: "private-net",
      cidr: "192.0.2.0/24",
      ipVersion: 4,
      gateway: "192.0.2.1",
      dhcp: true,
      dnsNameservers: ["198.51.100.53"],
      allocationPools: [{ start: "192.0.2.100", end: "192.0.2.200" }],
      hostRoutes: [{ destination: "203.0.113.0/24", nexthop: "192.0.2.254" }],
    }, context);
    assertEquals(written.length, 1);
  } finally {
    fake.restore();
  }
});

Deno.test("update replaces DNS servers by clearing first", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `subnet show ${ID}`) return SUBNET_SHOW;
    if (
      l ===
        `subnet set --no-dhcp --no-dns-nameservers --dns-nameserver 198.51.100.1 ${ID}`
    ) return "";
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.update.execute({
      subnet: ID,
      dhcp: false,
      dnsNameservers: ["198.51.100.1"],
    }, context);
    assertEquals(fake.calls.length, 3);
  } finally {
    fake.restore();
  }
});

Deno.test("delete drops the resource", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `subnet show ${ID}`) return SUBNET_SHOW;
    if (l === `subnet delete ${ID}`) return "";
    return undefined;
  });
  const { context, deleted } = makeContext();
  try {
    await model.methods.delete.execute({ subnet: ID }, context);
    assertEquals(deleted, ["subnet-private-subnet"]);
  } finally {
    fake.restore();
  }
});
