#!/usr/bin/env bash
# @dataverket/verified-upstream-image with a cosign extension older than
# 2026.11.10.1: the run must fail, at cosign-version, and say what it needs.
# REPO here is a second scratch repository, one that loads this extension
# from source and has @dataverket/cosign 2026.10.28.1 (smoke/README.md says
# how to make one). Read-only.
#
#   REPO=<scratch swamp repository with the older cosign> ./verified-upstream-image-old-cosign.sh
source "$(dirname "$0")/harness.sh"
W=@dataverket/verified-upstream-image
REF=ghcr.io/renovatebot/renovate:44.226.2
IDENTITY=https://github.com/renovatebot/renovate/.github/workflows/build.yml@refs/heads/main
WRONG=0000000000000000000000000000000000000000

version=$(cd "$REPO" && swamp model type describe @dataverket/cosign/signer --json 2>/dev/null | jq -r '.version')
if [ "$version" != "2026.10.28.1" ]; then
  echo "REPO has @dataverket/cosign $version; this batch is for 2026.10.28.1" >&2
  exit 2
fi

echo "=== G. @dataverket/cosign $version ==="
run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType=
fails_at "the signature alone: refused, since the record does not say what it was checked against" cosign-version 'needs @dataverket/cosign 2026.11.10.1 or later'
never_ran "and nothing is asserted from that record" signed-by-identity attestation attested-by-identity

run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType=slsaprovenance1
fails_at "with provenance: the same, where every step passed before with no subject check made" cosign-version 'needs @dataverket/cosign 2026.11.10.1 or later'

run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType=slsaprovenance1 "sourceCommit=$WRONG"
fails_at "with a wrong commit, which the older version ignores: the same, in words" cosign-version 'needs @dataverket/cosign 2026.11.10.1 or later'
never_ran "and the attestation is never asked for" attestation attested-by-identity
if grep -q 'Invalid expression\|No such key' "$OUT"; then bad "no expression error is what the user sees" "$(grep -o 'Invalid expression[^"]*' "$OUT" | head -1)"; else ok "no expression error is what the user sees"; fi
summary
