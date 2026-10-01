#!/usr/bin/env bash
#
# Live check that deleting one member of a collection model leaves the others
# readable: three 1 GiB volumes and three images from a small disk image file,
# one of each deleted, the other two read back through swamp, then all removed.
# Run from a swamp repository that has this extension as a source. See
# README.md in this directory.
#

cloud="${CLOUD:?CLOUD names a clouds.yaml entry}"
image_file="${IMAGE_FILE:?IMAGE_FILE is a small qcow2 disk image}"
prefix="swamp-smoke-$$"
failures=0

#
# Prints a passed or failed check and counts the failures.
#
function check()
{
	local what="$1"
	local result="$2"

	if [[ "$result" == 0 ]]; then
		echo "PASS  $what"
	else
		echo "FAIL  $what"
		failures=$((failures + 1))
	fi
}

#
# Runs a model method with key=value inputs; its JSON goes to stdout.
#
function method()
{
	local model="$1"
	local name="$2"
	local input
	shift 2

	local args=()
	for input in "$@"; do args+=(--input "$input"); done
	swamp model method run "$model" "$name" "${args[@]}" --json 2>/dev/null
}

#
# Creates a model of a type unless one of that name exists.
#
function ensure_model()
{
	local type="$1"
	local name="$2"

	swamp model get "$name" --json >/dev/null 2>&1 && return 0
	swamp model create "$type" "$name" --global-arg "cloud=$cloud" \
		>/dev/null || return $?
}

#
# Succeeds when a method run reports success.
#
function succeeds()
{
	method "$@" | jq -e '.status == "succeeded"' >/dev/null
}

#
# Succeeds when a get fails for a reason other than swamp's tombstone refusal.
#
function fails_upstream()
{
	local out

	out="$(method "$@")"
	[[ "$(jq -r '.status // "error"' <<<"$out")" != "succeeded" ]] &&
		! grep -q "run a 'create' method" <<<"$out"
}

#
# Deletes one member and checks its two siblings are still readable.
#
function exercise()
{
	local model="$1"
	local key="$2"
	local a="$prefix-a" b="$prefix-b" c="$prefix-c"

	succeeds "$model" delete "$key=$a"
	check "$model: delete $a" $?
	succeeds "$model" get "$key=$b"
	check "$model: get $b after deleting a sibling" $?
	succeeds "$model" get "$key=$c"
	check "$model: get $c after deleting a sibling" $?
	fails_upstream "$model" get "$key=$a"
	check "$model: get $a fails as not found, not as a tombstone" $?
	succeeds "$model" delete "$key=$a"
	check "$model: delete $a again is a no-op" $?
	succeeds "$model" get "$key=$b"
	check "$model: get $b after the no-op delete" $?
}

#
# Removes everything this run made; deleting what is gone is a no-op.
#
# shellcheck disable=SC2329  # called from the EXIT trap
function cleanup()
{
	local s

	for s in a b c; do
		method smoke-volume delete "volume=$prefix-$s" >/dev/null
		method smoke-image delete "image=$prefix-$s" >/dev/null
	done
}

trap cleanup EXIT

ensure_model @dataverket/openstack/volume smoke-volume || exit $?
ensure_model @dataverket/openstack/image smoke-image   || exit $?

for s in a b c; do
	succeeds smoke-volume create "name=$prefix-$s" sizeGb=1 wait=true
	check "volume create $prefix-$s" $?
	succeeds smoke-image create "name=$prefix-$s" "file=$image_file" \
		diskFormat=qcow2 containerFormat=bare visibility=private
	check "image create $prefix-$s" $?
done

exercise smoke-volume volume
exercise smoke-image image

for s in b c; do
	succeeds smoke-volume delete "volume=$prefix-$s"
	check "volume delete $prefix-$s" $?
	succeeds smoke-image delete "image=$prefix-$s"
	check "image delete $prefix-$s" $?
done

echo "$failures failed"
exit $((failures > 0))
