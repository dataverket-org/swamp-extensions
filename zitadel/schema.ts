/**
 * `@dataverket/zitadel` — the shapes every model stores, and the functions that
 * turn a Zitadel API record into one.
 *
 * Every resource carries an `action` saying what the run did to it and a
 * `timestamp`, so a stored record reads as an event as well as a state. A
 * secret appears in exactly one spec, exactly once, and is marked sensitive so
 * swamp vaults it and keeps it out of logs.
 *
 * @module
 */
import { z } from "npm:zod@4";
import {
  ACCESS_TOKEN_TYPE,
  Action,
  APP_TYPE,
  friendlyEnumArray,
  friendlyState,
  GRANT_TYPE,
  invertEnum,
  obj,
  optBool,
  optStr,
  optStrList,
  RESPONSE_TYPE,
  str,
} from "./common.ts";
import type { Json } from "./api.ts";

const APP_TYPE_REV = invertEnum(APP_TYPE);
const ACCESS_TOKEN_TYPE_REV = invertEnum(ACCESS_TOKEN_TYPE);
const RESPONSE_TYPE_REV = invertEnum(RESPONSE_TYPE);
const GRANT_TYPE_REV = invertEnum(GRANT_TYPE);

/** An organization. */
export const OrgInfo = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string().describe("active, inactive or removed"),
  primaryDomain: z.string().optional(),
  action: Action,
  timestamp: z.string(),
});

/** An organization manager (member) and the manager roles they hold. */
export const ManagerInfo = z.object({
  orgId: z.string(),
  userId: z.string(),
  displayName: z.string().optional(),
  preferredLoginName: z.string().optional(),
  email: z.string().optional(),
  roles: z.array(z.string()).describe("Manager roles, e.g. ORG_OWNER"),
  action: Action,
  timestamp: z.string(),
});

/** A project. */
export const ProjectInfo = z.object({
  id: z.string(),
  name: z.string(),
  state: z.string().describe("active or inactive"),
  roleAssertion: z.boolean().optional().describe(
    "Roles are asserted into the token and the userinfo endpoint",
  ),
  roleCheck: z.boolean().optional().describe(
    "A user must hold a role of this project to log in",
  ),
  hasProjectCheck: z.boolean().optional().describe(
    "The user's organization must be granted this project to log in",
  ),
  action: Action,
  timestamp: z.string(),
});

/** A project role. */
export const RoleInfo = z.object({
  projectId: z.string(),
  key: z.string().describe("The role key, as it appears in a token claim"),
  displayName: z.string().optional(),
  group: z.string().optional(),
  action: Action,
  timestamp: z.string(),
});

/** An application's configuration. Never carries a secret. */
export const AppInfo = z.object({
  projectId: z.string(),
  appId: z.string(),
  name: z.string(),
  state: z.string(),
  kind: z.string().describe("oidc, api, saml or unknown"),
  clientId: z.string().optional(),
  appType: z.string().optional().describe("OIDC app type: web, spa or native"),
  accessTokenType: z.string().optional().describe("bearer or jwt"),
  authMethod: z.string().optional(),
  redirectUris: z.array(z.string()).optional(),
  postLogoutUris: z.array(z.string()).optional(),
  responseTypes: z.array(z.string()).optional(),
  grantTypes: z.array(z.string()).optional(),
  devMode: z.boolean().optional(),
  action: Action,
  timestamp: z.string(),
});

/** An application's client credentials, emitted once at create or rotate. */
export const AppCredential = z.object({
  projectId: z.string(),
  appId: z.string(),
  name: z.string(),
  clientId: z.string(),
  clientSecret: z.string().optional().meta({ sensitive: true }).describe(
    "Emitted once; absent for auth methods that have no secret",
  ),
  action: Action,
  timestamp: z.string(),
});

/** An application key (a private key for an API application), emitted once. */
export const AppKey = z.object({
  projectId: z.string(),
  appId: z.string(),
  keyId: z.string(),
  type: z.string().optional(),
  expirationDate: z.string().optional(),
  keyJson: z.string().optional().meta({ sensitive: true }).describe(
    "The downloadable key JSON, emitted once at create",
  ),
  action: Action,
  timestamp: z.string(),
});

