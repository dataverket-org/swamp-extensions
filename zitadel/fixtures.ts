/**
 * Recorded Zitadel response bodies, trimmed to the fields the models read.
 *
 * @module
 */
import type { Json } from "./api.ts";

/** A project as `/projects/_search` and `/projects/{id}` return it. */
export const PROJECT: Json = {
  id: "300000000000000001",
  name: "fabrikk",
  state: "PROJECT_STATE_ACTIVE",
  projectRoleAssertion: true,
  projectRoleCheck: false,
  hasProjectCheck: false,
};

/** A project role. */
export const ROLE: Json = {
  key: "kube-admin",
  displayName: "Kubernetes administrators",
  group: "kubernetes",
};

/** An OIDC application with its configuration. */
export const OIDC_APP: Json = {
  id: "400000000000000001",
  name: "kubelogin",
  state: "APP_STATE_ACTIVE",
  oidcConfig: {
    redirectUris: ["http://localhost:8000"],
    responseTypes: ["OIDC_RESPONSE_TYPE_CODE"],
    grantTypes: ["OIDC_GRANT_TYPE_AUTHORIZATION_CODE"],
    appType: "OIDC_APP_TYPE_NATIVE",
    authMethodType: "OIDC_AUTH_METHOD_TYPE_NONE",
    postLogoutRedirectUris: [],
    devMode: false,
    accessTokenType: "OIDC_TOKEN_TYPE_BEARER",
    clientId: "400000000000000001@fabrikk",
  },
};

/** An API application. */
export const API_APP: Json = {
  id: "400000000000000002",
  name: "fabrikk-api",
  state: "APP_STATE_ACTIVE",
  apiConfig: {
    clientId: "400000000000000002@fabrikk",
    authMethodType: "API_AUTH_METHOD_TYPE_PRIVATE_KEY_JWT",
  },
};

/** A machine user as the v2 user service returns it. */
export const MACHINE_USER: Json = {
  userId: "500000000000000001",
  username: "svc-flux",
  state: "USER_STATE_ACTIVE",
  preferredLoginName: "svc-flux@example.org",
  loginNames: ["svc-flux@example.org"],
  machine: {
    name: "Flux",
    description: "reconciles the cluster",
    hasSecret: false,
    accessTokenType: "ACCESS_TOKEN_TYPE_BEARER",
  },
};

/** A human user as the v2 user service returns it. */
export const HUMAN_USER: Json = {
  userId: "500000000000000002",
  username: "kari",
  state: "USER_STATE_ACTIVE",
  preferredLoginName: "kari@example.org",
  loginNames: ["kari@example.org"],
  human: {
    profile: {
      givenName: "Kari",
      familyName: "Nordmann",
      displayName: "Kari Nordmann",
      preferredLanguage: "nb",
    },
    email: { email: "kari@example.org", isVerified: true },
  },
};

/** A user grant. */
export const GRANT: Json = {
  id: "600000000000000001",
  userId: "500000000000000002",
  projectId: "300000000000000001",
  roleKeys: ["kube-admin"],
  state: "USER_GRANT_STATE_ACTIVE",
  displayName: "Kari Nordmann",
};

/** An organization. */
export const ORG: Json = {
  id: "200000000000000001",
  name: "example",
  state: "ORG_STATE_ACTIVE",
  primaryDomain: "example.org",
};
