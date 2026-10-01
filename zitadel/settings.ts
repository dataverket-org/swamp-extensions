/**
 * `@dataverket/zitadel/settings` — what an organization's login, password,
 * lockout, branding and legal settings actually are, and where they come from.
 *
 * This type reads. Zitadel's v2 settings service answers with the values in
 * force for the context you ask about and a `resourceOwnerType` saying whether
 * they are the organization's own or inherited from the instance, which is the
 * question worth putting in a data model: not "what does the console show" but
 * "is this organization overriding the instance, and where". `read` fetches
 * every settings kind in one run and stores one resource per kind, so a
 * workflow can diff an organization against the instance, or one organization
 * against another, with CEL and no further calls.
 *
 * Only two settings are writable through v2, and both are here: the security
 * settings (iframe embedding and impersonation) and the hosted login
 * translations. Writing the login policy, lockout, password complexity,
 * branding or legal links is still the v1 Management API for an organization
 * and the v1 Admin API instance-wide, and neither is in this extension: a
 * service-user key that can read every policy is a much smaller thing to hold
 * than one that can weaken them.
 *
 * @module
 */
import { z } from "npm:zod@4";
import { asArray, call, type Json, seg, v2 } from "./api.ts";
import {
  boolArg,
  checks,
  type DataHandle,
  GlobalArgsSchema,
  jsonArray,
  type MethodResult,
  type ModelContext,
  nowIso,
  obj,
  optStr,
  optStrList,
  str,
  writeAll,
  writeOne,
} from "./common.ts";
import {
  ActiveIdentityProvider,
  BrandingSettings,
  DomainSettings,
  GeneralSettings,
  LegalSupportSettings,
  LockoutSettings,
  LoginSettings,
  LoginTranslation,
  PasswordComplexitySettings,
  PasswordExpirySettings,
  SecuritySettings,
  settingsScope,
} from "./schema.ts";

const ReadArgs = z.object({
  orgId: z.string().optional().describe(
    "The organization to read the settings of; omit for the model's own " +
      "organization, or pass instance=true for the instance defaults",
  ),
  instance: boolArg(false).describe(
    "Read the instance defaults rather than an organization's settings",
  ),
});
const SecuritySetArgs = z.object({
  iframeEmbeddingEnabled: z.boolean().describe(
    "Whether the login UI may be embedded in an iframe at all",
  ),
  allowedOrigins: jsonArray(z.string()).default([]).describe(
    "The origins that may embed it; meaningless when embedding is off",
  ),
  enableImpersonation: z.boolean().describe(
    "Whether a holder of an *_IMPERSONATOR role may act as another user",
  ),
});
const TranslationSetArgs = z.object({
  locale: z.string().min(2).describe("BCP-47 tag, e.g. nb, en or fr-CH"),
  translations: z.string().describe(
    'The translations as a JSON object, e.g. {"common":{"back":"Tilbake"}}',
  ),
  orgId: z.string().optional().describe(
    "The organization to set them for; omit with instance=true for the instance",
  ),
  instance: boolArg(false).describe("Set the instance's translations instead"),
});

/** The `ctx` query the settings service scopes a read by. */
function contextQuery(orgId: string | undefined, instance: boolean): string {
  if (instance) return "?ctx.instance=true";
  return orgId ? `?ctx.orgId=${seg(orgId)}` : "";
}

/**
 * A settings boolean, as it is in force. Zitadel omits a `false` (proto3 drops
 * zero values), and an audit record where `forceMfa` is simply absent reads as
 * "nobody knows" when it means "off" — so an absent boolean becomes `false`.
 */
function flag(value: unknown): boolean {
  return value === true;
}

/** One settings kind: where to read it and how to shape what comes back. */
interface SettingsKind {
  spec: string;
  path: string;
  field: string;
  shape: (raw: Json) => Record<string, unknown>;
}

