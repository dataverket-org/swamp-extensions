#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== G. nothing secret at rest ==="
collect_secrets

# Fill the data store once more with everything, then look through all of it.
for kind in certificate certificaterequest order challenge issuer; do
  holds "$kind list" '.dataArtifacts | length > 0' "cm-$kind" list
done
holds "trace of the hanging certificate" '.dataArtifacts | length == 2' cm-acme trace name=hanging
holds "trace of the certificate whose HTTP-01 answer nobody hears" '.dataArtifacts | length == 2' cm-acme trace name=wrong

# The Challenge of acme-test/wrong: its reason in the cluster quotes its key
# authorization, and its key and token are among the values looked for.
wrong() { k -n acme-test get challenges.acme.cert-manager.io -o json | jq -r "[.items[] | select(.spec.dnsName == \"wrong.example.test\")][0] | $1"; }
quoted() { [ -n "$(wrong .spec.key)" ] && wrong .status.reason | grep -qF -e "$(wrong .spec.key)"; }
check "the cluster's Challenge reason quotes the key authorization cert-manager expected" quoted
looked_for() { grep -qxF -e "$(wrong .spec.key)" "$SECRETS" && grep -qxF -e "$(wrong .spec.token)" "$SECRETS"; }
check "that Challenge's key and token are among the values looked for" looked_for

check "the cluster holds secrets to look for (challenge tokens and keys, CSRs, account tokens)" \
  [ "$(wc -l < "$SECRETS")" -ge 8 ]
none_at_rest() { ! grep -rqFf "$SECRETS" --exclude="${SECRETS##*/}" "$REPO" 2>/dev/null; }
check "none of them is anywhere in the repository: data, logs, definitions, the last output" none_at_rest
# .swamp/bundles holds the extension's own code, whose redaction pattern
# names the PEM header; everything else is data, logs and definitions.
no_pem() { ! grep -rqE --exclude-dir=bundles -e '-----BEGIN|LS0tLS1CRUdJTi' "$REPO/.swamp" 2>/dev/null; }
has_data() { [ -n "$(find "$REPO/.swamp" -path '*/bundles' -prune -o -type f -print | head -1)" ]; }
check "there is stored data to look through beside the bundles" has_data
check "no PEM body, plain or base64, is stored either" no_pem
summary
