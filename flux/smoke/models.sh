#!/usr/bin/env bash
# The models the suite runs, in the swamp repository $REPO, pointing at the
# cluster cluster.sh made.
set -euo pipefail
cd "$(dirname "$0")"
: "${REPO:?set REPO to a swamp repository that loads this extension from source}"
: "${SMOKE_KUBECONFIG:?set SMOKE_KUBECONFIG to the kubeconfig file of the smoke cluster}"
CONTEXT=kind-${CLUSTER:-flux-smoke}
WORK=${SMOKE_WORK:-$PWD/.work}
ADMIN=(--global-arg kubeconfig="$SMOKE_KUBECONFIG" --global-arg context="$CONTEXT")

m() { # type name args...
  local type=$1 name=$2; shift 2
  (cd "$REPO" && swamp model create "@dataverket/flux/$type" "$name" "$@" --json >/dev/null)
}
m helmrelease hr "${ADMIN[@]}"
m helmrelease hr-apps "${ADMIN[@]}" --global-arg namespace=apps
m helmrelease hr-flag "${ADMIN[@]}" --global-arg namespace=-A
m helmrelease hr-reader --global-arg kubeconfig="$WORK/reader.kubeconfig" --global-arg context=reader
m helmrelease hr-dead --global-arg kubeconfig="$WORK/dead.kubeconfig" --global-arg context="$CONTEXT"
m helmrelease hr-nofile --global-arg kubeconfig="$WORK/missing.kubeconfig" --global-arg context="$CONTEXT"
m helmrelease hr-slow --global-arg kubeconfig="$WORK/slow.kubeconfig" --global-arg context="$CONTEXT"
m helmrelease hr-nocontext --global-arg kubeconfig="$SMOKE_KUBECONFIG" --global-arg context=no-such-context
m kustomization ks "${ADMIN[@]}" --global-arg namespace=apps
m kustomization ks-flag "${ADMIN[@]}" --global-arg namespace=--all-namespaces
m source src "${ADMIN[@]}"
m source src-flag "${ADMIN[@]}" --global-arg namespace=-A
echo "models created in $REPO"
