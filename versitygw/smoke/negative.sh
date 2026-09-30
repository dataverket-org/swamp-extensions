#!/usr/bin/env bash
# Harness for the negative suite of @dataverket/versitygw: each batch sources
# this, runs model methods in $REPO, and counts what held.
set -u
PASS=0; FAIL=0
OUT=${REPO:-.}/.out.json
ERR=${REPO:-.}/.err.txt
# Everything secret the throwaway gateways hold; none of it may surface.
SECRETS='FIXTURE-SECRET|fixturerootsecret0000'

run() { # model method k=v...
  local model=$1 method=$2; shift 2
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  (cd "${REPO:-.}" && swamp model method run "$model" "$method" "${args[@]}" --json) >"$OUT" 2>"$ERR"
}

ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# The run must fail, its message must match the pattern, and carry no secret.
refuses() { # name pattern model method args...
  local name=$1 pattern=$2; shift 2
  if run "$@"; then
    bad "$name" "expected a refusal, the run succeeded"
  elif grep -qE "$SECRETS" "$OUT" "$ERR"; then
    bad "$name" "the refusal carried a secret"
  elif tr -d '\\' < "$ERR" | grep -qiE "$pattern"; then
    ok "$name"
  else
    bad "$name" "message did not match /$pattern/: $(tr -d '\n' < "$ERR" | tail -c 300)"
  fi
}

# The run must succeed, carry no secret, and the jq filter over its output hold.
holds() { # name jqfilter model method args...
  local name=$1 filter=$2; shift 2
  if ! run "$@"; then
    bad "$name" "run failed: $(tr -d '\n' < "$ERR" | tail -c 300)"
  elif grep -qE "$SECRETS" "$OUT" "$ERR"; then
    bad "$name" "the output carried a secret"
  elif [ "$(jq -r "$filter" "$OUT")" = "true" ]; then
    ok "$name"
  else
    bad "$name" "filter false: $(jq -c '[.dataArtifacts[]? | {name, attributes}]' "$OUT" | head -c 400)"
  fi
}

# The artifact of that name in the last run's output.
artifact() { jq -c --arg n "$1" '.dataArtifacts[] | select(.name == $n) | .attributes' "$OUT"; }

summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
