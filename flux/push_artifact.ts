/**
 * Adds to `@dataverket/flux/source` the producer side of an OCIRepository:
 * `push_artifact`, a directory pushed as an OCI artifact with
 * `flux push artifact`, reproducibly, with the source and revision Flux shows
 * on the object that pulls it, and an optional `release.json` written into a
 * copy of the directory first. The reference and digest flux prints are
 * recorded, so what is signed, promoted or verified later is the artifact as
 * pushed, never a tag that can move.
 *
 * An extension file rather than a method in `source.ts`: that file is
 * upstream's, kept close to `@ginger_pappa/flux` so the fork stays
 * comparable, and `reset.ts` set the precedent of adding this package's own
 * methods beside it. `flux` is run by name from PATH as the other files run
 * it, without the model's kubeconfig and context, which a registry push does
 * not use; registry credentials are flux's own, the container config of the
 * user running swamp.
 *
 * @module
 */
import { z } from "npm:zod@4.6.7";
import { brief } from "../lib/cli.ts";
import {
  FLUX_TIMEOUTS,
  fluxCliCheck,
  type FluxContext,
  runFlux,
  storedUrl,
} from "./_helpers.ts";

/** `push_artifact`'s arguments. */
export const PushArtifactArgsSchema = z.object({
  path: z.string().min(1).describe(
    "The directory to push, absolute or relative to the repository root",
  ),
  target: z.string().default("").describe(
    "Where to push, oci://<repository>:<tag>; or give repository and tag",
  ),
  repository: z.string().default("").describe(
    "The repository, <registry>/<path>, when target is not given",
  ),
  tag: z.string().default("").describe("The tag, when target is not given"),
  source: z.string().min(1).describe(
    "The source address Flux shows for the artifact, such as the Git URL; flux's --source",
  ),
  revision: z.string().min(1).describe(
    "The source revision, <branch|tag>@sha1:<commit>; flux's --revision",
  ),
  metadata: z.record(z.string(), z.unknown()).optional().describe(
    "Written as release.json into a copy of the directory before the push; the directory itself is untouched",
  ),
  annotations: z.array(z.string()).default([]).describe(
    "OCI annotations on the artifact, key=value",
  ),
  insecureRegistry: z.boolean().default(false).describe(
    "Push to a registry served over plain HTTP, flux's --insecure-registry",
  ),
});

/** The arguments as the method receives them. */
export type PushArtifactArgs = z.infer<typeof PushArtifactArgsSchema>;

/** One artifact pushed: where it went and what it is. */
export const ArtifactSchema = z.object({
  /** The artifact by digest, `<repository>@sha256:<hex>`, the form cosign signs. */
  ref: z.string(),
  /** The same as flux printed it, `oci://<repository>@sha256:<hex>`. */
  url: z.string(),
  repository: z.string(),
  tag: z.string(),
  digest: z.string(),
  /** The directory that was pushed, absolute. */
  path: z.string(),
  /** Whether metadata was written as release.json into the pushed copy. */
  releaseJson: z.boolean(),
  source: z.string(),
  revision: z.string(),
  annotations: z.record(z.string(), z.string()),
  reproducible: z.boolean(),
  pushedAt: z.string(),
});

/** One stored artifact record. */
export type ArtifactData = z.infer<typeof ArtifactSchema>;

const TAG = /^[A-Za-z0-9_][A-Za-z0-9_.-]{0,127}$/;
const TARGET = /^oci:\/\/(.+):([A-Za-z0-9_][A-Za-z0-9_.-]{0,127})$/;
const DIGEST = /^sha256:[0-9a-f]{64}$/;
const ANNOTATION = /^[^=\s]+=[^\n]*$/;

/** The repository and tag a push goes to, or why the arguments do not name one. */
export function parseTarget(
  a: { target: string; repository: string; tag: string },
): { repository: string; tag: string } | string {
  if (a.target !== "") {
    if (a.repository !== "" || a.tag !== "") {
      return "target, or repository and tag, not both";
    }
    if (a.target.includes("@")) {
      return `${a.target} names a digest; a push names a tag, and the digest is what comes back`;
    }
    const m = a.target.match(TARGET);
    if (!m || m[1].includes("@") || /\s/.test(m[1]) || !m[1].includes("/")) {
      return `${a.target} is not oci://<repository>:<tag>`;
    }
    return { repository: m[1], tag: m[2] };
  }
  if (a.repository === "" || a.tag === "") {
    return "target, or repository and tag, is required";
  }
  if (/[\s@]/.test(a.repository) || !a.repository.includes("/")) {
    return `repository ${
      JSON.stringify(a.repository)
    } is not <registry>/<path>`;
  }
  if (!TAG.test(a.tag)) {
    return `tag ${JSON.stringify(a.tag)} is not an OCI tag`;
  }
  return { repository: a.repository, tag: a.tag };
}

