#!/usr/bin/env bash
# What must be refused, and what must be recorded instead of thrown, without
# any registry: arguments, paths, a missing engine, a missing image, and a
# Renovate that hangs, prints something else or exits non-zero. Needs no
# network.
source "$(dirname "$0")/harness.sh"
echo "=== refusals and recorded states ($RUNTIME) ==="
BEFORE=$(stamp)

refuses "repo and repos together" 'not both' rn repo=fix/mixed 'repos=["fix/uptodate"]'
refuses "neither repo nor repos" 'give repo, one directory, or repos' rn
refuses "an empty list" 'repos is empty' rn 'repos=[]'
refuses "one value where a list is expected" 'expected array' rn repos=fix/mixed
refuses "a list where one value is expected" 'give a list as repos' rn 'repo=["fix/mixed"]'
refuses "the same directory twice" 'same directory twice' rn 'repos=["fix/mixed","fix/mixed"]'
refuses "the same directory under two spellings" 'same directory twice' rn 'repos=["fix/mixed","./fix/../fix/mixed/"]'
refuses "a path shaped like a long flag" 'is refused' rn repo=--privileged
refuses "a path shaped like a short flag, in a list" 'is refused' rn 'repos=["fix/mixed","-v"]'
refuses "an empty path" 'is refused|repo' rn repo=
refuses "a directory with a comma in its name" 'holds a comma or a double quote' rn 'repo=fix/a,b'
refuses "a directory with a double quote in its name" 'holds a comma or a double quote' rn 'repo=fix/a"b'
refuses "a path whose data name would be too long" 'more than the 255' rn "repo=$(printf 'a/%.0s' $(seq 1 100))a"
refuses "a container binary that is not there, named by the check" 'no-such-engine was not found.*containerBinary' rn-nobin repo=fix/mixed
refuses "a definition with no argument at all, which swamp accepts: there is no default image" 'image argument is not set' rn-noimage repo=fix/mixed
refuses "an image the engine does not hold, with pull never" 'is not held by .* and pull is never' rn-notheld repo=fix/mixed
refuses "an image no registry serves" 'pull localhost/renovate-smoke-absent:1 failed' rn-nopull repo=fix/mixed

# Definitions swamp must not accept.
no_definition() { # name pattern global-arg...
  local name=$1 pattern=$2; shift 2
  local args=()
  for kv in "$@"; do args+=(--global-arg "$kv"); done
  if (cd "$REPO" && swamp model create @dataverket/renovate/local "refused-$RANDOM" "${args[@]}" --json) >"$OUT" 2>"$ERR"; then
    bad "$name" "the definition was accepted"
  elif cat "$OUT" "$ERR" | grep -qiE "$pattern"; then ok "$name"
  else bad "$name" "message did not match /$pattern/: $(said)"; fi
}
no_definition "no image beside another argument: there is no default" 'image' containerBinary=podman
no_definition "an image shaped like a flag" 'image' image=--privileged
no_definition "an image with a space" 'image' 'image=a b'
no_definition "a time limit under ten seconds" 'timeoutSeconds' image=x:1 timeoutSeconds=5
no_definition "a time limit over an hour" 'timeoutSeconds' image=x:1 timeoutSeconds=3601
no_definition "the host's network" 'network' image=x:1 network=host
no_definition "another container's network" 'network' image=x:1 network=container:other
no_definition "a network mode with options that open the host's loopback" 'network' image=x:1 network=slirp4netns:allow_host_loopback=true
no_definition "a log level that hides the report" 'logLevel' image=x:1 logLevel=warn

# Recorded, not thrown.
holds "a path that does not exist is recorded" repo-fix_2fmissing \
  '.status == "not-a-directory" and (.ok | not) and (.upToDate | not) and (.reason | test("does not exist"))' rn repo=fix/missing
