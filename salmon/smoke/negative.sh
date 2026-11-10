#!/usr/bin/env bash
# Harness for the smoke and negative suite of @dataverket/salmon: each batch
# sources this, runs model methods in $REPO, and counts what held.
set -u
: "${REPO:?set REPO to the swamp repository models.sh filled}"
: "${SMOKE_KUBECONFIG:?set SMOKE_KUBECONFIG to the kubeconfig file of the smoke cluster}"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
CLUSTER=${CLUSTER:-salmon-smoke}
CONTEXT=${SMOKE_CONTEXT:-kind-$CLUSTER}
WORK=${SMOKE_WORK:-$HERE/.work}
PORT=${SMOKE_PORT:-18090}
PASS=0; FAIL=0
OUT=$REPO/.out.json
ERR=$REPO/.err.txt
# What the stand-in was last sent as subject token (batch c).
SENT=$WORK/subject-token
# Anything shaped like a signed token.
JWT='eyJ[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{8,}\.[A-Za-z0-9_-]{4,}'

case $CONTEXT in
  kind-*) ;;
  *) echo "refused: the context $CONTEXT is not a kind cluster" >&2; exit 2 ;;
esac
k() { kubectl --kubeconfig "$SMOKE_KUBECONFIG" --context "$CONTEXT" "$@"; }

run() { # model method k=v...
  local model=$1 method=$2; shift 2
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  (cd "$REPO" && swamp model method run "$model" "$method" "${args[@]}" --json) >"$OUT" 2>"$ERR"
}

# found <file-or-dir>...: whether a token is in any of them: one shaped like
# a JWT, or the one the stand-in was sent, which is handed to grep as a
# pattern file and never as an argument.
found() {
  grep -rqE "$JWT" "$@" 2>/dev/null && return 0
  [ -s "$SENT" ] && grep -rqFf "$SENT" "$@" 2>/dev/null
}
leaks() { found "$OUT" "$ERR"; }
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }
said() { cat "$OUT" "$ERR" | tr -d '\n' | tail -c 400; }

# The run must fail, its message must match the pattern and carry no token.
# What a failed run recorded, or did not, is checked with `latest`.
refuses() { # name pattern model method args...
  local name=$1 pattern=$2; shift 2
  if run "$@"; then
    bad "$name" "expected a refusal, the run succeeded"
  elif leaks; then
    bad "$name" "the refusal carried a token"
  elif cat "$OUT" "$ERR" | tr -d '\\' | grep -qiE "$pattern"; then
    ok "$name"
  else
    bad "$name" "message did not match /$pattern/: $(said)"
  fi
}

# The run must succeed, carry no token, and the jq filter over the attributes
# of its first record hold.
holds() { # name jqfilter model method args...
  local name=$1 filter=$2; shift 2
  if ! run "$@"; then
    bad "$name" "run failed: $(said)"
  elif leaks; then
    bad "$name" "the output carried a token"
  elif [ "$(jq -r ".dataArtifacts[0].attributes | $filter" "$OUT")" = "true" ]; then
    ok "$name"
  else
    bad "$name" "filter false: $(jq -c '.dataArtifacts[0].attributes' "$OUT" | head -c 400)"
  fi
}

# latest <model> <data name> <jq filter>: whether the filter holds for the
# newest record of that name, read through swamp.
latest() {
  local model=$1 data=$2 filter=$3
  [ "$(cd "$REPO" && swamp data query "modelName == \"$model\" && name == \"$data\"" --select content --json 2>/dev/null |
    jq -r ".results[0] | $filter")" = "true" ]
}

# total <query>: how many records match, read through swamp.
total() { (cd "$REPO" && swamp data query "$1" --json 2>/dev/null | jq .total); }

# no_definition <name> <pattern> <type> <global-arg>...: creating the
# definition must be refused with the pattern, and the refusal must not
# repeat $PLANTED.
PLANTED=hunter2secret
no_definition() {
  local name=$1 pattern=$2 type=$3; shift 3
  local args=()
  for kv in "$@"; do args+=(--global-arg "$kv"); done
  if (cd "$REPO" && swamp model create "@dataverket/salmon/$type" "refused-$RANDOM" "${args[@]}" --json) >"$OUT" 2>"$ERR"; then
    bad "$name" "the definition was accepted"
  elif grep -q "$PLANTED" "$OUT" "$ERR"; then
    bad "$name" "the refusal repeats the password"
  elif cat "$OUT" "$ERR" | grep -qiE "$pattern"; then
    ok "$name"
  else
    bad "$name" "message did not match /$pattern/: $(said)"
  fi
}

# check <name> <command...>: a plain condition.
check() {
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name" "condition false: $*"; fi
}

# No token anywhere in what swamp keeps: records, logs, outputs, reports.
repo_clean() {
  if found "$REPO"; then bad "no token in the repository's data and logs" "a token was found under $REPO"
  else ok "no token in the repository's data and logs"; fi
}

summary() {
  echo "--- $PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ]
}
