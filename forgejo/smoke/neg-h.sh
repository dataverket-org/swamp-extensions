#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== H. pages, scopes, the rest, and nothing at rest ==="

# Issues: an org's label, a pull request's labels, a repository without issues.
holds "issue_ensure files an issue with the organization's label" \
  '.dataArtifacts[0].attributes | .action == "created" and .labels == ["kind/bug"]' \
  forge issue_ensure owner=fxorg name=app 'issues=[{"title":"With an org label","labels":["kind/bug"]}]'
pr=$(forge GET '/repos/fxorg/app/pulls?state=open' | jq '.[0].number')
holds "issue_labels_ensure labels a pull request by its number" \
  '.dataArtifacts[0].attributes | .action == "updated" and (.labels | index("bug") != null)' \
  forge issue_labels_ensure owner=fxorg name=app number="$pr" 'labels=["bug"]'
holds "pr_assign assigns" '.dataArtifacts[0].attributes.action == "assigned"' \
  forge pr_assign owner=fxorg name=app index="$pr" 'assignees=["fxplain"]'
holds "... the same list again is unchanged" '.dataArtifacts[0].attributes.action == "unchanged"' \
  forge pr_assign owner=fxorg name=app index="$pr" 'assignees=["fxplain"]'
holds "a repository without issues" 'true' forge repo_ensure owner=fxorg name=noissues private=false hasIssues=false
refuses "... refuses a filed issue with the forge's own message" "HTTP 4[0-9][0-9]: " \
  forge issue_ensure owner=fxorg name=noissues 'issues=[{"title":"Nowhere"}]'

# More than a page: 56 issues, a needle among them that only the search's
# second page holds, and 55 labels.
forge POST /orgs/fxorg/repos '{"name":"many","auto_init":true,"private":false}' >/dev/null
needle=$(forge POST /repos/fxorg/many/issues '{"title":"Needle"}' | jq .number)
for i in $(seq 1 55); do
  forge POST /repos/fxorg/many/issues "{\"title\":\"Needle $i\"}" >/dev/null
  forge POST /repos/fxorg/many/labels "{\"name\":\"l$i\",\"color\":\"#00aa00\"}" >/dev/null
done
holds "issue_list reads every page: 56 issues" '(.dataArtifacts | length) == 56' \
  forge issue_list owner=fxorg name=many state=all
# The search lags; wait until its second page holds the needle, as the forge
# lists newest first.
for _ in $(seq 1 60); do
  forge GET '/repos/fxorg/many/issues?state=all&type=issues&q=Needle&limit=50&page=2' |
    jq -e --argjson n "$needle" 'any(.[]; .number == $n)' >/dev/null && break
  sleep 1
done
holds "issue_ensure finds a title on the search's second page, not among the newest" \
  ".dataArtifacts[0].attributes | .action == \"unchanged\" and .number == $needle" \
  forge issue_ensure owner=fxorg name=many 'issues=[{"title":"Needle"}]'
holds "label_list reads every page: 55 labels" \
  '[.dataArtifacts[].attributes | select(.scope == "repo")] | length == 55' forge label_list owner=fxorg name=many
holds "label_ensure patches a description in place" \
  '.dataArtifacts[0].attributes | .action == "updated" and .description == "the docs"' \
  forge label_ensure owner=fxorg name=tool 'labels=[{"name":"docs","color":"0075ca","description":"the docs"}]'
refuses "two labels of one name in a call are refused" "same name|twice|duplicate|unique" \
  forge label_ensure owner=fxorg name=tool 'labels=[{"name":"x","color":"000000"},{"name":"x","color":"111111"}]'

# Topics: an empty exact list, and too many.
holds "repo_topics_ensure exact with an empty list clears every topic" \
  '.dataArtifacts[0].attributes | .topics == [] and .removed == ["gamma"]' \
  forge repo_topics_ensure owner=fxorg name=tool 'topics=[]' exact=true
refuses "more than 25 topics are refused before anything is written" "Forgejo allows 25" \
  forge repo_topics_ensure owner=fxorg name=tool "topics=$(jq -nc '[range(26) | "t\(.)"]')"
[ "$(forge GET /repos/fxorg/tool/topics | jq -c .topics)" = '[]' ] \
  && ok "... and none was" || bad "... and none was" "$(forge GET /repos/fxorg/tool/topics)"

