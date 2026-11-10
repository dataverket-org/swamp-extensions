#!/usr/bin/env bash
# Installs what the suite reads on a throwaway cluster: cert-manager, Pebble
# (the Let's Encrypt test ACME server) with its challenge test server, the
# issuers and Certificates, and four ServiceAccount kubeconfigs that may do
# less than an administrator.
#
#   setup.sh <kubeconfig>
#
# Run neg-a.sh first: it needs a cluster that has no cert-manager yet.
set -euo pipefail

KUBECONFIG_FILE=${1:?usage: setup.sh <kubeconfig of a throwaway cluster>}
HERE=$(cd "$(dirname "$0")" && pwd)
WORK=${WORK:-$HERE/.work}
CERT_MANAGER_VERSION=${CERT_MANAGER_VERSION:-v1.20.5}
PEBBLE_VERSION=${PEBBLE_VERSION:-v2.10.1}

k() { kubectl --kubeconfig "$KUBECONFIG_FILE" "$@"; }

# The suite installs and changes things: only a kind cluster is accepted.
kind_only() { # kubeconfig
  local current
  current=$(kubectl --kubeconfig "$1" config current-context 2>/dev/null) || current=
  case $current in
    kind-*) ;;
    *) echo "refusing: the current context of $1 is '${current:-none}', not a kind-* context" >&2; exit 2 ;;
  esac
}
kind_only "$KUBECONFIG_FILE"

# Poll, never one long wait: 60 tries, 3 s apart.
until_ok() { # description command...
  local what=$1 i; shift
  for i in $(seq 60); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 3
  done
  echo "gave up waiting for $what" >&2
  return 1
}

mkdir -p "$WORK"

echo "cert-manager $CERT_MANAGER_VERSION"
k apply -f "https://github.com/cert-manager/cert-manager/releases/download/$CERT_MANAGER_VERSION/cert-manager.yaml" >/dev/null

# cert-manager checks a challenge itself before it tells the ACME server.
# Both checks are pointed at the challenge test server, which answers every
# name with the address of the http01-solvers Service.
if ! k -n cert-manager get deployment cert-manager -o jsonpath='{.spec.template.spec.containers[0].args}' \
  | grep -q dns01-recursive-nameservers-only; then
  k -n cert-manager patch deployment cert-manager --type=json -p '[
    {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--acme-http01-solver-nameservers=10.96.100.53:8053"},
    {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--dns01-recursive-nameservers=10.96.100.53:8053"},
    {"op":"add","path":"/spec/template/spec/containers/0/args/-","value":"--dns01-recursive-nameservers-only"}
  ]' >/dev/null
fi

echo "Pebble $PEBBLE_VERSION"
k apply -f "$HERE/manifests/pebble.yaml" >/dev/null
for d in cert-manager cert-manager-webhook cert-manager-cainjector pebble challtestsrv; do
  until_ok "deployment $d" k -n cert-manager rollout status "deployment/$d" --timeout=2s
done
until_ok "deployment wrong-answer" k -n acme-test rollout status deployment/wrong-answer --timeout=2s

# One name gets the address of the server that answers with something else.
# The record is set through the challenge test server's management port,
# reached through the API server; nothing is exposed on the host. The test
# DNS server answers every name, so cert-manager's resolver is answered on
# the first name of its search list: the record is set for those too.
for suffix in "" .cert-manager.svc.cluster.local .svc.cluster.local .cluster.local; do
  printf '{"host":"wrong.example.test%s.","addresses":["10.96.100.81"]}' "$suffix" > "$WORK/wrong-a.json"
  until_ok "the A record of wrong.example.test$suffix" k create --raw \
    /api/v1/namespaces/cert-manager/services/http:challtestsrv:mgmt/proxy/add-a -f "$WORK/wrong-a.json"
done

# Pebble's own test CA signs its ACME endpoint; the issuers trust exactly it.
curl -fsS -m 30 -o "$WORK/pebble.minica.pem" \
  "https://raw.githubusercontent.com/letsencrypt/pebble/$PEBBLE_VERSION/test/certs/pebble.minica.pem"
sed "s|PEBBLE_CA_BUNDLE|$(base64 -w0 < "$WORK/pebble.minica.pem")|" \
  "$HERE/manifests/issuers.yaml" > "$WORK/issuers.yaml"

echo "issuers and certificates"
until_ok "the cert-manager webhook" k apply -f "$WORK/issuers.yaml"
k apply -f "$HERE/manifests/certificates.yaml" -f "$HERE/manifests/rbac.yaml" >/dev/null

ready() { [ "$(k -n "$1" get certificate "$2" -o jsonpath='{.status.conditions[?(@.type=="Ready")].status}')" = True ]; }
until_ok "Certificate pki/leaf" ready pki leaf
until_ok "Certificate acme-test/web (HTTP-01 through Pebble)" ready acme-test web
dns01_challenge() { k -n acme-test get challenges.acme.cert-manager.io -o jsonpath='{.items[*].spec.type}' | grep -q DNS-01; }
until_ok "the DNS-01 challenge of acme-test/hanging" dns01_challenge
# The reason must really quote what the check expected; the text is matched,
# never printed.
self_check_failed() {
  k -n acme-test get challenges.acme.cert-manager.io \
    -o jsonpath='{.items[?(@.spec.dnsName=="wrong.example.test")].status.reason}' | grep -q 'expected "'
}
until_ok "the failed HTTP-01 self check of acme-test/wrong" self_check_failed

# One kubeconfig per ServiceAccount, each with a token of one hour. They are
# credentials of a throwaway cluster and stay in .work/, which git ignores.
server=$(k config view --minify -o jsonpath='{.clusters[0].cluster.server}')
k config view --minify --raw -o jsonpath='{.clusters[0].cluster.certificate-authority-data}' \
  | base64 -d > "$WORK/ca.crt"
for sa in reader narrow editor noissuer; do
  cfg=$WORK/$sa.kubeconfig
  rm -f "$cfg"
  kubectl --kubeconfig "$cfg" config set-cluster smoke --server="$server" \
    --certificate-authority="$WORK/ca.crt" --embed-certs=true >/dev/null
  kubectl --kubeconfig "$cfg" config set-credentials "$sa" \
    --token="$(k -n pki create token "$sa" --duration=1h)" >/dev/null
  kubectl --kubeconfig "$cfg" config set-context smoke --cluster=smoke --user="$sa" >/dev/null
  kubectl --kubeconfig "$cfg" config use-context smoke >/dev/null
  chmod 600 "$cfg"
done
# The same cluster with a token nobody issued.
sed 's|token: .*|token: not-a-token|' "$WORK/reader.kubeconfig" > "$WORK/badtoken.kubeconfig"
chmod 600 "$WORK/badtoken.kubeconfig"

echo "ready: $(k get certificates.cert-manager.io -A -o name | wc -l) certificates, kubeconfigs in $WORK"
