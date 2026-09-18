/**
 * `@dataverket/openstack/image` — Glance images through the `openstack`
 * CLI: discover, upload, update metadata and delete images.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { openstack, openstackJson } from "./cli.ts";
import {
  assertArg,
  assertList,
  assertShow,
  bool,
  checks,
  cliOptions,
  type DataHandle,
  GlobalArgsSchema,
  instanceName,
  listThenShow,
  type MethodResult,
  type ModelContext,
  num,
  propertyFlags,
  type Raw,
  repeatFlag,
  showRaw,
  showRawOrNull,
  str,
  strList,
  strRecord,
  writeAll,
} from "./common.ts";

const KIND = ["image"];
const PREFIX = "image";

// Glance surfaces a few well-known keys inside `properties`; they get their
// own fields and are left out of the free-form `properties` record.
const LIFTED = new Set([
  "os_distro",
  "os_version",
  "architecture",
  "os_hidden",
  "locations",
  "direct_url",
  "description",
]);

/** One Glance image as written to the `image` spec. */
export const ImageSchema = z.object({
  id: z.string(),
  name: z.string(),
  status: z.string().describe("active, queued, saving, deactivated, ..."),
  visibility: z.string().describe("public, private, shared or community"),
  diskFormat: z.string(),
  containerFormat: z.string(),
  sizeBytes: z.number(),
  minDiskGb: z.number(),
  minRamMb: z.number(),
  checksum: z.string(),
  protected: z.boolean(),
  hidden: z.boolean(),
  owner: z.string().describe("Owning project id"),
  osDistro: z.string(),
  osVersion: z.string(),
  architecture: z.string(),
  description: z.string(),
  properties: z.record(z.string(), z.string()).describe(
    "Custom properties (well-known ones are lifted into their own fields)",
  ),
  tags: z.array(z.string()),
  createdAt: z.string(),
  updatedAt: z.string(),
});
/** {@link ImageSchema} */
export type Image = z.infer<typeof ImageSchema>;

/** Shape a raw `image show` object into an {@link Image}. */
export function normalizeImage(raw: Raw): Image {
  const props = strRecord(raw.properties);
  const custom: Record<string, string> = {};
  for (const [k, v] of Object.entries(props)) if (!LIFTED.has(k)) custom[k] = v;
  return {
    id: str(raw.id),
    name: str(raw.name),
    status: str(raw.status),
    visibility: str(raw.visibility),
    diskFormat: str(raw.disk_format),
    containerFormat: str(raw.container_format),
    sizeBytes: num(raw.size),
    minDiskGb: num(raw.min_disk),
    minRamMb: num(raw.min_ram),
    checksum: str(raw.checksum),
    protected: bool(raw.protected),
    hidden: bool(props.os_hidden),
    owner: str(raw.owner),
    osDistro: props.os_distro ?? "",
    osVersion: props.os_version ?? "",
    architecture: props.architecture ?? "",
    description: props.description ?? "",
    properties: custom,
    tags: strList(raw.tags),
    createdAt: str(raw.created_at),
    updatedAt: str(raw.updated_at),
  };
}

async function writeImage(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "image", PREFIX, [normalizeImage(raw)]);
}

const Visibility = z.enum(["public", "private", "shared", "community"]);
const DiskFormat = z.enum([
  "raw",
  "qcow2",
  "iso",
  "vmdk",
  "vhd",
  "vhdx",
  "vdi",
  "ploop",
  "ami",
  "ari",
  "aki",
]);
const Target = z.string().min(1).describe("Image name or ID");

