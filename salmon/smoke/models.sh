#!/usr/bin/env bash
# The models the suite runs, in the swamp repository $REPO, pointing at the
# cluster cluster.sh made.
set -euo pipefail
cd "$(dirname "$0")"
: "${REPO:?set REPO to a swamp repository that loads this extension from source}"
: "${SMOKE_KUBECONFIG:?set SMOKE_KUBECONFIG to the kubeconfig file of the smoke cluster}"
CLUSTER=${CLUSTER:-salmon-smoke}
CONTEXT=${SMOKE_CONTEXT:-kind-$CLUSTER}
WORK=${SMOKE_WORK:-$PWD/.work}
PORT=${SMOKE_PORT:-18090}
STANDIN=http://127.0.0.1:$((PORT + 1))
SA=salmon-token-exchange-test

case $CONTEXT in
  kind-*) ;;
  *) echo "refused: the context $CONTEXT is not a kind cluster" >&2; exit 2 ;;
esac

m() { # type name args...
  local type=$1 name=$2; shift 2
  (cd "$REPO" && swamp model create "@dataverket/salmon/$type" "$name" "$@" --json >/dev/null)
}

# The real Salmon, seeded with one app, the cluster as trusted issuer and one grant.
IMAGE=()
if [ -n "${SALMON_IMAGE:-}" ]; then IMAGE=(--global-arg "image=$SALMON_IMAGE"); fi
m stack stack "${IMAGE[@]}" \
  --global-arg project=salmon-smoke \
  --global-arg port="$PORT" \
  --global-arg issuerUrl="http://localhost:$PORT/issuer/" \
  --global-arg 'networks=["kind"]' \
  --global-arg name=orders \
  --global-arg 'apps=[{"key":"db","name":"orders database"}]' \
  --global-arg "trust={\"issuer\":\"https://$CLUSTER-control-plane:6443\",\"subject\":\"system:serviceaccount:default:$SA\",\"insecure\":true}" \
  --global-arg 'grants=[{"app":"db"}]' \
  --global-arg upTimeoutSeconds=150 \
  --global-arg startTimeoutSeconds=60
# An image no registry is asked for and no cache holds.
m stack stack-noimage \
  --global-arg project=salmon-smoke-noimage \
  --global-arg port=$((PORT + 2)) \
  --global-arg image=localhost/no-such-salmon:none \
  --global-arg pullPolicy=never \
  --global-arg upTimeoutSeconds=60
# A project that was never started.
m stack stack-idle --global-arg project=salmon-smoke-idle --global-arg port=$((PORT + 3))

CLUSTERARGS=(--global-arg kubeconfig="$SMOKE_KUBECONFIG" --global-arg kubeContext="$CONTEXT")
# The check against the real Salmon, wired to the stack's record.
m token-exchange tx "${CLUSTERARGS[@]}" \
  --global-arg 'issuerUrl=${{ data.latest("stack", "stack").attributes.localIssuerUrl }}' \
  --global-arg 'audience=${{ data.latest("stack", "stack").attributes.issuerUrl }}' \
  --global-arg 'trustId=${{ data.latest("stack", "stack").attributes.trustId }}' \
  --global-arg 'requestAudience=${{ data.latest("stack", "stack").attributes.apps.db }}'

# The checks against the stand-in (standin.py), one per answer it can give.
T=(--global-arg trustId=smoke-trust)
for mode in ok echo html other opaque page ftp; do
  m token-exchange "tx-$mode" "${CLUSTERARGS[@]}" "${T[@]}" --global-arg issuerUrl="$STANDIN/$mode/issuer"
done
OK=(--global-arg issuerUrl="$STANDIN/ok/issuer")
m token-exchange tx-newsa "${CLUSTERARGS[@]}" "${T[@]}" "${OK[@]}" --global-arg serviceAccount=smoke-made-on-demand
m token-exchange tx-nons "${CLUSTERARGS[@]}" "${T[@]}" "${OK[@]}" --global-arg namespace=nonesuch
m token-exchange tx-duration "${CLUSTERARGS[@]}" "${T[@]}" "${OK[@]}" --global-arg tokenDuration=forever
m token-exchange tx-dead "${T[@]}" "${OK[@]}" --global-arg kubeconfig="$WORK/dead.kubeconfig" --global-arg kubeContext="$CONTEXT"
m token-exchange tx-nofile "${T[@]}" "${OK[@]}" --global-arg kubeconfig="$WORK/missing.kubeconfig" --global-arg kubeContext="$CONTEXT"
m token-exchange tx-nocontext "${T[@]}" "${OK[@]}" --global-arg kubeconfig="$SMOKE_KUBECONFIG" --global-arg kubeContext=kind-no-such-context
m token-exchange tx-nobin "${CLUSTERARGS[@]}" "${T[@]}" "${OK[@]}" --global-arg kubectlBinary="$WORK/no-such-kubectl"
m token-exchange tx-nosalmon "${CLUSTERARGS[@]}" "${T[@]}" --global-arg issuerUrl="http://127.0.0.1:$((PORT + 4))/issuer"
echo "models created in $REPO"
