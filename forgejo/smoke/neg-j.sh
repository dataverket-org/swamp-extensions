#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== J. teams, a branch rule's merge whitelist, a team's repository behind a rule ==="
# Its own repositories, so the batch holds whatever the ones before it left.
for r in teamrepo teamrepo2 teamrepo3 teamrepo4 teamrepo5; do
  forge DELETE /repos/fxorg/$r >/dev/null 2>&1
  forge POST /orgs/fxorg/repos "{\"name\":\"$r\",\"auto_init\":true,\"default_branch\":\"main\"}" >/dev/null
done
for t in $(forge GET /orgs/fxorg/teams | jq -r '.[] | select(.name != "Owners") | .id'); do
  forge DELETE /teams/$t >/dev/null
done
TEAM='.dataArtifacts[] | select(.name == "team-fxorg-bots") | .attributes'
UNITS='unitsMap={"repo.code":"write","repo.pulls":"write","repo.issues":"write"}'
# What the plain user, a member of the team, may do to a branch: the forge's own answer for the asking user.
as_plain() { # repo
  curl -sS -H "Authorization: token $(cat "$SMOKE/.work/tokens/narrow")" \
    "$URL/api/v1/repos/fxorg/$1/branches/main" | jq -c '[.protected, .user_can_push, .user_can_merge]'
}
bots() { forge GET /orgs/fxorg/teams | jq '.[] | select(.name == "bots") | .id'; }
team_has() { code "/teams/$(bots)/repos/fxorg/$1"; } # repo: the HTTP status of the team's repository
# The team lists of a repository's main rule as the forge answers them now: [push teams, merge teams].
rule_teams() { forge GET "/repos/fxorg/$1/branch_protections/main" | jq -c '[.push_whitelist_teams, .merge_whitelist_teams]'; }
# A workflow run that must also carry no secret; prints the run's status.
wfs() {
  local s; s=$(wf "$@")
  grep -qE "$SECRETS" "$OUT" "$ERR" && s="leaked"
  echo "$s"
}

holds "team_ensure makes a team with write on three units" \
  "$TEAM | .action == \"created\" and .permission == \"write\" and .unitsMap == {\"repo.code\":\"write\",\"repo.issues\":\"write\",\"repo.pulls\":\"write\"} and (.includesAllRepositories | not) and (.canCreateOrgRepo | not)" \
  forge team_ensure org=fxorg name=bots "$UNITS"
[ "$(forge GET /orgs/fxorg/teams | jq -c '.[] | select(.name == "bots") | [.permission, .units_map, .includes_all_repositories]')" = '["write",{"repo.code":"write","repo.issues":"write","repo.pulls":"write"},false]' ] \
  && ok "... the forge has exactly that" || bad "... the forge has exactly that" "$(forge GET /orgs/fxorg/teams | jq -c '.[] | select(.name == "bots")')"
holds "... the same again writes nothing" "$TEAM | .action == \"unchanged\"" \
  forge team_ensure org=fxorg name=bots "$UNITS"
holds "... a unit named none is the same as one left out" "$TEAM | .action == \"unchanged\"" \
  forge team_ensure org=fxorg name=bots 'unitsMap={"repo.code":"write","repo.pulls":"write","repo.issues":"write","repo.wiki":"none"}'
holds "... the map is the whole map: a unit not named loses its access" \
  "$TEAM | .action == \"updated\" and .unitsMap == {\"repo.code\":\"write\",\"repo.pulls\":\"write\"}" \
  forge team_ensure org=fxorg name=bots 'unitsMap={"repo.code":"write","repo.pulls":"write"}'
holds "... and back" "$TEAM | .action == \"updated\" and (.unitsMap | length) == 3" \
  forge team_ensure org=fxorg name=bots "$UNITS"
refuses "a name that differs only by case is refused with the forge's spelling, nothing sent" \
  'the team is named "bots", not "Bots". Use the forge.s spelling. Nothing was sent' \
  forge team_ensure org=fxorg name=Bots "$UNITS"
[ "$(forge GET /orgs/fxorg/teams | jq '[.[] | select(.name | ascii_downcase == "bots")] | length')" = 1 ] \
  && ok "... and there is still one such team" || bad "... still one such team" "$(forge GET /orgs/fxorg/teams | jq -c '[.[].name]')"
refuses "the Owners team is not changed here" "Owners team is the forge's own" \
  forge team_ensure org=fxorg name=Owners "$UNITS"
