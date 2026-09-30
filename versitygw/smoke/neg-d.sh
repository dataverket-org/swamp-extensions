#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== D. check reads one inventory, and only that one ==="
H=$(dirname "$0")

holds "inventory runs" '[.dataArtifacts[] | select(.name == "inventory")] | length == 1' vgw inventory
first=$(artifact inventory | jq -r .inventoryId)
holds "check finds the nine seeded problems" \
  '.dataArtifacts[] | select(.name == "check") | .attributes.findings | length == 9' vgw check

# Change the gateway: the idle account goes, then a new inventory.
podman exec vgw-fixture versitygw admin -a fixtureroot -s fixturerootsecret0000 -r us-east-1 \
  -er http://localhost:7071 delete-user -a idle >/dev/null
holds "a second inventory, without idle" \
  '[.dataArtifacts[] | select(.name == "inventory")] | length == 1' vgw inventory
holds "check of the latest no longer sees idle" \
  '.dataArtifacts[] | select(.name == "check") | [.attributes.findings[].subject] | index("idle") == null' vgw check
holds "check of the first inventory still does, and nothing newer" \
  ".dataArtifacts[] | select(.name == \"check\") | .attributes.inventoryId == \"$first\" and ([.attributes.findings[].subject] | index(\"idle\") != null) and (.attributes.findings | length == 9)" \
  vgw check inventoryId="$first"
podman exec vgw-fixture versitygw admin -a fixtureroot -s fixturerootsecret0000 -r us-east-1 \
  -er http://localhost:7071 create-user -a idle -s FIXTURE-SECRET-idle-0000000000000 -r userplus >/dev/null

refuses "an id shaped as a query injection is refused" "not an inventory id" vgw check 'inventoryId=" || true || "'
refuses "an id nobody wrote is refused" "has no inventory record" vgw check inventoryId=00000000-0000-4000-8000-000000000000
refuses "a rule that does not exist is refused" "no-such-rule|invalid" vgw check 'rules=["no-such-rule"]'
refuses "failOnFindings fails the run" "findings in inventory" vgw check failOnFindings=true
holds "allowing every role and switching off the rest leaves it clean" \
  '.dataArtifacts[] | select(.name == "check") | .attributes.clean' \
  vgw check 'rules=["account-role"]' 'allowedRoles=["user","userplus","admin"]'
summary
