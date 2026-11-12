#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== B. units, merge settings, topics, labels, branch protection ==="
MS='.dataArtifacts[] | select(.name == "repo-merge-settings-fxorg-tool") | .attributes'

holds "repo_units_ensure switches projects off and says so" \
  '.dataArtifacts[] | select(.name == "repo-units-fxorg-tool") | .attributes | .action == "updated" and .changed == ["hasProjects"] and (.hasProjects | not)' \
  forge repo_units_ensure owner=fxorg name=tool hasProjects=false
holds "... again is unchanged, and the units not named are as they were" \
  '.dataArtifacts[] | select(.name == "repo-units-fxorg-tool") | .attributes | .action == "unchanged" and .changed == [] and .hasActions and .hasPackages' \
  forge repo_units_ensure owner=fxorg name=tool hasProjects=false
refuses "... and with nothing named it refuses rather than guess" "name at least one unit" \
  forge repo_units_ensure owner=fxorg name=tool
refuses "units of a repository that is not there" "repository fxorg/no-such-repo does not exist" \
  forge repo_units_ensure owner=fxorg name=no-such-repo hasActions=true

holds "repo_merge_settings_ensure with no setting reads all eleven" \
  "$MS | .action == \"unchanged\" and .hasPullRequests and ([.allowMergeCommits, .allowRebase, .allowRebaseExplicit, .allowSquashMerge, .allowFastForwardOnlyMerge, .allowRebaseUpdate, .defaultMergeStyle, .defaultUpdateStyle, .defaultDeleteBranchAfterMerge, .defaultAllowMaintainerEdit, .ignoreWhitespaceConflicts] | all(. != null))" \
  forge repo_merge_settings_ensure owner=fxorg name=tool
holds "... merge commits only, written and read back" \
  "$MS | .action == \"updated\" and .allowMergeCommits and (.allowRebase | not) and (.allowRebaseExplicit | not) and (.allowSquashMerge | not) and (.allowRebaseUpdate | not) and .defaultMergeStyle == \"merge\"" \
  forge repo_merge_settings_ensure owner=fxorg name=tool allowMergeCommits=true defaultMergeStyle=merge \
  allowRebase=false allowRebaseExplicit=false allowSquashMerge=false allowRebaseUpdate=false
holds "... the same again writes nothing" \
  "$MS | .action == \"unchanged\" and .changed == []" \
  forge repo_merge_settings_ensure owner=fxorg name=tool allowMergeCommits=true defaultMergeStyle=merge \
  allowRebase=false allowRebaseExplicit=false allowSquashMerge=false allowRebaseUpdate=false
holds "... one setting changes that one, the rest stay" \
  "$MS | .changed == [\"defaultDeleteBranchAfterMerge\"] and .defaultDeleteBranchAfterMerge and (.allowRebase | not)" \
  forge repo_merge_settings_ensure owner=fxorg name=tool defaultDeleteBranchAfterMerge=true
holds "pull requests off: a read reports false and merge everywhere" \
  '.dataArtifacts[] | select(.name == "repo-merge-settings-fxorg-nopr") | .attributes | (.hasPullRequests | not) and .defaultMergeStyle == "merge" and (.allowMergeCommits | not)' \
  forge repo_merge_settings_ensure owner=fxorg name=nopr
refuses "pull requests off: any setting is refused, nothing sent" "pull requests are off.*Nothing was sent" \
  forge repo_merge_settings_ensure owner=fxorg name=nopr allowMergeCommits=false
[ "$(forge GET /repos/fxorg/nopr | jq .has_pull_requests)" = false ] \
  && ok "... and pull requests are still off" || bad "... and pull requests are still off" "they were turned on"
refuses "an unknown merge style is refused by the schema" "defaultMergeStyle|invalid" \
  forge repo_merge_settings_ensure owner=fxorg name=tool defaultMergeStyle=octopus
refuses "merge settings of a repository that is not there" "does not exist" \
  forge repo_merge_settings_ensure owner=fxorg name=no-such-repo

holds "repo_topics_ensure adds topics" \
  '.dataArtifacts[] | select(.name == "repo-topics-fxorg-tool") | .attributes | .action == "updated" and .topics == ["alpha", "beta"] and .added == ["alpha", "beta"]' \
  forge repo_topics_ensure owner=fxorg name=tool 'topics=["beta","alpha"]'
holds "... additive: another one keeps the two" \
  '.dataArtifacts[] | select(.name == "repo-topics-fxorg-tool") | .attributes | .topics == ["alpha", "beta", "gamma"] and .removed == []' \
  forge repo_topics_ensure owner=fxorg name=tool 'topics=["gamma"]'
