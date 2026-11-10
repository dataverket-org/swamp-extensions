#!/usr/bin/env bash
# F. States made on purpose. Run it after the other batches and before
# limit.sh: it changes three Clusters and does not put them back.
#   online     a volumeSnapshot Backup with online settings, twice (needs
#              `setup.sh snapshots`); nothing takes the snapshot, so the
#              Backup never completes
#   fence      the only instance of `failing` fenced, then let go
#   hibernate  `failing` hibernated
#   usage: states.sh [online | fence | hibernate]   (all three when left out)
source "$(dirname "$0")/lib.sh"
echo "=== F. states made on purpose ==="
C=clusters.postgresql.cnpg.io
part() { [ -z "${ONLY:-}" ] || [ "$ONLY" = "$1" ]; }
ONLY=${1:-}

if part online; then
  count() { k -n pg get backups.postgresql.cnpg.io -o name | grep -c "/$1\$"; }
  k -n pg delete backups.postgresql.cnpg.io --ignore-not-found smoke-online >/dev/null
  k -n pg patch $C nobackup --type merge \
    -p '{"spec":{"backup":{"volumeSnapshot":{"className":"no-such-class"}}}}' >/dev/null
  ONLINE='onlineConfiguration={"immediateCheckpoint":true}'
  # The API server fills in onlineConfiguration.waitForArchive beside what is
  # sent, so the stored Backup holds more than the request did.
  holds "a volumeSnapshot Backup with online and onlineConfiguration is accepted by the API server and recorded" \
    '.dataArtifacts[0] | .name == "pg--smoke-online" and (.attributes | .cluster == "nobackup"
       and .method == "volumeSnapshot" and .online == true and (.completed | not))' \
    pg-backup create name=smoke-online cluster=nobackup method=volumeSnapshot online=true "$ONLINE" waitSeconds=5
  check "... and the API server stored a default beside what was sent" test \
    "$(k -n pg get backups.postgresql.cnpg.io smoke-online -o jsonpath='{.spec.online}/{.spec.onlineConfiguration.immediateCheckpoint}/{.spec.onlineConfiguration.waitForArchive}')" = true/true/true
  holds "the identical create again is the same request, not a refusal" \
    '.dataArtifacts[0] | .name == "pg--smoke-online" and .attributes.method == "volumeSnapshot"' \
    pg-backup create name=smoke-online cluster=nobackup method=volumeSnapshot online=true "$ONLINE" waitSeconds=0
  check "... and there is still exactly one Backup of that name" test "$(count smoke-online)" = 1
  refuses "the same name asking for another onlineConfiguration is refused" \
    "different request \(onlineConfiguration\)" \
    pg-backup create name=smoke-online cluster=nobackup method=volumeSnapshot online=true \
    'onlineConfiguration={"immediateCheckpoint":false}'
  refuses "... and so is one that asks for online=false" "different request \(online\)" \
    pg-backup create name=smoke-online cluster=nobackup method=volumeSnapshot online=false "$ONLINE"
  printf 'NOTE  smoke-online is in phase %s: %s\n' \
    "$(k -n pg get backups.postgresql.cnpg.io smoke-online -o jsonpath='{.status.phase}')" \
    "$(k -n pg get backups.postgresql.cnpg.io smoke-online -o jsonpath='{.status.error}' | head -c 160)"
fi

