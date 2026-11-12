#!/usr/bin/env bash
# The vault and the models the negative suite runs, in the swamp repository
# $REPO, pointing at the forge forge.sh started. The tokens go into a
# local_encryption vault on stdin; a definition only names them.
set -euo pipefail
cd "$(dirname "$0")"
T=$PWD/.work/tokens
: "${REPO:?set REPO to a scratch swamp repository loading this extension}"
sw() { (cd "$REPO" && swamp "$@"); }

# swamp caches each extension's bundles under .swamp/bundles/<id>/; a bundle
# of this extension from an earlier run would run old code. Clear only this
# extension's files: in the directories that hold its two type modules, the
# bundle of each module manifest.yaml lists. Nothing else there is touched.
mods=$(sed -n '/^models:/,/^[a-z]/s/^  - \(.*\)\.ts$/\1/p' ../manifest.yaml)
for d in "$REPO"/.swamp/bundles/*/; do
  [ -f "$d/forgejo.js" ] && [ -f "$d/stagecraft_tracker.js" ] || continue
  for m in $mods; do rm -f -- "${d:?}${m:?}.js"; done
done

sw vault create local_encryption forge --json >/dev/null
for k in admin narrow wrong actions; do
  sw vault put forge "$k" --yes < "$T/$k" >/dev/null
done
# The tracker conformance run needs stagecraft's publisher and workflow.
sw extension pull @swamp/stagecraft --yes >/dev/null

URL=http://127.0.0.1:13000
tok() { printf 'token=${{ vault.get("forge", "%s") }}' "$1"; }
m() { # type name args...
  local type=$1 name=$2; shift 2
  sw model create "$type" "$name" "$@" --json >/dev/null
}
F=@dataverket/forgejo
m $F forge --global-arg apiUrl=$URL --global-arg "$(tok admin)"
m $F forge-narrow --global-arg apiUrl=$URL --global-arg "$(tok narrow)"
m $F forge-wrong --global-arg apiUrl=$URL --global-arg "$(tok wrong)"
m $F forge-closed --global-arg apiUrl=http://127.0.0.1:13999 --global-arg "$(tok admin)" \
  --global-arg httpTimeoutMs=3000
m $F forge-apiv1 --global-arg apiUrl=$URL/api/v1 --global-arg "$(tok admin)"

TR=@dataverket/forgejo/stagecraft-tracker
TA=(--global-arg "apiUrl=$URL" --global-arg owner=fxorg --global-arg repo=tickets)
m $TR tickets "${TA[@]}" --global-arg "$(tok admin)"
m $TR tickets-wrong "${TA[@]}" --global-arg "$(tok wrong)"
m $TR tickets-closed --global-arg apiUrl=http://127.0.0.1:13999 --global-arg owner=fxorg \
  --global-arg repo=tickets --global-arg "$(tok admin)" --global-arg httpTimeoutMs=3000
for r in tool:tickets-bare nodeps:tickets-nodeps tk-old:tickets-renamed; do
  m $TR "${r#*:}" --global-arg "apiUrl=$URL" --global-arg owner=fxorg \
    --global-arg "repo=${r%%:*}" --global-arg "$(tok admin)"
done
m @swamp/stagecraft/publisher tickets-pub --global-arg tracker=tickets
echo "vault and models created in $REPO"
