#!/usr/bin/env bash
# What the live suite runs against, put on a throwaway cluster: the
# CloudNativePG operator, cert-manager and the Barman Cloud plugin, each from
# its pinned release manifest, a single-pod S3 gateway, five Clusters and two
# ServiceAccounts. Every key is made here, kept in .work with mode 0600, and
# put in a Secret; none is printed.
#   usage: SMOKE_KUBECONFIG=<file> setup.sh operator | fixtures | wait | readers | snapshots | nocrd
set -euo pipefail
: "${SMOKE_KUBECONFIG:?set SMOKE_KUBECONFIG to the kubeconfig of the throwaway cluster}"
HERE=$(cd "$(dirname "$0")" && pwd)
W=${WORK:-$HERE/.work}
mkdir -p "$W"

# Only a kind cluster is ever touched: any other current context is refused.
case $(kubectl --kubeconfig "$SMOKE_KUBECONFIG" config current-context 2>/dev/null) in
  kind-*) ;;
  *) echo "the current context of SMOKE_KUBECONFIG is not a kind-* cluster; refusing" >&2; exit 2 ;;
esac

k() { kubectl --kubeconfig "$SMOKE_KUBECONFIG" "$@"; }

CNPG=https://github.com/cloudnative-pg/cloudnative-pg/releases/download/v1.30.1/cnpg-1.30.1.yaml
CNPG_SUM=37237f145d8138256ea25ae830f87759255665ff08f8d552fdd8224a5ec032fb
CERT_MANAGER=https://github.com/cert-manager/cert-manager/releases/download/v1.21.3/cert-manager.yaml
CERT_MANAGER_SUM=c04a51295adda2b1a775146751f973e787190778c7f35180861d9678876e5c74
PLUGIN=https://github.com/cloudnative-pg/plugin-barman-cloud/releases/download/v0.15.1/manifest.yaml
SNAPSHOT_CRDS=https://raw.githubusercontent.com/kubernetes-csi/external-snapshotter/v8.2.0/client/config/crd
PLUGIN_SUM=8f377ff4a7d0d3f74fc64b0f7ac4f449fc38ca9e83a40107cca2f9315a9bd920

fetch() { # url sha256 file
  [ -f "$W/$3" ] || curl -fsSL -o "$W/$3" "$1"
  echo "$2  $W/$3" | sha256sum -c --quiet -
}

# Wait for a rollout in steps of 20 s, at most 160 s.
rollout() { # namespace deployment
  for _ in 1 2 3 4 5 6 7 8; do
    k -n "$1" rollout status "deployment/$2" --timeout=20s >/dev/null 2>&1 && return 0
  done
  echo "deployment $2 in $1 did not become ready" >&2; return 1
}

case ${1:-} in
operator)
  fetch "$CNPG" "$CNPG_SUM" cnpg.yaml
  fetch "$CERT_MANAGER" "$CERT_MANAGER_SUM" cert-manager.yaml
  fetch "$PLUGIN" "$PLUGIN_SUM" plugin-barman-cloud.yaml
  k apply --server-side -f "$W/cnpg.yaml" >/dev/null
  k apply --server-side -f "$W/cert-manager.yaml" >/dev/null
  rollout cnpg-system cnpg-controller-manager
  rollout cert-manager cert-manager-webhook
  k apply --server-side -f "$W/plugin-barman-cloud.yaml" >/dev/null
  rollout cnpg-system barman-cloud
  ;;
fixtures)
  key() { # file prefix
    [ -f "$W/$1" ] || (umask 077; printf 'ACCESS_KEY_ID=%s\nSECRET_ACCESS_KEY=%s\n' \
      "$2$(openssl rand -hex 6)" "$(openssl rand -hex 20)" > "$W/$1")
  }
  key s3.env smoke; key s3-wrong.env wrong
  k create namespace pg --dry-run=client -o yaml | k apply -f - >/dev/null
  k -n pg create secret generic s3-creds --from-env-file="$W/s3.env" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  k -n pg create secret generic s3-wrong --from-env-file="$W/s3-wrong.env" \
    --dry-run=client -o yaml | k apply -f - >/dev/null
  k apply -f "$HERE/manifests/s3.yaml" >/dev/null
  rollout pg s3
  k apply -f "$HERE/manifests/clusters.yaml" >/dev/null
  ;;
