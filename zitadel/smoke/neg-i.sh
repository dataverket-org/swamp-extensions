#!/usr/bin/env bash
source ./negative.sh
echo "=== I. actions: targets and executions ==="

# Start from nothing, so "created" means created and not "was already there".
run zitadel-action delete target=selftest-hook confirm=selftest-hook dryRun=false >/dev/null 2>&1

acts  "a target is created and its signing key comes back once" created target-credential \
  zitadel-action ensure name=selftest-hook endpoint=https://example.com/zitadel-hook style=webhook
holds "... and the stored target carries no signing key" '[.dataArtifacts[] | select(.name == "target-selftest-hook") | .attributes | has("signingKey")] | all(. == false)' \
  zitadel-action get target=selftest-hook
acts  "converging it again mints no new key" updated target-selftest-hook \
  zitadel-action ensure name=selftest-hook endpoint=https://example.com/zitadel-hook style=webhook
holds "the catalog says which conditions this instance accepts" '[.dataArtifacts[] | select(.name | startswith("catalog-")) | .attributes.values | length] | any(. > 0)' \
  zitadel-action catalog

refuses "an execution with no condition is refused" \
  "exactly one condition" \
  zitadel-action executionSet 'targets=["selftest-hook"]'
refuses "an execution naming a target that is not there is refused" \
  'no target "ghost-hook"' \
  zitadel-action executionSet event=user.human.added 'targets=["ghost-hook"]'
acts  "an execution binds an event to a target" updated execution-event-user-human-added \
  zitadel-action executionSet event=user.human.added 'targets=["selftest-hook"]'
holds "... and it is listed with that target" '[.dataArtifacts[] | select(.attributes.condition == "event-user.human.added") | .attributes.targets | length] | any(. > 0)' \
  zitadel-action executionList
acts  "removing it under dryRun changes nothing" planned execution-deletion \
  zitadel-action executionRemove event=user.human.added dryRun=true
holds "... so it is still bound" '[.dataArtifacts[] | select(.attributes.condition == "event-user.human.added") | .attributes.targets | length] | any(. > 0)' \
  zitadel-action executionList
acts  "removing it for real clears the condition" removed execution-deletion \
  zitadel-action executionRemove event=user.human.added dryRun=false

refuses "a target that is not there is named" \
  'no target "ghost-hook"' \
  zitadel-action get target=ghost-hook
refuses "delete refuses a confirm that is not the target's name" \
  "refusing to delete target name" \
  zitadel-action delete target=selftest-hook confirm=selftest-hooks dryRun=false
acts  "delete under dryRun reports a plan" planned target-deletion \
  zitadel-action delete target=selftest-hook confirm=selftest-hook dryRun=true
acts  "deleting a target that is already gone is a no-op" unchanged target-deletion \
  zitadel-action delete target=ghost-hook confirm=ghost-hook dryRun=false
acts  "removing a public key the target does not have is a no-op" unchanged public-key-deletion \
  zitadel-action keyRemove target=selftest-hook keyId=999999999999999999 dryRun=false
refuses "a public key that is not a key is refused by Zitadel" \
  "HTTP 4[0-9][0-9]|invalid" \
  zitadel-action keyAdd target=selftest-hook publicKey="not a key"
refuses "an endpoint Zitadel cannot resolve says why, not just a code" \
  "resolves the host first" \
  zitadel-action ensure name=unreachable-hook endpoint=https://hooks.invalid/zitadel style=webhook
summary