holds "... exact makes the list the whole set" \
  '.dataArtifacts[] | select(.name == "repo-topics-fxorg-tool") | .attributes | .topics == ["gamma"] and .removed == ["alpha", "beta"]' \
  forge repo_topics_ensure owner=fxorg name=tool 'topics=["gamma"]' exact=true
[ "$(forge GET /repos/fxorg/tool/topics | jq -c .topics)" = '["gamma"]' ] \
  && ok "... the forge has exactly that" || bad "... the forge has exactly that" "$(forge GET /repos/fxorg/tool/topics)"
holds "... and again is unchanged" \
  '.dataArtifacts[] | select(.name == "repo-topics-fxorg-tool") | .attributes.action == "unchanged"' \
  forge repo_topics_ensure owner=fxorg name=tool 'topics=["gamma"]' exact=true
refuses "a topic Forgejo would refuse is named first" 'invalid topic.*"-bad topic"' \
  forge repo_topics_ensure owner=fxorg name=tool 'topics=["-bad topic"]'

holds "label_ensure makes organization labels" \
  '[.dataArtifacts[] | .attributes | select(.scope == "org" and .action == "created")] | map(.name) | sort == ["kind/bug", "kind/feature"]' \
  forge label_ensure owner=fxorg \
  'labels=[{"name":"kind/bug","color":"#ee0701","exclusive":true},{"name":"kind/feature","color":"0e8a16","exclusive":true}]'
bugid=$(jq '[.dataArtifacts[] | .attributes | select(.name == "kind/bug")] | .[0].id' "$OUT")
holds "... a different colour is patched in place, keeping the id" \
  "[.dataArtifacts[] | .attributes | select(.name == \"kind/bug\")] | .[0] | .action == \"updated\" and .color == \"aa0000\" and .id == $bugid" \
  forge label_ensure owner=fxorg 'labels=[{"name":"kind/bug","color":"#AA0000","exclusive":true}]'
holds "... the same in other case and without # is unchanged" \
  '[.dataArtifacts[] | .attributes | select(.name == "kind/bug")] | .[0].action == "unchanged"' \
  forge label_ensure owner=fxorg 'labels=[{"name":"kind/bug","color":"aa0000","exclusive":true}]'
holds "repository labels sit beside them" \
  '[.dataArtifacts[] | .attributes | select(.scope == "repo")] | map(.name) | sort == ["docs", "wontfix"]' \
  forge label_ensure owner=fxorg name=tool \
  'labels=[{"name":"docs","color":"0075ca"},{"name":"wontfix","color":"ffffff","description":"not now"}]'
holds "prune deletes the scope's others, and only there" \
  '[.dataArtifacts[] | .attributes | select(.action == "deleted")] | map(.name) == ["wontfix"]' \
  forge label_ensure owner=fxorg name=tool 'labels=[{"name":"docs","color":"0075ca"}]' prune=true
holds "label_list of the organization" \
  '[.dataArtifacts[] | .attributes | select(.scope == "org") | .name] | sort == ["kind/bug", "kind/feature"]' \
  forge label_list owner=fxorg
holds "label_list of the repository, its own only" \
  '[.dataArtifacts[] | .attributes | .name] == ["docs"]' forge label_list owner=fxorg name=tool
refuses "a colour that is not six hex digits is refused" "color|invalid|regex" \
  forge label_ensure owner=fxorg name=tool 'labels=[{"name":"x","color":"red"}]'

holds "branch_protection_ensure creates a rule" \
  '.dataArtifacts[] | select(.name == "branch-protection-fxorg-tool-main") | .attributes | .action == "created" and (.enablePush | not) and .requiredApprovals == 1 and .protectedFilePatterns == ".forgejo/**"' \
  forge branch_protection_ensure owner=fxorg name=tool rule=main enablePush=false requiredApprovals=1 \
  protectedFilePatterns='.forgejo/**'
holds "... the same again is unchanged" \
  '.dataArtifacts[] | select(.name == "branch-protection-fxorg-tool-main") | .attributes.action == "unchanged"' \
  forge branch_protection_ensure owner=fxorg name=tool rule=main enablePush=false requiredApprovals=1
holds "... a status check is an update, the rest kept" \
  '.dataArtifacts[] | select(.name == "branch-protection-fxorg-tool-main") | .attributes | .action == "updated" and .enableStatusCheck and .statusCheckContexts == ["ci/build"] and .requiredApprovals == 1' \
  forge branch_protection_ensure owner=fxorg name=tool rule=main enableStatusCheck=true 'statusCheckContexts=["ci/build"]'
holds "... a glob rule is a rule of its own" \
  '.dataArtifacts[] | select(.name == "branch-protection-fxorg-tool-release") | .attributes | .action == "created" and .ruleName == "release/*"' \
  forge branch_protection_ensure owner=fxorg name=tool 'rule=release/*' applyToAdmins=true
