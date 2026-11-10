#!/usr/bin/env bash
# Harness for the suite of @dataverket/cert-manager: each batch sources this,
# runs methods in the swamp repository at $REPO against the cluster of
# $KUBECONFIG_FILE, and counts what held.
set -u
: "${REPO:?set REPO to the swamp repository models.sh filled}"
: "${KUBECONFIG_FILE:?set KUBECONFIG_FILE to the kubeconfig of the throwaway cluster}"
PASS=0; FAIL=0
OUT=$REPO/.out.json
ERR=$REPO/.err.txt

k() { kubectl --kubeconfig "$KUBECONFIG_FILE" "$@"; }

# The suite installs and changes things: only a kind cluster is accepted.
kind_only() { # kubeconfig
  local current
  current=$(kubectl --kubeconfig "$1" config current-context 2>/dev/null) || current=
  case $current in
    kind-*) ;;
    *) echo "refusing: the current context of $1 is '${current:-none}', not a kind-* context" >&2; exit 2 ;;
  esac
}
kind_only "$KUBECONFIG_FILE"

# Everything secret the cluster's ACME objects hold: challenge tokens and
# keys, the CSRs, and the ServiceAccount tokens setup.sh wrote. Collected
# into a pattern file that is never printed; no run may surface a line of it.
SECRETS=$REPO/.secrets.txt
collect_secrets() {
  {
    k get challenges.acme.cert-manager.io -A -o json 2>/dev/null \
      | jq -r '.items[].spec | .token, .key'
    k get orders.acme.cert-manager.io -A -o json 2>/dev/null \
      | jq -r '.items[] | .spec.request, (.status.authorizations[]?.challenges[]?.token)'
    k get certificaterequests.cert-manager.io -A -o json 2>/dev/null \
      | jq -r '.items[].spec.request'
    local work=${WORK:-$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)/.work}
    grep -h 'token:' "$work"/*.kubeconfig 2>/dev/null | sed 's/.*token: *//' | grep -v '^not-a-token$'
    echo never-stored   # the webhook solver's config value in issuers.yaml
  } | grep -v '^null$' | grep -v '^$' | sort -u > "$SECRETS"
  chmod 600 "$SECRETS"
}
leaks() { [ -s "$SECRETS" ] && grep -qFf "$SECRETS" "$@"; }

run() { # model method k=v...
  local model=$1 method=$2; shift 2
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  (cd "$REPO" && swamp behavior run "$model" "$method" "${args[@]}" --json) >"$OUT" 2>"$ERR"
}

ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# The run must fail, its message must match the pattern, and carry no secret.
refuses() { # name pattern model method args...
  local name=$1 pattern=$2; shift 2
  if run "$@"; then
    bad "$name" "expected a refusal, the run succeeded"
  elif leaks "$OUT" "$ERR"; then
    bad "$name" "the refusal carried a secret"
  elif tr -d '\\' < "$ERR" | grep -qiE -e "$pattern"; then
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
  elif leaks "$OUT" "$ERR"; then
    bad "$name" "the output carried a secret"
  elif [ "$(jq -r "$filter" "$OUT")" = "true" ]; then
    ok "$name"
  else
    bad "$name" "filter false: $(jq -c '[.dataArtifacts[]? | {name}]' "$OUT" | head -c 300)"
  fi
}

# A plain condition, for what is checked in the cluster beside a run.
check() { # name command...
  local name=$1; shift
  if "$@"; then ok "$name"; else bad "$name" "condition false: $*"; fi
}

# The attributes of the artifact of that name in the last run's output.
artifact() { jq -c --arg n "$1" '.dataArtifacts[] | select(.name == $n) | .attributes' "$OUT"; }

# What a Certificate looks like to the cluster right now, for before/after.
revision() { k -n "$1" get certificates.cert-manager.io "$2" -o jsonpath='{.status.revision}'; }
version()  { k -n "$1" get certificates.cert-manager.io "$2" -o jsonpath='{.metadata.resourceVersion}'; }

# Poll for a condition: 40 tries, 3 s apart.
eventually() { local i; for i in $(seq 40); do "$@" && return 0; sleep 3; done; return 1; }

summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
