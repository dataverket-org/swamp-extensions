#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== B. what get refuses ==="

refuses "a release that does not exist is named" '"nope" not found' hr get name=nope namespace=apps
refuses "a namespace that does not exist is named" 'namespaces "nonesuch" not found' hr get name=podinfo namespace=nonesuch
refuses "no namespace at all" 'namespace is required for get' hr get name=podinfo
refuses "a namespace on the model that is a flag" 'is not a Kubernetes namespace name' hr-flag get name=podinfo

for name in '--all' '-A' '-o=yaml' '--kubeconfig=/dev/null' 'podinfo -A' 'podinfo;id' '$(id)' \
  'podinfo,helm.toolkit.fluxcd.io/name=hooked' '../podinfo' 'Podinfo' 'podinfo.' ; do
  refuses "a name that is not a name: $name" 'not a Kubernetes object name' hr get "name=$name" namespace=apps
done
for ns in '--all-namespaces' '-A' 'apps -A' 'apps;id' 'apps.x' 'Apps'; do
  refuses "a namespace that is not one: $ns" 'is not a Kubernetes namespace name' hr get name=podinfo "namespace=$ns"
done

refuses "a closed port is named as a cluster that could not be reached" 'kubectl get .* failed: the cluster could not be reached' hr-dead get name=podinfo namespace=apps
refuses "a kubeconfig file that is not there" 'kubectl get .* failed' hr-nofile get name=podinfo namespace=apps
refuses "a context the kubeconfig does not hold" 'no-such-context' hr-nocontext get name=podinfo namespace=apps

echo "--- what list refuses: it used to pass its namespace to kubectl unchecked ---"
refuses "helmrelease list: a namespace on the model that is a flag" 'is not a Kubernetes namespace name' hr-flag list
refuses "kustomization list: a namespace on the model that is a flag" 'is not a Kubernetes namespace name' ks-flag list
refuses "source list: a namespace on the model that is a flag" 'is not a Kubernetes namespace name' src-flag list
for ns in '--all-namespaces' '-A' 'apps -A' 'apps;id' 'Apps'; do
  refuses "helmrelease list: a namespace argument that is not one: $ns" 'is not a Kubernetes namespace name' hr list "namespace=$ns"
done
refuses "list against a closed port" 'kubectl get .* -A failed: the cluster could not be reached' hr-dead list
refuses "list with a context the kubeconfig does not hold" 'no-such-context' hr-nocontext list

echo "--- a server that accepts the connection and never answers ---"
# kubectl itself gives up (TLS handshake or request timeout); the process
# limit of 35 seconds is behind that. Either way the run ends and says so.
if command -v python3 >/dev/null; then
  python3 -c '
import socket, sys, time
s = socket.socket(); s.setsockopt(socket.SOL_SOCKET, socket.SO_REUSEADDR, 1)
s.bind(("127.0.0.1", int(sys.argv[1]))); s.listen(16)
held = []
while True:
    held.append(s.accept()[0])
' "${SMOKE_SLOW_PORT:-16443}" &
  SLOW=$!
  trap 'kill $SLOW 2>/dev/null' EXIT
  sleep 1
  START=$SECONDS
  refuses "get against it ends with a timeout that is named" 'no answer (in time|within 35 seconds)' hr-slow get name=podinfo namespace=apps
  refuses "list against it ends the same way" 'no answer (in time|within 35 seconds)' hr-slow list
  TOOK=$((SECONDS-START))
  if [ "$TOOK" -le 90 ]; then ok "both ended within 90 seconds ($TOOK s)"; else bad "both ended within 90 seconds" "$TOOK s"; fi
  kill $SLOW 2>/dev/null
else
  echo "SKIP  no python3 for the server that never answers"
fi
summary
