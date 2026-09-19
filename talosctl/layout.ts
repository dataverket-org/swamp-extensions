/**
 * `@dataverket/talosctl` — what is on a Talos machine's disks, from three
 * `talosctl` reads: `get disks`, `get discoveredvolumes` and `usage /var`.
 * Pure parsing and shaping; no I/O. The `omni` extension in this repository
 * carries an identical copy (`omni/talos_layout.ts`), kept in sync by hand,
 * because each extension is packaged from its own directory.
 *
 * @module
 */
import { z } from "npm:zod@4";

/** A physical or virtual disk (loop devices and CD-ROMs are dropped). */
export const DiskSchema = z.object({
  devPath: z.string(),
  sizeBytes: z.number(),
  transport: z.string().describe("virtio, nvme, ata, ..."),
  rotational: z.boolean(),
  systemDisk: z.boolean().describe("True for the disk holding STATE"),
  serial: z.string().optional(),
  model: z.string().optional(),
});

/** A GPT partition Talos discovered, by label. */
export const PartitionSchema = z.object({
  devPath: z.string(),
  parentDevPath: z.string(),
  index: z.number().int(),
  label: z.string().describe(
    "Partition label: EPHEMERAL, STATE, u-<name>, ...",
  ),
  filesystem: z.string().describe("Probed filesystem, or empty"),
  sizeBytes: z.number(),
});

/** One machine's disks, partitions and EPHEMERAL usage. */
export const VolumeLayoutSchema = z.object({
  hostname: z.string(),
  node: z.string().describe("Node address the data was read from"),
  disks: z.array(DiskSchema),
  partitions: z.array(PartitionSchema),
  systemDisk: z.string().describe("Device path of the disk holding STATE"),
  systemDiskSizeBytes: z.number(),
  systemDiskUnallocatedBytes: z.number().describe(
    "Bytes on the system disk not covered by any partition",
  ),
  ephemeralSizeBytes: z.number(),
  ephemeralUsedBytes: z.number().describe("Bytes used under /var"),
  ephemeralUsedPercent: z.number(),
  ephemeralLibBytes: z.number().describe("/var/lib: images, kubelet, etcd"),
  ephemeralLogBytes: z.number(),
  userVolumes: z.array(z.string()).describe("Names of u-<name> partitions"),
  timestamp: z.string(),
});
/** {@link VolumeLayoutSchema} */
export type VolumeLayout = z.infer<typeof VolumeLayoutSchema>;

/** A record as `talosctl get -o json` prints it, one per resource. */
export interface TalosRecord {
  metadata: { id: string; [k: string]: unknown };
  node?: string;
  spec: Record<string, unknown>;
}

/**
 * Parse concatenated pretty-printed JSON objects (`talosctl get -o json`
 * prints one object per resource with no array wrapper). A leading `[` is
 * accepted as a single array for forward compatibility.
 */
export function parseConcatJson(text: string): TalosRecord[] {
  const t = text.trim();
  if (t === "") return [];
  if (t.startsWith("[")) return JSON.parse(t) as TalosRecord[];
  const out: TalosRecord[] = [];
  let depth = 0, start = -1, inStr = false, esc = false;
  for (let i = 0; i < t.length; i++) {
    const c = t[i];
    if (inStr) {
      if (esc) esc = false;
      else if (c === "\\") esc = true;
      else if (c === '"') inStr = false;
      continue;
    }
    if (c === '"') inStr = true;
    else if (c === "{") {
      if (depth === 0) start = i;
      depth++;
    } else if (c === "}") {
      depth--;
      if (depth === 0 && start >= 0) {
        out.push(JSON.parse(t.slice(start, i + 1)) as TalosRecord);
        start = -1;
      } else if (depth < 0) throw new Error("unbalanced JSON output");
    }
  }
  if (depth !== 0) throw new Error("unbalanced JSON output");
  return out;
}

/** Per-node bytes from `usage -d 1 /var`: total, `lib` and `log`. */
export interface Usage {
  total: number;
  lib: number;
  log: number;
}

/**
 * Parse `talosctl usage -d 1 /var`. With several nodes the table has a NODE
 * column; with one it may not, in which case rows are keyed by `single`.
 */
