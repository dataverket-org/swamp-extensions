#!/usr/bin/env bash
# A. The reads: five Clusters, two schedules and their newest Backups, the Backups.
source "$(dirname "$0")/lib.sh"
echo "=== A. reads ==="
k apply -f "$HERE/manifests/scheduled.yaml" >/dev/null

holds "list finds the five Clusters across namespaces, and writes one inventory" \
  "($OBJECTS | map(.name) | sort"' == ["pg--bad","pg--failing","pg--nobackup","pg--one","pg--three"])
     and ([.dataArtifacts[].name] | index("inventory_all") != null)' \
  all-cluster list
holds "the inventory of every namespace counts five healthy Clusters, each pointing at its record" \
  "$INVENTORY"' | .name == "inventory_all" and (.attributes | .namespace == null and .count == 5
     and .healthyCount == 5 and .unhealthyCount == 0 and .observedAt != null
     and ([.items[] | select(.healthy and .reason == null and .namespace == "pg"
       and .dataName == "pg--" + .name)] | length) == 5)' \
  all-cluster list
# `bad` cannot archive from its first WAL file on; `failing` and `one` can.
for _ in $(seq 12); do
  run pg-cluster list &&
    [ "$(jq -r "$INVENTORY"' | [.attributes.items[] | select(.archiveFailing) | .name] | join(",")' "$OUT")" = bad ] && break
  sleep 5
done
holds "the inventory of one namespace says which Cluster's archive is failing, and only that one" \
  "$INVENTORY"' | .name == "inventory_ns_pg" and (.attributes | .namespace == "pg" and .count == 5
     and ([.items[] | select(.archiveFailing) | .name] == ["bad"])
     and ([.items[] | select(.name == "bad")][0] | .healthy and .reason == null))' \
  pg-cluster list
holds "a healthy Cluster says so, with its primary, instances, image and storage" \
  '.dataArtifacts[0].attributes | .summary.healthy and .summary.instancesReady
     and (.summary.primaryChanging | not) and (.currentPrimary | startswith("three-"))
     and .currentPrimary == .targetPrimary
     and .instances == 3 and .readyInstances == 3 and (.instanceStates | length) == 3
     and ([.instanceStates[] | select(.isPrimary) | .name] == [.currentPrimary])
     and ([.instanceStates[] | select(.status == "healthy")] | length) == 3
     and .postgresMajor == 18 and (.postgresVersion | startswith("18."))
     and .storageSize == "1Gi" and .timelineId >= 1' \
  pg-cluster get name=three
holds "a plugin Cluster shows its ObjectStore by reference and archives" \
  '.dataArtifacts[0].attributes | .summary.archiving and .backup.methods == ["plugin"]
     and .backup.walArchiver == "barman-cloud.cloudnative-pg.io"
     and .backup.objectStore.found and .backup.objectStore.destinationPath == "s3://three/"
     and .backup.retentionPolicy == "7d" and .backup.plugins[0].version == "0.15.1"' \
  pg-cluster get name=three
holds "an in-tree Cluster shows its destination by reference and archives" \
  '.dataArtifacts[0].attributes | .summary.archiving and .backup.methods == ["barmanObjectStore"]
     and .backup.barmanObjectStore.destinationPath == "s3://one/"
     and .backup.barmanObjectStore.endpointURL == "http://s3.pg.svc:7070"
     and .backup.retentionPolicy == "7d" and .backup.objectStore == null' \
  pg-cluster get name=one
holds "a Cluster with no backup configuration is healthy and not archiving" \
  '.dataArtifacts[0].attributes | .summary.healthy and (.summary.archiving | not)
     and (.backup.configured | not) and .archive.source == "none"
     and ([.conditions[] | select(.type == "ContinuousArchiving" and .status == "True")] | length) == 1' \
  pg-cluster get name=nobackup
holds "a Cluster whose archive is unreachable is healthy and not archiving, with the reason" \
  '.dataArtifacts[0].attributes | .summary.healthy and (.summary.archiving | not)
     and ([.conditions[] | select(.type == "ContinuousArchiving")][0].reason == "ContinuousArchivingFailing")' \
  pg-cluster get name=bad
