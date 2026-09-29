#!/usr/bin/env bash
source ./negative.sh
echo "=== L. authentication factors: who actually has MFA, and taking one away ==="

holds "a person who has registered nothing has no factors" '[.dataArtifacts[] | select(.name | startswith("auth-factor-")) | .attributes.userId] | length == 0' \
  zitadel-user authFactorList user=kari-selftest
holds "a service user has none either, and the read does not fail" '[.dataArtifacts[] | select(.name | startswith("auth-factor-")) | .attributes.userId] | length == 0' \
  zitadel-user authFactorList user=svc-selftest
refuses "listing the factors of somebody who is not there says so" \
  'no user "ghost-user"' \
  zitadel-user authFactorList user=ghost-user

refuses "removing a u2f key without its id is refused before any call" \
  "needs its id" \
  zitadel-user authFactorRemove user=kari-selftest type=u2f dryRun=false
refuses "removing a passkey without its id is refused too" \
  "needs its id" \
  zitadel-user authFactorRemove user=kari-selftest type=passkey dryRun=false
refuses "an unknown kind of factor is refused by the schema" \
  "invalid|expected one of|totp" \
  zitadel-user authFactorRemove user=kari-selftest type=fingerprint dryRun=false
acts  "removing a TOTP the person never had is a no-op" unchanged auth-factor-deletion \
  zitadel-user authFactorRemove user=kari-selftest type=totp dryRun=false
acts  "removing a passkey that is not theirs is a no-op" unchanged auth-factor-deletion \
  zitadel-user authFactorRemove user=kari-selftest type=passkey id=999999999999999999 dryRun=false

holds "a person with no identity-provider link lists none" '[.dataArtifacts[] | select(.name | startswith("idp-link-")) | .attributes.idpId] | length == 0' \
  zitadel-user idpLinkList user=kari-selftest
acts  "unlinking a provider they were never linked to is a no-op" unchanged idp-link-deletion \
  zitadel-user idpLinkRemove user=kari-selftest idpId=ghost-idp externalUserId=whoever dryRun=false
refuses "unlinking for somebody who is not there says so" \
  'no user "ghost-user"' \
  zitadel-user idpLinkRemove user=ghost-user idpId=ghost-idp externalUserId=whoever dryRun=false
summary
