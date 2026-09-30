#!/usr/bin/env bash
# The models the negative suite runs, in the swamp repository $REPO, pointing at
# the gateways gateway.sh started. Key files go in .work/keys, mode 0600.
set -euo pipefail
cd "$(dirname "$0")"
K=$PWD/.work/keys; C=$PWD/.work/certs
mkdir -p "$K"
key() { (umask 077; printf 'ROOT_ACCESS_KEY=%s\nROOT_SECRET_KEY=%s\n' "$2" "$3" > "$K/$1.env"); }
key root fixtureroot fixturerootsecret0000
key wrong-secret fixtureroot not-the-secret
key writer cnpg-forgejo FIXTURE-SECRET-cnpg-forgejo-000000
key partial fixtureroot ""

PLAIN=(--global-arg adminUrl=http://127.0.0.1:17071 --global-arg s3Url=http://127.0.0.1:17070)
TLS=(--global-arg adminUrl=http://127.0.0.1:17444 --global-arg s3Url=https://127.0.0.1:17443)
m() { # name args...
  local name=$1; shift
  (cd "$REPO" && swamp model create @dataverket/versitygw/gateway "$name" "$@" --json >/dev/null)
}
m vgw "${PLAIN[@]}" --global-arg rootKeyFile="$K/root.env"
m vgw-env "${PLAIN[@]}" --global-arg rootKeyEnv=true \
  --global-arg accessKeyName=VGW_ACCESS --global-arg secretKeyName=VGW_SECRET
m vgw-both "${PLAIN[@]}" --global-arg rootKeyFile="$K/root.env" --global-arg rootKeyEnv=true
m vgw-none "${PLAIN[@]}"
m vgw-nofile "${PLAIN[@]}" --global-arg rootKeyFile="$K/missing.env"
m vgw-partial "${PLAIN[@]}" --global-arg rootKeyFile="$K/partial.env"
m vgw-wrong-secret "${PLAIN[@]}" --global-arg rootKeyFile="$K/wrong-secret.env"
m vgw-wrong-region "${PLAIN[@]}" --global-arg rootKeyFile="$K/root.env" --global-arg region=eu-north-1
m vgw-writer "${PLAIN[@]}" --global-arg rootKeyFile="$K/writer.env"
m vgw-closed --global-arg adminUrl=http://127.0.0.1:1 --global-arg s3Url=http://127.0.0.1:1 \
  --global-arg rootKeyFile="$K/root.env" --global-arg httpTimeoutMs=3000
m vgw-prefix --global-arg adminUrl=http://127.0.0.1:17071/no-such-prefix \
  --global-arg s3Url=http://127.0.0.1:17070 --global-arg rootKeyFile="$K/root.env"
m vgw-tls "${TLS[@]}" --global-arg rootKeyFile="$K/root.env" --global-arg caFile="$C/ca.crt"
m vgw-tls-other-ca "${TLS[@]}" --global-arg rootKeyFile="$K/root.env" --global-arg caFile="$C/other-ca.crt"
m vgw-tls-no-ca "${TLS[@]}" --global-arg rootKeyFile="$K/root.env"
echo "models created in $REPO"
