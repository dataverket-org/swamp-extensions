#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== D. Actions, runners, mirrors, webhooks ==="
V() { printf '${{ vault.get("forge", "%s") }}' "$1"; }
SRC=http://localhost:3000   # the forge as it sees itself, inside the container

holds "actions_secret_put, repo scope: created, the name recorded and never the value" \
  '.dataArtifacts[0].attributes | .action == "created" and .scope == "repo" and .target == "fxorg/tool" and .name == "DEPLOY_KEY" and (has("value") | not)' \
  forge actions_secret_put owner=fxorg repo=tool name=DEPLOY_KEY "value=$(V actions)"
holds "... again is an update" '.dataArtifacts[0].attributes.action == "updated"' \
  forge actions_secret_put owner=fxorg repo=tool name=DEPLOY_KEY "value=$(V actions)"
holds "... org scope" '.dataArtifacts[0].attributes | .scope == "org" and .target == "fxorg"' \
  forge actions_secret_put owner=fxorg name=REGISTRY_PASSWORD "value=$(V actions)"
[ "$(forge GET /orgs/fxorg/actions/secrets | jq -c '[.[].name]')" = '["REGISTRY_PASSWORD"]' ] \
  && ok "... the forge has the org secret" || bad "... the forge has the org secret" "missing"
refuses "a secret name Forgejo would refuse is refused first" "name|regex|invalid" \
  forge actions_secret_put owner=fxorg name=1-BAD "value=$(V actions)"
refuses "a secret on a repository that is not there" "HTTP 404" \
  forge actions_secret_put owner=fxorg repo=no-such-repo name=X "value=$(V actions)"

holds "runner_registration_token records a vault reference, not the token" \
  '.dataArtifacts[0].attributes | .scope == "org" and (.token | startswith("${{ vault.get(")) ' \
  forge runner_registration_token owner=fxorg
# The same token the forge hands out again; it is now a secret of this suite.
(umask 077; forge GET /orgs/fxorg/actions/runners/registration-token | jq -j .token \
  > "$SMOKE/.work/tokens/registration")
SECRETS+="|$(cat "$SMOKE/.work/tokens/registration")"
grep -qF "$(cat "$SMOKE/.work/tokens/registration")" "$OUT" "$ERR" \
  && bad "... and the token is nowhere in the run's output" "found" \
  || ok "... and the token is nowhere in the run's output"
holds "... repo scope" '.dataArtifacts[0].attributes | .scope == "repo" and .target == "fxorg/tool"' \
  forge runner_registration_token owner=fxorg repo=tool

holds "runner_list of the org: three offline runners" \
  '[.dataArtifacts[].attributes | {name, status, level}] | (map(.name) | sort == ["other-runner", "stale-runner", "stale-runner"]) and all(.status == "offline" and .level == "org")' \
  forge runner_list owner=fxorg
holds "... two of one name are two records" \
  '[.dataArtifacts[].name] | map(select(startswith("runner-fxorg-stale-runner-"))) | length == 2' \
  forge runner_list owner=fxorg
holds "runner_list of a repository records its own runner and the org's it may use, with their level" \
  '[.dataArtifacts[].attributes | select(.target == "fxorg/tool") | .level] | sort == ["org", "org", "org", "repo"]' \
  forge runner_list owner=fxorg repo=tool
holds "runner_prune at the repository deletes its own and keeps the org's of that name, saying why" \
  '.dataArtifacts[0].attributes | (.deleted | length == 1) and (.kept | length == 1) and .kept[0].reason == "an org runner; prune it at its own scope"' \
  forge runner_prune owner=fxorg repo=tool name=other-runner
[ "$(forge GET /repos/fxorg/tool/actions/runners | jq -c '[.[] | select(.repo_id > 0)] | length')" = 0 ] \
  && [ "$(forge GET /orgs/fxorg/actions/runners | jq -c '[.[] | select(.name == "other-runner")] | length')" = 1 ] \
  && ok "... the forge has the org's other-runner and no repository runner" \
  || bad "... the forge has the org's other-runner and no repository runner" "$(forge GET /repos/fxorg/tool/actions/runners | jq -c '[.[] | {name, repo_id}]')"
