#!/usr/bin/env bash
# Harness for the smoke suite of @dataverket/http: each batch sources this,
# runs `health` on models in $REPO, and counts what held.
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
  (cd "$REPO" && swamp model create @dataverket/http/endpoint "$name" "${args[@]}" --json >/dev/null)
}

run() { (cd "$REPO" && swamp model method run "$1" health --json) >"$OUT" 2>"$ERR"; }

ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# The health record of the last run.
record() { jq -c '.dataArtifacts[] | select(.name == "health") | .attributes' "$OUT"; }

# The run must succeed and the jq filter over its health record hold.
holds() { # name jqfilter model
  local name=$1 filter=$2 model=$3
  if ! run "$model"; then
    bad "$name" "run failed: $(tr -d '\n' < "$ERR" | tail -c 300)"
  elif [ "$(record | jq -r "$filter")" = "true" ]; then
    ok "$name"
  else
    bad "$name" "filter false: $(record | head -c 500)"
  fi
}

# The run must fail and its message match the pattern.
refuses() { # name pattern model
  local name=$1 pattern=$2 model=$3
  if run "$model"; then
    bad "$name" "expected a refusal, the run succeeded"
  elif cat "$OUT" "$ERR" | tr -d '\\' | grep -qiE "$pattern"; then
    ok "$name"
  else
    bad "$name" "message did not match /$pattern/: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  fi
}

# Nothing the last run printed or recorded may hold the pattern.
silent() { # name pattern
  if cat "$OUT" "$ERR" | grep -qE "$2"; then bad "$1" "the output holds /$2/"; else ok "$1"; fi
}

summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