/** The exact `flux` argument list; pure so a test can pin it. */
export function pushArgs(a: {
  repository: string;
  tag: string;
  path: string;
  source: string;
  revision: string;
  annotations: string[];
  insecureRegistry: boolean;
}): string[] {
  const args = [
    "push",
    "artifact",
    `oci://${a.repository}:${a.tag}`,
    "--path",
    a.path,
    "--source",
    a.source,
    "--revision",
    a.revision,
    "--reproducible",
    "--output",
    "json",
  ];
  for (const ann of a.annotations) args.push("--annotations", ann);
  if (a.insecureRegistry) args.push("--insecure-registry");
  return args;
}

/** What `flux push artifact --output json` printed, or why it cannot be used. */
export function parsePushOutput(
  text: string,
): { url: string; repository: string; tag: string; digest: string } {
  let parsed: Record<string, unknown>;
  try {
    parsed = JSON.parse(text);
  } catch {
    throw new Error(
      `flux push artifact did not print JSON: ${brief(text, 120) || "(empty)"}`,
    );
  }
  const digest = String(parsed.digest ?? "");
  if (!DIGEST.test(digest)) {
    throw new Error(
      `flux push artifact printed no sha256 digest: ${
        brief(JSON.stringify(parsed), 120)
      }`,
    );
  }
  return {
    url: String(parsed.url ?? ""),
    repository: String(parsed.repository ?? ""),
    tag: String(parsed.tag ?? ""),
    digest,
  };
}

/** `key=value` pairs as a record; a later key wins. */
export function annotationRecord(
  annotations: string[],
): Record<string, string> {
  const out: Record<string, string> = {};
  for (const a of annotations) {
    const i = a.indexOf("=");
    out[a.slice(0, i)] = a.slice(i + 1);
  }
  return out;
}

/** Makes `path` absolute against `root` when it is relative. */
export function absolute(root: string, path: string): string {
  if (path.startsWith("/")) return path;
  return `${root.replace(/\/+$/, "")}/${path.replace(/^\.\/+/, "")}`;
}

/**
 * Copies the regular files and directories of a tree. Anything else, a
 * symbolic link, a FIFO, a socket or a device, is not copied and its path is
 * added to `skipped`: `flux push artifact` leaves such entries out of the
 * artifact itself, and opening a FIFO would wait forever. The copy stops
 * between two entries when the run is cancelled.
 */
/**
 * What the copy does with one directory entry: only a directory and a
 * regular file are copied. A FIFO, a socket and a device are none of the
 * three things Deno names, and a link is not followed.
 */
export function copyKind(
  entry: { isFile: boolean; isDirectory: boolean; isSymlink: boolean },
): "directory" | "file" | "skip" {
  if (entry.isSymlink) return "skip";
  return entry.isDirectory ? "directory" : entry.isFile ? "file" : "skip";
}

async function copyDir(
  src: string,
  dst: string,
  signal: AbortSignal | undefined,
  skipped: string[],
  prefix = "",
): Promise<void> {
  for await (const entry of Deno.readDir(src)) {
    if (signal?.aborted) {
      throw new Error(
        "push_artifact was cancelled while copying the directory",
      );
    }
    const from = `${src}/${entry.name}`;
    const to = `${dst}/${entry.name}`;
    const kind = copyKind(entry);
    if (kind === "directory") {
      await Deno.mkdir(to);
      await copyDir(from, to, signal, skipped, `${prefix}${entry.name}/`);
    } else if (kind === "file") {
      await Deno.copyFile(from, to);
    } else {
      skipped.push(`${prefix}${entry.name}`);
    }
  }
}

/**
 * The data name of an artifact record: `<repository>:<tag>` with every
 * character that is not a letter, a digit, `.` or `-` written as `_` and
 * its two hex digits, so `/` is `_2f`, `:` is `_3a` and `_` is `_5f`. Two
 * different targets never share a name, and the name is a file name
 * everywhere.
 */
export function instanceName(repository: string, tag: string): string {
  return `${repository}:${tag}`.replace(
    /[^A-Za-z0-9.-]/g,
    (c) =>
      [...new TextEncoder().encode(c)].map((b) =>
        `_${b.toString(16).padStart(2, "0")}`
      ).join(""),
  );
}

