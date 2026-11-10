#!/usr/bin/env bash
# The models the suite runs, in the swamp repository $REPO.
set -euo pipefail
: "${REPO:?set REPO to a swamp repository that loads this extension from source}"
RUNTIME=${RUNTIME:-podman}
IMAGE=${RENOVATE_IMAGE:?set RENOVATE_IMAGE to the Renovate image to test with, tag included}

m() { # name args...
  local name=$1; shift
  (cd "$REPO" && swamp model create @dataverket/renovate/local "$name" \
    --global-arg containerBinary="$RUNTIME" "$@" --json >/dev/null)
}

# The real Renovate. The suite never pulls: the image must be held already.
m rn --global-arg image="$IMAGE" --global-arg pull=never --global-arg timeoutSeconds=150
m rn-debug --global-arg image="$IMAGE" --global-arg pull=never --global-arg timeoutSeconds=150 --global-arg logLevel=debug
# The stand-ins of fixtures.sh.
m rn-hang --global-arg image=localhost/renovate-smoke-hang:1 --global-arg pull=never --global-arg timeoutSeconds=10
m rn-garbage --global-arg image=localhost/renovate-smoke-garbage:1 --global-arg pull=never
m rn-exit3 --global-arg image=localhost/renovate-smoke-exit3:1 --global-arg pull=never
m rn-killed --global-arg image=localhost/renovate-smoke-hang:1 --global-arg pull=never --global-arg timeoutSeconds=10
m rn-proxy --global-arg image=localhost/renovate-smoke-hang:1 --global-arg pull=never --global-arg timeoutSeconds=10 --global-arg passProxy=true
# The real Renovate with no network at all.
m rn-nonet --global-arg image="$IMAGE" --global-arg pull=never --global-arg timeoutSeconds=150 --global-arg network=none
# An image the engine does not hold: not pulled, and one no registry serves.
m rn-notheld --global-arg image=localhost/renovate-smoke-absent:1 --global-arg pull=never
m rn-nopull --global-arg image=localhost/renovate-smoke-absent:1 --global-arg pullTimeoutSeconds=60
# No argument at all: swamp accepts the definition, the method must not.
(cd "$REPO" && swamp model create @dataverket/renovate/local rn-noimage --json >/dev/null)
# A container binary that is not there.
(cd "$REPO" && swamp model create @dataverket/renovate/local rn-nobin \
  --global-arg containerBinary="$REPO/no-such-engine" --global-arg image="$IMAGE" --json >/dev/null)
echo "models created in $REPO"

# Two workflows over the records: one whose assertion holds for the fixture
# that is up to date, one that must fail on the fixture with old pins.
w() { # name repository-path data-name
  cat > "$REPO/workflows/workflow-$1.yaml" <<EOF
id: $(cat /proc/sys/kernel/random/uuid)
name: $1
description: Look one repository up and assert that no major update is pending.
version: 1
jobs:
  - name: lookup
    steps:
      - name: renovate
        task:
          type: model_method
          modelIdOrName: rn
          methodName: lookup
          inputs:
            repos:
              - $2
  - name: verify
    dependsOn:
      - job: lookup
        condition:
          type: succeeded
    steps:
      - name: no-major-update-pending
        task:
          type: assert
          expr: >-
            data.latest("rn", "$3").attributes.lookupComplete
            && data.latest("rn", "$3").attributes.updateCounts.major == 0
          message: >-
            $2 has a major update pending, or its lookup was not complete
          severity: high
EOF
}
w smoke-current fix/uptodate repo-fix_2fuptodate
w smoke-outdated fix/mixed repo-fix_2fmixed
echo "workflows written in $REPO/workflows"