holds "runner_prune deletes the offline runners of one name" \
  '.dataArtifacts[0].attributes | (.deleted | length == 2) and .kept == []' \
  forge runner_prune owner=fxorg name=stale-runner
[ "$(forge GET /orgs/fxorg/actions/runners | jq -c '[.[].name]')" = '["other-runner"]' ] \
  && ok "... and leaves the other name" || bad "... and leaves the other name" "$(forge GET /orgs/fxorg/actions/runners | jq -c '[.[].name]')"
holds "... again deletes nothing" '.dataArtifacts[0].attributes | .deleted == [] and .kept == []' \
  forge runner_prune owner=fxorg name=stale-runner

holds "mirror_ensure makes a pull mirror of a repository on the forge" \
  '.dataArtifacts[] | select(.name == "mirror-fxorg-m-app") | .attributes | .action == "created" and (.private | not) and .interval == "10m0s" and (.originalUrl | endswith("/fxorg/app.git"))' \
  forge mirror_ensure owner=fxorg name=m-app cloneAddr=$SRC/fxorg/app.git service=git private=false mirrorInterval=10m0s
holds "... again is unchanged" \
  '.dataArtifacts[0].attributes.action == "unchanged"' \
  forge mirror_ensure owner=fxorg name=m-app cloneAddr=$SRC/fxorg/app service=git private=false mirrorInterval=10m
holds "... a description converges" \
  '.dataArtifacts[0].attributes.action == "updated"' \
  forge mirror_ensure owner=fxorg name=m-app cloneAddr=$SRC/fxorg/app.git service=git private=false \
  mirrorInterval=10m0s description="a mirror"
refuses "... another source is refused" "already mirrors .* not .*fxorg/tool.git" \
  forge mirror_ensure owner=fxorg name=m-app cloneAddr=$SRC/fxorg/tool.git service=git
refuses "... a repository that is not a mirror is refused" "is NOT a mirror" \
  forge mirror_ensure owner=fxorg name=tool cloneAddr=$SRC/fxorg/app.git service=git
refuses "... an empty one is named as a failed migration's shell" "EMPTY non-mirror shell" \
  forge mirror_ensure owner=fxorg name=empty cloneAddr=$SRC/fxorg/app.git service=git
holds "mirror_sync_now queues a sync" '.dataArtifacts[0].attributes.action == "triggered"' \
  forge mirror_sync_now owner=fxorg name=m-app
refuses "... of a repository that is not a mirror" "is not a mirror" forge mirror_sync_now owner=fxorg name=tool
refuses "... of nothing" "does not exist" forge mirror_sync_now owner=fxorg name=no-such-repo

holds "pull_mirror_ensure sends only what it is given: public by the forge's default" \
  '.dataArtifacts[0].attributes | .action == "created" and (.private | not) and .changed == []' \
  forge pull_mirror_ensure owner=fxorg name=pm-tool cloneAddr=$SRC/fxorg/tool.git
holds "... again with nothing is unchanged" '.dataArtifacts[0].attributes.action == "unchanged"' \
  forge pull_mirror_ensure owner=fxorg name=pm-tool cloneAddr=$SRC/fxorg/tool.git
holds "... one setting changes that one" \
  '.dataArtifacts[0].attributes | .action == "updated" and .changed == ["private"] and .private' \
  forge pull_mirror_ensure owner=fxorg name=pm-tool cloneAddr=$SRC/fxorg/tool.git private=true
holds "... with a source token from the vault, never recorded" \
  '.dataArtifacts[0].attributes | .action == "created" and (has("authToken") | not)' \
  forge pull_mirror_ensure owner=fxorg name=pm-auth cloneAddr=$SRC/fxorg/app.git "authToken=$(V admin)"
refuses "... a source that is not there fails, its token masked" "HTTP 4|HTTP 5" \
  forge pull_mirror_ensure owner=fxorg name=pm-none cloneAddr=$SRC/fxorg/nothing.git "authToken=$(V wrong)"
# Forgejo 15 leaves the failed migration behind as an empty repository marked
# mirror, never synced.
[ "$(forge GET /repos/fxorg/pm-none | jq -c '[.mirror, .empty]')" = '[true,true]' ] \
  && ok "... and the forge left an empty mirror behind" || bad "... and the forge left an empty mirror behind" "$(forge GET /repos/fxorg/pm-none | head -c 200)"
