#!/usr/bin/env bash
# Harness for the smoke suite of @dataverket/cosign: a batch sources this,
# runs methods on signer models in $REPO, and counts what held.
set -u
: "${REPO:?set REPO to the scratch swamp repository}"
PASS=0; FAIL=0
OUT=$REPO/.out.json
ERR=$REPO/.err.txt

# model name, then global arguments as key=value; a model of that name from
# an earlier run is replaced, so the arguments are always the ones given.
model() {
  local name=$1; shift
  local args=()
  for kv in "$@"; do args+=(--global-arg "$kv"); done
  if (cd "$REPO" && swamp model get "$name" --json >/dev/null 2>&1); then
    (cd "$REPO" && swamp model delete "$name" --yes --force --json >/dev/null) || return 1
  fi
  (cd "$REPO" && swamp model create @dataverket/cosign/signer "$name" "${args[@]}" --json >/dev/null)
}

# model, method, then inputs as key=value or key:json=value. No call waits
# longer than 150 s.
run() {
  local name=$1 method=$2; shift 2
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  (cd "$REPO" && timeout 150 swamp model method run "$name" "$method" "${args[@]}" --json) >"$OUT" 2>"$ERR"
}

ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# The first record of the last run.
record() { jq -c '.dataArtifacts[0].attributes' "$OUT"; }

# The last run must have succeeded and the jq filter over its record hold.
holds() { # name jqfilter
  if [ "$(jq -r '.status' "$OUT" 2>/dev/null)" != "succeeded" ]; then
    bad "$1" "run failed: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  elif [ "$(record | jq -r "$2")" = "true" ]; then
    ok "$1"
  else
    bad "$1" "filter false: $(record | head -c 600)"
  fi
}

# The last run must have failed with a message that matches the pattern.
refused() { # name pattern
  if [ "$(jq -r '.status' "$OUT" 2>/dev/null)" = "succeeded" ]; then
    bad "$1" "expected a refusal, the run succeeded"
  elif cat "$OUT" "$ERR" | tr -d '\\' | grep -qiE "$2"; then
    ok "$1"
  else
    bad "$1" "message did not match /$2/: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  fi
}

summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
