#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== E. names shaped as flags, shell and paths; definitions that point nowhere ==="
collect_secrets

v=$(version pki leaf)
all=$(k get certificates.cert-manager.io -A -o jsonpath='{.items[*].metadata.resourceVersion}')
for bad in '-A' '--all-namespaces' '-o=yaml' 'leaf -A' 'leaf;id' '$(id)' '`id`' 'leaf|cat' '../leaf' 'pki/leaf' 'Leaf' 'leaf-'; do
  for method in get trace renew; do
    refuses "$method name '$bad'" "Kubernetes object name|validation failed" cm-pki "$method" "name=$bad"
    refuses "$method namespace '$bad'" "Kubernetes namespace name|validation failed" cm-pki "$method" name=leaf "namespace=$bad"
  done
  refuses "list namespace '$bad'" "Kubernetes namespace name|validation failed" cm-certificate list "namespace=$bad"
done
# A definition's namespace is checked when a method uses it, not when the
# definition is made: such a definition exists and can do nothing.
(cd "$REPO" && swamp behavior create @dataverket/cert-manager/certificate cm-badns \
  --global-arg "kubeconfig=$KUBECONFIG_FILE" --global-arg "namespace=--all-namespaces" --json) >"$OUT" 2>"$ERR" || true
refuses "a definition whose namespace is a flag: list refuses before kubectl" \
  "Kubernetes namespace name" cm-badns list
for method in get trace renew; do
  refuses "... and so does $method" "Kubernetes namespace name" cm-badns "$method" name=leaf
done
refuses "a kubeconfig that is not there" "kubectl get .* failed" cm-nofile list
refuses "... is fatal to renew before anything is read" "kubectl get .* failed" cm-nofile renew name=leaf
refuses "a context the kubeconfig does not have" "context.*no-such-context|does not exist" cm-nocontext list
check "no certificate was touched by any of it" [ "$(k get certificates.cert-manager.io -A -o jsonpath='{.items[*].metadata.resourceVersion}')" = "$all" ]
check "leaf in particular" [ "$(version pki leaf)" = "$v" ]
summary
