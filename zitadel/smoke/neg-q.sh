#!/usr/bin/env bash
source ./negative.sh
echo "=== Q. instances: the System API key makes and lists them, an ordinary key reads one; trusted domains; mail and MFA audits ==="

names='[.dataArtifacts[].name]'
attrs() { jq -r "$1" "$OUT"; }

# The instance, read with the key of one of its own users.
holds "the owner's key reads the instance with its version" '[.dataArtifacts[] | select(.name | startswith("instance-")) | select(.name | startswith("instance-domain-") | not) | .attributes.version] | last | length > 0' \
  zitadel-instance read
holds "... and every domain of it, one generated" '[.dataArtifacts[] | select(.name | startswith("instance-domain-")) | .attributes.generated] | any' \
  zitadel-instance read
holds "... and exactly one primary" '[.dataArtifacts[] | select(.name | startswith("instance-domain-")) | .attributes.primary] | map(select(.)) | length == 1' \
  zitadel-instance read
holds "the owner's key lists the instance's members, itself among them as IAM_OWNER" '[.dataArtifacts[] | select(.name | startswith("member-")) | .attributes.roles] | flatten | index("IAM_OWNER") != null' \
  zitadel-instance memberList
holds "a reader key reads the instance too" "$names | map(startswith(\"instance-domain-\")) | any" \
  ro-instance read
holds "... and its members" "$names | map(startswith(\"member-\")) | any" \
  ro-instance memberList

# Trusted domains: added once, refused without confirm, planned, then removed.
acts  "trustedDomainAdd adds a host" created trusted-domain-login-smoke-invalid \
  zitadel-instance trustedDomainAdd domain=login.smoke.invalid
acts  "... and leaves it alone the second time" unchanged trusted-domain-login-smoke-invalid \
  zitadel-instance trustedDomainAdd domain=login.smoke.invalid
holds "... and read lists it" "$names | index(\"trusted-domain-login-smoke-invalid\") != null" \
  zitadel-instance read
refuses "a reader key cannot trust a domain" \
  "HTTP 403|permission" \
  ro-instance trustedDomainAdd domain=reader.smoke.invalid
refuses "removing a trusted domain needs the right confirm" \
  "refusing to delete trusted domain" \
  zitadel-instance trustedDomainRemove domain=login.smoke.invalid confirm=other dryRun=false
refuses "removing a domain that is not trusted says so" \
  "is not trusted" \
  zitadel-instance trustedDomainRemove domain=nobody.smoke.invalid confirm=nobody.smoke.invalid dryRun=false
acts  "a dry run only plans" planned trusted-domain-login-smoke-invalid \
  zitadel-instance trustedDomainRemove domain=login.smoke.invalid confirm=login.smoke.invalid dryRun=true
holds "... and the domain is still trusted" "$names | index(\"trusted-domain-login-smoke-invalid\") != null" \
  zitadel-instance read
acts  "the real run removes it" removed trusted-domain-login-smoke-invalid \
  zitadel-instance trustedDomainRemove domain=login.smoke.invalid confirm=login.smoke.invalid dryRun=false
holds "... and read no longer lists it" "$names | index(\"trusted-domain-login-smoke-invalid\") == null" \
  zitadel-instance read

# The instances a deployment hosts, with the System API key.
holds "the System API key lists the one instance there is, running" '[.dataArtifacts[] | select(.name | startswith("instance-")) | .attributes.state] | . == ["running"]' \
  zitadel-system instanceList
holds "... and its domains" '[.dataArtifacts[] | select(.name | startswith("instance-domain-")) | .attributes.generated] | any' \
  zitadel-system domainList
refuses "instanceCreate needs an expiry for the owner's credential" \
  "expirationDate|required|expected string" \
  zitadel-system instanceCreate name=smoke-second
acts  "instanceCreate makes a second instance with a machine owner" created instance-owner-smoke-second-admin \
  zitadel-system instanceCreate name=smoke-second firstOrgName=smoke customDomain=id.smoke-second.invalid expirationDate=2027-01-01T00:00:00Z
