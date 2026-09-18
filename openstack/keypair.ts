/**
 * `@dataverket/openstack/keypair` — Nova SSH keypairs through the
 * `openstack` CLI: discover, import or generate, and delete keypairs.
 *
 * A generated private key is written once to the `privateKey` spec, which is
 * marked sensitive so swamp vaults the material; the public `keypair` spec
 * never carries it.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { openstack, openstackJson } from "./cli.ts";
import {
  assertArg,
  assertList,
  checks,
  cliOptions,
  type DataHandle,
  GlobalArgsSchema,
  instanceName,
  isNotFound,
  mapLimit,
  type MethodResult,
  type ModelContext,
  type Raw,
  sanitizeInstanceName,
  str,
  withTempFile,
  writeAll,
} from "./common.ts";

const PREFIX = "keypair";

/** One keypair as written to the `keypair` spec (public half only). */
export const KeypairSchema = z.object({
  id: z.string().describe("Nova reports the name as the id"),
  name: z.string(),
  fingerprint: z.string(),
  type: z.string().describe("ssh or x509"),
  publicKey: z.string(),
  userId: z.string(),
  createdAt: z.string(),
});
/** {@link KeypairSchema} */
export type Keypair = z.infer<typeof KeypairSchema>;

/** The private half of a keypair Nova generated; stored via the vault. */
export const PrivateKeySchema = z.object({
  name: z.string(),
  privateKey: z.string().meta({ sensitive: true }),
});

/** Shape a raw `keypair show` object into a {@link Keypair}. */
export function normalizeKeypair(raw: Raw): Keypair {
  const name = str(raw.name);
  return {
    id: str(raw.id) || name,
    name,
    fingerprint: str(raw.fingerprint),
    type: str(raw.type) || "ssh",
    publicKey: str(raw.public_key).trim(),
    userId: str(raw.user_id),
    createdAt: str(raw.created_at),
  };
}

async function writeKeypair(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "keypair", PREFIX, [normalizeKeypair(raw)]);
}

/** Keypair show, tolerating Nova's habit of omitting `id`. */
async function showKeypair(context: ModelContext, name: string): Promise<Raw> {
  const raw = await openstackJson<unknown>(
    cliOptions(context.globalArgs),
    ["keypair", "show", assertArg(name, "keypair")],
    context.signal,
  );
  if (raw === null || typeof raw !== "object" || Array.isArray(raw)) {
    throw new Error(`openstack keypair show returned no object: ${str(raw)}`);
  }
  const o = raw as Raw;
  if (!o.id) o.id = o.name;
  return o;
}

/** {@link showKeypair} resolving to `null` when the keypair is missing. */
async function showKeypairOrNull(
  context: ModelContext,
  name: string,
): Promise<Raw | null> {
  try {
    return await showKeypair(context, name);
  } catch (err) {
    if (isNotFound(err)) return null;
    throw err;
  }
}

const Name = z.string().min(1).describe("Keypair name");
const ListArgs = z.object({});
const GetArgs = z.object({ keypair: Name });
const CreateArgs = z.object({
  name: Name.describe("Keypair name; an existing keypair is reused"),
  publicKey: z.string().optional().describe(
    "OpenSSH public key line to import; omit to have Nova generate an ed25519 key",
  ),
  type: z.enum(["ssh", "x509"]).optional(),
});
const DeleteArgs = z.object({ keypair: Name });

/** Nova keypair model. */
export const model = {
  type: "@dataverket/openstack/keypair",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    keypair: {
      description: "An SSH keypair registered with Nova (public half)",
      schema: KeypairSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    privateKey: {
      description:
        "The private key of a keypair Nova generated; written once at create",
      schema: PrivateKeySchema,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
  },
  methods: {
    list: {
      description: "Discover the caller's keypairs and store each one",
      arguments: ListArgs,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing keypairs");
        const rows = assertList(
          await openstackJson(cliOptions(context.globalArgs), [
            "keypair",
            "list",
            "-c",
            "Name",
          ], context.signal),
          "keypair list",
        );
        const names = rows.map((r) => str(r.Name)).filter((n) => n.length > 0);
        const raws = await mapLimit(
          names,
          context.globalArgs.concurrency,
          (n: string) => showKeypair(context, n),
        );
        const keypairs = raws.map(normalizeKeypair);
        const handles = await writeAll(context, "keypair", PREFIX, keypairs);
        context.logger.info("stored {count} keypairs", {
          count: keypairs.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one keypair by name and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading keypair {name}", { name: args.keypair });
        return {
          dataHandles: await writeKeypair(
            context,
            await showKeypair(context, args.keypair),
          ),
        };
      },
    },
    create: {
      description:
        "Import a public key, or let Nova generate a keypair (private key stored sensitively); an existing name is reused",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.name, "name");
        const existing = await showKeypairOrNull(context, args.name);
        if (existing) {
          context.logger.info("keypair {name} already exists; reusing", {
            name: args.name,
          });
          return { dataHandles: await writeKeypair(context, existing) };
        }
        const cli = ["keypair", "create"];
        if (args.type) cli.push("--type", args.type);
        const opts = cliOptions(context.globalArgs);
        const run = (extra: string[]) =>
          openstackJson<Raw>(
            opts,
            [...cli, ...extra, args.name],
            context.signal,
          );
        let created: Raw;
        if (args.publicKey !== undefined) {
          context.logger.info("importing public key as keypair {name}", {
            name: args.name,
          });
          created = await withTempFile(
            args.publicKey.trim() + "\n",
            (path) => run(["--public-key", path]),
          );
        } else {
          context.logger.info("generating keypair {name}", { name: args.name });
          created = await run([]);
        }
        const handles = await writeKeypair(
          context,
          await showKeypair(context, args.name),
        );
        const privateKey = str(created.private_key);
        if (privateKey.length > 0) {
          handles.push(
            await context.writeResource(
              "privateKey",
              `privatekey-${sanitizeInstanceName(args.name)}`,
              {
                name: args.name,
                privateKey,
              },
            ),
          );
          context.logger.info("stored generated private key for {name}", {
            name: args.name,
          });
        }
        return { dataHandles: handles };
      },
    },
    delete: {
      description:
        "Delete a keypair (no-op when already gone) and drop its stored resource",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showKeypairOrNull(context, args.keypair);
        if (!existing) {
          context.logger.info("keypair {name} is already gone", {
            name: args.keypair,
          });
          return { dataHandles: [] };
        }
        context.logger.info("deleting keypair {name}", { name: args.keypair });
        await openstack(cliOptions(context.globalArgs), [
          "keypair",
          "delete",
          args.keypair,
        ], context.signal);
        if (context.deleteResource) {
          await context.deleteResource(
            instanceName(PREFIX, { id: args.keypair, name: args.keypair }),
          );
        }
        return { dataHandles: [] };
      },
    },
  },
};
