#!/usr/bin/env bash
# The throwaway cluster of the smoke run: a kind cluster with Flux's source,
# helm and kustomize controllers, a chart server inside it, three HelmReleases
# brought to the states `get` has to tell apart, and one Kustomization. Every
# command names the kubeconfig file and the context `kind-<CLUSTER>`, so the
# operator's own kubeconfig is never read or written and no other cluster can
# be reached.
#
#   SMOKE_KUBECONFIG=<file> ./cluster.sh up|seed|upgrade|reader|heal|down
#
# CLUSTER names the kind cluster (flux-smoke); SMOKE_WORK is where the packaged
# charts and the three extra kubeconfig files go (.work beside this script);
# SMOKE_SLOW_PORT is the local port of the server that never answers (16443).
#
# Each step polls and returns within three minutes; run them in that order.
set -euo pipefail
cd "$(dirname "$0")"
: "${SMOKE_KUBECONFIG:?set SMOKE_KUBECONFIG to the kubeconfig file the smoke cluster may write}"
CLUSTER=${CLUSTER:-flux-smoke}
CONTEXT=kind-$CLUSTER
WORK=${SMOKE_WORK:-$PWD/.work}
export KIND_EXPERIMENTAL_PROVIDER=${KIND_EXPERIMENTAL_PROVIDER:-podman}

k() { kubectl --kubeconfig "$SMOKE_KUBECONFIG" --context "$CONTEXT" "$@"; }
f() { flux --kubeconfig "$SMOKE_KUBECONFIG" --context "$CONTEXT" "$@"; }

# until <seconds> <description> <command...>: poll once a second.
until_ok() {
  local limit=$1 what=$2 i=0; shift 2
  until "$@" >/dev/null 2>&1; do
    i=$((i+1))
    if [ "$i" -ge "$limit" ]; then echo "gave up waiting for $what" >&2; return 1; fi
    sleep 1
  done
  echo "ok: $what"
}

# reason <release>: the reason of its Ready condition.
reason() {
  k -n apps get helmreleases.helm.toolkit.fluxcd.io "$1" \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].reason}'
}
has_reason() { [ "$(reason "$1")" = "$2" ]; }
ks_ready() {
  [ "$(k -n apps get kustomizations.kustomize.toolkit.fluxcd.io podinfo \
    -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')" = "True" ]
}
entries() {
  [ "$(k -n apps get helmreleases.helm.toolkit.fluxcd.io "$1" -o json | jq '.status.history | length')" = "$2" ]
}

case ${1:-} in
  up)
    kind create cluster --name "$CLUSTER" --kubeconfig "$SMOKE_KUBECONFIG" --wait 90s
    f install --components source-controller,helm-controller,kustomize-controller --timeout 150s
    ;;
  seed)
    mkdir -p "$WORK/repo"
    rm -f "$WORK"/repo/*
    helm package chart/hooked --version 0.1.0 -d "$WORK/repo" >/dev/null
    helm package chart/hooked --version 0.2.0 -d "$WORK/repo" >/dev/null
    helm repo index "$WORK/repo" --url http://charts.charts.svc.cluster.local
    k create namespace charts --dry-run=client -o yaml | k apply -f - >/dev/null
    k -n charts create configmap charts --from-file="$WORK/repo" --dry-run=client -o yaml | k apply -f - >/dev/null
    k apply -f releases.yaml >/dev/null
    until_ok 150 "podinfo installed" has_reason podinfo InstallSucceeded
    until_ok 60 "hooked installed and tested" has_reason hooked TestSucceeded
    until_ok 60 "noversion has no chart" has_reason noversion SourceNotReady
    until_ok 120 "the Kustomization is applied" ks_ready
    ;;
  upgrade)
    k -n apps patch ocirepositories.source.toolkit.fluxcd.io podinfo --type merge \
      -p '{"spec":{"ref":{"tag":"6.9.2"}}}' >/dev/null
    k -n apps patch helmreleases.helm.toolkit.fluxcd.io hooked --type merge \
      -p '{"spec":{"chart":{"spec":{"version":"0.2.0"}},"values":{"failUpgradeHook":true}}}' >/dev/null
    until_ok 150 "podinfo upgraded" has_reason podinfo UpgradeSucceeded
    until_ok 30 "podinfo has two history entries" entries podinfo 2
    until_ok 90 "hooked failed its upgrade" has_reason hooked UpgradeFailed
    ;;
  reader)
    # A second kubeconfig whose only user is the smoke-reader ServiceAccount.
    # The token goes from kubectl to the file through jq's environment: it is
    # never an argument and never printed.
    mkdir -p "$WORK"
    R=$WORK/reader.kubeconfig
    (
      umask 077
      k config view --raw --minify -o json |
        T=$(k -n apps create token smoke-reader --duration 1h) jq '
          .users = [{name: "smoke-reader", user: {token: env.T}}]
          | .contexts = [{name: "reader", context: {cluster: .clusters[0].name, user: "smoke-reader"}}]
          | .["current-context"] = "reader"' > "$R"
    )
    # One that points at a port nothing listens on, and one that points at
    # the port where neg-b.sh starts a server that accepts and never answers.
    D=$WORK/dead.kubeconfig
    (umask 077; cp "$SMOKE_KUBECONFIG" "$D")
    kubectl --kubeconfig "$D" config set-cluster "$CONTEXT" --server https://127.0.0.1:1 >/dev/null
    S=$WORK/slow.kubeconfig
    (umask 077; cp "$SMOKE_KUBECONFIG" "$S")
    kubectl --kubeconfig "$S" config set-cluster "$CONTEXT" \
      --server "https://127.0.0.1:${SMOKE_SLOW_PORT:-16443}" >/dev/null
    echo "ok: $R, $D and $S"
    ;;
  heal)
    # Batch d: the pre-upgrade hook of hooked stops failing, so the next
    # attempt can succeed. Nothing retries by itself: the release is stalled.
    k -n apps patch helmreleases.helm.toolkit.fluxcd.io hooked --type merge \
      -p '{"spec":{"values":{"failUpgradeHook":false}}}' >/dev/null
    echo "ok: hooked no longer fails its pre-upgrade hook"
    ;;
  down)
    kind delete cluster --name "$CLUSTER" --kubeconfig "$SMOKE_KUBECONFIG"
    rm -rf "$WORK"
    ;;
  *)
    echo "usage: SMOKE_KUBECONFIG=<file> $0 up|seed|upgrade|reader|heal|down" >&2
    exit 2
    ;;
esac
