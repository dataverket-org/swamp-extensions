#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== C. an issuer that repeats the token it was sent ==="
# Needs no Salmon image: the cluster mints a real token, the stand-in answers.
python3 "$HERE/standin.py" $((PORT + 1)) "$WORK" &
STANDIN=$!
trap 'kill $STANDIN 2>/dev/null' EXIT
for _ in $(seq 50); do
  curl -fsS "http://127.0.0.1:$((PORT + 1))/ok/issuer/.well-known/openid-configuration" >/dev/null 2>&1 && break
  sleep 0.1
done
rm -f "$SENT"

refuses "a discovery document that is a login page" 'did not return a discovery document' tx-page test
refuses "a token endpoint that is not http" 'must be an http or https URL' tx-ftp test
check "no token was minted for either: the stand-in was sent none" test ! -e "$SENT"

holds "an issued token is recorded as its claims only" \
  '.passed == true and .tokenSubject == "trust/smoke" and .roles == ["users/Registry-Push"] and .expiresIn == 60 and (tostring | test("eyJ") | not)' \
  tx-ok test
check "the stand-in was sent a real ServiceAccount token" grep -qE "^$JWT" "$SENT"
holds "a ServiceAccount that is not there is made on demand" '.passed == true and .subject == "system:serviceaccount:default:smoke-made-on-demand"' tx-newsa test
check "it exists now" k -n default get serviceaccount smoke-made-on-demand

refuses "a refusal that repeats the subject token" 'token exchange failed \(HTTP 400\).*invalid_grant: subject_token \[redacted\] is not trusted' tx-echo test
check "that refusal is recorded as not passed, with the redacted reason" \
  latest tx-echo result '.passed == false and .httpStatus == 400 and .error == "invalid_grant: subject_token [redacted] is not trusted"'
refuses "an error page that repeats it" 'token exchange failed \(HTTP 500\).*could not verify \[redacted\]' tx-html test
refuses "an answer without access_token that holds a token elsewhere" 'token exchange failed \(HTTP 200\)' tx-other test
refuses "an access_token that is not a JWT" 'the access_token Salmon issued is not a JWT' tx-opaque test
check "and that is the recorded result" latest tx-opaque result '.passed == false and .httpStatus == 200 and (.error | test("not a JWT"))'
check "the opaque token is not in the output" bash -c "! grep -q 'opaque-xxxx' '$OUT' '$ERR'"
repo_clean
check "nor the opaque one" bash -c "! grep -rq 'opaque-xxxx' '$REPO'"
summary
