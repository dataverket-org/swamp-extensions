#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== G. the stagecraft tracker, and nothing at rest ==="
L='.dataArtifacts[] | select(.name == "tracker-labels") | .attributes.labels'
TL=/repos/fxorg/tickets/labels

st=$(wf @dataverket/forgejo-stagecraft-labels tracker=tickets forgejo=forge)
[ "$st" = succeeded ] && ok "the labels workflow runs on a repository with none of the tracker's" \
  || bad "the labels workflow runs on a repository with none of the tracker's" "status $st: $(tail -c 300 "$ERR")"
labels=$(forge GET '/repos/fxorg/tickets/labels?limit=50')
[ "$(jq '[.[] | select(.name | test("^(status|type|severity)/")) | select(.exclusive)] | length' <<<"$labels")" = 12 ] \
  && ok "... all twelve are made, exclusive" || bad "... all twelve are made, exclusive" "$(jq -c '[.[].name]' <<<"$labels")"
[ "$(jq -c '[.[] | select(.name == "keep-me") | [.color, .description]]' <<<"$labels")" = '[["123456","not the tracker'"'"'s"]]' ] \
  && ok "... and the extra label is untouched" || bad "... and the extra label is untouched" "$(jq -c '.[] | select(.name == "keep-me")' <<<"$labels")"
holds "labels records the twelve, exclusive, in label_ensure's form" \
  "$L | length == 12 and all(.exclusive) and all(has(\"color\") and has(\"description\"))" tickets labels
holds "... and calls no forge: it works with the forge's port closed" \
  "$L | length == 12" tickets-closed labels
st=$(wf @dataverket/forgejo-stagecraft-labels tracker=tickets forgejo=forge)
[ "$st" = succeeded ] && [ "$(forge GET '/repos/fxorg/tickets/labels?limit=50' | jq -c 'sort_by(.id)')" = "$(jq -c 'sort_by(.id)' <<<"$labels")" ] \
  && ok "... a second workflow run changes nothing on the forge" || bad "... a second workflow run changes nothing on the forge" "status $st, or the labels moved"
forge PATCH "/repos/fxorg/tickets/labels/$(jq '.[] | select(.name == "status/new") | .id' <<<"$labels")" \
  '{"color":"#000000"}' >/dev/null
st=$(wf @dataverket/forgejo-stagecraft-labels tracker=tickets forgejo=forge)
[ "$st" = succeeded ] && [ "$(forge GET "$TL?limit=50" | jq -r '.[] | select(.name == "status/new") | .color')" = bfd4f2 ] \
  && ok "a colour changed by hand is corrected by the workflow" || bad "a colour changed by hand is corrected by the workflow" "status $st"
st=$(wf @dataverket/forgejo-stagecraft-labels tracker=tickets forgejo=forge-wrong)
[ "$st" = failed ] && ! grep -qE "$SECRETS" "$OUT" "$ERR" \
  && ok "the workflow with a wrong forgejo token fails, the token masked" || bad "the workflow with a wrong forgejo token fails, the token masked" "status $st"

holds "describe: the tracker's name, contract 1, nothing optional" \
  '.dataArtifacts[0].attributes | .tracker == "forgejo" and .contract == 1 and .capabilities == {"history": false, "assign": false, "pullRequests": false} and (.closesDuplicates | not)' \
  tickets describe
holds "operate create files an issue in the first status" \
  '.dataArtifacts[0].attributes | .ok and .run == "smoke"' \
  tickets operate answer=answer-g1 operation=create 'request={"title":"Ticket one","body":"b","type":"bug"}' run=smoke
t1=$(jq -r '.dataArtifacts[0].attributes.result.id // .dataArtifacts[0].attributes.result.ticket.id' "$OUT")
[ "$(forge GET "/repos/fxorg/tickets/issues/$t1" | jq -c '[.state, ([.labels[].name] | sort)]')" = '["open",["status/new","type/bug"]]' ] \
  && ok "... the forge has it open with status/new and type/bug" || bad "... the forge has it open with status/new and type/bug" "$(forge GET "/repos/fxorg/tickets/issues/$t1" | jq -c '[.state, [.labels[].name]]')"
