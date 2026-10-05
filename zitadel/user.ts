/**
 * `@dataverket/zitadel/user` — human and machine users over the v2 user
 * service, with their credentials and metadata.
 *
 * Both kinds of user live here because Zitadel keeps them in one service and
 * one namespace of usernames: `ensureHuman` and `ensureMachine` differ in what
 * they create, not in how they are found, updated, suspended or deleted. Human
 * users matter because the people who log in are worth managing the same way as
 * the services that do.
 *
 * No password is ever an argument. A human's password is set by the human,
 * from a reset link `passwordResetLinkCreate` mints — returned once into a
 * sensitive spec, or mailed by Zitadel and never seen here.
 *
 * Every credential this type mints — a personal access token, a key's JSON, a
 * machine user's client secret — is emitted exactly once into the
 * `user-credential` spec, marked sensitive. `patList` and `keyList` can say
 * afterwards that a credential exists and when it expires, never what it is.
 *
 * `setState` covers deactivate, reactivate, lock and unlock, all reversible.
 * `delete` is the one irreversible method: it re-reads the user, refuses unless
 * `confirm` repeats the live username, and does nothing under `dryRun`.
 *
 * @module
 */
import {
  asArray,
  call,
  fromBase64,
  type Json,
  searchAllV2,
  seg,
  toBase64,
  v2,
} from "./api.ts";
import { z } from "npm:zod@4";
import {
  assertArg,
  checks,
  DryRun,
  forgetInstance,
  friendlyState,
  GENDER,
  GlobalArgsSchema,
  jsonArray,
  mapEnum,
  type MethodResult,
  type ModelContext,
  nowIso,
  obj,
  optStr,
  requireConfirm,
  str,
  USER_TOKEN_TYPE,
  writeAll,
  writeOne,
} from "./common.ts";
import {
  AuthFactor,
  CredentialRecord,
  DeleteResult,
  IdpLink,
  MetadataEntry,
  PasswordReset,
  shapeUser,
  StateResult,
  UserCredential,
  UserInfo,
} from "./schema.ts";
import {
  findUserByUsername,
  getUser,
  resolveOrgId,
  resolveUser,
  tryResolveUser,
} from "./lookup.ts";

const UserRef = z.string().min(1).describe(
  "User id, or the username — a username is looked up",
);
const Expiry = z.string().min(1).describe(
  "RFC3339 expiry, e.g. 2027-01-01T00:00:00Z. The v2 user service requires " +
    "one: a token or key that never expires is not something it will mint.",
);

const ListArgs = z.object({
  type: z.enum(["human", "machine", "any"]).default("any").describe(
    "Narrow the listing to one kind of user",
  ),
});
const GetArgs = z.object({ user: UserRef });
const EnsureMachineArgs = z.object({
  username: z.string().min(1).describe(
    "Login name; an existing machine user of this name is converged",
  ),
  name: z.string().min(1).describe("Display name"),
  description: z.string().optional().describe(
    "Free text; omitting it leaves any existing description as it is, since " +
      "Zitadel refuses an empty one",
  ),
  accessTokenType: z.enum(["bearer", "jwt"]).default("bearer"),
});
const EnsureHumanArgs = z.object({
  username: z.string().min(1).describe(
    "Login name; an existing human user of this name is converged",
  ),
  email: z.string().min(1).describe("Email address"),
  givenName: z.string().min(1).describe("First name"),
  familyName: z.string().min(1).describe("Last name"),
  displayName: z.string().optional(),
  nickName: z.string().optional(),
  gender: z.enum(["unspecified", "female", "male", "diverse"]).optional(),
  preferredLanguage: z.string().optional().describe(
    "BCP-47 tag, e.g. nb or en",
  ),
  phone: z.string().optional().describe("Phone number in E.164 form"),
  emailVerified: z.boolean().default(false).describe(
    "Mark the address verified instead of having Zitadel send a code",
  ),
});
const UpdateArgs = z.object({
  user: UserRef,
  username: z.string().min(1).optional().describe("New login name"),
  email: z.string().min(1).optional().describe(
    "Human users: new email address",
  ),
  emailVerified: z.boolean().optional(),
  givenName: z.string().min(1).optional(),
  familyName: z.string().min(1).optional(),
  displayName: z.string().optional(),
  phone: z.string().optional(),
  name: z.string().min(1).optional().describe(
    "Machine users: new display name",
  ),
  description: z.string().optional().describe("Machine users: new description"),
  accessTokenType: z.enum(["bearer", "jwt"]).optional().describe(
    "Machine users: token type",
  ),
});
const SetStateArgs = z.object({
  user: UserRef,
  state: z.enum(["active", "inactive", "locked"]).describe(
    "active reactivates or unlocks, inactive deactivates, locked locks out",
  ),
});
const DeleteArgs = z.object({
  user: UserRef,
  confirm: z.string().min(1).describe(
    "The user's exact username, repeated — a mismatch refuses the delete",
  ),
  dryRun: DryRun.describe("Report what would be deleted and change nothing"),
});
const PatCreateArgs = z.object({ user: UserRef, expirationDate: Expiry });
const PatListArgs = z.object({ user: UserRef });
const PatRevokeArgs = z.object({
  user: UserRef,
  tokenId: z.string().min(1).describe(
    "Token id, verified to belong to the user first",
  ),
  dryRun: DryRun.describe("Report what would be revoked and change nothing"),
});
const KeyCreateArgs = z.object({
  user: UserRef,
  expirationDate: Expiry,
  publicKey: z.string().optional().describe(
    "A public key to register instead of having Zitadel generate the pair",
  ),
});
const KeyListArgs = z.object({ user: UserRef });
const KeyDeleteArgs = z.object({
  user: UserRef,
  keyId: z.string().min(1).describe(
    "Key id, verified to belong to the user first",
  ),
  dryRun: DryRun.describe("Report what would be deleted and change nothing"),
});
const SecretArgs = z.object({ user: UserRef });
const SecretRemoveArgs = z.object({
  user: UserRef,
  dryRun: DryRun.describe("Report what would be removed and change nothing"),
});
const MetadataSetArgs = z.object({
  user: UserRef,
  key: z.string().min(1).describe("Metadata key"),
  value: z.string().describe("Metadata value, stored as given"),
});
const MetadataListArgs = z.object({ user: UserRef });
const MetadataDeleteArgs = z.object({
  user: UserRef,
  keys: jsonArray(z.string()).describe("Metadata keys to delete"),
  dryRun: DryRun.describe("Report what would be deleted and change nothing"),
});
const AuthFactorListArgs = z.object({ user: UserRef });
const AuthFactorRemoveArgs = z.object({
  user: UserRef,
  type: z.enum([
    "totp",
    "u2f",
    "otp-sms",
    "otp-email",
    "passkey",
    "recovery-codes",
  ])
    .describe("Which kind of factor to take away"),
  id: z.string().optional().describe(
    "The factor's id, needed for u2f and passkey, where a user may have several",
  ),
  dryRun: DryRun.describe("Report what would be removed and change nothing"),
});
const IdpLinkListArgs = z.object({ user: UserRef });
const IdpLinkRemoveArgs = z.object({
  user: UserRef,
  idpId: z.string().min(1).describe("The identity provider"),
  externalUserId: z.string().min(1).describe(
    "The user's id at that provider, verified against the link first",
  ),
  dryRun: DryRun.describe("Report what would be removed and change nothing"),
});
const PasswordResetArgs = z.object({
  user: UserRef,
  delivery: z.enum(["return", "email"]).default("return").describe(
    "return stores the code once as a secret; email has Zitadel send the link",
  ),
  urlTemplate: z.string().optional().describe(
    "Link template for the mail, e.g. https://example.org/reset?code={{.Code}}",
  ),
});

