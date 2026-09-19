import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  buildLayout,
  parseConcatJson,
  parseUsage,
  type TalosRecord,
} from "./layout.ts";

Deno.test("parseConcatJson splits concatenated objects and keeps node", () => {
  const rs = parseConcatJson(
    `{\n "metadata": {"id": "a"}, "node": "10.0.0.1", "spec": {"x": "{"}\n}\n{"metadata": {"id": "b"}, "spec": {}}`,
  );
  assertEquals(rs.map((r) => r.metadata.id), ["a", "b"]);
  assertEquals(rs[0].node, "10.0.0.1");
  assertEquals(parseConcatJson("  "), []);
});

Deno.test("parseUsage reads multi-node and single-node tables", () => {
  const multi = parseUsage(
    "NODE         SIZE         NAME\n10.0.0.129   1229582341   lib\n10.0.0.129   40816889     log\n10.0.0.129   9293         system\n10.0.0.129   1270408591   .\n",
  );
  assertEquals(multi["10.0.0.129"], {
    total: 1270408591,
    lib: 1229582341,
    log: 40816889,
  });
  const single = parseUsage("SIZE  NAME\n100  lib\n5  log\n120  .\n", "n1");
  assertEquals(single["n1"], { total: 120, lib: 100, log: 5 });
});

Deno.test("buildLayout computes unallocated space and EPHEMERAL usage", () => {
  const GiB = 2 ** 30, MiB = 2 ** 20;
  const disks: TalosRecord[] = [
    { metadata: { id: "loop0" }, spec: { dev_path: "/dev/loop0", size: 4096 } },
    {
      metadata: { id: "vda" },
      spec: {
        dev_path: "/dev/vda",
        size: 30 * GiB,
        transport: "virtio",
        rotational: true,
      },
    },
    {
      metadata: { id: "vdb" },
      spec: { dev_path: "/dev/vdb", size: 20 * GiB, transport: "virtio" },
    },
  ];
  const part = (dev: string, i: number, label: string, size: number) => ({
    metadata: { id: dev },
    spec: {
      dev_path: `/dev/${dev}`,
      parent_dev_path: "/dev/vda",
      partition_index: i,
      partition_label: label,
      name: "xfs",
      size,
    },
  });
  const vols: TalosRecord[] = [
    {
      metadata: { id: "vda" },
      spec: { dev_path: "/dev/vda", size: 30 * GiB, type: "disk" },
    },
    part("vda5", 5, "EPHEMERAL", 14 * GiB),
    part("vda1", 1, "STATE", 100 * MiB),
    part("vda3", 3, "BOOT", 2000 * MiB),
    part("vda6", 6, "u-pg", 8 * GiB),
  ];
  const l = buildLayout(
    "wrkr-1",
    "10.0.0.3",
    disks,
    vols,
    { total: 7 * GiB, lib: 6 * GiB, log: 1 * GiB },
    "t",
  );
  assertEquals(l.systemDisk, "/dev/vda");
  assertEquals(l.disks.map((d) => [d.devPath, d.systemDisk]), [
    ["/dev/vda", true],
    ["/dev/vdb", false],
  ]);
  assertEquals(l.partitions.map((p) => p.label), [
    "STATE",
    "BOOT",
    "EPHEMERAL",
    "u-pg",
  ]);
  assertEquals(
    l.systemDiskUnallocatedBytes,
    30 * GiB - (14 * GiB + 100 * MiB + 2000 * MiB + 8 * GiB),
  );
  assertEquals(l.ephemeralUsedPercent, 50);
  assertEquals(l.userVolumes, ["pg"]);
});