holds "... the same answer again makes nothing" '(.dataArtifacts | length) == 0' \
  tickets operate answer=answer-g1 operation=create 'request={"title":"Ticket one","body":"b","type":"bug"}'
holds "a second ticket" '.dataArtifacts[0].attributes.ok' \
  tickets operate answer=answer-g2 operation=create 'request={"title":"Ticket two","body":"","type":"feature"}'
t2=$(jq -r '.dataArtifacts[0].attributes.result.id // .dataArtifacts[0].attributes.result.ticket.id' "$OUT")
holds "set_status shipped closes it" '.dataArtifacts[0].attributes.ok' \
  tickets operate answer=answer-g3 operation=set_status "request={\"issue\":\"$t1\",\"status\":\"shipped\"}"
[ "$(forge GET "/repos/fxorg/tickets/issues/$t1" | jq -c '[.state, ([.labels[].name] | sort)]')" = '["closed",["status/shipped","type/bug"]]' ] \
  && ok "... label and state together" || bad "... label and state together" "$(forge GET "/repos/fxorg/tickets/issues/$t1" | jq -c '[.state, [.labels[].name]]')"
holds "relate parent_of writes the block in both bodies" '.dataArtifacts[0].attributes.ok' \
  tickets operate answer=answer-g4 operation=relate "request={\"issue\":\"$t1\",\"type\":\"parent_of\",\"to\":\"$t2\"}"
forge GET "/repos/fxorg/tickets/issues/$t2" | jq -e --arg p "#$t1" '.body | contains("Child of: " + $p)' >/dev/null \
  && ok "... the child reads its parent" || bad "... the child reads its parent" "no Child of line"
holds "relate blocked_by is the forge's own dependency" '.dataArtifacts[0].attributes.ok' \
  tickets operate answer=answer-g5 operation=relate "request={\"issue\":\"$t2\",\"type\":\"blocked_by\",\"to\":\"$t1\"}"
[ "$(forge GET "/repos/fxorg/tickets/issues/$t2/dependencies" | jq -c '[.[].number]')" = "[$t1]" ] \
  && ok "... the forge has the dependency" || bad "... the forge has the dependency" "$(forge GET "/repos/fxorg/tickets/issues/$t2/dependencies" | head -c 200)"
holds "a second parent is refused as invalid, written as an answer" \
  '.dataArtifacts[0].attributes | (.ok | not) and .kind == "invalid"' \
  tickets operate answer=answer-g6 operation=relate "request={\"issue\":\"$t2\",\"type\":\"parent_of\",\"to\":\"$t2\"}"
holds "fetch_issue reads the relations back and leaves the block out of the description" \
  '.dataArtifacts[0].attributes | .ok and (.result | tostring | contains("stagecraft-relations") | not)' \
  tickets operate answer=answer-g7 operation=fetch_issue "request={\"issue\":\"#$t2\"}"
holds "unrelate removes it" '.dataArtifacts[0].attributes.ok' \
  tickets operate answer=answer-g8 operation=unrelate "request={\"issue\":\"$t1\",\"type\":\"parent_of\",\"to\":\"$t2\"}"
holds "comment" '.dataArtifacts[0].attributes.ok' \
  tickets operate answer=answer-g9 operation=comment "request={\"issue\":\"$t2\",\"body\":\"a note\"}"
holds "a ticket that is not there is not_found" '.dataArtifacts[0].attributes | (.ok | not) and .kind == "not_found"' \
  tickets operate answer=answer-g10 operation=fetch_issue 'request={"issue":"999999"}'
holds "an id that is not a number is invalid" '.dataArtifacts[0].attributes | (.ok | not) and .kind == "invalid"' \
  tickets operate answer=answer-g11 operation=fetch_issue 'request={"issue":"abc"}'
holds "a type not listed is invalid, naming the ones that are" \
  '.dataArtifacts[0].attributes | (.ok | not) and .kind == "invalid" and (.detail | contains("feature"))' \
  tickets operate answer=answer-g12 operation=create 'request={"title":"x","body":"","type":"chore"}'
