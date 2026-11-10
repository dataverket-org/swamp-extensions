#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== A. a cluster without cert-manager (run before setup.sh) ==="

if k get crd certificates.cert-manager.io >/dev/null 2>&1; then
  echo "cert-manager is installed here; batch A needs a cluster without it" >&2
  exit 2
fi
NONE="cert-manager is not installed in this cluster"
for kind in certificate certificaterequest order challenge issuer; do
  refuses "$kind list says cert-manager is missing" "$NONE" "cm-$kind" list
  refuses "$kind get says cert-manager is missing" "$NONE" "cm-$kind" get name=x namespace=default
done
refuses "trace says cert-manager is missing" "$NONE" cm-certificate trace name=x namespace=default
refuses "renew says cert-manager is missing" "$NONE" cm-certificate renew name=x namespace=default
summary
