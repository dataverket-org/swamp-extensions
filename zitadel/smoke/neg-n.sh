#!/usr/bin/env bash
source ./negative.sh
echo "=== N. a swamp workflow, run twice ==="

# The models one at a time are one thing; the way swamp actually drives them —
# a DAG, guards, asserts and data.latest wiring between steps — is another, and
# this is the only batch that tests it.

wf() { swamp workflow "$@" >"$OUT" 2>"$ERR"; }

if wf validate zitadel-selftest; then ok "the workflow validates, inputs and all"; else
  bad "the workflow validates, inputs and all" "$(tail -c 300 "$ERR")"; fi

if wf run zitadel-selftest --json; then ok "it provisions what decision 015 needs"; else
  bad "it provisions what decision 015 needs" "$(tail -c 300 "$ERR")"; fi

status=$(swamp workflow history get zitadel-selftest --json 2>/dev/null | jq -r '.status')
[ "$status" = "succeeded" ] && ok "every step succeeded, asserts included" ||
  bad "every step succeeded, asserts included" "run status was $status"

failed=$(swamp workflow history get zitadel-selftest --json 2>/dev/null | jq -r '[.jobs[].steps[] | select(.status != "succeeded") | .name] | join(",")')
[ -z "$failed" ] && ok "no step was skipped or failed" || bad "no step was skipped or failed" "$failed"

# The asserts above are the real test of the data names: a workflow author has
# to be able to write data.latest("zitadel-app", "app-<project>-<app>") without
# knowing an id that only exists after the run.
if wf run zitadel-selftest --json; then ok "running it a second time succeeds"; else
  bad "running it a second time succeeds" "$(tail -c 300 "$ERR")"; fi

for pair in \
  "zitadel-project:project-kubernetes" \
  "zitadel-project:role-kubernetes-kube-admins" \
  "zitadel-project:role-kubernetes-kube-readers" \
  "zitadel-app:app-kubernetes-kubelogin" \
  "zitadel-user:user-svc-kubernetes" \
  "zitadel-grant:grant-svc-kubernetes-kubernetes"; do
  model="${pair%%:*}"; name="${pair##*:}"
  action=$(swamp data get "$model" "$name" --json 2>/dev/null | jq -r '.content.action')
  [ "$action" = "unchanged" ] && ok "second run changed nothing: $name" ||
    bad "second run changed nothing: $name" "action was '$action'"
done
summary
