#!/usr/bin/env bash
# Harness for the live suite of @dataverket/cnpg: each batch sources this,
# runs model methods in the swamp repository $REPO against the cluster of
# $SMOKE_KUBECONFIG, and counts what held.
set -u
: "${REPO:?set REPO to a swamp repository that loads this extension}"
: "${SMOKE_KUBECONFIG:?set SMOKE_KUBECONFIG to the kubeconfig of the throwaway cluster}"
HERE=$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)
W=${WORK:-$HERE/.work}
PASS=0; FAIL=0
OUT=$W/.out.json
ERR=$W/.err.txt
mkdir -p "$W"

# Only a kind cluster is ever touched: any other current context is refused.
case $(kubectl --kubeconfig "$SMOKE_KUBECONFIG" config current-context 2>/dev/null) in
  kind-*) ;;
  *) echo "the current context of SMOKE_KUBECONFIG is not a kind-* cluster; refusing" >&2; exit 2 ;;
esac

# kubectl against the throwaway cluster only, never the caller's own context.
k() { kubectl --kubeconfig "$SMOKE_KUBECONFIG" "$@"; }

# Every secret value the suite made, as one pattern; none of it may surface.
secrets() {
  {
    cat "$W"/s3.env "$W"/s3-wrong.env 2>/dev/null | cut -d= -f2-
    grep -h 'token:' "$W"/*.kubeconfig 2>/dev/null | awk '{print $2}'
  } | paste -sd'|'
}

run() { # model method k=v...
  local model=$1 method=$2; shift 2
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  (cd "$REPO" && swamp model method run "$model" "$method" "${args[@]}" --json) >"$OUT" 2>"$ERR"
}

ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

leaked() { local s; s=$(secrets); [ -n "$s" ] && grep -qE "$s" "$OUT" "$ERR"; }

# The run must fail, its message must match the pattern, and carry no secret.
refuses() { # name pattern model method args...
  local name=$1 pattern=$2; shift 2
  if run "$@"; then
    bad "$name" "expected a refusal, the run succeeded"
  elif leaked; then
    bad "$name" "the refusal carried a secret"
  elif cat "$OUT" "$ERR" | tr -d '\\' | grep -qiE "$pattern"; then
    ok "$name"
  else
    bad "$name" "message did not match /$pattern/: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  fi
}

# The run must succeed, carry no secret, and the jq filter over its output hold.
holds() { # name jqfilter model method args...
  local name=$1 filter=$2; shift 2
  if ! run "$@"; then
    bad "$name" "run failed: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  elif leaked; then
    bad "$name" "the output carried a secret"
  elif [ "$(jq -r "$filter" "$OUT")" = "true" ]; then
    ok "$name"
  else
    bad "$name" "filter false: $(jq -c '[.dataArtifacts[]? | {name, attributes}]' "$OUT" | head -c 600)"
  fi
}

# The names of the object records in the last run's output, sorted, as JSON:
# everything but the inventory of the list.
# (used as a jq fragment: OBJECTS | ...)
OBJECTS='[.dataArtifacts[] | select(.name | startswith("inventory_") | not)]'
# The inventory of the last run's output; `error` when there is not exactly one.
INVENTORY='([.dataArtifacts[] | select(.name | startswith("inventory_"))] | if length == 1 then .[0] else error("not one inventory") end)'

# The attributes of the artifact of that name in the last run's output.
artifact() { jq -c --arg n "$1" '.dataArtifacts[] | select(.name == $n) | .attributes' "$OUT"; }

# A plain check outside swamp, for example how many objects exist.
check() { # name command...
  local name=$1; shift
  if "$@" >/dev/null 2>&1; then ok "$name"; else bad "$name" "check failed: $*"; fi
}

summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