const ListArgs = z.object({
  name: z.string().optional().describe("Exact name filter"),
  visibility: z.enum(["public", "private", "shared", "community", "all"])
    .optional().describe("Limit to one visibility, or all"),
  status: z.string().optional(),
});
const GetArgs = z.object({ image: Target });
const CreateArgs = z.object({
  name: z.string().min(1).describe("Image name; reused if it already exists"),
  file: z.string().min(1).describe(
    "Local image file to upload; relative paths resolve against the repository",
  ),
  diskFormat: DiskFormat.default("qcow2"),
  containerFormat: z.string().default("bare"),
  minDiskGb: z.number().int().nonnegative().optional(),
  minRamMb: z.number().int().nonnegative().optional(),
  visibility: Visibility.optional(),
  protected: z.boolean().optional(),
  properties: z.record(z.string(), z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
const UpdateArgs = z.object({
  image: Target,
  name: z.string().optional(),
  minDiskGb: z.number().int().nonnegative().optional(),
  minRamMb: z.number().int().nonnegative().optional(),
  visibility: Visibility.optional(),
  protected: z.boolean().optional(),
  properties: z.record(z.string(), z.string()).optional(),
  tags: z.array(z.string()).optional(),
});
const DeleteArgs = z.object({ image: Target });
const FindArgs = z.object({
  name: z.string().optional().describe("Exact name (server-side filter)"),
  nameRegex: z.string().optional().describe(
    "Regular expression on the name (client-side)",
  ),
  tags: z.array(z.string()).optional().describe("Every tag must be present"),
  properties: z.record(z.string(), z.string()).optional().describe(
    "Property values that must match, e.g. os_distro=debian",
  ),
  visibility: z.enum(["public", "private", "shared", "community", "all"])
    .optional(),
  status: z.string().default("active"),
});

/** Find images by exact name, as `[{ID, Name}]` rows. */
async function findByName(context: ModelContext, name: string): Promise<Raw[]> {
  return assertList(
    await openstackJson(
      cliOptions(context.globalArgs),
      [
        "image",
        "list",
        "-c",
        "ID",
        "-c",
        "Name",
        "--name",
        assertArg(name, "name"),
      ],
      context.signal,
    ),
    "image list",
  );
}

/** Glance image model. */
export const model = {
  type: "@dataverket/openstack/image",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    image: {
      description:
        "A Glance image: format, size, visibility, OS metadata and tags",
      schema: ImageSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "Discover images visible to the project and store each one",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const filters: string[] = [];
        if (args.name) filters.push("--name", assertArg(args.name, "name"));
        if (args.visibility === "all") filters.push("--all");
        else if (args.visibility) filters.push(`--${args.visibility}`);
        if (args.status) {
          filters.push("--status", assertArg(args.status, "status"));
        }
        context.logger.info("listing images");
        const images = (await listThenShow(context, KIND, filters)).map(
          normalizeImage,
        );
        const handles = await writeAll(context, "image", PREFIX, images);
        context.logger.info("stored {count} images", { count: images.length });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one image by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading image {image}", { image: args.image });
        return {
          dataHandles: await writeImage(
            context,
            await showRaw(context, KIND, args.image),
          ),
        };
      },
    },
    create: {
      description:
        "Upload a local file as a new image; an existing image of the same name is reused",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await findByName(context, args.name);
        if (existing.length > 0) {
          const id = str(existing[0].ID);
          context.logger.info("image {name} already exists as {id}; reusing", {
            name: args.name,
            id,
          });
          return {
            dataHandles: await writeImage(
              context,
              await showRaw(context, KIND, id),
            ),
          };
        }
        const file = args.file.startsWith("/")
          ? args.file
          : `${context.repoDir ?? Deno.cwd()}/${args.file}`;
        await Deno.stat(file).catch(() => {
          throw new Error(`image file not found: ${file}`);
        });
        const cli = [
          "image",
          "create",
          "--file",
          file,
          "--disk-format",
          args.diskFormat,
          "--container-format",
          assertArg(args.containerFormat, "containerFormat"),
        ];
        if (args.minDiskGb !== undefined) {
          cli.push("--min-disk", String(args.minDiskGb));
        }
        if (args.minRamMb !== undefined) {
          cli.push("--min-ram", String(args.minRamMb));
        }
        if (args.visibility) cli.push(`--${args.visibility}`);
        if (args.protected !== undefined) {
          cli.push(args.protected ? "--protected" : "--unprotected");
        }
        cli.push(...propertyFlags("--property", args.properties));
        cli.push(...repeatFlag("--tag", args.tags, "tag"));
        context.logger.info("uploading {file} as image {name}", {
          file,
          name: args.name,
        });
        const created = assertShow(
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            args.name,
          ], context.signal),
          "image create",
        );
        context.logger.info("created image {name} as {id}", {
          name: args.name,
          id: str(created.id),
        });
        return {
          dataHandles: await writeImage(
            context,
            await showRaw(context, KIND, str(created.id)),
          ),
        };
      },
    },
    find: {
      description:
        "Find the newest image matching name, regex, tags and properties (like a data source) and store just that one",
      arguments: FindArgs,
      execute: async (
        args: z.infer<typeof FindArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const filters: string[] = [];
        if (args.name) filters.push("--name", assertArg(args.name, "name"));
        if (args.visibility === "all") filters.push("--all");
        else if (args.visibility) filters.push(`--${args.visibility}`);
        if (args.status) {
          filters.push("--status", assertArg(args.status, "status"));
        }
        filters.push(...repeatFlag("--tag", args.tags, "tag"));
        filters.push(...propertyFlags("--property", args.properties));
        const regex = args.nameRegex ? new RegExp(args.nameRegex) : undefined;
        context.logger.info("finding newest image matching {criteria}", {
          criteria: JSON.stringify({
            name: args.name,
            nameRegex: args.nameRegex,
            tags: args.tags,
            properties: args.properties,
          }),
        });
        const candidates = (await listThenShow(context, KIND, filters))
          .map(normalizeImage)
          .filter((i) => !regex || regex.test(i.name))
          .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
        if (candidates.length === 0) {
          throw new Error("no image matches the given criteria");
        }
        const newest = candidates[0];
        context.logger.info(
          "newest match is {name} ({id}, created {createdAt}) of {count}",
          {
            name: newest.name,
            id: newest.id,
            createdAt: newest.createdAt,
            count: candidates.length,
          },
        );
        return {
          dataHandles: await writeAll(context, "image", PREFIX, [newest]),
        };
      },
    },
    update: {
      description:
        "Change an image's name, limits, visibility, protection, properties or tags",
      arguments: UpdateArgs,
      execute: async (
        args: z.infer<typeof UpdateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const before = normalizeImage(await showRaw(context, KIND, args.image));
        const set: string[] = [];
        if (args.name !== undefined) {
          set.push("--name", assertArg(args.name, "name"));
        }
        if (args.minDiskGb !== undefined) {
          set.push("--min-disk", String(args.minDiskGb));
        }
        if (args.minRamMb !== undefined) {
          set.push("--min-ram", String(args.minRamMb));
        }
        if (args.visibility) set.push(`--${args.visibility}`);
        if (args.protected !== undefined) {
          set.push(args.protected ? "--protected" : "--unprotected");
        }
        set.push(...propertyFlags("--property", args.properties));
        set.push(...repeatFlag("--tag", args.tags, "tag"));
        if (set.length === 0) {
          context.logger.info("nothing to update on image {id}", {
            id: before.id,
          });
          return {
            dataHandles: await writeAll(context, "image", PREFIX, [before]),
          };
        }
        context.logger.info("updating image {id}", { id: before.id });
        await openstack(cliOptions(context.globalArgs), [
          "image",
          "set",
          ...set,
          before.id,
        ], context.signal);
        const after = normalizeImage(await showRaw(context, KIND, before.id));
        if (after.name !== before.name && context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, before));
        }
        return {
          dataHandles: await writeAll(context, "image", PREFIX, [after]),
        };
      },
    },
    delete: {
      description:
        "Delete an image (no-op when already gone) and drop its stored resource",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showRawOrNull(context, KIND, args.image);
        if (!existing) {
          context.logger.info("image {image} is already gone", {
            image: args.image,
          });
          return { dataHandles: [] };
        }
        const image = normalizeImage(existing);
        context.logger.info("deleting image {name} ({id})", {
          name: image.name,
          id: image.id,
        });
        await openstack(cliOptions(context.globalArgs), [
          "image",
          "delete",
          image.id,
        ], context.signal);
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, image));
        }
        return { dataHandles: [] };
      },
    },
  },
};
