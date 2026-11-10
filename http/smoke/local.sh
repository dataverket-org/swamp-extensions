#!/usr/bin/env bash
# bodyJson against the local server of server.ts: what must pass, and mostly
# what must not. BASE is where the server listens.
source "$(dirname "$0")/negative.sh"
BASE=${BASE:-http://127.0.0.1:18080}
ISSUER=https://id.example.org
WANT="bodyJson:json={\"issuer\":\"$ISSUER\"}"
failed() { printf '%s' ".ok == false and .reachable == true and .jsonMatched == false and (.jsonMismatches | length == 1) and .jsonMismatches[0].reason == \"$1\""; }

echo "=== A. what must pass ==="
model lj-ok "url=$BASE/discovery" "$WANT"
holds "the issuer matches exactly" '.ok == true and .jsonMatched == true and .jsonMismatchCount == 0 and .error == null' lj-ok
model lj-nested "url=$BASE/discovery" \
  'bodyJson:json={"limits":{"max_age":3600,"strict":true,"note":null},"scopes_supported":["openid","profile","email"]}'
holds "a nested object as a subset, an array as a whole, number, boolean and null" '.ok == true and .jsonMatched == true' lj-nested
model lj-both "url=$BASE/discovery" "$WANT" bodyContains=authorization_endpoint
holds "bodyContains and bodyJson together" '.ok == true and .bodyMatched == true and .jsonMatched == true' lj-both
model lj-moved "url=$BASE/moved" "$WANT"
holds "a redirect, then JSON" '.ok == true and .redirects == 1 and .jsonMatched == true' lj-moved
model lj-none "url=$BASE/discovery"
holds "nothing asked is null, as before" '.ok == true and .jsonMatched == null and .bodyMatched == null and .jsonMismatches == []' lj-none

echo "=== B. a field that differs ==="
model lj-substring "url=$BASE/longer" "bodyContains=$ISSUER"
holds "a longer issuer passes a substring match ..." '.ok == true' lj-substring
model lj-longer "url=$BASE/longer" "$WANT"
holds "... and fails the exact one, by field" \
  '.ok == false and .jsonMismatches == [{"path":"/issuer","reason":"value","expectedType":"string","actualType":"string","expected":null,"actual":null}]' lj-longer
silent "nothing of the body is recorded or printed without bodyJsonShowValues" 'attacker'
model lj-shown "url=$BASE/longer" "$WANT" bodyJsonShowValues=true
holds "bodyJsonShowValues records expected and actual" \
  '.jsonMismatches[0].actual == "\"https://id.example.org.attacker.example\"" and .jsonMismatches[0].expected == "\"https://id.example.org\""' lj-shown
model lj-type "url=$BASE/discovery" 'bodyJson:json={"limits":{"max_age":"3600"}}'
holds 'the string "3600" is not the number 3600' \
  '.ok == false and .jsonMismatches[0].path == "/limits/max_age" and .jsonMismatches[0].reason == "type" and .jsonMismatches[0].actualType == "number"' lj-type
model lj-missing "url=$BASE/discovery" 'bodyJson:json={"end_session_endpoint":"x","limits":{"absent":null}}'
holds "missing fields are each named" \
  '.ok == false and .jsonMismatchCount == 2 and ([.jsonMismatches[] | .path] == ["/end_session_endpoint","/limits/absent"]) and ([.jsonMismatches[] | .reason] == ["missing","missing"])' lj-missing
model lj-order "url=$BASE/discovery" 'bodyJson:json={"scopes_supported":["profile","openid","email"]}'
holds "an array in another order differs" '.ok == false and .jsonMismatches[0].reason == "value" and .jsonMismatches[0].path == "/scopes_supported"' lj-order
model lj-inherited "url=$BASE/discovery" 'bodyJson:json={"constructor":{},"toString":{}}'
holds "constructor and toString are not fields of every body" '.ok == false and ([.jsonMismatches[] | .reason] == ["missing","missing"])' lj-inherited
model lj-down "url=$BASE/down" 'bodyJson:json={"status":"up"}'
holds "a wrong status stays the first error" '.ok == false and .error == "status 503, expected 200" and .jsonMatched == false' lj-down

echo "=== C. a body that cannot be judged ==="
model lj-html "url=$BASE/html" "$WANT";         holds "text/html" "$(failed content-type)" lj-html
model lj-plain "url=$BASE/text-plain" "$WANT";  holds "JSON served as text/plain" "$(failed content-type)" lj-plain
model lj-notjson "url=$BASE/not-json" "$WANT";  holds "not JSON" "$(failed not-json)" lj-notjson
model lj-array "url=$BASE/array" "$WANT";       holds "an array at the top" "$(failed not-object)" lj-array
model lj-scalar "url=$BASE/scalar" "$WANT";     holds "a string at the top" "$(failed not-object)" lj-scalar
model lj-twice "url=$BASE/twice" "$WANT";       holds "a key held twice, the right value last" "$(failed duplicate-key)" lj-twice
model lj-proto "url=$BASE/proto" "$WANT";       holds "a field only under __proto__ is missing" "$(failed missing)" lj-proto
model lj-deep "url=$BASE/deep" "$WANT";         holds "nested 100 deep" "$(failed too-deep)" lj-deep
model lj-huge "url=$BASE/huge" "$WANT";         holds "2 MiB" "$(failed too-large)" lj-huge
model lj-endless "url=$BASE/endless" "$WANT";   holds "a body without end is cut off" "$(failed too-large)" lj-endless
model lj-utf8 "url=$BASE/not-utf8" "$WANT";     holds "invalid UTF-8" "$(failed not-utf8)" lj-utf8
model lj-slow "url=$BASE/slow" "$WANT" timeoutMs=1000
holds "a body slower than timeoutMs" '.ok == false and .reachable == false and .jsonMatched == null and .error == "no answer within 1000 ms"' lj-slow
model lj-cut "url=$BASE/cut" "$WANT"
holds "a body cut short" '.ok == false and .reachable == false and .jsonMatched == null and .error != null' lj-cut

echo "=== D. a definition that is refused ==="
if (cd "$REPO" && swamp model create @dataverket/http/endpoint lj-string --global-arg "url=$BASE/discovery" --global-arg bodyJson=issuer --json) >"$OUT" 2>"$ERR"; then
  refuses "bodyJson that is a text, not fields" "bodyJson" lj-string
else
  ok "bodyJson that is a text, not fields, is refused at create"
fi
# A definition written by hand, as a file in the repository.
definition() { # name typeVersion, the globalArguments on stdin
  local dir=$REPO/models/@dataverket/http/endpoint
  mkdir -p "$dir"
  { printf "type: '@dataverket/http/endpoint'\ntypeVersion: %s\nid: %s\nname: %s\nversion: 1\ntags: {}\nglobalArguments:\n" \
      "$2" "$(cat /proc/sys/kernel/random/uuid 2>/dev/null || uuidgen)" "$1"
    cat; printf 'methods: {}\n'; } > "$dir/$1.yaml"
}
definition lj-proto-key 2026.11.10.1 <<YAML
  url: '$BASE/discovery'
  bodyJson:
    __proto__:
      issuer: nope
YAML
refuses "a field named __proto__ is refused, not dropped" "__proto__, which cannot be asserted" lj-proto-key
definition lj-proto-deep 2026.11.10.1 <<YAML
  url: '$BASE/discovery'
  bodyJson:
    limits:
      __proto__: 1
YAML
refuses "... and one level down" "__proto__, which cannot be asserted" lj-proto-deep

echo "=== E. a definition of the version before ==="
definition lj-old 2026.10.29.1 <<YAML
  url: '$BASE/discovery'
  expectStatus: 200
  followRedirects: true
  maxRedirects: 5
  bodyContains: 'authorization_endpoint'
  timeoutMs: 10000
  caFile: ''
  userAgent: swamp @dataverket/http
YAML
holds "it runs as before, with the new fields empty" \
  '.ok == true and .bodyMatched == true and .jsonMatched == null and .jsonMismatches == [] and .jsonMismatchCount == 0' lj-old
if grep -q '^typeVersion: 2026.11.10.1' "$REPO/models/@dataverket/http/endpoint/lj-old.yaml"; then
  ok "and is stamped with the new version"
else
  bad "and is stamped with the new version" "$(grep typeVersion "$REPO/models/@dataverket/http/endpoint/lj-old.yaml")"
fi
summary