/** The profile fields of a human user, as the v2 API nests them. */
function humanProfile(args: {
  givenName?: string;
  familyName?: string;
  displayName?: string;
  nickName?: string;
  gender?: string;
  preferredLanguage?: string;
}): Record<string, unknown> | undefined {
  const profile: Record<string, unknown> = {};
  if (args.givenName) profile.givenName = args.givenName;
  if (args.familyName) profile.familyName = args.familyName;
  if (args.displayName) profile.displayName = args.displayName;
  if (args.nickName) profile.nickName = args.nickName;
  if (args.gender) profile.gender = mapEnum(GENDER, args.gender, "gender");
  if (args.preferredLanguage) {
    profile.preferredLanguage = args.preferredLanguage;
  }
  return Object.keys(profile).length ? profile : undefined;
}

/** Store one user record under the `user` spec. */
function writeUser(
  context: ModelContext,
  raw: Json,
  action: "observed" | "created" | "updated" | "unchanged",
) {
  const user = shapeUser(raw, action, nowIso());
  return writeOne(
    context,
    "user",
    "user",
    str(user.username) || str(user.id),
    user,
  );
}

/** The filters a v2 credential search takes for one user. */
function userFilter(userId: string): Record<string, unknown> {
  return { filters: [{ userIdFilter: { id: userId } }] };
}