if part fence; then
  run pg-cluster get name=failing
  primary=$(jq -r '.dataArtifacts[0].attributes.currentPrimary' "$OUT")
  k -n pg annotate $C failing "cnpg.io/fencedInstances=[\"$primary\"]" --overwrite >/dev/null 2>&1
  holds "a fenced Cluster is recorded as fenced, not healthy and not archiving, at once" \
    '.dataArtifacts[0].attributes | .fenced and .fencedInstances == ["'"$primary"'"] and (.hibernated | not)
       and (.summary.healthy | not) and (.summary.archiving | not) and .backup.walArchiver != null' \
    pg-cluster get name=failing
  printf 'NOTE  fenced, the operator shows: phase %s, ready %s/%s, ContinuousArchiving %s\n' \
    "$(jq -r '.dataArtifacts[0].attributes.phase' "$OUT")" \
    "$(jq -r '.dataArtifacts[0].attributes.readyInstances' "$OUT")" \
    "$(jq -r '.dataArtifacts[0].attributes.instances' "$OUT")" \
    "$(jq -r '[.dataArtifacts[0].attributes.conditions[] | select(.type == "ContinuousArchiving")][0].status' "$OUT")"
  holds "the inventory names the fence as the reason" \
    "$INVENTORY"' | [.attributes.items[] | select(.name == "failing")][0]
       | (.healthy | not) and (.hibernated | not) and (.reason | startswith("fenced: '"$primary"' (annotation cnpg.io/fencedInstances)"))' \
    pg-cluster list
  k -n pg annotate $C failing cnpg.io/fencedInstances- >/dev/null 2>&1
  for _ in $(seq 12); do
    run pg-cluster get name=failing &&
      [ "$(jq -r '.dataArtifacts[0].attributes.summary.healthy' "$OUT")" = true ] && break
    sleep 5
  done
  holds "with the annotation gone the Cluster is healthy again and not fenced" \
    '.dataArtifacts[0].attributes | .summary.healthy and (.fenced | not) and .fencedInstances == []' \
    pg-cluster get name=failing
fi

if part hibernate; then
  k -n pg annotate $C failing cnpg.io/hibernation=on --overwrite >/dev/null 2>&1
  holds "a hibernated Cluster is recorded as hibernated, not healthy and not archiving, at once" \
    '.dataArtifacts[0].attributes | .hibernated and (.fenced | not) and (.summary.healthy | not)
       and (.summary.archiving | not) and .backup.walArchiver != null' \
    pg-cluster get name=failing
  # What the inventory says while the operator is on its way: either it has
  # acted already, or the Cluster is not healthy and the reason says why.
  holds "on the way there the inventory says hibernated only when the operator has acted, else why not" \
    "$INVENTORY"' as $i | [.dataArtifacts[] | select(.name == "pg--failing")][0].attributes as $r
       | [$i.attributes.items[] | select(.name == "failing")][0]
       | if $r.hibernationReached then .healthy and .hibernated and .reason == null
         else (.healthy | not) and (.hibernated | not)
           and (.reason | startswith("hibernation asked for and not reached")) end' \
    pg-cluster list
  printf 'NOTE  right after the annotation: reached %s, hibernation condition %s\n' \
    "$(jq -r '[.dataArtifacts[] | select(.name == "pg--failing")][0].attributes.hibernationReached' "$OUT")" \
    "$(jq -r '[.dataArtifacts[] | select(.name == "pg--failing")][0].attributes.conditions | map(select(.type == "cnpg.io/hibernation")) | if length == 0 then "not set" else .[0] | .status + " (" + (.reason // "") + ")" end' "$OUT")"
  for _ in $(seq 16); do
    [ "$(k -n pg get pods -l cnpg.io/cluster=failing -o name | wc -l)" = 0 ] && break
    sleep 5
  done
  check "its pods are gone" test "$(k -n pg get pods -l cnpg.io/cluster=failing -o name | wc -l)" = 0
  for _ in $(seq 6); do
    run pg-cluster get name=failing &&
      [ "$(jq -r '.dataArtifacts[0].attributes.hibernationReached' "$OUT")" = true ] && break
    sleep 5
  done
  holds "with its pods gone the operator's condition says it has acted; still not healthy and not archiving" \
    '.dataArtifacts[0].attributes | .hibernated and .hibernationReached and (.summary.healthy | not)
       and (.summary.archiving | not)
       and ([.conditions[] | select(.type == "cnpg.io/hibernation" and .status == "True")] | length) == 1' \
    pg-cluster get name=failing
  printf 'NOTE  hibernated, the operator shows: phase %s, ready %s/%s, conditions True: %s\n' \
    "$(jq -r '.dataArtifacts[0].attributes.phase' "$OUT")" \
    "$(jq -r '.dataArtifacts[0].attributes.readyInstances' "$OUT")" \
    "$(jq -r '.dataArtifacts[0].attributes.instances' "$OUT")" \
    "$(jq -r '[.dataArtifacts[0].attributes.conditions[] | select(.status == "True") | .type] | join(", ")' "$OUT")"
  holds "the inventory counts it as healthy, says hibernated, and does not call its archive failing" \
    "$INVENTORY"' | [.attributes.items[] | select(.name == "failing")][0]
       | .healthy and .hibernated and .reason == null and (.archiveFailing | not)' \
    pg-cluster list
fi
summary
