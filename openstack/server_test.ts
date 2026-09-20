import { assert, assertEquals, assertRejects } from "jsr:@std/assert@1.0.13";
import { model, normalizeServer, parseNameId } from "./server.ts";
import {
  idRows,
  NETWORK_SHOW,
  PORT_SHOW,
  PRIV_NET,
  SERVER_SHOW,
  SERVER_SHOW_2,
} from "./fixtures.ts";
import { installFake, line, makeContext, notFound } from "./test_support.ts";

const ID = SERVER_SHOW.id;
const ID2 = SERVER_SHOW_2.id;

Deno.test("normalizeServer shapes the 10.3.0 server show output", () => {
  const s = normalizeServer(SERVER_SHOW);
  assertEquals(s.id, ID);
  assertEquals(s.name, "web-01");
  assertEquals(s.status, "ACTIVE");
  assertEquals(s.powerState, "RUNNING");
  assertEquals(s.vmState, "active");
  assertEquals(s.taskState, "");
  assertEquals(s.availabilityZone, "zone-a");
  assertEquals(
    s.hostId,
    "5576ffc29a3b73a627059d86980f0b8eb70b0cdde14516f63cda4668",
  );
  assertEquals(s.addresses, { "private-net": ["192.0.2.10", "203.0.113.20"] });
  assertEquals(s.ipAddresses, ["192.0.2.10", "203.0.113.20"]);
  assertEquals(s.imageName, "Debian GNU/Linux 13 (Trixie)");
  assertEquals(s.imageId, "5021ee7c-1bcb-49b5-9f96-d477611b29d5");
  assertEquals(s.flavorName, "m5.medium");
  assertEquals(s.vcpus, 1);
  assertEquals(s.ramMb, 4096);
  assertEquals(s.diskGb, 25);
  assertEquals(s.keyName, "ops-key");
  assertEquals(s.securityGroups, ["ssh", "default"]);
  assertEquals(s.volumesAttached, ["7f84cddf-5cfd-45a9-9048-6026b41c5a45"]);
  assertEquals(s.properties, { role: "web" });
  assertEquals(s.tags, ["web"]);
  assertEquals(s.locked, false);
  assertEquals(s.launchedAt, "2026-09-15T10:28:21.000000");
  const stopped = normalizeServer(SERVER_SHOW_2);
  assertEquals(stopped.powerState, "SHUTDOWN");
  assertEquals(stopped.imageName, "N/A (booted from volume)");
  assertEquals(stopped.imageId, "");
});

Deno.test("parseNameId handles objects, name (uuid) strings and plain names", () => {
  assertEquals(parseNameId({ name: "a", id: "b" }), { name: "a", id: "b" });
  assertEquals(parseNameId("m5 (5021ee7c-1bcb-49b5-9f96-d477611b29d5)"), {
    name: "m5",
    id: "5021ee7c-1bcb-49b5-9f96-d477611b29d5",
  });
  assertEquals(parseNameId("m5.medium"), { name: "m5.medium", id: "" });
});

Deno.test("list fans out show per id with the configured concurrency and stores each server", async () => {
  const shows: Record<string, unknown> = {
    [ID]: SERVER_SHOW,
    [ID2]: SERVER_SHOW_2,
  };
  const fake = installFake((args) => {
    const l = args.join(" ");
    if (l === "server list -c ID --status ACTIVE") return idRows(ID, ID2);
    if (args[0] === "server" && args[1] === "show") return shows[args[2]];
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    const r = await model.methods.list.execute({ status: "ACTIVE" }, context);
    assertEquals(r.dataHandles.length, 2);
    assertEquals(written.map((w) => w.name), ["server-web-01", "server-db-01"]);
    assertEquals(written[0].spec, "server");
    assertEquals(fake.calls.length, 3);
  } finally {
    fake.restore();
  }
});

Deno.test("list suffixes duplicate names with the id instead of overwriting", async () => {
  const dup = { ...SERVER_SHOW_2, name: "web-01" };
  const fake = installFake((args) => {
    if (line({ args, env: {} }) === "server list -c ID") return idRows(ID, ID2);
    if (args[1] === "show") return args[2] === ID ? SERVER_SHOW : dup;
    return undefined;
  });
  const { context, written, logs } = makeContext();
  try {
    await model.methods.list.execute({}, context);
    assertEquals(written.map((w) => w.name), [
      "server-web-01",
      `server-web-01-${ID2.slice(0, 8)}`,
    ]);
    assert(logs.some((l) => l.level === "warning"));
  } finally {
    fake.restore();
  }
});

Deno.test("create reuses an existing server of the same name without creating", async () => {
  const fake = installFake((args) => {
    if (line({ args, env: {} }) === "server show web-01") return SERVER_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "web-01",
      flavor: "m5.medium",
      image: "debian-13",
      networks: ["private-net"],
      wait: true,
    }, context);
    assertEquals(fake.calls.length, 1);
    assertEquals(written[0].name, "server-web-01");
  } finally {
    fake.restore();
  }
});

