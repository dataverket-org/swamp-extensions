#!/usr/bin/env bash
# identify against a registry that lies or fails, in a throwaway registry on
# this machine: forged certificates beside a real signature in the tag form;
# signatures under a tag beside bundles, which cosign does not read unless
# told to; and a rate limit, a refused login, a server error and a missing
# object on every request cosign makes while it looks for signatures. Reads
# ghcr.io, to copy one signed public image twice; writes only to that
# registry and records in $REPO.
#
#   REPO=<scratch swamp repository> REGISTRY=127.0.0.1:<port> ./hostile.sh
#
# The registry serves plain HTTP and needs no login. PROXY_PORT, 5079 when
# not set, is a free port on 127.0.0.1 for fault-proxy.py. With REGISTRY2,
# a second such registry, and PROXY_PORT2, 5075 when not set, the last
# batch runs there too: one of the two should have a referrers API of its
# own. Needs crane, python3, openssl, curl and jq, and keeps a throwaway
# key in the scratch repository's vault, `default` unless VAULT names
# another.
source "$(dirname "$0")/harness.sh"
HERE=$(cd "$(dirname "$0")" && pwd)
: "${REGISTRY:?set REGISTRY to a throwaway registry, 127.0.0.1:<port>}"
case $REGISTRY in
  127.0.0.1:*|localhost:*) ;;
  *) echo "refusing REGISTRY=$REGISTRY: only a registry on 127.0.0.1 or localhost" >&2; exit 2 ;;
esac
PROXY_PORT=${PROXY_PORT:-5079}
PROXY=127.0.0.1:$PROXY_PORT
VAULT=${VAULT:-default}

# The last run must have failed, in cosign's command and words, and must
# have recorded nothing.
failed_with() { # name pattern
  if [ "$(jq -r '.status' "$OUT" 2>/dev/null)" = "succeeded" ]; then
    bad "$1" "recorded: $(record | jq -c '{state, reason}' | head -c 200)"
  elif cat "$OUT" "$ERR" | tr -d '\\' | grep -qE "$2"; then
    ok "$1"
  else
    bad "$1" "message did not match /$2/: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  fi
}

# A. Forged certificates in the tag form. The image is a public one signed
# under a .sig tag, copied with its signature.
DIGEST=sha256:44ea51a40e4da2c0f19427df3219f29b86c8fce38539d227f6ffc2bdc944036f
IDENTITY=https://github.com/fluxcd/source-controller/.github/workflows/release.yml@refs/tags/v1.6.0
SOURCE=https://github.com/fluxcd/source-controller
VICTIM=https://github.com/victim/the-real-product0
TAGGED=$REGISTRY/smoke/hostile-tagged@$DIGEST
crane copy --insecure "ghcr.io/fluxcd/source-controller@$DIGEST" "$REGISTRY/smoke/hostile-tagged:v1.6.0" >/dev/null 2>&1 &&
  crane copy --insecure "ghcr.io/fluxcd/source-controller:${DIGEST/:/-}.sig" "$REGISTRY/smoke/hostile-tagged:${DIGEST/:/-}.sig" >/dev/null 2>&1 ||
  { bad "a signed public image copied into $REGISTRY" "crane copy failed"; summary; exit; }
crane manifest --insecure "$REGISTRY/smoke/hostile-tagged:${DIGEST/:/-}.sig" > "$REPO/.hostile-sig.json" ||
  { bad "the signature manifest as it was copied" "crane manifest failed"; summary; exit; }
forge() { python3 "$HERE/forge-tag-form.py" "$REGISTRY" smoke/hostile-tagged "$DIGEST" "$REPO/.hostile-sig.json" "$SOURCE" "$VICTIM" "$1" "$2"; }

model sm-h httpRegistry=true
forge 0 1
run sm-h identify "refs:json=[\"$TAGGED\"]"
holds "tag form, as copied: one identity, one genuine certificate" \
  ".state == \"identified\" and .certificateIdentity == \"$IDENTITY\" and .signaturesFound == 1 and .certificatesGenuine == 1"
forge 20 20
run sm-h identify "refs:json=[\"$TAGGED\"]"
holds "20 forged certificates before 20 real signatures: the real identity, 20 genuine, 20 that could not be checked" \
  ".state == \"identified\" and .certificateIdentity == \"$IDENTITY\" and .signaturesFound == 40 and .certificatesGenuine == 20 and .identities == [{certificateIdentity: \"$IDENTITY\", oidcIssuer: \"https://token.actions.githubusercontent.com\", signatures: 20}] and .reason == \"other signatures on this image: 20 that could not be checked\""
