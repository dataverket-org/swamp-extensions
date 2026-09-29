#!/usr/bin/env bash
source ./negative.sh
echo "=== B. deleting what is not there, and never deleting a neighbour ==="

acts "project delete: a project that is already gone is a no-op" unchanged project-deletion \
  zitadel-project delete project=ghost-project confirm=ghost-project dryRun=false
acts "app delete: an application that is already gone is a no-op" unchanged app-deletion \
  zitadel-app delete project=selftest app=ghost-app confirm=ghost-app dryRun=false
acts "user delete: a user that is already gone is a no-op" unchanged user-deletion \
  zitadel-user delete user=ghost-user confirm=ghost-user dryRun=false
acts "roleRemove: a role that is already gone is a no-op" unchanged role-deletion \
  zitadel-project roleRemove project=selftest roleKey=ghost-role dryRun=false

# A token id that belongs to nobody, and one that belongs to another user, both
# have to leave the real token alone.
acts "patRevoke: an unknown token id is a no-op" unchanged pat-deletion \
  zitadel-user patRevoke user=svc-selftest tokenId=999999999999999999 dryRun=false
holds "patRevoke: ... and the user's real token is still there" '[.dataArtifacts[] | select(.name | startswith("pat-")) | .attributes.kind] | length > 0' \
  zitadel-user patList user=svc-selftest

acts "user keyDelete: an unknown key id is a no-op" unchanged user-key-deletion \
  zitadel-user keyDelete user=svc-selftest keyId=999999999999999999 dryRun=false
holds "user keyDelete: ... and the user's real key is still there" '[.dataArtifacts[] | select(.name | startswith("key-")) | .attributes.kind] | length > 0' \
  zitadel-user keyList user=svc-selftest

acts "app keyDelete: an unknown key id is a no-op" unchanged app-key-deletion \
  zitadel-app keyDelete project=selftest app=selftest-api keyId=999999999999999999 dryRun=false
holds "app keyDelete: ... and the application's real key is still there" '[.dataArtifacts[] | select(.name | startswith("app-key-")) | .attributes.keyId] | length > 0' \
  zitadel-app keyList project=selftest app=selftest-api

acts "grant delete: a grant that was never made is a no-op" unchanged grant-deletion \
  zitadel-grant delete user=svc-selftest project=selftest dryRun=false
holds "grant delete: ... and the other user's grant is untouched" '[.dataArtifacts[] | select(.name | startswith("grant-")) | .attributes.userId] | length > 0' \
  zitadel-grant list project=selftest
summary
