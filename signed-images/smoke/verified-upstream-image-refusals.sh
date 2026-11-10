#!/usr/bin/env bash
# @dataverket/verified-upstream-image: inputs it refuses before the registry
# is read, and a publisher whose provenance is signed by another identity
# than its image. Read-only, as verified-upstream-image.sh.
#
#   REPO=<scratch swamp repository> ./verified-upstream-image-refusals.sh
source "$(dirname "$0")/harness.sh"
W=@dataverket/verified-upstream-image
REF=ghcr.io/renovatebot/renovate:44.226.2
IDENTITY=https://github.com/renovatebot/renovate/.github/workflows/build.yml@refs/heads/main
COMMIT=a42552e6c9739a9d577f86dd819e9d41aee7c059
WRONG=0000000000000000000000000000000000000000
REST=(digest one-digest this-runs-digest signature cosign-version signed-by-identity attestation attested-by-identity)

echo "=== H. the names an unknown input is held to ==="
for w in ko-signed-images ko-signed-manifests verified-manifests signed-release verify-release promote-release mirror-release-images pinned-base-image verified-upstream-image; do
  inputs_match "@dataverket/$w"
done

echo "=== C. refused before anything is read ==="
run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType= attestationtype=slsaprovenance1 "sourcecommit=$WRONG"
not_started "an input name in the wrong case is refused, not ignored" 'attestationtype|sourcecommit'

run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType=slsaprovenance1 "sourceComit=$WRONG"
not_started "a mistyped sourceCommit is refused, where it was a run that asked for no commit" 'sourceComit'

run $W "ref=$REF" "certificateIdentity=$IDENTITY"
not_started "attestationType left out is refused: the caller says whether the attestation is checked" 'attestationType'

run $W "certificateIdentity=$IDENTITY" attestationType=
not_started "no ref at all is refused" 'ref'

# The other eight refuse an unknown input too; this one needs no registry.
run @dataverket/verify-release repository=registry.example.invalid/team/release publicKey=cosign.pub tag=v1 'anotations:json=["env=prod"]'
not_started "verify-release refuses a mistyped annotations, which was a run that asked for no annotation" 'anotations'

run $W "ref=$REF" attestationType=slsaprovenance1
fails_at "neither identity input" one-identity 'Give exactly one of certificateIdentity and certificateIdentityRegexp'
never_ran "and nothing ran" "${REST[@]}"

run $W "ref=$REF" "certificateIdentity=$IDENTITY" 'certificateIdentityRegexp=^https://github\.com/renovatebot/.*$' attestationType=
fails_at "both identity inputs" one-identity 'Give exactly one of'
never_ran "and nothing ran" "${REST[@]}"

run $W "ref=$REF" 'certificateIdentityRegexp=.*' attestationType=
fails_at "an expression that is not anchored: .* is any workflow of any repository" expression-anchored 'start with \^ and end with \$'
never_ran "and nothing ran" "${REST[@]}"

run $W "ref=$REF" 'certificateIdentityRegexp=^https://github.com/renovatebot/' attestationType=
fails_at "an expression anchored at one end only" expression-anchored 'start with \^ and end with \$'
never_ran "and nothing ran" "${REST[@]}"

run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType= "sourceCommit=$COMMIT"
fails_at "a source asked for with attestationType empty" source-needs-attestation 'nothing would check it'
never_ran "and nothing ran" "${REST[@]}"

run $W "ref=$REF" "certificateIdentity=$IDENTITY" attestationType=https://sigstore.dev/cosign/sign/v1
fails_at "the type cosign stores the signature under, which every signed image has" attestation-type-is-not-the-signature 'stores the signature itself'
never_ran "and nothing ran" "${REST[@]}"

run $W "ref=$REF" 'certificateIdentityRegexp=^https://github\.com/renovatebot/renovate/\.github/workflows/build\.yml@refs/heads/main$' attestationType=slsaprovenance1
fails_at "an expression with provenance and no sourceRepository" expression-with-provenance-needs-source 'sourceRepository'
never_ran "and nothing ran" "${REST[@]}"

echo "=== D. provenance signed by another identity than the image ==="
# The image is signed by the repository's release workflow; its SLSA v0.2
# provenance is signed by the slsa-github-generator's reusable workflow,
# which signs provenance for any repository that calls it.
FLUX=ghcr.io/fluxcd/source-controller:v1.6.0
FLUX_SOURCE=https://github.com/fluxcd/source-controller
RELEASE='^https://github\.com/fluxcd/source-controller/\.github/workflows/release\.yml@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$'
BOTH='^https://github\.com/(fluxcd/source-controller/\.github/workflows/release\.yml|slsa-framework/slsa-github-generator/\.github/workflows/generator_container_slsa3\.yml)@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$'

run $W "ref=$FLUX" "certificateIdentityRegexp=$RELEASE" attestationType=
passes "the signature alone, against the release workflow" attestation attested-by-identity

run $W "ref=$FLUX" "certificateIdentityRegexp=$RELEASE" attestationType=slsaprovenance "sourceRepository=$FLUX_SOURCE"
fails_at "the provenance does not verify against the release workflow's identity, and the message says what that usually means" attested-by-identity 'has no slsaprovenance attestation.*signed by another identity than the image'

run $W "ref=$FLUX" "certificateIdentityRegexp=$BOTH" attestationType=slsaprovenance "sourceRepository=$FLUX_SOURCE" sourceCommit=83cb98615d31294f19766cb08e649635503bf951
passes "an expression for both identities, with the source held to the repository and commit"

run $W "ref=$FLUX" "certificateIdentityRegexp=$BOTH" attestationType=slsaprovenance sourceRepository=https://github.com/fluxcd/helm-controller
fails_at "and the same with another repository, which the generator signs for as well" attested-by-identity 'sourceRepository is .*fluxcd/source-controller.*, not .*fluxcd/helm-controller'
summary
