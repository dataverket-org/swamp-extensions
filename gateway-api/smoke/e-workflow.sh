#!/usr/bin/env bash
source "$(dirname "$0")/harness.sh"
echo "=== E. a workflow asserts on the records: run after cluster.sh settle ==="

# The README's assertions, as a workflow of the scratch repository.
wf() { # name gateway-data-name route-data-name
  (cd "$REPO" && swamp workflow create "$1" --json >/dev/null 2>&1)
  local file; file=$(grep -l "^name: $1\$" "$REPO"/workflows/*.yaml)
  local id; id=$(sed -n 's/^id: //p' "$file")
  cat > "$file" <<YAML
id: $id
name: $1
description: Reads the Gateways and HTTPRoutes and asserts on two records and one inventory.
version: 1
jobs:
  - name: check
    steps:
      - name: gateways
        task: { type: model_method, modelIdOrName: gw-gateway, methodName: list }
      - name: routes
        task: { type: model_method, modelIdOrName: gw-httproute, methodName: list }
      - name: gateway-programmed
        dependsOn: [{ step: gateways, condition: { type: succeeded } }]
        task:
          type: assert
          expr: >-
            data.latest("gw-gateway", "$2").attributes.summary.programmed == true
            && data.latest("gw-gateway", "$2").attributes.summary.allListenersProgrammed
            && size(data.latest("gw-gateway", "$2").attributes.summary.unhealthy) == 0
          message: >-
            Gateway $2 is not healthy: \${{ data.latest("gw-gateway", "inventory_all").attributes.unhealthy }}
      - name: route-attached
        dependsOn: [{ step: routes, condition: { type: succeeded } }]
        task:
          type: assert
          expr: >-
            data.latest("gw-httproute", "$3").attributes.summary.allParentsAccepted
            && data.latest("gw-httproute", "$3").attributes.summary.allRefsResolved
          message: >-
            HTTPRoute $3 is not attached: \${{ data.latest("gw-httproute", "$3").attributes.summary.unhealthy }}
YAML
}

wfrun() { (cd "$REPO" && swamp workflow run "$1" --json) >"$OUT" 2>"$ERR"; }

wf smoke-healthy gw-smoke--healthy apps--ok
if wfrun smoke-healthy; then ok "the healthy Gateway and its route pass the assertions"; else
  bad "the healthy Gateway and its route pass the assertions" "$(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 400)"
fi
wf smoke-bad-cert gw-smoke--bad-cert apps--ok
if wfrun smoke-bad-cert; then bad "a listener that is not programmed fails the workflow" "the run succeeded"
elif cat "$OUT" "$ERR" | grep -q "InvalidCertificateRef"; then ok "a listener that is not programmed fails the workflow, and the message names the reason"
else bad "a listener that is not programmed fails the workflow" "$(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 400)"; fi
wf smoke-bad-route gw-smoke--healthy apps--missing-backend
if wfrun smoke-bad-route; then bad "a route whose backend is missing fails the workflow" "the run succeeded"
elif cat "$OUT" "$ERR" | grep -q "BackendNotFound"; then ok "a route whose backend is missing fails the workflow, and the message names the reason"
else bad "a route whose backend is missing fails the workflow" "$(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 400)"; fi
summary
