#!/usr/bin/env bash
# Harness for the negative suite of @dataverket/forgejo: each batch sources
# this, runs model methods in $REPO, and counts what held.
set -u
PASS=0; FAIL=0
SMOKE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
OUT=${REPO:-.}/.out.json
ERR=${REPO:-.}/.err.txt
URL=http://127.0.0.1:13000
# Every secret the seed made: the tokens, the planted markers and the
# passwords. None of it may surface.
SECRETS='FIXTURE-SECRET|fx-(admin|plain|other)-pass-1'
for f in "$SMOKE"/.work/tokens/*; do SECRETS+="|$(cat "$f")"; done

run() { # model method k=v... (an argument --flag=value goes to swamp as it is)
  local model=$1 method=$2; shift 2
  local args=()
  for kv in "$@"; do
    case $kv in --*) args+=("$kv") ;; *) args+=(--input "$kv") ;; esac
  done
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

# A check of the forge itself, made with curl and the admin token: what a
# method left behind, read from the other side. The token stays in a header.
forge() { # method path [json]
  local data=()
  [ $# -ge 3 ] && data=(--data-binary "$3")
  curl -sS -X "$1" -H "Authorization: token $(cat "$SMOKE/.work/tokens/admin")" \
    -H 'Content-Type: application/json' "$URL/api/v1$2" "${data[@]}"
}

# The HTTP status the forge answers a GET with, as the admin.
code() { # path
  curl -sS -o /dev/null -w '%{http_code}' -H "Authorization: token $(cat "$SMOKE/.work/tokens/admin")" \
    "$URL/api/v1$1"
}

# A workflow run; its JSON lines go to $OUT, and the status is the last
# object's that has a status of succeeded or failed.
wf() { # workflow k=v...
  local w=$1; shift
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  (cd "${REPO:-.}" && swamp workflow run "$w" "${args[@]}" --json) >"$OUT" 2>"$ERR"
  jq -rs '[.[] | objects | select(.status == "succeeded" or .status == "failed") | .status] | last // "none"' "$OUT"
}

summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
