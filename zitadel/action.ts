/**
 * `@dataverket/zitadel/action` — Zitadel's v2 actions: the targets an instance
 * calls out to, and the executions that decide when it calls them.
 *
 * An action in v4 is two halves. A **target** is an endpoint of yours with a
 * timeout and a delivery style: `webhook` (fire and forget the response),
 * `call` (the response may change what Zitadel does) or `async`. An
 * **execution** binds a condition — a request to a gRPC method, a response from
 * one, an event, or one of Zitadel's named functions — to an ordered list of
 * targets. Setting an execution with no targets is how you remove it, which is
 * why `executionRemove` exists rather than a delete.
 *
 * A target's signing key is what lets your endpoint prove the call came from
 * this instance. It is returned once when the target is created, and once more
 * when `ensure` rotates it, into a spec marked sensitive; it is never readable
 * afterwards.
 *
 * `catalog` is the discovery method: the services, methods and functions an
 * execution condition may name on this instance and this version. Read it
 * before writing a condition rather than guessing at one.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { asArray, call, searchAllV2, seg, v2 } from "./api.ts";
import {
  boolArg,
  checks,
  DryRun,
  forgetInstance,
  GlobalArgsSchema,
  jsonArray,
  type MethodResult,
  type ModelContext,
  nowIso,
  obj,
  optStr,
  requireConfirm,
  str,
  writeAll,
  writeOne,
} from "./common.ts";
import {
  ActionCatalog,
  DeleteResult,
  ExecutionInfo,
  PublicKeyInfo,
  shapeExecution,
  shapeTarget,
  StateResult,
  TargetCredential,
  TargetInfo,
} from "./schema.ts";

const TargetRef = z.string().min(1).describe(
  "Target id, or its name — a name is looked up",
);

const ListArgs = z.object({});
const GetArgs = z.object({ target: TargetRef });
const EnsureArgs = z.object({
  name: z.string().min(1).describe(
    "Target name; an existing target of this name is converged",
  ),
  endpoint: z.string().min(1).describe(
    "The URL Zitadel calls, e.g. https://hooks.example.org/zitadel",
  ),
  style: z.enum(["webhook", "call", "async"]).default("webhook").describe(
    "webhook ignores the response, call lets the response change the outcome, " +
      "async does not wait at all",
  ),
  interruptOnError: boolArg(false).describe(
    "Stop the operation when the endpoint fails; webhook and call only",
  ),
  timeout: z.string().default("10s").describe(
    "How long Zitadel waits, as a duration with a unit, e.g. 10s",
  ),
  payloadType: z.enum(["json", "jwt", "jwe"]).optional().describe(
    "How the payload is encoded; jwt and jwe need a public key on the target",
  ),
  rotateSigningKey: boolArg(false).describe(
    "On an existing target, mint a new signing key and return it once",
  ),
});
const DeleteArgs = z.object({
  target: TargetRef,
  confirm: z.string().min(1).describe(
    "The target's exact name, repeated — a mismatch refuses the delete",
  ),
  dryRun: DryRun.describe("Report what would be deleted and change nothing"),
});
const ExecutionListArgs = z.object({});
const Condition = {
  requestService: z.string().optional().describe(
    "Condition: every request to this gRPC service, e.g. zitadel.user.v2.UserService",
  ),
  requestMethod: z.string().optional().describe(
    "Condition: one request method, fully qualified",
  ),
  responseService: z.string().optional().describe(
    "Condition: every response from this gRPC service",
  ),
  responseMethod: z.string().optional().describe(
    "Condition: one response method, fully qualified",
  ),
  event: z.string().optional().describe(
    "Condition: one event, e.g. user.human.added",
  ),
  eventGroup: z.string().optional().describe(
    "Condition: every event in a group",
  ),
  allEvents: boolArg(false).describe("Condition: every event there is"),
  function: z.string().optional().describe(
    "Condition: one of Zitadel's named functions, from the catalog",
  ),
};
const ExecutionSetArgs = z.object({
  ...Condition,
  targets: jsonArray(z.string()).describe(
    "Target ids or names, in the order they are called",
  ),
});
const ExecutionRemoveArgs = z.object({
  ...Condition,
  dryRun: DryRun.describe("Report what would be removed and change nothing"),
});
const CatalogArgs = z.object({});
const KeyListArgs = z.object({ target: TargetRef });
const KeyAddArgs = z.object({
  target: TargetRef,
  publicKey: z.string().min(1).describe(
    "PEM public key the payload is encrypted to",
  ),
  expirationDate: z.string().optional().describe(
    "RFC3339 expiry, if it should have one",
  ),
});
const KeySetStateArgs = z.object({
  target: TargetRef,
  keyId: z.string().min(1),
  state: z.enum(["active", "inactive"]),
});
const KeyRemoveArgs = z.object({
  target: TargetRef,
  keyId: z.string().min(1).describe("Key id, verified to belong to the target"),
  dryRun: DryRun.describe("Report what would be removed and change nothing"),
});

/** The delivery style, as the API nests it in the request body. */
function styleBody(
  style: "webhook" | "call" | "async",
  interruptOnError: boolean,
): Record<string, unknown> {
  if (style === "async") return { restAsync: {} };
  if (style === "call") return { restCall: { interruptOnError } };
  return { restWebhook: { interruptOnError } };
}

