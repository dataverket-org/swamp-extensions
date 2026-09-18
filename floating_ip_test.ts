import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeFloatingIp } from "./floating_ip.ts";
import {
  EXT_NET,
  FLOATING_IP_FREE,
  FLOATING_IP_SHOW,
  idRows,
  PORT_SHOW,
} from "./fixtures.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

const ID = FLOATING_IP_SHOW.id;
const ADDR = FLOATING_IP_SHOW.floating_ip_address;

Deno.test("normalizeFloatingIp exposes the binding through port details", () => {
  const ip = normalizeFloatingIp(FLOATING_IP_SHOW);
  assertEquals(ip.address, ADDR);
  assertEquals(ip.name, ADDR);
  assertEquals(ip.fixedIpAddress, "192.0.2.10");
  assertEquals(ip.attachedDeviceId, "55c8c0b6-59c6-44fe-bd83-0ea42ecd98e8");
  assertEquals(ip.attachedDeviceOwner, "compute:nova");
  assertEquals(ip.status, "ACTIVE");
  const free = normalizeFloatingIp(FLOATING_IP_FREE);
  assertEquals(free.portId, "");
  assertEquals(free.fixedIpAddress, "");
  assertEquals(free.attachedDeviceId, "");
});

Deno.test("list filters by network and status and stores under floatingip-<address>", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `floating ip list -c ID --network ${EXT_NET} --status DOWN`) {
      return idRows(FLOATING_IP_FREE.id);
    }
    if (l === `floating ip show ${FLOATING_IP_FREE.id}`) {
      return FLOATING_IP_FREE;
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.list.execute(
      { network: EXT_NET, status: "DOWN" },
      context,
    );
    assertEquals(written.map((w) => w.name), ["floatingip-203-0-113-21"]);
  } finally {
    fake.restore();
  }
});

Deno.test("allocate reuses an IP on the network that already carries the description", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "floating ip list -c ID --network ext-net") {
      return idRows(ID, FLOATING_IP_FREE.id);
    }
    if (l === `floating ip show ${ID}`) return FLOATING_IP_SHOW;
    if (l === `floating ip show ${FLOATING_IP_FREE.id}`) {
      return FLOATING_IP_FREE;
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.allocate.execute({
      network: "ext-net",
      description: "web-01 public",
    }, context);
    assertEquals(written.map((w) => w.name), ["floatingip-203-0-113-20"]);
    assert(!fake.calls.some((c) => line(c).startsWith("floating ip create")));
  } finally {
    fake.restore();
  }
});

Deno.test("allocate creates a new IP with description and tags, then re-reads it", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "floating ip list -c ID --network ext-net") return [];
    if (l === "floating ip create --description fresh --tag t ext-net") {
      return { ...FLOATING_IP_FREE, description: "fresh" };
    }
    if (l === `floating ip show ${FLOATING_IP_FREE.id}`) {
      return { ...FLOATING_IP_FREE, description: "fresh" };
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.allocate.execute({
      network: "ext-net",
      description: "fresh",
      tags: ["t"],
    }, context);
    assertEquals(written[0].data.description, "fresh");
  } finally {
    fake.restore();
  }
});

Deno.test("allocate with a requested address reuses it when already allocated", async () => {
  const fake = installFake((args) => {
    if (line({ args, env: {} }) === `floating ip show ${ADDR}`) {
      return FLOATING_IP_SHOW;
    }
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.allocate.execute(
      { network: "ext-net", address: ADDR },
      context,
    );
    assertEquals(written.length, 1);
    assertEquals(fake.calls.length, 1);
  } finally {
    fake.restore();
  }
});

Deno.test("bind resolves an ID to its address for server add floating ip", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `floating ip show ${ID}`) return FLOATING_IP_SHOW;
    if (
      l ===
        `server add floating ip --fixed-ip-address 192.0.2.10 web-01 ${ADDR}`
    ) return "";
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.bind.execute({
      floatingIp: ID,
      server: "web-01",
      fixedIpAddress: "192.0.2.10",
    }, context);
    assertEquals(fake.calls.length, 3);
    assertEquals(written[0].data.attachedDeviceOwner, "compute:nova");
  } finally {
    fake.restore();
  }
});

