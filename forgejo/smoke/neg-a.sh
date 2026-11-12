#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== A. organizations, repositories, users, collaborators ==="

holds "health reads the version the forge runs" \
  '.dataArtifacts[] | select(.name == "status") | .attributes.version | startswith("15.0.11")' forge health
holds "org_ensure creates an organization" \
  '.dataArtifacts[] | select(.name == "fxnew") | .attributes.action == "created" and .attributes.visibility == "private"' \
  forge org_ensure name=fxnew visibility=private description=first
holds "... a second run with the same settings is unchanged" \
  '.dataArtifacts[] | select(.name == "fxnew") | .attributes.action == "unchanged"' \
  forge org_ensure name=fxnew visibility=private description=first
holds "... a new description is an update, and only that changes" \
  '.dataArtifacts[] | select(.name == "fxnew") | .attributes | .action == "updated" and .description == "second" and .visibility == "private"' \
  forge org_ensure name=fxnew description=second
holds "org_list records every organization" \
  '[.dataArtifacts[].name] | contains(["fxorg", "fxempty", "fxnew"])' forge org_list

holds "repo_ensure creates a repository in an organization, private by default" \
  '.dataArtifacts[] | select(.name == "repo-fxnew-svc") | .attributes | .action == "created" and .private and .empty' \
  forge repo_ensure owner=fxnew name=svc
holds "... and under the token's own user" \
  '.dataArtifacts[] | select(.name == "repo-fxadmin-own") | .attributes | .action == "created" and .owner == "fxadmin" and (.private | not)' \
  forge repo_ensure owner=fxadmin name=own private=false
holds "... converges what it is given, units included" \
  '.dataArtifacts[] | select(.name == "repo-fxnew-svc") | .attributes | .action == "updated" and .description == "a service" and (.private | not)' \
  forge repo_ensure owner=fxnew name=svc private=false description="a service" hasWiki=false
[ "$(forge GET /repos/fxnew/svc | jq .has_wiki)" = false ] && ok "... the wiki is off on the forge" \
  || bad "... the wiki is off on the forge" "has_wiki is not false"
holds "... and a rerun is unchanged" \
  '.dataArtifacts[] | select(.name == "repo-fxnew-svc") | .attributes.action == "unchanged"' \
  forge repo_ensure owner=fxnew name=svc private=false description="a service" hasWiki=false
holds "... a second repository, private" \
  '.dataArtifacts[] | select(.name == "repo-fxnew-priv") | .attributes | .action == "created" and .private' \
  forge repo_ensure owner=fxnew name=priv
holds "repo_list without an owner sees every repository" \
  '[.dataArtifacts[].name] | contains(["repo-fxorg-app", "repo-fxnew-svc", "repo-fxadmin-own"])' forge repo_list
holds "repo_list of an organization sees only its own" \
  '[.dataArtifacts[].attributes.owner] | unique == ["fxorg"]' forge repo_list owner=fxorg
holds "repo_list of a user resolves the user" \
  '[.dataArtifacts[].name] == ["repo-fxadmin-own"]' forge repo_list owner=fxadmin
refuses "repo_list of nobody names the owner" 'No user "nobody-here".*no organization' \
  forge repo_list owner=nobody-here
refuses "a narrow token cannot resolve an owner, and says what to do instead" \
  "neither read:organization nor read:user" forge-narrow repo_list owner=fxorg
holds "... and lists through the search instead" \
  '[.dataArtifacts[].name] | index("repo-fxorg-app") != null' forge-narrow repo_list

holds "user_list sees the three users, and no credential" \
  '[.dataArtifacts[] | .attributes | select(.login | startswith("fx"))] | (map(.login) | sort == ["fxadmin", "fxother", "fxplain"]) and (map(.isAdmin) | any)' \
  forge user_list
refuses "user_list with a narrow token is refused for read:admin" "read:admin|403" forge-narrow user_list
holds "user_search finds a login by fragment" \
  '[.dataArtifacts[] | .attributes.login] == ["fxother"]' forge user_search q=fxoth
holds "user_search for nobody records nothing" '(.dataArtifacts | length) == 0' forge user_search q=zz-nobody

holds "collaborator_ensure gives a user write on a private repository" \
  '.dataArtifacts[] | select(.name == "collaborator-fxnew-priv-fxplain") | .attributes | .action == "created" and .permission == "write"' \
  forge collaborator_ensure owner=fxnew name=priv user=fxplain
[ "$(forge GET /repos/fxnew/priv/collaborators/fxplain/permission | jq -r .permission)" = write ] \
  && ok "... the forge has the grant" || bad "... the forge has the grant" "permission is not write"
holds "... again is unchanged" \
  '.dataArtifacts[] | select(.name == "collaborator-fxnew-priv-fxplain") | .attributes.action == "unchanged"' \
  forge collaborator_ensure owner=fxnew name=priv user=fxplain
holds "... read is an update" \
  '.dataArtifacts[] | select(.name == "collaborator-fxnew-priv-fxplain") | .attributes | .action == "updated" and .permission == "read"' \
  forge collaborator_ensure owner=fxnew name=priv user=fxplain permission=read
# On a public repository the forge answers the permission probe with "read"
# for anyone; membership is what decides.
holds "on a public repository a new grant is created, not updated" \
  '.dataArtifacts[] | select(.name == "collaborator-fxorg-tool-fxother") | .attributes | .action == "created" and .permission == "read"' \
  forge collaborator_ensure owner=fxorg name=tool user=fxother permission=read
forge GET /repos/fxorg/tool/collaborators | jq -e 'any(.[]; .login == "fxother")' >/dev/null \
  && ok "... and read, the forge's default for anyone, is still granted" \
  || bad "... and read, the forge's default for anyone, is still granted" "fxother is no collaborator"
holds "... again is unchanged" \
  '.dataArtifacts[] | select(.name == "collaborator-fxorg-tool-fxother") | .attributes.action == "unchanged"' \
  forge collaborator_ensure owner=fxorg name=tool user=fxother permission=read
refuses "the owner of a repository is refused" "owns fxadmin/own" \
  forge collaborator_ensure owner=fxadmin name=own user=fxadmin

holds "repo_archive archives" \
  '.dataArtifacts[] | select(.name == "repo-fxnew-svc") | .attributes | .action == "archived" and .archived' \
  forge repo_archive owner=fxnew name=svc
holds "... twice is a no-op" \
  '.dataArtifacts[] | select(.name == "repo-fxnew-svc") | .attributes | .action == "unchanged" and .archived' \
  forge repo_archive owner=fxnew name=svc
holds "repo_unarchive undoes it" \
  '.dataArtifacts[] | select(.name == "repo-fxnew-svc") | .attributes | .action == "unarchived" and (.archived | not)' \
  forge repo_unarchive owner=fxnew name=svc
holds "... twice is a no-op" \
  '.dataArtifacts[] | select(.name == "repo-fxnew-svc") | .attributes.action == "unchanged"' \
  forge repo_unarchive owner=fxnew name=svc
refuses "archiving a repository that is not there is a 404" "HTTP 404" forge repo_archive owner=fxorg name=no-such-repo
summary