/** The condition an execution is keyed by, as the API nests it. */
function conditionBody(args: Record<string, unknown>): Record<string, unknown> {
  const requestService = optStr(args.requestService);
  const requestMethod = optStr(args.requestMethod);
  const responseService = optStr(args.responseService);
  const responseMethod = optStr(args.responseMethod);
  const event = optStr(args.event);
  const eventGroup = optStr(args.eventGroup);
  const fn = optStr(args.function);
  if (requestMethod) return { request: { method: requestMethod } };
  if (requestService) return { request: { service: requestService } };
  if (responseMethod) return { response: { method: responseMethod } };
  if (responseService) return { response: { service: responseService } };
  if (event) return { event: { event } };
  if (eventGroup) return { event: { group: eventGroup } };
  if (args.allEvents === true) return { event: { all: true } };
  if (fn) return { function: { name: fn } };
  throw new Error(
    "an execution needs exactly one condition: requestService, requestMethod, " +
      "responseService, responseMethod, event, eventGroup, allEvents or function",
  );
}

/** A stable key for a condition, for naming the stored instance. */
function conditionKey(condition: Record<string, unknown>): string {
  const request = obj(condition.request);
  const response = obj(condition.response);
  const event = obj(condition.event);
  const fn = obj(condition.function);
  if (request.method) return `request-${str(request.method)}`;
  if (request.service) return `request-${str(request.service)}`;
  if (response.method) return `response-${str(response.method)}`;
  if (response.service) return `response-${str(response.service)}`;
  if (event.event) return `event-${str(event.event)}`;
  if (event.group) return `event-group-${str(event.group)}`;
  if (event.all === true) return "event-all";
  if (fn.name) return `function-${str(fn.name)}`;
  return "condition";
}

/**
 * Zitadel answers a target it will not accept with `Errors.Target.DeniedURL`
 * and nothing else. It resolves the endpoint's host first and refuses what it
 * cannot resolve, as well as anything on the instance's deny list, so say that
 * rather than pass the code through.
 */
function explainEndpoint(err: unknown, endpoint: string): never {
  const message = err instanceof Error ? err.message : String(err);
  if (/DeniedURL/.test(message)) {
    throw new Error(
      `Zitadel will not call ${endpoint}: it resolves the host first and ` +
        `refuses one it cannot resolve, as well as anything on the instance's ` +
        `Actions.HTTP.DenyList (localhost and loopback by default). ` +
        `Original: ${message}`,
    );
  }
  throw err instanceof Error ? err : new Error(message);
}

