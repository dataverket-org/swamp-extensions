#!/usr/bin/env bash
# identify against public images, read-only: who signed an image kept as a
# Sigstore bundle, one kept under a `.sig` tag, one with no signature and
# one that is not there; then verify against the identity that was found.
# After that, what swamp model validate says for a signer with no key, and
# that sign, attest and signBlob still refuse one. Reads ghcr.io, quay.io
# and the public Sigstore instance; writes records in $REPO.
#
#   REPO=<scratch swamp repository> ./identify.sh
#
# With REGISTRY=127.0.0.1:<port>, a throwaway registry over plain HTTP that
# needs no login, it also signs two images it makes there with a key, in
# both storage forms, and reads those. That part needs crane, openssl and
# curl, writes only to that registry, and keeps a throwaway key in the
# scratch repository's vault, `default` unless VAULT names another.
source "$(dirname "$0")/harness.sh"
HERE=$(cd "$(dirname "$0")" && pwd)
ISSUER=https://token.actions.githubusercontent.com

# swamp model validate for a model, with more flags; the outcome is in $OUT.
validate() {
  local name=$1; shift
  (cd "$REPO" && timeout 150 swamp model validate "$name" "$@" --json) >"$OUT" 2>"$ERR"
}
# One check of the last validate must have the outcome given.
check_is() { # name check true|false
  if [ "$(jq -r --arg c "Check: $2" '.validations[] | select(.name == $c) | .passed' "$OUT" 2>/dev/null)" = "$3" ]; then
    ok "$1"
  else
    bad "$1" "$(jq -c '.validations' "$OUT" 2>/dev/null | head -c 400)"
  fi
}

# A. A signature kept as a Sigstore bundle, by a definition with nothing set.
BUNDLE=ghcr.io/renovatebot/renovate@sha256:c30c21d917b25cee1103fe8585bbc67bdb0a8792067237eae8d6734e83b4d485
BUNDLE_IDENTITY=https://github.com/renovatebot/renovate/.github/workflows/build.yml@refs/heads/main

model sm-id
run sm-id identify "refs:json=[\"$BUNDLE\"]"
holds "bundle form: one identity, with its issuer, from a definition with no key and no identity" \
  ".state == \"identified\" and .certificateIdentity == \"$BUNDLE_IDENTITY\" and .oidcIssuer == \"$ISSUER\" and .identities == [{certificateIdentity: \"$BUNDLE_IDENTITY\", oidcIssuer: \"$ISSUER\", signatures: 1}] and .reason == \"\""
holds "bundle form: the record says no identity was expected, and counts what it found" \
  '.identityChecked == false and .signaturesFound == 1 and .certificatesGenuine == 1 and .keySigned == 0 and .forms == ["bundle"] and (has("verified") | not)'
holds "bundle form: the provenance stored the same way is not taken for a signature" \
  '.otherStatements >= 1'
holds "bundle form: the certificate's further claims are recorded, also one this version has no name for" \
  '.signatures[0] | .certificateGenuine == true and .signedWith == "certificate" and .withheld == 0 and .claims.sourceRepositoryUri == "https://github.com/renovatebot/renovate" and .claims.sourceRepositoryRef == "refs/heads/main" and .claims.githubWorkflowSha == "a42552e6c9739a9d577f86dd819e9d41aee7c059" and .claims.buildTrigger == "push" and .claims.runnerEnvironment == "github-hosted" and (.claims | keys | any(startswith("1.3.6.1.4.1.57264.1.")))'
if [ "$(jq -r '.dataArtifacts[0].name' "$OUT")" = "identification-ghcr.io-renovatebot-renovate-c30c21d917b2" ]; then
  ok "the record is named as a verification is: identification-<repository>-<digest>"
else
  bad "the record is named as a verification is" "$(jq -r '.dataArtifacts[0].name' "$OUT")"
fi

# Find the identity, then verify against it: the record's two fields are
# the two arguments.
FOUND_IDENTITY=$(record | jq -r .certificateIdentity)
FOUND_ISSUER=$(record | jq -r .oidcIssuer)
model sm-id-verify "certificateIdentity=$FOUND_IDENTITY" "oidcIssuer=$FOUND_ISSUER" tlog=true
run sm-id-verify verify "refs:json=[\"$BUNDLE\"]"
holds "what identify recorded, given to verify as it is, verifies the image" \
  ".verified == true and .verifyMode == \"keyless\" and .certificateIdentity == \"$BUNDLE_IDENTITY\""

