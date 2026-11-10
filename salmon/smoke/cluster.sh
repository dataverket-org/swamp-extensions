#!/usr/bin/env bash
# The throwaway cluster of the smoke run: a kind cluster whose ServiceAccount
# issuer is named after its control-plane container, so a Salmon container on
# the `kind` network can fetch the cluster's signing keys. Every command names
# the kubeconfig file and the context, so your own kubeconfig is never read
# or written.
#
#   SMOKE_KUBECONFIG=<file> ./cluster.sh up|dead|down
#
# CLUSTER names the kind cluster (salmon-smoke); SMOKE_WORK is where the extra
# kubeconfig file goes (.work beside this script).
set -euo pipefail
cd "$(dirname "$0")"
: "${SMOKE_KUBECONFIG:?set SMOKE_KUBECONFIG to the kubeconfig file the smoke cluster may write}"
CLUSTER=${CLUSTER:-salmon-smoke}
CONTEXT=${SMOKE_CONTEXT:-kind-$CLUSTER}
WORK=${SMOKE_WORK:-$PWD/.work}
export KIND_EXPERIMENTAL_PROVIDER=${KIND_EXPERIMENTAL_PROVIDER:-podman}

case $CONTEXT in
  kind-*) ;;
  *) echo "refused: the context $CONTEXT is not a kind cluster" >&2; exit 2 ;;
esac

k() { kubectl --kubeconfig "$SMOKE_KUBECONFIG" --context "$CONTEXT" "$@"; }

case ${1:-} in
  up)
    kind create cluster --name "$CLUSTER" --kubeconfig "$SMOKE_KUBECONFIG" --wait 90s --config - <<YAML
kind: Cluster
apiVersion: kind.x-k8s.io/v1alpha4
kubeadmConfigPatches:
  - |
    kind: ClusterConfiguration
    apiServer:
      extraArgs:
        service-account-issuer: https://$CLUSTER-control-plane:6443
        service-account-jwks-uri: https://$CLUSTER-control-plane:6443/openid/v1/jwks
YAML
    # Salmon reads the keys without credentials.
    k create clusterrolebinding oidc-anon \
      --clusterrole=system:service-account-issuer-discovery \
      --group=system:unauthenticated
    ;;
  dead)
    # A kubeconfig that points at a port nothing listens on.
    mkdir -p "$WORK"
    D=$WORK/dead.kubeconfig
    (umask 077; cp "$SMOKE_KUBECONFIG" "$D")
    kubectl --kubeconfig "$D" config set-cluster "$CONTEXT" --server https://127.0.0.1:1 >/dev/null
    echo "ok: $D"
    ;;
  down)
    kind delete cluster --name "$CLUSTER" --kubeconfig "$SMOKE_KUBECONFIG"
    rm -rf "$WORK"
    ;;
  *)
    echo "usage: SMOKE_KUBECONFIG=<file> $0 up|dead|down" >&2
    exit 2
    ;;
esac