holds "an operation not offered is invalid" '.dataArtifacts[0].attributes | (.ok | not) and .kind == "invalid"' \
  tickets operate answer=answer-g13 operation=assign 'request={"issue":"1"}'
holds "a wrong token is auth, the token masked" '.dataArtifacts[0].attributes | (.ok | not) and .kind == "auth"' \
  tickets-wrong operate answer=answer-g14 operation=fetch_issue "request={\"issue\":\"$t1\"}"
holds "a closed port is upstream, the forge did not answer" \
  '.dataArtifacts[0].attributes | (.ok | not) and .kind == "upstream" and (.detail | contains("the forge did not answer"))' \
  tickets-closed operate answer=answer-g15 operation=fetch_issue "request={\"issue\":\"$t1\"}"
holds "... and a failed answer is made again when asked again" \
  '.dataArtifacts[0].attributes | (.ok | not) and .kind == "upstream"' \
  tickets-closed operate answer=answer-g15 operation=fetch_issue "request={\"issue\":\"$t1\"}"
refuses "an answer name of another shape is refused" "answer|regex|invalid" \
  tickets operate answer=result-1 operation=fetch_issue 'request={"issue":"1"}'

# What the unit tests on fakes used to say, now said by the forge.
TK=/repos/fxorg/tickets
count_tk() { forge GET "$TK/issues?state=all&type=issues&limit=50" | jq length; }
[ "$(forge GET "$TK/issues?state=all&type=issues&limit=50" | jq '[.[] | select(.title == "Ticket one")] | length')" = 1 ] \
  && ok "the answer made twice filed one issue, not two" || bad "the answer made twice filed one issue, not two" "Ticket one is there more than once"
hand=$(forge POST "$TK/issues" '{"title":"Filed by hand"}' | jq .number)
holds "an issue filed by hand, without a status label, reads as the first status of its state" \
  '.dataArtifacts[0].attributes | .ok and .result.status.name == "new"' \
  tickets operate answer=answer-h1 operation=fetch_issue "request={\"issue\":\"$hand\"}"
forge PATCH "$TK/issues/$hand" '{"state":"closed"}' >/dev/null
holds "... closed by hand, the first closed status" \
  '.dataArtifacts[0].attributes | .ok and .result.status.name == "shipped"' \
  tickets operate answer=answer-h2 operation=fetch_issue "request={\"issue\":\"$hand\"}"
forge POST "$TK/contents/pr.txt" "{\"content\":\"$(printf pr | base64)\",\"message\":\"pr\",\"branch\":\"main\",\"new_branch\":\"feat/pr\"}" >/dev/null
prn=$(forge POST "$TK/pulls" '{"head":"feat/pr","base":"main","title":"A pull request"}' | jq .number)
holds "a pull request is not a ticket" \
  '.dataArtifacts[0].attributes | (.ok | not) and .kind == "not_found" and (.detail | contains("is a pull request"))' \
  tickets operate answer=answer-h3 operation=fetch_issue "request={\"issue\":\"$prn\"}"
holds "a comment on a missing issue is not_found, and posts nothing" \
  '.dataArtifacts[0].attributes | (.ok | not) and .kind == "not_found"' \
  tickets operate answer=answer-h4 operation=comment 'request={"issue":"999999","body":"x"}'
holds "set_status to the status it has changes nothing" \
  '.dataArtifacts[0].attributes | .ok and .result.changed == false' \
  tickets operate answer=answer-h5 operation=set_status "request={\"issue\":\"$t1\",\"status\":\"shipped\"}"
holds "set_status back to an open status reopens it" '.dataArtifacts[0].attributes | .ok and .result.changed' \
  tickets operate answer=answer-h6 operation=set_status "request={\"issue\":\"$t1\",\"status\":\"in-progress\"}"
[ "$(forge GET "$TK/issues/$t1" | jq -c '[.state, ([.labels[].name | select(startswith("status/"))])]')" = '["open",["status/in-progress"]]' ] \
  && ok "... open, with one status label" || bad "... open, with one status label" "$(forge GET "$TK/issues/$t1" | jq -c '[.state, [.labels[].name]]')"
