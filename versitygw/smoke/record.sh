#!/usr/bin/env bash
# Record the unit tests' fixtures from the plain gateway gateway.sh started:
# one JSON file per answer (method, path, status, content type, body) in
# ../fixtures. Every key in them is a throwaway. Needs curl with --aws-sigv4.
set -euo pipefail
cd "$(dirname "$0")/../fixtures"
A=http://127.0.0.1:17071; S=http://127.0.0.1:17070
R=(--aws-sigv4 aws:amz:us-east-1:s3 --user fixtureroot:fixturerootsecret0000)

rec() { # name method url curl-args...
  local n=$1 m=$2 u=$3 out; shift 3
  out=$(curl -sS -X "$m" -o body.tmp -w '%{http_code} %{content_type}' "$@" "$u")
  jq -n --arg m "$m" --arg p "${u#http://127.0.0.1:1707?}" --argjson s "${out%% *}" \
    --arg ct "${out#* }" --rawfile b body.tmp \
    '{method: $m, path: $p, status: $s, contentType: $ct, body: $b}' > "$n.json"
  rm body.tmp
}

rec admin-list-users PATCH $A/list-users "${R[@]}"
rec admin-list-buckets PATCH $A/list-buckets "${R[@]}"
rec admin-unsigned PATCH $A/list-users
rec admin-wrong-region PATCH $A/list-users --aws-sigv4 aws:amz:eu-north-1:s3 \
  --user fixtureroot:fixturerootsecret0000
rec admin-wrong-secret PATCH $A/list-users "${R[0]}" "${R[1]}" --user fixtureroot:wrong
rec admin-unknown-key PATCH $A/list-users "${R[0]}" "${R[1]}" --user nobody:wrong
rec admin-not-admin PATCH $A/list-users "${R[0]}" "${R[1]}" \
  --user cnpg-forgejo:FIXTURE-SECRET-cnpg-forgejo-000000
rec health GET $S/health
for b in cnpg-forgejo restic-zitadel shared-scratch ops orphaned locked; do
  for q in versioning policy acl object-lock ownershipControls cors tagging; do
    rec "bucket-$b-$q" GET "$S/$b?$q" "${R[@]}"
  done
done
rec bucket-missing-versioning GET "$S/nope?versioning" "${R[@]}"
ls | wc -l