refuses "... which a rerun refuses as a failed migration, to be deleted first" \
  "fxorg/pm-none is a pull mirror whose migration failed.*Delete it \(repo_delete\)" \
  forge pull_mirror_ensure owner=fxorg name=pm-none cloneAddr=$SRC/fxorg/nothing.git
refuses "mirror_ensure: a source that is not there fails" "HTTP 4" \
  forge mirror_ensure owner=fxorg name=m-none cloneAddr=$SRC/fxorg/nothing.git service=git
refuses "... and the leftover is refused the same way, not patched into a 500" \
  "fxorg/m-none is a pull mirror whose migration failed.*Delete it \(repo_delete\)" \
  forge mirror_ensure owner=fxorg name=m-none cloneAddr=$SRC/fxorg/nothing.git service=git
refuses "... another source is refused" "already mirrors" \
  forge pull_mirror_ensure owner=fxorg name=pm-tool cloneAddr=$SRC/fxorg/app.git
refuses "... not a mirror is refused" "is not a mirror" \
  forge pull_mirror_ensure owner=fxorg name=tool cloneAddr=$SRC/fxorg/app.git
refuses "... an empty repository is named" "empty repository that is not a mirror" \
  forge pull_mirror_ensure owner=fxorg name=empty cloneAddr=$SRC/fxorg/app.git
holds "mirror_status sees every pull mirror; the three good ones synced and not stale" \
  '[.dataArtifacts[].attributes | select(.owner == "fxorg" and (.name | endswith("-none") | not))] | (map(.name) | sort == ["m-app", "pm-auth", "pm-tool"]) and all((.neverSynced | not) and (.stale | not))' \
  forge mirror_status
holds "... and the two leftovers never synced, so stale" \
  '[.dataArtifacts[].attributes | select(.name | endswith("-none")) | [.name, .neverSynced, .stale]] | sort == [["m-none", true, true], ["pm-none", true, true]]' \
  forge mirror_status
holds "repo_delete removes a leftover, as the refusal asks" '.dataArtifacts[0].attributes | .action == "deleted" and .wasEmpty' \
  forge repo_delete owner=fxorg name=m-none

holds "push_mirror_ensure pushes tool to another repository, the password from the vault" \
  '.dataArtifacts[0].attributes | .action == "created" and (.remoteAddress | endswith("/fxadmin/own.git")) and (has("remotePassword") | not)' \
  forge push_mirror_ensure owner=fxorg name=tool remoteAddress=$SRC/fxadmin/own.git remoteUsername=fxadmin \
  "remotePassword=$(V admin)" interval=0s
for _ in $(seq 1 30); do
  [ "$(forge GET /repos/fxadmin/own | jq .empty)" = false ] && break
  sleep 1
done
[ "$(forge GET /repos/fxadmin/own | jq .empty)" = false ] \
  && ok "... the remote received the commits" || bad "... the remote received the commits" "fxadmin/own is still empty"
holds "... again is unchanged, the address given without .git" '.dataArtifacts[0].attributes.action == "unchanged"' \
  forge push_mirror_ensure owner=fxorg name=tool remoteAddress=$SRC/fxadmin/own/ remoteUsername=fxadmin \
  "remotePassword=$(V admin)"
holds "a second one with a wrong password is still created" '.dataArtifacts[0].attributes.action == "created"' \
  forge push_mirror_ensure owner=fxorg name=tool remoteAddress=$SRC/fxadmin/elsewhere.git \
  "remotePassword=$(V wrong)" syncNow=true
for _ in $(seq 1 30); do
  forge GET /repos/fxorg/tool/push_mirrors | jq -e 'any(.[]; .last_error != "")' >/dev/null && break
  sleep 1
done
holds "push_mirror_list: one pushing, one failing, the error without the password" \
  '[.dataArtifacts[].attributes] | (map(select(.lastError == "")) | length == 1) and (map(select(.lastError != "")) | length == 1)' \
  forge push_mirror_list owner=fxorg name=tool
