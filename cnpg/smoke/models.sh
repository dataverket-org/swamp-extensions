#!/usr/bin/env bash
# The models the live suite runs, created in the swamp repository $REPO and
# pointed at the throwaway cluster. Run setup.sh readers first.
set -euo pipefail
: "${REPO:?set REPO to a swamp repository that loads this extension}"
: "${SMOKE_KUBECONFIG:?set SMOKE_KUBECONFIG to the kubeconfig of the throwaway cluster}"
HERE=$(cd "$(dirname "$0")" && pwd)
W=${WORK:-$HERE/.work}
m() { # type name global-args...
  local type=$1 name=$2; shift 2
  local args=()
  for kv in "$@"; do args+=(--global-arg "$kv"); done
  (cd "$REPO" && swamp model create "@dataverket/cnpg/$type" "$name" "${args[@]}" --json >/dev/null)
}
for t in cluster scheduledbackup backup; do
  m "$t" "all-$t" kubeconfig="$SMOKE_KUBECONFIG"
  m "$t" "pg-$t" kubeconfig="$SMOKE_KUBECONFIG" namespace=pg
  m "$t" "reader-$t" kubeconfig="$W/reader.kubeconfig" namespace=pg
  m "$t" "blind-$t" kubeconfig="$W/blind.kubeconfig" namespace=pg
  m "$t" "badtoken-$t" kubeconfig="$W/badtoken.kubeconfig" namespace=pg
  m "$t" "closed-$t" kubeconfig="$W/closed.kubeconfig" namespace=pg
  m "$t" "nowhere-$t" kubeconfig="$SMOKE_KUBECONFIG" namespace=no-such-namespace
  m "$t" "badctx-$t" kubeconfig="$SMOKE_KUBECONFIG" context=no-such-context namespace=pg
  m "$t" "nofile-$t" kubeconfig="$W/no-such-kubeconfig" namespace=pg
done
# The same Backups and schedules, judged with one minute of patience.
for t in scheduledbackup backup; do
  m "$t" "quick-$t" kubeconfig="$SMOKE_KUBECONFIG" namespace=pg unfinishedAfterSeconds=60
done
echo "models created in $REPO"
