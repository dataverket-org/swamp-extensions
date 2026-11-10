#!/usr/bin/env bash
# Harness for the smoke and negative suite of @dataverket/renovate: each batch
# sources this, runs the lookup method in $REPO, and counts what held.
#
# Input: REPO, a swamp repository that loads the extension from source and
# that fixtures.sh and models.sh filled. Optionally RUNTIME (podman).
set -u
: "${REPO:?set REPO to the swamp repository fixtures.sh and models.sh filled}"
RUNTIME=${RUNTIME:-podman}
PASS=0; FAIL=0
OUT=$REPO/.out.json
ERR=$REPO/.err.txt
# A value planted in a fixture's configuration; it must reach no record.
PLANTED=hunter2-planted-secret

run() { # model k=v...
  local model=$1; shift
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  (cd "$REPO" && swamp model method run "$model" lookup "${args[@]}" --json) >"$OUT" 2>"$ERR"
}

ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }
said() { cat "$OUT" "$ERR" | tr -d '\n' | tail -c 500; }

# The record named <data name> of the last run, as JSON.
rec() { jq -c --arg n "$1" '[.dataArtifacts[] | select(.name == $n)][0].attributes' "$OUT"; }

# The run must fail with a message that matches, and write no record.
refuses() { # name pattern model args...
  local name=$1 pattern=$2; shift 2
  if run "$@"; then
    bad "$name" "expected a refusal, the run succeeded"
  elif jq -e '(.dataArtifacts // []) | length > 0' "$OUT" >/dev/null 2>&1; then
    bad "$name" "a refused run wrote a record"
  elif cat "$OUT" "$ERR" | tr -d '\\' | grep -qiE "$pattern"; then
    ok "$name"
  else
    bad "$name" "message did not match /$pattern/: $(said)"
  fi
}

# The run must succeed and the jq filter hold for the record <data name>.
holds() { # name dataName jqfilter model args...
  local name=$1 data=$2 filter=$3; shift 3
  if ! run "$@"; then
    bad "$name" "run failed: $(said)"
  elif [ "$(rec "$data" | jq -r "$filter")" = "true" ]; then
    ok "$name"
  else
    bad "$name" "filter false: $(rec "$data" | head -c 600)"
  fi
}

# A further filter over a record of the run `holds` just made.
also() { # name dataName jqfilter
  if [ "$(rec "$2" | jq -r "$3")" = "true" ]; then ok "$1"
  else bad "$1" "filter false: $(rec "$2" | head -c 600)"; fi
}

# check <name> <command...>: a plain condition. never: its opposite.
check() {
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name" "condition false: $*"; fi
}
never() {
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then bad "$name" "condition true: $*"; else ok "$name"; fi
}

# Every file of the fixtures, with its content's checksum and its mode.
stamp() { (cd "$REPO/fix" && find . -type f -not -path './*/.git/*' -exec cksum {} + | sort; find . -not -path './*/.git/*' -printf '%m %p\n' | sort; for d in */.git; do git -C "${d%/.git}" status --porcelain; done) | cksum; }
# Whether a container this type named is left, running or not.
leftover() { "$RUNTIME" ps --all --format '{{.Names}}' | grep -q '^renovate-local-'; }
# The name of the container of this type that runs now, or nothing.
running() { "$RUNTIME" ps --format '{{.Names}}' | grep -m1 '^renovate-local-'; }
# start <model> <repo>: a lookup in the background, with proxy variables that
# hold a password; returns when its container runs. Its pid is $SWAMP.
start() {
  (cd "$REPO" && HTTPS_PROXY="http://alice:$PLANTED@127.0.0.1:9" http_proxy="http://alice:$PLANTED@127.0.0.1:9" NO_PROXY=localhost \
    exec swamp model method run "$1" lookup --input "repo=$2" --json) >"$OUT" 2>"$ERR" &
  SWAMP=$!
  for _ in $(seq 1 40); do leftover && break; sleep 0.5; done
}
# What the running container was given as environment.
container_env() { "$RUNTIME" inspect --format '{{json .Config.Env}}' "$(running)"; }
gone() { for _ in $(seq 1 "${1:-20}"); do leftover || return 0; sleep 0.5; done; return 1; }
planted() { grep -rqF "$PLANTED" "$REPO/.swamp" "$OUT" "$ERR"; }

summary() {
  echo "--- $PASS passed, $FAIL failed"
  [ "$FAIL" -eq 0 ]
}
