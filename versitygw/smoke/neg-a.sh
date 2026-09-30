#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== A. the root key's source ==="

refuses "no source is refused by name" "no root key source" vgw-none accounts
refuses "two sources are refused" "not both" vgw-both accounts
refuses "a key file that is not there is named" "does not exist" vgw-nofile accounts
refuses "an empty secret in the key file counts as unset" "ROOT_SECRET_KEY is not set" vgw-partial accounts
refuses "rootKeyEnv without the variables names them, not values" "VGW_ACCESS is not set" vgw-env accounts
export VGW_ACCESS=fixtureroot VGW_SECRET=fixturerootsecret0000
holds   "rootKeyEnv reads the pair from swamp's environment" \
  '[.dataArtifacts[] | select(.name | startswith("account-"))] | length == 4' vgw-env accounts
unset VGW_ACCESS VGW_SECRET
refuses "... and without them again, nothing was remembered" "VGW_ACCESS is not set" vgw-env accounts
summary
