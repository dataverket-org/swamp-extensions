#!/usr/bin/env bash
# verifyAttestation against two public images, read-only: what the provenance
# of each says, and whether sourceRepository and sourceCommit are held to it.
# Reads ghcr.io and the public Sigstore instance; writes records in $REPO.
#
#   REPO=<scratch swamp repository> ./provenance.sh
source "$(dirname "$0")/harness.sh"
ISSUER=https://token.actions.githubusercontent.com

# A. SLSA provenance v1, written by GitHub's attest-build-provenance.
V1=ghcr.io/renovatebot/renovate@sha256:c30c21d917b25cee1103fe8585bbc67bdb0a8792067237eae8d6734e83b4d485
V1_IDENTITY=https://github.com/renovatebot/renovate/.github/workflows/build.yml@refs/heads/main
V1_SOURCE=https://github.com/renovatebot/renovate
V1_COMMIT=a42552e6c9739a9d577f86dd819e9d41aee7c059

model sm-v1 "certificateIdentity=$V1_IDENTITY" "oidcIssuer=$ISSUER" tlog=true
run sm-v1 verifyAttestation "refs:json=[\"$V1\"]" type=slsaprovenance1
holds "v1: verified, one attestation, and it counts" \
  '.verified == true and .attestations == 1 and .matched == 1 and .error == "" and .predicateTypes == ["https://slsa.dev/provenance/v1"]'
holds "v1: the summary names repository, ref, commit and builder" \
  ".sourceRepository == \"$V1_SOURCE\" and .sourceRef == \"refs/heads/main\" and .sourceCommit == \"$V1_COMMIT\" and .builderId == \"$V1_IDENTITY\""
holds "v1: the statement's subject is the digest that was verified" \
  '.statements | length == 1 and .[0].subjectMatches == true and .[0].counted == true and .[0].subjects == [{name: "ghcr.io/renovatebot/renovate", digest: {sha256: "c30c21d917b25cee1103fe8585bbc67bdb0a8792067237eae8d6734e83b4d485"}}]'
holds "v1: the workflow, the dependency and the invocation are recorded" \
  ".statements[0].provenance | .buildType == \"https://actions.github.io/buildtypes/workflow/v1\" and .workflow.path == \".github/workflows/build.yml\" and .resolvedDependencies == [{uri: \"git+$V1_SOURCE@refs/heads/main\", gitCommit: \"$V1_COMMIT\"}] and (.invocationId | startswith(\"$V1_SOURCE/actions/runs/\"))"
holds "v1: the record says which identity and issuer it was checked against" \
  ".verifyMode == \"keyless\" and .certificateIdentity == \"$V1_IDENTITY\" and .certificateIdentityRegexp == \"\" and .oidcIssuer == \"$ISSUER\" and .publicKeyFingerprint == \"\""
holds "v1: nothing but the named fields is stored" \
  '(.statements[0].provenance | keys) == ["buildType","builderId","invocationId","resolvedDependencies","resolvedDependencyCount","workflow"] and .statements[0].withheld == 0'

run sm-v1 verifyAttestation "refs:json=[\"$V1\"]" type=slsaprovenance1 "sourceRepository=$V1_SOURCE" "sourceCommit=$V1_COMMIT"
holds "v1: the right repository and commit pass, and are recorded as expected" \
  ".verified == true and .matched == 1 and .expectedSourceCommit == \"$V1_COMMIT\" and .expectedSourceRepository == \"$V1_SOURCE\""

WRONG=0000000000000000000000000000000000000000
run sm-v1 verifyAttestation "refs:json=[\"$V1\"]" type=slsaprovenance1 "sourceCommit=$WRONG"
holds "v1: another commit is recorded as not verified, with both commits in the reason" \
  ".verified == false and .attestations == 1 and .matched == 0 and .sourceCommit == null and .statements[0].sourceCommit == \"$V1_COMMIT\" and .error == \"1 attestation verified by cosign, none counted: sourceCommit is \\\"$V1_COMMIT\\\", not \\\"$WRONG\\\"\""
run sm-v1 verifyAttestation "refs:json=[\"$V1\"]" type=slsaprovenance1 "sourceCommit=${V1_COMMIT:0:12}"
holds "v1: a short commit is another commit" '.verified == false and .matched == 0'
run sm-v1 verifyAttestation "refs:json=[\"$V1\"]" type=slsaprovenance1 "sourceRepository=$V1_SOURCE.git"
holds "v1: the repository with .git is another repository" \
  '.verified == false and (.error | contains("sourceRepository is "))'
run sm-v1 verifyAttestation "refs:json=[\"$V1\"]" type=slsaprovenance1 "sourceCommit=$V1_COMMIT extra"
refused "v1: an expectation with a space is refused before cosign runs" 'sourceCommit is not one word'
run sm-v1 verifyAttestation "refs:json=[\"$V1\"]" type=spdxjson
holds "v1: a type the image has no attestation of is a record, not a failed run" \
  '.verified == false and .attestations == 0 and .statements == [] and (.error | startswith("none of the attestations matched the predicate type: spdxjson"))'
