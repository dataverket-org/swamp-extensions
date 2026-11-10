#!/usr/bin/env bash
# What only a running container shows: what is in its environment, with and
# without passProxy; the engine's own time limit; an interrupted run; a
# lookup with no network; and swamp itself killed while a container runs.
# Needs no network. Run it last: the killed run keeps the lock of its model.
source "$(dirname "$0")/harness.sh"
echo "=== the running container ($RUNTIME) ==="
BEFORE=$(stamp)

# Interrupted while a container runs: the run ends as cancelled, writes
# nothing, and the container is removed although its client was stopped. While
# it runs: the host's proxy variables, set for swamp with a password in them,
# are not in the container, and the engine holds a time limit of its own.
start rn-hang fix/uptodate
check "the interrupted run had started its container" leftover
check "the method's log names the container before it ends" grep -q "$(running)" "$ERR" "$REPO"/.swamp/outputs -r
never "the host's proxy variables are not in the container" sh -c "$RUNTIME inspect --format '{{json .Config.Env}}' $(running) | grep -qi proxy"
check "the container's environment was read" sh -c "$RUNTIME inspect --format '{{json .Config.Env}}' $(running) | grep -q LOG_FORMAT=json"
check "the engine itself stops the container 30 seconds after the client's limit" test "$("$RUNTIME" inspect --format '{{.Config.Timeout}}' "$(running)")" = 40
kill -INT "$SWAMP"; wait "$SWAMP"
check "an interrupted run ends as cancelled" test "$(jq -r .status "$OUT")" = cancelled
check "and wrote no record" test "$(jq '.dataArtifacts | length' "$OUT")" = 0
check "and its container is not left behind" gone

# With passProxy the variables are in the container, and the password in
# them is in nothing swamp keeps.
start rn-proxy fix/uptodate
check "with passProxy the proxy variables are in the container" sh -c "$RUNTIME inspect --format '{{json .Config.Env}}' $(running) | grep -q 'HTTPS_PROXY=http://alice:'"
wait "$SWAMP"
check "that run passed its limit and is recorded" test "$(rec repo-fix_2fuptodate | jq -r .failure)" = timeout
never "the proxy's password is nowhere in swamp's data or output" planted
check "its container is not left behind" gone

holds "with no network Renovate exits zero and the record says failed" repo-fix_2fmixed \
  '.status == "failed" and .failure == "result" and (.reason | test("external-host-error")) and (.upToDate | not) and .configRead == "renovate.json"' rn-nonet repo=fix/mixed

# swamp itself killed while a container runs: nothing is left to remove it,
# so the engine's own limit must. Last, because the killed run keeps the
# lock of its model.
start rn-killed fix/uptodate
check "the run to be killed had started its container" leftover
kill -KILL "$SWAMP"; wait "$SWAMP" 2>/dev/null
check "the container outlives a killed swamp" leftover
check "and the engine stops it at its own limit, within a minute" gone 120

never "no container of this type is left" leftover
check "no fixture was changed" test "$(stamp)" = "$BEFORE"
summary