Deno.test("unbind is a no-op for a free IP and otherwise removes it from the server", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `floating ip show ${FLOATING_IP_FREE.floating_ip_address}`) {
      return FLOATING_IP_FREE;
    }
    if (l === `floating ip show ${ADDR}`) return FLOATING_IP_SHOW;
    if (l === `floating ip show ${ID}`) return FLOATING_IP_FREE;
    if (l === `server remove floating ip web-01 ${ADDR}`) return "";
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.unbind.execute({
      floatingIp: FLOATING_IP_FREE.floating_ip_address,
      server: "web-01",
    }, context);
    assertEquals(fake.calls.length, 1);
    await model.methods.unbind.execute(
      { floatingIp: ADDR, server: "web-01" },
      context,
    );
    assertEquals(fake.calls.length, 4);
    assertEquals(written.length, 2);
  } finally {
    fake.restore();
  }
});

Deno.test("release is idempotent, warns when still bound, and drops the resource", async () => {
  let present = true;
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `floating ip show ${ADDR}`) {
      return present ? FLOATING_IP_SHOW : notFound("floating ip", ADDR);
    }
    if (l === `floating ip delete ${ID}`) {
      present = false;
      return "";
    }
    return undefined;
  });
  const { context, deleted, logs } = makeContext();
  try {
    await model.methods.release.execute({ floatingIp: ADDR }, context);
    await model.methods.release.execute({ floatingIp: ADDR }, context);
    assertEquals(deleted, ["floatingip-203-0-113-20"]);
    assert(
      logs.some((l) =>
        l.level === "warning" && l.message.includes("still bound")
      ),
    );
  } finally {
    fake.restore();
  }
});

Deno.test("bind to a port resolves the port name and uses floating ip set --port", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `floating ip show ${FLOATING_IP_FREE.id}`) {
      return fake.calls.length > 3 ? FLOATING_IP_SHOW : FLOATING_IP_FREE;
    }
    if (l === "port show lb-vip") return PORT_SHOW;
    if (
      l ===
        `floating ip set --port ${PORT_SHOW.id} --fixed-ip-address 192.0.2.10 ${FLOATING_IP_FREE.id}`
    ) return "";
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.bind.execute({
      floatingIp: FLOATING_IP_FREE.id,
      port: "lb-vip",
      fixedIpAddress: "192.0.2.10",
    }, context);
    assertEquals(
      fake.calls.map(line)[2],
      `floating ip set --port ${PORT_SHOW.id} --fixed-ip-address 192.0.2.10 ${FLOATING_IP_FREE.id}`,
    );
    assertEquals(written.length, 1);
  } finally {
    fake.restore();
  }
});

Deno.test("bind to the port already holding the IP is a no-op; server and port together are rejected", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `floating ip show ${ID}`) return FLOATING_IP_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.bind.execute({
      floatingIp: ID,
      port: FLOATING_IP_SHOW.port_id,
    }, context);
    assertEquals(fake.calls.length, 1);
    assertEquals(written.length, 1);
    await assertRejects(
      () =>
        model.methods.bind.execute(
          { floatingIp: ID, port: "p", server: "s" },
          context,
        ),
      Error,
      "exactly one",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("unbind without a server disassociates whatever port holds the IP", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === `floating ip show ${ADDR}`) return FLOATING_IP_SHOW;
    if (l === `floating ip show ${ID}`) return FLOATING_IP_FREE;
    if (l === `floating ip unset --port ${ID}`) return "";
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.unbind.execute({ floatingIp: ADDR }, context);
    assertEquals(fake.calls.map(line)[1], `floating ip unset --port ${ID}`);
    assertEquals(written[0].data.portId, "");
  } finally {
    fake.restore();
  }
});
