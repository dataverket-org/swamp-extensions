#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== A. what get records, release by release ==="

holds "an upgraded release: upgrade, succeeded, read from the status field" \
  '.lastAction == "upgrade" and .lastActionOutcome == "succeeded" and .lastActionSource == "lastAttemptedReleaseAction" and .ready' \
  hr get name=podinfo namespace=apps
also "... stored as detail.apps--podinfo, one record" \
  '[.dataArtifacts[].name] == ["detail.apps--podinfo"]'
also "... two history entries, newest first: 2 deployed over 1 superseded" \
  '.dataArtifacts[0].attributes.history | map([.version, .status]) == [[2,"deployed"],[1,"superseded"]]'
also "... each with chart, app version, both times and three digests" \
  '.dataArtifacts[0].attributes.history | all(.chartName == "podinfo" and (.chartVersion | startswith("6.9.")) and (.appVersion | startswith("6.9.")) and .firstDeployed != null and .lastDeployed != null and (.digest | startswith("sha256:")) and (.configDigest | startswith("sha256:")) and (.ociDigest | startswith("sha256:")))'
also "... applied is the attempted revision, counters at zero, not stalled" \
  '.dataArtifacts[0].attributes | .lastAppliedRevision == .lastAttemptedRevision and .lastAppliedReleaseVersion == 2 and .failures == 0 and .installFailures == 0 and .upgradeFailures == 0 and (.stalled | not)'
also "... no Job is labelled for it, and that is a read answer" \
  '.dataArtifacts[0].attributes | .jobsRead and .jobs == []'

holds "a failed upgrade: upgrade, failed, stalled, and not an error" \
  '.lastAction == "upgrade" and .lastActionOutcome == "failed" and .releasedReason == "UpgradeFailed" and .stalled and (.ready | not)' \
  hr-apps get name=hooked
also "... the record is current: generation 2 was observed" \
  '.dataArtifacts[0].attributes | .generation == 2 and .observedGeneration == 2'
also "... the counters say one upgrade failure and no install failure" \
  '.dataArtifacts[0].attributes | .failures == 1 and .upgradeFailures == 1 and .installFailures == 0'
also "... a failed entry over the deployed one; attempted 0.2.0, applied 0.1.0" \
  '.dataArtifacts[0].attributes | (.history | map([.version, .status, .action]) == [[2,"failed","upgrade"],[1,"deployed","install"]]) and .lastAttemptedRevision == "0.2.0" and .lastAppliedRevision == "0.1.0" and .lastAppliedReleaseVersion == 1'
also "... the test hook of revision 1 succeeded; revision 2 was never tested" \
  '.dataArtifacts[0].attributes.history | (.[1].tested and (.[1].testHooks | map([.name, .phase]) == [["hooked-test","Succeeded"]])) and (.[0].tested | not) and .[0].testHooks == []'
also "... the pre-install hook Job succeeded and the pre-upgrade one failed" \
  '.dataArtifacts[0].attributes.jobs | map([.name, .hooks, .state, .succeeded, .failed]) == [["hooked-pre-install",["pre-install"],"succeeded",1,0],["hooked-pre-upgrade",["pre-upgrade"],"failed",0,1]]'
also "... the post-install Job, deleted by its hook-succeeded policy, is simply absent" \
  '.dataArtifacts[0].attributes.jobs | map(.name) | index("hooked-post-install") == null'
also "... a failed Job has a reason and no completion time" \
  '.dataArtifacts[0].attributes.jobs[1] | .reason == "BackoffLimitExceeded" and .completionTime == null'

holds "a release that never installed: no history, action unknown, no outcome" \
  '.history == [] and .lastAction == "unknown" and .lastActionSource == "none" and .lastActionOutcome == "unknown" and .readyReason == "SourceNotReady" and .lastAppliedRevision == null and .jobs == []' \
  hr get name=noversion namespace=apps

run hr list
also "list still writes <namespace>--<name>, one record per release" \
  '[.dataArtifacts[].name] | sort == ["apps--hooked","apps--noversion","apps--podinfo"]'
also "... with the sixteen fields it had, and none of get's" \
  '.dataArtifacts | all(.attributes | (keys - ["appVersion","appliedVersion","chartName","conditions","deployStatus","lastAttemptedRevision","lastHandledReconcileAt","name","namespace","observedGeneration","ready","readyMessage","readyReason","requestedVersion","sourceRef","suspended"]) == [])'
summary
