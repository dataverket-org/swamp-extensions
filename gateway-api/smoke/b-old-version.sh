#!/usr/bin/env bash
source "$(dirname "$0")/harness.sh"
echo "=== B. only v1beta1 served: run between cluster.sh old-crds and no-crds ==="

holds "a v1beta1 Gateway is read and its version recorded" \
  "$(record old-api--old) | .apiVersion == \"gateway.networking.k8s.io/v1beta1\"" gw-gateway list
also "nobody manages it: programmed is null, not healthy, and the reason is the API server's" \
  "$(record old-api--old) | .summary | .programmed == null and .accepted == null and .healthy == false and (.unhealthy[0].reason == \"Pending\")"
also "its listener is named as not reported" \
  "$(record old-api--old) | .summary.unhealthy | map(select(.listener == \"http\" and .reason == \"NotReported\")) | length == 1"
also "the inventory names the version" \
  "$(record inventory_all) | .apiVersions == [\"gateway.networking.k8s.io/v1beta1\"]"
(cd "$REPO" && swamp model method run gw-gateway get --input name=old --input namespace=old-api) >"$OUT" 2>&1
if grep -q "served at gateway.networking.k8s.io/v1beta1" "$OUT"; then
  ok "the run warns that the version is not v1"
else
  bad "the run warns that the version is not v1" "no warning line in the log"
fi
holds "an empty list is an inventory of nothing, not an error" \
  "$(record inventory_all) | .count == 0 and .allHealthy" gw-httproute list
summary
