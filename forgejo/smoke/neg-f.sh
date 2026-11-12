#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== F. refused, unreachable, misaddressed, missing ==="

refuses "a wrong token: the live check stops a write, naming the 401" "forgejo-token-accepted.*401|401.*forgejo-token-accepted" \
  forge-wrong org_ensure name=never-made
[ "$(code /orgs/never-made)" = 404 ] && ok "... and nothing was made" || bad "... and nothing was made" "never-made exists"
refuses "... the check stops a read too" "forgejo-token-accepted" forge-wrong repo_list
# Past the check, the forge's own answer: it echoes the token, which is masked.
refuses "... with the live check skipped a read fails on the 401, the echoed token masked" "HTTP 401" \
  forge-wrong repo_list --skip-check-label=live
refuses "... and so does the admin list" "HTTP 401" forge-wrong user_list --skip-check-label=live
refuses "... and the write itself" "HTTP 401" \
  forge-wrong org_ensure name=never-made --skip-check-label=live

refuses "a closed port: the live check fails a write" "forgejo-token-accepted.*GET http://127.0.0.1:13999/api/v1/user could not be reached" \
  forge-closed repo_ensure owner=fxorg name=never-made
refuses "... and a read, past the check, names the address it tried" \
  "GET http://127.0.0.1:13999/api/v1/version could not be reached: .*(ECONNREFUSED|refused)" \
  forge-closed health --skip-check-label=live
refuses "apiUrl ending in /api/v1: the policy check names it, once" "should be the forge's base URL without /api/v1" \
  forge-apiv1 org_ensure name=never-made
if grep -q "forgejo-token-accepted" "$ERR"; then
  bad "... and the live check stands down" "the live check reported too"
else
  ok "... and the live check stands down"
fi
refuses "... a read is stopped by the same check" "should be the forge's base URL without /api/v1" forge-apiv1 org_list
refuses "... and past it gets the doubled path's 404" "GET /api/v1/orgs.*HTTP 404" \
  forge-apiv1 org_list --skip-check-label=policy

refuses "a narrow token passes the live check and the write is refused for its scope" "HTTP 403.*scope" \
  forge-narrow repo_ensure owner=fxorg name=never-made
refuses "... a label write too" "HTTP 403.*scope" \
  forge-narrow label_ensure owner=fxorg 'labels=[{"name":"x","color":"000000"}]'
holds "... yet it reads a repository" '[.dataArtifacts[].attributes.repo] | length > 0 and all(. == "fxorg/app")' \
  forge-narrow pr_list owner=fxorg name=app state=closed

refuses "repo_ensure in an organization that is not there" "HTTP 404|HTTP 422" \
  forge repo_ensure owner=no-such-org name=x
refuses "issue_list of a repository that is not there" "HTTP 404" forge issue_list owner=fxorg name=no-such-repo
refuses "label_list of an organization that is not there" "HTTP 404" forge label_list owner=no-such-org
refuses "pr_feedback of a pull request that is not there" "HTTP 404" forge pr_feedback owner=fxorg name=app index=9999
refuses "pr_comment on a pull request that is not there" "HTTP 404" \
  forge pr_comment owner=fxorg name=app index=9999 body=x
refuses "pr_merge_state of a pull request that is not there" "HTTP 404" \
  forge pr_merge_state owner=fxorg name=app index=9999
refuses "pr_merge of a pull request that is not there" "does not exist" forge pr_merge owner=fxorg name=app index=9999
refuses "webhook_audit of a repository that is not there" "No such repo: fxorg/no-such-repo" \
  forge webhook_audit owner=fxorg name=no-such-repo
refuses "push_mirror_list of an owner that is not there" "HTTP 404" forge push_mirror_list owner=no-such-org
refuses "runner_list of an owner that is not there" "HTTP 404" forge runner_list owner=no-such-org
refuses "collaborator_ensure of a user that is not there" "HTTP 404|HTTP 422" \
  forge collaborator_ensure owner=fxorg name=tool user=no-such-user
refuses "work_item_sync of a factory with no such work item files nothing" "no-such-factory has no work item WI-1" \
  forge work_item_sync owner=fxorg name=tool factory=no-such-factory workItem=WI-1
[ "$(forge GET '/repos/fxorg/tool/issues?state=all&type=issues' | jq length)" = 0 ] \
  && ok "... and no issue was filed" || bad "... and no issue was filed" "an issue appeared on fxorg/tool"

refuses "pull requests off: pr_ensure is the forge's refusal" "HTTP 4" \
  forge pr_ensure owner=fxorg name=nopr head=main base=main title=x
refuses "pull requests off: pr_list too" "HTTP 4" forge pr_list owner=fxorg name=nopr
summary
