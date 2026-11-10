#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== B. the stack without an image, and a cluster that cannot be used ==="
# Needs no Salmon image. The stand-in answers discovery so the check gets as
# far as kubectl.
python3 "$HERE/standin.py" $((PORT + 1)) "$WORK" &
STANDIN=$!
trap 'kill $STANDIN 2>/dev/null' EXIT
for _ in $(seq 50); do
  curl -fsS "http://127.0.0.1:$((PORT + 1))/ok/issuer/.well-known/openid-configuration" >/dev/null 2>&1 && break
  sleep 0.1
done

refuses "an image that is neither cached nor pulled fails with compose's own words" \
  'docker compose up failed \(exit [0-9]+\): .*no such image' stack-noimage ensure
check "the failure is recorded: not running, with the reason" \
  latest stack-noimage stack '.running == false and (.error | test("docker compose up failed")) and (.error | test("\n") | not)'
check "and leaves no container" test -z "$(docker ps -q --filter label=com.docker.compose.project=salmon-smoke-noimage)"
holds "stop of a stack that never ran is a record, not an error" '.running == false' stack-noimage stop
holds "stop of a project that never existed too" '.running == false and .project == "salmon-smoke-idle"' stack-idle stop
refuses "revoke on a fixture without grants" 'grants nothing at app' stack-idle revoke app=db

C=(kubeconfig="$SMOKE_KUBECONFIG" kubeContext="$CONTEXT" trustId=smoke-trust)
no_definition "a namespace shaped like a flag is no definition" 'namespace must be a Kubernetes namespace name' token-exchange "${C[@]}" namespace=-A
no_definition "a ServiceAccount shaped like a flag" 'serviceAccount must be a Kubernetes object name' token-exchange "${C[@]}" serviceAccount=--all
no_definition "a ServiceAccount with shell text" 'serviceAccount must be a Kubernetes object name' token-exchange "${C[@]}" 'serviceAccount=sa;id'
no_definition "an issuer URL with a password, token-exchange" 'must not hold a user or password' token-exchange "${C[@]}" "issuerUrl=http://admin:$PLANTED@127.0.0.1:$PORT/issuer"
no_definition "an issuer URL with a password, stack" 'must not hold a user or password' stack "issuerUrl=http://admin:$PLANTED@localhost:$PORT/issuer/"
no_definition "a wait of more than an hour" 'upTimeoutSeconds' stack upTimeoutSeconds=3601
refuses "a namespace that does not exist is kubectl's own sentence" 'namespaces "nonesuch" not found' tx-nons test
refuses "a duration kubectl refuses" 'kubectl create token .* failed' tx-duration test
refuses "a cluster that does not answer" 'kubectl get serviceaccount .* failed: the cluster could not be reached' tx-dead test
refuses "a kubeconfig file that is not there" 'kubectl get serviceaccount .* failed' tx-nofile test
refuses "a context the kubeconfig does not hold" 'kind-no-such-context' tx-nocontext test
refuses "a kubectl binary that is not there" 'no-such-kubectl was not found' tx-nobin test
refuses "a Salmon that is not there, before kubectl runs" 'Salmon issuer is not reachable at http://127.0.0.1' tx-nosalmon test
check "none of these wrote a result" test "$(total 'name == "result" && modelName != "tx"')" = 0
check "the password is nowhere in the repository" bash -c "! grep -rq '$PLANTED' '$REPO'"
repo_clean
summary
