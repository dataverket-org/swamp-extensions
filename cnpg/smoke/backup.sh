#!/usr/bin/env bash
# B. On-demand Backups: completed, repeated, refused, failed.
source "$(dirname "$0")/lib.sh"
echo "=== B. on-demand Backups ==="
PLUGIN='pluginConfiguration={"name":"barman-cloud.cloudnative-pg.io"}'
count() { k -n pg get backups.postgresql.cnpg.io -o name | grep -c "/$1\$"; }
# A clean start: the Backups of an earlier run of this batch go first.
k -n pg delete backups.postgresql.cnpg.io --ignore-not-found \
  smoke-one smoke-three smoke-nowait smoke-failed smoke-online smoke-params >/dev/null

holds "an on-demand Backup with the in-tree method completes within the wait" \
  '.dataArtifacts[0] | .name == "pg--smoke-one" and (.attributes | .completed and .finished
     and (.failed | not) and .method == "barmanObjectStore" and .cluster == "one"
     and .destinationPath == "s3://one/" and .serverName == "one" and .instance == "one-1"
     and .backupId != null and .backupName != null and .beginWal != null and .endWal != null
     and .beginLSN != null and .endLSN != null and .timeline == 1 and .scheduledBackup == null
     and .adopted == false)' \
  pg-backup create name=smoke-one cluster=one
holds "create again with the same name and request changes nothing, and the record says the Backup was found" \
  '.dataArtifacts[0].attributes | .completed and .name == "smoke-one" and .adopted == true' \
  pg-backup create name=smoke-one cluster=one
check "... and there is still exactly one Backup of that name" test "$(count smoke-one)" = 1
refuses "the same name with a different request is refused" \
  "already exists in namespace pg with a different request \(target\)" \
  pg-backup create name=smoke-one cluster=one target=primary
refuses "the same name for another Cluster is refused" \
  "different request \(cluster, method, pluginConfiguration\)" \
  pg-backup create name=smoke-one cluster=three method=plugin "$PLUGIN"
holds "the in-tree Cluster's status now holds the recovery window" \
  '.dataArtifacts[0].attributes | .archive.source == "clusterStatus"
     and .archive.firstRecoverabilityPoint != null and .archive.lastSuccessfulBackup != null' \
  pg-cluster get name=one

run pg-cluster get name=three
primary=$(jq -r '.dataArtifacts[0].attributes.currentPrimary' "$OUT")
holds "an on-demand Backup through the plugin completes, on the primary as asked" \
  '.dataArtifacts[0].attributes | .completed and .method == "plugin"
     and .pluginName == "barman-cloud.cloudnative-pg.io" and .cluster == "three"
     and .backupId != null and .beginWal != null and .instance != null and .timeline != null
     and .target == "primary" and .instance == "'"$primary"'"' \
  pg-backup create name=smoke-three cluster=three method=plugin target=primary "$PLUGIN"

PARAMS='pluginConfiguration={"name":"barman-cloud.cloudnative-pg.io","parameters":{"note":"smoke"}}'
holds "plugin parameters are accepted by the API server and the Backup completes" \
  '.dataArtifacts[0] | .name == "pg--smoke-params" and (.attributes | .completed and .method == "plugin")' \
  pg-backup create name=smoke-params cluster=three method=plugin "$PARAMS"
check "... and they are in the Backup object, which is why they are never a secret" test \
  "$(k -n pg get backups.postgresql.cnpg.io smoke-params -o jsonpath='{.spec.pluginConfiguration.parameters.note}')" = smoke
holds "the identical create again is the same request" \
  '.dataArtifacts[0].attributes | .completed and .name == "smoke-params"' \
  pg-backup create name=smoke-params cluster=three method=plugin "$PARAMS"
refuses "the same name with no parameters is another request: a Backup with more parameters is not taken over" \
  "different request \(pluginConfiguration\)" \
  pg-backup create name=smoke-params cluster=three method=plugin \
  'pluginConfiguration={"name":"barman-cloud.cloudnative-pg.io"}'
refuses "... and so is one with one parameter more" "different request \(pluginConfiguration\)" \
  pg-backup create name=smoke-params cluster=three method=plugin \
  'pluginConfiguration={"name":"barman-cloud.cloudnative-pg.io","parameters":{"note":"smoke","more":"x"}}'