/** The outcome of changing an OIDC application's redirect allowlist. */
export const OidcRedirectResult = z.object({
  projectId: z.string(),
  appId: z.string(),
  name: z.string(),
  redirectUris: z.array(z.string()),
  postLogoutUris: z.array(z.string()),
  added: z.array(z.string()),
  removed: z.array(z.string()),
  action: Action,
  timestamp: z.string(),
});

/** A user, human or machine. */
export const UserInfo = z.object({
  id: z.string(),
  username: z.string(),
  type: z.string().describe("human, machine or unknown"),
  state: z.string().describe("active, inactive, locked or initial"),
  preferredLoginName: z.string().optional(),
  loginNames: z.array(z.string()).optional(),
  displayName: z.string().optional(),
  givenName: z.string().optional(),
  familyName: z.string().optional(),
  email: z.string().optional(),
  emailVerified: z.boolean().optional(),
  phone: z.string().optional(),
  description: z.string().optional().describe("Machine users only"),
  accessTokenType: z.string().optional().describe(
    "Machine users: bearer or jwt",
  ),
  hasSecret: z.boolean().optional().describe("Machine users: a secret is set"),
  action: Action,
  timestamp: z.string(),
});

/** A credential minted for a user: a PAT, a key or a client secret, once. */
export const UserCredential = z.object({
  userId: z.string(),
  username: z.string().optional(),
  kind: z.string().describe("pat, key or secret"),
  credentialId: z.string().optional().describe("Token id or key id"),
  expirationDate: z.string().optional(),
  secret: z.string().meta({ sensitive: true }).describe(
    "The token, key JSON or client secret — emitted once, never readable again",
  ),
  action: Action,
  timestamp: z.string(),
});

/** A user's credential as it can be listed afterwards: metadata, no secret. */
export const CredentialRecord = z.object({
  userId: z.string(),
  kind: z.string().describe("pat or key"),
  id: z.string(),
  creationDate: z.string().optional(),
  expirationDate: z.string().optional(),
  action: Action,
  timestamp: z.string(),
});

/** One user metadata entry, with its value decoded from Zitadel's base64. */
export const MetadataEntry = z.object({
  userId: z.string(),
  key: z.string(),
  value: z.string(),
  action: Action,
  timestamp: z.string(),
});

/** A password reset a human can act on: a link's code, or a mail that was sent. */
export const PasswordReset = z.object({
  userId: z.string(),
  username: z.string().optional(),
  delivery: z.string().describe("return (the code is stored) or email"),
  verificationCode: z.string().optional().meta({ sensitive: true }).describe(
    "Emitted once when the code is returned rather than mailed",
  ),
  action: Action,
  timestamp: z.string(),
});

/** A user grant: which roles a user holds on a project. */
export const GrantInfo = z.object({
  grantId: z.string(),
  userId: z.string(),
  projectId: z.string(),
  roleKeys: z.array(z.string()),
  state: z.string(),
  displayName: z.string().optional(),
  action: Action,
  timestamp: z.string(),
});

/** The outcome of a reversible state change. */
export const StateResult = z.object({
  kind: z.string().describe("project, app, user or grant"),
  id: z.string(),
  name: z.string().optional(),
  previousState: z.string(),
  state: z.string(),
  action: Action,
  timestamp: z.string(),
});

/** The outcome of a delete, including one that only reported what it would do. */
export const DeleteResult = z.object({
  kind: z.string().describe("project, app, user, role, grant, pat or key"),
  id: z.string(),
  name: z.string(),
  deleted: z.boolean().describe("False when dryRun reported the plan only"),
  action: Action,
  timestamp: z.string(),
});

/** {@link OrgInfo} */
export type Org = z.infer<typeof OrgInfo>;
/** {@link ProjectInfo} */
export type Project = z.infer<typeof ProjectInfo>;
/** {@link AppInfo} */
export type App = z.infer<typeof AppInfo>;
/** {@link UserInfo} */
export type User = z.infer<typeof UserInfo>;
/** {@link GrantInfo} */
export type Grant = z.infer<typeof GrantInfo>;
/** {@link RoleInfo} */
export type Role = z.infer<typeof RoleInfo>;

