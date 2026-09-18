/**
 * `@dataverket/openstack/server-group` — Nova server groups (affinity and
 * anti-affinity placement) through the `openstack` CLI.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { openstack, openstackJson } from "./cli.ts";
import {
  assertArg,
  assertShow,
  checks,
  cliOptions,
  type DataHandle,
  GlobalArgsSchema,
  instanceName,
  listThenShow,
  type MethodResult,
  type ModelContext,
  type Raw,
  showRaw,
  showRawOrNull,
  str,
  strList,
  strRecord,
  writeAll,
} from "./common.ts";

const KIND = ["server", "group"];
const PREFIX = "servergroup";

/** One server group as written to the `serverGroup` spec. */
export const ServerGroupSchema = z.object({
  id: z.string(),
  name: z.string(),
  policy: z.string().describe(
    "affinity, anti-affinity, soft-affinity or soft-anti-affinity",
  ),
  members: z.array(z.string()).describe("Member server ids"),
  rules: z.record(z.string(), z.string()).describe(
    "Policy rules, e.g. max_server_per_host",
  ),
  projectId: z.string(),
  userId: z.string(),
});
/** {@link ServerGroupSchema} */
export type ServerGroup = z.infer<typeof ServerGroupSchema>;

/** Shape a raw `server group show` object into a {@link ServerGroup}. */
export function normalizeServerGroup(raw: Raw): ServerGroup {
  // Microversion >= 2.64 reports a single `policy`; older ones a `policies` list.
  const policy = str(raw.policy) || strList(raw.policies)[0] || "";
  return {
    id: str(raw.id),
    name: str(raw.name),
    policy,
    members: strList(raw.members),
    rules: strRecord(raw.rules),
    projectId: str(raw.project_id),
    userId: str(raw.user_id),
  };
}

async function writeGroup(
  context: ModelContext,
  raw: Raw,
): Promise<DataHandle[]> {
  return await writeAll(context, "serverGroup", PREFIX, [
    normalizeServerGroup(raw),
  ]);
}

const Target = z.string().min(1).describe("Server group name or ID");
const ListArgs = z.object({});
const GetArgs = z.object({ serverGroup: Target });
const CreateArgs = z.object({
  name: z.string().min(1).describe("Group name; an existing group is reused"),
  policy: z.enum([
    "affinity",
    "anti-affinity",
    "soft-affinity",
    "soft-anti-affinity",
  ]),
  maxServerPerHost: z.number().int().positive().optional().describe(
    "Rule for anti-affinity: how many members may share a host",
  ),
});
const DeleteArgs = z.object({ serverGroup: Target });

/** Nova server group model. */
export const model = {
  type: "@dataverket/openstack/server-group",
  version: "2026.09.18.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    serverGroup: {
      description: "A Nova server group: placement policy, rules and members",
      schema: ServerGroupSchema,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description: "Discover the project's server groups and store each one",
      arguments: ListArgs,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing server groups");
        const groups = (await listThenShow(context, KIND, [])).map(
          normalizeServerGroup,
        );
        const handles = await writeAll(context, "serverGroup", PREFIX, groups);
        context.logger.info("stored {count} server groups", {
          count: groups.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one server group by name or ID and store it",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading server group {group}", {
          group: args.serverGroup,
        });
        return {
          dataHandles: await writeGroup(
            context,
            await showRaw(context, KIND, args.serverGroup),
          ),
        };
      },
    },
    create: {
      description:
        "Create a server group with a placement policy; an existing name is reused",
      arguments: CreateArgs,
      execute: async (
        args: z.infer<typeof CreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.name, "name");
        const existing = await showRawOrNull(context, KIND, args.name);
        if (existing) {
          context.logger.info(
            "server group {name} already exists as {id}; reusing",
            {
              name: args.name,
              id: str(existing.id),
            },
          );
          return { dataHandles: await writeGroup(context, existing) };
        }
        const cli = ["server", "group", "create", "--policy", args.policy];
        if (args.maxServerPerHost !== undefined) {
          cli.push("--rule", `max_server_per_host=${args.maxServerPerHost}`);
        }
        context.logger.info("creating server group {name} ({policy})", {
          name: args.name,
          policy: args.policy,
        });
        const created = assertShow(
          await openstackJson(cliOptions(context.globalArgs), [
            ...cli,
            args.name,
          ], context.signal),
          "server group create",
        );
        return {
          dataHandles: await writeGroup(
            context,
            await showRaw(context, KIND, str(created.id)),
          ),
        };
      },
    },
    delete: {
      description:
        "Delete a server group (no-op when already gone) and drop its stored resource",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const existing = await showRawOrNull(context, KIND, args.serverGroup);
        if (!existing) {
          context.logger.info("server group {group} is already gone", {
            group: args.serverGroup,
          });
          return { dataHandles: [] };
        }
        const group = normalizeServerGroup(existing);
        context.logger.info("deleting server group {name} ({id})", {
          name: group.name,
          id: group.id,
        });
        await openstack(cliOptions(context.globalArgs), [
          "server",
          "group",
          "delete",
          group.id,
        ], context.signal);
        if (context.deleteResource) {
          await context.deleteResource(instanceName(PREFIX, group));
        }
        return { dataHandles: [] };
      },
    },
  },
};