Deno.test("create builds the CLI invocation, passes user-data via a private temp file and re-reads the server", async () => {
  let userDataPath = "";
  let userDataContent = "";
  const fake = installFake((args) => {
    const l = args.join(" ");
    if (l === "server show web-01") return notFound("server", "web-01");
    if (args[0] === "server" && args[1] === "create") {
      userDataPath = args[args.indexOf("--user-data") + 1];
      userDataContent = Deno.readTextFileSync(userDataPath);
      return { ...SERVER_SHOW, status: "BUILD" };
    }
    if (l === `server show ${ID}`) return SERVER_SHOW;
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.create.execute({
      name: "web-01",
      flavor: "m5.medium",
      image: "debian-13",
      networks: ["private-net", "other-net"],
      keyName: "ops-key",
      securityGroups: ["ssh"],
      userData: "#cloud-config\n",
      serverGroup: "web-spread",
      properties: { role: "web" },
      tags: ["web"],
      wait: true,
    }, context);
    const create = fake.calls[1].args;
    assertEquals(create.slice(0, 4), [
      "server",
      "create",
      "--flavor",
      "m5.medium",
    ]);
    assert(create.includes("--image") && create.includes("debian-13"));
    assertEquals(create.filter((a) => a === "--network").length, 2);
    assert(create.includes("--key-name"));
    assert(create.includes("--server-group"));
    assert(create.includes("role=web"));
    assert(create.includes("--wait"));
    assertEquals(create.at(-1), "web-01");
    assertEquals(userDataContent, "#cloud-config\n");
    await assertRejects(() => Deno.stat(userDataPath), Deno.errors.NotFound);
    assertEquals(written[0].data.status, "ACTIVE");
  } finally {
    fake.restore();
  }
});

Deno.test("create resolves nic names to ids and serialises nics, block devices, config drive and hints", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "server show db-01") return notFound("server", "db-01");
    if (l === "network show private-net") return NETWORK_SHOW;
    if (l === "port show web-01-eth0") return PORT_SHOW;
    if (args[0] === "server" && args[1] === "create") return SERVER_SHOW_2;
    if (l === `server show ${ID2}`) return SERVER_SHOW_2;
    return undefined;
  });
  const { context } = makeContext();
  try {
    await model.methods.create.execute({
      name: "db-01",
      flavor: "m5.large",
      nics: [{ network: "private-net", fixedIpV4: "192.0.2.11" }, {
        port: "web-01-eth0",
      }],
      blockDevices: [
        {
          sourceType: "image",
          destinationType: "volume",
          uuid: "5021ee7c-1bcb-49b5-9f96-d477611b29d5",
          volumeSizeGb: 40,
          bootIndex: 0,
          deleteOnTermination: true,
        },
        { sourceType: "blank", destinationType: "volume", volumeSizeGb: 100 },
      ],
      configDrive: true,
      hints: { different_host: ID },
      wait: false,
    }, context);
    const create = fake.calls.find((c) => c.args[1] === "create")!.args;
    const nics = create.filter((_, i) => create[i - 1] === "--nic");
    assertEquals(nics, [
      `net-id=${PRIV_NET},v4-fixed-ip=192.0.2.11`,
      `port-id=${PORT_SHOW.id}`,
    ]);
    const bds = create.filter((_, i) => create[i - 1] === "--block-device");
    assertEquals(bds, [
      "uuid=5021ee7c-1bcb-49b5-9f96-d477611b29d5,source_type=image,destination_type=volume,volume_size=40,boot_index=0,delete_on_termination=true",
      "source_type=blank,destination_type=volume,volume_size=100",
    ]);
    assert(create.includes("--use-config-drive"));
    assert(
      create.includes("--hint") && create.includes(`different_host=${ID}`),
    );
    assert(!create.includes("--wait"));
  } finally {
    fake.restore();
  }
});

Deno.test("create needs a NIC source and a boot source", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      model.methods.create.execute({
        name: "x",
        flavor: "f",
        image: "i",
        wait: true,
      }, context),
    Error,
    "at least one of networks, ports or nics",
  );
  await assertRejects(
    () =>
      model.methods.create.execute({
        name: "x",
        flavor: "f",
        networks: ["n"],
        nics: [{}],
        wait: true,
      }, context),
    Error,
    "image, a volume or a boot-index-0",
  );
});

