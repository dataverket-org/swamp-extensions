/**
 * `@dataverket/talosctl` — parsers for talosctl's table and log output.
 *
 * Some talosctl commands have no JSON output (`etcd status`, `processes`), and
 * their cells hold single spaces (`31 MB`, `10 MB (34.20%)`), so a row cannot
 * be split on whitespace. The header can: talosctl aligns columns with at
 * least two spaces, and a column starts where a header name does. `logs`
 * prefixes every line with its node, and most Talos services log JSON with a
 * `ts` field, as an RFC 3339 string or as epoch milliseconds.
 *
 * @module
 */

/** Start offsets of each column, read from a header line. */
export function columnStarts(header: string): number[] {
  const starts: number[] = [];
  for (let i = 0; i < header.length; i++) {
    if (header[i] === " ") continue;
    if (i === 0 || (header[i - 1] === " " && header[i - 2] === " ")) {
      starts.push(i);
    }
  }
  return starts;
}

/**
 * Parse an aligned talosctl table into rows keyed by header name. The
 * `error from node ...` lines talosctl mixes in are skipped; the last column
 * runs to the end of the line.
 */
export function parseTable(stdout: string): Record<string, string>[] {
  const lines = stdout.split("\n").filter((l) => l.trim() !== "");
  if (lines.length === 0) return [];
  const header = lines[0];
  const starts = columnStarts(header);
  const names = starts.map((s, i) =>
    header.slice(s, i + 1 < starts.length ? starts[i + 1] : undefined).trim()
  );
  const rows: Record<string, string>[] = [];
  for (const line of lines.slice(1)) {
    if (line.startsWith("error from node")) continue;
    const row: Record<string, string> = {};
    starts.forEach((s, i) => {
      const end = i + 1 < starts.length ? starts[i + 1] : undefined;
      row[names[i]] = line.slice(s, end).trim();
    });
    rows.push(row);
  }
  return rows;
}

const UNITS: Record<string, number> = {
  B: 1,
  kB: 1e3,
  KB: 1e3,
  MB: 1e6,
  GB: 1e9,
  TB: 1e12,
  KiB: 2 ** 10,
  MiB: 2 ** 20,
  GiB: 2 ** 30,
  TiB: 2 ** 40,
};

/**
 * Bytes from a humanized size such as `31 MB` or `2.3 GB` (talosctl prints SI
 * units); undefined when the text is not a size.
 */
export function parseSize(text: string): number | undefined {
  const m = text.trim().match(/^([0-9.]+)\s*([A-Za-z]+)/);
  if (!m) return undefined;
  const unit = UNITS[m[2]];
  const n = Number(m[1]);
  if (unit === undefined || !Number.isFinite(n)) return undefined;
  return Math.round(n * unit);
}

/** The percentage in `10 MB (34.20%)`; undefined without one. */
export function parsePercent(text: string): number | undefined {
  const m = text.match(/\(([0-9.]+)%\)/);
  return m ? Number(m[1]) : undefined;
}

/** One line of `talosctl logs`, without its node prefix. */
export interface LogLine {
  node: string;
  text: string;
  /** Epoch milliseconds from the line's own `ts`, when it has one. */
  ts?: number;
}

/** The epoch milliseconds of a JSON log line's `ts`, if it has one. */
export function lineTime(text: string): number | undefined {
  if (!text.startsWith("{")) return undefined;
  let ts: unknown;
  try {
    ts = (JSON.parse(text) as Record<string, unknown>).ts;
  } catch {
    return undefined;
  }
  if (typeof ts === "number" && Number.isFinite(ts)) return ts;
  if (typeof ts === "string") {
    const t = Date.parse(ts);
    return Number.isNaN(t) ? undefined : t;
  }
  return undefined;
}

/** Split `talosctl logs` output into lines with their node and time. */
export function parseLogs(stdout: string): LogLine[] {
  const out: LogLine[] = [];
  for (const raw of stdout.split("\n")) {
    if (raw.trim() === "") continue;
    const m = raw.match(/^([^\s:]+|\[[^\]]+\]):\s(.*)$/);
    const node = m ? m[1] : "";
    const text = m ? m[2] : raw;
    out.push({ node, text, ts: lineTime(text) });
  }
  return out;
}

/** CPU-TIME as talosctl prints it, seconds with a fraction. */
export function parseSeconds(text: string): number | undefined {
  const n = Number(text.trim());
  return text.trim() !== "" && Number.isFinite(n) ? n : undefined;
}