export function parseUsage(
  text: string,
  single = "",
): Record<string, Usage> {
  const res: Record<string, Usage> = {};
  for (const line of text.split("\n")) {
    const cols = line.trim().split(/\s+/);
    let node: string, size: string, name: string;
    if (cols.length === 3) [node, size, name] = cols;
    else if (cols.length === 2) [size, name] = cols, node = single;
    else continue;
    if (size === "SIZE") continue;
    const n = Number(size);
    if (!Number.isFinite(n)) continue;
    res[node] ??= { total: 0, lib: 0, log: 0 };
    if (name === ".") res[node].total = n;
    else if (name === "lib") res[node].lib = n;
    else if (name === "log") res[node].log = n;
  }
  return res;
}

/** Records for one node, from a multi-node read. */
export function forNode(records: TalosRecord[], node: string): TalosRecord[] {
  return records.filter((r) => r.node === node);
}

/** Shape one node's disks, discovered volumes and usage into its layout. */
export function buildLayout(
  hostname: string,
  node: string,
  disks: TalosRecord[],
  volumes: TalosRecord[],
  usage: Usage | undefined,
  timestamp: string,
): VolumeLayout {
  const partitions: z.infer<typeof PartitionSchema>[] = volumes
    .filter((v) => v.spec.partition_label !== undefined)
    .map((v) => ({
      devPath: String(v.spec.dev_path),
      parentDevPath: String(v.spec.parent_dev_path ?? ""),
      index: Number(v.spec.partition_index ?? 0),
      label: String(v.spec.partition_label),
      filesystem: String(v.spec.name ?? ""),
      sizeBytes: Number(v.spec.size ?? 0),
    }))
    .sort((a, b) =>
      a.parentDevPath.localeCompare(b.parentDevPath) || a.index - b.index
    );
  const systemDisk = partitions.find((p) => p.label === "STATE")
    ?.parentDevPath ?? "";
  const ds: z.infer<typeof DiskSchema>[] = disks
    .filter((d) =>
      !String(d.spec.dev_path).startsWith("/dev/loop") && d.spec.cdrom !== true
    )
    .map((d) => ({
      devPath: String(d.spec.dev_path),
      sizeBytes: Number(d.spec.size ?? 0),
      transport: String(d.spec.transport ?? ""),
      rotational: d.spec.rotational === true,
      systemDisk: String(d.spec.dev_path) === systemDisk,
      serial: d.spec.serial ? String(d.spec.serial) : undefined,
      model: d.spec.model ? String(d.spec.model) : undefined,
    }))
    .sort((a, b) => a.devPath.localeCompare(b.devPath));
  const systemDiskSizeBytes = ds.find((d) => d.systemDisk)?.sizeBytes ?? 0;
  const allocated = partitions
    .filter((p) => p.parentDevPath === systemDisk)
    .reduce((s, p) => s + p.sizeBytes, 0);
  const ephemeralSizeBytes =
    partitions.find((p) => p.label === "EPHEMERAL")?.sizeBytes ?? 0;
  const used = usage?.total ?? 0;
  return {
    hostname,
    node,
    disks: ds,
    partitions,
    systemDisk,
    systemDiskSizeBytes,
    systemDiskUnallocatedBytes: Math.max(0, systemDiskSizeBytes - allocated),
    ephemeralSizeBytes,
    ephemeralUsedBytes: used,
    ephemeralUsedPercent: ephemeralSizeBytes > 0
      ? Math.round((used / ephemeralSizeBytes) * 1000) / 10
      : 0,
    ephemeralLibBytes: usage?.lib ?? 0,
    ephemeralLogBytes: usage?.log ?? 0,
    userVolumes: partitions
      .filter((p) => p.label.startsWith("u-"))
      .map((p) => p.label.slice(2)),
    timestamp,
  };
}

/** Hostname of a node from its `get hostname -o json` record, or the address. */
export function hostnameOf(records: TalosRecord[], node: string): string {
  const r = forNode(records, node)[0];
  const h = r?.spec.hostname;
  return typeof h === "string" && h !== "" ? h : node;
}