holds "an unknown status is invalid, naming the valid ones" \
  '.dataArtifacts[0].attributes | (.ok | not) and .kind == "invalid" and (.detail | contains("in-progress"))' \
  tickets operate answer=answer-h7 operation=set_status "request={\"issue\":\"$t1\",\"status\":\"done\"}"
holds "relating to a missing ticket is not_found" \
  '.dataArtifacts[0].attributes | (.ok | not) and .kind == "not_found"' \
  tickets operate answer=answer-h8 operation=relate "request={\"issue\":\"$t1\",\"type\":\"related_to\",\"to\":\"999999\"}"
# A second status label set by hand goes with the next set_status.
forge POST "$TK/issues/$t1/labels" "{\"labels\":[$(forge GET "$TK/labels?limit=50" | jq '.[] | select(.name == "status/new") | .id')]}" >/dev/null
holds "set_status drops a second status label put there by hand" '.dataArtifacts[0].attributes | .ok and .result.changed' \
  tickets operate answer=answer-h9 operation=set_status "request={\"issue\":\"$t1\",\"status\":\"in-progress\"}"
[ "$(forge GET "$TK/issues/$t1" | jq -c '[.labels[].name | select(startswith("status/"))]')" = '["status/in-progress"]' ] \
  && ok "... one status label left" || bad "... one status label left" "$(forge GET "$TK/issues/$t1" | jq -c '[.labels[].name]')"
# A dependency on another repository's issue is the forge's, not this tracker's.
other=$(forge POST /repos/fxorg/app/issues '{"title":"Elsewhere"}' | jq .number)
forge POST "$TK/issues/$t2/dependencies" "{\"owner\":\"fxorg\",\"repo\":\"app\",\"index\":$other}" >/dev/null
[ "$(forge GET "$TK/issues/$t2/dependencies" | jq length)" = 2 ] \
  && ok "the forge has a dependency of the ticket on another repository's issue" \
  || bad "the forge has a dependency of the ticket on another repository's issue" "$(forge GET "$TK/issues/$t2/dependencies" | head -c 200)"
holds "... which fetch_issue leaves out" \
  "[.dataArtifacts[0].attributes.result.relations[] | select(.type == \"blocked_by\" and .direction == \"outgoing\") | .issue] == [\"$t1\"]" \
  tickets operate answer=answer-h10 operation=fetch_issue "request={\"issue\":\"$t2\"}"
# A dependency list longer than one page.
holds "a ticket for a long dependency list" '.dataArtifacts[0].attributes.ok' \
  tickets operate answer=answer-h11 operation=create 'request={"title":"Blocked a lot","body":"","type":"bug"}'
t3=$(jq -r '.dataArtifacts[0].attributes.result.id' "$OUT")
for i in $(seq 1 52); do
  n=$(forge POST "$TK/issues" "{\"title\":\"Blocker $i\"}" | jq .number)
  forge POST "$TK/issues/$t3/dependencies" "{\"owner\":\"fxorg\",\"repo\":\"tickets\",\"index\":$n}" >/dev/null
done
holds "... is read to the end: 52 blockers" \
  '[.dataArtifacts[0].attributes.result.relations[] | select(.type == "blocked_by" and .direction == "outgoing")] | length == 52' \
  tickets operate answer=answer-h12 operation=fetch_issue "request={\"issue\":\"$t3\"}"
# A relation written on one side only, by hand: unrelate writes that side.
a=$(forge POST "$TK/issues" '{"title":"One side"}' | jq .number)
b=$(forge POST "$TK/issues" '{"title":"Other side","body":"untouched"}' | jq .number)
forge PATCH "$TK/issues/$a" "$(jq -n --arg b "$(printf 'text\n\n<!-- stagecraft-relations: kept by the tracker -->\nRelated to: #%s\n<!-- /stagecraft-relations -->' "$b")" '{body: $b}')" >/dev/null
holds "a relation on one side only is read from that side" \
  "[.dataArtifacts[0].attributes.result.relations[] | select(.type == \"related_to\") | .issue] == [\"$b\"]" \
  tickets operate answer=answer-h13 operation=fetch_issue "request={\"issue\":\"$a\"}"
