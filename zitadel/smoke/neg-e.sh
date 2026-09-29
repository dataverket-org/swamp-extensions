#!/usr/bin/env bash
source ./negative.sh
echo "=== E. credentials that are wrong, missing, or two at once ==="

holds   "a key read from a vault authenticates" '.dataArtifacts[0].attributes.state == "active"' \
  cred-vault get
refuses "no credential at all is refused before any call" \
  "no credential|keyJson|keyJsonFile" \
  cred-none get
refuses "both a vault value and a file is refused" \
  "not both|keyJson or keyJsonFile" \
  cred-both get
refuses "a key file that is not there is named in the error" \
  "cannot read keyJsonFile.*does-not-exist" \
  cred-missing get
refuses "a key file that is not JSON is refused" \
  "not valid JSON" \
  cred-notjson get
hides   "a key file that is not JSON does not echo its contents" \
  "SECRETMARKER1" \
  cred-notjson get
refuses "a key whose PEM is rubbish says it is the service user's key" \
  "service user's key" \
  cred-badrsa get
hides   "a key whose PEM is rubbish does not echo the key material" \
  "SECRETMARKER2" \
  cred-badrsa get
refuses "an instance that is not listening says so" \
  "connect|refused|ECONNREFUSED|error sending request|Fetch failed" \
  cred-badurl get
refuses "an organization the service user may not act in is refused by Zitadel" \
  "HTTP 4[0-9][0-9]|not found|permission|membership" \
  cred-badorg list
summary
