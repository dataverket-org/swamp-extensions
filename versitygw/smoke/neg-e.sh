#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== E. at rest, and twice in a row ==="

holds "inventory once" 'true' vgw inventory
cp "$OUT" "$REPO/.first.json"
holds "inventory twice gives identical records" \
  "[.dataArtifacts[] | select(.name != \"inventory\" and .name != \"health\") | {name, attributes}] == $(jq -c '[.dataArtifacts[] | select(.name != "inventory" and .name != "health") | {name, attributes}]' "$REPO/.first.json")" \
  vgw inventory
# The one place grep is right: proving a value is nowhere swamp keeps anything.
if grep -rqE "$SECRETS|fixtureroot" "$REPO/.swamp"; then
  bad "no secret and no root access key anywhere in the repository's .swamp" \
    "$(grep -rlE "$SECRETS|fixtureroot" "$REPO/.swamp" | head -3)"
else
  ok "no secret and no root access key anywhere in the repository's .swamp"
fi
summary
