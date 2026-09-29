#!/usr/bin/env bash
source ./negative.sh
ORG=${ORG:?run mkorg.ts first and export ORG}
echo "=== J. project grants: handing a project to another organization ==="

refuses "granting to an organization that does not exist is refused" \
  "HTTP 4[0-9][0-9]|not found|invalid" \
  zitadel-project projectGrantEnsure project=selftest grantedOrgId=999999999999999999 'roleKeys=["kube-admin"]'
refuses "granting a role the project does not define is refused" \
  "HTTP 4[0-9][0-9]|not found|invalid|role" \
  zitadel-project projectGrantEnsure project=selftest grantedOrgId=$ORG 'roleKeys=["role-that-does-not-exist"]'
acts  "the project is granted to the other organization" created project-grant \
  zitadel-project projectGrantEnsure project=selftest grantedOrgId=$ORG 'roleKeys=["kube-admin"]'
acts  "granting the same roles again changes nothing" unchanged project-grant \
  zitadel-project projectGrantEnsure project=selftest grantedOrgId=$ORG 'roleKeys=["kube-admin"]'
acts  "a different role set is converged, not added to" updated project-grant \
  zitadel-project projectGrantEnsure project=selftest grantedOrgId=$ORG 'roleKeys=["kube-readers"]'
holds "... so only the new role is granted" '[.dataArtifacts[] | select(.name | startswith("project-grant-selftest-")) | .attributes.roleKeys] | last == ["kube-readers"]' \
  zitadel-project projectGrantList project=selftest

acts  "the grant can be deactivated" deactivated project-grant-state \
  zitadel-project projectGrantSetState project=selftest grantedOrgId=$ORG state=inactive
acts  "... and deactivating it again changes nothing" unchanged project-grant-state \
  zitadel-project projectGrantSetState project=selftest grantedOrgId=$ORG state=inactive
acts  "... while activating brings it back" reactivated project-grant-state \
  zitadel-project projectGrantSetState project=selftest grantedOrgId=$ORG state=active

refuses "a member of the granted organization must be named by id" \
  "HTTP 4[0-9][0-9]|not found|invalid|member" \
  zitadel-project projectGrantMemberEnsure project=selftest grantedOrgId=$ORG userId=999999999999999999 'roles=["PROJECT_GRANT_OWNER"]'
acts  "removing a member who was never one is a no-op" unchanged project-grant-member-deletion \
  zitadel-project projectGrantMemberRemove project=selftest grantedOrgId=$ORG userId=999999999999999999 dryRun=false

refuses "taking the grant back wants the granted organization's name" \
  "refusing to delete granted organization name" \
  zitadel-project projectGrantDelete project=selftest grantedOrgId=$ORG confirm=$ORG dryRun=false
acts  "... dryRun reports the plan" planned project-grant-deletion \
  zitadel-project projectGrantDelete project=selftest grantedOrgId=$ORG confirm="Annen organisasjon" dryRun=true
holds "... and the grant is still there" '[.dataArtifacts[] | select(.name | startswith("project-grant-selftest-")) | .attributes.grantedOrgId] | length > 0' \
  zitadel-project projectGrantList project=selftest
acts  "... while the exact name takes it back" removed project-grant-deletion \
  zitadel-project projectGrantDelete project=selftest grantedOrgId=$ORG confirm="Annen organisasjon" dryRun=false
acts  "... and taking back a grant that is gone is a no-op" unchanged project-grant-deletion \
  zitadel-project projectGrantDelete project=selftest grantedOrgId=$ORG confirm="Annen organisasjon" dryRun=false
refuses "a member listing of a grant that is gone says so" \
  "not granted to organization" \
  zitadel-project projectGrantMemberList project=selftest grantedOrgId=$ORG
summary