const KINDS: SettingsKind[] = [
  {
    spec: "login",
    path: "/settings/login",
    field: "settings",
    shape: (raw) => ({
      allowUsernamePassword: flag(raw.allowUsernamePassword),
      allowRegister: flag(raw.allowRegister),
      allowExternalIdp: flag(raw.allowExternalIdp),
      allowDomainDiscovery: flag(raw.allowDomainDiscovery),
      allowLocalAuthentication: flag(raw.allowLocalAuthentication),
      forceMfa: flag(raw.forceMfa),
      forceMfaLocalOnly: flag(raw.forceMfaLocalOnly),
      hidePasswordReset: flag(raw.hidePasswordReset),
      ignoreUnknownUsernames: flag(raw.ignoreUnknownUsernames),
      disableLoginWithEmail: flag(raw.disableLoginWithEmail),
      disableLoginWithPhone: flag(raw.disableLoginWithPhone),
      passkeysType: optStr(raw.passkeysType),
      defaultRedirectUri: optStr(raw.defaultRedirectUri),
      secondFactors: optStrList(raw.secondFactors),
      multiFactors: optStrList(raw.multiFactors),
      passwordCheckLifetime: optStr(raw.passwordCheckLifetime),
      externalLoginCheckLifetime: optStr(raw.externalLoginCheckLifetime),
      multiFactorCheckLifetime: optStr(raw.multiFactorCheckLifetime),
      secondFactorCheckLifetime: optStr(raw.secondFactorCheckLifetime),
      mfaInitSkipLifetime: optStr(raw.mfaInitSkipLifetime),
    }),
  },
  {
    spec: "lockout",
    path: "/settings/lockout",
    field: "settings",
    shape: (raw) => ({
      maxPasswordAttempts: Number(raw.maxPasswordAttempts ?? 0),
      maxOtpAttempts: Number(raw.maxOtpAttempts ?? 0),
    }),
  },
  {
    spec: "password-complexity",
    path: "/settings/password/complexity",
    field: "settings",
    shape: (raw) => ({
      minLength: Number(raw.minLength ?? 0),
      requiresUppercase: flag(raw.requiresUppercase),
      requiresLowercase: flag(raw.requiresLowercase),
      requiresNumber: flag(raw.requiresNumber),
      requiresSymbol: flag(raw.requiresSymbol),
    }),
  },
  {
    spec: "password-expiry",
    path: "/settings/password/expiry",
    field: "settings",
    shape: (raw) => ({
      maxAgeDays: Number(raw.maxAgeDays ?? 0),
      expireWarnDays: Number(raw.expireWarnDays ?? 0),
    }),
  },
  {
    spec: "branding",
    path: "/settings/branding",
    field: "settings",
    shape: (raw) => ({
      themeMode: optStr(raw.themeMode),
      hideLoginNameSuffix: flag(raw.hideLoginNameSuffix),
      disableWatermark: flag(raw.disableWatermark),
      fontUrl: optStr(raw.fontUrl),
    }),
  },
  {
    spec: "domain",
    path: "/settings/domain",
    field: "settings",
    shape: (raw) => ({
      loginNameIncludesDomain: flag(raw.loginNameIncludesDomain),
      requireOrgDomainVerification: flag(raw.requireOrgDomainVerification),
      smtpSenderAddressMatchesInstanceDomain: flag(
        raw.smtpSenderAddressMatchesInstanceDomain,
      ),
    }),
  },
  {
    spec: "legal-support",
    path: "/settings/legal_support",
    field: "settings",
    shape: (raw) => ({
      tosLink: optStr(raw.tosLink),
      privacyPolicyLink: optStr(raw.privacyPolicyLink),
      helpLink: optStr(raw.helpLink),
      supportEmail: optStr(raw.supportEmail),
      docsLink: optStr(raw.docsLink),
      customLink: optStr(raw.customLink),
      customLinkText: optStr(raw.customLinkText),
    }),
  },
  {
    spec: "security",
    path: "/settings/security",
    field: "settings",
    shape: (raw) => ({
      iframeEmbeddingEnabled: flag(obj(raw.embeddedIframe).enabled),
      allowedOrigins: optStrList(obj(raw.embeddedIframe).allowedOrigins),
      enableImpersonation: flag(raw.enableImpersonation),
    }),
  },
  {
    spec: "general",
    path: "/settings",
    field: "",
    shape: (raw) => ({
      defaultLanguage: optStr(raw.defaultLanguage),
      supportedLanguages: optStrList(raw.supportedLanguages),
      allowedLanguages: optStrList(raw.allowedLanguages),
      defaultOrgId: optStr(raw.defaultOrgId ?? raw.defaultOrganizationId),
    }),
  },
];

