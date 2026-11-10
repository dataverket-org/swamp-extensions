#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== A. the real Salmon: seed, exchange, revoke, restore, stop ==="
# Needs the Salmon image (SALMON_IMAGE, or the type's default) and the cluster.

running() { [ -n "$(docker ps -q --filter label=com.docker.compose.project=salmon-smoke)" ]; }
stopped() { ! running; }

holds "ensure starts Salmon with the seed and records stable ids" \
  '.running == true and .project == "salmon-smoke" and (.apps.db | test("^[0-9a-f-]{36}$")) and (.trustId | test("^[0-9a-f-]{36}$")) and .grants == [{app: "db", appId: .apps.db, role: "users/Registry-Push", revoked: false}] and .localIssuerUrl == "http://127.0.0.1:'"$PORT"'/issuer/"' \
  stack ensure
IDS=$(jq -c '.dataArtifacts[0].attributes | {apps, trustId}' "$OUT")
check "the container runs" running
holds "ensure again leaves it running, with the same ids" \
  '.running == true and ({apps, trustId} == '"$IDS"')' stack ensure

holds "a ServiceAccount token of the cluster is exchanged for one with the granted role" \
  '.passed == true and .roles == ["users/Registry-Push"] and (.tokenSubject | startswith("trust/")) and .subject == "system:serviceaccount:default:salmon-token-exchange-test" and .tokenType == "Bearer" and .expiresIn > 0' \
  tx test
check "the ServiceAccount was made in the cluster" k -n default get serviceaccount salmon-token-exchange-test
holds "a second exchange reuses the ServiceAccount" '.passed == true' tx test

refuses "revoke of an app the fixture grants nothing at" 'grants nothing at app' stack revoke app=other
holds "revoke restarts Salmon without the grant and says so" \
  '.running == true and .grants[0].revoked == true and ({apps, trustId} == '"$IDS"')' stack revoke app=db
refuses "the exchange is refused once the grant is gone" 'token exchange failed \(HTTP 4[0-9][0-9]\).*invalid_target' tx test
check "and that refusal is the latest result: not passed, with Salmon's reason" \
  latest tx result '.passed == false and .httpStatus >= 400 and (.error | test("invalid_target")) and .roles == [] and .tokenSubject == ""'
holds "ensure restores the grant" '.running == true and .grants[0].revoked == false' stack ensure
holds "and the exchange passes again" '.passed == true and .roles == ["users/Registry-Push"]' tx test

holds "stop removes the stack and records it" '.running == false and .error == ""' stack stop
check "no container is left" stopped
refuses "an exchange with Salmon stopped names the issuer" 'not reachable at http://127.0.0.1' tx test
check "a test that could not be made is not a result: the last one stands" latest tx result '.passed == true'
repo_clean
summary
