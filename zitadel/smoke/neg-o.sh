#!/usr/bin/env bash
source ./negative.sh
echo "=== O. invariants worth pinning: secrets at rest, convergence, diagnostics ==="

# Every spec that carries a minted secret must hold a vault reference on disk,
# not the secret. One of these was proven before; the rest were assumed.
vaulted() { # name model instance field
  local label=$1 model=$2 instance=$3 field=$4
  local value
  value=$(swamp data get "$model" "$instance" --json 2>/dev/null | jq -r ".content.$field // \"\"")
  if [ -z "$value" ]; then bad "$label" "no $field stored on $instance"; return; fi
  case "$value" in
    *'vault.get('*) ok "$label" ;;
    *) bad "$label" "stored in the clear: ${value:0:24}…" ;;
  esac
}

pat=$(swamp data list zitadel-user --json 2>/dev/null | jq -r '.groups[].items[].name' | grep '^user-credential-.*-pat-' | head -1)
key=$(swamp data list zitadel-user --json 2>/dev/null | jq -r '.groups[].items[].name' | grep '^user-credential-.*-key-' | head -1)
# A public or private-key client has no secret at all, so make one that does —
# and rotate it, because a secret is emitted at create and never again, so an
# ensure that finds the application already there carries none.
run zitadel-app ensureApi project=selftest name=selftest-secret authMethod=basic >/dev/null 2>&1
run zitadel-app secretRotate project=selftest app=selftest-secret >/dev/null 2>&1
appcred=$(jq -r '[.dataArtifacts[] | select(.name | startswith("app-credential-")) | .name] | last' "$OUT")
# A key listing carries no key JSON by design, so mint one and check that.
run zitadel-app keyCreate project=selftest app=selftest-api >/dev/null 2>&1
appkey=$(jq -r '[.dataArtifacts[] | select(.name | startswith("app-key-")) | .name] | last' "$OUT")
target=$(swamp data list zitadel-action --json 2>/dev/null | jq -r '.groups[].items[].name' | grep '^target-credential-' | head -1)

vaulted "a personal access token is a vault reference at rest" zitadel-user "$pat" secret
vaulted "a user key is a vault reference at rest"              zitadel-user "$key" secret
vaulted "an application key JSON is a vault reference at rest" zitadel-app "$appkey" keyJson
vaulted "an application client secret is a vault reference at rest" zitadel-app "$appcred" clientSecret
vaulted "a target's signing key is a vault reference at rest"  zitadel-action "$target" signingKey

# The whole fixture suite, run again, must report no creations: the surface
# converges rather than making a second copy of anything.
before=$(./fixtures.sh 2>&1 | grep -c '^FAIL' || true)
[ "$before" = "0" ] && ok "the fixture suite still passes on a re-run" ||
  bad "the fixture suite still passes on a re-run" "$before failures"

# A method that fails still has to leave something a person can read afterwards
# — this repository's rule 11.
run zitadel-project delete project=ghost confirm=wrong dryRun=false >/dev/null 2>&1
report=$(swamp report get @swamp/method-summary --model zitadel-project --json 2>/dev/null | head -c 4000)
echo "$report" | grep -qiE 'error|status|method' &&
  ok "a failed method leaves a method-summary report to read" ||
  bad "a failed method leaves a method-summary report to read" "${report:0:200}"
summary
