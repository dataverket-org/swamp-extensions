#!/usr/bin/env bash
source ./negative.sh
echo "=== P. keys that may do less, names two methods must agree on, and an older definition ==="

names='[.dataArtifacts[].name]'

# A reader of the instance (IAM_OWNER_VIEWER) reads all of it and changes none.
holds   "a reader key lists the projects" "$names | index(\"project-selftest\") != null" \
  ro-project list
holds   "a reader key lists the users" "$names | index(\"user-kari-selftest\") != null" \
  ro-user list
holds   "a reader key reads the instance's settings" '[.dataArtifacts[].attributes.scope] | index("instance") != null' \
  ro-settings read instance=true
holds   "a reader key reads the organization and its managers" "$names | map(startswith(\"manager-\")) | any" \
  ro-org managerList
holds   "a reader key reads what an execution may name" "$names | index(\"catalog-service\") != null" \
  ro-action catalog
holds   "a reader key reads an application's configuration" '[.dataArtifacts[] | select(.name == "app-selftest-selftest-app") | .attributes.appType] | last == "native"' \
  ro-app get project=selftest app=selftest-app
refuses "a reader key cannot create a project" \
  "HTTP 403|permission" \
  ro-project ensure name=reader-made
refuses "a reader key cannot add a role to a project it can read" \
  "HTTP 403|permission" \
  ro-project roleEnsure project=selftest roleKey=reader-made displayName=nope
refuses "a reader key cannot create a user" \
  "HTTP 403|permission" \
  ro-user ensureMachine username=reader-made name=nope
refuses "a reader key cannot change an application" \
  "HTTP 403|permission" \
  ro-app redirectSet project=selftest app=selftest-app 'add=["http://localhost:19999"]'
holds   "... and none of it was made" "$names | (index(\"project-reader-made\") == null)" \
  zitadel-project list
holds   "... nor the role" "$names | (index(\"role-selftest-reader-made\") == null)" \
  zitadel-project roleList project=selftest

# An owner of one project (PROJECT_OWNER, no role in the organization) changes
# that project and nothing else. This is the key a deployment hands a process
# that provisions, and the login application a device flow goes through is the
# first thing such a key makes.
holds   "an owner key adds a device-code application to its project" '[.dataArtifacts[] | select(.name == "app-owned-cli") | .attributes.action] | last | . == "created" or . == "unchanged"' \
  po-app ensureOidc project=owned name=cli appType=native authMethod=none 'grantTypes=["device_code"]'
acts    "... and a second run changes nothing" unchanged app-owned-cli \
  po-app ensureOidc project=owned name=cli appType=native authMethod=none 'grantTypes=["device_code"]'
holds   "... which reads back as a public device-code client" '[.dataArtifacts[] | select(.name == "app-owned-cli") | .attributes] | last | .appType == "native" and .authMethod == "none" and .grantTypes == ["device_code"]' \
  po-app get project=owned app=cli
holds   "an owner key adds a role to its project" '[.dataArtifacts[] | select(.name == "role-owned-operators") | .attributes.action] | last | . == "created" or . == "unchanged"' \
  po-project roleEnsure project=owned roleKey=operators displayName=Operators
refuses "an owner key does not see a project it does not own" \
  "no project" \
  po-app ensureOidc project=selftest name=owner-made appType=native authMethod=none
refuses "an owner key cannot create a project" \
  "HTTP 403|permission" \
  po-project ensure name=owner-made
refuses "an owner key cannot create a user" \
  "HTTP 403|permission" \
  po-user ensureMachine username=owner-made name=nope
holds   "... and none of it was made" "$names | (index(\"project-owner-made\") == null)" \
  zitadel-project list
holds   "... nor the application in the other project" "$names | (index(\"app-selftest-owner-made\") == null)" \
  zitadel-app list project=selftest

# A grant is one instance whichever method wrote it: list and ensure agree on
# the name, and no record is left under the ids a list once used.
run zitadel-grant ensure user=kari-selftest project=selftest 'roleKeys=["kube-admin"]' >/dev/null 2>&1
holds   "grant list stores a grant under the name ensure uses" "$names | index(\"grant-kari-selftest-selftest\") != null" \
  zitadel-grant list user=kari-selftest project=selftest
holds   "... and under no name made of ids" "[.dataArtifacts[].name | select(test(\"^grant-[0-9]+-[0-9]+\$\"))] | length == 0" \
  zitadel-grant list

# Zitadel leaves a default out of its answer, and basic is the default auth
# method of both kinds of application.
run zitadel-app ensureOidc project=selftest name=basic-web 'redirectUris=["https://example.org/cb"]' >/dev/null 2>&1
holds   "a web application with the default auth method reads as basic" '[.dataArtifacts[] | select(.name == "app-selftest-basic-web") | .attributes.authMethod] | last == "basic"' \
  zitadel-app get project=selftest app=basic-web
run zitadel-app ensureApi project=selftest name=basic-api authMethod=basic >/dev/null 2>&1
holds   "an API application with basic auth reads as basic" '[.dataArtifacts[] | select(.name == "app-selftest-basic-api") | .attributes.authMethod] | last == "basic"' \
  zitadel-app get project=selftest app=basic-api
holds   "... and one with a key still reads as jwt" '[.dataArtifacts[] | select(.name == "app-selftest-selftest-api") | .attributes.authMethod] | last == "jwt"' \
  zitadel-app get project=selftest app=selftest-api

# A definition written for an earlier version of the type is migrated the first
# time a method runs on it, and says so afterwards.
before=$(swamp model get old-org --json 2>/dev/null | jq -r '.staleness // "?"')
[ "$before" = "upgradable" ] && ok "a definition from 2026.09.29.1 is reported as upgradable" ||
  bad "a definition from 2026.09.29.1 is reported as upgradable" "staleness was '$before'"
holds   "... it runs" '.dataArtifacts[0].attributes.state == "active"' \
  old-org get
after=$(swamp model get old-org --json 2>/dev/null | jq -r '(.staleness // "?") + " " + ((.typeVersion == .currentTypeVersion) | tostring)')
[ "$after" = "current true" ] && ok "... and is at the type's version afterwards" ||
  bad "... and is at the type's version afterwards" "staleness and match were '$after'"
summary