holds "... and unrelate removes it" '.dataArtifacts[0].attributes | .ok and .result.changed' \
  tickets operate answer=answer-h14 operation=unrelate "request={\"issue\":\"$a\",\"type\":\"related_to\",\"to\":\"$b\"}"
[ "$(forge GET "$TK/issues/$a" | jq -r .body)" = text ] && [ "$(forge GET "$TK/issues/$b" | jq -r .body)" = untouched ] \
  && ok "... from that side, the other untouched" || bad "... from that side, the other untouched" "$(forge GET "$TK/issues/$a" | jq -c .body) $(forge GET "$TK/issues/$b" | jq -c .body)"
# A repository whose tracker labels are not there.
before=$(forge GET '/repos/fxorg/tool/issues?state=all&type=issues&limit=50' | jq length)
holds "create on a repository without the tracker's labels says the labels workflow makes them" \
  '.dataArtifacts[0].attributes | (.ok | not) and .kind == "invalid" and (.detail | contains("forgejo-stagecraft-labels makes them"))' \
  tickets-bare operate answer=answer-h15 operation=create 'request={"title":"x","body":"","type":"bug"}'
[ "$(forge GET '/repos/fxorg/tool/issues?state=all&type=issues&limit=50' | jq length)" = "$before" ] \
  && ok "... and files nothing" || bad "... and files nothing" "an issue was filed on fxorg/tool"
# A repository with issue dependencies switched off.
forge POST /orgs/fxorg/repos '{"name":"nodeps","auto_init":true,"private":false}' >/dev/null
forge PATCH /repos/fxorg/nodeps '{"internal_tracker":{"enable_time_tracker":false,"allow_only_contributors_to_track_time":true,"enable_issue_dependencies":false}}' >/dev/null
[ "$(forge GET /repos/fxorg/nodeps | jq .internal_tracker.enable_issue_dependencies)" = false ] \
  && ok "a repository with issue dependencies off" || bad "a repository with issue dependencies off" "$(forge GET /repos/fxorg/nodeps | jq -c .internal_tracker)"
st=$(wf @dataverket/forgejo-stagecraft-labels tracker=tickets-nodeps forgejo=forge)
[ "$st" = succeeded ] && ok "... gets the tracker's labels" || bad "... gets the tracker's labels" "status $st"
holds "... create still answers" '.dataArtifacts[0].attributes.ok' \
  tickets-nodeps operate answer=answer-h16 operation=create 'request={"title":"No deps","body":"","type":"bug"}'
nd=$(jq -r '.dataArtifacts[0].attributes.result.id' "$OUT")
holds "... and the ticket reads as having no relations" \
  '.dataArtifacts[0].attributes | .ok and .result.relations == []' \
  tickets-nodeps operate answer=answer-h17 operation=fetch_issue "request={\"issue\":\"$nd\"}"
# A renamed repository: refused with the new name, never followed.
forge POST /orgs/fxorg/repos '{"name":"tk-old","auto_init":true,"private":false}' >/dev/null
forge PATCH /repos/fxorg/tk-old '{"name":"tk-new"}' >/dev/null
holds "a tracker on a renamed repository answers upstream, naming the new name" \
  '.dataArtifacts[0].attributes | (.ok | not) and .kind == "upstream" and (.detail | contains("fxorg/tk-old was renamed; it now redirects to /api/v1/repos/fxorg/tk-new"))' \
  tickets-renamed operate answer=answer-h18 operation=fetch_issue 'request={"issue":"1"}'

st=$(wf @swamp/stagecraft/conformance tracker=tickets-pub statusNames=in-progress,shipped createType=bug missing=999999)
[ "$st" = succeeded ] && ok "stagecraft's conformance workflow passes through a publisher" \
  || bad "stagecraft's conformance workflow passes through a publisher" "status $st: $(tail -c 400 "$ERR")"

