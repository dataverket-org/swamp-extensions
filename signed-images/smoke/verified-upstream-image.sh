#!/usr/bin/env bash
# @dataverket/verified-upstream-image against a public image whose signature
# and SLSA v1 provenance come from one identity. Read-only: it reads ghcr.io
# and the public Sigstore instance and writes records in $REPO.
#
#   REPO=<scratch swamp repository> ./verified-upstream-image.sh
source "$(dirname "$0")/harness.sh"
W=@dataverket/verified-upstream-image
REF=ghcr.io/renovatebot/renovate:44.226.2
DIGEST=sha256:c30c21d917b25cee1103fe8585bbc67bdb0a8792067237eae8d6734e83b4d485
IDENTITY=https://github.com/renovatebot/renovate/.github/workflows/build.yml@refs/heads/main
SOURCE=https://github.com/renovatebot/renovate
COMMIT=a42552e6c9739a9d577f86dd819e9d41aee7c059
WRONG=0000000000000000000000000000000000000000

echo "=== A. what passes ==="
run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType=slsaprovenance1
passes "the right identity: signature and provenance verified, all eight steps"
[ "$(output digest digest)" = "$DIGEST" ] && ok "the tag resolved to the digest expected" || bad "the tag resolved to the digest expected" "$(output digest digest)"
[ "$(output signature digest)" = "$DIGEST" ] && [ "$(output signature verified)" = "true" ] && ok "the verification is of that digest" || bad "the verification is of that digest" "$(output signature digest)"
[ "$(output attestation sourceCommit)" = "$COMMIT" ] && [ "$(output attestation sourceRepository)" = "$SOURCE" ] && ok "the attestation record names the source" || bad "the attestation record names the source" "$(output attestation sourceCommit)"

run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType=slsaprovenance1 "sourceRepository=$SOURCE" "sourceCommit=$COMMIT"
passes "the right repository and commit"

run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType=
passes "attestationType empty: only the signature, the attestation steps skipped" attestation attested-by-identity

run $W "ref=ghcr.io/renovatebot/renovate@$DIGEST" 'certificateIdentityRegexp=^https://github.com/renovatebot/renovate/\.github/workflows/build\.yml@refs/heads/main$' attestationType=slsaprovenance1 "sourceRepository=$SOURCE" "sourceCommit=$COMMIT"
passes "the reference by digest, the identity as an expression"

run $W "ref=$REF@$DIGEST" "certificateIdentity=$IDENTITY" attestationType=slsaprovenance1
passes "the reference by tag and digest, as a pin is written"
[ "$(output signature digest)" = "$DIGEST" ] && ok "and what is verified is that digest" || bad "and what is verified is that digest" "$(output signature digest)"

echo "=== B. what fails, and where ==="
run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType=slsaprovenance1 "sourceCommit=$WRONG"
fails_at "another commit fails at the attestation assert, with both commits" attested-by-identity "sourceCommit is \\\\?\"$COMMIT\\\\?\", not \\\\?\"$WRONG"

run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType=slsaprovenance1 "sourceRepository=$SOURCE.git" "sourceCommit=$COMMIT"
fails_at "another repository fails there too, the commit being right" attested-by-identity 'sourceRepository is '

run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType=spdxjson
fails_at "an attestation type the image does not have" attested-by-identity 'has no spdxjson attestation'

run $W ref=ghcr.io/fluxcd/source-controller:v1.6.0 "certificateIdentity=$IDENTITY" attestationType=slsaprovenance1
fails_at "an image signed by another identity fails at the signature assert" signed-by-identity 'has no signature from .*renovatebot.*Do not use this image'
never_ran "and its attestations are never asked for" attestation attested-by-identity

run $W "ref=$REF@sha256:${WRONG}000000000000000000000000" "certificateIdentity=$IDENTITY" attestationType=
fails_at "a tag with a digest the registry does not have fails at the digest" digest 'renovate'

run $W "ref=$REF" "certificateIdentity=$IDENTITY" oidcIssuer=https://accounts.example.org attestationType=
fails_at "the right identity from another issuer" signed-by-identity 'has no signature from'

run $W ref=ghcr.io/renovatebot/renovate:0.0.0-no-such-tag "certificateIdentity=$IDENTITY" attestationType=
fails_at "a tag that does not exist fails at the digest" digest 'no-such-tag'
never_ran "and nothing is verified" this-runs-digest signature cosign-version signed-by-identity attestation attested-by-identity
summary