holds "and every claim recorded is one cosign printed for a signature it verified" \
  '[.signatures[] | select(.certificateGenuine) | .claims | keys == ["githubWorkflowName","githubWorkflowRef","githubWorkflowRepository","githubWorkflowSha","githubWorkflowTrigger"]] | length == 20 and all'
if grep -q 'victim' "$OUT"; then
  bad "the forged claim is nowhere in the output" "found"
else
  ok "the forged claim is nowhere in the output"
fi
forge 3 0
run sm-h identify "refs:json=[\"$TAGGED\"]"
holds "forged certificates alone: no identity, nothing genuine, not even an unproven name" \
  '.state == "unproven" and .certificateIdentity == "" and .certificatesGenuine == 0 and .signaturesFound == 3 and ([.signatures[] | .unprovenIdentity == "" and .claims == {}] | all)'
forge 0 1

# The images of the other batches, made in the registry given: one signed
# with a key as a bundle, one with a bundle and a tag-form signature, one
# with a tag-form signature and an attestation, one with an attestation
# only, and one with nothing.
image() { # registry name
  local tmp; tmp=$(mktemp -d)
  printf '%s %s\n' "$2" "$(date +%s%N)" > "$tmp/made-by-hostile-smoke"
  tar -C "$tmp" -cf "$tmp/layer.tar" made-by-hostile-smoke
  crane append --insecure --oci-empty-base -f "$tmp/layer.tar" -t "$1/smoke/hostile-$2:latest" 2>/dev/null | tail -1
  rm -rf "$tmp"
}
tag_sign() { # registry ref
  local repo=${2%@*}
  "$HERE/tag-form-sign.sh" "$1" "${repo#*/}" "${2#*@}" "$REPO/smoke-keys/ec.key"
}
mkdir -p "$REPO/smoke-keys"
if [ ! -f "$REPO/smoke-keys/ec.key" ]; then
  (cd "$REPO/smoke-keys" && COSIGN_PASSWORD='' cosign generate-key-pair --output-key-prefix k >/dev/null 2>&1) &&
    (cd "$REPO" && swamp vault put "$VAULT" smoke-cosign-key --json < smoke-keys/k.key >/dev/null 2>&1 &&
      swamp vault put "$VAULT" smoke-cosign-password "" --json >/dev/null 2>&1) ||
    { bad "a throwaway key in the vault $VAULT of the scratch repository" "cosign generate-key-pair or swamp vault put failed"; summary; exit; }
  rm -f "$REPO/smoke-keys/k.key"
  openssl ecparam -name prime256v1 -genkey -noout -out "$REPO/smoke-keys/ec.key" 2>/dev/null
fi
echo '{"made":"by the hostile smoke suite"}' > "$REPO/hostile-predicate.json"
model sm-h-signer "key=\${{ vault.get(\"$VAULT\", \"smoke-cosign-key\") }}" \
  "password=\${{ vault.get(\"$VAULT\", \"smoke-cosign-password\") }}" httpRegistry=true
make_images() { # registry
  BUNDLED=$(image "$1" bundled); BOTH=$(image "$1" both); UNSIGNED=$(image "$1" unsigned)
  TAGATT=$(image "$1" tagatt); ATTONLY=$(image "$1" attonly)
  case "$BUNDLED$BOTH$UNSIGNED$TAGATT$ATTONLY" in
    *@sha256:*@sha256:*@sha256:*@sha256:*@sha256:*) ;;
    *) bad "five images made in $1" "crane append gave: $BUNDLED $BOTH $UNSIGNED $TAGATT $ATTONLY"; return 1 ;;
  esac
  run sm-h-signer sign "refs:json=[\"$BUNDLED\",\"$BOTH\"]"
  holds "$1: two images signed with a key through the model" '.uploaded == true'
  tag_sign "$1" "$BOTH" && tag_sign "$1" "$TAGATT" ||
    { bad "$1: two images signed in the tag form" "tag-form-sign.sh failed"; return 1; }
  run sm-h-signer attest "refs:json=[\"$TAGATT\",\"$ATTONLY\"]" predicate=hostile-predicate.json
  holds "$1: two images attested with a key through the model" '.uploaded == true'
}
make_images "$REGISTRY" || { summary; exit; }

