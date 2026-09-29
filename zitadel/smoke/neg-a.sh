#!/usr/bin/env bash
source ./negative.sh
echo "=== A. the guards in front of a delete ==="

refuses "project delete: a confirm that is not the name is refused" \
  "refusing to delete project name" \
  zitadel-project delete project=selftest confirm=selftes dryRun=false
holds   "project delete: ... and the project is still there" '.dataArtifacts[0].attributes.name == "selftest"' \
  zitadel-project get project=selftest

refuses "project delete: confirm differing only in case is refused" \
  "refusing to delete" \
  zitadel-project delete project=selftest confirm=SELFTEST dryRun=false
refuses "project delete: an empty confirm is refused by the schema" \
  "confirm|too small|at least 1" \
  zitadel-project delete project=selftest confirm= dryRun=false

acts    "project delete: dryRun reports a plan" planned project-deletion \
  zitadel-project delete project=selftest confirm=selftest dryRun=true
holds   "project delete: ... and the project is still there" '.dataArtifacts[0].attributes.name == "selftest"' \
  zitadel-project get project=selftest

refuses "app delete: a confirm that is not the name is refused" \
  "refusing to delete application name" \
  zitadel-app delete project=selftest app=selftest-app confirm=selftest dryRun=false
acts    "app delete: dryRun reports a plan" planned app-deletion \
  zitadel-app delete project=selftest app=selftest-app confirm=selftest-app dryRun=true
holds   "app delete: ... and the application is still there" '.dataArtifacts[0].attributes.name == "selftest-app"' \
  zitadel-app get project=selftest app=selftest-app

refuses "user delete: a confirm that is not the username is refused" \
  "refusing to delete username" \
  zitadel-user delete user=svc-selftest confirm=svc-self dryRun=false
acts    "user delete: dryRun reports a plan" planned user-deletion \
  zitadel-user delete user=svc-selftest confirm=svc-selftest dryRun=true
holds   "user delete: ... and the user is still there" '.dataArtifacts[0].attributes.username == "svc-selftest"' \
  zitadel-user get user=svc-selftest

acts    "grant delete: dryRun reports a plan" planned grant-deletion \
  zitadel-grant delete user=kari-selftest project=selftest dryRun=true
holds   "grant delete: ... and the grant is still there" '[.dataArtifacts[].attributes.roleKeys[]] | index("kube-admin") != null' \
  zitadel-grant list user=kari-selftest project=selftest

acts    "roleRemove: dryRun reports a plan" planned role-deletion \
  zitadel-project roleRemove project=selftest roleKey=kube-readers dryRun=true
holds   "roleRemove: ... and the role is still there" '[.dataArtifacts[].attributes.key] | index("kube-readers") != null' \
  zitadel-project roleList project=selftest
summary