[ "$(forge GET /orgs/fxorg/teams | jq -r '.[] | select(.name == "Owners") | .permission')" = owner ] \
  && ok "... and it is as it was" || bad "... and it is as it was" "the Owners team changed"
refuses "a map that gives no access is refused, nothing sent" "gives no access to any unit" \
  forge team_ensure org=fxorg name=nothing 'unitsMap={"repo.code":"none"}'
refuses "administrator access cannot be asked for" "unitsMap|invalid|admin" \
  forge team_ensure org=fxorg name=nothing 'unitsMap={"repo.code":"admin"}'
refuses "a unit that is not a repository unit is refused by the schema" "unitsMap|invalid" \
  forge team_ensure org=fxorg name=nothing 'unitsMap={"org.members":"read"}'
[ "$(forge GET /orgs/fxorg/teams | jq '[.[] | select(.name == "nothing")] | length')" = 0 ] \
  && ok "... and no team was made by any of the three" || bad "... no team was made" "a team named nothing exists"
forge POST /orgs/fxorg/teams '{"name":"admins","permission":"admin","units_map":{"repo.code":"admin"}}' >/dev/null
refuses "a team with administrator access is refused, nothing sent" "has administrator access.*Nothing was sent" \
  forge team_ensure org=fxorg name=admins "$UNITS"
[ "$(forge GET /orgs/fxorg/teams | jq -r '.[] | select(.name == "admins") | .permission')" = admin ] \
  && ok "... and it is still an administrator team" || bad "... still an administrator team" "it changed"
refuses "an organization that is not there carries the forge's message" "HTTP 404" \
  forge team_ensure org=no-such-org name=bots "$UNITS"
refuses "a token without the scope is refused with the forge's message" "HTTP 403" \
  forge-narrow team_ensure org=fxorg name=bots2 "$UNITS"
refuses "a closed port is reported, not retried" "ECONNREFUSED|refused|unreachable|connect" \
  forge-closed team_ensure org=fxorg name=bots "$UNITS"

MEM='.dataArtifacts[] | select(.name == "teammember-fxorg-bots-fxplain") | .attributes'
holds "team_member_ensure adds a user" "$MEM | .action == \"added\"" \
  forge team_member_ensure org=fxorg team=bots username=fxplain
holds "... again is unchanged" "$MEM | .action == \"unchanged\"" \
  forge team_member_ensure org=fxorg team=bots username=fxplain
refuses "a user that does not exist is named, nothing sent" 'there is no user "ghost". Nothing was sent' \
  forge team_member_ensure org=fxorg team=bots username=ghost
refuses "a team that does not exist is named" 'there is no team named "no-team"' \
  forge team_member_ensure org=fxorg team=no-team username=fxplain
refuses "a team named in another case is refused" 'the team is named "bots", not "BOTS"' \
  forge team_member_ensure org=fxorg team=BOTS username=fxother
refuses "nobody is added to the Owners team" "Owners team or has administrator access.*Nothing was sent" \
  forge team_member_ensure org=fxorg team=Owners username=fxother
refuses "... nor to a team with administrator access" "Owners team or has administrator access.*Nothing was sent" \
  forge team_member_ensure org=fxorg team=admins username=fxother
[ "$(forge GET /orgs/fxorg/members | jq '[.[] | select(.login == "fxother")] | length')" = 0 ] \
  && ok "... and the user is in neither" || bad "... the user is in neither" "fxother is a member of fxorg"

REPOA='.dataArtifacts[] | select(.name == "teamrepo-fxorg-bots-teamrepo") | .attributes'
[ "$(as_plain teamrepo)" = '[false,false,false]' ] \
  && ok "before: the member cannot push to a repository the team does not have" \
  || bad "before: the member cannot push" "$(as_plain teamrepo)"
holds "team_repo_ensure adds a repository" "$REPOA | .action == \"added\" and .repo == \"fxorg/teamrepo\" and (.includedByAll | not)" \
  forge team_repo_ensure org=fxorg team=bots name=teamrepo
holds "... again is unchanged" "$REPOA | .action == \"unchanged\"" \
  forge team_repo_ensure org=fxorg team=bots name=teamrepo
[ "$(as_plain teamrepo)" = '[false,true,true]' ] \
  && ok "... and with no branch rule the member can push and merge: the team alone protects nothing" \
  || bad "... the member can push and merge" "$(as_plain teamrepo)"
