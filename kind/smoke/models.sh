#!/usr/bin/env bash
# The models the suite runs, in the swamp repository $REPO. CLUSTER is the
# cluster the suite creates and deletes, CLUSTER2 a name that is never created.
set -euo pipefail
cd "$(dirname "$0")"
: "${REPO:?set REPO to a swamp repository that loads this extension from source}"
: "${SMOKE_KUBECONFIG:?set SMOKE_KUBECONFIG to the kubeconfig file the smoke cluster is written to}"
CLUSTER=${CLUSTER:-kind-smoke}
CLUSTER2=${CLUSTER2:-kind-smoke-absent}
HERE=$PWD
KC=(--global-arg kubeconfig="$SMOKE_KUBECONFIG")
CFG=(--global-arg configPath="$HERE/kind.yaml")
ONE=(--global-arg clusterName="$CLUSTER" "${CFG[@]}" "${KC[@]}")
TWO=(--global-arg clusterName="$CLUSTER2" "${CFG[@]}" "${KC[@]}")

m() { # name args...
  local name=$1; shift
  (cd "$REPO" && swamp model create @dataverket/kind/cluster "$name" "$@" --json >/dev/null)
}

# The cluster of the suite, with two manifests and a short wait.
m c "${ONE[@]}" --global-arg waitTimeout=90s \
  --global-arg "manifests=[\"$HERE/manifests/namespace.yaml\",\"$HERE/manifests/configmap.yaml\",\"$HERE/manifests/with space.yaml\"]"
# The same cluster seen through definitions that are wrong in one way each.
m c-badmanifest "${ONE[@]}" \
  --global-arg "manifests=[\"$HERE/manifests/namespace.yaml\",\"$HERE/manifests/missing.yaml\"]"
m c-nokubectl "${ONE[@]}" --global-arg kubectlBinary=no-such-kubectl
m c-otherfile --global-arg clusterName="$CLUSTER" "${CFG[@]}" \
  --global-arg kubeconfig="${SMOKE_KUBECONFIG%/*}/other.kubeconfig"

# A cluster that is never created.
m absent "${TWO[@]}"
# Its own model: after a delete swamp refuses a get until an ensure has run.
m absent-delete "${TWO[@]}"
m absent-noconfig --global-arg clusterName="$CLUSTER2" "${KC[@]}" \
  --global-arg configPath="$HERE/no-such-kind.yaml"
m absent-nodir --global-arg clusterName="$CLUSTER2" "${CFG[@]}" \
  --global-arg kubeconfig="${SMOKE_KUBECONFIG%/*}/no-such-dir/kubeconfig"
m absent-nokind "${TWO[@]}" --global-arg kindBinary=no-such-kind
m absent-nokubectl "${TWO[@]}" --global-arg kubectlBinary=no-such-kubectl
m absent-longwait "${TWO[@]}" --global-arg waitTimeout=600h
m absent-badwait "${TWO[@]}" --global-arg waitTimeout="90s --retain"
m absent-flagconfig --global-arg clusterName="$CLUSTER2" "${KC[@]}" --global-arg configPath=--retain
m absent-flagkubeconfig --global-arg clusterName="$CLUSTER2" "${CFG[@]}" --global-arg kubeconfig=--retain

# Cluster names that are not names. names.txt holds one per line.
i=0
while IFS= read -r name; do
  i=$((i+1))
  m "name-$i" --global-arg clusterName="$name" "${CFG[@]}" "${KC[@]}"
done < names.txt
echo "models created in $REPO"
