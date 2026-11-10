#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== D. the methods that change something, on their working paths ==="
# Run last: this batch suspends and resumes, and at its end the release
# `hooked` is upgraded, so batches a to c no longer find the failed upgrade.
HERE=$(cd "$(dirname "$0")" && pwd)

echo "--- helmrelease ---"
holds "suspend records the release as suspended" \
  '.name == "podinfo" and .namespace == "apps" and .suspended' \
  hr-apps suspend name=podinfo
also "... under the name list uses, as one helmrelease record" \
  '[.dataArtifacts[] | [.name]] == [["apps--podinfo"]]'
holds "resume records it as running again, and ready" \
  '(.suspended | not) and .ready' \
  hr-apps resume name=podinfo
holds "reconcile waits for the release and records that the request was handled" \
  '.ready and .lastHandledReconcileAt != null and .appliedVersion != ""' \
  hr-apps reconcile name=podinfo
FIRST=$(jq -r '.dataArtifacts[0].attributes.lastHandledReconcileAt' "$OUT")
sleep 1
holds "reconcile with its source reconciles the OCIRepository first, then the release" \
  ".ready and .lastHandledReconcileAt != null and .lastHandledReconcileAt != \"$FIRST\"" \
  hr reconcile name=podinfo namespace=apps withSource=true

echo "--- kustomization ---"
run ks list
also "list writes <namespace>--<name> with the fifteen fields it had" \
  '([.dataArtifacts[].name] == ["apps--podinfo"]) and (.dataArtifacts[0].attributes | .ready and .path == "./kustomize" and .prune and .targetNamespace == "ks-apps" and .sourceRef.kind == "GitRepository" and (.lastAppliedRevision | startswith("6.9.2@sha1:")) and ((keys - ["conditions","interval","lastAppliedRevision","lastAttemptedRevision","name","namespace","observedGeneration","path","prune","ready","readyMessage","readyReason","sourceRef","suspended","targetNamespace"]) == []))'
holds "suspend records the Kustomization as suspended" '.name == "podinfo" and .suspended' ks suspend name=podinfo
holds "resume records it as running again, and ready" '(.suspended | not) and .ready' ks resume name=podinfo
holds "reconcile waits for it and records the applied revision" \
  '.ready and (.lastAppliedRevision | startswith("6.9.2@sha1:"))' ks reconcile name=podinfo
holds "reconcile with its source reconciles the GitRepository first" \
  '.ready and (.lastAppliedRevision | startswith("6.9.2@sha1:"))' ks reconcile name=podinfo withSource=true

echo "--- source ---"
run src list
also "list writes <kind>--<namespace>--<name> for all three kinds" \
  '[.dataArtifacts[].name] | sort == ["GitRepository--apps--podinfo","HelmRepository--apps--local","OCIRepository--apps--podinfo"]'
also "... each ready, with its URL, and an artifact revision" \
  '.dataArtifacts | all(.attributes | .ready and .url != "" and .artifact.revision != null and ((keys - ["artifact","conditions","interval","kind","name","namespace","observedGeneration","ready","readyMessage","readyReason","ref","suspended","url"]) == []))'
run src list kind=GitRepository namespace=apps
also "list with kind and namespace reads that kind only" \
  '[.dataArtifacts[].name] == ["GitRepository--apps--podinfo"]'

echo "--- reset ---"
run hr-apps list
refuses "reset by a reader who may read the release and not change it: flux fails, nothing was reset, and a ready release does not make that a success" \
  'flux reconcile failed.*the reset was not handled' hr-reader reset name=podinfo namespace=apps
fails "reset of a release whose hook still fails: the attempt fails again and the method says what flux said" \
  'flux reconcile failed' hr-apps reset name=hooked
latest "... and what the object says afterwards was recorded all the same, as reset.apps--hooked" \
  hr-apps reset.apps--hooked '(.ready | not) and .upgradeFailures >= 1 and .deployStatus == "failed"'
"$HERE/cluster.sh" heal
holds "reset after the cause is gone: the upgrade is tried again and succeeds" \
  '.name == "hooked" and .ready and .upgradeFailures == 0 and .installFailures == 0 and .deployStatus == "deployed"' \
  hr-apps reset name=hooked
also "... stored as the resetResult reset.apps--hooked" \
  '[.dataArtifacts[] | .name] == ["reset.apps--hooked"]'
latest "... and the record list wrote for the release is still the newest under apps--hooked" \
  hr-apps apps--hooked 'has("appliedVersion") and has("chartName") and (has("installFailures") | not)'
holds "... and get agrees: an upgrade that succeeded, no longer stalled" \
  '.lastAction == "upgrade" and .lastActionOutcome == "succeeded" and (.stalled | not) and .lastAppliedRevision == "0.2.0"' \
  hr-apps get name=hooked
summary