# B. A tag-form signature beside bundles. cosign reads bundles only once an
# image has one, also when that one is an attestation.
ATTESTED=$REGISTRY/smoke/hostile-attested@$DIGEST
crane copy --insecure "ghcr.io/fluxcd/source-controller@$DIGEST" "$REGISTRY/smoke/hostile-attested:v1.6.0" >/dev/null 2>&1 &&
  crane copy --insecure "ghcr.io/fluxcd/source-controller:${DIGEST/:/-}.sig" "$REGISTRY/smoke/hostile-attested:${DIGEST/:/-}.sig" >/dev/null 2>&1 ||
  { bad "a second copy of the signed public image" "crane copy failed"; summary; exit; }
run sm-h-signer attest "refs:json=[\"$ATTESTED\"]" predicate=hostile-predicate.json
holds "an attestation added, as a bundle, to an image signed keyless under a .sig tag" '.uploaded == true'
run sm-h identify "refs:json=[\"$ATTESTED\"]"
holds "signed under a tag, attested later as a bundle: still identified, from the tag" \
  ".state == \"identified\" and .certificateIdentity == \"$IDENTITY\" and .forms == [\"tag\"] and .otherStatements >= 1 and .tagSignaturesUnlisted == true and .signatures[0].certificateGenuine == true"
holds "and its five claims are the ones cosign confirmed of the certificate" \
  '.signatures[0].claims == {githubWorkflowTrigger: "push", githubWorkflowSha: "83cb98615d31294f19766cb08e649635503bf951", githubWorkflowName: "release", githubWorkflowRepository: "fluxcd/source-controller", githubWorkflowRef: "refs/tags/v1.6.0"}'
run sm-h identify "refs:json=[\"$TAGATT\"]"
holds "a key's signature under a tag beside an attestation: not unsigned, and said to be there" \
  '.state == "unproven" and .tagSignaturesUnlisted == true and .signaturesFound == 1 and .otherStatements == 1 and .signatures[0].form == "tag" and (.reason | contains("signatures are stored under the tag beside the bundles"))'
run sm-h identify "refs:json=[\"$BOTH\"]"
holds "a bundle signature and signatures under the tag: both are in the record" \
  '.tagSignaturesUnlisted == true and .forms == ["bundle", "tag"] and .keySigned == 1 and .signaturesFound == 2'
run sm-h identify "refs:json=[\"$BUNDLED\"]"
holds "a bundle signature and nothing under the tag: nothing is unlisted" \
  '.state == "key-signed" and .tagSignaturesUnlisted == false and .forms == ["bundle"]'
run sm-h identify "refs:json=[\"$ATTONLY\"]"
holds "an attestation and no signature anywhere: unsigned, with the attestation counted" \
  '.state == "unsigned" and .otherStatements == 1 and .tagSignaturesUnlisted == false'

# C. Faults while cosign looks for signatures, through a proxy.
RULES=$REPO/.fault-rules
REQUESTS=$REPO/.fault-requests
: > "$RULES"
PROXY_PIDS=
trap 'kill $PROXY_PIDS 2>/dev/null' EXIT
proxy() { # registry port
  python3 "$HERE/fault-proxy.py" "$1" "$2" "$RULES" "$REQUESTS" >/dev/null 2>&1 &
  PROXY_PIDS="$PROXY_PIDS $!"
  for _ in 1 2 3 4 5 6 7 8 9 10; do
    crane catalog --insecure "127.0.0.1:$2" >/dev/null 2>&1 && return
    sleep 0.5
  done
}
proxy "$REGISTRY" "$PROXY_PORT"
through() { printf '%s' "${1/$REGISTRY/$PROXY}"; }

run sm-h identify "refs:json=[\"$(through "$BUNDLED")\"]"
holds "through the proxy, no fault: the bundle is read" '.state == "key-signed" and .forms == ["bundle"]'
run sm-h identify "refs:json=[\"$(through "$UNSIGNED")\"]"
holds "through the proxy, no fault: an image with nothing is unsigned" '.state == "unsigned" and .reason == "no signature found"'