holds "branch_protection_list reads both" \
  '[.dataArtifacts[].attributes.ruleName] | sort == ["main", "release/*"]' forge branch_protection_list owner=fxorg name=tool
refuses "branch protection of a repository that is not there" "HTTP 404" \
  forge branch_protection_list owner=fxorg name=no-such-repo
# Tag protection: a rule of another pattern made by hand must outlive all of it.
forge POST /repos/fxorg/tool/tag_protections '{"name_pattern":"v*","whitelist_usernames":["fxadmin"]}' >/dev/null
TP='.dataArtifacts[] | select(.name == "tag-protection-fxorg-tool-attestation") | .attributes'
tags() { forge GET /repos/fxorg/tool/tag_protections | jq -c --arg p "$1" '[.[] | select(.name_pattern == $p) | [(.whitelist_usernames | sort), (.whitelist_teams | sort)]]'; }
holds "tag_protection_ensure creates a rule for a glob" \
  "$TP | .action == \"created\" and .namePattern == \"attestation/*\" and .whitelistUsernames == [\"fxadmin\"]" \
  forge tag_protection_ensure owner=fxorg name=tool 'namePattern=attestation/*' 'whitelistUsernames=["fxadmin"]'
[ "$(tags 'attestation/*')" = '[[["fxadmin"],[]]]' ] && ok "... the forge has it" || bad "... the forge has it" "$(tags 'attestation/*')"
holds "... the same again is unchanged" "$TP | .action == \"unchanged\"" \
  forge tag_protection_ensure owner=fxorg name=tool 'namePattern=attestation/*' 'whitelistUsernames=["fxadmin"]'
# Forgejo stores a login that may not write to the repository but leaves it
# out of the rule's answer and its effect, without a word; fxplain may only
# read fxorg/tool.
refuses "... a login without write access is refused, named, not reported as updated" \
  'does not count "fxplain" in the tag protection attestation/\*.*write access' \
  forge tag_protection_ensure owner=fxorg name=tool 'namePattern=attestation/*' \
  'whitelistUsernames=["fxadmin","fxplain"]' 'whitelistTeams=["Owners"]'
holds "... given write access" 'true' forge collaborator_ensure owner=fxorg name=tool user=fxplain permission=write
holds "... with write access the login counts, and the rule, written by the refused run, is as asked" \
  "$TP | .action == \"unchanged\" and (.whitelistUsernames | sort) == [\"fxadmin\", \"fxplain\"]" \
  forge tag_protection_ensure owner=fxorg name=tool 'namePattern=attestation/*' \
  'whitelistUsernames=["fxadmin","fxplain"]' 'whitelistTeams=["Owners"]'
[ "$(tags 'attestation/*')" = '[[["fxadmin","fxplain"],["Owners"]]]' ] && ok "... the forge has both" || bad "... the forge has both" "$(tags 'attestation/*')"
holds "... in another order it is unchanged" "$TP | .action == \"unchanged\"" \
  forge tag_protection_ensure owner=fxorg name=tool 'namePattern=attestation/*' \
  'whitelistUsernames=["fxplain","fxadmin"]' 'whitelistTeams=["Owners"]'
holds "... exact sets: a login and the team left out go" "$TP | .action == \"updated\" and .whitelistUsernames == [\"fxadmin\"] and .whitelistTeams == []" \
  forge tag_protection_ensure owner=fxorg name=tool 'namePattern=attestation/*' 'whitelistUsernames=["fxadmin"]'
[ "$(tags 'attestation/*')" = '[[["fxadmin"],[]]]' ] && ok "... the forge has exactly that" || bad "... the forge has exactly that" "$(tags 'attestation/*')"
holds "... a login and a team added back converge it" \
  "$TP | .action == \"updated\" and (.whitelistUsernames | sort) == [\"fxadmin\", \"fxplain\"] and .whitelistTeams == [\"Owners\"]" \
  forge tag_protection_ensure owner=fxorg name=tool 'namePattern=attestation/*' \
  'whitelistUsernames=["fxplain","fxadmin"]' 'whitelistTeams=["Owners"]'
[ "$(tags 'attestation/*')" = '[[["fxadmin","fxplain"],["Owners"]]]' ] && ok "... the forge has them" || bad "... the forge has them" "$(tags 'attestation/*')"
[ "$(tags 'v*')" = '[[["fxadmin"],[]]]' ] && ok "... and the other rule is untouched" || bad "... and the other rule is untouched" "$(tags 'v*')"
refuses "tag protection of a repository that is not there" "HTTP 404" \
  forge tag_protection_ensure owner=fxorg name=no-such-repo 'namePattern=x*'
summary
