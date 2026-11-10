#!/usr/bin/env bash
# D. What must not pass: missing objects and namespaces, names shaped as
# injection, an account that may not read or may not write, a cluster that
# cannot be reached, and a secret anywhere in what swamp stored.
source "$(dirname "$0")/lib.sh"
echo "=== D. negative ==="
count() { k -n pg get backups.postgresql.cnpg.io -o name | wc -l; }
before=$(count)

refuses "a missing Cluster is named" 'clusters.postgresql.cnpg.io "no-such" not found' \
  pg-cluster get name=no-such
refuses "a missing ScheduledBackup is named" '"no-such" not found' pg-scheduledbackup get name=no-such
refuses "a missing Backup is named" '"no-such" not found' pg-backup get name=no-such
refuses "create for a missing Cluster is refused" \
  "was not created: there is no Cluster no-such in namespace pg" \
  pg-backup create name=smoke-neg cluster=no-such

EMPTY="($OBJECTS | length == 0) and ($INVENTORY | .name == \"inventory_ns_no-such-namespace\"
  and (.attributes | .count == 0 and .unhealthyCount == 0 and .items == []))"
holds "a list in a namespace that does not exist records an empty inventory and nothing else" \
  "$EMPTY" nowhere-cluster list
holds "... for schedules too" "$EMPTY" nowhere-scheduledbackup list
holds "... and for Backups" "$EMPTY" nowhere-backup list
holds "an empty namespace argument lists the definition's namespace, not every namespace" \
  "$INVENTORY"' | .name == "inventory_ns_pg"' pg-cluster list namespace=
refuses "a get in a namespace that does not exist is not found" "not found" nowhere-cluster get name=one
refuses "create in a namespace that does not exist is refused" \
  "there is no Cluster one in namespace no-such-namespace" nowhere-backup create name=smoke-neg cluster=one

for name in '-A' '--all-namespaces' '-o=yaml' 'a b' 'a;id' '$(id)' '../one' 'One' 'one/two' "$(printf 'a\nb')"; do
  refuses "a name shaped like $(printf '%q' "$name") is refused" "is not a Kubernetes object name" \
    pg-cluster get "name=$name"
  refuses "... as a Backup name" "is not a Kubernetes object name" \
    pg-backup create "name=$name" cluster=one
  refuses "... as the Cluster of a Backup" "is not a Kubernetes object name" \
    pg-backup create name=smoke-neg "cluster=$name"
  refuses "... as a namespace" "is not a Kubernetes namespace name" \
    all-cluster list "namespace=$name"
  refuses "... as a ScheduledBackup name" "is not a Kubernetes object name" \
    pg-scheduledbackup get "name=$name"
done
refuses "a method outside the CRD's three is refused" "Invalid option.*at \"method\"" \
  pg-backup create name=smoke-neg cluster=one method=pg_dump
refuses "a wait longer than the limit is refused" "expected number to be <=120" \
  pg-backup create name=smoke-neg cluster=one waitSeconds=121

refuses "the read-only account cannot create a Backup" \
  "\(Forbidden\).*cannot create resource" reader-backup create name=smoke-neg cluster=one
refuses "an account whose token the cluster does not accept is told to log in again" \
  "did not accept the credentials of this context" badtoken-cluster list
refuses "... and its create makes nothing" "did not accept the credentials" \
  badtoken-backup create name=smoke-neg cluster=one
refuses "a cluster that does not answer on its port is unreachable, in one line" \
  "kubectl get clusters.postgresql.cnpg.io -n pg failed: the cluster could not be reached \(The connection to the server 127.0.0.1:1 was refused" \
  closed-cluster list
if grep -qE 'memcache.go|E[0-9]{4} [0-9:.]+ ' "$OUT" "$ERR"; then
  bad "... without the client's log lines" "a client-go log line is in the output"
else
  ok "... without the client's log lines"
fi
refuses "an account with no rights cannot list Clusters" "\(Forbidden\)" blind-cluster list
refuses "... nor ScheduledBackups" "\(Forbidden\)" blind-scheduledbackup list
refuses "... nor Backups" "\(Forbidden\)" blind-backup list
refuses "... nor create a Backup" "\(Forbidden\)" blind-backup create name=smoke-neg cluster=one
refuses "a context that does not exist is a named failure" \
  'context "no-such-context" does not exist' badctx-cluster list
refuses "a kubeconfig that does not exist is a named failure" "kubectl get .* failed: .*no such file or directory" nofile-cluster list
check "none of the refusals made a Backup" test "$(count)" = "$before"

s=$(secrets)
if [ -z "$s" ]; then
  bad "no secret anywhere in what swamp stored" "no secrets to look for; run setup.sh first"
elif grep -rqE "$s" "$REPO/.swamp" "$REPO/models" 2>/dev/null; then
  bad "no secret anywhere in what swamp stored" "a key or token is in $REPO"
else
  ok "no secret anywhere in what swamp stored (keys and tokens searched for in the repository)"
fi
if grep -rqE 'ACCESS_KEY_ID|SECRET_ACCESS_KEY|s3-creds|s3-wrong' "$REPO/.swamp/data" 2>/dev/null; then
  bad "no credential reference in any record" "a Secret name or key is in the stored data"
else
  ok "no credential reference in any record"
fi
summary
