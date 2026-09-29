#!/usr/bin/env bash
source ./negative.sh
echo "=== H. secrets at rest, and swamp's own lifecycle rules ==="

# This batch ends by re-creating the project it deleted, so start from nothing.
run lastone delete project=only-one confirm=only-one dryRun=false >/dev/null 2>&1

acts  "a model with one project" created project-only-one \
  lastone ensure name=only-one
acts  "... deleting it is allowed" removed project-deletion \
  lastone delete project=only-one confirm=only-one dryRun=false
refuses "... after which a read says to create one first (swamp's rule for a model whose resources are all gone)" \
  "was deleted at|no project" \
  lastone get project=only-one
acts  "... and ensure, which is a create, gets the model going again" created project-only-one \
  lastone ensure name=only-one

holds "a listed token carries its id and expiry, never the token" '[.dataArtifacts[] | select(.name | startswith("pat-")) | .attributes | has("secret")] | all(. == false)' \
  zitadel-user patList user=svc-selftest
holds "a listed key carries its id and expiry, never the key" '[.dataArtifacts[] | select(.name | startswith("key-")) | .attributes | has("secret")] | all(. == false)' \
  zitadel-user keyList user=svc-selftest
holds "a listed application key carries no key JSON" '[.dataArtifacts[] | select(.name | startswith("app-key-")) | .attributes | has("keyJson")] | all(. == false)' \
  zitadel-app keyList project=selftest app=selftest-api
summary
