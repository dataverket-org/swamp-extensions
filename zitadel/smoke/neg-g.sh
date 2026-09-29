#!/usr/bin/env bash
source ./negative.sh
echo "=== G. odd names, cascades, and what a real delete leaves behind ==="

# A name a person would type, with spaces and a slash and Norwegian letters.
ODD='Prosjekt æøå / test'
acts  "a project with spaces, a slash and non-ASCII letters is created" created project- \
  zitadel-project ensure name="$ODD"
holds "... and its stored instance name is safe to put in a path" '[.dataArtifacts[] | select(.attributes.name == "Prosjekt æøå / test") | .name] | last | test("^project-[a-z0-9-]+$")' \
  zitadel-project get project="$ODD"
refuses "... and a confirm that drops the odd characters is refused" \
  "refusing to delete" \
  zitadel-project delete project="$ODD" confirm="Prosjekt test" dryRun=false
acts  "... while the exact name deletes it" removed project-deletion \
  zitadel-project delete project="$ODD" confirm="$ODD" dryRun=false
refuses "... and it is gone afterwards" \
  "no project" \
  zitadel-project get project="$ODD"

# Deleting a user takes their grants with it, upstream and in the data.
acts  "a throwaway human is created" created user- \
  zitadel-user ensureHuman username=doomed-selftest email=doomed@example.org givenName=Doomed familyName=User
acts  "... and granted a role" created grant- \
  zitadel-grant ensure user=doomed-selftest project=selftest 'roleKeys=["kube-readers"]'
acts  "... then deleted" removed user-deletion \
  zitadel-user delete user=doomed-selftest confirm=doomed-selftest dryRun=false
refuses "... so the user is gone" \
  "no user" \
  zitadel-user get user=doomed-selftest
refuses "... and their grant went with them" \
  "no user" \
  zitadel-grant list user=doomed-selftest project=selftest
holds "... while the other user's grant survived" '[.dataArtifacts[] | select(.name | startswith("grant-")) | .attributes.userId] | length > 0' \
  zitadel-grant list user=kari-selftest project=selftest
summary