refuses "the same name with another parameter value is refused" \
  "different request \(pluginConfiguration\)" \
  pg-backup create name=smoke-params cluster=three method=plugin \
  'pluginConfiguration={"name":"barman-cloud.cloudnative-pg.io","parameters":{"note":"other"}}'
refuses "online settings with a method that is not volumeSnapshot are refused by the operator, by name" \
  "can be specified only if the backup method is volumeSnapshot" \
  pg-backup create name=smoke-none cluster=one online=true 'onlineConfiguration={"immediateCheckpoint":true}'

holds "waitSeconds=0 records the Backup as it stands, not finished" \
  '.dataArtifacts[0].attributes | (.finished | not) and .name == "smoke-nowait"' \
  pg-backup create name=smoke-nowait cluster=one waitSeconds=0
for _ in $(seq 12); do
  run pg-backup get name=smoke-nowait &&
    [ "$(jq -r '.dataArtifacts[0].attributes.finished' "$OUT")" = true ] && break
  sleep 5
done
holds "... and get reads its result afterwards" \
  '.dataArtifacts[0] | .name == "pg--smoke-nowait" and .attributes.completed' \
  pg-backup get name=smoke-nowait

# `failing` archives WAL fine, but its backup command is given an option it
# does not have, so the base backup starts and fails at once. (A Backup of
# `bad`, whose archive never worked, does not fail: it waits; see README.)
for _ in $(seq 12); do
  run pg-cluster get name=failing &&
    [ "$(jq -r '.dataArtifacts[0].attributes.summary.archiving' "$OUT")" = true ] && break
  sleep 5
done
holds "a Backup that fails is a record with failed and the error, not a failed run" \
  '.dataArtifacts[0].attributes | .failed and .finished and (.completed | not)
     and .phase == "failed" and (.error | type == "string" and length > 0) and .cluster == "failing"
     and .destinationPath == "s3://failing/"' \
  pg-backup create name=smoke-failed cluster=failing waitSeconds=60
holds "get reads the same failed Backup" \
  '.dataArtifacts[0] | .name == "pg--smoke-failed" and .attributes.failed' \
  pg-backup get name=smoke-failed
holds "create on the failed Backup's name is the same request: recorded, not thrown" \
  '.dataArtifacts[0].attributes.failed' pg-backup create name=smoke-failed cluster=failing
holds "the Cluster records the failed backup: time and condition" \
  '.dataArtifacts[0].attributes | .archive.lastFailedBackup != null and .summary.healthy
     and ([.conditions[] | select(.type == "LastBackupSucceeded" and .status == "False")] | length) == 1' \
  pg-cluster get name=failing

refuses "a Cluster with no backup configuration is refused" \
  "was not created: the Cluster has no spec.backup.barmanObjectStore" \
  pg-backup create name=smoke-none cluster=nobackup
refuses "a method the Cluster is not configured for is refused" \
  "was not created: the Cluster has no spec.backup.volumeSnapshot" \
  pg-backup create name=smoke-none cluster=one method=volumeSnapshot
refuses "method plugin without a plugin name is refused" \
  "needs pluginConfiguration.name" pg-backup create name=smoke-none cluster=three method=plugin
refuses "a plugin the Cluster does not list is refused" \
  "does not list the plugin" \
  pg-backup create name=smoke-none cluster=one method=plugin "$PLUGIN"
check "... and none of the refusals made a Backup" test "$(count smoke-none)" = 0
holds "the Backups of one Cluster can be listed alone, and that list writes no inventory" \
  '([.dataArtifacts[].attributes.cluster] | length >= 2 and all(. == "one"))
     and ([.dataArtifacts[].name | select(startswith("inventory_"))] == [])' \
  pg-backup list cluster=one
holds "the inventory of all Backups names the failed on-demand Backup with the operator's error" \
  "$INVENTORY"' | .attributes | ([.items[] | select(.name == "smoke-failed")][0]
       | (.healthy | not) and .phase == "failed" and .dataName == "pg--smoke-failed"
         and (.reason | startswith("failed: ") and length <= 203))
     and ([.items[] | select(.name == "smoke-one" or .name == "smoke-three" or .name == "smoke-nowait")]
       | length == 3 and all(.healthy and .reason == null and .phase == "completed"))' \
  all-backup list
summary
