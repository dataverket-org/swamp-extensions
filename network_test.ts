import { assertEquals } from "jsr:@std/assert@1.0.13";
import { model, normalizeNetwork } from "./network.ts";
import {
  EXT_NET,
  idRows,
  NETWORK_EXTERNAL,
  NETWORK_SHOW,
  PRIV_NET,
} from "./fixtures.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

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

Deno.test("list --external fans out and stores network-<name>", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "network list -c ID --external") return idRows(EXT_NET);
    if (l === `network show ${EXT_NET}`) return NETWORK_EXTERNAL;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute({ external: true }, context);
    assertEquals(written.map((w) => w.name), ["network-ext-net"]);
    assertEquals(written[0].data.external, true);
  } finally {
    fake.restore();
  }
});

Deno.test("create builds flags and reuses an existing network", async () => {
  let created = false;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "network show private-net") {
      return created ? NETWORK_SHOW : notFound("network", "private-net");
    }
    if (
      l ===
        "network create --description lan --no-share --enable-port-security --mtu 1442 private-net"
    ) {
      created = true;
      return NETWORK_SHOW;
    }
    if (l === `network show ${PRIV_NET}`) return NETWORK_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "private-net",
      description: "lan",
      shared: false,
      portSecurity: true,
      mtu: 1442,
    }, context);
    await model.methods.create.execute({ name: "private-net" }, context);
    assertEquals(written.length, 2);
    assertEquals(fake.calls.length, 4);
  } finally {
    fake.restore();
  }
});

Deno.test("update renames via network set and drops the old instance", async () => {
  let renamed = false;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "network show private-net") return NETWORK_SHOW;
    if (l === `network set --name lan ${PRIV_NET}`) {
      renamed = true;
      return "";
    }
    if (l === `network show ${PRIV_NET}`) {
      return renamed ? { ...NETWORK_SHOW, name: "lan" } : NETWORK_SHOW;
    }
    return undefined;
  });
  const { context, written, deleted } = makeContext();
  try {
    await model.methods.update.execute(
      { network: "private-net", name: "lan" },
      context,
    );
    assertEquals(deleted, ["network-private-net"]);
    assertEquals(written[0].name, "network-lan");
  } finally {
    fake.restore();
  }
});

Deno.test("delete is idempotent and drops the resource", async () => {
  let present = true;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "network show private-net") {
      return present ? NETWORK_SHOW : notFound("network", "private-net");
    }
    if (l === `network delete ${PRIV_NET}`) {
      present = false;
      return "";
    }
    return undefined;
  });
  const { context, deleted } = makeContext();
  try {
    await model.methods.delete.execute({ network: "private-net" }, context);
    await model.methods.delete.execute({ network: "private-net" }, context);
    assertEquals(deleted, ["network-private-net"]);
  } finally {
    fake.restore();
  }
});
