#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== C. issues and pull requests ==="
A=(owner=fxorg name=app)


holds "labels for the issues, on the repository" 'true' forge label_ensure owner=fxorg name=app \
  'labels=[{"name":"bug","color":"d73a4a"},{"name":"triage","color":"fbca04"}]'
holds "issue_ensure files two issues, one with a label by name" \
  '[.dataArtifacts[].attributes | select(.action == "created")] | (map(.title) | sort == ["First issue", "Second issue"]) and (map(select(.title == "First issue") | .labels) == [["bug"]])' \
  forge issue_ensure "${A[@]}" 'issues=[{"title":"First issue","body":"b","labels":["bug"]},{"title":"Second issue"}]'
first=$(jq '.dataArtifacts[].attributes | select(.title == "First issue") | .number' "$OUT")
second=$(jq '.dataArtifacts[].attributes | select(.title == "Second issue") | .number' "$OUT")
# Straight away: the forge's search has not indexed them yet, and the rerun
# must still find them.
holds "... a rerun files nothing twice" \
  '[.dataArtifacts[].attributes.action] == ["unchanged", "unchanged"]' \
  forge issue_ensure "${A[@]}" 'issues=[{"title":"First issue"},{"title":"Second issue"}]'
holds "... a title that only contains another is its own issue" \
  '[.dataArtifacts[].attributes | select(.title == "First") | .action] == ["created"]' \
  forge issue_ensure "${A[@]}" 'issues=[{"title":"First"}]'
forge PATCH "/repos/fxorg/app/issues/$second" '{"state":"closed"}' >/dev/null
holds "... a closed one is found, not reopened" \
  '.dataArtifacts[].attributes | .action == "unchanged" and .state == "closed"' \
  forge issue_ensure "${A[@]}" 'issues=[{"title":"Second issue"}]'
refuses "a label that is nowhere is refused before anything is filed" 'label\(s\) "no-such-label" exist neither' \
  forge issue_ensure "${A[@]}" 'issues=[{"title":"Third issue","labels":["no-such-label"]}]'
[ "$(forge GET '/repos/fxorg/app/issues?state=all&type=issues&limit=50' | jq '[.[] | select(.title == "Third issue")] | length')" = 0 ] \
  && ok "... and nothing was" || bad "... and nothing was" "an issue Third was filed"
refuses "two equal titles in one call are refused" "same title" \
  forge issue_ensure "${A[@]}" 'issues=[{"title":"Dup"},{"title":"Dup"}]'
holds "issue_list open: the open issues, no pull request" \
  '[.dataArtifacts[].attributes | .title] | sort == ["First", "First issue"]' forge issue_list "${A[@]}"
holds "issue_list closed" '[.dataArtifacts[].attributes | .title] == ["Second issue"]' \
  forge issue_list "${A[@]}" state=closed
holds "issue_labels_ensure adds a label, keeps the other" \
  '.dataArtifacts[0].attributes | .action == "updated" and .labels == ["bug", "triage"] and .added == ["triage"]' \
  forge issue_labels_ensure "${A[@]}" number="$first" 'labels=["triage"]'
holds "... again is unchanged" '.dataArtifacts[0].attributes.action == "unchanged"' \
  forge issue_labels_ensure "${A[@]}" number="$first" 'labels=["triage"]'
holds "... exact removes the rest" \
  '.dataArtifacts[0].attributes | .labels == ["triage"] and .removed == ["bug"]' \
  forge issue_labels_ensure "${A[@]}" number="$first" 'labels=["triage"]' exact=true
[ "$(forge GET "/repos/fxorg/app/issues/$first/labels" | jq -c '[.[].name]')" = '["triage"]' ] \
  && ok "... the forge agrees" || bad "... the forge agrees" "labels differ"
refuses "... a missing label is refused" "exist neither" \
  forge issue_labels_ensure "${A[@]}" number="$first" 'labels=["nope"]'

holds "pr_ensure opens a pull request" \
  '.dataArtifacts[0].attributes | .action == "created" and .head == "feat/one" and .base == "main" and .state == "open"' \
  forge pr_ensure "${A[@]}" head=feat/one base=main title="Add one"
