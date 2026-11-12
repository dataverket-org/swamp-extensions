#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== E. renames and verify-first deletes ==="

holds "repo_rename renames, verify-first, and records the new URLs" \
  '.dataArtifacts[] | select(.name == "repo-rename-fxnew-svc2") | .attributes | .action == "renamed" and .from == "svc" and .to == "svc2" and (.htmlUrl | endswith("/fxnew/svc2"))' \
  forge repo_rename owner=fxnew name=svc newName=svc2
holds "... to its own name is unchanged" '.dataArtifacts[0].attributes.action == "unchanged"' \
  forge repo_rename owner=fxnew name=svc2 newName=svc2
refuses "... onto a repository that exists is refused" "fxnew/priv already exists; refusing" \
  forge repo_rename owner=fxnew name=svc2 newName=priv
refuses "... the old name, now a redirect to the new, is refused as renamed" \
  "fxnew/svc was renamed; it now redirects to /api/v1/repos/fxnew/svc2" \
  forge repo_rename owner=fxnew name=svc newName=svc3
refuses "... a repository that is not there" "does not exist; nothing to rename" \
  forge repo_rename owner=fxnew name=no-such-repo newName=x
refuses "... a new name with a slash is refused before anything is sent" "newName|invalid|regex" \
  forge repo_rename owner=fxnew name=svc2 newName=a/b

# A renamed repository's old name: the forge redirects it, and nothing may
# act on the renamed repository through it.
forge POST /orgs/fxorg/repos '{"name":"old-name","auto_init":true,"private":false}' >/dev/null
holds "a repository with commits, renamed" '.dataArtifacts[0].attributes.action == "renamed"' \
  forge repo_rename owner=fxorg name=old-name newName=new-name
refuses "repo_delete of the old name is refused as renamed, even with allowContent" \
  "fxorg/old-name was renamed; it now redirects to /api/v1/repos/fxorg/new-name" \
  forge repo_delete owner=fxorg name=old-name allowContent=true
refuses "repo_ensure of the old name is refused, nothing patched or made" "fxorg/old-name was renamed" \
  forge repo_ensure owner=fxorg name=old-name description=x
refuses "repo_units_ensure of the old name too" "fxorg/old-name was renamed" \
  forge repo_units_ensure owner=fxorg name=old-name hasProjects=false
[ "$(code /repos/fxorg/new-name)" = 200 ] && [ "$(forge GET /repos/fxorg/new-name | jq -r .description)" = "" ] \
  && ok "... and the renamed repository is there, untouched" \
  || bad "... and the renamed repository is there, untouched" "$(forge GET /repos/fxorg/new-name | head -c 200)"

refuses "repo_delete refuses a repository with commits" "fxorg/app has commits; pass allowContent=true" \
  forge repo_delete owner=fxorg name=app
[ "$(forge GET /repos/fxorg/app | jq -r .name)" = app ] \
  && ok "... and it is still there" || bad "... and it is still there" "fxorg/app is gone"
holds "repo_delete deletes an empty one" \
  '.dataArtifacts[0].attributes | .action == "deleted" and .wasEmpty' forge repo_delete owner=fxorg name=empty
holds "... again it is absent, a no-op" \
  '.dataArtifacts[] | select(.name == "repo-delete-fxorg-empty") | .attributes.action == "absent"' \
  forge repo_delete owner=fxorg name=empty
holds "allowContent deletes one with commits, and says so" \
  '.dataArtifacts[0].attributes | .action == "deleted" and (.wasEmpty | not)' \
  forge repo_delete owner=fxadmin name=own allowContent=true
[ "$(code /repos/fxadmin/own)" = 404 ] \
  && ok "... and the forge no longer has it" || bad "... and the forge no longer has it" "still there"

refuses "org_delete refuses an organization that holds repositories, naming them" \
  "organization fxnew still holds repositories \(.*priv" forge org_delete name=fxnew
holds "... empty it" 'true' forge repo_delete owner=fxnew name=priv
holds "... and the next" 'true' forge repo_delete owner=fxnew name=svc2
holds "org_delete deletes the empty organization" \
  '.dataArtifacts[0].attributes | .action == "deleted" and .id > 0 and .description == "second"' \
  forge org_delete name=fxnew
holds "... again it is absent" '.dataArtifacts[0].attributes | .action == "absent" and .id == 0' \
  forge org_delete name=fxnew
holds "org_delete of one that never had repositories" '.dataArtifacts[0].attributes.action == "deleted"' \
  forge org_delete name=fxempty
summary