refuses "a repository that is not there is named, nothing sent" "repository fxorg/no-such-repo does not exist" \
  forge team_repo_ensure org=fxorg team=bots name=no-such-repo
refuses "a team that does not exist is named" 'there is no team named "no-team"' \
  forge team_repo_ensure org=fxorg team=no-team name=teamrepo
refuses "no repository is added to a team with administrator access" "Owners team or has administrator access.*Nothing was sent" \
  forge team_repo_ensure org=fxorg team=admins name=teamrepo
[ "$(code "/teams/$(forge GET /orgs/fxorg/teams | jq '.[] | select(.name == "admins") | .id')/repos/fxorg/teamrepo")" = 404 ] \
  && ok "... and that team is without it" || bad "... that team is without it" "the administrator team has teamrepo"
forge POST /orgs/fxorg/teams '{"name":"everything","permission":"read","units_map":{"repo.code":"read"},"includes_all_repositories":true}' >/dev/null
holds "a team with every repository has it already" \
  '.dataArtifacts[] | select(.name == "teamrepo-fxorg-everything-teamrepo") | .attributes | .action == "unchanged" and .includedByAll' \
  forge team_repo_ensure org=fxorg team=everything name=teamrepo
holds "team_get reads the team, its members and its repositories" \
  "$TEAM | .action == \"observed\" and .members == [\"fxplain\"] and .repositories == [\"fxorg/teamrepo\"] and (.unitsMap | length) == 3" \
  forge team_get org=fxorg name=bots
refuses "... a token without the organization scope is refused with the forge's message" "HTTP 403" \
  forge-narrow team_get org=fxorg name=bots
refuses "... and a team that is not there is named" 'there is no team named "no-team"' \
  forge team_get org=fxorg name=no-team

RULE='.dataArtifacts[] | select(.name == "branch-protection-fxorg-teamrepo-main") | .attributes'
holds "branch_protection_ensure makes a rule with a merge whitelist of a login and a push whitelist" \
  "$RULE | .action == \"created\" and .enablePush and .enablePushWhitelist and .pushWhitelistUsernames == [\"fxadmin\"] and .enableMergeWhitelist and .mergeWhitelistUsernames == [\"fxadmin\"] and .mergeWhitelistTeams == [] and .pushWhitelistTeams == []" \
  forge branch_protection_ensure owner=fxorg name=teamrepo rule=main enablePush=true enablePushWhitelist=true \
  'pushWhitelistUsernames=["fxadmin"]' enableMergeWhitelist=true 'mergeWhitelistUsernames=["fxadmin"]'
[ "$(as_plain teamrepo)" = '[true,false,false]' ] \
  && ok "... and the member of the team can no longer push or merge" || bad "... the member can no longer push or merge" "$(as_plain teamrepo)"
holds "... the same again is unchanged" "$RULE | .action == \"unchanged\"" \
  forge branch_protection_ensure owner=fxorg name=teamrepo rule=main enablePush=true enablePushWhitelist=true \
  'pushWhitelistUsernames=["fxadmin"]' enableMergeWhitelist=true 'mergeWhitelistUsernames=["fxadmin"]'
# A name the forge keeps and does not show: the team in both whitelists while it has the repository, then without it.
forge PUT "/teams/$(bots)/repos/fxorg/teamrepo4" >/dev/null
forge POST /repos/fxorg/teamrepo4/branch_protections '{"rule_name":"main","enable_push":true,"enable_push_whitelist":true,"push_whitelist_usernames":["fxadmin"],"push_whitelist_teams":["bots"],"enable_merge_whitelist":true,"merge_whitelist_usernames":["fxadmin"],"merge_whitelist_teams":["bots"]}' >/dev/null
forge DELETE "/teams/$(bots)/repos/fxorg/teamrepo4" >/dev/null
[ "$(rule_teams teamrepo4)" = '[[],[]]' ] \
  && ok "a team that lost the repository is kept in the rule and not shown" || bad "the forge hides the team" "$(rule_teams teamrepo4)"
holds "... empty team lists are sent over it all the same, and reported unchanged" \
  '.dataArtifacts[] | select(.name == "branch-protection-fxorg-teamrepo4-main") | .attributes | .action == "unchanged" and .pushWhitelistTeams == [] and .mergeWhitelistTeams == []' \
  forge branch_protection_ensure owner=fxorg name=teamrepo4 rule=main 'pushWhitelistTeams=[]' 'mergeWhitelistTeams=[]'