/** Users of a Zitadel organization, human and machine. */
export const model = {
  type: "@dataverket/zitadel/user",
  version: "2026.10.05.1",
  upgrades: [
    {
      toVersion: "2026.10.01.3",
      description: "keyJsonFile expands a leading ~/; no argument changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
    {
      toVersion: "2026.10.05.1",
      description:
        "Released with the app and settings changes of this version; nothing in this type changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    user: {
      description: "A user, human or machine",
      schema: UserInfo,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "user-credential": {
      description:
        "A credential minted for a user — token, key or secret — emitted once",
      schema: UserCredential,
      lifetime: "infinite" as const,
      garbageCollection: 5,
    },
    credential: {
      description:
        "A user's existing token or key, by id and expiry; never the secret",
      schema: CredentialRecord,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    metadata: {
      description: "One metadata entry on a user",
      schema: MetadataEntry,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "auth-factor": {
      description: "One way a person can prove who they are",
      schema: AuthFactor,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "idp-link": {
      description: "A user's account at an identity provider",
      schema: IdpLink,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "password-reset": {
      description: "A password reset a human can act on",
      schema: PasswordReset,
      lifetime: "infinite" as const,
      garbageCollection: 5,
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
        "List users, optionally only the humans or only the machines, and store each one. Read-only.",
      arguments: ListArgs,
      execute: async (
        args: z.infer<typeof ListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const queries: Record<string, unknown>[] = [{
          organizationIdQuery: {
            organizationId: await resolveOrgId(context.globalArgs),
          },
        }];
        if (args.type !== "any") {
          queries.push({
            typeQuery: {
              type: args.type === "human" ? "TYPE_HUMAN" : "TYPE_MACHINE",
            },
          });
        }
        context.logger.info("listing {type} users", { type: args.type });
        const rows = await searchAllV2(
          context.globalArgs,
          v2("/users"),
          { queries },
          "query",
        );
        const timestamp = nowIso();
        const users = rows.map((row) => shapeUser(row, "observed", timestamp));
        const handles = await writeAll(
          context,
          "user",
          "user",
          users,
          (user) => str(user.username) || str(user.id),
        );
        context.logger.info("stored {count} users", { count: users.length });
        return { dataHandles: handles };
      },
    },
    get: {
      description: "Read one user by id or username and store it. Read-only.",
      arguments: GetArgs,
      execute: async (
        args: z.infer<typeof GetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        context.logger.info("reading user {user}", { user: args.user });
        const live = await resolveUser(context.globalArgs, args.user);
        return { dataHandles: await writeUser(context, live, "observed") };
      },
    },
    ensureMachine: {
      kind: "create" as const,
      description:
        "Find or create a machine (service) user by username, converging its display name, description and token type. Idempotent, and mints no credential — patCreate, keyCreate or secretGenerate do that.",
      arguments: EnsureMachineArgs,
      execute: async (
        args: z.infer<typeof EnsureMachineArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.username, "username");
        const globalArgs = context.globalArgs;
        const existing = await findUserByUsername(globalArgs, args.username);
        const tokenType = mapEnum(
          USER_TOKEN_TYPE,
          args.accessTokenType,
          "accessTokenType",
        );

        if (existing) {
          const machine = obj(existing.machine);
          if (existing.machine === undefined) {
            throw new Error(
              `user ${
                JSON.stringify(args.username)
              } exists and is not a machine user`,
            );
          }
          // An omitted description means "leave it as it is": Zitadel refuses an
          // empty one, so there is no way to clear it through this API anyway.
          const same = str(machine.name) === args.name &&
            (args.description === undefined ||
              str(machine.description) === args.description) &&
            str(machine.accessTokenType || "ACCESS_TOKEN_TYPE_BEARER") ===
              tokenType;
          if (same) {
            context.logger.info("machine user {username} is already as asked", {
              username: args.username,
            });
            return {
              dataHandles: await writeUser(context, existing, "unchanged"),
            };
          }
          const userId = str(existing.userId ?? existing.id);
          await call(globalArgs, {
            method: "PATCH",
            path: v2(`/users/${seg(userId)}`),
            body: {
              machine: {
                name: args.name,
                ...(args.description === undefined
                  ? {}
                  : { description: args.description }),
                accessTokenType: tokenType,
              },
            },
          });
          context.logger.info("converged machine user {username}", {
            username: args.username,
          });
          const after = await getUser(globalArgs, userId);
          return {
            dataHandles: await writeUser(context, after ?? existing, "updated"),
          };
        }

        context.logger.info("creating machine user {username}", {
          username: args.username,
        });
        const created = await call(globalArgs, {
          method: "POST",
          path: v2("/users/new"),
          body: {
            organizationId: await resolveOrgId(globalArgs),
            username: args.username,
            machine: {
              name: args.name,
              ...(args.description === undefined
                ? {}
                : { description: args.description }),
              accessTokenType: tokenType,
            },
          },
        });
        const after = await getUser(globalArgs, str(created.body.id));
        return {
          dataHandles: await writeUser(
            context,
            after ?? {
              userId: str(created.body.id),
              username: args.username,
              machine: { name: args.name },
            },
            "created",
          ),
        };
      },
    },
    ensureHuman: {
      kind: "create" as const,
      description:
        "Find or create a human user by username, converging their name and email. Idempotent, and sets no password: the person sets one from a passwordResetLinkCreate link, or from the mail Zitadel sends.",
      arguments: EnsureHumanArgs,
      execute: async (
        args: z.infer<typeof EnsureHumanArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        assertArg(args.username, "username");
        const globalArgs = context.globalArgs;
        const existing = await findUserByUsername(globalArgs, args.username);
        const profile = humanProfile(args);

        if (existing) {
          if (existing.human === undefined) {
            throw new Error(
              `user ${
                JSON.stringify(args.username)
              } exists and is not a human user`,
            );
          }
          const human = obj(existing.human);
          const liveProfile = obj(human.profile);
          const liveEmail = obj(human.email);
          const same = str(liveProfile.givenName) === args.givenName &&
            str(liveProfile.familyName) === args.familyName &&
            str(liveEmail.email) === args.email;
          if (same) {
            context.logger.info("human user {username} is already as asked", {
              username: args.username,
            });
            return {
              dataHandles: await writeUser(context, existing, "unchanged"),
            };
          }
          const userId = str(existing.userId ?? existing.id);
          await call(globalArgs, {
            method: "PATCH",
            path: v2(`/users/${seg(userId)}`),
            body: {
              human: {
                ...(profile ? { profile } : {}),
                email: {
                  email: args.email,
                  ...(args.emailVerified ? { isVerified: true } : {}),
                },
              },
            },
          });
          context.logger.info("converged human user {username}", {
            username: args.username,
          });
          const after = await getUser(globalArgs, userId);
          return {
            dataHandles: await writeUser(context, after ?? existing, "updated"),
          };
        }

        context.logger.info("creating human user {username}", {
          username: args.username,
        });
        const human: Record<string, unknown> = {
          ...(profile ? { profile } : {}),
          email: {
            email: args.email,
            ...(args.emailVerified ? { isVerified: true } : {}),
          },
        };
        if (args.phone) human.phone = { phone: args.phone };
        const created = await call(globalArgs, {
          method: "POST",
          path: v2("/users/new"),
          body: {
            organizationId: await resolveOrgId(globalArgs),
            username: args.username,
            human,
          },
        });
        const after = await getUser(globalArgs, str(created.body.id));
        return {
          dataHandles: await writeUser(
            context,
            after ?? {
              userId: str(created.body.id),
              username: args.username,
              human,
            },
            "created",
          ),
        };
      },
    },
    update: {
      description:
        "Change a user's login name, a human's profile or email, or a machine's name, description and token type. Only what is given is sent. Never a password.",
      arguments: UpdateArgs,
      execute: async (
        args: z.infer<typeof UpdateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const body: Record<string, unknown> = {};
        if (args.username) body.username = args.username;

        const profile = humanProfile(args);
        const human: Record<string, unknown> = {};
        if (profile) human.profile = profile;
        if (args.email) {
          human.email = {
            email: args.email,
            ...(args.emailVerified ? { isVerified: true } : {}),
          };
        }
        if (args.phone) human.phone = { phone: args.phone };
        if (Object.keys(human).length) body.human = human;

        const machine: Record<string, unknown> = {};
        if (args.name) machine.name = args.name;
        if (args.description) machine.description = args.description;
        if (args.accessTokenType) {
          machine.accessTokenType = mapEnum(
            USER_TOKEN_TYPE,
            args.accessTokenType,
            "accessTokenType",
          );
        }
        if (Object.keys(machine).length) body.machine = machine;

        if (Object.keys(body).length === 0) {
          context.logger.info("nothing to change on user {id}", { id: userId });
          return { dataHandles: await writeUser(context, live, "unchanged") };
        }
        await call(globalArgs, {
          method: "PATCH",
          path: v2(`/users/${seg(userId)}`),
          body,
        });
        context.logger.info("updated user {id}", { id: userId });
        const after = await getUser(globalArgs, userId);
        return {
          dataHandles: await writeUser(context, after ?? live, "updated"),
        };
      },
    },
    setState: {
      description:
        "Deactivate, reactivate, lock or unlock a user. Every direction is reversible, and asking for the state a user is already in changes nothing.",
      arguments: SetStateArgs,
      execute: async (
        args: z.infer<typeof SetStateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username);
        const before = friendlyState(live.state);
        const timestamp = nowIso();
        const write = (
          state: string,
          action: "unchanged" | "deactivated" | "reactivated" | "locked",
        ) =>
          writeOne(context, "state", "user-state", username, {
            kind: "user",
            id: userId,
            name: username,
            previousState: before,
            state,
            action,
            timestamp,
          });

        if (before === args.state) {
          context.logger.info("user {username} is already {state}", {
            username,
            state: args.state,
          });
          return { dataHandles: await write(before, "unchanged") };
        }
        const endpoint = args.state === "inactive"
          ? "deactivate"
          : args.state === "locked"
          ? "lock"
          : before === "locked"
          ? "unlock"
          : "reactivate";
        await call(globalArgs, {
          method: "POST",
          path: v2(`/users/${seg(userId)}/${endpoint}`),
          body: {},
        });
        context.logger.info("user {username} is now {state}", {
          username,
          state: args.state,
        });
        const action = args.state === "inactive"
          ? "deactivated"
          : args.state === "locked"
          ? "locked"
          : "reactivated";
        return { dataHandles: await write(args.state, action) };
      },
    },
    delete: {
      kind: "action" as const,
      description:
        "Delete a user and everything that belongs to them — grants, tokens, keys. Verify-first: confirm must repeat the live username, and dryRun only reports. Prefer setState inactive, which is reversible.",
      arguments: DeleteArgs,
      execute: async (
        args: z.infer<typeof DeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const timestamp = nowIso();
        const live = await tryResolveUser(globalArgs, args.user);
        if (!live) {
          context.logger.warning("no user {user}; nothing to delete", {
            user: args.user,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "user-deletion",
              args.user,
              {
                kind: "user",
                id: "",
                name: args.user,
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        const userId = str(live.userId ?? live.id);
        const username = str(live.username);
        requireConfirm(username, args.confirm, "username");
        if (args.dryRun) {
          context.logger.info("dry run: would delete user {username}", {
            username,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "user-deletion",
              username,
              {
                kind: "user",
                id: userId,
                name: username,
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }
        await call(globalArgs, {
          method: "DELETE",
          path: v2(`/users/${seg(userId)}`),
        });
        await forgetInstance(context, "user", username);
        context.logger.warning("deleted user {username}", { username });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "user-deletion",
            userId,
            {
              kind: "user",
              id: userId,
              name: username,
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
    patCreate: {
      description:
        "Add a personal access token to a user. Returns the token once, marked sensitive.",
      arguments: PatCreateArgs,
      execute: async (
        args: z.infer<typeof PatCreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        const body: Record<string, unknown> = {
          expirationDate: args.expirationDate,
        };
        context.logger.info("creating a personal access token for {username}", {
          username: str(live.username),
        });
        const created = await call(globalArgs, {
          method: "POST",
          path: v2(`/users/${seg(userId)}/pats`),
          body,
        });
        return {
          dataHandles: await writeOne(
            context,
            "user-credential",
            "user-credential",
            `${username}-pat-${str(created.body.tokenId)}`,
            {
              userId,
              username: str(live.username),
              kind: "pat",
              credentialId: str(created.body.tokenId),
              expirationDate: args.expirationDate,
              secret: str(created.body.token),
              action: "created",
              timestamp: nowIso(),
            },
          ),
        };
      },
    },
    patList: {
      kind: "list" as const,
      description:
        "List a user's personal access tokens by id and expiry. Read-only; a token's value is not readable after it was created.",
      arguments: PatListArgs,
      execute: async (
        args: z.infer<typeof PatListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        const rows = await searchAllV2(
          globalArgs,
          v2("/users/pats/search"),
          userFilter(userId),
        );
        const timestamp = nowIso();
        const tokens = rows.map((row) => ({
          userId,
          kind: "pat",
          id: str(row.id),
          creationDate: optStr(row.creationDate),
          expirationDate: optStr(row.expirationDate),
          action: "observed" as const,
          timestamp,
        }));
        const handles = await writeAll(
          context,
          "credential",
          "pat",
          tokens,
          (token) => `${username}-${token.id}`,
        );
        context.logger.info("stored {count} personal access tokens", {
          count: tokens.length,
        });
        return { dataHandles: handles };
      },
    },
    patRevoke: {
      kind: "action" as const,
      description:
        "Revoke a personal access token, verifying first that it belongs to the user. dryRun only reports.",
      arguments: PatRevokeArgs,
      execute: async (
        args: z.infer<typeof PatRevokeArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        const rows = await searchAllV2(
          globalArgs,
          v2("/users/pats/search"),
          userFilter(userId),
        );
        const timestamp = nowIso();
        if (!rows.some((row) => str(row.id) === args.tokenId)) {
          context.logger.warning("user {username} has no token {token}", {
            username: str(live.username),
            token: args.tokenId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "pat-deletion",
              `${username}-${args.tokenId}`,
              {
                kind: "pat",
                id: args.tokenId,
                name: str(live.username),
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        if (args.dryRun) {
          context.logger.info("dry run: would revoke token {token}", {
            token: args.tokenId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "pat-deletion",
              `${username}-${args.tokenId}`,
              {
                kind: "pat",
                id: args.tokenId,
                name: str(live.username),
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }
        await call(globalArgs, {
          method: "DELETE",
          path: v2(`/users/${seg(userId)}/pats/${seg(args.tokenId)}`),
        });
        await forgetInstance(context, "pat", `${username}-${args.tokenId}`);
        context.logger.warning("revoked token {token}", {
          token: args.tokenId,
        });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "pat-deletion",
            `${username}-${args.tokenId}`,
            {
              kind: "pat",
              id: args.tokenId,
              name: str(live.username),
              deleted: true,
              action: "revoked",
              timestamp,
            },
          ),
        };
      },
    },
    keyCreate: {
      description:
        "Add a private key to a machine user, or register a public key you hold. Returns the generated key JSON once, marked sensitive.",
      arguments: KeyCreateArgs,
      execute: async (
        args: z.infer<typeof KeyCreateArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        const body: Record<string, unknown> = {
          expirationDate: args.expirationDate,
        };
        if (args.publicKey) body.publicKey = toBase64(args.publicKey);
        context.logger.info("creating a key for {username}", {
          username: str(live.username),
        });
        const created = await call(globalArgs, {
          method: "POST",
          path: v2(`/users/${seg(userId)}/keys`),
          body,
        });
        const content = created.body.keyContent;
        const secret = typeof content === "string" && content.length > 0
          ? fromBase64(content)
          : "";
        return {
          dataHandles: await writeOne(
            context,
            "user-credential",
            "user-credential",
            `${username}-key-${str(created.body.keyId)}`,
            {
              userId,
              username: str(live.username),
              kind: "key",
              credentialId: str(created.body.keyId),
              expirationDate: args.expirationDate,
              secret,
              action: "created",
              timestamp: nowIso(),
            },
          ),
        };
      },
    },
    keyList: {
      kind: "list" as const,
      description:
        "List a user's keys by id and expiry. Read-only; key material is not readable after it was created.",
      arguments: KeyListArgs,
      execute: async (
        args: z.infer<typeof KeyListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        const rows = await searchAllV2(
          globalArgs,
          v2("/users/keys/search"),
          userFilter(userId),
        );
        const timestamp = nowIso();
        const keys = rows.map((row) => ({
          userId,
          kind: "key",
          id: str(row.id),
          creationDate: optStr(row.creationDate),
          expirationDate: optStr(row.expirationDate),
          action: "observed" as const,
          timestamp,
        }));
        const handles = await writeAll(
          context,
          "credential",
          "key",
          keys,
          (key) => `${username}-${key.id}`,
        );
        context.logger.info("stored {count} keys", { count: keys.length });
        return { dataHandles: handles };
      },
    },
    keyDelete: {
      kind: "action" as const,
      description:
        "Delete a user's key, verifying first that it belongs to them. dryRun only reports.",
      arguments: KeyDeleteArgs,
      execute: async (
        args: z.infer<typeof KeyDeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        const rows = await searchAllV2(
          globalArgs,
          v2("/users/keys/search"),
          userFilter(userId),
        );
        const timestamp = nowIso();
        if (!rows.some((row) => str(row.id) === args.keyId)) {
          context.logger.warning("user {username} has no key {key}", {
            username: str(live.username),
            key: args.keyId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "user-key-deletion",
              `${username}-${args.keyId}`,
              {
                kind: "key",
                id: args.keyId,
                name: str(live.username),
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        if (args.dryRun) {
          context.logger.info("dry run: would delete key {key}", {
            key: args.keyId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "user-key-deletion",
              `${username}-${args.keyId}`,
              {
                kind: "key",
                id: args.keyId,
                name: str(live.username),
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }
        await call(globalArgs, {
          method: "DELETE",
          path: v2(`/users/${seg(userId)}/keys/${seg(args.keyId)}`),
        });
        await forgetInstance(context, "key", `${username}-${args.keyId}`);
        context.logger.warning("deleted key {key}", { key: args.keyId });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "user-key-deletion",
            `${username}-${args.keyId}`,
            {
              kind: "key",
              id: args.keyId,
              name: str(live.username),
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
    secretGenerate: {
      description:
        "Generate a machine user's client secret, replacing any previous one. Returns it once, marked sensitive.",
      arguments: SecretArgs,
      execute: async (
        args: z.infer<typeof SecretArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        const hadSecret = obj(live.machine).hasSecret === true;
        context.logger.info("generating a client secret for {username}", {
          username: str(live.username),
        });
        const created = await call(globalArgs, {
          method: "POST",
          path: v2(`/users/${seg(userId)}/secret`),
          body: {},
        });
        return {
          dataHandles: await writeOne(
            context,
            "user-credential",
            "user-credential",
            `${username}-secret`,
            {
              userId,
              username: str(live.username),
              kind: "secret",
              secret: str(created.body.clientSecret),
              action: hadSecret ? "rotated" : "created",
              timestamp: nowIso(),
            },
          ),
        };
      },
    },
    secretRemove: {
      kind: "action" as const,
      description:
        "Remove a machine user's client secret, leaving the user in place. dryRun only reports.",
      arguments: SecretRemoveArgs,
      execute: async (
        args: z.infer<typeof SecretRemoveArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username);
        const timestamp = nowIso();
        if (args.dryRun) {
          context.logger.info(
            "dry run: would remove the secret of {username}",
            {
              username,
            },
          );
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "user-secret-deletion",
              username,
              {
                kind: "secret",
                id: userId,
                name: username,
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }
        await call(globalArgs, {
          method: "DELETE",
          path: v2(`/users/${seg(userId)}/secret`),
        });
        context.logger.warning("removed the client secret of {username}", {
          username,
        });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "user-secret-deletion",
            username,
            {
              kind: "secret",
              id: userId,
              name: username,
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
    metadataSet: {
      description:
        "Set one metadata entry on a user, creating or overwriting it. Idempotent.",
      arguments: MetadataSetArgs,
      execute: async (
        args: z.infer<typeof MetadataSetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        context.logger.info("setting metadata {key} on {username}", {
          key: args.key,
          username: str(live.username),
        });
        await call(globalArgs, {
          method: "POST",
          path: v2(`/users/${seg(userId)}/metadata`),
          body: {
            metadata: [{ key: args.key, value: toBase64(args.value) }],
          },
        });
        return {
          dataHandles: await writeOne(
            context,
            "metadata",
            "metadata",
            `${username}-${args.key}`,
            {
              userId,
              key: args.key,
              value: args.value,
              action: "updated",
              timestamp: nowIso(),
            },
          ),
        };
      },
    },
    metadataList: {
      kind: "list" as const,
      description:
        "List a user's metadata, decoding each value, and store one resource per entry. Read-only.",
      arguments: MetadataListArgs,
      execute: async (
        args: z.infer<typeof MetadataListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        const rows = await searchAllV2(
          globalArgs,
          v2(`/users/${seg(userId)}/metadata/search`),
          {},
          "pagination",
          "metadata",
        );
        const timestamp = nowIso();
        const entries = rows.map((row) => ({
          userId,
          key: str(row.key),
          value: typeof row.value === "string" && row.value.length > 0
            ? fromBase64(row.value)
            : "",
          action: "observed" as const,
          timestamp,
        }));
        const handles = await writeAll(
          context,
          "metadata",
          "metadata",
          entries,
          (entry) => `${username}-${entry.key}`,
        );
        context.logger.info("stored {count} metadata entries", {
          count: entries.length,
        });
        return { dataHandles: handles };
      },
    },
    metadataDelete: {
      kind: "action" as const,
      description:
        "Delete metadata entries from a user by key. dryRun only reports.",
      arguments: MetadataDeleteArgs,
      execute: async (
        args: z.infer<typeof MetadataDeleteArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        if (args.keys.length === 0) throw new Error("keys must not be empty");
        const timestamp = nowIso();
        const name = args.keys.join(",");
        if (args.dryRun) {
          context.logger.info("dry run: would delete metadata {keys}", {
            keys: name,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "metadata-deletion",
              `${username}-${name}`,
              {
                kind: "metadata",
                id: userId,
                name,
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }
        const query = args.keys.map((key) => `keys=${seg(key)}`).join("&");
        await call(globalArgs, {
          method: "DELETE",
          path: `${v2(`/users/${seg(userId)}/metadata`)}?${query}`,
        });
        context.logger.info("deleted metadata {keys}", { keys: name });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "metadata-deletion",
            `${username}-${name}`,
            {
              kind: "metadata",
              id: userId,
              name,
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
    passwordResetLinkCreate: {
      description:
        "Mint a password reset for a human user: either a code returned once into a sensitive spec, or a link Zitadel mails to them. No password is ever an argument here.",
      arguments: PasswordResetArgs,
      execute: async (
        args: z.infer<typeof PasswordResetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        if (live.human === undefined) {
          throw new Error(
            `user ${
              str(live.username)
            } is not a human user; a machine user has no password`,
          );
        }
        const body: Record<string, unknown> = args.delivery === "email"
          ? {
            sendLink: {
              notificationType: "NOTIFICATION_TYPE_Email",
              ...(args.urlTemplate ? { urlTemplate: args.urlTemplate } : {}),
            },
          }
          : { returnCode: {} };
        context.logger.info("requesting a password reset for {username}", {
          username: str(live.username),
          delivery: args.delivery,
        });
        const created = await call(globalArgs, {
          method: "POST",
          path: v2(`/users/${seg(userId)}/password_reset`),
          body,
        });
        return {
          dataHandles: await writeOne(
            context,
            "password-reset",
            "password-reset",
            username,
            {
              userId,
              username: str(live.username),
              delivery: args.delivery,
              verificationCode: optStr(created.body.verificationCode),
              action: "created",
              timestamp: nowIso(),
            },
          ),
        };
      },
    },
    authFactorList: {
      kind: "list" as const,
      description:
        "List what a person can prove who they are with — TOTP, U2F, a code by SMS or email, a passkey — and whether each is ready. Read-only, and the audit behind 'who here actually has MFA'.",
      arguments: AuthFactorListArgs,
      execute: async (
        args: z.infer<typeof AuthFactorListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username);
        context.logger.info(
          "listing the authentication factors of {username}",
          {
            username,
          },
        );
        const timestamp = nowIso();
        const factors: Record<string, unknown>[] = [];

        const second = await call(globalArgs, {
          method: "POST",
          path: v2(`/users/${seg(userId)}/authentication_factors/_search`),
          body: {},
        });
        for (const row of asArray(second.body.result)) {
          const state = friendlyState(row.state);
          const otp = row.otp === undefined ? undefined : obj(row.otp);
          const u2f = row.u2f === undefined ? undefined : obj(row.u2f);
          const otpSms = row.otpSms === undefined ? undefined : obj(row.otpSms);
          const otpEmail = row.otpEmail === undefined
            ? undefined
            : obj(row.otpEmail);
          const type = otp
            ? "totp"
            : u2f
            ? "u2f"
            : otpSms
            ? "otp-sms"
            : otpEmail
            ? "otp-email"
            : "unknown";
          factors.push({
            userId,
            username,
            type,
            id: optStr((u2f ?? {}).id),
            name: optStr((u2f ?? {}).name),
            state,
            action: "observed",
            timestamp,
          });
        }

        const passkeys = await call(globalArgs, {
          method: "POST",
          path: v2(`/users/${seg(userId)}/passkeys/_search`),
          body: {},
        });
        for (const row of asArray(passkeys.body.result)) {
          factors.push({
            userId,
            username,
            type: "passkey",
            id: optStr(row.id),
            name: optStr(row.name),
            state: friendlyState(row.state),
            action: "observed",
            timestamp,
          });
        }

        const handles = await writeAll(
          context,
          "auth-factor",
          "auth-factor",
          factors,
          (factor) =>
            `${username}-${str(factor.type)}-${str(factor.id) || "one"}`,
        );
        context.logger.info("stored {count} authentication factors", {
          count: factors.length,
        });
        return { dataHandles: handles };
      },
    },
    authFactorRemove: {
      kind: "action" as const,
      description:
        "Take one authentication factor away from a person — a lost phone, a retired key. Verify-first: the factor has to be there, and u2f and passkey need the id from authFactorList. dryRun only reports. The person can register a new factor afterwards; this does not lock them out by itself, but removing their last factor while MFA is forced will.",
      arguments: AuthFactorRemoveArgs,
      execute: async (
        args: z.infer<typeof AuthFactorRemoveArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username);
        const timestamp = nowIso();
        const key = `${username}-${args.type}-${args.id ?? "one"}`;
        const needsId = args.type === "u2f" || args.type === "passkey";
        if (needsId && !args.id) {
          throw new Error(
            `removing a ${args.type} needs its id; authFactorList has them`,
          );
        }

        // Verify the factor is there before asking Zitadel to take it away.
        let present = false;
        if (args.type === "passkey") {
          const passkeys = await call(globalArgs, {
            method: "POST",
            path: v2(`/users/${seg(userId)}/passkeys/_search`),
            body: {},
          });
          present = asArray(passkeys.body.result).some((row) =>
            str(row.id) === args.id
          );
        } else if (args.type === "recovery-codes") {
          present = true; // Zitadel has no listing for these; removal is a no-op when absent
        } else {
          const second = await call(globalArgs, {
            method: "POST",
            path: v2(`/users/${seg(userId)}/authentication_factors/_search`),
            body: {},
          });
          present = asArray(second.body.result).some((row) => {
            if (args.type === "totp") return row.otp !== undefined;
            if (args.type === "otp-sms") return row.otpSms !== undefined;
            if (args.type === "otp-email") return row.otpEmail !== undefined;
            return obj(row.u2f).id === args.id;
          });
        }

        if (!present) {
          context.logger.warning("{username} has no {type} factor to remove", {
            username,
            type: args.type,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "auth-factor-deletion",
              key,
              {
                kind: "auth-factor",
                id: args.id ?? args.type,
                name: username,
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        if (args.dryRun) {
          context.logger.info(
            "dry run: would remove the {type} of {username}",
            {
              type: args.type,
              username,
            },
          );
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "auth-factor-deletion",
              key,
              {
                kind: "auth-factor",
                id: args.id ?? args.type,
                name: username,
                deleted: false,
                action: "planned",
                timestamp,
              },
            ),
          };
        }

        const path = args.type === "totp"
          ? `/users/${seg(userId)}/totp`
          : args.type === "otp-sms"
          ? `/users/${seg(userId)}/otp_sms`
          : args.type === "otp-email"
          ? `/users/${seg(userId)}/otp_email`
          : args.type === "recovery-codes"
          ? `/users/${seg(userId)}/recovery_codes`
          : args.type === "u2f"
          ? `/users/${seg(userId)}/u2f/${seg(args.id ?? "")}`
          : `/users/${seg(userId)}/passkeys/${seg(args.id ?? "")}`;
        await call(globalArgs, { method: "DELETE", path: v2(path) });
        await forgetInstance(context, "auth-factor", key);
        context.logger.warning("removed the {type} of {username}", {
          type: args.type,
          username,
        });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "auth-factor-deletion",
            key,
            {
              kind: "auth-factor",
              id: args.id ?? args.type,
              name: username,
              deleted: true,
              action: "removed",
              timestamp,
            },
          ),
        };
      },
    },
    idpLinkList: {
      kind: "list" as const,
      description:
        "List the identity providers a person can log in through, and their account at each. Read-only.",
      arguments: IdpLinkListArgs,
      execute: async (
        args: z.infer<typeof IdpLinkListArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username) || userId;
        const rows = await searchAllV2(
          globalArgs,
          v2(`/users/${seg(userId)}/links/_search`),
          {},
          "query",
        );
        const timestamp = nowIso();
        const links = rows.map((row) => ({
          userId,
          idpId: str(row.idpId),
          externalUserId: optStr(row.userId),
          externalUserName: optStr(row.userName),
          action: "observed" as const,
          timestamp,
        }));
        const handles = await writeAll(
          context,
          "idp-link",
          "idp-link",
          links,
          (link) => `${username}-${link.idpId}`,
        );
        context.logger.info("stored {count} identity-provider links", {
          count: links.length,
        });
        return { dataHandles: handles };
      },
    },
    idpLinkRemove: {
      kind: "action" as const,
      description:
        "Unlink a person from an identity provider, verifying the link first. dryRun only reports. If that provider was their only way in, they will need a password or a passkey afterwards.",
      arguments: IdpLinkRemoveArgs,
      execute: async (
        args: z.infer<typeof IdpLinkRemoveArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const live = await resolveUser(globalArgs, args.user);
        const userId = str(live.userId ?? live.id);
        const username = str(live.username);
        const rows = await searchAllV2(
          globalArgs,
          v2(`/users/${seg(userId)}/links/_search`),
          {},
          "query",
        );
        const timestamp = nowIso();
        const key = `${username}-${args.idpId}`;
        if (
          !rows.some((row) =>
            str(row.idpId) === args.idpId &&
            str(row.userId) === args.externalUserId
          )
        ) {
          context.logger.warning("{username} has no link to {idp}", {
            username,
            idp: args.idpId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "idp-link-deletion",
              key,
              {
                kind: "idp-link",
                id: args.idpId,
                name: username,
                deleted: false,
                action: "unchanged",
                timestamp,
              },
            ),
          };
        }
        if (args.dryRun) {
          context.logger.info("dry run: would unlink {username} from {idp}", {
            username,
            idp: args.idpId,
          });
          return {
            dataHandles: await writeOne(
              context,
              "deletion",
              "idp-link-deletion",
              key,
              {
                kind: "idp-link",
                id: args.idpId,
                name: username,
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
            `/users/${seg(userId)}/links/${seg(args.idpId)}/${
              seg(args.externalUserId)
            }`,
          ),
        });
        await forgetInstance(context, "idp-link", key);
        context.logger.warning("unlinked {username} from {idp}", {
          username,
          idp: args.idpId,
        });
        return {
          dataHandles: await writeOne(
            context,
            "deletion",
            "idp-link-deletion",
            key,
            {
              kind: "idp-link",
              id: args.idpId,
              name: username,
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