Deno.test("attachInterface and detachInterface use server add/remove port|network", async () => {
  const fake = installFake((args) => {
    const l = line({ args, env: {} });
    if (l === "server show web-01" || l === `server show ${ID}`) {
      return SERVER_SHOW;
    }
    if (l === `server add network --tag data ${ID} private-net`) return "";
    if (l === `server add port ${ID} web-01-eth0`) return "";
    if (l === `server remove port ${ID} web-01-eth0`) return "";
    if (l === `server remove network ${ID} private-net`) return "";
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.attachInterface.execute({
      server: "web-01",
      network: "private-net",
      tag: "data",
    }, context);
    await model.methods.attachInterface.execute({
      server: "web-01",
      port: "web-01-eth0",
    }, context);
    await model.methods.detachInterface.execute({
      server: "web-01",
      port: "web-01-eth0",
    }, context);
    await model.methods.detachInterface.execute({
      server: "web-01",
      network: "private-net",
    }, context);
    assertEquals(written.length, 4);
    await assertRejects(
      () =>
        model.methods.attachInterface.execute({ server: "web-01" }, context),
      Error,
      "exactly one",
    );
  } finally {
    fake.restore();
  }
});

Deno.test("create refuses a server with neither image nor volume", async () => {
  const { context } = makeContext();
  await assertRejects(
    () =>
      model.methods.create.execute(
        { name: "x", flavor: "f", networks: ["n"], wait: true },
        context,
      ),
    Error,
    "image, a volume or a boot-index-0",
  );
});

Deno.test("delete is a no-op when the server is already gone", async () => {
  const fake = installFake(() => notFound("server", "ghost"));
  const { context, deleted } = makeContext();
  try {
    const r = await model.methods.delete.execute({
      server: "ghost",
      force: false,
      wait: true,
    }, context);
    assertEquals(r.dataHandles, []);
    assertEquals(deleted, []);
    assertEquals(fake.calls.length, 1);
  } finally {
    fake.restore();
  }
});

Deno.test("delete resolves the server, deletes by id with --wait and drops the stored resource", async () => {
  const fake = installFake((args) => {
    const l = args.join(" ");
    if (l === "server show web-01") return SERVER_SHOW;
    if (l === `server delete --wait ${ID}`) return "";
    return undefined;
  });
  const { context, deleted } = makeContext();
  try {
    await model.methods.delete.execute({
      server: "web-01",
      force: false,
      wait: true,
    }, context);
    assertEquals(deleted, ["server-web-01"]);
  } finally {
    fake.restore();
  }
});

Deno.test("update renames through server set and drops the old instance name", async () => {
  let renamed = false;
  const fake = installFake((args) => {
    const l = args.join(" ");
    if (l === "server show web-01") return SERVER_SHOW;
    if (l === `server set --name web-02 --property role=api ${ID}`) {
      renamed = true;
      return "";
    }
    if (l === `server unset --property old ${ID}`) return "";
    if (l === `server show ${ID}`) {
      return renamed ? { ...SERVER_SHOW, name: "web-02" } : SERVER_SHOW;
    }
    return undefined;
  });
  const { context, written, deleted } = makeContext();
  try {
    await model.methods.update.execute({
      server: "web-01",
      name: "web-02",
      properties: { role: "api" },
      removeProperties: ["old"],
    }, context);
    assertEquals(deleted, ["server-web-01"]);
    assertEquals(written[0].name, "server-web-02");
  } finally {
    fake.restore();
  }
});

Deno.test("start, stop and reboot act by id and store the refreshed server", async () => {
  const fake = installFake((args) => {
    const l = args.join(" ");
    if (l === "server show web-01" || l === `server show ${ID}`) {
      return SERVER_SHOW;
    }
    if (
      [
        `server start ${ID}`,
        `server stop ${ID}`,
        `server reboot --hard --wait ${ID}`,
      ].includes(l)
    ) return "";
    return undefined;
  });
  const { context, written } = makeContext();
  try {
    await model.methods.start.execute({ server: "web-01" }, context);
    await model.methods.stop.execute({ server: "web-01" }, context);
    await model.methods.reboot.execute({
      server: "web-01",
      hard: true,
      wait: true,
    }, context);
    assertEquals(written.length, 3);
    assertEquals(fake.calls.map(line).filter((l) => !l.includes("show")), [
      `server start ${ID}`,
      `server stop ${ID}`,
      `server reboot --hard --wait ${ID}`,
    ]);
  } finally {
    fake.restore();
  }
});

Deno.test("targets that look like flags are rejected before reaching the CLI", async () => {
  const fake = installFake(() => undefined);
  const { context } = makeContext();
  try {
    await assertRejects(
      () => model.methods.get.execute({ server: "--all-projects" }, context),
      Error,
      'must not start with "-"',
    );
    assertEquals(fake.calls.length, 0);
  } finally {
    fake.restore();
  }
});