# Refusals by the forge, with its own message.
refuses "merge settings: a read the forge refuses carries its message" "HTTP 401" \
  forge-wrong repo_merge_settings_ensure owner=fxorg name=tool --skip-check-label=live
refuses "merge settings: a write without the scope carries the forge's message" "HTTP 403.*scope" \
  forge-narrow repo_merge_settings_ensure owner=fxorg name=tool allowSquashMerge=true
[ "$(forge GET /repos/fxorg/tool | jq .allow_squash_merge)" = false ] \
  && ok "... and nothing changed" || bad "... and nothing changed" "allow_squash_merge moved"
refuses "units: a write without the scope carries the forge's message" "HTTP 403.*scope" \
  forge-narrow repo_units_ensure owner=fxorg name=tool hasProjects=true
refuses "org_delete: a read the forge refuses is the error, nothing deleted" "HTTP 403" \
  forge-narrow org_delete name=fxorg
[ "$(code /orgs/fxorg)" = 200 ] && ok "... fxorg is there" || bad "... fxorg is there" "gone"

# Mirrors: every setting on create, the source compared without case or
# credentials, a push mirror past the first page, an owner that is a user.
SRC=http://localhost:3000
holds "pull_mirror_ensure sends every setting it is given" \
  '.dataArtifacts[0].attributes | .action == "created" and .private and .interval == "12h0m0s" and .description == "full"' \
  forge pull_mirror_ensure owner=fxorg name=pm-full cloneAddr=$SRC/fxorg/app.git private=true interval=12h0m0s \
  description=full lfs=false service=git
holds "... the source given in other case, with credentials, is the same source" \
  '.dataArtifacts[0].attributes.action == "unchanged"' \
  forge pull_mirror_ensure owner=fxorg name=pm-full cloneAddr=http://someone:pw@LOCALHOST:3000/fxorg/app.git/
forge POST /orgs/fxorg/repos '{"name":"pmany","auto_init":true,"private":false}' >/dev/null
for i in $(seq 1 51); do
  forge POST /repos/fxorg/pmany/push_mirrors \
    "{\"remote_address\":\"$SRC/fxorg/r$i.git\",\"remote_username\":\"x\",\"remote_password\":\"x\",\"interval\":\"0s\",\"sync_on_commit\":false}" >/dev/null
done
holds "push_mirror_ensure finds a mirror past the first page" '.dataArtifacts[0].attributes.action == "unchanged"' \
  forge push_mirror_ensure owner=fxorg name=pmany remoteAddress=$SRC/fxorg/r51.git "remotePassword=\${{ vault.get(\"forge\", \"wrong\") }}" \
  syncNow=false
[ "$(forge GET '/repos/fxorg/pmany/push_mirrors?limit=100' | jq length)" = 51 ] \
  && ok "... and makes no 52nd" || bad "... and makes no 52nd" "$(forge GET '/repos/fxorg/pmany/push_mirrors?limit=100' | jq length)"
holds "push_mirror_list reads all 51" '(.dataArtifacts | length) == 51' forge push_mirror_list owner=fxorg name=pmany
refuses "push_mirror_ensure on a repository that is not there carries the forge's message" "HTTP 404" \
  forge push_mirror_ensure owner=fxorg name=no-such-repo remoteAddress=$SRC/x.git "remotePassword=\${{ vault.get(\"forge\", \"wrong\") }}"
forge POST /user/repos '{"name":"user-repo","auto_init":true,"private":false}' >/dev/null
forge POST /repos/fxadmin/user-repo/push_mirrors \
  "{\"remote_address\":\"$SRC/fxorg/u1.git\",\"remote_username\":\"x\",\"remote_password\":\"x\",\"interval\":\"0s\",\"sync_on_commit\":false}" >/dev/null
holds "push_mirror_list of a user's repositories" \
  '[.dataArtifacts[].attributes | .repo] == ["user-repo"]' forge push_mirror_list owner=fxadmin

# The one place grep is right: proving a value is nowhere swamp keeps anything.
if grep -rqE "$SECRETS" "$REPO/.swamp"; then
  bad "no token, password or planted secret anywhere in the repository's .swamp" \
    "$(grep -rlE "$SECRETS" "$REPO/.swamp" | head -3)"
else
  ok "no token, password or planted secret anywhere in the repository's .swamp"
fi
summary
