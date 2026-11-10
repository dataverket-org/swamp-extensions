#!/usr/bin/env bash
# E. A cluster without the CloudNativePG CRDs: run before `setup.sh operator`,
# or after `setup.sh nocrd`.
source "$(dirname "$0")/lib.sh"
echo "=== E. no CRDs ==="
HINT="the CRDs that define it are not installed.*doesn't have a resource type"
refuses "listing Clusters names the missing resource type" "$HINT" all-cluster list
refuses "... ScheduledBackups" "$HINT" all-scheduledbackup list
refuses "... Backups" "$HINT" all-backup list
refuses "reading one Cluster does too" "$HINT" pg-cluster get name=one
refuses "create is refused at its first check" "$HINT" pg-backup create name=smoke-nocrd cluster=one
summary