forge PUT "/teams/$(bots)/repos/fxorg/teamrepo4" >/dev/null
[ "$(rule_teams teamrepo4)" = '[[],[]]' ] && [ "$(as_plain teamrepo4)" = '[true,false,false]' ] \
  && ok "... so the team is not back in the whitelists when it gets the repository again" \
  || bad "... the team is not back in the whitelists" "$(rule_teams teamrepo4) $(as_plain teamrepo4)"
holds "... a team with write joins the merge whitelist, the rest stays" \
  "$RULE | .action == \"updated\" and .mergeWhitelistTeams == [\"bots\"] and .mergeWhitelistUsernames == [\"fxadmin\"] and .pushWhitelistUsernames == [\"fxadmin\"]" \
  forge branch_protection_ensure owner=fxorg name=teamrepo rule=main 'mergeWhitelistTeams=["bots"]'
[ "$(as_plain teamrepo)" = '[true,false,true]' ] \
  && ok "... and its member can merge now, and still not push" || bad "... its member can merge now" "$(as_plain teamrepo)"
holds "... an empty list takes the team out again" "$RULE | .action == \"updated\" and .mergeWhitelistTeams == []" \
  forge branch_protection_ensure owner=fxorg name=teamrepo rule=main 'mergeWhitelistTeams=[]'
refuses "a login without write access is named, not reported as an update" \
  'does not count mergeWhitelistUsernames "fxother" in the branch protection main' \
  forge branch_protection_ensure owner=fxorg name=teamrepo rule=main 'mergeWhitelistUsernames=["fxadmin","fxother"]'
refuses "a team without the repository is named" 'does not count pushWhitelistTeams "admins" in the branch protection main' \
  forge branch_protection_ensure owner=fxorg name=teamrepo rule=main 'pushWhitelistTeams=["admins"]'
refuses "a team that does not exist carries the forge's message" "HTTP 422" \
  forge branch_protection_ensure owner=fxorg name=teamrepo rule=main 'pushWhitelistTeams=["no-team"]'
refuses "a login that does not exist carries the forge's message" "HTTP 422" \
  forge branch_protection_ensure owner=fxorg name=teamrepo rule=main 'mergeWhitelistUsernames=["ghost"]'
holds "branch_protection_list shows the merge whitelist as the forge holds it" \
  "$RULE | .action == \"observed\" and .enableMergeWhitelist and .mergeWhitelistUsernames == [\"fxadmin\"]" \
  forge branch_protection_list owner=fxorg name=teamrepo

W=@dataverket/forgejo-team-repository-behind-rule
[ "$(team_has teamrepo2)" = 404 ] && ok "before the workflow the team does not have the second repository" \
  || bad "before the workflow" "the team has teamrepo2"
s=$(wfs $W forgejo=forge owner=fxorg name=teamrepo2 team=bots 'pushWhitelistUsernames=["fxadmin"]' 'mergeWhitelistUsernames=["fxadmin"]')
[ "$s" = succeeded ] && ok "the workflow succeeds" || bad "the workflow succeeds" "status $s: $(tail -c 300 "$ERR")"
[ "$(team_has teamrepo2)" = 200 ] && ok "... the team has the repository" || bad "... the team has the repository" "$(team_has teamrepo2)"
[ "$(as_plain teamrepo2)" = '[true,false,false]' ] \
  && ok "... and its member can neither push to main nor merge into it" || bad "... neither push nor merge" "$(as_plain teamrepo2)"
s=$(wfs $W forgejo=forge owner=fxorg name=teamrepo2 team=bots 'pushWhitelistUsernames=["fxadmin"]' 'mergeWhitelistUsernames=["fxadmin"]')
[ "$s" = succeeded ] && ok "... run again it succeeds and changes nothing" || bad "... run again" "status $s"
s=$(wfs $W forgejo=forge owner=fxorg name=teamrepo3 team=bots 'pushWhitelistUsernames=["fxadmin"]')
[ "$s" = failed ] && ok "a merge whitelist with nobody in it fails the run" || bad "an empty merge whitelist fails the run" "status $s"
[ "$(forge GET /repos/fxorg/teamrepo3/branch_protections | jq length)" = 0 ] && [ "$(team_has teamrepo3)" = 404 ] \
  && ok "... before anything is sent: no rule, and the team is without the repository" \
  || bad "... before anything is sent" "rules $(forge GET /repos/fxorg/teamrepo3/branch_protections | jq length), team $(team_has teamrepo3)"
