#!/usr/bin/env bash
# Harness for the live suite of @dataverket/gateway-api: each batch sources
# this, runs model methods in $REPO, and counts what held. $SMOKE_KUBECONFIG
# is the kubeconfig of the throwaway kind cluster; nothing here reads the
# default kubeconfig, and a context that is not a kind cluster is refused.
set -u
: "${REPO:?set REPO to the scratch swamp repository}"
: "${SMOKE_KUBECONFIG:?set SMOKE_KUBECONFIG to the kubeconfig file of the kind cluster}"
SMOKE_CONTEXT=${SMOKE_CONTEXT:-kind-dvgw}
case "$SMOKE_CONTEXT" in
  kind-*) ;;
  *) echo "harness: $SMOKE_CONTEXT is not a kind context, refusing" >&2; exit 2 ;;
esac
PASS=0; FAIL=0
OUT=$REPO/.out.json
ERR=$REPO/.err.txt

# kubectl against the throwaway cluster, and only that one.
k() { kubectl --kubeconfig "$SMOKE_KUBECONFIG" --context "$SMOKE_CONTEXT" --request-timeout=30s "$@"; }

run() { # model method k=v...
  local model=$1 method=$2; shift 2
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  (cd "$REPO" && swamp model method run "$model" "$method" ${args[@]+"${args[@]}"} --json) >"$OUT" 2>"$ERR"
}

ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# The run must fail and its message match the pattern.
refuses() { # name pattern model method args...
  local name=$1 pattern=$2; shift 2
  if run "$@"; then
    bad "$name" "expected a refusal, the run succeeded"
  elif cat "$OUT" "$ERR" | tr -d '\\' | grep -qiE "$pattern"; then
    ok "$name"
  else
    bad "$name" "message did not match /$pattern/: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  fi
}

# The run must succeed and the jq filter over its output hold.
holds() { # name jqfilter model method args...
  local name=$1 filter=$2; shift 2
  if ! run "$@"; then
    bad "$name" "run failed: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  elif [ "$(jq -r "$filter" "$OUT")" = "true" ]; then
    ok "$name"
  else
    bad "$name" "filter false: $(jq -c '[.dataArtifacts[]? | {name, summary: .attributes.summary}]' "$OUT" | head -c 600)"
  fi
}

# The jq filter over the last run's output must hold; no new run.
also() { # name jqfilter
  if [ "$(jq -r "$2" "$OUT")" = "true" ]; then ok "$1"; else
    bad "$1" "filter false: $(jq -c '[.dataArtifacts[]? | {name, summary: .attributes.summary}]' "$OUT" | head -c 600)"
  fi
}

# The attributes of the record of that data name in the last run's output.
record() { printf '.dataArtifacts[] | select(.name == "%s") | .attributes' "$1"; }

# Nothing a run stored may hold a kubeconfig credential or key material: not
# the shape of one, and not the tokens models.sh wrote into .work. The code
# bundles are skipped; they hold the pattern that blanks such text.
no_secrets_stored() {
  local name="no credential or key material in anything stored"
  local work; work=$(dirname "${BASH_SOURCE[0]}")/.work
  if grep -rqE --exclude-dir=bundles 'client-key-data|client-certificate-data|BEGIN [A-Z ]*PRIVATE KEY' "$REPO/.swamp" "$OUT" "$ERR"; then
    bad "$name" "found credential-shaped text"
  elif grep -rqF --exclude-dir=bundles \
    -f <(sed -n 's/.*token: "\(..*\)".*/\1/p' "$work"/*.kubeconfig 2>/dev/null; echo not-a-token) \
    "$REPO/.swamp" "$OUT" "$ERR"; then
    bad "$name" "found a token of the test kubeconfigs"
  else
    ok "$name"
  fi
}

summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
