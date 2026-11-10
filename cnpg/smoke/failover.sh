#!/usr/bin/env bash
# C. A failover, read while it happens: the primary pod of the three-instance
# Cluster is deleted and the Clusters listed every second until it has settled.
# Each list is checked against its own inventory: whenever the record says
# not healthy, the inventory line must say so too, with a reason.
source "$(dirname "$0")/lib.sh"
echo "=== C. failover ==="
run pg-cluster get name=three
before=$(jq -r '.dataArtifacts[0].attributes.currentPrimary' "$OUT")
k -n pg delete pod "$before" --wait=false >/dev/null
changing=0; unhealthy=0; notready=0; after=$before; settled=0; named=0; reason=
for _ in $(seq 60); do
  run pg-cluster list || { bad "a read during the failover failed" "$(tail -c 300 "$ERR")"; break; }
  a=$(artifact pg--three)
  line=$(jq -c "$INVENTORY"' | .attributes.items[] | select(.name == "three")' "$OUT")
  [ "$(jq -r '.summary.primaryChanging' <<<"$a")" = true ] && changing=$((changing+1))
  [ "$(jq -r '.summary.instancesReady' <<<"$a")" = false ] && notready=$((notready+1))
  if [ "$(jq -r '.summary.healthy' <<<"$a")" = false ]; then
    unhealthy=$((unhealthy+1))
    if [ "$(jq -r '(.healthy | not) and (.reason | type == "string" and length > 0)' <<<"$line")" = true ]; then
      named=$((named+1)); reason=$(jq -r '.reason' <<<"$line")
    fi
    printf '      %s | current %s target %s ready %s/%s\n' \
      "$(jq -r '.phase' <<<"$a")" "$(jq -r '.currentPrimary' <<<"$a")" \
      "$(jq -r '.targetPrimary' <<<"$a")" "$(jq -r '.readyInstances' <<<"$a")" \
      "$(jq -r '.instances' <<<"$a")"
  elif [ "$unhealthy" -gt 0 ]; then
    after=$(jq -r '.currentPrimary' <<<"$a"); settled=1; break
  fi
  sleep 1
done
[ "$unhealthy" -gt 0 ] && ok "the Cluster was read as not healthy during the failover ($unhealthy reads)" ||
  bad "the Cluster was read as not healthy during the failover" "every read said healthy"
[ "$unhealthy" -gt 0 ] && [ "$named" = "$unhealthy" ] &&
  ok "every such list named the Cluster in its inventory with a reason (last: $reason)" ||
  bad "every such list named the Cluster in its inventory with a reason" "$named of $unhealthy"
[ "$notready" -gt 0 ] && ok "instancesReady was false while an instance was gone ($notready reads)" ||
  bad "instancesReady was false while an instance was gone" "never seen"
[ "$changing" -gt 0 ] && ok "primaryChanging was true while current and target differed ($changing reads)" ||
  bad "primaryChanging was true while current and target differed" "never seen; the window can be shorter than a read"
[ "$settled" = 1 ] && [ "$after" != "$before" ] && ok "the Cluster settled healthy on a new primary ($before to $after)" ||
  bad "the Cluster settled healthy on a new primary" "before $before, after $after, settled $settled"
holds "after the failover the timeline has moved on" \
  '.dataArtifacts[0].attributes | .summary.healthy and .timelineId >= 2' pg-cluster get name=three
summary