/** Shape an organization record (v1 `orgs/me` or v2 search). */
export function shapeOrg(
  raw: Json,
  action: z.infer<typeof Action>,
  timestamp: string,
): Record<string, unknown> {
  return {
    id: str(raw.id ?? raw.organizationId),
    name: str(raw.name),
    state: friendlyState(raw.state),
    primaryDomain: optStr(raw.primaryDomain),
    action,
    timestamp,
  };
}

/** Shape an org member record into a manager. */
export function shapeManager(
  orgId: string,
  raw: Json,
  action: z.infer<typeof Action>,
  timestamp: string,
): Record<string, unknown> {
  return {
    orgId,
    userId: str(raw.userId),
    displayName: optStr(raw.displayName),
    preferredLoginName: optStr(raw.preferredLoginName),
    email: optStr(raw.email),
    roles: optStrList(raw.roles) ?? [],
    action,
    timestamp,
  };
}

/** Shape a project record. */
export function shapeProject(
  raw: Json,
  action: z.infer<typeof Action>,
  timestamp: string,
): Record<string, unknown> {
  return {
    id: str(raw.id),
    name: str(raw.name),
    state: friendlyState(raw.state),
    roleAssertion: optBool(raw.projectRoleAssertion),
    roleCheck: optBool(raw.projectRoleCheck),
    hasProjectCheck: optBool(raw.hasProjectCheck),
    action,
    timestamp,
  };
}

/** Shape a project-role record. */
export function shapeRole(
  projectId: string,
  raw: Json,
  action: z.infer<typeof Action>,
  timestamp: string,
): Record<string, unknown> {
  return {
    projectId,
    key: str(raw.key),
    displayName: optStr(raw.displayName),
    group: optStr(raw.group),
    action,
    timestamp,
  };
}

/**
 * Shape an application record. OIDC configuration uses proto3 zero-value
 * omission, so `appType=web`, `accessTokenType=bearer` and `devMode=false` come
 * back absent; they are normalized to the effective default so a read shows the
 * whole configuration and a read-then-converge changes only what was asked for.
 */
export function shapeApp(
  projectId: string,
  raw: Json,
  action: z.infer<typeof Action>,
  timestamp: string,
): Record<string, unknown> {
  const oidc = obj(raw.oidcConfig);
  const api = obj(raw.apiConfig);
  const isOidc = raw.oidcConfig !== undefined;
  const kind = isOidc
    ? "oidc"
    : raw.apiConfig !== undefined
    ? "api"
    : raw.samlConfig !== undefined
    ? "saml"
    : "unknown";
  return {
    projectId,
    appId: str(raw.id),
    name: str(raw.name),
    state: friendlyState(raw.state),
    kind,
    clientId: optStr(oidc.clientId ?? api.clientId),
    appType: isOidc
      ? (typeof oidc.appType === "string"
        ? (APP_TYPE_REV[oidc.appType] ?? friendlyState(oidc.appType))
        : "web")
      : undefined,
    accessTokenType: isOidc
      ? (typeof oidc.accessTokenType === "string"
        ? (ACCESS_TOKEN_TYPE_REV[oidc.accessTokenType] ??
          friendlyState(oidc.accessTokenType))
        : "bearer")
      : undefined,
    authMethod: (oidc.authMethodType ?? api.authMethodType)
      ? friendlyState(oidc.authMethodType ?? api.authMethodType)
      : undefined,
    redirectUris: optStrList(oidc.redirectUris),
    postLogoutUris: optStrList(oidc.postLogoutRedirectUris),
    responseTypes: friendlyEnumArray(oidc.responseTypes, RESPONSE_TYPE_REV),
    grantTypes: friendlyEnumArray(oidc.grantTypes, GRANT_TYPE_REV),
    devMode: isOidc
      ? (typeof oidc.devMode === "boolean" ? oidc.devMode : false)
      : undefined,
    action,
    timestamp,
  };
}

