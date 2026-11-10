#!/usr/bin/env bash
# What Renovate did with the repository's configuration: every form it reads
# is recorded as read, a file it did not read is said, and a lookup that
# covered nothing is not called up to date. Needs network access to Docker
# Hub and the npm registry.
source "$(dirname "$0")/harness.sh"
echo "=== configurations ($RUNTIME) ==="
BEFORE=$(stamp)
has() { # depName: an update for it whose new version is not the old one
  printf '([.updates[] | select(.depName == "%s" and .newVersion != null and .newVersion != .currentVersion)] | length >= 1)' "$1"
}

holds "a renovate key in package.json is a configuration Renovate read" repo-fix_2fpkg-config \
  ".status == \"ok\" and .ok and .configFile == \"package.json\" and .configRead == \"package.json\" and .lookedUpCount >= 1 and $(has lodash)" rn repo=fix/pkg-config
holds "and it is obeyed: a key that switches Renovate off ends as disabled, with the key read" repo-fix_2fpkg-disabled \
  '.status == "failed" and .failure == "result" and (.reason | test("disabled-by-config")) and .configRead == "package.json"' rn repo=fix/pkg-disabled
holds "a JSON5 file under .github, with a comment in it" repo-fix_2fgithub-json5 \
  ".status == \"ok\" and .configFile == \".github/renovate.json5\" and .configRead == \".github/renovate.json5\" and $(has alpine)" rn repo=fix/github-json5
holds "a .renovaterc" repo-fix_2frenovaterc ".status == \"ok\" and .configRead == \".renovaterc\" and $(has alpine)" rn repo=fix/renovaterc

holds "another manager only: nothing was looked up, so not ok and not up to date, with an old pin present" repo-fix_2fonly-npm \
  '.status == "nothing-looked-up" and (.ok | not) and (.upToDate | not) and .lookedUpCount == 0 and .packageFileCount == 0 and .configRead == "renovate.json" and (.reason | test("looked up none"))' rn repo=fix/only-npm
holds "every package disabled: the same, with the dependency counted as skipped" repo-fix_2fall-disabled \
  '.status == "nothing-looked-up" and (.upToDate | not) and .lookedUpCount == 0 and .packageFileCount == 1 and .dependencyCount == 1 and .skippedCount == 1' rn repo=fix/all-disabled
holds "no package file: the same" repo-fix_2fno-package-file '.status == "nothing-looked-up" and (.upToDate | not) and .dependencyCount == 0' rn repo=fix/no-package-file
holds "a configuration Git does not track is not read, and the record says so" repo-fix_2funtracked-config \
  '.status == "config-not-read" and (.ok | not) and (.upToDate | not) and .configFile == "renovate.json" and .configRead == null and .git and (.reason | test("Git does not track"))' rn repo=fix/untracked-config
also "what Renovate proposed on its defaults is still listed" repo-fix_2funtracked-config '.updateCount >= 1'
also "the old pins: what was looked up is counted" repo-fix_2funtracked-config '.lookedUpCount == 1 and .packageFileCount == 1'

never "no container of this type is left" leftover
check "no fixture was changed: content, modes and git status" test "$(stamp)" = "$BEFORE"
summary