one=$(jq '.dataArtifacts[0].attributes.index' "$OUT")
holds "... again on the same pair is unchanged, the same index" \
  ".dataArtifacts[0].attributes | .action == \"unchanged\" and .index == $one" \
  forge pr_ensure "${A[@]}" head=feat/one base=main title="Add one"
holds "... a new title converges it" \
  ".dataArtifacts[0].attributes | .action == \"updated\" and .title == \"Add one, renamed\" and .index == $one" \
  forge pr_ensure "${A[@]}" head=feat/one base=main title="Add one, renamed" body="the body"
refuses "a head that does not exist is the forge's refusal" "HTTP 404|HTTP 422" \
  forge pr_ensure "${A[@]}" head=feat/none base=main title=x
holds "pr_list open records it, with no mergeable verdict" \
  "[.dataArtifacts[].attributes | select(.index == $one)] | length == 1 and (.[0].mergeable == null)" \
  forge pr_list "${A[@]}"
holds "pr_get: mergeable, and no CI state at all" \
  ".dataArtifacts[0].attributes | .mergeable == true and .ciState == \"none\" and .author == \"fxadmin\"" \
  forge pr_get "${A[@]}" index="$one"
refuses "pr_get of a pull request that is not there" "fxorg/app#9999 does not exist" forge pr_get "${A[@]}" index=9999
refuses "pr_merge refuses a head with no CI state" 'CI state "none", not success' \
  forge pr_merge "${A[@]}" index="$one" strategy=merge
sha=$(forge GET "/repos/fxorg/app/pulls/$one" | jq -r .head.sha)
forge POST "/repos/fxorg/app/statuses/$sha" '{"state":"failure","context":"ci/build"}' >/dev/null
refuses "... and a failed one" 'CI state "failure"' forge pr_merge "${A[@]}" index="$one" strategy=merge
forge POST "/repos/fxorg/app/statuses/$sha" '{"state":"success","context":"ci/build"}' >/dev/null
holds "pr_get sees success" '.dataArtifacts[0].attributes.ciState == "success"' forge pr_get "${A[@]}" index="$one"

holds "pr_assign assigns a collaborator" \
  '.dataArtifacts[0].attributes | .action == "assigned" and .assignees == ["fxplain"]' \
  forge pr_assign "${A[@]}" index="$one" 'assignees=["fxplain"]'
refuses "... a login that does not exist is refused, nothing assigned" 'No user "fx-typo"' \
  forge pr_assign "${A[@]}" index="$one" 'assignees=["fxplain","fx-typo"]'
[ "$(forge GET "/repos/fxorg/app/pulls/$one" | jq -c '[.assignees[].login]')" = '["fxplain"]' ] \
  && ok "... the list on the forge is unchanged" || bad "... the list on the forge is unchanged" "assignees moved"
refuses "pr_assign of a pull request that is not there" "does not exist" \
  forge pr_assign "${A[@]}" index=9999 'assignees=["fxplain"]'

holds "pr_comment posts a comment" '.dataArtifacts[0].attributes | .commentId > 0 and .action == "created"' \
  forge pr_comment "${A[@]}" index="$one" body="looks fine"
holds "... every call posts a new one" '.dataArtifacts[0].attributes.commentId > 0' \
  forge pr_comment "${A[@]}" index="$one" body="looks fine"
forge POST "/repos/fxorg/app/pulls/$one/reviews" \
  '{"event":"COMMENT","body":"a review","comments":[{"path":"one.txt","body":"an inline note","new_position":1}]}' >/dev/null
holds "pr_feedback reads both comments, the review and its inline comment" \
  '.dataArtifacts[0].attributes.notes | (map(select(.kind == "comment")) | length == 2) and (map(select(.kind == "review")) | .[0].body == "a review") and (map(select(.kind == "inline")) | .[0] | .path == "one.txt" and .body == "an inline note")' \
  forge pr_feedback "${A[@]}" index="$one"
holds "pr_merge_state before the merge: open, no merge commit" \
  '.dataArtifacts[0].attributes | (.merged | not) and .mergeSha == null and .state == "open"' \
  forge pr_merge_state "${A[@]}" index="$one"