/** Shape a v2 user record, flattening the human and machine halves. */
export function shapeUser(
  raw: Json,
  action: z.infer<typeof Action>,
  timestamp: string,
): Record<string, unknown> {
  const human = obj(raw.human);
  const machine = obj(raw.machine);
  const profile = obj(human.profile);
  const email = obj(human.email);
  const phone = obj(human.phone);
  const type = raw.human !== undefined
    ? "human"
    : raw.machine !== undefined
    ? "machine"
    : "unknown";
  return {
    id: str(raw.userId ?? raw.id),
    username: str(raw.username ?? raw.userName),
    type,
    state: friendlyState(raw.state),
    preferredLoginName: optStr(raw.preferredLoginName),
    loginNames: optStrList(raw.loginNames),
    displayName: optStr(profile.displayName) ?? optStr(machine.name),
    givenName: optStr(profile.givenName),
    familyName: optStr(profile.familyName),
    email: optStr(email.email),
    emailVerified: optBool(email.isVerified),
    phone: optStr(phone.phone),
    description: optStr(machine.description),
    accessTokenType: raw.machine !== undefined
      ? friendlyState(machine.accessTokenType ?? "ACCESS_TOKEN_TYPE_BEARER")
      : undefined,
    hasSecret: optBool(machine.hasSecret),
    action,
    timestamp,
  };
}

/** Shape a user-grant record. */
export function shapeGrant(
  raw: Json,
  action: z.infer<typeof Action>,
  timestamp: string,
): Record<string, unknown> {
  return {
    grantId: str(raw.id ?? raw.grantId),
    userId: str(raw.userId),
    projectId: str(raw.projectId),
    roleKeys: optStrList(raw.roleKeys) ?? [],
    state: friendlyState(raw.state),
    displayName: optStr(raw.displayName),
    action,
    timestamp,
  };
}

/** An endpoint Zitadel calls when an execution fires. */
export const TargetInfo = z.object({
  id: z.string(),
  name: z.string(),
  endpoint: z.string(),
  style: z.string().describe("webhook, call or async"),
  interruptOnError: z.boolean().optional().describe(
    "The operation stops when the endpoint fails; webhook and call only",
  ),
  timeout: z.string().optional(),
  payloadType: z.string().optional().describe("json, jwt or jwe"),
  creationDate: z.string().optional(),
  changeDate: z.string().optional(),
  action: Action,
  timestamp: z.string(),
});

/** A target's signing key, emitted once at create and once at each rotation. */
export const TargetCredential = z.object({
  targetId: z.string(),
  name: z.string(),
  signingKey: z.string().meta({ sensitive: true }).describe(
    "What the endpoint checks the call's signature with — emitted once",
  ),
  action: Action,
  timestamp: z.string(),
});

/** A public key a target's payload may be encrypted to. */
export const PublicKeyInfo = z.object({
  targetId: z.string(),
  keyId: z.string(),
  state: z.string(),
  expirationDate: z.string().optional(),
  action: Action,
  timestamp: z.string(),
});

/** A condition bound to the targets it calls, in order. */
export const ExecutionInfo = z.object({
  condition: z.string().describe(
    "The condition as one string, e.g. event-user.human.added or request-<method>",
  ),
  conditionType: z.string().describe("request, response, event or function"),
  targets: z.array(z.string()).describe(
    "Target ids, in the order they are called",
  ),
  creationDate: z.string().optional(),
  changeDate: z.string().optional(),
  action: Action,
  timestamp: z.string(),
});

/** What an execution condition may name on this instance. */
export const ActionCatalog = z.object({
  kind: z.string().describe("service, method or function"),
  values: z.array(z.string()),
  action: Action,
  timestamp: z.string(),
});

/** Shape a target record; the signing key is never part of it. */
export function shapeTarget(
  raw: Json,
  action: z.infer<typeof Action>,
  timestamp: string,
): Record<string, unknown> {
  const webhook = raw.restWebhook === undefined
    ? undefined
    : obj(raw.restWebhook);
  const restCall = raw.restCall === undefined ? undefined : obj(raw.restCall);
  const style = webhook
    ? "webhook"
    : restCall
    ? "call"
    : raw.restAsync !== undefined
    ? "async"
    : "unknown";
  const payload = optStr(raw.payloadType);
  return {
    id: str(raw.id),
    name: str(raw.name),
    endpoint: str(raw.endpoint),
    style,
    interruptOnError: optBool((webhook ?? restCall ?? {}).interruptOnError),
    timeout: optStr(raw.timeout),
    payloadType: payload ? friendlyState(payload) : undefined,
    creationDate: optStr(raw.creationDate),
    changeDate: optStr(raw.changeDate),
    action,
    timestamp,
  };
}

