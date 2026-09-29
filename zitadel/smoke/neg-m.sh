#!/usr/bin/env bash
source ./negative.sh
echo "=== M. paging: more than fits on one page ==="

# Zitadel pages at a hundred. Every list below has more than that, so a list
# that stops at the first page fails here and nowhere else.
holds "the v2 user search walks past the first page" '[.dataArtifacts[] | select(.name | startswith("user-bulk-")) | .name] | length >= 120' \
  zitadel-user list
holds "... and a filtered user search pages too" '[.dataArtifacts[] | select(.name | startswith("user-bulk-")) | .attributes.type] | all(. == "machine") and (length >= 120)' \
  zitadel-user list type=machine
holds "the v1 project search walks past the first page" '[.dataArtifacts[] | select(.name | startswith("project-bulk-project-")) | .name] | length >= 120' \
  zitadel-project list
holds "the v1 role search walks past the first page" '[.dataArtifacts[] | select(.name | startswith("role-")) | select(.attributes.key | startswith("bulk-role-")) | .name] | length >= 120' \
  zitadel-project roleList project=selftest
holds "the last page's rows are there, not just the first hundred" '[.dataArtifacts[] | select(.name == "user-bulk-119")] | length == 1' \
  zitadel-user list
holds "a user late in the paging can still be found by name" '.dataArtifacts | map(select(.attributes.username == "bulk-119")) | length >= 1' \
  zitadel-user get user=bulk-119
summary
