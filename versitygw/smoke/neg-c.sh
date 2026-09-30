#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== C. TLS against the site's CA ==="

holds "the right CA verifies" \
  '.dataArtifacts[] | select(.name == "health") | .attributes.tls == "verified" and .attributes.reachable' \
  vgw-tls health
holds "another CA fails the chain, recorded, not thrown" \
  '.dataArtifacts[] | select(.name == "health") | .attributes.tls == "failed" and (.attributes.reachable | not)' \
  vgw-tls-other-ca health
holds "no CA at all (system store) fails the chain" \
  '.dataArtifacts[] | select(.name == "health") | .attributes.tls == "failed"' \
  vgw-tls-no-ca health
holds "bucketSettings over TLS with the right CA reads the bucket" \
  '.dataArtifacts[] | select(.name == "settings-cnpg-forgejo") | .attributes.versioning == "Off"' \
  vgw-tls bucketSettings
refuses "bucketSettings over TLS with another CA fails" "certificate|UnknownIssuer" vgw-tls-other-ca bucketSettings
summary