/** Shape an execution record, flattening its condition into one readable key. */
export function shapeExecution(
  raw: Json,
  action: z.infer<typeof Action>,
  timestamp: string,
): Record<string, unknown> {
  const condition = obj(raw.condition);
  const request = obj(condition.request);
  const response = obj(condition.response);
  const event = obj(condition.event);
  const fn = obj(condition.function);
  let key = "condition";
  let type = "unknown";
  if (condition.request !== undefined) {
    type = "request";
    key = `request-${str(request.method || request.service || "all")}`;
  } else if (condition.response !== undefined) {
    type = "response";
    key = `response-${str(response.method || response.service || "all")}`;
  } else if (condition.event !== undefined) {
    type = "event";
    key = `event-${str(event.event || event.group || "all")}`;
  } else if (condition.function !== undefined) {
    type = "function";
    key = `function-${str(fn.name)}`;
  }
  return {
    condition: key,
    conditionType: type,
    targets: optStrList(raw.targets) ?? [],
    creationDate: optStr(raw.creationDate),
    changeDate: optStr(raw.changeDate),
    action,
    timestamp,
  };
}

/** A project handed to another organization, with the roles that came with it. */
export const ProjectGrantInfo = z.object({
  grantId: z.string(),
  projectId: z.string(),
  projectName: z.string().optional(),
  grantedOrgId: z.string().describe(
    "The organization the project was granted to",
  ),
  grantedOrgName: z.string().optional(),
  roleKeys: z.array(z.string()).describe(
    "The subset of the project's roles granted",
  ),
  state: z.string(),
  action: Action,
  timestamp: z.string(),
});

/** A user of the granted organization who may administer the project grant. */
export const ProjectGrantMember = z.object({
  grantId: z.string(),
  projectId: z.string(),
  userId: z.string(),
  displayName: z.string().optional(),
  preferredLoginName: z.string().optional(),
  roles: z.array(z.string()).describe("Manager roles on the grant"),
  action: Action,
  timestamp: z.string(),
});

/** Shape a project-grant record. */
export function shapeProjectGrant(
  projectId: string,
  raw: Json,
  action: z.infer<typeof Action>,
  timestamp: string,
): Record<string, unknown> {
  return {
    grantId: str(raw.grantId ?? raw.id),
    projectId: str(raw.projectId) || projectId,
    projectName: optStr(raw.projectName),
    grantedOrgId: str(raw.grantedOrgId),
    grantedOrgName: optStr(raw.grantedOrgName),
    roleKeys: optStrList(raw.grantedRoleKeys ?? raw.roleKeys) ?? [],
    state: friendlyState(raw.state),
    action,
    timestamp,
  };
}

/** Shape a project-grant member record. */
export function shapeProjectGrantMember(
  projectId: string,
  grantId: string,
  raw: Json,
  action: z.infer<typeof Action>,
  timestamp: string,
): Record<string, unknown> {
  return {
    grantId,
    projectId,
    userId: str(raw.userId),
    displayName: optStr(raw.displayName),
    preferredLoginName: optStr(raw.preferredLoginName),
    roles: optStrList(raw.roles) ?? [],
    action,
    timestamp,
  };
}

/**
 * One settings record. Zitadel answers a settings read with the values in
 * force for the context asked about and a `resourceOwnerType` saying whether
 * they are the organization's own or inherited from the instance, which is the
 * question an audit is really asking.
 */
const settingsBase = {
  scope: z.string().describe(
    "org or instance — where the values in force come from",
  ),
  orgId: z.string().optional().describe(
    "The organization asked about, when one was",
  ),
  action: Action,
  timestamp: z.string(),
};

/** How a login may be done, and how long each factor is trusted for. */
export const LoginSettings = z.object({
  allowUsernamePassword: z.boolean().optional(),
  allowRegister: z.boolean().optional(),
  allowExternalIdp: z.boolean().optional(),
  allowDomainDiscovery: z.boolean().optional(),
  allowLocalAuthentication: z.boolean().optional(),
  forceMfa: z.boolean().optional(),
  forceMfaLocalOnly: z.boolean().optional(),
  hidePasswordReset: z.boolean().optional(),
  ignoreUnknownUsernames: z.boolean().optional(),
  disableLoginWithEmail: z.boolean().optional(),
  disableLoginWithPhone: z.boolean().optional(),
  passkeysType: z.string().optional(),
  defaultRedirectUri: z.string().optional(),
  secondFactors: z.array(z.string()).optional(),
  multiFactors: z.array(z.string()).optional(),
  passwordCheckLifetime: z.string().optional(),
  externalLoginCheckLifetime: z.string().optional(),
  multiFactorCheckLifetime: z.string().optional(),
  secondFactorCheckLifetime: z.string().optional(),
  mfaInitSkipLifetime: z.string().optional(),
  ...settingsBase,
});

