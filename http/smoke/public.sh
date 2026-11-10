#!/usr/bin/env bash
# bodyJson against a real OIDC discovery document, read-only: two plain GETs.
# URL is the discovery document, ISSUER the issuer it must name.
#
#   URL=https://id.example.org/.well-known/openid-configuration \
#   ISSUER=https://id.example.org ./public.sh
source "$(dirname "$0")/negative.sh"
URL=${URL:-https://id.example.org/.well-known/openid-configuration}
ISSUER=${ISSUER:-https://id.example.org}

model pj-issuer "url=$URL" "bodyJson:json={\"issuer\":\"$ISSUER\"}"
holds "the issuer is exactly $ISSUER, over a verified chain" \
  '.ok == true and .tls == "verified" and .jsonMatched == true and .jsonMismatches == []' pj-issuer
model pj-wrong "url=$URL" "bodyJson:json={\"issuer\":\"$ISSUER.wrong.example\"}" bodyJsonShowValues=true
holds "another issuer is recorded as a failure that names the field" \
  ".ok == false and .reachable == true and .status == 200 and .jsonMatched == false and .jsonMismatches[0].path == \"/issuer\" and .jsonMismatches[0].reason == \"value\" and .jsonMismatches[0].actual == (\"$ISSUER\" | tojson)" pj-wrong
model pj-slash "url=$URL" "bodyJson:json={\"issuer\":\"$ISSUER/\"}"
holds "a trailing slash is another issuer" '.ok == false and .jsonMismatches[0].reason == "value"' pj-slash
summary
