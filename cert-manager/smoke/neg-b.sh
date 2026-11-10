#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== B. reads: every kind, healthy and not, and what is not there ==="
collect_secrets

L='[.dataArtifacts[] | select(.name | startswith("inventory_"))][0]'
NO_SECRET_KEYS='([.dataArtifacts[].attributes | .. | objects | keys[]] | map(select(. == "token" or . == "key" or . == "request" or . == "certificate" or . == "ca" or . == "url" or . == "config")) | length == 0)'

holds "certificate list sees seven, four of them not healthy" \
  "$L.name == \"inventory_all\" and $L.attributes.namespace == null and $L.attributes.count == 7 and $L.attributes.healthyCount == 3 and $L.attributes.unhealthyCount == 4 and ([.dataArtifacts[].name] | index(\"pki--leaf\") != null)" \
  cm-certificate list
holds "every inventory line names its record; a healthy one has no reason, the others one line each" \
  "$L.attributes.items | (map(select(.healthy)) | length == 3 and all(.reason == null)) and (map(select(.healthy | not)) | length == 4 and all((.reason | type) == \"string\" and (.reason | length) > 0 and (.reason | test(\"\\n\") | not))) and all(.dataName == .namespace + \"--\" + .name) and ([.[] | select(.name == \"hanging\")][0] | .state == \"Issuing\" and .dataName == \"acme-test--hanging\")" \
  cm-certificate list
holds "the inventory names exactly the records the same run wrote" \
  "($L.attributes.items | map(.dataName) | sort) == ([.dataArtifacts[].name | select(startswith(\"inventory_\") | not)] | sort)" \
  cm-certificate list
holds "a definition's namespace scopes the list" \
  "$L.name == \"inventory_ns_pki\" and $L.attributes.namespace == \"pki\" and $L.attributes.count == 3" cm-pki list
holds "a namespace argument overrides it" \
  "$L.name == \"inventory_ns_acme-test\" and $L.attributes.count == 4" cm-pki list namespace=acme-test
holds "a namespace that does not exist lists as empty" \
  "$L.name == \"inventory_ns_no-such-namespace\" and $L.attributes.count == 0 and $L.attributes.items == []" cm-certificate list namespace=no-such-namespace
holds "get reads a Ready certificate with its window, names and issuer" \
  '.dataArtifacts[0].attributes | .ready and (.issuing | not) and .secondsUntilExpiry > 0 and (.expired | not) and .revision >= 1 and .dnsNames == ["leaf.example.test","www.leaf.example.test"] and .issuerRef == {name:"ca",kind:"Issuer",group:"cert-manager.io"} and .secretName == "leaf-tls"' \
  cm-pki get name=leaf
holds "get reads an issuing certificate as a record, not an error" \
  '.dataArtifacts[0].attributes | (.ready | not) and .issuing and .notAfter == null and .secondsUntilExpiry == null and .nextPrivateKeySecretNamePresent' \
  cm-acme get name=hanging

holds "certificaterequest list knows each request's certificate and revision" \
  "$L.attributes.count >= 7 and ([.dataArtifacts[].attributes | select(.certificateName == \"hanging\")][0] | .state == \"Pending\" and .approved and .certificateRevision == 1 and (.certificateIssued | not)) and $NO_SECRET_KEYS" \
  cm-certificaterequest list
holds "order list has the valid and the pending order, authorizations without tokens" \
  "$L.attributes.count >= 2 and ([.dataArtifacts[].attributes | select(.state == \"pending\")][0] | (.authorizations | length == 2) and (.authorizations[0].challengeTypes | index(\"dns-01\") != null) and .certificateRequestName == \"hanging-1\") and $NO_SECRET_KEYS" \
  cm-order list
holds "challenge list has the DNS-01 challenges that cannot complete, and the HTTP-01 one nobody hears" \
  "$L.attributes.count == 3 and $L.attributes.unhealthyCount == 3 and ([.dataArtifacts[].attributes | select(.type == \"HTTP-01\" and .dnsName == \"wrong.example.test\" and .solverKind == \"http01/ingress\" and .state == \"pending\")] | length == 1) and ($L.attributes.items | all(.reason != null)) and ([.dataArtifacts[].attributes | select(.type == \"DNS-01\" and .solverKind == \"dns01/webhook\" and .solverName == \"absent\" and (.presented | not))] | length == 2) and ([.dataArtifacts[].attributes | select(.wildcard == true)] | length == 1) and $NO_SECRET_KEYS" \
  cm-challenge list