/** Find a target by exact name. */
async function findTargetByName(
  globalArgs: Record<string, unknown>,
  name: string,
): Promise<Record<string, unknown> | null> {
  const rows = await searchAllV2(
    globalArgs,
    v2("/actions/targets/search"),
    {
      filters: [{
        targetNameFilter: {
          targetName: name,
          method: "TEXT_FILTER_METHOD_EQUALS",
        },
      }],
    },
    "pagination",
    "targets",
  );
  return rows.find((row) => str(row.name) === name) ?? null;
}

/** Read one target by id. */
async function getTarget(
  globalArgs: Record<string, unknown>,
  id: string,
): Promise<Record<string, unknown> | null> {
  try {
    const result = await call(globalArgs, {
      method: "GET",
      path: v2(`/actions/targets/${seg(id)}`),
    });
    const target = result.body.target;
    return target ? (target as Record<string, unknown>) : null;
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (/HTTP 404|not found/i.test(message)) return null;
    throw err;
  }
}

/** Resolve a target reference (id or name), or `null` when it is gone. */
async function tryResolveTarget(
  globalArgs: Record<string, unknown>,
  reference: string,
): Promise<Record<string, unknown> | null> {
  // Target ids are not digits-only, so try the name first and fall back to id.
  return await findTargetByName(globalArgs, reference) ??
    await getTarget(globalArgs, reference);
}

/** Resolve a target reference, failing with its name when it is not there. */
async function resolveTarget(
  globalArgs: Record<string, unknown>,
  reference: string,
): Promise<Record<string, unknown>> {
  const target = await tryResolveTarget(globalArgs, reference);
  if (!target) throw new Error(`no target ${JSON.stringify(reference)}`);
  return target;
}