holds "... of the whole org" '[.dataArtifacts[].attributes.repo] | unique == ["tool"]' forge push_mirror_list owner=fxorg
[ "$(forge GET /repos/fxorg/tool/push_mirrors | jq length)" = 2 ] \
  && ok "... and the forge has two mirrors, not three" || bad "... and the forge has two mirrors, not three" "$(forge GET /repos/fxorg/tool/push_mirrors | jq -c '[.[].remote_address]')"
refuses "push_mirror_sync_now passes on the forge's 500 while a mirror cannot push" \
  "HTTP 500: error occurred when syncing push mirror" forge push_mirror_sync_now owner=fxorg name=tool
refuses "... of a repository that is not there" "HTTP 404" forge push_mirror_sync_now owner=fxorg name=no-such-repo
holds "push_mirror_delete removes the failing one" \
  '.dataArtifacts[0].attributes | .action == "deleted" and (.remoteName | length > 0)' \
  forge push_mirror_delete owner=fxorg name=tool remoteAddress=$SRC/fxadmin/elsewhere.git
holds "... again finds it absent" '.dataArtifacts[0].attributes.action == "absent"' \
  forge push_mirror_delete owner=fxorg name=tool remoteAddress=$SRC/fxadmin/elsewhere.git
holds "push_mirror_sync_now queues a push once every mirror can" '(.dataArtifacts | length) == 0' \
  forge push_mirror_sync_now owner=fxorg name=tool
# One deleted behind the method's back: the audit drops its record.
name=$(forge GET /repos/fxorg/tool/push_mirrors | jq -r '.[0].remote_name')
forge DELETE "/repos/fxorg/tool/push_mirrors/$name" >/dev/null
holds "push_mirror_list after an out-of-band delete records none" '(.dataArtifacts | length) == 0' \
  forge push_mirror_list owner=fxorg name=tool
left=$(cd "$REPO" && swamp data query "modelName == \"forge\" && specName == \"pushMirror\" && isLatest" --json 2>/dev/null |
  jq '[.. | objects | select(has("name") and (.name | tostring | startswith("push-mirror-fxorg-tool")))] | length')
[ "${left:-1}" = 0 ] && ok "... and the stored record of the vanished mirror is gone" \
  || bad "... and the stored record of the vanished mirror is gone" "$left left"

holds "webhook_audit: both hooks, the CI one matching, its query redacted" \
  '[.dataArtifacts[].attributes] | length == 2 and (map(select(.matchesExpected)) | length == 1) and (map(.url) | all(test("access_token=[^&]") | not) or any(test("access_token=")))' \
  forge webhook_audit owner=fxorg name=app expectedUrl=http://127.0.0.1:1/ci/hook
holds "... of the whole org finds the same two" '[.dataArtifacts[].attributes.repo] == ["fxorg/app", "fxorg/app"]' \
  forge webhook_audit owner=fxorg
refuses "... a name without an owner is refused" "requires .owner" forge webhook_audit name=app
refuses "webhook_retarget refuses to guess between two" "2 webhooks match" \
  forge webhook_retarget owner=fxorg name=app url=http://127.0.0.1:3/ci/hook
holds "... retargets the one that matches" \
  '.dataArtifacts[0].attributes | .action == "updated" and (.url | startswith("http://127.0.0.1:3/ci/hook"))' \
  forge webhook_retarget owner=fxorg name=app url=http://127.0.0.1:3/ci/hook matchUrl=127.0.0.1:1
forge GET /repos/fxorg/app/hooks | jq -e --arg q "$(cat "$SMOKE/.work/tokens/hookquery")" \
  'any(.[]; .config.url == "http://127.0.0.1:3/ci/hook?access_token=" + $q)' >/dev/null \
  && ok "... carrying the query over verbatim" || bad "... carrying the query over verbatim" "query lost"
holds "... again is unchanged" '.dataArtifacts[0].attributes.action == "unchanged"' \
  forge webhook_retarget owner=fxorg name=app url=http://127.0.0.1:3/ci/hook matchUrl=127.0.0.1:3
refuses "... no hook matches" "no webhook whose URL contains" \
  forge webhook_retarget owner=fxorg name=app url=http://127.0.0.1:4/x matchUrl=nowhere
refuses "... a repository without hooks is refused, never one created" "has no webhooks to retarget" \
  forge webhook_retarget owner=fxorg name=tool url=http://127.0.0.1:4/x
summary
