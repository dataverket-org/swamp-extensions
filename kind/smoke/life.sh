#!/usr/bin/env bash
# The life of one cluster: created, found again, read, its node container
# stopped and started, deleted, deleted again, created again and deleted. Creates and deletes $CLUSTER,
# and refuses to start when a cluster of that name is already there.
source "$(dirname "$0")/negative.sh"
echo "=== life of the cluster $CLUSTER ($RUNTIME) ==="

if listed "$CLUSTER"; then
  echo "refusing: a kind cluster named $CLUSTER exists and this suite did not make it" >&2
  exit 2
fi
BEFORE=$(stamp)
OTHERS=$(kind get clusters 2>/dev/null)

holds "ensure creates the cluster and records it" \
  ".exists and .created and .name == \"$CLUSTER\" and .context == \"$CONTEXT\" and (.apiServer | test(\"^https://127\\\\.0\\\\.0\\\\.1:[0-9]+\$\")) and (.manifestsApplied | length == 3) and .kubeconfig == \"$SMOKE_KUBECONFIG\"" \
  c ensure
check "kind lists the cluster" listed "$CLUSTER"
check "the kubeconfig file holds the context" k config get-contexts "$CONTEXT"
check "the manifests were applied" k -n smoke get configmap applied
check "also the one whose path holds a space" k -n smoke get configmap spaced
check "the recorded apiServer is the one in the kubeconfig" \
  test "$(jq -r '.dataArtifacts[0].attributes.apiServer' "$OUT")" = \
  "$(k config view --minify -o 'jsonpath={.clusters[0].cluster.server}')"
CREATED=$(k get node "$NODE" -o 'jsonpath={.metadata.uid}')

holds "ensure again finds it: no second create" '.exists and (.created | not) and (.manifestsApplied | length == 3)' c ensure
check "the node is the same one" test "$(k get node "$NODE" -o 'jsonpath={.metadata.uid}')" = "$CREATED"
holds "get records it and applies nothing" \
  ".exists and (.created | not) and .manifestsApplied == [] and .context == \"$CONTEXT\" and (.apiServer | startswith(\"https://\"))" c get

refuses "a manifest that is not there is named" 'missing.yaml.* does not exist' c-badmanifest ensure
recorded "and the record says what is true: the cluster, one manifest applied, the one that failed" \
  '.exists and (.created | not) and (.manifestsApplied | length == 1) and (.manifestFailed | endswith("missing.yaml")) and (.error | test("does not exist")) and (.apiServer | startswith("https://"))' c-badmanifest
refuses "kubectl that is not there stops ensure" 'no-such-kubectl is not on PATH' c-nokubectl ensure
holds "get of the existing cluster without kubectl records that it exists, and why no more" \
  '.exists and .apiServer == "" and (.error | test("no-such-kubectl is not on PATH"))' c-nokubectl get

OTHER=${SMOKE_KUBECONFIG%/*}/other.kubeconfig
holds "get with a kubeconfig that is not there records the cluster and how to write the file" \
  '.exists and .apiServer == "" and (.error | test("kind export kubeconfig --name"))' c-otherfile get
never "a read wrote no kubeconfig" test -e "$OTHER"
holds "ensure with that kubeconfig writes it with kind export and carries on" '.exists and (.created | not)' c-otherfile ensure
check "the other kubeconfig now holds the context" kubectl --kubeconfig "$OTHER" config get-contexts "$CONTEXT"
holds "get reads the cluster through it" '.exists and (.error == null) and (.apiServer | startswith("https://"))' c-otherfile get

"$RUNTIME" stop "$NODE" >/dev/null 2>&1
refuses "a stopped node container gets the hint of the provider in use" "try '$RUNTIME start $NODE'" c ensure
holds "get still records the stopped cluster as existing" '.exists and (.created | not)' c get
"$RUNTIME" start "$NODE" >/dev/null 2>&1
for _ in $(seq 1 30); do k get --raw /readyz >/dev/null 2>&1 && break; sleep 3; done
holds "after the container is started ensure passes, with no create" '.exists and (.created | not)' c ensure
check "the node is still the same one" test "$(k get node "$NODE" -o 'jsonpath={.metadata.uid}')" = "$CREATED"

never "the client key is nowhere in the repository's data" found "$REPO/.swamp" "$REPO/models"

holds "delete removes the cluster" '(.exists | not) and .apiServer == ""' c delete
never "kind no longer lists it" listed "$CLUSTER"
never "its context left the kubeconfig file" k config get-contexts "$CONTEXT"
holds "delete of a cluster that is gone succeeds" '(.exists | not) and (.created | not)' c delete
check "the other kubeconfig still holds the entry of the cluster that is gone" kubectl --kubeconfig "$OTHER" config get-contexts "$CONTEXT"
holds "delete with that kubeconfig, of a cluster that is gone, succeeds" '(.exists | not)' c-otherfile delete
never "and kind took the stale entry out of it" kubectl --kubeconfig "$OTHER" config get-contexts "$CONTEXT"
# delete is the model's own delete: swamp marks the record deleted, and a read
# is refused until a method that creates has run again.
refuses "after delete, get is refused by swamp until ensure has run again" 're-create it first' c get
holds "ensure after delete creates the cluster again" '.exists and .created' c ensure
check "it is a new node" test "$(k get node "$NODE" -o 'jsonpath={.metadata.uid}')" != "$CREATED"
holds "get reads it again" '.exists and (.created | not)' c get
holds "delete removes it again" '(.exists | not)' c delete
never "kind no longer lists it" listed "$CLUSTER"

check "every other kind cluster is still there" others_remain
check "the default kubeconfig is unchanged" test "$(stamp)" = "$BEFORE"
summary