# The merge-settings workflow: a fresh repository with every merge style on and a
# main rule that requires an up-to-date branch.
forge POST /orgs/fxorg/repos '{"name":"merges","auto_init":true,"default_branch":"main","private":false}' >/dev/null
forge POST /repos/fxorg/merges/branch_protections '{"rule_name":"main","block_on_outdated_branch":true,"required_approvals":1}' >/dev/null
MS='.allow_merge_commits and .default_merge_style == "merge" and (.allow_fast_forward_only_merge | not) and (.allow_rebase | not) and (.allow_rebase_explicit | not) and (.allow_squash_merge | not) and (.allow_rebase_update | not)'
st=$(wf @dataverket/forgejo-stagecraft-merge-settings forgejo=forge owner=fxorg name=merges)
[ "$st" = succeeded ] && [ "$(forge GET /repos/fxorg/merges | jq "$MS")" = true ] \
  && ok "the merge-settings workflow leaves merge commits only" || bad "the merge-settings workflow leaves merge commits only" "status $st: $(forge GET /repos/fxorg/merges | jq -c '{allow_merge_commits, allow_fast_forward_only_merge, allow_rebase, allow_rebase_explicit, allow_squash_merge, allow_rebase_update, default_merge_style}')"
[ "$(forge GET /repos/fxorg/merges/branch_protections/main | jq -c '[.block_on_outdated_branch, .required_approvals]')" = '[false,1]' ] \
  && ok "... and main's rule stops requiring an up-to-date branch, the rest kept" || bad "... and main's rule stops requiring an up-to-date branch, the rest kept" "$(forge GET /repos/fxorg/merges/branch_protections/main | jq -c .)"
st=$(wf @dataverket/forgejo-stagecraft-merge-settings forgejo=forge owner=fxorg name=merges)
[ "$st" = succeeded ] && jq -e '[.. | objects | select(.stepName? == "no-outdated-branch-block" and .status? == "skipped")] | length > 0' -s "$OUT" >/dev/null \
  && ok "... a second run sends nothing to the rule (the step is guarded off)" || bad "... a second run sends nothing to the rule (the step is guarded off)" "status $st"
st=$(wf @dataverket/forgejo-stagecraft-merge-settings forgejo=forge owner=fxorg name=tickets)
[ "$st" = succeeded ] && [ "$(forge GET /repos/fxorg/tickets/branch_protections | jq length)" = 0 ] \
  && ok "... a repository without a branch rule is left without one" || bad "... a repository without a branch rule is left without one" "status $st: $(forge GET /repos/fxorg/tickets/branch_protections | jq -c '[.[].rule_name]')"
st=$(wf @dataverket/forgejo-stagecraft-merge-settings forgejo=forge owner=fxorg name=nopr)
[ "$st" = failed ] && [ "$(forge GET /repos/fxorg/nopr | jq .has_pull_requests)" = false ] \
  && ok "... a repository with pull requests off is refused, and left off" || bad "... a repository with pull requests off is refused, and left off" "status $st"
# A rule recorded earlier, then deleted on the forge: the old record must not make the step create one.
forge POST /orgs/fxorg/repos '{"name":"merges2","auto_init":true,"default_branch":"main","private":false}' >/dev/null
forge POST /repos/fxorg/merges2/branch_protections '{"rule_name":"main","block_on_outdated_branch":true}' >/dev/null
run forge branch_protection_list owner=fxorg name=merges2 >/dev/null
forge DELETE /repos/fxorg/merges2/branch_protections/main >/dev/null
st=$(wf @dataverket/forgejo-stagecraft-merge-settings forgejo=forge owner=fxorg name=merges2)
[ "$st" = succeeded ] && [ "$(forge GET /repos/fxorg/merges2/branch_protections | jq length)" = 0 ] \
  && ok "... an older record of a rule deleted since creates no rule" || bad "... an older record of a rule deleted since creates no rule" "status $st: $(forge GET /repos/fxorg/merges2/branch_protections | jq -c '[.[].rule_name]')"
st=$(wf @dataverket/forgejo-stagecraft-merge-settings forgejo=forge-wrong owner=fxorg name=merges)
[ "$st" = failed ] && ! grep -qE "$SECRETS" "$OUT" "$ERR" \
  && ok "... a wrong token fails the run, the token masked" || bad "... a wrong token fails the run, the token masked" "status $st"

summary
