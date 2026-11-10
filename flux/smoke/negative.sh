#!/usr/bin/env bash
# Harness for the smoke and negative suite of @dataverket/flux: each batch
# sources this, runs model methods in $REPO, and counts what held.
set -u
: "${REPO:?set REPO to the swamp repository models.sh filled}"
PASS=0; FAIL=0
OUT=$REPO/.out.json
ERR=$REPO/.err.txt
WORK=${SMOKE_WORK:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.work}
# The one secret of the run: the reader's token. It may surface nowhere.
TOKEN=$(kubectl --kubeconfig "$WORK/reader.kubeconfig" config view --raw \
  -o jsonpath='{.users[?(@.name=="smoke-reader")].user.token}' 2>/dev/null)

run() { # model method k=v...
  local model=$1 method=$2; shift 2
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  (cd "$REPO" && swamp model method run "$model" "$method" "${args[@]}" --json) >"$OUT" 2>"$ERR"
}

# found <file-or-dir>...: whether the token is in any of them. The token is
# handed to grep as a pattern file, never as an argument.
found() { [ -n "$TOKEN" ] && grep -rqFf <(printf '%s\n' "$TOKEN") "$@" 2>/dev/null; }
leaks() { found "$OUT" "$ERR"; }
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# The run must fail, its message must match the pattern, write no record and
# carry no secret.
refuses() { # name pattern model method args...
  local name=$1 pattern=$2; shift 2
  if run "$@"; then
    bad "$name" "expected a refusal, the run succeeded"
  elif leaks; then
    bad "$name" "the refusal carried the token"
  elif [ "$(jq -r '[.dataArtifacts[]?] | length' "$OUT" 2>/dev/null || echo 0)" != "0" ] && [ -s "$OUT" ]; then
    bad "$name" "the refused run wrote a record"
  elif cat "$OUT" "$ERR" | tr -d '\\' | grep -qiE "$pattern"; then
    ok "$name"
  else
    bad "$name" "message did not match /$pattern/: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  fi
}

# The run must succeed, carry no secret, and the jq filter over the attributes
# of its first record hold.
holds() { # name jqfilter model method args...
  local name=$1 filter=$2; shift 2
  if ! run "$@"; then
    bad "$name" "run failed: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  elif leaks; then
    bad "$name" "the output carried the token"
  elif [ "$(jq -r ".dataArtifacts[0].attributes | $filter" "$OUT")" = "true" ]; then
    ok "$name"
  else
    bad "$name" "filter false: $(jq -c '.dataArtifacts[0].attributes' "$OUT" | head -c 400)"
  fi
}

# The run must fail with a message that matches the pattern, like a refusal,
# but it is allowed to have written a record: the method records what it saw
# before it reports the failure.
fails() { # name pattern model method args...
  local name=$1 pattern=$2; shift 2
  if run "$@"; then
    bad "$name" "expected a failure, the run succeeded"
  elif leaks; then
    bad "$name" "the failure carried the token"
  elif cat "$OUT" "$ERR" | tr -d '\\' | grep -qiE "$pattern"; then
    ok "$name"
  else
    bad "$name" "message did not match /$pattern/: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  fi
}

# latest <model> <data name> <jq filter over the attributes>: the newest
# stored record of that name holds.
latest() { # name model dataname jqfilter
  local got
  got=$(cd "$REPO" && swamp data query "modelName == \"$2\" && name == \"$3\" && isLatest" --select content --json 2>"$ERR")
  if [ "$(printf '%s' "$got" | jq -r "[.. | objects | select(has(\"namespace\") and has(\"ready\"))][0] | $4" 2>/dev/null)" = "true" ]; then
    ok "$1"
  else
    bad "$1" "filter false: $(printf '%s' "$got" | tr -d '\n' | head -c 300)"
  fi
}

# A jq filter over the whole output of the last run.
also() { # name jqfilter
  if [ "$(jq -r "$2" "$OUT")" = "true" ]; then ok "$1"; else bad "$1" "filter false"; fi
}

summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
