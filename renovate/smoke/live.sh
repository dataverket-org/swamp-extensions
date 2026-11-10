#!/usr/bin/env bash
# The real Renovate against the real registries: old pins have newer
# versions, a retired package has none, a registry that does not exist is an
# unresolved lookup, a refused configuration is a failure, and several
# repositories go through one method run. Needs network access to Docker Hub
# and the npm registry. Asserts that an old pin HAS a newer version, never
# which one.
source "$(dirname "$0")/harness.sh"
echo "=== lookups against live registries ($RUNTIME) ==="
BEFORE=$(stamp)
has() { # depName: an update for it whose new version is not the old one
  printf '([.updates[] | select(.depName == "%s" and .newVersion != null and .newVersion != .currentVersion)] | length >= 1)' "$1"
}

holds "old pins: Renovate ran and its report was read" repo-fix_2fmixed \
  '.status == "ok" and .ok and .failure == null and .reason == null and .git and .configFile == "renovate.json" and .configRead == "renovate.json" and .packageFileCount == 4 and .lookedUpCount >= 4 and (.renovateVersion | test("^[0-9]+\\.[0-9]+\\.[0-9]+"))' rn repo=fix/mixed
also "the image in the Dockerfile has a newer version" repo-fix_2fmixed "$(has alpine)"
also "the image in the Kubernetes manifest has a newer version" repo-fix_2fmixed "$(has nginx)"
also "the npm package has a newer version" repo-fix_2fmixed "$(has lodash)"
also "redis 6 has a major update pending" repo-fix_2fmixed \
  '.updateCounts.major >= 1 and ([.updates[] | select(.depName == "redis" and .updateType == "major")] | length >= 1)'
also "each update names its manager, file and datasource" repo-fix_2fmixed \
  '([.updates[] | select(.depName == "nginx")][0] | .manager == "kubernetes" and .packageFile == "kube/deploy.yaml" and .datasource == "docker" and .currentValue == "1.25.0")'
also "the counts agree with the list" repo-fix_2fmixed \
  '.updateCount == (.updates | length) and .updateCount == ([.updateCounts[]] | add) and .outdatedCount >= 4 and (.truncated | not)'
also "without a token the GitHub Action is skipped, and that is said" repo-fix_2fmixed \
  '.tokenRequiredCount == 1 and ([.skipped[] | select(.depName == "actions/checkout" and .reason == "github-token-required")] | length == 1) and ([.warnings[] | select(.message | test("GitHub token is required"))] | length == 1)'
also "so the lookup is not complete and the repository is not called up to date" repo-fix_2fmixed \
  '(.lookupComplete | not) and (.upToDate | not)'

holds "a retired package at its last release is up to date" repo-fix_2fuptodate \
  '.status == "ok" and .lookupComplete and .upToDate and .updateCount == 0 and .dependencyCount == 1 and .unresolvedCount == 0 and .updates == []' rn repo=fix/uptodate
holds "an image no registry serves is unresolved, the one beside it is looked up" repo-fix_2funresolved \
  ".status == \"ok\" and .unresolvedCount == 1 and (.unresolved[0].depName == \"registry.invalid/none/such\") and (.lookupComplete | not) and (.upToDate | not) and $(has alpine)" rn repo=fix/unresolved
holds "a configuration Renovate refuses is a failure, although Renovate exits zero" repo-fix_2fbadconfig \
  '.status == "failed" and .failure == "result" and (.reason | test("config-validation")) and (.reason | test("noSuchOption")) and (.upToDate | not)' rn repo=fix/badconfig
never "the value planted in that configuration is nowhere in swamp's data or output" planted

holds "in a Git repository a change that is not committed is read" repo-fix_2fdirty \
  '.git and ([.updates[] | select(.depName == "alpine")][0].currentValue == "3.17.0")' rn repo=fix/dirty
also "and a file Git does not track is not" repo-fix_2fdirty '([.updates[] | select(.depName == "redis")] | length == 0)'
holds "in a plain directory every file is read" repo-fix_2fplain \
  '(.git | not) and .status == "ok" and ([.updates[] | select(.depName == "redis")] | length >= 1)' rn repo=fix/plain
holds "a directory only its owner can enter is read" repo-fix_2fprivate ".status == \"ok\" and $(has alpine)" rn repo=fix/private
holds "a path with a space and a colon" 'repo-fix_2fwith_20space_3acolon' ".status == \"ok\" and $(has alpine)" rn 'repo=fix/with space:colon'
holds "an absolute path, and its data name" "repo-$(printf '%s' "$REPO/fix/uptodate" | sed 's/_/_5f/g; s|/|_2f|g')" \
  ".upToDate and .path == \"$REPO/fix/uptodate\" and .directory == \"$REPO/fix/uptodate\"" rn "repo=$REPO/fix/uptodate"
holds "logLevel debug gives the same findings" repo-fix_2fuptodate '.upToDate and .dependencyCount == 1' rn-debug repo=fix/uptodate

holds "a path with two dots in a name is looked up and stored" 'repo-fix_2fmy._2erepo' '.status == "ok" and .upToDate and .lookedUpCount == 1' rn repo=fix/my..repo
holds "and one that climbs with .." 'repo-fix_2fdeep_2fer_2f._2e_2f._2e_2fuptodate' '.status == "ok" and .upToDate' rn repo=fix/deep/er/../../uptodate

holds "several repositories in one run: one record each and one inventory" inventory_all \
  '.count == 6 and .okCount == 3 and .failedCount == 1 and .noConfigCount == 1 and .notADirectoryCount == 1 and .upToDateCount == 1 and .outdatedCount == 2 and .incompleteCount == 2 and .updateCounts.major >= 1 and (.renovateVersion != null) and (.engine | test("^(podman|docker) [0-9]"))' \
  rn 'repos=["fix/mixed","fix/uptodate","fix/noconfig","fix/missing","fix/badconfig","fix/unresolved"]'
also "the inventory lists them in the order given, with their data names" inventory_all \
  '([.items[].dataName] == ["repo-fix_2fmixed","repo-fix_2fuptodate","repo-fix_2fnoconfig","repo-fix_2fmissing","repo-fix_2fbadconfig","repo-fix_2funresolved"]) and ([.items[].status] == ["ok","ok","no-config","not-a-directory","failed","ok"])'
also "the failed one did not stop the one after it" repo-fix_2funresolved '.status == "ok"'
check "the run wrote seven records" test "$(jq '.dataArtifacts | length' "$OUT")" = 7
also "the inventory's totals are the sum of the records" inventory_all \
  '.updateCount == ([.items[].updateCount] | add) and .updateCounts.major == ([.items[].majorCount] | add)'

wf() { (cd "$REPO" && swamp workflow run "$1" --json) >"$OUT" 2>"$ERR"; }
check "a workflow asserts that no major update is pending, and it holds for the current one" wf smoke-current
never "the same assertion fails for the repository with old pins" wf smoke-outdated
check "and it failed in the assertion, not in the lookup" grep -q 'major update pending' "$OUT" "$ERR"

never "no container of this type is left" leftover
check "no fixture was changed: content, modes and git status" test "$(stamp)" = "$BEFORE"
summary
