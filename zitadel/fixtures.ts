/**
 * Recorded Zitadel response bodies, trimmed to the fields the models read.
 *
 * @module
 */
import type { Json } from "./api.ts";

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
