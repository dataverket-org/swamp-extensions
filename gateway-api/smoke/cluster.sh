#!/usr/bin/env bash
# What the live suite installs on the throwaway kind cluster, one step per
# argument. Versions are pinned here and nowhere else.
#
#   ./cluster.sh old-crds       Gateway API v0.8.1 CRDs: serve v1beta1 only
#   ./cluster.sh no-crds        remove the v0.8.1 CRDs again
#   ./cluster.sh crds           Gateway API standard channel, the pinned release
#   ./cluster.sh controller     Envoy Gateway, from its OCI chart
#   ./cluster.sh fixtures       the Gateways and routes the suite reads
#   ./cluster.sh settle         wait until the controller has reported on them
#   ./cluster.sh rename         rename a listener a route is attached to
#   ./cluster.sh resection      add a listener name to an attached route's
#                               parent, and take one away from another's
#   ./cluster.sh written-status write the status no controller here produces
set -euo pipefail
cd "$(dirname "$0")"
source ./harness.sh

GATEWAY_API_VERSION=v1.5.1
GATEWAY_API_OLD_VERSION=v0.8.1
ENVOY_GATEWAY_VERSION=v1.8.2
RELEASES=https://github.com/kubernetes-sigs/gateway-api/releases/download
OLD_CRDS=https://raw.githubusercontent.com/kubernetes-sigs/gateway-api/$GATEWAY_API_OLD_VERSION/config/crd/standard
CHARTS=oci://docker.io/envoyproxy
WORK=$PWD/.work

# Poll a command every 5 s, at most $1 times; no single wait is long.
poll() { # tries command...
  local tries=$1 i; shift
  for ((i = 0; i < tries; i++)); do
    if "$@" >/dev/null 2>&1; then return 0; fi
    sleep 5
  done
  echo "cluster: gave up waiting for: $*" >&2
  return 1
}

# The Accepted status of route "renamed" for one listener name, or nothing.
accepted_for() { # listener
  k -n apps get httproute renamed -o json |
    jq -r --arg s "$1" '.status.parents[]? | select(.parentRef.sectionName == $s)
      | .conditions[] | select(.type == "Accepted") | .status'
}
is_accepted() { [ "$(accepted_for "$1")" = "$2" ]; } # listener status

