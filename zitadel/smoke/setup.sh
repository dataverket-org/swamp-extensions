#!/usr/bin/env bash
# Builds the swamp repository the suite runs in, in the current directory,
# against a throwaway instance that is already up (see README.md). Everything
# the batches name is made here, so a fresh directory and this script are the
# whole of the setup.
#
#   mkdir /tmp/zit-smoke && cd /tmp/zit-smoke && <smoke>/setup.sh <machinekey dir>
#
# API is where the instance answers (default http://localhost:8899). SMOKE_ID
# keeps two runs on one host apart, when two versions are tested side by side.
set -eu
smoke=$(cd "$(dirname "$0")" && pwd)
ext=$(cd "$smoke/.." && pwd)
keys=${1:?usage: setup.sh <machinekey dir>}
api=${API:-http://localhost:8899}
admin=$keys/swamp-admin.json
deno=${DENO:-$(command -v deno || echo "$HOME/.swamp/deno/deno")}
run_deno() { "$deno" run --allow-read --allow-write --allow-net --allow-env "$@"; }
T=@dataverket/zitadel

[ -s "$admin" ] || { echo "no admin key at $admin; is the instance up?" >&2; exit 1; }

swamp repo init --tool none >/dev/null
swamp extension source add "$ext" >/dev/null
swamp vault create local_encryption testvault >/dev/null
create() { swamp model create "$@" --json >/dev/null; }

# The seven models every batch drives, as the owner the instance was born with.
for t in org project app user grant action settings; do
  create "$T/$t" "zitadel-$t" --global-arg apiUrl="$api" --global-arg keyJsonFile="$admin"
done

# Batch H: a model that holds one project and nothing else.
create "$T/project" lastone --global-arg apiUrl="$api" --global-arg keyJsonFile="$admin"

# Batch E: one model per way of naming a credential, right and wrong.
swamp vault put testvault zitadel_key_json --yes <"$admin" >/dev/null
vault="\${{ vault.get('testvault', 'zitadel_key_json') }}"
mkdir -p cred
echo 'SECRETMARKER1 this is not json' >cred/notjson.json
jq '.key = "-----BEGIN RSA PRIVATE KEY-----\nSECRETMARKER2\n-----END RSA PRIVATE KEY-----\n"' "$admin" >cred/badrsa.json
create "$T/org" cred-vault   --global-arg apiUrl="$api" --global-arg keyJson="$vault"
create "$T/org" cred-none    --global-arg apiUrl="$api"
create "$T/org" cred-both    --global-arg apiUrl="$api" --global-arg keyJson="$vault" --global-arg keyJsonFile="$admin"
create "$T/org" cred-missing --global-arg apiUrl="$api" --global-arg keyJsonFile="$PWD/cred/does-not-exist.json"
create "$T/org" cred-notjson --global-arg apiUrl="$api" --global-arg keyJsonFile="$PWD/cred/notjson.json"
create "$T/org" cred-badrsa  --global-arg apiUrl="$api" --global-arg keyJsonFile="$PWD/cred/badrsa.json"
create "$T/org" cred-badurl  --global-arg apiUrl=http://localhost:1 --global-arg keyJsonFile="$admin"
create "$T/org" cred-badorg  --global-arg apiUrl="$api" --global-arg keyJsonFile="$admin" --global-arg orgId=999999999999999999
# A key file named the way an operator names one. The copy is this throwaway
# instance's key and goes when teardown removes the directory.
home_keys=${XDG_CACHE_HOME:-$HOME/.cache}/zitadel-smoke${SMOKE_ID:+-$SMOKE_ID}
mkdir -p "$home_keys" && chmod 700 "$home_keys" && install -m 600 "$admin" "$home_keys/key.json"
tilde="~${home_keys#"$HOME"}"
create "$T/org" cred-tilde         --global-arg apiUrl="$api" --global-arg keyJsonFile="$tilde/key.json"
create "$T/org" cred-tilde-missing --global-arg apiUrl="$api" --global-arg keyJsonFile="$tilde/does-not-exist.json"

# Batch J: a second organization to grant a project to.
run_deno "$smoke/mkorg.ts" "$admin" "$api" "Annen organisasjon" >org-id.txt

# Batch M: more than a page of users, of projects, and of roles in the project
# the fixtures use, which therefore has to exist already.
run_deno "$smoke/bulk.ts" "$admin" "$api" users 120 >/dev/null
run_deno "$smoke/bulk.ts" "$admin" "$api" projects 120 >/dev/null
swamp model method run zitadel-project ensure --input name=selftest >/dev/null
selftest=$(swamp data get zitadel-project project-selftest --json | jq -r '.content.id')
run_deno "$smoke/bulk.ts" "$admin" "$api" roles 120 "$selftest" >/dev/null

# Batch N: the workflow, under the id swamp assigns.
path=$(swamp workflow create zitadel-selftest --json | jq -r '.path')
id=$(yq -r '.id' "$path")
sed "s/^id: .*/id: $id/" "$smoke/workflow-zitadel-selftest.yaml" >"$path"

# Batch P: two keys that may do less, and a definition from an older version.
run_deno "$smoke/mkscoped.ts" "$admin" "$api" smoke-reader "$PWD/cred/reader.json" viewer >/dev/null
run_deno "$smoke/mkscoped.ts" "$admin" "$api" smoke-owner "$PWD/cred/owner.json" owner:owned >/dev/null
for t in org project app user action settings; do
  create "$T/$t" "ro-$t" --global-arg apiUrl="$api" --global-arg keyJsonFile="$PWD/cred/reader.json"
done
for t in project app user; do
  create "$T/$t" "po-$t" --global-arg apiUrl="$api" --global-arg keyJsonFile="$PWD/cred/owner.json"
done
old=$(swamp model create "$T/org" old-org --global-arg apiUrl="$api" --global-arg keyJsonFile="$admin" --json | jq -r '.path')
sed -i.bak 's/^typeVersion: .*/typeVersion: 2026.09.29.1/' "$old" && rm -f "$old.bak"

cp "$smoke"/negative.sh "$smoke"/fixtures.sh "$smoke"/neg-*.sh .
echo "ready: REPO=\$PWD ORG=\$(cat org-id.txt) ./fixtures.sh, then the neg-*.sh batches"
