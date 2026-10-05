#!/usr/bin/env bash
source ./negative.sh
echo "=== D. arguments the schema should catch before Zitadel sees them ==="

refuses "an unknown OIDC application type lists the ones that exist" \
  "invalid.*appType|expected one of|web.*spa.*native" \
  zitadel-app ensureOidc project=selftest name=bogus-app appType=bogus
refuses "an unknown authentication method is refused" \
  "invalid.*authMethod|expected one of|basic.*post.*none" \
  zitadel-app ensureOidc project=selftest name=bogus-app authMethod=telepathy
refuses "an unknown user state is refused" \
  "invalid|expected one of|active.*inactive.*locked" \
  zitadel-user setState user=svc-selftest state=confused
refuses "an unknown grant type is refused" \
  "invalid|expected one of|authorization_code" \
  zitadel-app ensureOidc project=selftest name=bogus-app 'grantTypes=["telepathy"]'
refuses "a login base URI without the v2 login UI is refused before any call" \
  "loginBaseUri needs loginVersion v2" \
  zitadel-app ensureOidc project=selftest name=bogus-app loginBaseUri=https://login.example.org
refuses "an unknown login UI version is refused" \
  "invalid|expected one of|instance.*v1.*v2" \
  zitadel-app ensureOidc project=selftest name=bogus-app loginVersion=v3
refuses "an empty project name is refused" \
  "too small|at least 1|expected string to have|name" \
  zitadel-project ensure name=
refuses "metadataDelete with no keys is refused" \
  "keys must not be empty|too small|at least 1" \
  zitadel-user metadataDelete user=kari-selftest 'keys=[]' dryRun=false
refuses "a personal access token without an expiry is refused by the schema" \
  "expirationDate|too small|at least 1|required" \
  zitadel-user patCreate user=svc-selftest
refuses "a nonsense expiry is refused by Zitadel, with the status" \
  "HTTP 400|invalid|parsing time" \
  zitadel-user patCreate user=svc-selftest expirationDate=whenever
refuses "a public key that is not a key is refused by Zitadel" \
  "HTTP 4[0-9][0-9]|invalid" \
  zitadel-user keyCreate user=svc-selftest expirationDate=2027-01-01T00:00:00Z publicKey="not a key"
refuses "a role key the project does not define cannot be granted" \
  "HTTP 4[0-9][0-9]|not found|invalid|role" \
  zitadel-grant ensure user=kari-selftest project=selftest 'roleKeys=["role-that-does-not-exist"]'
summary
