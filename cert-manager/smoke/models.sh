#!/usr/bin/env bash
# Makes the definitions the batches name, in the swamp repository at $REPO.
#
#   REPO=<swamp repository> models.sh <kubeconfig>
#
# The ServiceAccount kubeconfigs are written by setup.sh later; a definition
# only names the file.
set -euo pipefail

KUBECONFIG_FILE=$(realpath "${1:?usage: models.sh <kubeconfig of a throwaway cluster>}")
: "${REPO:?set REPO to a swamp repository that loads this extension from source}"
WORK=${WORK:-$(cd "$(dirname "$0")" && pwd)/.work}
T=@dataverket/cert-manager

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

create() { # type name global-arg...
  local type=$1 name=$2 args=(); shift 2
  for kv in "$@"; do args+=(--global-arg "$kv"); done
  (cd "$REPO" && swamp behavior create "$T/$type" "$name" "${args[@]}" --json >/dev/null)
  echo "  $name"
}

for kind in certificate certificaterequest order challenge issuer; do
  create "$kind" "cm-$kind" "kubeconfig=$KUBECONFIG_FILE"
done
create certificate cm-pki "kubeconfig=$KUBECONFIG_FILE" namespace=pki
create certificate cm-acme "kubeconfig=$KUBECONFIG_FILE" namespace=acme-test
create certificate cm-reader "kubeconfig=$WORK/reader.kubeconfig" namespace=pki
create certificate cm-narrow "kubeconfig=$WORK/narrow.kubeconfig" namespace=pki
create certificate cm-noissuer "kubeconfig=$WORK/noissuer.kubeconfig" namespace=acme-test
create certificate cm-editor "kubeconfig=$WORK/editor.kubeconfig" namespace=pki
create certificate cm-badtoken "kubeconfig=$WORK/badtoken.kubeconfig" namespace=pki
create certificate cm-nofile "kubeconfig=$WORK/does-not-exist.kubeconfig" namespace=pki
create certificate cm-nocontext "kubeconfig=$KUBECONFIG_FILE" context=no-such-context namespace=pki
