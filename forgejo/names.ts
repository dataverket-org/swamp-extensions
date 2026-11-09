/**
 * The data names `@dataverket/forgejo` stores records under, and the names
 * the same records had before 2026.11.09.1.
 *
 * A data name becomes a directory name in a filesystem datastore, so it has
 * to hold on Windows too, which refuses `:` and `< > " | ? *` and a trailing
 * dot or space (dataverket-org/swamp-extensions#1, swamp-club/swamp#3205).
 * Until 2026.11.09.1 every record of a repository was named `owner:repo…`,
 * since a Forgejo full name is `owner/repo` and the old `safeName` turned
 * the slash into a colon. A record is now named by a spec word first, then
 * its parts joined with `-`, each part reduced to `[A-Za-z0-9._-]`:
 * `repo-acme-tool`, `pull-acme-tool-12`, `push-mirror-acme-tool-github`.
 * The owner stays in the name, unlike `@dataverket/github`, because one
 * forgejo model spans every organization of the instance.
 *
 * Old data is left where it is. The first time a record is written under
 * its new name while the old one holds data, the run says so once; the
 * README says how to remove the old records.
 *
 * @module
 */

/**
 * One part of a data name: `[A-Za-z0-9._-]`, runs of anything else collapsed
 * to one `-`, no leading or trailing `-`, no trailing dot.
 */
export function slug(part: string | number): string {
  return String(part)
    .replace(/[^A-Za-z0-9._-]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .replace(/\.+$/, "");
}

/**
 * `<word>-<part>-<part>…`, every part through {@link slug}: the shape of
 * `@dataverket/github`'s `repo-<repo>` and `release-<repo>-<tag>`, kept from
 * upstream. Parts may carry `-` themselves, so `acme/corp-x` and
 * `acme-corp/x` read the same, as `release-a-b-c` does upstream; the record's
 * attributes say which it is.
 */
export function dataName(word: string, ...parts: (string | number)[]): string {
  return [word, ...parts.map(slug)].join("-");
}

/**
 * `<word>-<owner>-<repo>…` from a Forgejo full name, `owner/repo`, so a
 * record named from a full name reads the same as one named from its parts.
 * Without a slash the whole string is one part (an id, when the API gave no
 * full name).
 */
export function repoName(
  word: string,
  full: string,
  ...more: (string | number)[]
): string {
  return dataName(word, ...full.split("/"), ...more);
}

/** What the old `safeName` made of a name: `/` and `\` to `:`, `..` to `_`, no NUL. */
export function legacyName(s: string): string {
  return s.replace(/[\\/]/g, ":").replace(/\.\./g, "_").replace(/\0/g, "");
}

/** What `labels.ts`'s old `safeName` made of a name: slashes and whitespace to one `:`. */
export function legacyLabelName(s: string): string {
  return s.replace(/[\\/\s]+/g, ":");
}

/** What `writeRecord` needs of a method context; every module's context has it. */
export interface RecordCtx<H> {
  logger: {
    info(msg: string, props?: Record<string, unknown>): void;
    warning?(msg: string, props?: Record<string, unknown>): void;
    warn?(msg: string, props?: Record<string, unknown>): void;
  };
  writeResource(
    spec: string,
    name: string,
    data: Record<string, unknown>,
  ): Promise<H>;
  /** Absent in some test contexts; swamp always supplies it to a method. */
  readResource?(
    name: string,
    version?: number,
  ): Promise<Record<string, unknown> | null>;
}

/** The latest record under `name`, or null when there is none or it cannot be read. */
export async function readOrNull(
  context: Pick<RecordCtx<unknown>, "readResource">,
  name: string,
): Promise<Record<string, unknown> | null> {
  try {
    return (await context.readResource?.(name)) ?? null;
  } catch {
    // a name Windows cannot store fails at the path, not as "not found"
    return null;
  }
}

/**
 * Writes a record under its portable `name`. The first time one is written
 * under that name while data exists under `legacy`, the pre-2026.11.09.1
 * name, the run says so once: the old data is left as it was and is no
 * longer updated. Nothing is renamed or deleted.
 */
export async function writeRecord<H>(
  context: RecordCtx<H>,
  spec: string,
  name: string,
  legacy: string,
  data: Record<string, unknown>,
): Promise<H> {
  if (context.readResource && legacy !== name) {
    const [fresh, old] = await Promise.all([
      readOrNull(context, name),
      readOrNull(context, legacy),
    ]);
    if (fresh === null && old !== null) {
      (context.logger.warning ?? context.logger.warn ?? context.logger.info)
        .call(
          context.logger,
          "Data under the old name {legacy} is left as it was and is no longer updated; " +
            "this record and later ones are {name}. README.md, Data names, says how to remove the old data.",
          { legacy, name },
        );
    }
  }
  return await context.writeResource(spec, name, data);
}