s=$(wfs $W forgejo=forge owner=fxorg name=teamrepo3 team=bots 'mergeWhitelistUsernames=["fxadmin"]' 'mergeWhitelistTeams=["bots"]')
[ "$s" = failed ] && [ "$(team_has teamrepo3)" = 404 ] \
  && ok "a whitelist that names the team itself fails the run, the team without the repository" \
  || bad "a whitelist that names the team" "status $s, team $(team_has teamrepo3)"
s=$(wfs $W forgejo=forge owner=fxorg name=teamrepo3 team=bots 'mergeWhitelistUsernames=["fxadmin","fxother"]')
[ "$s" = failed ] && [ "$(team_has teamrepo3)" = 404 ] \
  && ok "a rule the forge did not take as asked fails the run, the team without the repository" \
  || bad "a rule the forge did not take" "status $s, team $(team_has teamrepo3)"
s=$(wfs $W forgejo=forge owner=fxorg name=no-such-repo team=bots 'mergeWhitelistUsernames=["fxadmin"]')
[ "$s" = failed ] && ok "a repository that is not there fails the run" || bad "a missing repository fails the run" "status $s"
s=$(wfs $W forgejo=forge owner=fxorg name=teamrepo3 team=admins 'mergeWhitelistUsernames=["fxadmin"]')
[ "$s" = failed ] && [ "$(code "/teams/$(forge GET /orgs/fxorg/teams | jq '.[] | select(.name == "admins") | .id')/repos/fxorg/teamrepo3")" = 404 ] \
  && ok "a team with administrator access fails the run and does not get the repository" \
  || bad "an administrator team fails the run" "status $s"
# The team named in another case than a whitelist names it, on teamrepo2, which the team holds.
s=$(wfs $W forgejo=forge owner=fxorg name=teamrepo2 team=BOTS 'pushWhitelistUsernames=["fxadmin"]' 'mergeWhitelistUsernames=["fxadmin"]' 'mergeWhitelistTeams=["bots"]')
[ "$s" = failed ] && [ "$(rule_teams teamrepo2)" = '[[],[]]' ] && [ "$(as_plain teamrepo2)" = '[true,false,false]' ] \
  && ok "a team named in another case than a whitelist names it fails the run before anything is sent" \
  || bad "a team named in another case" "status $s, rule $(rule_teams teamrepo2), member $(as_plain teamrepo2)"
s=$(wfs $W forgejo=forge owner=fxorg name=teamrepo2 team=bots 'mergeWhitelistUsernames=["fxadmin"]' 'mergeWhitelistTeams=["BOTS"]')
[ "$s" = failed ] && [ "$(rule_teams teamrepo2)" = '[[],[]]' ] \
  && ok "... and so does a whitelist that names the team in another case" \
  || bad "... a whitelist naming the team in another case" "status $s, rule $(rule_teams teamrepo2)"
# The whole run over a rule that hides the team: the team in both whitelists of teamrepo5, then without the repository.
forge PUT "/teams/$(bots)/repos/fxorg/teamrepo5" >/dev/null
forge POST /repos/fxorg/teamrepo5/branch_protections '{"rule_name":"main","enable_push":true,"enable_push_whitelist":true,"push_whitelist_teams":["bots"],"enable_merge_whitelist":true,"merge_whitelist_teams":["bots"]}' >/dev/null
forge DELETE "/teams/$(bots)/repos/fxorg/teamrepo5" >/dev/null
s=$(wfs $W forgejo=forge owner=fxorg name=teamrepo5 team=bots 'pushWhitelistUsernames=["fxadmin"]' 'mergeWhitelistUsernames=["fxadmin"]')
[ "$s" = succeeded ] && [ "$(team_has teamrepo5)" = 200 ] && [ "$(rule_teams teamrepo5)" = '[[],[]]' ] && [ "$(as_plain teamrepo5)" = '[true,false,false]' ] \
  && ok "over a rule that hid the team, the run leaves the team with the repository and in neither whitelist" \
  || bad "over a rule that hid the team" "status $s, team $(team_has teamrepo5), rule $(rule_teams teamrepo5), member $(as_plain teamrepo5)"
summary
