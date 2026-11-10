#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== D. renew: the revision advances, and everything that must not renew ==="
collect_secrets

R='([.dataArtifacts[] | select(.name | startswith("renewal_"))][0].attributes)'

before=$(revision pki leaf)
holds "a CA certificate is renewed and its revision rises by one" \
  "$R | .outcome == \"issued\" and .revisionBefore == $before and .revisionAfter == $((before + 1)) and (.issuing | not) and .ready and .pollError == null and .notAfterAfter >= .notAfterBefore" \
  cm-pki renew name=leaf
check "the cluster agrees on the new revision" [ "$(revision pki leaf)" = "$((before + 1))" ]
holds "the renewal also stores the certificate as it is now" \
  "[.dataArtifacts[].name] == [\"pki--leaf\", \"renewal_pki--leaf\"] and .dataArtifacts[0].attributes.revision == $((before + 2))" \
  cm-pki renew name=leaf

conditions() { k -n "$1" get certificates.cert-manager.io "$2" -o json | jq -cS '[.status.conditions[] | select(.type != "Issuing")]'; }
before=$(revision pki leaf)
kept=$(conditions pki leaf)
holds "waitSeconds 0 records the trigger and does not wait" \
  "$R | .outcome == \"in-progress\" and .issuing and .issuingReason == \"ManuallyTriggered\" and .waitedSeconds == 0 and .revisionAfter == $before" \
  cm-pki renew name=leaf waitSeconds=0
risen() { [ "$(revision pki leaf)" = "$((before + 1))" ]; }
check "the renewal went on in the cluster after the method returned" eventually risen
check "the patch wrote every other condition back as it was read" [ "$(conditions pki leaf)" = "$kept" ]

before=$(revision acme-test web)
holds "an ACME certificate is renewed through Pebble: a new order, a new revision" \
  "$R | .outcome == \"issued\" and .revisionAfter == $((before + 1))" \
  cm-acme renew name=web waitSeconds=90
holds "its trace now shows the request of the new revision" \
  "[.dataArtifacts[] | select(.name | startswith(\"trace_\"))][0].attributes | .certificateRequest.certificateRevision == $((before + 1)) and .order.state == \"valid\"" \
  cm-acme trace name=web

v=$(version acme-test hanging)
refuses "a certificate in the middle of an issuance is not renewed" "is already issuing since .*renew is refused" cm-acme renew name=hanging
refuses "nor one whose issuer is missing and which never got as far as an order" "is already issuing" cm-pki renew name=no-issuer
check "the refused renewal changed nothing" [ "$(version acme-test hanging)" = "$v" ]
refuses "a certificate that is not there" "Certificate pki/nope does not exist" cm-pki renew name=nope
refuses "a namespace that is not there" "Certificate no-such-namespace/leaf does not exist" cm-pki renew name=leaf namespace=no-such-namespace
refuses "renew without a namespace anywhere" "namespace is required for renew" cm-certificate renew name=leaf
refuses "renew without a name" "name" cm-pki renew
v=$(version pki leaf)
refuses "a wait longer than two minutes" "waitSeconds" cm-pki renew name=leaf waitSeconds=121
refuses "a negative wait" "waitSeconds" cm-pki renew name=leaf waitSeconds=-1
refuses "a wait that is not a number" "waitSeconds" cm-pki renew name=leaf waitSeconds=soon
check "the refused arguments changed nothing" [ "$(version pki leaf)" = "$v" ]
summary
