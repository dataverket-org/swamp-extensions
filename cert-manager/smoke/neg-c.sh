#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== C. trace: the chain from a Certificate down, and where it stands ==="
collect_secrets

T='([.dataArtifacts[] | select(.name | startswith("trace_"))][0].attributes)'
holds "a certificate issued over HTTP-01 through Pebble: ready, its order valid, challenges gone" \
  "$T | .stage == \"ready\" and .certificateRequest.state == \"Issued\" and .order.state == \"valid\" and .challenges == [] and .issuer.ready" \
  cm-acme trace name=web
holds "a hanging DNS-01: the trace stops at the challenge and says why" \
  "$T | .stage == \"challenge\" and (.summary | test(\"DNS-01 for .*hang.example.test, solver dns01/webhook\\\\) is pending, not presented\")) and .order.state == \"pending\" and (.challenges | length == 2) and .certificateRequest.state == \"Pending\" and .certificate.issuing and .issuer.ready" \
  cm-acme trace name=hanging
holds "the trace also refreshes the certificate record" \
  '[.dataArtifacts[].name] == ["acme-test--hanging", "trace_acme-test--hanging"]' \
  cm-acme trace name=hanging
BLANKED='"expected \"[redacted]\" but got"'
holds "an HTTP-01 answer nobody hears: the trace stops at the challenge, and the key it quotes is blanked" \
  "$T | .stage == \"challenge\" and (.summary | contains(\"(HTTP-01 for wrong.example.test, solver http01/ingress) is pending\") and contains($BLANKED)) and (.challenges | length == 1) and (.challenges[0].reason | contains($BLANKED)) and .order.state == \"pending\" and .issuer.ready" \
  cm-acme trace name=wrong
holds "an ACME directory that does not answer: the trace stops at the issuer" \
  "$T | .stage == \"issuer\" and (.issuer.found and (.issuer.ready | not)) and .order == null and (.summary | test(\"ClusterIssuer acme-unreachable is not Ready\"))" \
  cm-acme trace name=unreachable
holds "an issuer that does not exist is recorded, not thrown" \
  "$T | .stage == \"issuer\" and (.issuer.found | not) and .issuer.error == \"does not exist\" and .certificateRequest.state == \"Pending\"" \
  cm-pki trace name=no-issuer
holds "a CA-issued certificate has no order" \
  "$T | .stage == \"ready\" and .order == null and .challenges == [] and .issuer.kind == \"Issuer\"" \
  cm-pki trace name=leaf
refuses "trace of a certificate that is not there" "Certificate pki/nope does not exist" cm-pki trace name=nope
refuses "trace without a namespace anywhere" "namespace is required for trace" cm-certificate trace name=leaf
summary
