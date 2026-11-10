#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== F. keys that may do less ==="
collect_secrets

holds "a reader lists" '[.dataArtifacts[] | select(.name == "inventory_ns_pki")][0].attributes.count == 3' cm-reader list
holds "a reader traces" '[.dataArtifacts[] | select(.name | startswith("trace_"))][0].attributes.stage == "ready"' cm-reader trace name=leaf
v=$(version pki leaf); r=$(revision pki leaf)
refuses "a reader cannot renew, and is told which right is missing" \
  "needs the patch verb on certificates/status.*Nothing was changed" cm-reader renew name=leaf
refuses "patch on certificates alone is not enough: the status subresource is its own right" \
  "needs the patch verb on certificates/status" cm-editor renew name=leaf
check "neither attempt changed the certificate" [ "$(version pki leaf)" = "$v" ]
check "nor its revision" [ "$(revision pki leaf)" = "$r" ]

holds "a key that reads only certificates lists them" '[.dataArtifacts[] | select(.name == "inventory_ns_pki")][0].attributes.count == 3' cm-narrow list
holds "... and reads one" '.dataArtifacts[0].attributes.ready' cm-narrow get name=leaf
refuses "... but cannot trace: the requests are refused, and no half trace is stored" \
  "certificaterequests.*forbidden" cm-narrow trace name=leaf
T='([.dataArtifacts[] | select(.name | startswith("trace_"))][0].attributes)'
holds "a key that may not read issuers still traces a hanging DNS-01 to its challenge" \
  "$T | .stage == \"challenge\" and (.issuer.found | not) and .issuer.error == \"could not be read: access was refused\"" \
  cm-noissuer trace name=hanging
holds "... and does not blame an issuer it could not read" \
  "$T | .stage == \"certificaterequest\" and (.issuer.missing | not) and (.summary | test(\"CertificateRequest unreachable-1 is Pending\"))" \
  cm-noissuer trace name=unreachable
refuses "a token nobody issued" "did not accept the credentials of this context" cm-badtoken list
refuses "... cannot renew either" "did not accept the credentials of this context" cm-badtoken renew name=leaf
check "still unchanged" [ "$(version pki leaf)" = "$v" ]
summary