run sm-v1 verify "refs:json=[\"$V1\"]"
holds "v1: the signature verifies, and its record names the identity and issuer too" \
  ".verified == true and .signatures >= 1 and .verifyMode == \"keyless\" and .certificateIdentity == \"$V1_IDENTITY\" and .oidcIssuer == \"$ISSUER\""
run sm-v1 verifyAttestation "refs:json=[\"-x@${V1#*@}\"]" type=slsaprovenance1
refused "v1: a reference that starts with a dash is refused, not handed to cosign as a flag" 'not an image reference pinned by digest'

model sm-v1-other "certificateIdentity=https://github.com/example/nobody/.github/workflows/build.yml@refs/heads/main" "oidcIssuer=$ISSUER" tlog=true
run sm-v1-other verifyAttestation "refs:json=[\"$V1\"]" type=slsaprovenance1 "sourceCommit=$V1_COMMIT"
holds "v1: another identity verifies nothing, and nothing is read from what did not verify" \
  '.certificateIdentity == "https://github.com/example/nobody/.github/workflows/build.yml@refs/heads/main" and .verified == false and .attestations == 0 and .statements == [] and .sourceCommit == null and (.error | test("none of the expected identities matched|no matching attestations"))'

# B. SLSA provenance v0.2, written by the slsa-github-generator. The
# certificate names the generator, so the source is only in the provenance.
V02_TAG=ghcr.io/fluxcd/source-controller:v1.6.0
V02=ghcr.io/fluxcd/source-controller@sha256:44ea51a40e4da2c0f19427df3219f29b86c8fce38539d227f6ffc2bdc944036f
V02_SOURCE=https://github.com/fluxcd/source-controller
V02_COMMIT=83cb98615d31294f19766cb08e649635503bf951

model sm-v02 'certificateIdentityRegexp=^https://github.com/slsa-framework/slsa-github-generator/.github/workflows/generator_container_slsa3.yml@refs/tags/v[0-9]+.[0-9]+.[0-9]+$' "oidcIssuer=$ISSUER" tlog=true
run sm-v02 verifyAttestation "refs:json=[\"$V02\"]" type=slsaprovenance "sourceRepository=$V02_SOURCE" "sourceCommit=$V02_COMMIT"
holds "v0.2 ($V02_TAG): verified, the config source is the repository, ref and commit" \
  ".verified == true and .matched == 1 and .predicateTypes == [\"https://slsa.dev/provenance/v0.2\"] and .sourceRepository == \"$V02_SOURCE\" and .sourceRef == \"refs/tags/v1.6.0\" and .sourceCommit == \"$V02_COMMIT\" and (.builderId | startswith(\"https://github.com/slsa-framework/slsa-github-generator/\"))"
holds "v0.2: entry point, materials and invocation id are recorded; the environment is not" \
  ".statements[0].provenance | .workflow.path == \".github/workflows/release.yml\" and .resolvedDependencies == [{uri: \"git+$V02_SOURCE@refs/tags/v1.6.0\", gitCommit: \"$V02_COMMIT\"}] and .invocationId != null and (keys | index(\"environment\")) == null"
if grep -q 'github_event_payload\|github_actor' "$OUT"; then
  bad "v0.2: the invocation's environment is nowhere in the output" "found"
else
  ok "v0.2: the invocation's environment is nowhere in the output"
fi
run sm-v02 verifyAttestation "refs:json=[\"$V02\"]" type=slsaprovenance "sourceRepository=$V1_SOURCE"
holds "v0.2: another repository is recorded as not verified" \
  ".verified == false and .error == \"1 attestation verified by cosign, none counted: sourceRepository is \\\"$V02_SOURCE\\\", not \\\"$V1_SOURCE\\\"\""

# C. A definition written by 2026.10.28.1, and a call as it was made then.
dir=$REPO/models/@dataverket/cosign/signer
mkdir -p "$dir"
cat > "$dir/sm-old.yaml" <<YAML
type: '@dataverket/cosign/signer'
typeVersion: 2026.10.28.1
id: $(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
name: sm-old
version: 1
tags: {}
globalArguments:
  key: ''
  password: ''
  publicKey: ''
  certificateIdentity: '$V1_IDENTITY'
  certificateIdentityRegexp: ''
  oidcIssuer: '$ISSUER'
  tlog: true
  signingConfig: ''
  trustedRoot: ''
  insecureRegistry: false
  httpRegistry: false
  cosignBinary: cosign
methods: {}
YAML
run sm-old verifyAttestation "refs:json=[\"$V1\"]" type=slsaprovenance1
holds "a definition of 2026.10.28.1 runs as before, with the old fields as they were" \
  '.verified == true and .attestations == 1 and .predicateTypes == ["https://slsa.dev/provenance/v1"] and .error == "" and .tlog == true and .type == "slsaprovenance1" and .expectedSourceCommit == "" and .expectedSourceRepository == ""'
if grep -q '^typeVersion: 2026.11.10.2' "$dir/sm-old.yaml"; then
  ok "and is stamped with the new version"
else
  bad "and is stamped with the new version" "$(grep typeVersion "$dir/sm-old.yaml")"
fi
summary
