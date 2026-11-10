#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== C. a reader with little access, and names the other methods refuse ==="

holds "a reader who may not list Jobs still gets the history; the Jobs are recorded as unread" \
  '(.jobsRead | not) and .jobs == [] and (.jobsNote | test("jobs.batch is forbidden")) and (.history | length) == 2 and .lastAction == "upgrade"' \
  hr-reader get name=hooked namespace=apps
refuses "a reader who may not get the HelmRelease is refused" 'Forbidden' hr-reader get name=podinfo namespace=closed
refuses "a reader who may not list in every namespace is refused, though kubectl printed an empty list" 'is forbidden' hr-reader list

for method in suspend reconcile resume reset; do
  refuses "helmrelease $method refuses --all" 'name "--all" is not a Kubernetes object name' hr-apps "$method" name=--all
done
for method in suspend reconcile resume; do
  refuses "kustomization $method refuses --all" 'name "--all" is not a Kubernetes object name' ks "$method" name=--all
done
run ks list
also "... and no Kustomization was suspended by any of them" \
  '.dataArtifacts | length == 1 and all(.attributes.suspended | not)'
run hr list
also "... and no release was suspended by any of them" \
  '.dataArtifacts | length == 3 and all(.attributes.suspended | not)'

if [ -z "$TOKEN" ]; then
  bad "the reader's token could be read back for the check" "no token in the reader kubeconfig"
elif found "$REPO/.swamp"; then
  bad "the reader's token is nowhere in the repository's data" "found under .swamp"
else
  ok "the reader's token is nowhere in the repository's data"
fi
summary
