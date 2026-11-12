/** The image every test names. */
export const IMAGE = "registry.example/renovate:44.0.0";

// ---------------------------------------------------------------------------
// Renovate's output
// ---------------------------------------------------------------------------

type Json = Record<string, unknown>;

/** One dependency as Renovate reports it, with what a test changes. */
export function dep(over: Json = {}): Json {
  return {
    depName: "alpine",
    packageName: "alpine",
    currentValue: "3.18.0",
    datasource: "docker",
    depType: "final",
    updates: [],
    versioning: "docker",
    warnings: [],
    currentVersion: "3.18.0",
    ...over,
  };
}

/** One proposed update as Renovate reports it. */
export function update(over: Json = {}): Json {
  return {
    bucket: "non-major",
    newVersion: "3.24.4",
    newValue: "3.24.4",
    releaseTimestamp: "2026-11-08T14:24:43.040Z",
    newVersionAgeInDays: 2,
    newMajor: 3,
    newMinor: 24,
    newPatch: 4,
    updateType: "minor",
    isBreaking: false,
    branchName: "renovate/alpine-3.x",
    ...over,
  };
}

/** The report's entry of one repository, from its dependencies. */
export function repository(deps: Json[], over: Json = {}): Json {
  return {
    problems: [],
    branches: [],
    packageFiles: {
      dockerfile: [{ deps, packageFile: "Dockerfile" }],
    },
    ...over,
  };
}

/**
 * What Renovate 44.226.2 really logs about the repository configuration, one
 * debug run per form, captured in `testdata/config_lines.json`. The reader
 * is tested on these and nothing made up, so a reader that only understands
 * one form fails here as it would live.
 */
export const CONFIG_LINES: {
  renovateVersion: string;
  forms: Record<string, Json[]>;
  none: Json[];
} = JSON.parse(
  Deno.readTextFileSync(
    new URL("./testdata/config_lines.json", import.meta.url),
  ),
);

/** The lines for one form; null is a configuration Renovate did not read. */
export function configLines(form: string | null): Json[] {
  if (form === null) return CONFIG_LINES.none;
  const lines = CONFIG_LINES.forms[form];
  if (lines === undefined) throw new Error(`no captured lines for ${form}`);
  return lines;
}

// ---------------------------------------------------------------------------
// Directories and the method context
// ---------------------------------------------------------------------------

/** A temporary swamp repository root with repository directories in it. */
type Disk = {
  root: string;
  /** Make a directory under the root, with the files named. */
  repo: (name: string, files?: Record<string, string>) => Promise<string>;
};

/** Run `body` with a temporary directory that is removed afterwards. */
export async function withDisk<T>(body: (d: Disk) => Promise<T>): Promise<T> {
  const root = await Deno.realPath(
    await Deno.makeTempDir({ prefix: "renovate-test-" }),
  );
  try {
    return await body({
      root,
      repo: async (name, files = { "renovate.json": "{}" }) => {
        const dir = `${root}/${name}`;
        await Deno.mkdir(dir, { recursive: true });
        for (const [file, content] of Object.entries(files)) {
          const path = `${dir}/${file}`;
          await Deno.mkdir(path.slice(0, path.lastIndexOf("/")), {
            recursive: true,
          });
          await Deno.writeTextFile(path, content);
        }
        return dir;
      },
    });
  } finally {
    await Deno.remove(root, { recursive: true });
  }
}

/**
 * swamp's rule for a data name: it refuses one that holds `..`, `/`, `\\` or
 * a null byte; and a name is a file name, so at most 255 bytes and not empty.
 */
export function storable(name: string): boolean {
  return name !== "" && !/\.\.|[\/\\\0]/.test(name) &&
    new TextEncoder().encode(name).length <= 255;
}