/** Zitadel settings, as they are in force. */
export const model = {
  type: "@dataverket/zitadel/settings",
  version: "2026.10.01.3",
  upgrades: [
    {
      toVersion: "2026.10.01.3",
      description: "keyJsonFile expands a leading ~/; no argument changed",
      upgradeAttributes: (old: Record<string, unknown>) => old,
    },
  ],
  globalArguments: GlobalArgsSchema,
  checks,
  resources: {
    login: {
      description:
        "How a login may be done, and how long each factor is trusted",
      schema: LoginSettings,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    lockout: {
      description: "How many wrong answers lock an account",
      schema: LockoutSettings,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "password-complexity": {
      description: "What a password has to look like",
      schema: PasswordComplexitySettings,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "password-expiry": {
      description: "How long a password lives",
      schema: PasswordExpirySettings,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    branding: {
      description: "What the login screen looks like",
      schema: BrandingSettings,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    domain: {
      description: "How login names and domains are handled",
      schema: DomainSettings,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "legal-support": {
      description: "The links a login screen shows, and who to ask for help",
      schema: LegalSupportSettings,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    security: {
      description: "Whether the login UI may be framed, and impersonation",
      schema: SecuritySettings,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "login-translation": {
      description: "A locale whose hosted-login translations were set",
      schema: LoginTranslation,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    general: {
      description: "The instance's languages and default organization",
      schema: GeneralSettings,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
    "identity-provider": {
      description: "An identity provider a person may log in with",
      schema: ActiveIdentityProvider,
      lifetime: "infinite" as const,
      garbageCollection: 10,
    },
  },
  methods: {
    read: {
      kind: "list" as const,
      description:
        "Read every settings kind in force for one organization, or for the instance, and store one resource per kind — each saying whether the values are the organization's own or inherited. Read-only, one run, one lock.",
      arguments: ReadArgs,
      execute: async (
        args: z.infer<typeof ReadArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        const orgId = args.instance ? undefined : optStr(args.orgId) ??
          optStr(globalArgs.orgId);
        const query = contextQuery(orgId, args.instance);
        const timestamp = nowIso();
        context.logger.info("reading the settings of {scope}", {
          scope: args.instance
            ? "the instance"
            : orgId ?? "the model's organization",
        });

        const handles: DataHandle[] = [];
        for (const kind of KINDS) {
          const result = await call(globalArgs, {
            method: "GET",
            path: v2(kind.path) + query,
          });
          const raw = kind.field ? obj(result.body[kind.field]) : result.body;
          handles.push(
            ...await writeOne(
              context,
              kind.spec,
              kind.spec,
              orgId ?? (args.instance ? "instance" : "org"),
              { ...kind.shape(raw), ...settingsScope(raw, orgId, timestamp) },
            ),
          );
        }

        const idps = await call(globalArgs, {
          method: "GET",
          path: v2("/settings/login/idps") + query,
        });
        const providers = asArray(idps.body.identityProviders).map((row) => ({
          id: str(row.id),
          name: optStr(row.name),
          type: optStr(row.type),
          ...settingsScope({}, orgId, timestamp),
        }));
        handles.push(
          ...await writeAll(
            context,
            "identity-provider",
            "identity-provider",
            providers,
            (provider) =>
              `${orgId ?? "instance"}-${
                str(provider.name) || str(provider.id)
              }`,
          ),
        );

        context.logger.info("stored {count} settings resources", {
          count: handles.length,
        });
        return { dataHandles: handles };
      },
    },
    securitySet: {
      description:
        "Set the instance's security settings: whether the login UI may be embedded in an iframe, from which origins, and whether impersonation is allowed. Instance-wide — there is no per-organization version of this one.",
      arguments: SecuritySetArgs,
      execute: async (
        args: z.infer<typeof SecuritySetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        context.logger.info(
          "setting security settings: iframe {iframe}, impersonation {impersonation}",
          {
            iframe: args.iframeEmbeddingEnabled,
            impersonation: args.enableImpersonation,
          },
        );
        let action: "updated" | "unchanged" = "updated";
        try {
          await call(globalArgs, {
            method: "PUT",
            path: v2("/policies/security"),
            body: {
              embeddedIframe: {
                enabled: args.iframeEmbeddingEnabled,
                allowedOrigins: args.allowedOrigins,
              },
              enableImpersonation: args.enableImpersonation,
            },
          });
        } catch (err) {
          // Zitadel answers a write that changes nothing with 400 "No changes";
          // that is this method being idempotent, not a failure.
          const message = err instanceof Error ? err.message : String(err);
          if (!/no changes/i.test(message)) throw err;
          action = "unchanged";
        }
        const after = await call(globalArgs, {
          method: "GET",
          path: v2("/settings/security"),
        });
        const raw = obj(after.body.settings);
        return {
          dataHandles: await writeOne(
            context,
            "security",
            "security",
            "instance",
            {
              iframeEmbeddingEnabled: flag(obj(raw.embeddedIframe).enabled),
              allowedOrigins: optStrList(
                obj(raw.embeddedIframe).allowedOrigins,
              ),
              enableImpersonation: flag(raw.enableImpersonation),
              ...settingsScope(raw, undefined, nowIso()),
              action,
            },
          ),
        };
      },
    },
    loginTranslationSet: {
      description:
        "Set the hosted login screen's translations for one locale, for an organization or for the instance. The translations are a JSON object of the keys Zitadel's login UI uses.",
      arguments: TranslationSetArgs,
      execute: async (
        args: z.infer<typeof TranslationSetArgs>,
        context: ModelContext,
      ): Promise<MethodResult> => {
        const globalArgs = context.globalArgs;
        let translations: unknown;
        try {
          translations = JSON.parse(args.translations);
        } catch {
          throw new Error("translations is not valid JSON");
        }
        const orgId = args.instance ? undefined : optStr(args.orgId) ??
          optStr(globalArgs.orgId);
        if (!args.instance && !orgId) {
          throw new Error(
            "name the organization with orgId, or pass instance=true",
          );
        }
        context.logger.info("setting {locale} login translations for {scope}", {
          locale: args.locale,
          scope: args.instance ? "the instance" : orgId,
        });
        await call(globalArgs, {
          method: "PUT",
          path: v2("/settings/hosted_login_translation"),
          body: {
            locale: args.locale,
            translations,
            ...(args.instance ? { instance: true } : { organizationId: orgId }),
          },
        });
        return {
          dataHandles: await writeOne(
            context,
            "login-translation",
            "login-translation",
            `${orgId ?? "instance"}-${args.locale}`,
            {
              locale: args.locale,
              scope: args.instance ? "instance" : "org",
              orgId,
              action: "updated",
              timestamp: nowIso(),
            },
          ),
        };
      },
    },
  },
};
