#!/usr/bin/env bash
# Harness for the smoke and negative suite of @dataverket/kind: each batch
# sources this, runs model methods in $REPO, and counts what held.
#
# Input: REPO, SMOKE_KUBECONFIG, and optionally CLUSTER and CLUSTER2.
set -u
: "${REPO:?set REPO to the swamp repository models.sh filled}"
: "${SMOKE_KUBECONFIG:?set SMOKE_KUBECONFIG to the kubeconfig file the smoke cluster is written to}"
CLUSTER=${CLUSTER:-kind-smoke}
CLUSTER2=${CLUSTER2:-kind-smoke-absent}
CONTEXT=kind-$CLUSTER
# The container command of the provider kind uses.
RUNTIME=${KIND_EXPERIMENTAL_PROVIDER:-docker}
NODE=$CLUSTER-control-plane
# KUBECONFIG may be a list of files; each of them is the operator's own.
DEFAULT_KUBECONFIGS=${KUBECONFIG:-$HOME/.kube/config}
PASS=0; FAIL=0
OUT=$REPO/.out.json
ERR=$REPO/.err.txt

# The suite writes one kubeconfig file and it is never the operator's own.
case "$CONTEXT" in
  kind-*) ;;
  *) echo "refusing: context $CONTEXT is not a kind context" >&2; exit 2 ;;
esac
# each_default <command...>: run the command once per file of the list, with
# the file as its last argument. Empty entries of the list are skipped.
each_default() {
  local file rest=$DEFAULT_KUBECONFIGS
  while [ -n "$rest" ]; do
    file=${rest%%:*}
    case "$rest" in *:*) rest=${rest#*:} ;; *) rest= ;; esac
    [ -n "$file" ] && "$@" "$file"
  done
  return 0
}
refuse_default() {
  if [ "$SMOKE_KUBECONFIG" = "$1" ] || [ "$SMOKE_KUBECONFIG" -ef "$1" ]; then
    echo "refusing: SMOKE_KUBECONFIG is your default kubeconfig $1" >&2; exit 2
  fi
}
each_default refuse_default

k() { kubectl --kubeconfig "$SMOKE_KUBECONFIG" --context "$CONTEXT" --request-timeout=10s "$@"; }
# Whether every cluster in $OTHERS (one per line) is still listed.
others_remain() {
  local name
  for name in $OTHERS; do listed "$name" || return 1; done
}
listed() { kind get clusters 2>/dev/null | grep -qxF "$1"; }
# One line per file of the default kubeconfig list: its checksum, or absent.
stamp_one() { if [ -e "$1" ]; then printf '%s %s\n' "$1" "$(cksum < "$1")"; else printf '%s absent\n' "$1"; fi; }
stamp() { each_default stamp_one; }
# The content of the latest record of a model, deleted or not.
latest() { (cd "$REPO" && swamp data query "modelName == \"$1\" && name == \"cluster\"" --json) | jq -c '.results[0].content'; }

run() { # model method
  (cd "$REPO" && swamp model method run "$1" "$2" --json) >"$OUT" 2>"$ERR"
}

# found <file-or-dir>...: whether the cluster's client key is in any of them.
# The key is handed to grep as a pattern file, never as an argument.
found() {
  local key
  [ -s "$SMOKE_KUBECONFIG" ] || return 1
  key=$(sed -n 's/^ *client-key-data: *//p' "$SMOKE_KUBECONFIG" | head -1)
  [ -n "$key" ] && grep -rqFf <(printf '%s\n' "$key") "$@" 2>/dev/null
}
leaks() { found "$OUT" "$ERR"; }
ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# The run must fail, its message must match the pattern, write no record and
# carry no key.
refuses() { # name pattern model method
  local name=$1 pattern=$2; shift 2
  if run "$@"; then
    bad "$name" "expected a refusal, the run succeeded"
  elif leaks; then
    bad "$name" "the refusal carried the client key"
  elif [ -s "$OUT" ] && [ "$(jq -r '[.dataArtifacts[]?] | length' "$OUT" 2>/dev/null || echo 0)" != "0" ]; then
    bad "$name" "the refused run wrote a record"
  elif cat "$OUT" "$ERR" | tr -d '\\' | grep -qiE "$pattern"; then
    ok "$name"
  else
    bad "$name" "message did not match /$pattern/: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  fi
}

# The run must succeed, carry no key, and the jq filter over the attributes
# of its record hold.
holds() { # name jqfilter model method
  local name=$1 filter=$2; shift 2
  if ! run "$@"; then
    bad "$name" "run failed: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  elif leaks; then
    bad "$name" "the output carried the client key"
  elif [ "$(jq -r ".dataArtifacts[0].attributes | $filter" "$OUT")" = "true" ]; then
    ok "$name"
  else
    bad "$name" "filter false: $(jq -c '.dataArtifacts[0].attributes' "$OUT" | head -c 400)"
  fi
}

# The jq filter must hold over the latest record of a model.
recorded() { # name jqfilter model
  if [ "$(latest "$3" | jq -r "$2")" = "true" ]; then ok "$1"; else bad "$1" "filter false: $(latest "$3" | head -c 400)"; fi
}

# A shell condition that must hold.
check() { # name command...
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name" "false: $*"; fi
}
never() { # name command...
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then bad "$name" "true: $*"; else ok "$name"; fi
}

summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
