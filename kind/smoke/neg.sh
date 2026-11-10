#!/usr/bin/env bash
# What is refused, and that a refusal creates nothing. Needs no cluster and
# makes none: $CLUSTER2 must not exist, and does not exist afterwards.
source "$(dirname "$0")/negative.sh"
echo "=== refusals; $CLUSTER2 is never created ==="

if listed "$CLUSTER2"; then
  echo "refusing: a kind cluster named $CLUSTER2 exists; pick another CLUSTER2" >&2
  exit 2
fi
BEFORE=$(stamp)
OTHERS=$(kind get clusters 2>/dev/null)
DIR=${SMOKE_KUBECONFIG%/*}

holds "get of a cluster that was never made records that" \
  "(.exists | not) and (.created | not) and .apiServer == \"\" and .context == \"kind-$CLUSTER2\"" absent get
holds "delete of a cluster that was never made succeeds" '(.exists | not)' absent-delete delete

i=0
while IFS= read -r name; do
  i=$((i+1))
  for method in ensure get delete; do
    refuses "$method with a cluster name that is not a name: $name" 'is not a Kubernetes object name' "name-$i" "$method"
  done
done < "$(dirname "$0")/names.txt"

refuses "a kind config that is not there is named by kind" 'no-such-kind.yaml: no such file' absent-noconfig ensure
refuses "a kubeconfig in a directory that is not there" 'no-such-dir does not exist' absent-nodir ensure
never "that directory was not made" test -e "$DIR/no-such-dir"
refuses "delete with that kubeconfig is refused before kind runs" 'no-such-dir does not exist' absent-nodir delete
never "and the directory was still not made" test -e "$DIR/no-such-dir"
for method in ensure get delete; do
  refuses "$method with kind not on PATH names the argument" 'no-such-kind was not found.*kindBinary' absent-nokind "$method"
done
refuses "a waitTimeout that carries a flag" 'is not a duration' absent-badwait ensure
refuses "a waitTimeout longer than a time limit can be" 'waitTimeout .*is too long' absent-longwait ensure

# Which method needs which binary: swamp runs no check before a read, and
# delete never runs kubectl.
holds "get needs no kubectl for a cluster that is not there" '(.exists | not)' absent-nokubectl get
holds "delete needs no kubectl" '(.exists | not)' absent-nokubectl delete
refuses "ensure is stopped by the kubectl check before kind runs" 'no-such-kubectl is not on PATH' absent-nokubectl ensure
refuses "a config path that is a flag" 'configPath .* is refused' absent-flagconfig ensure
refuses "a kubeconfig path that is a flag" 'kubeconfig .* is refused' absent-flagkubeconfig ensure

never "no cluster named $CLUSTER2 was made" listed "$CLUSTER2"
check "every other kind cluster is still there" others_remain
check "the default kubeconfig is unchanged" test "$(stamp)" = "$BEFORE"
summary