# True once the controller reported on a route at its present generation for
# the parent in this form: a listener name, or "" for none.
reported_now() { # route listener
  k -n apps get httproute "$1" -o json | jq -e --arg s "$2" '
    .metadata.generation as $g
    | [.status.parents[]? | select((.parentRef.sectionName // "") == $s)
       | .conditions[] | select(.type == "Accepted")
       | .status == "True" and .observedGeneration == $g] | any'
}

# Write .status of an object as a controller would: a merge patch of the
# status subresource, built by a jq filter from the object as it is now.
write_status() { # resource name jq-filter [-n namespace]
  local resource=$1 name=$2 filter=$3; shift 3
  k "$@" patch "$resource" "$name" --subresource=status --type=merge \
    -p "$(k "$@" get "$resource" "$name" -o json | jq -c "{status: ($filter)}")" >/dev/null
}

# True once the API server no longer serves Gateways.
crd_gone() { ! k get crd gateways.gateway.networking.k8s.io; }

case "${1:-}" in
  old-crds)
    for kind in gatewayclasses gateways httproutes; do
      k apply -f "$OLD_CRDS/gateway.networking.k8s.io_$kind.yaml"
    done
    poll 12 k wait --for=condition=Established --timeout=5s \
      crd/gateways.gateway.networking.k8s.io
    k create namespace old-api --dry-run=client -o yaml | k apply -f -
    k apply -f - <<'YAML'
apiVersion: gateway.networking.k8s.io/v1beta1
kind: Gateway
metadata: { name: old, namespace: old-api }
spec:
  gatewayClassName: nobody
  listeners:
    - { name: http, port: 80, protocol: HTTP }
YAML
    ;;
  no-crds)
    k delete namespace old-api --ignore-not-found --wait=false
    for kind in gatewayclasses gateways httproutes; do
      k delete --ignore-not-found --wait=false \
        -f "$OLD_CRDS/gateway.networking.k8s.io_$kind.yaml"
    done
    poll 24 crd_gone
    ;;
  crds)
    k apply --server-side -f "$RELEASES/$GATEWAY_API_VERSION/standard-install.yaml"
    poll 12 k wait --for=condition=Established --timeout=5s \
      crd/httproutes.gateway.networking.k8s.io
    ;;
  controller)
    # The chart's own CRDs only; the Gateway API ones are the upstream release.
    helm template eg-crds "$CHARTS/gateway-crds-helm" \
      --version "$ENVOY_GATEWAY_VERSION" \
      --set crds.gatewayAPI.enabled=false \
      --set crds.envoyGateway.enabled=true |
      k apply --server-side -f -
    helm --kubeconfig "$SMOKE_KUBECONFIG" --kube-context "$SMOKE_CONTEXT" \
      upgrade --install eg "$CHARTS/gateway-helm" \
      --version "$ENVOY_GATEWAY_VERSION" \
      --namespace envoy-gateway-system --create-namespace --skip-crds
    poll 30 k -n envoy-gateway-system wait --for=condition=Available \
      --timeout=5s deployment/envoy-gateway
    ;;
  fixtures)
    # A throwaway certificate for the HTTPS listeners; the key stays in .work.
    mkdir -p "$WORK"
    (umask 077; openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 \
      -nodes -days 2 -subj "/CN=*.example.org" \
      -keyout "$WORK/tls.key" -out "$WORK/tls.crt" 2>/dev/null)
    k apply -f fixtures.yaml
    k -n gw-smoke create secret tls wildcard \
      --cert "$WORK/tls.crt" --key "$WORK/tls.key" \
      --dry-run=client -o yaml | k apply -f - >/dev/null
    echo "secret/wildcard applied"
    ;;
  settle)
    poll 30 k -n gw-smoke wait --for=condition=Programmed --timeout=5s \
      gateway/healthy
    poll 12 k -n apps wait --timeout=5s httproute/ok \
      --for=jsonpath='{.status.parents[0].conditions[0].type}'
    poll 12 k -n outside wait --timeout=5s httproute/not-allowed \
      --for=jsonpath='{.status.parents[0].conditions[0].type}'
    poll 12 is_accepted before True
    ;;
  rename)
    # The Gateway's listener gets a new name, the controller refuses the
    # route's old reference, and then the route follows.
    k -n gw-smoke patch gateway renamed --type=json \
      -p '[{"op":"replace","path":"/spec/listeners/0/name","value":"after"}]'
    poll 12 is_accepted before False
    k -n apps patch httproute renamed --type=json \
      -p '[{"op":"replace","path":"/spec/parentRefs/0/sectionName","value":"after"}]'
    poll 12 is_accepted after True
    ;;
  resection)
    # The route named the Gateway and now names one of its listeners...
    poll 12 reported_now section-added ""
    k -n apps patch httproute section-added --type=json \
      -p '[{"op":"add","path":"/spec/parentRefs/0/sectionName","value":"a"}]'
    poll 12 reported_now section-added a
    # ...and the other way round.
    poll 12 reported_now section-removed a
    k -n apps patch httproute section-removed --type=json \
      -p '[{"op":"remove","path":"/spec/parentRefs/0/sectionName"}]'
    poll 12 reported_now section-removed ""
    ;;
  written-status)
    # Two controllers on one parent: the route changed once (generation 2),
    # one controller followed and the other, which is gone, did not.
    k -n apps patch httproute two-controllers --type=json \
      -p '[{"op":"add","path":"/spec/hostnames/-","value":"two-b.example.org"}]'
    write_status httproute two-controllers '{parents: [
      {controllerName: "example.org/suite", parentRef: {group: "gateway.networking.k8s.io", kind: "Gateway", name: "unmanaged", namespace: "gw-smoke", sectionName: "http"},
       conditions: [
        {type: "Accepted", status: "True", reason: "Accepted", message: "", observedGeneration: 2, lastTransitionTime: "2026-01-01T00:00:00Z"},
        {type: "ResolvedRefs", status: "True", reason: "ResolvedRefs", message: "", observedGeneration: 2, lastTransitionTime: "2026-01-01T00:00:00Z"}]},
      {controllerName: "example.org/replaced-controller", parentRef: {group: "gateway.networking.k8s.io", kind: "Gateway", name: "unmanaged", namespace: "gw-smoke", sectionName: "http"},
       conditions: [
        {type: "Accepted", status: "True", reason: "Accepted", message: "", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"},
        {type: "ResolvedRefs", status: "True", reason: "ResolvedRefs", message: "", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"}]}
      ]}' -n apps
    # Reports per listener for a parent the route names without one.
    write_status httproute other-form '{parents: [
      {controllerName: "example.org/suite", parentRef: {group: "gateway.networking.k8s.io", kind: "Gateway", name: "unmanaged", namespace: "gw-smoke", sectionName: "http"},
       conditions: [
        {type: "Accepted", status: "False", reason: "NotAllowedByListeners", message: "written by the live suite", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"},
        {type: "ResolvedRefs", status: "True", reason: "ResolvedRefs", message: "", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"}]},
      {controllerName: "example.org/suite", parentRef: {group: "gateway.networking.k8s.io", kind: "Gateway", name: "unmanaged", namespace: "gw-smoke", sectionName: "https"},
       conditions: [
        {type: "Accepted", status: "True", reason: "Accepted", message: "", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"},
        {type: "ResolvedRefs", status: "True", reason: "ResolvedRefs", message: "", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"}]}
      ]}' -n apps
    # Named without a listener, and no listener accepts.
    write_status httproute all-refuse '{parents: [
      {controllerName: "example.org/suite", parentRef: {group: "gateway.networking.k8s.io", kind: "Gateway", name: "unmanaged", namespace: "gw-smoke", sectionName: "http"},
       conditions: [
        {type: "Accepted", status: "False", reason: "NotAllowedByListeners", message: "written by the live suite", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"},
        {type: "ResolvedRefs", status: "True", reason: "ResolvedRefs", message: "", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"}]},
      {controllerName: "example.org/suite", parentRef: {group: "gateway.networking.k8s.io", kind: "Gateway", name: "unmanaged", namespace: "gw-smoke", sectionName: "https"},
       conditions: [
        {type: "Accepted", status: "False", reason: "NoMatchingListenerHostname", message: "written by the live suite", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"},
        {type: "ResolvedRefs", status: "True", reason: "ResolvedRefs", message: "", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"}]}
      ]}' -n apps
    # Accepted, with some rules dropped; the port of the spec's parent left out.
    write_status httproute partially-invalid '{parents: [
      {controllerName: "example.org/suite", parentRef: {group: "gateway.networking.k8s.io", kind: "Gateway", name: "unmanaged", namespace: "gw-smoke"},
       conditions: [
        {type: "Accepted", status: "True", reason: "Accepted", message: "", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"},
        {type: "ResolvedRefs", status: "True", reason: "ResolvedRefs", message: "", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"},
        {type: "PartiallyInvalid", status: "True", reason: "UnsupportedValue", message: "written by the live suite", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"}]}
      ]}' -n apps
    # Accepted on CRDs of a version the controller does not support.
    write_status gatewayclass unsupported-version '{conditions: [
      {type: "Accepted", status: "True", reason: "Accepted", message: "", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"},
      {type: "SupportedVersion", status: "False", reason: "UnsupportedVersion", message: "written by the live suite", observedGeneration: 1, lastTransitionTime: "2026-01-01T00:00:00Z"}]}'
    ;;
  *)
    sed -n '2,15p' "$0" >&2
    exit 2
    ;;
esac