# B. A signature kept under a .sig tag, the older form.
TAGGED=ghcr.io/fluxcd/source-controller@sha256:44ea51a40e4da2c0f19427df3219f29b86c8fce38539d227f6ffc2bdc944036f
TAGGED_IDENTITY=https://github.com/fluxcd/source-controller/.github/workflows/release.yml@refs/tags/v1.6.0
run sm-id identify "refs:json=[\"$TAGGED\"]"
holds "tag form: one identity, with its issuer and the five claims cosign prints, and no other" \
  ".state == \"identified\" and .forms == [\"tag\"] and .certificateIdentity == \"$TAGGED_IDENTITY\" and .oidcIssuer == \"$ISSUER\" and .signatures[0].certificateGenuine == true and .signatures[0].claims == {githubWorkflowTrigger: \"push\", githubWorkflowSha: \"83cb98615d31294f19766cb08e649635503bf951\", githubWorkflowName: \"release\", githubWorkflowRepository: \"fluxcd/source-controller\", githubWorkflowRef: \"refs/tags/v1.6.0\"}"

# C. No signature, and no image: both are records, and neither names anyone.
UNSIGNED=quay.io/coreos/etcd@sha256:28759af54acd6924b2191dc1a1d096e2fa2e219717a21b9d8edf89717db3631b
run sm-id identify "refs:json=[\"$UNSIGNED\"]"
holds "an image with no signature is a record with a reason, not a failed run" \
  '.state == "unsigned" and .reason == "no signature found" and .certificateIdentity == "" and .oidcIssuer == "" and .signaturesFound == 0 and .signatures == [] and .identityChecked == false'
MISSING=ghcr.io/renovatebot/renovate@sha256:0000000000000000000000000000000000000000000000000000000000000000
run sm-id identify "refs:json=[\"$MISSING\"]"
holds "a digest the registry does not have is a record too, and is not called unsigned" \
  '.state == "not-found" and (.reason | contains("MANIFEST_UNKNOWN")) and .certificateIdentity == ""'
run sm-id identify "refs:json=[\"$BUNDLE\",\"$UNSIGNED\"]"
if [ "$(jq -c '[.dataArtifacts[].attributes.state]' "$OUT" 2>/dev/null)" = '["identified","unsigned"]' ]; then
  ok "two references in one run give two records, in order"
else
  bad "two references in one run give two records, in order" "$(jq -c '[.dataArtifacts[].attributes.state]' "$OUT" 2>&1 | head -c 300)"
fi
run sm-id identify 'refs:json=["ghcr.io/renovatebot/renovate:44.226.2"]'
refused "a tag is refused before cosign runs" 'not an image reference pinned by digest'
run sm-id identify "refs:json=[\"--allow-http-registry@${BUNDLE#*@}\"]"
refused "a reference shaped like a flag is refused, not handed to cosign" 'not an image reference pinned by digest'
model sm-id-nobin cosignBinary=cosign-that-is-not-installed
run sm-id-nobin identify "refs:json=[\"$BUNDLE\"]"
refused "a cosign that is not installed is said so by the method, since no check runs before a read" 'could not be run.*install cosign'

# D. A definition written by 2026.11.10.1, with every argument it had.
dir=$REPO/models/@dataverket/cosign/signer
mkdir -p "$dir"
cat > "$dir/sm-id-old.yaml" <<YAML
type: '@dataverket/cosign/signer'
typeVersion: 2026.11.10.1
id: $(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)
name: sm-id-old
version: 1
tags: {}
globalArguments:
  key: ''
  password: ''
  publicKey: ''
  certificateIdentity: '$BUNDLE_IDENTITY'
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
validate sm-id-old
if [ "$(jq -r .passed "$OUT" 2>/dev/null)" = "true" ]; then
  ok "a definition of 2026.11.10.1 that only verifies passes validate"
else
  bad "a definition of 2026.11.10.1 that only verifies passes validate" "$(head -c 400 "$OUT")"
fi
run sm-id-old verify "refs:json=[\"$BUNDLE\"]"
holds "and verifies as before" '.verified == true and .verifyMode == "keyless"'
run sm-id-old identify "refs:json=[\"$BUNDLE\"]"
holds "and identify on it ignores the identity it is configured with: none is expected" \
  ".state == \"identified\" and .identityChecked == false and .certificateIdentity == \"$BUNDLE_IDENTITY\""
if grep -q '^typeVersion: 2026.11.10.2' "$dir/sm-id-old.yaml"; then
  ok "and is stamped with the new version"
else
  bad "and is stamped with the new version" "$(grep typeVersion "$dir/sm-id-old.yaml")"