/** How many wrong answers lock an account. */
export const LockoutSettings = z.object({
  maxPasswordAttempts: z.number().optional(),
  maxOtpAttempts: z.number().optional(),
  ...settingsBase,
});

/** What a password has to look like. */
export const PasswordComplexitySettings = z.object({
  minLength: z.number().optional(),
  requiresUppercase: z.boolean().optional(),
  requiresLowercase: z.boolean().optional(),
  requiresNumber: z.boolean().optional(),
  requiresSymbol: z.boolean().optional(),
  ...settingsBase,
});

/** How long a password lives. */
export const PasswordExpirySettings = z.object({
  maxAgeDays: z.number().optional(),
  expireWarnDays: z.number().optional(),
  ...settingsBase,
});

/** What the login screen looks like. */
export const BrandingSettings = z.object({
  themeMode: z.string().optional(),
  hideLoginNameSuffix: z.boolean().optional(),
  disableWatermark: z.boolean().optional(),
  fontUrl: z.string().optional(),
  ...settingsBase,
});

/** How login names and domains are handled. */
export const DomainSettings = z.object({
  loginNameIncludesDomain: z.boolean().optional(),
  requireOrgDomainVerification: z.boolean().optional(),
  smtpSenderAddressMatchesInstanceDomain: z.boolean().optional(),
  ...settingsBase,
});

/** The links a login screen shows, and who to ask for help. */
export const LegalSupportSettings = z.object({
  tosLink: z.string().optional(),
  privacyPolicyLink: z.string().optional(),
  helpLink: z.string().optional(),
  supportEmail: z.string().optional(),
  docsLink: z.string().optional(),
  customLink: z.string().optional(),
  customLinkText: z.string().optional(),
  ...settingsBase,
});

/** Whether the login UI may be framed, and whether impersonation is allowed. */
export const SecuritySettings = z.object({
  iframeEmbeddingEnabled: z.boolean().optional(),
  allowedOrigins: z.array(z.string()).optional(),
  enableImpersonation: z.boolean().optional(),
  ...settingsBase,
});

/** The instance's languages and default organization. */
export const GeneralSettings = z.object({
  defaultLanguage: z.string().optional(),
  supportedLanguages: z.array(z.string()).optional(),
  allowedLanguages: z.array(z.string()).optional(),
  defaultOrgId: z.string().optional(),
  ...settingsBase,
});

/** A locale whose hosted-login translations were set. */
export const LoginTranslation = z.object({
  locale: z.string().describe("BCP-47 tag the translations were set for"),
  ...settingsBase,
});

/** An identity provider a person may log in with. */
export const ActiveIdentityProvider = z.object({
  id: z.string(),
  name: z.string().optional(),
  type: z.string().optional(),
  ...settingsBase,
});

/** The scope fields every settings record carries. */
export function settingsScope(
  raw: Json,
  orgId: string | undefined,
  timestamp: string,
): Record<string, unknown> {
  return {
    scope: friendlyState(
      raw.resourceOwnerType ?? "RESOURCE_OWNER_TYPE_INSTANCE",
    ),
    orgId,
    action: "observed",
    timestamp,
  };
}

/** One way a person can prove who they are, and whether it is ready. */
export const AuthFactor = z.object({
  userId: z.string(),
  username: z.string().optional(),
  type: z.string().describe("totp, u2f, otp-sms, otp-email or passkey"),
  id: z.string().optional().describe("The factor's id, where it has one"),
  name: z.string().optional().describe("What the person called it"),
  state: z.string().describe("ready, not-ready or removed"),
  action: Action,
  timestamp: z.string(),
});

/** A user's account at an identity provider. */
export const IdpLink = z.object({
  userId: z.string(),
  idpId: z.string(),
  externalUserId: z.string().optional(),
  externalUserName: z.string().optional(),
  action: Action,
  timestamp: z.string(),
});