# The lookup of the bundles: the referrers API, then the fallback tag.
for rule in '/referrers/ 429' 'manifests/sha256-[0-9a-f]{64}$ 401' '/referrers/ 500'; do
  printf '%s\n' "$rule" > "$RULES"
  for named in "bundled $BUNDLED" "both $BOTH" "tagged $TAGGED" "unsigned $UNSIGNED"; do
    run sm-h identify "refs:json=[\"$(through "${named#* }")\"]"
    failed_with "[$rule] ${named%% *}: the run fails and records nothing, it is not called unsigned or read from the tag" \
      'cosign tree .*exited 1.*(TOOMANYREQUESTS|UNAUTHORIZED|UNKNOWN)'
  done
done
# The lookup of the tag form, which is asked for beside bundles too.
printf '%s\n' '\.sig$ 429' > "$RULES"
for named in "tagged $TAGGED" "unsigned $UNSIGNED"; do
  run sm-h identify "refs:json=[\"$(through "${named#* }")\"]"
  failed_with "[.sig 429] ${named%% *}: the run fails and records nothing" \
    'cosign download signature .*exited 1.*TOOMANYREQUESTS'
done
run sm-h identify "refs:json=[\"$(through "$BUNDLED")\"]"
failed_with "[.sig 429] bundled: the tag form beside the bundle cannot be asked for, so the run fails" \
  'cosign verify --new-bundle-format=false .*TOOMANYREQUESTS'
: > "$RULES"
run sm-h identify "refs:json=[\"$(through "$TAGGED")\"]"
holds "the fault gone: the tagged image is identified again" ".state == \"identified\" and .certificateIdentity == \"$IDENTITY\""

# The manifest of the one signature bundle, with the list of bundles
# answering as it should: cosign download signature says "no signatures",
# and cosign tree exits 0 after printing the error.
: > "$REQUESTS"
run sm-h identify "refs:json=[\"$(through "$BUNDLED")\"]"
ARTIFACT=$(awk '{print $2}' "$REQUESTS" | grep "/manifests/sha256:" | grep -v "${BUNDLED#*@}" | sort -u | head -n 1)
for code in 429 401 404; do
  printf '^%s$ %s\n' "$(printf '%s' "$ARTIFACT" | sed 's/[.]/\\./g')" "$code" > "$RULES"
  run sm-h identify "refs:json=[\"$(through "$BUNDLED")\"]"
  failed_with "[$code on the signature bundle's own manifest] the run fails: a bundle that is listed and cannot be read is not 'unsigned'" \
    'cosign tree|Error fetching artifact'
done
: > "$RULES"

# D. Every request identify makes for an image, failed one at a time. With
# 401 the run must fail or record exactly what it records with no fault.
# With 404 on a manifest or a blob that is named by digest, which the
# registry itself listed, the run must fail.
recorded() {
  if [ "$(jq -r '.status' "$OUT" 2>/dev/null)" = "succeeded" ]; then
    jq -c '.dataArtifacts[0].attributes | del(.identifiedAt)' "$OUT"
  else
    echo FAILED
  fi
}
every_request() { # name, reference through the proxy
  local name=$1 ref=$2 digest=${2#*@} base paths path codes code got count=0 wrong=0 detail=
  : > "$RULES"; : > "$REQUESTS"
  run sm-h identify "refs:json=[\"$ref\"]"; base=$(recorded)
  if [ "$base" = FAILED ]; then bad "$name: identified with no fault" "$(tail -c 300 "$OUT")"; return; fi
  paths=$(awk '{print $2}' "$REQUESTS" | grep -v '^/v2/$' | sort -u)
  for path in $paths; do
    codes=401
    case $path in
      */manifests/"$digest") ;;
      */manifests/sha256:*|*/blobs/*) codes="401 404" ;;
    esac
    for code in $codes; do
      printf '^%s$ %s\n' "$(printf '%s' "$path" | sed 's/[][\.*^$()+?{|]/\\&/g')" "$code" > "$RULES"
      run sm-h identify "refs:json=[\"$ref\"]"; got=$(recorded); count=$((count+1))
      if [ "$got" = FAILED ]; then continue; fi
      if [ "$got" = "$base" ] && [ "$code" != 404 ]; then continue; fi
      wrong=$((wrong+1)); detail="$code on ${path##*/v2/} gave $(printf '%s' "$got" | jq -c '{state, reason}' | head -c 200)"
    done
  done
  : > "$RULES"
  if [ "$wrong" -eq 0 ] && [ "$count" -gt 0 ]; then
    ok "$name: $count faults, one request at a time; each fails the run or changes nothing"
  else
    bad "$name: $wrong of $count faults were recorded as something else" "$detail"
  fi
}
sweep() { # label, then the images as they are reached through a proxy
  local label=$1; shift
  for named in "$@"; do every_request "$label ${named%% *}" "${named#* }"; done
}
sweep "$REGISTRY" "bundled $(through "$BUNDLED")" "both $(through "$BOTH")" "tagged $(through "$TAGGED")" \
  "attested $(through "$ATTESTED")" "tagatt $(through "$TAGATT")" "attonly $(through "$ATTONLY")" "unsigned $(through "$UNSIGNED")"

# E. What stands beside an image under a label. cosign tree names a
# referrer by a label its writer chose; only a registry with a referrers
# API of its own lists what referrer.py adds.
labels() { # registry
  local repo digest artifact odd
  odd=$(image "$1" odd) || return
  repo=${odd%@*}; repo=${repo#*/}; digest=${odd#*@}
  if [ "$(curl -s -o /dev/null -w '%{http_code}' "http://$1/v2/$repo/referrers/$digest")" != 200 ]; then
    printf 'SKIP  %s has no referrers API: batch E needs one\n' "$1"; return
  fi
  for type in doc/example x-custom/thing application/vnd.example.thing+json; do
    python3 "$HERE/referrer.py" add "$1" "$repo" "$digest" "$type" >/dev/null ||
      { bad "$1: an artifact of type $type beside an image" "referrer.py failed"; return; }
  done
  run sm-h identify "refs:json=[\"$odd\"]"
  holds "$1: three artifacts of other kinds beside an unsigned image, one of a type nobody registered: unsigned, and left alone" \
    '.state == "unsigned" and .reason == "no signature found" and .otherStatements == 0'
  # An attestation whose label says it is a signature, as a real cosign wrote one.
  repo=${ATTONLY%@*}; repo=${repo#*/}
  artifact=$(cosign tree --allow-http-registry "$ATTONLY" 2>/dev/null | sed -n 's/.* artifacts via OCI referrer: .*@\(sha256:[0-9a-f]*\)$/\1/p' | head -n 1)
  python3 "$HERE/referrer.py" relabel "$1" "$repo" "$artifact" https://sigstore.dev/cosign/sign/v1 >/dev/null ||
    { bad "$1: an attestation labelled as a signature" "referrer.py failed"; return; }
  run sm-h identify "refs:json=[\"$ATTONLY\"]"
  holds "$1: an attestation labelled as a signature is still an attestation: unsigned, two statements, no failure" \
    '.state == "unsigned" and .signaturesFound == 0 and .otherStatements == 2'
  # A signature whose label says it is something else.
  repo=${BUNDLED%@*}; repo=${repo#*/}
  artifact=$(cosign tree --allow-http-registry "$BUNDLED" 2>/dev/null | sed -n 's/.* artifacts via OCI referrer: .*@\(sha256:[0-9a-f]*\)$/\1/p' | head -n 1)
  python3 "$HERE/referrer.py" relabel "$1" "$repo" "$artifact" https://slsa.dev/provenance/v1 >/dev/null ||
    { bad "$1: a signature labelled as an attestation" "referrer.py failed"; return; }
  run sm-h identify "refs:json=[\"$BUNDLED\"]"
  holds "$1: a signature labelled as an attestation is still a signature" \
    '.state == "key-signed" and .signaturesFound == 2 and .otherStatements == 0'
}

# The same on a second registry, when one is given: REGISTRY2, with
# PROXY_PORT2 for its proxy. One with a referrers API of its own shows the
# other way cosign finds bundles.
if [ -n "${REGISTRY2:-}" ]; then
  case $REGISTRY2 in
    127.0.0.1:*|localhost:*) ;;
    *) echo "refusing REGISTRY2=$REGISTRY2: only a registry on 127.0.0.1 or localhost" >&2; exit 2 ;;
  esac
  PROXY2=127.0.0.1:${PROXY_PORT2:-5075}
  if make_images "$REGISTRY2"; then
    proxy "$REGISTRY2" "${PROXY_PORT2:-5075}"
    through2() { printf '%s' "${1/$REGISTRY2/$PROXY2}"; }
    sweep "$REGISTRY2" "bundled $(through2 "$BUNDLED")" "both $(through2 "$BOTH")" "tagatt $(through2 "$TAGATT")" \
      "attonly $(through2 "$ATTONLY")" "unsigned $(through2 "$UNSIGNED")"
    labels "$REGISTRY2"
  fi
else
  printf 'SKIP  a second registry: set REGISTRY2=127.0.0.1:<port> to run batch D there too\n'
fi
summary