owner_secret=$(swamp data get zitadel-system instance-owner-smoke-second-admin --json 2>/dev/null | jq -r '.content.secret // ""')
case "$owner_secret" in
  *'vault.get('*) ok "... whose token is a vault reference at rest, not the token" ;;
  "") bad "... whose token is a vault reference at rest" "no secret stored on instance-owner-smoke-second-admin" ;;
  *) bad "... whose token is a vault reference at rest" "stored in the clear: ${owner_secret:0:24}…" ;;
esac
holds "... and the second run leaves it alone and mints nothing" '[.dataArtifacts[] | select(.name | startswith("instance-")) | .attributes | select(.name == "smoke-second") | .action] | last == "unchanged"' \
  zitadel-system instanceCreate name=smoke-second expirationDate=2027-01-01T00:00:00Z
holds "instanceList now shows two" '[.dataArtifacts[] | select(.name | startswith("instance-")) | .attributes.instanceId] | length == 2' \
  zitadel-system instanceList
# The new instance's id, from the listing just stored, for a definition scoped to it.
second=$(jq -r '[.dataArtifacts[] | select(.name | startswith("instance-")) | .attributes | select(.name == "smoke-second") | .instanceId] | last' "$OUT")
refuses "domainList refuses to guess between two instances" \
  "name one with instanceId" \
  zitadel-system domainList

# A definition scoped to the new instance by instanceId, made now that the id is known.
if [ -n "$second" ] && [ "$second" != "null" ]; then
  swamp model create @dataverket/zitadel/system zitadel-system-second \
    --global-arg apiUrl="$API" --global-arg systemUser=operators \
    --global-arg systemKeyFile="$SYSTEM_PEM" --global-arg instanceId="$second" --json >/dev/null 2>&1 || true
  holds "domainList scoped by instanceId reads the new instance's domains, the custom one among them" "$names | index(\"instance-domain-id-smoke-second-invalid\") != null" \
    zitadel-system-second domainList
  holds "... and the custom domain is already its primary" '[.dataArtifacts[] | select(.name == "instance-domain-id-smoke-second-invalid") | .attributes.primary] | last == true' \
    zitadel-system-second domainList
  acts  "so domainSetPrimary on it changes nothing" unchanged instance-domain-id-smoke-second-invalid \
    zitadel-system-second domainSetPrimary domain=id.smoke-second.invalid
else
  bad "domainList scoped by instanceId" "no instance id for smoke-second in the list"
fi

# Mail and MFA, read with the owner's key.
holds "settings read stores the SMTP provider without its password" '[.dataArtifacts[] | select(.name == "email-provider-smoke-smtp") | .attributes] | last | .kind == "smtp" and .senderAddress == "noreply@smoke.invalid" and (has("password") | not)' \
  zitadel-settings read instance=true
holds "... and never the marker the provider was made with" '[.dataArtifacts[] | tostring] | map(contains("SMTPMARKER")) | any | not' \
  zitadel-settings read instance=true
holds "... and the notification settings" '[.dataArtifacts[] | select(.name == "notification-instance") | .attributes | has("passwordChange")] | last == true' \
  zitadel-settings read instance=true
holds "authFactorList without a user audits every human and sums each one up" '[.dataArtifacts[] | select(.name | startswith("auth-summary-")) | .attributes.mfa] | length >= 1 and all(. == false)' \
  zitadel-user authFactorList
holds "... kari among them, with nothing ready" '[.dataArtifacts[] | select(.name == "auth-summary-kari-selftest") | .attributes] | last | .factors == 0 and .mfa == false and .totp == false and .passkeys == 0' \
  zitadel-user authFactorList
holds "... and no machine user in the audit" '[.dataArtifacts[] | select(.name == "auth-summary-svc-selftest")] | length == 0' \
  zitadel-user authFactorList
summary
