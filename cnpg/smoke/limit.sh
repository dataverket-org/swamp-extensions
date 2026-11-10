#!/usr/bin/env bash
# F. The time limit of create, measured: the longest wait, on a Backup that
# does not end. Run it last. It takes a Backup of `bad`, whose WAL archive
# never worked, and after such a Backup the operator was once seen to give
# new Backups no phase (see README). `limit.sh after` then takes a Backup of
# another Cluster and says what the operator did with it: a note, not a check.
#   usage: limit.sh [after]
source "$(dirname "$0")/lib.sh"
if [ "${1:-}" = after ]; then
  k -n pg delete backups.postgresql.cnpg.io --ignore-not-found --wait=false \
    smoke-long smoke-after >/dev/null
  start=$(date +%s)
  if run pg-backup create name=smoke-after cluster=one waitSeconds=90; then
    printf 'NOTE  the next Backup, of Cluster one, was %s after %s s\n' \
      "$(jq -r '.dataArtifacts[0].attributes.phase // "without a phase"' "$OUT")" \
      "$(( $(date +%s) - start ))"
    if [ "$(jq -r '.dataArtifacts[0].attributes.finished' "$OUT")" = false ]; then
      # This is what the age limit is for: nothing else says it is stuck.
      holds "a Backup the operator has left unfinished is named in the inventory after a minute" \
        "$INVENTORY"' | [.attributes.items[] | select(.name == "smoke-after")][0]
           | (.healthy | not) and (.reason | test("^(still [a-zA-Z]+|without a phase) after [0-9]+ s, longer than 60 s$"))' \
        quick-backup list
    fi
  else
    printf 'NOTE  the next Backup, of Cluster one, could not be created: %s\n' \
      "$(tail -c 200 "$ERR")"
  fi
  exit 0
fi
echo "=== G. the longest wait ==="
k -n pg delete backups.postgresql.cnpg.io --ignore-not-found smoke-long >/dev/null

start=$(date +%s)
holds "a Backup that does not end is recorded as it stands after the longest wait" \
  '.dataArtifacts[0] | .name == "pg--smoke-long" and (.attributes | (.finished | not)
     and (.failed | not) and .cluster == "bad")' \
  pg-backup create name=smoke-long cluster=bad waitSeconds=120 pollSeconds=5
took=$(( $(date +%s) - start ))
if [ "$took" -ge 120 ] && [ "$took" -lt 180 ]; then
  ok "... after the whole wait and in less than 180 s (it took $took s)"
else
  bad "... after the whole wait and in less than 180 s" "it took $took s"
fi
printf 'NOTE  smoke-long was left in phase %s\n' \
  "$(jq -r '.dataArtifacts[0].attributes.phase // "none"' "$OUT")"
# The same unfinished Backup, judged with an hour of patience and with a minute.
LONG='[.attributes.items[] | select(.name == "smoke-long")][0]'
holds "an unfinished Backup two minutes old is healthy in the inventory of a definition with the default hour" \
  "($INVENTORY | $LONG | .healthy and .reason == null)"' and ([.dataArtifacts[] | select(.name == "pg--smoke-long")][0].attributes
     | (.finished | not) and .unfinishedSeconds >= 120 and .unfinishedSeconds < 600)' \
  pg-backup list
holds "... and named, with its age, in the inventory of a definition that allows a minute" \
  "$INVENTORY | $LONG"' | (.healthy | not) and (.reason | test("^(still [a-zA-Z]+|without a phase) after [0-9]+ s, longer than 60 s$"))' \
  quick-backup list
summary