wait)
  # The five Clusters healthy, in steps of 10 s, at most 170 s; run again if not.
  for _ in $(seq 17); do
    n=$(k -n pg get clusters.postgresql.cnpg.io -o json |
      jq '[.items[] | select(.status.phase == "Cluster in healthy state")] | length')
    [ "$n" = 5 ] && { echo "5 Clusters healthy"; exit 0; }
    sleep 10
  done
  echo "only $n of 5 Clusters healthy; run wait again" >&2; exit 1
  ;;
readers)
  k apply -f "$HERE/manifests/readers.yaml" >/dev/null
  server=$(k config view --minify --raw -o jsonpath='{.clusters[0].cluster.server}')
  k config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' |
    base64 -d > "$W/ca.crt"
  for sa in reader blind; do
    f=$W/$sa.kubeconfig
    (umask 077; : > "$f")
    kubectl --kubeconfig "$f" config set-cluster smoke --server="$server" \
      --certificate-authority="$W/ca.crt" --embed-certs=true >/dev/null
    kubectl --kubeconfig "$f" config set-credentials "$sa" \
      --token="$(k -n pg create token "$sa" --duration=2h)" >/dev/null
    kubectl --kubeconfig "$f" config set-context "$sa" --cluster=smoke --user="$sa" >/dev/null
    kubectl --kubeconfig "$f" config use-context "$sa" >/dev/null
  done
  # A token the cluster does not know, and a port nothing listens on.
  f=$W/badtoken.kubeconfig
  (umask 077; : > "$f")
  kubectl --kubeconfig "$f" config set-cluster smoke --server="$server" \
    --certificate-authority="$W/ca.crt" --embed-certs=true >/dev/null
  kubectl --kubeconfig "$f" config set-credentials nobody \
    --token="$(openssl rand -hex 24)" >/dev/null
  kubectl --kubeconfig "$f" config set-context nobody --cluster=smoke --user=nobody >/dev/null
  kubectl --kubeconfig "$f" config use-context nobody >/dev/null
  f=$W/closed.kubeconfig
  (umask 077; : > "$f")
  kubectl --kubeconfig "$f" config set-cluster closed --server=https://127.0.0.1:1 >/dev/null
  # Without a user kubectl would ask for a name instead of connecting.
  kubectl --kubeconfig "$f" config set-credentials nobody \
    --token="$(openssl rand -hex 24)" >/dev/null
  kubectl --kubeconfig "$f" config set-context closed --cluster=closed --user=nobody >/dev/null
  kubectl --kubeconfig "$f" config use-context closed >/dev/null
  ;;
snapshots)
  # The VolumeSnapshot CRDs, and nothing that takes snapshots: enough for the
  # operator to accept a volumeSnapshot Backup. It looks for the CRDs when it
  # starts, so it is restarted.
  for f in volumesnapshots volumesnapshotclasses volumesnapshotcontents; do
    case $f in
      volumesnapshots) sum=b032116e987fb1d7d93cec7d942833adeb9d95c9bdc7e00c10b280c2fe4a6c33 ;;
      volumesnapshotclasses) sum=75e6565aac2c0f2949ed13ea884bbaa388cb7be576b558b709cf1168e011828d ;;
      volumesnapshotcontents) sum=895a3c1e73b60f06a0deb566dd123d01bdf1b2efc5d5ff5231ff8bbcf42dafc7 ;;
    esac
    fetch "$SNAPSHOT_CRDS/snapshot.storage.k8s.io_$f.yaml" "$sum" "snapshot-$f.yaml"
    k apply --server-side -f "$W/snapshot-$f.yaml" >/dev/null
  done
  k -n cnpg-system rollout restart deployment/cnpg-controller-manager >/dev/null
  rollout cnpg-system cnpg-controller-manager
  ;;
nocrd)
  # Takes the operator and its CRDs away again, and every Cluster with them.
  k delete --ignore-not-found --wait=false -f "$W/cnpg.yaml" >/dev/null
  ;;
*)
  echo "usage: SMOKE_KUBECONFIG=<file> $0 operator | fixtures | wait | readers | snapshots | nocrd" >&2
  exit 2
  ;;
esac