fi

# E. validate on a signer with no key, and the signing methods on it. The
# reference names a host that cannot exist, so nothing could be signed
# even if a refusal were missing.
NOWHERE=registry.invalid/team/api@${BUNDLE#*@}
validate sm-id
if [ "$(jq -r '.passed' "$OUT" 2>/dev/null)" = "true" ]; then
  ok "validate passes on a definition with no key: every check passes"
else
  bad "validate passes on a definition with no key" "$(jq -c '.validations' "$OUT" 2>/dev/null | head -c 400)"
fi
check_is "validate: key-usable passes, an empty key is a signer that only verifies" key-usable true
check_is "validate: cosign-installed still runs" cosign-installed true
for method in sign attest signBlob; do
  validate sm-id --method "$method"
  check_is "validate --method $method: key-usable fails on the empty key" key-usable false
  if jq -r '.validations[] | select(.name == "Check: key-usable") | .error' "$OUT" | grep -q 'key is empty: nothing to sign with'; then
    ok "validate --method $method: and says why"
  else
    bad "validate --method $method: and says why" "$(jq -c '.validations' "$OUT" | head -c 300)"
  fi
done
validate sm-id --method verify
check_is "validate --method verify: key-usable does not apply" key-usable ""
echo '{"built":"by the smoke suite"}' > "$REPO/smoke-predicate.json"
echo 'a file to sign' > "$REPO/smoke-blob.txt"
rm -f "$REPO/smoke-blob.txt.sigstore.json"
# The last run must have been stopped by the key-usable check, and not by
# the method's own refusal, whose message ends otherwise.
stopped_by_check() { # name
  local all; all=$(cat "$OUT" "$ERR" | tr -d '\\')
  if [ "$(jq -r '.status' "$OUT" 2>/dev/null)" = "succeeded" ]; then
    bad "$1" "expected a refusal, the run succeeded"
  elif printf '%s' "$all" | grep -q 'this signer can only verify'; then
    bad "$1" "the method refused, so the check did not stop the run"
  elif printf '%s' "$all" | grep -q 'Pre-flight checks failed' &&
    printf '%s' "$all" | grep -q 'key-usable' &&
    printf '%s' "$all" | grep -q 'key is empty: nothing to sign with'; then
    ok "$1"
  else
    bad "$1" "not the check's refusal: $(printf '%s' "$all" | tr -d '\n' | tail -c 300)"
  fi
}
run sm-id sign "refs:json=[\"$NOWHERE\"]"
stopped_by_check "sign with an empty key is stopped by the check, before anything is signed"
run sm-id attest "refs:json=[\"$NOWHERE\"]" predicate=smoke-predicate.json
stopped_by_check "attest with an empty key is stopped by the check"
run sm-id signBlob path=smoke-blob.txt
stopped_by_check "signBlob with an empty key is stopped by the check"
# With every check skipped, each method still refuses by itself.
skipping() { # method, inputs
  local method=$1; shift
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  (cd "$REPO" && timeout 150 swamp model method run sm-id "$method" "${args[@]}" --skip-checks --json) >"$OUT" 2>"$ERR"
}
skipping sign "refs:json=[\"$NOWHERE\"]"
refused "sign with the checks skipped refuses the empty key itself" 'key is empty: nothing to sign with; this signer can only verify'
skipping attest "refs:json=[\"$NOWHERE\"]" predicate=smoke-predicate.json
refused "attest with the checks skipped refuses the empty key itself" 'key is empty: nothing to sign with; this signer can only verify'
skipping signBlob path=smoke-blob.txt
refused "signBlob with the checks skipped refuses the empty key itself" 'key is empty: nothing to sign with; this signer can only verify'
if [ -e "$REPO/smoke-blob.txt.sigstore.json" ]; then
  bad "no bundle was written beside the file" "found one"
else
  ok "no bundle was written beside the file"
fi

# F. Signatures made with a key, in a throwaway registry on this machine.
if [ -z "${REGISTRY:-}" ]; then
  printf 'SKIP  key-signed images: set REGISTRY=127.0.0.1:<port> to run them\n'
  summary; exit
fi
case $REGISTRY in
  127.0.0.1:*|localhost:*) ;;
  *) echo "refusing REGISTRY=$REGISTRY: only a registry on 127.0.0.1 or localhost" >&2; exit 2 ;;