holds "the read-only account reads the same" \
  "($OBJECTS | length == 5) and ($INVENTORY | .attributes.count == 5)" reader-cluster list

# Both schedules are immediate: their first Backups exist within seconds.
for _ in $(seq 12); do
  run pg-scheduledbackup get name=nightly &&
    [ "$(jq -r '.dataArtifacts[0].attributes.lastBackupCompleted' "$OUT")" = true ] && break
  sleep 10
done
holds "a schedule is read with the newest Backup it made and its result" \
  '.dataArtifacts[0].attributes | .schedule == "0 30 3 * * *" and .immediate and (.suspend | not)
     and .backupOwnerReference == "self" and .method == "plugin" and .cluster == "three"
     and .lastScheduleTime != null and .nextScheduleTime != null and .backupCount >= 1
     and .lastBackupCompleted and .lastBackupPhase == "completed"
     and (.lastBackup | .scheduledBackup == "nightly" and .completed and .startedAt != null
       and .stoppedAt != null and .beginWal != null and .endWal != null and .backupId != null
       and .method == "plugin" and .error == null and (.name | startswith("nightly-")))' \
  pg-scheduledbackup get name=nightly
holds "a schedule that owns nothing still finds its Backup, by the operator's label" \
  '.dataArtifacts[0].attributes | .backupOwnerReference == "none" and .method == "barmanObjectStore"
     and .cluster == "one" and .backupCount >= 1
     and (.lastBackup | .scheduledBackup == "plain" and .method == "barmanObjectStore"
       and .destinationPath == "s3://one/" and (.name | startswith("plain-")))' \
  pg-scheduledbackup get name=plain
# The Backup of `doomed` fails at once, as every base backup of `failing` does.
for _ in $(seq 12); do
  run pg-scheduledbackup get name=doomed &&
    [ "$(jq -r '.dataArtifacts[0].attributes.lastBackupPhase' "$OUT")" = failed ] && break
  sleep 10
done
holds "list finds the four schedules across namespaces under the same data names" \
  "$OBJECTS"' | map(.name) | sort == ["pg--doomed","pg--nightly","pg--paused","pg--plain"]' \
  all-scheduledbackup list
holds "the inventory names the suspended schedule and the one whose newest Backup failed, with a reason each" \
  "$INVENTORY"' | .name == "inventory_all" and (.attributes | .count == 4 and .healthyCount == 2
     and .unhealthyCount == 2
     and ([.items[] | select(.healthy | not) | .name] | sort == ["doomed","paused"])
     and ([.items[] | select(.name == "paused")][0].reason == "suspended")
     and ([.items[] | select(.name == "doomed")][0].reason | test("^newest Backup doomed-[0-9]+ failed: .+"))
     and ([.items[] | select(.healthy) | .reason] == [null, null]))' \
  all-scheduledbackup list
holds "the inventory names the failed Backup of that schedule, and counts a completed one as healthy" \
  "$INVENTORY"' | .name == "inventory_ns_pg" and (.attributes
     | ([.items[] | select(.healthy | not)] | length >= 1 and all(.phase == "failed" and (.reason | startswith("failed: "))))
     and ([.items[] | select(.name | startswith("doomed-"))] | length >= 1 and all(.healthy | not))
     and ([.items[] | select(.name | startswith("nightly-"))] | length >= 1 and all(.healthy and .reason == null and .phase == "completed"))
     and .count == (.items | length) and .unhealthyCount == ([.items[] | select(.healthy | not)] | length))' \
  pg-backup list
holds "the plugin Cluster now takes its recovery window from the ObjectStore" \
  '.dataArtifacts[0].attributes | .archive.source == "objectStore"
     and .archive.firstRecoverabilityPoint != null and .archive.lastSuccessfulBackup != null
     and ([.conditions[] | select(.type == "LastBackupSucceeded" and .status == "True")] | length) == 1' \
  pg-cluster get name=three
holds "the schedule's Backup is in the list of Backups" \
  '[.dataArtifacts[].attributes | select(.scheduledBackup == "nightly" and .cluster == "three")] | length >= 1' \
  all-backup list
summary