holds "a file is recorded as no directory" repo-fix_2ffile \
  '.status == "not-a-directory" and (.reason | test("is not a directory"))' rn repo=fix/file
holds "a directory without a Renovate configuration is recorded, and Renovate is not run" repo-fix_2fnoconfig \
  '.status == "no-config" and (.ok | not) and (.upToDate | not) and .renovateVersion == null and .durationMs < 1000' rn repo=fix/noconfig
holds "a configuration under .forgejo is not one local mode reads" repo-fix_2fforgejo-only '.status == "no-config"' rn repo=fix/forgejo-only
holds "a path shaped like shell text is a path" 'repo-_24_28id_29' '.status == "not-a-directory" and .path == "$(id)"' rn 'repo=$(id)'

holds "a Renovate that hangs is stopped at the limit and recorded" repo-fix_2fmixed \
  '.status == "failed" and .failure == "timeout" and (.upToDate | not) and (.reason | test("within 10 seconds")) and .durationMs >= 10000 and .durationMs < 40000' rn-hang repo=fix/mixed
never "its container is not left behind" leftover
holds "a Renovate that prints something else: no report, and the text is not kept" repo-fix_2fmixed \
  '.status == "failed" and .failure == "no-report" and (.upToDate | not) and (tostring | test("Bad Gateway") | not)' rn-garbage repo=fix/mixed
holds "a Renovate that exits non-zero: recorded with what it said" repo-fix_2fmixed \
  '.status == "failed" and .failure == "exit" and (.reason | test("exit 3")) and (.reason | test("boom"))' rn-exit3 repo=fix/mixed
never "the token it printed is nowhere in swamp's data or output" planted

holds "a list of states in one run: every one recorded, the method succeeds" inventory_all \
  '.count == 4 and .okCount == 0 and .failedCount == 1 and .noConfigCount == 1 and .notADirectoryCount == 2 and .upToDateCount == 0 and ([.items[].status] == ["not-a-directory","failed","no-config","not-a-directory"])' \
  rn-exit3 'repos=["fix/missing","fix/mixed","fix/noconfig","fix/file"]'
also "the failing one did not stop the ones after it" repo-fix_2fnoconfig '.status == "no-config"'

holds "a path that climbs with .. is recorded under a name swamp stores" 'repo-fix_2fdeep_2fer_2f._2e_2f._2e_2fmissing' \
  '.status == "not-a-directory" and .path == "fix/deep/er/../../missing" and (.directory | endswith("/fix/missing"))' rn repo=fix/deep/er/../../missing
holds "a path above the swamp repository too" 'repo-_2e._2f._2e_2fnowhere' '.status == "not-a-directory"' rn repo=../../nowhere
holds "a path named like one of swamp's own reports keeps a record of its own" 'repo-report-swamp-method-summary' \
  '.status == "not-a-directory" and .path == "report-swamp-method-summary"' rn repo=report-swamp-method-summary
check "and swamp's report of that run is stored beside it, not over it" test "$(cd "$REPO" && swamp data query 'modelName == "rn" && (name == "report-swamp-method-summary" || name == "repo-report-swamp-method-summary")' --json 2>/dev/null | jq '[.results[].name] | unique | length')" = 2
refuses "a path that is not well-formed Unicode, which only JSON input can carry" 'not well-formed Unicode' rn '{"repo":"a\ud800"}'
holds "a symlink to a device where a configuration would be is not read" repo-fix_2fdevzero \
  '.status == "no-config" and .durationMs < 1000' rn repo=fix/devzero
holds "a FIFO where a configuration would be is not opened" repo-fix_2ffifo \
  '.status == "no-config" and .durationMs < 1000' rn repo=fix/fifo
refuses "a symlink to a directory of the list is the same directory twice" 'same directory twice' rn 'repos=["fix/uptodate","fix/link-to-uptodate"]'
never "no container of this type is left" leftover
check "no fixture was changed" test "$(stamp)" = "$BEFORE"
summary
