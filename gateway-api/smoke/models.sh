#!/usr/bin/env bash
# The models the live suite runs, in the swamp repository $REPO, all pointing
# at the kind cluster of $SMOKE_KUBECONFIG. The kubeconfigs that must fail are
# written to .work, mode 0600. Needs the cluster and nothing installed on it.
set -euo pipefail
cd "$(dirname "$0")"
source ./harness.sh
WORK=$PWD/.work
mkdir -p "$WORK"

m() { # type name args...
  local type=$1 name=$2; shift 2
  (cd "$REPO" && swamp model create "@dataverket/gateway-api/$type" "$name" \
    --global-arg context="$SMOKE_CONTEXT" "$@" --json >/dev/null)
}

# A kubeconfig for the same cluster with a bearer token instead of the admin
# certificate. The token goes from kubectl into the file and nowhere else.
token_kubeconfig() { # file token-command...
  local file=$1; shift
  local server ca
  server=$(k config view --minify -o jsonpath='{.clusters[0].cluster.server}')
  ca=$(k config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}')
  (umask 077; cat > "$file" <<YAML
apiVersion: v1
kind: Config
current-context: $SMOKE_CONTEXT
clusters:
  - name: c
    cluster: { server: "$server", certificate-authority-data: "$ca" }
contexts:
  - name: $SMOKE_CONTEXT
    context: { cluster: c, user: u }
users:
  - name: u
    user: { token: "$("$@")" }
YAML
  )
}

for type in gateway httproute gatewayclass; do
  m "$type" "gw-$type" --global-arg kubeconfig="$SMOKE_KUBECONFIG"
done
m gateway gw-gateway-ns --global-arg kubeconfig="$SMOKE_KUBECONFIG" --global-arg namespace=gw-smoke
m httproute gw-httproute-ns --global-arg kubeconfig="$SMOKE_KUBECONFIG" --global-arg namespace=apps

# What a reader needs, and an identity with nothing.
k apply -f - >/dev/null <<'YAML'
apiVersion: v1
kind: ServiceAccount
metadata: { name: gateway-api-reader, namespace: default }
---
apiVersion: v1
kind: ServiceAccount
metadata: { name: gateway-api-nothing, namespace: default }
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRole
metadata: { name: gateway-api-reader }
rules:
  - apiGroups: [gateway.networking.k8s.io]
    resources: [gateways, httproutes, gatewayclasses]
    verbs: [get, list]
---
apiVersion: rbac.authorization.k8s.io/v1
kind: ClusterRoleBinding
metadata: { name: gateway-api-reader }
roleRef: { apiGroup: rbac.authorization.k8s.io, kind: ClusterRole, name: gateway-api-reader }
subjects:
  - { kind: ServiceAccount, name: gateway-api-reader, namespace: default }
YAML
token_kubeconfig "$WORK/reader.kubeconfig" k -n default create token gateway-api-reader --duration 1h
token_kubeconfig "$WORK/nothing.kubeconfig" k -n default create token gateway-api-nothing --duration 1h
token_kubeconfig "$WORK/bad-token.kubeconfig" echo not-a-token
(umask 077; sed 's#server: .*#server: https://127.0.0.1:1#' "$SMOKE_KUBECONFIG" > "$WORK/closed.kubeconfig")
# An address of the documentation range (RFC 5737): nothing answers there.
(umask 077; sed 's#server: .*#server: https://192.0.2.1:6443#' "$SMOKE_KUBECONFIG" > "$WORK/silent.kubeconfig")

for type in gateway httproute gatewayclass; do
  m "$type" "gw-$type-reader" --global-arg kubeconfig="$WORK/reader.kubeconfig"
  m "$type" "gw-$type-nothing" --global-arg kubeconfig="$WORK/nothing.kubeconfig"
done
m gateway gw-bad-token --global-arg kubeconfig="$WORK/bad-token.kubeconfig"
m gateway gw-closed --global-arg kubeconfig="$WORK/closed.kubeconfig"
m gateway gw-silent --global-arg kubeconfig="$WORK/silent.kubeconfig"
m gateway gw-no-file --global-arg kubeconfig="$WORK/no-such.kubeconfig"
(cd "$REPO" && swamp model create @dataverket/gateway-api/gateway gw-no-context \
  --global-arg kubeconfig="$SMOKE_KUBECONFIG" --global-arg context=kind-no-such-cluster --json >/dev/null)
echo "models created in $REPO"
