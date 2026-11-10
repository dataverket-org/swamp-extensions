#!/usr/bin/env bash
source "$(dirname "$0")/harness.sh"
echo "=== F. a cancelled run stops its kubectl: run any time after models.sh ==="

# gw-silent points at an address where nothing answers, so its kubectl waits
# for the request timeout. The run is interrupted long before that.
kubectl_runs() { pgrep -f '^[^ ]*kubectl --kubeconfig [^ ]*silent\.kubeconfig ' >/dev/null; }

(cd "$REPO" && exec swamp model method run gw-silent list --json) >"$OUT" 2>"$ERR" &
pid=$!
for _ in $(seq 50); do kubectl_runs && break; sleep 0.2; done
if kubectl_runs; then ok "the run started a kubectl that waits"; else
  bad "the run started a kubectl that waits" "no kubectl process seen within 10 s"; fi
kill -INT "$pid"
gone=""
for i in $(seq 25); do
  if ! kubectl_runs; then gone=$i; break; fi
  sleep 0.2
done
wait "$pid"
if [ -n "$gone" ]; then ok "kubectl was stopped within $(( gone * 200 )) ms of the interrupt"; else
  bad "kubectl was stopped after the interrupt" "it still ran 5 s later"; fi
if [ "$(jq -r '.status' "$OUT" 2>/dev/null)" = "cancelled" ]; then ok "the run ends as cancelled"; else
  bad "the run ends as cancelled" "$(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"; fi
left=$(cd "$REPO" && swamp data query 'dataType == "resource" && modelName == "gw-silent"' --json 2>/dev/null | jq '.results | length')
if [ "$left" = "0" ]; then ok "a cancelled run leaves no record"; else bad "a cancelled run leaves no record" "$left records"; fi
summary