holds "pr_merge merges a green head, deleting the branch" \
  '.dataArtifacts[0].attributes | .action == "merged" and .merged and .ciState == "success"' \
  forge pr_merge "${A[@]}" index="$one" strategy=merge deleteBranch=true
[ "$(code /repos/fxorg/app/branches/feat%2Fone)" = 404 ] \
  && ok "... the branch is gone" || bad "... the branch is gone" "feat/one still there"
refuses "... a second merge is refused" "already merged" forge pr_merge "${A[@]}" index="$one"
holds "pr_merge_state: the merge commit, time and merger" \
  '.dataArtifacts[0].attributes | .merged and (.mergeSha | length == 40) and .mergedBy == "fxadmin" and (.mergedAt | length > 0)' \
  forge pr_merge_state "${A[@]}" index="$one"

holds "a second pull request" 'true' forge pr_ensure "${A[@]}" head=feat/two base=main title="Add two"
two=$(jq '.dataArtifacts[0].attributes.index' "$OUT")
holds "force merges past no CI state, squash" \
  '.dataArtifacts[0].attributes | .merged and .ciState == "none"' \
  forge pr_merge "${A[@]}" index="$two" strategy=squash force=true

holds "a conflicting pull request" 'true' forge pr_ensure "${A[@]}" head=feat/conflict base=main title="Conflict"
three=$(jq '.dataArtifacts[0].attributes.index' "$OUT")
# The forge checks mergeability in the background; poll until it has.
for _ in $(seq 1 20); do
  [ "$(forge GET "/repos/fxorg/app/pulls/$three" | jq .mergeable)" = false ] && break
  sleep 1
done
holds "pr_get records it not mergeable" '.dataArtifacts[0].attributes.mergeable == false' \
  forge pr_get "${A[@]}" index="$three"
refuses "pr_merge refuses a conflict, even with force" "is not mergeable" \
  forge pr_merge "${A[@]}" index="$three" force=true
forge PATCH "/repos/fxorg/app/pulls/$three" '{"state":"closed"}' >/dev/null
refuses "pr_merge refuses a closed pull request" "is closed, not open" \
  forge pr_merge "${A[@]}" index="$three" force=true
refuses "pr_assign refuses a closed pull request" "closed" \
  forge pr_assign "${A[@]}" index="$three" 'assignees=["fxplain"]'
forge POST /repos/fxorg/app/contents/draft.txt \
  "{\"content\":\"$(printf draft | base64)\",\"message\":\"draft\",\"branch\":\"main\",\"new_branch\":\"feat/draft\"}" >/dev/null
holds "a draft pull request" '.dataArtifacts[0].attributes.draft' \
  forge pr_ensure "${A[@]}" head=feat/draft base=main title="WIP: not yet"
four=$(jq '.dataArtifacts[0].attributes.index' "$OUT")
refuses "pr_merge refuses a draft, even with force" "is a draft" forge pr_merge "${A[@]}" index="$four" force=true
holds "pr_list closed sees the merged and the closed" \
  "[.dataArtifacts[].attributes.index] | sort == ([$one, $two, $three] | sort)" forge pr_list "${A[@]}" state=closed
# issue_state_ensure and issue_body_ensure, on two issues of their own
holds "two issues for state and text" 'true' forge issue_ensure "${A[@]}" \
  'issues=[{"title":"State one","body":"first text"},{"title":"State two"}]'
s1=$(jq '.dataArtifacts[].attributes | select(.title == "State one") | .number' "$OUT")
s2=$(jq '.dataArtifacts[].attributes | select(.title == "State two") | .number' "$OUT")
comments() { forge GET "/repos/fxorg/app/issues/$1/comments" | jq length; }
state() { forge GET "/repos/fxorg/app/issues/$1" | jq -r .state; }
holds "issue_state_ensure closes one with a comment and one without" \
  "[.dataArtifacts[] | [.name, .attributes.number, .attributes.state, .attributes.action]] == [[\"issue-state-fxorg-app-$s1\", $s1, \"closed\", \"updated\"], [\"issue-state-fxorg-app-$s2\", $s2, \"closed\", \"updated\"]]" \
  forge issue_state_ensure "${A[@]}" \
  "issues=[{\"number\":$s1,\"state\":\"closed\",\"comment\":\"Closing: done.\"},{\"number\":$s2,\"state\":\"closed\"}]"
