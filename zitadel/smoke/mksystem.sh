#!/usr/bin/env bash
# Makes the System API user's key pair for the throwaway instance, before
# compose starts it: the private half stays in the machinekey directory for the
# zitadel-system model, the public half goes to Zitadel through
# ZITADEL_SYSTEMAPIUSERS, which this prints as an export line to eval.
#
#   eval "$(<smoke>/mksystem.sh machinekey)"
#   podman compose -p zit-test up -d
set -eu
keys=${1:?usage: mksystem.sh <machinekey dir>}
mkdir -p "$keys"
pem=$keys/system.pem
[ -s "$pem" ] || openssl genrsa -out "$pem" 2048 2>/dev/null
chmod 600 "$pem"
keydata=$(openssl rsa -in "$pem" -pubout 2>/dev/null | base64 | tr -d '\n')
printf "export ZITADEL_SYSTEMAPIUSERS='%s'\n" "{\"operators\":{\"KeyData\":\"$keydata\"}}"
