#!/usr/bin/env bash
source "$(dirname "$0")/harness.sh"
echo "=== D. what is refused: run after cluster.sh settle ==="

# Arguments
refuses "get without a name" "name" gw-gateway get namespace=gw-smoke
refuses "get with an empty name" "name" gw-gateway get name= namespace=gw-smoke
refuses "get without a namespace anywhere" "namespace is required for get" gw-gateway get name=healthy
refuses "route get without a namespace anywhere" "namespace is required for get" gw-httproute get name=ok
refuses "get with an empty namespace and none in the definition" "namespace is required for get" \
  gw-gateway get name=healthy namespace=
for bad in '-A' '--all-namespaces' '-o=yaml' '--kubeconfig=/dev/null' 'healthy -n kube-system' \
  'healthy;id' '$(id)' '`id`' 'healthy|id' '../healthy' 'secrets/wildcard' 'Healthy' 'healthy,conflict' '*'; do
  refuses "gateway name $bad" "not a Kubernetes object name" gw-gateway get "name=$bad" namespace=gw-smoke
  refuses "route name $bad" "not a Kubernetes object name" gw-httproute get "name=$bad" namespace=apps
  refuses "class name $bad" "not a Kubernetes object name" gw-gatewayclass get "name=$bad"
  refuses "get namespace $bad" "not a Kubernetes namespace name" gw-gateway get name=healthy "namespace=$bad"
  refuses "list namespace $bad" "not a Kubernetes namespace name" gw-httproute list "namespace=$bad"
done

# Objects that are not there
refuses "a Gateway that does not exist" "gateways.gateway.networking.k8s.io \"?no-such\"? not found" gw-gateway get name=no-such namespace=gw-smoke
refuses "a Gateway asked for in another namespace" "not found" gw-gateway get name=healthy namespace=apps
refuses "an HTTPRoute that does not exist" "not found" gw-httproute get name=no-such namespace=apps
refuses "a class that does not exist" "not found" gw-gatewayclass get name=no-such
refuses "a namespace that does not exist, on get" "not found" gw-gateway get name=healthy namespace=no-such-namespace
holds "a namespace that does not exist, on list: an inventory of nothing" \
  "$(record inventory_ns_no-such-namespace) | .count == 0" gw-gateway list namespace=no-such-namespace

# Access
for type in gateway httproute gatewayclass; do
  refuses "$type list without rights is named as RBAC" "refused by RBAC" "gw-$type-nothing" list
done
refuses "get without rights is named as RBAC" "refused by RBAC" gw-gateway-nothing get name=healthy namespace=gw-smoke
refuses "a token the cluster does not accept" "did not accept the credentials" gw-bad-token list
refuses "a context the kubeconfig does not have" "kind-no-such-cluster" gw-no-context list
refuses "a kubeconfig file that is not there" "no such file" gw-no-file list
# Nothing answers at this address. kubectl does not give up on its own at the
# request timeout here, so this is the process limit a little after it.
started=$(date +%s)
refuses "a cluster that never answers is a timeout: kubectl is stopped at the process limit" \
  "no answer within 35 seconds; kubectl was stopped" gw-silent list
took=$(( $(date +%s) - started ))
if [ "$took" -ge 33 ] && [ "$took" -le 45 ]; then ok "it took the 35 s of the limit and no longer ($took s)"; else
  bad "it took the 35 s of the limit and no longer" "$took s"; fi
if pgrep -f '^[^ ]*kubectl --kubeconfig [^ ]*silent\.kubeconfig ' >/dev/null; then
  bad "no kubectl is left running after the limit" "one still runs"
else
  ok "no kubectl is left running after the limit"
fi
refuses "a cluster that does not answer is named unreachable, in one sentence" \
  "could not be reached \(The connection to the server 127.0.0.1:1 was refused" gw-closed list
if grep -q "memcache.go" "$OUT" "$ERR"; then
  bad "kubectl's client log lines stay out of the error" "found memcache.go"
else
  ok "kubectl's client log lines stay out of the error"
fi

# Nothing refused may have left a record behind.
left=$(cd "$REPO" && swamp data query 'dataType == "resource" && modelName in ["gw-gateway-nothing", "gw-bad-token", "gw-no-context", "gw-no-file", "gw-closed", "gw-silent"]' --json 2>/dev/null | jq '.results | length')
if [ "$left" = "0" ]; then ok "the refused models hold no data"; else bad "the refused models hold no data" "$left records"; fi
no_secrets_stored
summary