CH=$(k -n acme-test get challenges.acme.cert-manager.io -o json | jq -r '[.items[] | select(.spec.type == "DNS-01")][0].metadata.name')
WRONG=$(k -n acme-test get challenges.acme.cert-manager.io -o json | jq -r '[.items[] | select(.spec.dnsName == "wrong.example.test")][0].metadata.name')
# The key cert-manager expected, quoted in the Challenge's reason in the
# cluster: matched below, never printed.
quoted_in_cluster() {
  k -n acme-test get challenges.acme.cert-manager.io "$WRONG" -o json \
    | jq -e '.spec.key as $k | .spec.token as $t | (.status.reason | contains($k) and contains($t))' >/dev/null
}
check "the cluster's Challenge reason really quotes the key authorization" quoted_in_cluster
BLANKED='"expected \"[redacted]\" but got"'
holds "challenge get stores the reason of the failed self check with the key blanked" \
  ".dataArtifacts[0].attributes | .name == \"$WRONG\" and .type == \"HTTP-01\" and (.reason | contains($BLANKED))" \
  cm-challenge get "name=$WRONG" namespace=acme-test
holds "the challenge inventory line carries the same blanked reason" \
  "[$L.attributes.items[] | select(.name == \"$WRONG\")][0] | (.healthy | not) and (.reason | contains($BLANKED))" \
  cm-challenge list
holds "challenge get reads one by name" \
  ".dataArtifacts[0].attributes | .name == \"$CH\" and .dnsName == \"hang.example.test\" and (.orderName | startswith(\"hanging-1-\"))" \
  cm-challenge get "name=$CH" namespace=acme-test
holds "issuer list reads both kinds; the unreachable ACME issuer is not ready" \
  "$L.name == \"inventory_all\" and $L.attributes.count == 6 and $L.attributes.unhealthyCount == 1 and ([.dataArtifacts[].name] | index(\"Issuer--pki--ca\") != null and index(\"ClusterIssuer--pebble-dns01\") != null) and ([$L.attributes.items[] | select(.dataName == \"ClusterIssuer--acme-unreachable\")][0] | .namespace == null and (.healthy | not) and .state == \"NotReady\" and (.reason | length) > 0) and ([$L.attributes.items[] | select(.dataName == \"Issuer--pki--ca\")][0] | .namespace == \"pki\" and .healthy and .reason == null) and $NO_SECRET_KEYS" \
  cm-issuer list
holds "an issuer list of one kind writes the issuers and no inventory" \
  '([.dataArtifacts[].name] | length == 5 and all(startswith("ClusterIssuer--")))' \
  cm-issuer list kind=ClusterIssuer
holds "issuer get reads a ClusterIssuer that cannot register" \
  '.dataArtifacts[0].attributes | (.ready | not) and .type == "acme" and .readyReason == "ErrRegisterACMEAccount" and .namespace == ""' \
  cm-issuer get name=acme-unreachable kind=ClusterIssuer

refuses "a certificate that is not there" "Certificate pki/nope does not exist" cm-pki get name=nope
refuses "a certificate in a namespace that is not there" "Certificate no-such-namespace/leaf does not exist" cm-pki get name=leaf namespace=no-such-namespace
refuses "a request that is not there" "CertificateRequest pki/nope does not exist" cm-certificaterequest get name=nope namespace=pki
refuses "an order that is not there" "Order pki/nope does not exist" cm-order get name=nope namespace=pki
refuses "a challenge that is not there" "Challenge pki/nope does not exist" cm-challenge get name=nope namespace=pki
refuses "an issuer that is not there" "ClusterIssuer nope does not exist" cm-issuer get name=nope kind=ClusterIssuer
refuses "get without a namespace anywhere" "namespace is required for get" cm-certificate get name=leaf
refuses "get without a name" "name" cm-pki get
summary
