#!/usr/bin/env bash
source "$(dirname "$0")/harness.sh"
echo "=== A. a cluster without the Gateway API: run before cluster.sh crds ==="

if k get crd gateways.gateway.networking.k8s.io >/dev/null 2>&1; then
  echo "the Gateway API is installed on this cluster; this batch needs it absent" >&2
  exit 2
fi
for type in gateway httproute gatewayclass; do
  refuses "$type list names the missing API" "Gateway API CRDs are not installed" "gw-$type" list
done
refuses "gateway get names the missing API" "does not serve gateways.gateway.networking.k8s.io" \
  gw-gateway get name=any namespace=default
refuses "httproute get names the missing API" "does not serve httproutes.gateway.networking.k8s.io" \
  gw-httproute get name=any namespace=default
refuses "gatewayclass get names the missing API" "does not serve gatewayclasses.gateway.networking.k8s.io" \
  gw-gatewayclass get name=any
summary