/**
 * The longest data name, in bytes. swamp sets no limit of its own: the name
 * becomes a directory name in the data store, and a file name holds 255
 * bytes on the common file systems. A longer name fails when the record is
 * written, which is after flux has pushed.
 */
export const MAX_DATA_NAME_BYTES = 255;

/** The context `push_artifact` reads: the three types' context plus the repository root. */
export interface PushContext extends FluxContext<ArtifactData> {
  repoDir: string;
}

/** Adds `push_artifact` and the flux CLI check to `@dataverket/flux/source`. */
export const extension = {
  type: "@dataverket/flux/source",
  checks: [{
    "flux-cli-available": {
      ...fluxCliCheck,
      appliesTo: ["push_artifact"],
    },
  }],
  resources: {
    artifact: {
      description:
        "One directory pushed as an OCI artifact: repository, tag, the digest flux printed, source and revision, annotations",
      schema: ArtifactSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: [{
    push_artifact: {
      description:
        "Push a directory as an OCI artifact with flux push artifact, reproducibly, with release.json from metadata written into a copy first; records the reference and digest",
      arguments: PushArtifactArgsSchema,
      execute: async (
        args: PushArtifactArgs,
        context: PushContext,
      ): Promise<{ dataHandles: unknown[] }> => {
        const target = parseTarget(args);
        if (typeof target === "string") throw new Error(target);
        for (const a of args.annotations) {
          if (!ANNOTATION.test(a)) {
            throw new Error(`annotation ${JSON.stringify(a)} is not key=value`);
          }
        }
        // Before anything is copied or pushed: a name the data store cannot
        // hold would lose the record of a digest that is already uploaded.
        const dataName = instanceName(target.repository, target.tag);
        if (dataName.length > MAX_DATA_NAME_BYTES) {
          throw new Error(
            `the record of oci://${
              brief(`${target.repository}:${target.tag}`, 80)
            } would be stored under a name of ${dataName.length} bytes, more than the ${MAX_DATA_NAME_BYTES} a data name can be; nothing was pushed, use a shorter repository or tag`,
          );
        }
        const path = absolute(context.repoDir, args.path);
        let stat: Deno.FileInfo;
        try {
          stat = await Deno.stat(path);
        } catch {
          throw new Error(`${path} cannot be read`);
        }
        if (!stat.isDirectory) throw new Error(`${path} is not a directory`);

        let pushed = path;
        let scratch: string | undefined;
        try {
          if (args.metadata !== undefined) {
            // Inside the try: a copy that fails half way is removed too.
            scratch = await Deno.makeTempDir({ prefix: "flux-push-artifact-" });
            pushed = `${scratch}/artifact`;
            await Deno.mkdir(pushed);
            const skipped: string[] = [];
            await copyDir(path, pushed, context.signal, skipped);
            if (skipped.length > 0) {
              context.logger.info(
                "Not copied, because they are neither files nor directories; flux leaves them out of an artifact too: {skipped}",
                { skipped: skipped.sort().join(", ") },
              );
            }
            await Deno.writeTextFile(
              `${pushed}/release.json`,
              JSON.stringify(args.metadata, null, 2) + "\n",
            );
            context.logger.info("release.json written into a copy of {path}", {
              path,
            });
          }
          context.logger.info("Pushing {path} to oci://{repository}:{tag}", {
            path,
            repository: target.repository,
            tag: target.tag,
          });
          const out = await runFlux(
            pushArgs({
              ...target,
              path: pushed,
              source: args.source,
              revision: args.revision,
              annotations: args.annotations,
              insecureRegistry: args.insecureRegistry,
            }),
            { signal: context.signal },
            FLUX_TIMEOUTS.push,
          );
          const printed = parsePushOutput(out);
          const record: ArtifactData = {
            ref: `${target.repository}@${printed.digest}`,
            url: printed.url,
            repository: target.repository,
            tag: target.tag,
            digest: printed.digest,
            path,
            releaseJson: scratch !== undefined,
            source: storedUrl(args.source),
            revision: args.revision,
            annotations: annotationRecord(args.annotations),
            reproducible: true,
            pushedAt: new Date().toISOString(),
          };
          const handle = await context.writeResource(
            "artifact",
            dataName,
            record,
          );
          context.logger.info("Pushed {ref}", { ref: record.ref });
          return { dataHandles: [handle] };
        } finally {
          if (scratch) await Deno.remove(scratch, { recursive: true });
        }
      },
    },
  }],
};