/** Zitadel v2 actions: targets and executions. */
export const model = {
  type: "@dataverket/zitadel/action",
  version: "2026.09.29.1",
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    target: {
      description: "An endpoint Zitadel calls, with its delivery style",
      schema: TargetInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "target-credential": {
      description:
        "A target's signing key, emitted once at create and once at each rotation",
      schema: TargetCredential,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    "public-key": {
      description: "A public key a target's payload may be encrypted to",
      schema: PublicKeyInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    execution: {
      description: "A condition bound to the targets it calls, in order",
      schema: ExecutionInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    catalog: {
      description:
        "What an execution condition may name on this instance: services, methods, functions",
      schema: ActionCatalog,
      lifetime: "infinite" as const,
      garbageCollection: 3,
    },
    state: {
      description: "The outcome of a reversible state change",
      schema: StateResult,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    deletion: {
      description: "The outcome of a delete, or of a dry run that planned one",
      schema: DeleteResult,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    list: {
      description:
        "List every target and store each one. Read-only, no signing keys.",
      arguments: ListArgs,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing action targets");
        const rows = await searchAllV2(
          context.globalArgs,
          v2("/actions/targets/search"),
          {},
          "pagination",
          "targets",
        );
        const timestamp = nowIso();
        const targets = rows.map((row) =>
          shapeTarget(row, "observed", timestamp)
        );
        const handles = await writeAll(
          context,
          "target",
          "target",
          targets,
          (target) => str(target.name) || str(target.id),
        );
        context.logger.info("stored {count} targets", {
          count: targets.length,
        });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one target by id or name and store it. Read-only.",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading target {target}", { target: args.target });
        const live = await resolveTarget(context.globalArgs, args.target);
        const target = shapeTarget(live, "observed", nowIso());
        return {
          dataHandles: await writeOne(
            context,
            "target",
            "target",
            str(target.name) || str(target.id),
            target,
          ),
        };
      },
    },
    ensure: {
      kind: "create" as const,
      description:
        "Find or create a target by name and converge its endpoint, style and timeout. The signing key comes back once on create, and again when rotateSigningKey asks for a new one. Idempotent.",
      arguments: EnsureArgs,
      execute: async (
        args: z.infer<typeof EnsureArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const timestamp = nowIso();
        const body: Record<string, unknown> = {
          name: args.name,
          endpoint: args.endpoint,
          timeout: args.timeout,
          ...styleBody(args.style, args.interruptOnError),
        };
        if (args.payloadType) {
          body.payloadType = `PAYLOAD_TYPE_${args.payloadType.toUpperCase()}`;
        }
        const existing = await findTargetByName(globalArgs, args.name);

        if (existing) {
          const id = str(existing.id);
          const update = { ...body };
          if (args.rotateSigningKey) update.expirationSigningKey = "0s";
          const result = await call(globalArgs, {
            method: "POST",
            path: v2(`/actions/targets/${seg(id)}`),
            body: update,
          }).catch((err) => explainEndpoint(err, args.endpoint));
          const after = await getTarget(globalArgs, id) ?? existing;
          const signingKey = optStr(result.body.signingKey);
          context.logger.info("converged target {name}", { name: args.name });
          const handles = await writeOne(
            context,
            "target",
            "target",
            args.name,
            shapeTarget(after, "updated", timestamp),
          );
          if (signingKey) {
            handles.push(
              ...await writeOne(
                context,
                "target-credential",
                "target-credential",
                args.name,
                {
                  targetId: id,
                  name: args.name,
                  signingKey,
                  action: "rotated",
                  timestamp,
                },
              ),
            );
          }
          return { dataHandles: handles };
        }

        context.logger.info("creating target {name}", { name: args.name });
        const created = await call(globalArgs, {
          method: "POST",
          path: v2("/actions/targets"),
          body,
        }).catch((err) => explainEndpoint(err, args.endpoint));
        const id = str(created.body.id);
        const after = await getTarget(globalArgs, id);
        return {
          dataHandles: [
            ...await writeOne(
              context,
              "target",
              "target",
              args.name,
              shapeTarget(after ?? { id, ...body }, "created", timestamp),
            ),
            ...await writeOne(
              context,
              "target-credential",
              "target-credential",
              args.name,
              {
                targetId: id,
                name: args.name,
                signingKey: str(created.body.signingKey),
                action: "created",
                timestamp,
              },
            ),
          ],
        };
      },
    },
    delete: {
      kind: "action" as const,
      description:
        "Delete a target. Verify-first: confirm must repeat the live name, and dryRun only reports. Executions that named the target stop calling it.",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const timestamp = nowIso();
        const live = await tryResolveTarget(globalArgs, args.target);
        if (!live) {
          context.logger.warning("no target {target}; nothing to delete", {
            target: args.target,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "target-deletion",
              args.target,
              {
                kind: "target",
                id: "",
                name: args.target,
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        const id = str(live.id);
        const name = str(live.name);
        requireConfirm(name, args.confirm, "target name");
        if (args.dryRun) {
          context.logger.info("dry run: would delete target {name}", { name });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "target-deletion",
              name,
              {
                kind: "target",
                id,
                name,
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }
        await call(globalArgs, {
          method: "DELETE",
          path: v2(`/actions/targets/${seg(id)}`),
        });
        await forgetInstance(context, "target", name);
        context.logger.warning("deleted target {name}", { name });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "target-deletion",
            name,
            {
              kind: "target",
              id,
              name,
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
    executionList: {
      kind: "list" as const,
      description:
        "List every execution with its condition and the targets it calls. Read-only.",
      arguments: ExecutionListArgs,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("listing executions");
        const rows = await searchAllV2(
          context.globalArgs,
          v2("/actions/executions/search"),
          {},
          "pagination",
          "executions",
        );
        const timestamp = nowIso();
        const executions = rows.map((row) =>
          shapeExecution(row, "observed", timestamp)
        );
        const handles = await writeAll(
          context,
          "execution",
          "execution",
          executions,
          (execution) => str(execution.condition),
        );
        context.logger.info("stored {count} executions", {
          count: executions.length,
        });
        return { dataHandles: handles };
      },
    },
    executionSet: {
      description:
        "Bind a condition to an ordered list of targets, replacing whatever that condition called before. Give exactly one condition. Idempotent.",
      arguments: ExecutionSetArgs,
      execute: async (
        args: z.infer<typeof ExecutionSetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const condition = conditionBody(args as Record<string, unknown>);
        const targetIds: string[] = [];
        for (const reference of args.targets) {
          targetIds.push(str((await resolveTarget(globalArgs, reference)).id));
        }
        context.logger.info("setting the execution for {condition}", {
          condition: conditionKey(condition),
        });
        await call(globalArgs, {
          method: "PUT",
          path: v2("/actions/executions"),
          body: { condition, targets: targetIds },
        });
        return {
          dataHandles: await writeOne(
            context,
            "execution",
            "execution",
            conditionKey(condition),
            shapeExecution(
              { condition, targets: targetIds },
              "updated",
              nowIso(),
            ),
          ),
        };
      },
    },
    executionRemove: {
      kind: "action" as const,
      description:
        "Stop a condition calling anything, by setting it to no targets — which is how Zitadel removes an execution. dryRun only reports.",
      arguments: ExecutionRemoveArgs,
      execute: async (
        args: z.infer<typeof ExecutionRemoveArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const condition = conditionBody(args as Record<string, unknown>);
        const key = conditionKey(condition);
        const timestamp = nowIso();
        if (args.dryRun) {
          context.logger.info(
            "dry run: would clear the execution for {condition}",
            {
              condition: key,
            },
          );
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "execution-deletion",
              key,
              {
                kind: "execution",
                id: key,
                name: key,
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }
        await call(globalArgs, {
          method: "PUT",
          path: v2("/actions/executions"),
          body: { condition, targets: [] },
        });
        await forgetInstance(context, "execution", key);
        context.logger.warning("cleared the execution for {condition}", {
          condition: key,
        });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "execution-deletion",
            key,
            {
              kind: "execution",
              id: key,
              name: key,
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
    catalog: {
      kind: "list" as const,
      description:
        "Store what an execution condition may name on this instance: the gRPC services, the methods and Zitadel's own functions. Read-only, and the thing to read before writing a condition.",
      arguments: CatalogArgs,
      execute: async (
        _args: Record<string, never>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        context.logger.info("reading the execution catalog");
        const timestamp = nowIso();
        const parts: { kind: string; path: string; field: string }[] = [
          {
            kind: "service",
            path: "/actions/executions/services",
            field: "services",
          },
          {
            kind: "method",
            path: "/actions/executions/methods",
            field: "methods",
          },
          {
            kind: "function",
            path: "/actions/executions/functions",
            field: "functions",
          },
        ];
        const entries: Record<string, unknown>[] = [];
        for (const part of parts) {
          const result = await call(globalArgs, {
            method: "GET",
            path: v2(part.path),
          });
          entries.push({
            kind: part.kind,
            values: asArray(result.body[part.field]).map((value) => str(value)),
            action: "observed",
            timestamp,
          });
        }
        const handles = await writeAll(
          context,
          "catalog",
          "catalog",
          entries,
          (entry) => str(entry.kind),
        );
        context.logger.info("stored the catalog of {count} kinds", {
          count: entries.length,
        });
        return { dataHandles: handles };
      },
    },
    keyList: {
      kind: "list" as const,
      description:
        "List a target's public keys by id, state and expiry. Read-only.",
      arguments: KeyListArgs,
      execute: async (
        args: z.infer<typeof KeyListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveTarget(globalArgs, args.target);
        const targetId = str(live.id);
        const rows = await searchAllV2(
          globalArgs,
          v2(`/actions/targets/${seg(targetId)}/publickeys/search`),
          {},
          "pagination",
          "publicKeys",
        );
        const timestamp = nowIso();
        const keys = rows.map((row) => ({
          targetId,
          keyId: str(row.id),
          state: str(row.state ?? "").toLowerCase().split("_").pop() ??
            "unknown",
          expirationDate: optStr(row.expirationDate),
          action: "observed" as const,
          timestamp,
        }));
        const handles = await writeAll(
          context,
          "public-key",
          "public-key",
          keys,
          (key) => `${targetId}-${key.keyId}`,
        );
        context.logger.info("stored {count} public keys", {
          count: keys.length,
        });
        return { dataHandles: handles };
      },
    },
    keyAdd: {
      description:
        "Add a public key to a target, for a payload encrypted to it. Idempotent only in the sense that adding twice adds two keys — list first.",
      arguments: KeyAddArgs,
      execute: async (
        args: z.infer<typeof KeyAddArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveTarget(globalArgs, args.target);
        const targetId = str(live.id);
        const body: Record<string, unknown> = { publicKey: args.publicKey };
        if (args.expirationDate) body.expirationDate = args.expirationDate;
        context.logger.info("adding a public key to target {name}", {
          name: str(live.name) || targetId,
        });
        const created = await call(globalArgs, {
          method: "POST",
          path: v2(`/actions/targets/${seg(targetId)}/publickeys`),
          body,
        });
        return {
          dataHandles: await writeOne(
            context,
            "public-key",
            "public-key",
            `${targetId}-${str(created.body.id)}`,
            {
              targetId,
              keyId: str(created.body.id),
              state: "active",
              expirationDate: optStr(args.expirationDate),
              action: "created",
              timestamp: nowIso(),
            },
          ),
        };
      },
    },
    keySetState: {
      description:
        "Activate or deactivate a target's public key. Reversible, and the way to retire a key before removing it.",
      arguments: KeySetStateArgs,
      execute: async (
        args: z.infer<typeof KeySetStateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveTarget(globalArgs, args.target);
        const targetId = str(live.id);
        const endpoint = args.state === "active" ? "activate" : "deactivate";
        await call(globalArgs, {
          method: "POST",
          path: v2(
            `/actions/targets/${seg(targetId)}/publickeys/${
              seg(args.keyId)
            }/${endpoint}`,
          ),
          body: {},
        });
        context.logger.info("public key {key} is now {state}", {
          key: args.keyId,
          state: args.state,
        });
        return {
          dataHandles: await writeOne(
            context,
            "state",
            "public-key-state",
            `${targetId}-${args.keyId}`,
            {
              kind: "public-key",
              id: args.keyId,
              name: str(live.name),
              previousState: args.state === "active" ? "inactive" : "active",
              state: args.state,
              action: args.state === "active" ? "reactivated" : "deactivated",
              timestamp: nowIso(),
            },
          ),
        };
      },
    },
    keyRemove: {
      kind: "action" as const,
      description:
        "Remove a public key from a target, verifying first that it belongs to it. dryRun only reports.",
      arguments: KeyRemoveArgs,
      execute: async (
        args: z.infer<typeof KeyRemoveArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveTarget(globalArgs, args.target);
        const targetId = str(live.id);
        const rows = await searchAllV2(
          globalArgs,
          v2(`/actions/targets/${seg(targetId)}/publickeys/search`),
          {},
          "pagination",
          "publicKeys",
        );
        const timestamp = nowIso();
        if (!rows.some((row) => str(row.id) === args.keyId)) {
          context.logger.warning("target {name} has no public key {key}", {
            name: str(live.name) || targetId,
            key: args.keyId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "public-key-deletion",
              `${targetId}-${args.keyId}`,
              {
                kind: "public-key",
                id: args.keyId,
                name: str(live.name),
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        if (args.dryRun) {
          context.logger.info("dry run: would remove public key {key}", {
            key: args.keyId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "public-key-deletion",
              `${targetId}-${args.keyId}`,
              {
                kind: "public-key",
                id: args.keyId,
                name: str(live.name),
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }
        await call(globalArgs, {
          method: "DELETE",
          path: v2(
            `/actions/targets/${seg(targetId)}/publickeys/${seg(args.keyId)}`,
          ),
        });
        await forgetInstance(
          context,
          "public-key",
          `${targetId}-${args.keyId}`,
        );
        context.logger.warning("removed public key {key}", { key: args.keyId });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "public-key-deletion",
            `${targetId}-${args.keyId}`,
            {
              kind: "public-key",
              id: args.keyId,
              name: str(live.name),
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
  },
};

/** Exported for the tests: the condition builder and its stable key. */
export const __internal = { conditionBody, conditionKey, styleBody };
