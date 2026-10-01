#!/usr/bin/env bash
source ./negative.sh
echo "=== K. settings: what is in force, and where it comes from ==="

holds "every settings kind is read in one run" '[.dataArtifacts[] | select(.attributes | has("scope")) | .name] | length >= 9' \
  zitadel-settings read
holds "... and each says whether it is the org's own or the instance's" '[.dataArtifacts[] | select(.attributes | has("scope")) | .attributes.scope] | all(. == "org" or . == "instance")' \
  zitadel-settings read
holds "the login settings carry the MFA flags an audit asks about" '[.dataArtifacts[] | select(.name | startswith("login-")) | .attributes | has("forceMfa")] | all(. == true)' \
  zitadel-settings read
holds "reading the instance is a different scope from reading an org" '[.dataArtifacts[] | select(.name == "lockout-instance") | .attributes.scope] | last == "instance"' \
  zitadel-settings read instance=true

refuses "translations that are not JSON never reach the API" \
  "not valid JSON" \
  zitadel-settings loginTranslationSet locale=nb translations="not json" instance=true
refuses "translations need a scope" \
  "name the organization" \
  zitadel-settings loginTranslationSet locale=nb translations='{}' 
refuses "a locale that is not a BCP-47 tag is refused by the schema" \
  "too small|at least 2|locale" \
  zitadel-settings loginTranslationSet locale=n translations='{}' instance=true

# Start from the other value, so that "updated" is a change this run made.
# Zitadel 4.15.3 answers a security write that changes nothing with "No
# changes" and 4.19.3 accepts it, so only a real change reads the same on both.
run zitadel-settings securitySet iframeEmbeddingEnabled=false enableImpersonation=true >/dev/null 2>&1
acts  "security settings can be read back after being set" updated security-instance \
  zitadel-settings securitySet iframeEmbeddingEnabled=false enableImpersonation=false
holds "... and the read shows what was set" '[.dataArtifacts[] | select(.name == "security-instance") | .attributes.enableImpersonation] | last == false' \
  zitadel-settings read instance=true
summary
