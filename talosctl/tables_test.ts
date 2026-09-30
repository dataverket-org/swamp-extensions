import { assertEquals } from "jsr:@std/assert@1.0.13";
import {
  columnStarts,
  lineTime,
  parseLogs,
  parsePercent,
  parseSize,
  parseTable,
} from "./tables.ts";

// Recorded from talosctl 1.14 against a three-control-plane cluster through
// Omni, 2026-09-30; trailing blanks are as talosctl prints them.
const ETCD_STATUS =
  "NODE         MEMBER             DB SIZE   IN USE           LEADER             RAFT INDEX   RAFT TERM   RAFT APPLIED INDEX   LEARNER   PROTOCOL   STORAGE   ERRORS\n" +
  "192.0.2.13   0123456789abcdef   30 MB     10 MB (35.30%)   0123456789abcdef   15427147     18          15427147             false     3.7.1      3.7.0     \n" +
  "error from node 192.0.2.44: rpc error: code = Unimplemented desc = etcd status is only available on control plane nodes\n";

const PROCESSES =
  "NODE         PID      STATE   THREADS   CPU-TIME     VIRTMEM   RESMEM   LABEL                                   COMMAND\n" +
  "192.0.2.13   814      S       14        1748564.50   12 GB     128 MB   system_u:system_r:etcd_t:s0             /usr/local/bin/etcd --advertise-client-urls=https://192.0.2.13:2379 --auto-tls=false\n" +
  "192.0.2.13   1        S       18        36535.50     1.5 GB    158 MB   system_u:system_r:init_t:s0             /sbin/init\n";

Deno.test("columnStarts splits on two spaces, not on the one inside a name", () => {
  assertEquals(columnStarts("NODE   DB SIZE   IN USE"), [0, 7, 17]);
});

Deno.test("parseTable reads etcd status cells that hold spaces, and skips node errors", () => {
  const rows = parseTable(ETCD_STATUS);
  assertEquals(rows.length, 1);
  assertEquals(rows[0]["DB SIZE"], "30 MB");
  assertEquals(rows[0]["IN USE"], "10 MB (35.30%)");
  assertEquals(rows[0]["RAFT APPLIED INDEX"], "15427147");
  assertEquals(rows[0]["ERRORS"], "");
});

Deno.test("parseTable gives the last column the rest of the line", () => {
  const rows = parseTable(PROCESSES);
  assertEquals(rows.length, 2);
  assertEquals(rows[0]["VIRTMEM"], "12 GB");
  assertEquals(
    rows[0]["COMMAND"],
    "/usr/local/bin/etcd --advertise-client-urls=https://192.0.2.13:2379 --auto-tls=false",
  );
  assertEquals(rows[1]["LABEL"], "system_u:system_r:init_t:s0");
});

Deno.test("parseSize reads SI and binary units, and rejects the rest", () => {
  assertEquals(parseSize("30 MB"), 30e6);
  assertEquals(parseSize("2.3 GB"), 2.3e9);
  assertEquals(parseSize("10 MB (35.30%)"), 10e6);
  assertEquals(parseSize("1 GiB"), 2 ** 30);
  assertEquals(parseSize(""), undefined);
  assertEquals(parseSize("3 parsecs"), undefined);
  assertEquals(parsePercent("10 MB (35.30%)"), 35.3);
  assertEquals(parsePercent("10 MB"), undefined);
});

Deno.test("parseLogs strips the node prefix and reads both kinds of ts", () => {
  const lines = parseLogs(
    '192.0.2.13: {"level":"warn","ts":"2026-09-30T11:16:14.526388Z","msg":"ignored streaming request; ID mismatch"}\n' +
      '192.0.2.44: {"ts":1790766762840.1804,"msg":"Error syncing pod, skipping"}\n' +
      "192.0.2.44: plain text without a time\n",
  );
  assertEquals(lines.map((l) => l.node), [
    "192.0.2.13",
    "192.0.2.44",
    "192.0.2.44",
  ]);
  assertEquals(lines[0].ts, Date.parse("2026-09-30T11:16:14.526388Z"));
  assertEquals(lines[1].ts, 1790766762840.1804);
  assertEquals(lines[2].ts, undefined);
  assertEquals(lines[2].text, "plain text without a time");
});

Deno.test("lineTime ignores JSON without a usable ts", () => {
  assertEquals(lineTime('{"msg":"x"}'), undefined);
  assertEquals(lineTime('{"ts":"not a time"}'), undefined);
  assertEquals(lineTime("{broken"), undefined);
});
