#!/usr/bin/env bash
source ./negative.sh
echo "=== C. the wrong kind of thing, and things that are not there ==="

refuses "ensureMachine on a human's username is refused" \
  "exists and is not a machine user" \
  zitadel-user ensureMachine username=kari-selftest name="Kari" 
refuses "ensureHuman on a machine's username is refused" \
  "exists and is not a human user" \
  zitadel-user ensureHuman username=svc-selftest email=x@example.org givenName=X familyName=Y
refuses "a password reset for a machine user is refused" \
  "not a human user" \
  zitadel-user passwordResetLinkCreate user=svc-selftest delivery=return
refuses "redirectSet on an API application is refused" \
  "not an OIDC application" \
  zitadel-app redirectSet project=selftest app=selftest-api 'add=["http://localhost:9000"]'

refuses "a project that does not exist is named, not guessed at" \
  'no project "ghost-project"' \
  zitadel-project get project=ghost-project
refuses "a numeric project id that does not exist is a clean miss, not a crash" \
  'no project "999999999999999999"' \
  zitadel-project get project=999999999999999999
refuses "a user that does not exist is named" \
  'no user "ghost-user"' \
  zitadel-user get user=ghost-user
refuses "a numeric user id that does not exist is a clean miss" \
  'no user "999999999999999999"' \
  zitadel-user get user=999999999999999999
refuses "an application in a project that does not exist" \
  'no project "ghost-project"' \
  zitadel-app list project=ghost-project
refuses "an application that does not exist in a real project" \
  'no application "ghost-app" in project' \
  zitadel-app get project=selftest app=ghost-app
refuses "a grant for a user that does not exist" \
  'no user "ghost-user"' \
  zitadel-grant ensure user=ghost-user project=selftest 'roleKeys=["kube-admin"]'
refuses "a grant on a project that does not exist" \
  'no project "ghost-project"' \
  zitadel-grant ensure user=kari-selftest project=ghost-project 'roleKeys=["kube-admin"]'
refuses "setState on a grant that was never made" \
  "has no grant on project" \
  zitadel-grant setState user=svc-selftest project=selftest state=inactive
refuses "secretRotate on an application with neither OIDC nor API config" \
  "no application \"ghost-app\"|neither an OIDC nor an API" \
  zitadel-app secretRotate project=selftest app=ghost-app
summary
