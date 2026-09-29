#!/usr/bin/env bash
source ./negative.sh
made() { # name model method args... — created or unchanged, both mean "it is there now"
  local name=$1; shift
  holds "$name" '[.dataArtifacts[].attributes.action] | all(. == "created" or . == "unchanged" or . == "updated")' "$@"
}
echo "--- fixtures (the minimum the negative tests need) ---"
made "project ensure selftest"         zitadel-project ensure name=selftest
made "roleEnsure kube-admin"           zitadel-project roleEnsure project=selftest roleKey=kube-admin displayName="Kubernetes administrators"
made "roleEnsure kube-readers"         zitadel-project roleEnsure project=selftest roleKey=kube-readers displayName="Kubernetes readers"
made "app ensureOidc selftest-app"     zitadel-app ensureOidc project=selftest name=selftest-app 'redirectUris=["http://localhost:8000"]' appType=native authMethod=none
made "app ensureApi selftest-api"      zitadel-app ensureApi project=selftest name=selftest-api authMethod=jwt
made "user ensureMachine svc-selftest" zitadel-user ensureMachine username=svc-selftest name="Self test"
made "user ensureHuman kari-selftest"  zitadel-user ensureHuman username=kari-selftest email=kari@example.org givenName=Kari familyName=Nordmann
made "grant ensure kari on selftest"   zitadel-grant ensure user=kari-selftest project=selftest 'roleKeys=["kube-admin"]'
acts "patCreate for svc-selftest"      created user-credential zitadel-user patCreate user=svc-selftest expirationDate=2027-01-01T00:00:00Z
acts "keyCreate for svc-selftest"      created user-credential zitadel-user keyCreate user=svc-selftest expirationDate=2027-01-01T00:00:00Z
acts "app keyCreate for selftest-api"  created app-key zitadel-app keyCreate project=selftest app=selftest-api
summary
