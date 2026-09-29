#!/usr/bin/env bash
# Negative-path suite for @dataverket/zitadel against the throwaway instance.
set -u
PASS=0; FAIL=0
OUT=${REPO:-.}/.out.json
ERR=${REPO:-.}/.err.txt

run() { # model method k=v...
  local model=$1 method=$2; shift 2
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  swamp model method run "$model" "$method" "${args[@]}" --json >"$OUT" 2>"$ERR"
  return $?
}

ok()   { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad()  { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# The run must fail, and the message must match the pattern.
refuses() { # name pattern model method args...
  local name=$1 pattern=$2; shift 2
  if run "$@"; then
    bad "$name" "expected a refusal, the run succeeded"
  else
    local msg; msg=$(tr -d '\n' < "$ERR" | sed 's/  */ /g' | tail -c 400)
    # the CLI reports the message as JSON, so unescape before matching
    if tr -d '\\\\' < "$ERR" | grep -qiE "$pattern"; then ok "$name"; else bad "$name" "message did not match /$pattern/: $msg"; fi
  fi
}

# The run must fail, and the message must NOT contain this text.
hides() { # name text model method args...
  local name=$1 text=$2; shift 2
  if run "$@"; then
    bad "$name" "expected a refusal, the run succeeded"
  elif grep -qF "$text" "$ERR"; then
    bad "$name" "the error carried '$text'"
  else
    ok "$name"
  fi
}

# The run must succeed and the named artifact must carry this action.
# (a method run reports every artifact of the model, so the artifact is named)
acts() { # name action artifact-prefix model method args...
  local name=$1 want=$2 prefix=$3; shift 3
  if run "$@"; then
    local got; got=$(jq -r --arg p "$prefix" '[.dataArtifacts[] | select(.name | startswith($p)) | .attributes.action] | last // "none"' "$OUT")
    if [ "$got" = "$want" ]; then ok "$name"; else bad "$name" "action of $prefix* was '$got', wanted '$want'"; fi
  else
    bad "$name" "run failed: $(tail -c 300 "$ERR" | tr -d '\n')"
  fi
}

# The run must succeed and the jq filter over dataArtifacts must be true.
holds() { # name jqfilter model method args...
  local name=$1 filter=$2; shift 2
  if run "$@"; then
    if [ "$(jq -r "$filter" "$OUT")" = "true" ]; then ok "$name"; else bad "$name" "filter false: $(jq -c '[.dataArtifacts[].attributes]' "$OUT" | head -c 300)"; fi
  else
    bad "$name" "run failed: $(tail -c 300 "$ERR" | tr -d '\n')"
  fi
}

summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