[ "$(state "$s1") $(state "$s2") $(comments "$s1") $(comments "$s2")" = "closed closed 1 0" ] \
  && [ "$(forge GET "/repos/fxorg/app/issues/$s1/comments" | jq -r '.[0].body')" = "Closing: done." ] \
  && ok "... the forge has both closed, the comment on the first only" \
  || bad "... the forge has both closed, the comment on the first only" "$(state "$s1") $(state "$s2") $(comments "$s1") $(comments "$s2")"
holds "... again: unchanged, and the comment is not posted" \
  '[.dataArtifacts[].attributes.action] == ["unchanged", "unchanged"]' \
  forge issue_state_ensure "${A[@]}" \
  "issues=[{\"number\":$s1,\"state\":\"closed\",\"comment\":\"Closing: done.\"},{\"number\":$s2,\"state\":\"closed\",\"comment\":\"never\"}]"
[ "$(comments "$s1") $(comments "$s2")" = "1 0" ] && ok "... no comment was added" || bad "... no comment was added" "$(comments "$s1") $(comments "$s2")"
holds "... reopens, with a comment and without" \
  '[.dataArtifacts[].attributes | [.state, .action]] == [["open", "updated"], ["open", "updated"]]' \
  forge issue_state_ensure "${A[@]}" \
  "issues=[{\"number\":$s1,\"state\":\"open\",\"comment\":\"Reopened.\"},{\"number\":$s2,\"state\":\"open\"}]"
[ "$(state "$s1") $(state "$s2") $(comments "$s1") $(comments "$s2")" = "open open 2 0" ] \
  && ok "... the forge has both open, one more comment on the first" \
  || bad "... the forge has both open, one more comment on the first" "$(state "$s1") $(state "$s2") $(comments "$s1") $(comments "$s2")"
refuses "a pull request in the list is refused before anything is written" \
  "#$four of fxorg/app is a pull request, not an issue" forge issue_state_ensure "${A[@]}" \
  "issues=[{\"number\":$s1,\"state\":\"closed\",\"comment\":\"must not appear\"},{\"number\":$four,\"state\":\"closed\"}]"
[ "$(state "$s1") $(comments "$s1") $(state "$four")" = "open 2 open" ] \
  && ok "... nothing was written: the issue open, no comment, the pull request open" \
  || bad "... nothing was written: the issue open, no comment, the pull request open" "$(state "$s1") $(comments "$s1") $(state "$four")"
refuses "an issue that is not there is refused" "HTTP 404" forge issue_state_ensure "${A[@]}" \
  'issues=[{"number":99999,"state":"closed"}]'
holds "issue_body_ensure rewrites the text, and records no text" \
  ".dataArtifacts[] | select(.name == \"issue-body-fxorg-app-$s1\") | .attributes | .action == \"updated\" and (has(\"body\") | not)" \
  forge issue_body_ensure "${A[@]}" number="$s1" body="second text"
[ "$(forge GET "/repos/fxorg/app/issues/$s1" | jq -r .body)" = "second text" ] \
  && ok "... the forge has it" || bad "... the forge has it" "$(forge GET "/repos/fxorg/app/issues/$s1" | jq -r .body)"
holds "... the same again is unchanged" '.dataArtifacts[0].attributes.action == "unchanged"' \
  forge issue_body_ensure "${A[@]}" number="$s1" body="second text"
refuses "... a pull request is refused, its text untouched" "#$four of fxorg/app is a pull request" \
  forge issue_body_ensure "${A[@]}" number="$four" body="not this"
[ "$(forge GET "/repos/fxorg/app/pulls/$four" | jq -r .body)" != "not this" ] \
  && ok "... and the pull request's text is as it was" || bad "... and the pull request's text is as it was" "it was rewritten"
summary