esac
# A new image of a few bytes, so no earlier run has signed it; prints its reference by digest.
image() {
  local tmp; tmp=$(mktemp -d)
  printf '%s %s\n' "$1" "$(date +%s%N)" > "$tmp/made-by-identify-smoke"
  tar -C "$tmp" -cf "$tmp/layer.tar" made-by-identify-smoke
  crane append --insecure -f "$tmp/layer.tar" -t "$REGISTRY/smoke/identify-$1:latest" 2>/dev/null | tail -1
  rm -rf "$tmp"
}
ONE=$(image one); TWO=$(image two)
case "$ONE$TWO" in
  *@sha256:*@sha256:*) ;;
  *) bad "two images made in $REGISTRY" "crane append gave: $ONE $TWO"; summary; exit ;;
esac
# Two throwaway keys: one cosign makes, kept in the scratch repository's own
# vault as swamp wants a key kept, and an EC key for the tag form.
VAULT=${VAULT:-default}
mkdir -p "$REPO/smoke-keys"
if [ ! -f "$REPO/smoke-keys/ec.key" ]; then
  (cd "$REPO/smoke-keys" && COSIGN_PASSWORD='' cosign generate-key-pair --output-key-prefix k >/dev/null 2>&1) &&
    (cd "$REPO" && swamp vault put "$VAULT" smoke-cosign-key --json < smoke-keys/k.key >/dev/null 2>&1 &&
      swamp vault put "$VAULT" smoke-cosign-password "" --json >/dev/null 2>&1) ||
    { bad "a throwaway key in the vault $VAULT of the scratch repository" "cosign generate-key-pair or swamp vault put failed"; summary; exit; }
  rm -f "$REPO/smoke-keys/k.key"
  openssl ecparam -name prime256v1 -genkey -noout -out "$REPO/smoke-keys/ec.key" 2>/dev/null
fi

model sm-id-local httpRegistry=true
run sm-id-local identify "refs:json=[\"$ONE\"]"
holds "local: a new image has no signature" '.state == "unsigned"'
run sm-id-local sign "refs:json=[\"$ONE\"]"
stopped_by_check "local: sign with an empty key is stopped by the check"
run sm-id-local identify "refs:json=[\"$ONE\"]"
holds "local: and the image is still unsigned after the refusal" '.state == "unsigned" and .signaturesFound == 0'

model sm-id-signer "key=\${{ vault.get(\"$VAULT\", \"smoke-cosign-key\") }}" \
  "password=\${{ vault.get(\"$VAULT\", \"smoke-cosign-password\") }}" httpRegistry=true
run sm-id-signer describe
FINGERPRINT=$(record | jq -r .fingerprint)
run sm-id-signer sign "refs:json=[\"$ONE\"]"
holds "local: signed with a key through the model" '.uploaded == true'
run sm-id-local identify "refs:json=[\"$ONE\"]"
holds "local, bundle form: a key's signature is recorded as key-signed, with a reason and no identity" \
  '.state == "key-signed" and (.reason | startswith("made with a key")) and (.reason | contains("nothing here says which key")) and .certificateIdentity == "" and .oidcIssuer == "" and .identities == [] and .keySigned == 1 and .certificatesGenuine == 0 and .forms == ["bundle"] and .signatures[0].signedWith == "key" and .identityChecked == false'
holds "local, bundle form: the bundle names its key by the fingerprint describe records, under a name that says it is not proven" \
  ".signatures[0].unprovenKeyFingerprint == \"$FINGERPRINT\" and (.signatures[0] | has(\"publicKeyFingerprint\") | not) and (\"$FINGERPRINT\" | startswith(\"sha256:\"))"

repo_of() { local r=${1%@*}; printf '%s' "${r#*/}"; }
"$HERE/tag-form-sign.sh" "$REGISTRY" "$(repo_of "$TWO")" "${TWO#*@}" "$REPO/smoke-keys/ec.key"
run sm-id-local identify "refs:json=[\"$TWO\"]"
holds "local, tag form: a key's signature is recorded as key-signed" \
  '.state == "key-signed" and .keySigned == 1 and .forms == ["tag"] and .signatures[0].signedWith == "key" and .signatures[0].unprovenKeyFingerprint == "" and .certificateIdentity == ""'
"$HERE/tag-form-sign.sh" "$REGISTRY" "$(repo_of "$ONE")" "${ONE#*@}" "$REPO/smoke-keys/ec.key"
run sm-id-local identify "refs:json=[\"$ONE\"]"
holds "local, both forms on one image: the bundle is read, and the record says there are signatures under the tag too" \
  '.tagSignaturesUnlisted == true and .signaturesFound == 2 and .keySigned == 1 and .forms == ["bundle", "tag"]'
summary
