#!/usr/bin/env bash
source ./negative.sh
echo "=== F. converging, not accumulating; and not clobbering what was not asked about ==="

# A grant is set to exactly the roles asked for, and the earlier failed ensure
# with an unknown role left the old set alone. Put the starting state back
# first, so this batch says the same thing however often it is run.
run zitadel-grant ensure user=kari-selftest project=selftest 'roleKeys=["kube-admin"]' >/dev/null 2>&1
holds "the grant still holds what it held before the failed ensure" '[.dataArtifacts[] | select(.name | startswith("grant-")) | .attributes.roleKeys[]] | index("kube-admin") != null' \
  zitadel-grant list user=kari-selftest project=selftest
acts  "grant ensure replaces the role set" updated grant- \
  zitadel-grant ensure user=kari-selftest project=selftest 'roleKeys=["kube-readers"]'
holds "... so the old role is gone, not kept beside the new one" '[.dataArtifacts[] | select(.name | startswith("grant-")) | .attributes.roleKeys] | last == ["kube-readers"]' \
  zitadel-grant list user=kari-selftest project=selftest
acts  "grant ensure with the same roles in another order changes nothing" unchanged grant- \
  zitadel-grant ensure user=kari-selftest project=selftest 'roleKeys=["kube-readers"]'

# A project keeps the flags nobody mentioned. Start from the flag being off, so
# "updated" means this run changed it rather than an earlier one having done so.
run zitadel-project update project=selftest roleAssertion=false >/dev/null 2>&1
acts  "project update sets roleAssertion" updated project-selftest \
  zitadel-project update project=selftest roleAssertion=true
acts  "project ensure without flags does not clear them" unchanged project-selftest \
  zitadel-project ensure name=selftest
holds "... and roleAssertion is still on" '[.dataArtifacts[] | select(.name == "project-selftest") | .attributes.roleAssertion] | last == true' \
  zitadel-project get project=selftest
acts  "project update with nothing new is a no-op" unchanged project-selftest \
  zitadel-project update project=selftest roleAssertion=true

# The role assertion and the login UI are part of what ensureOidc converges.
# Start with both off, so that "updated" is a change this run made.
run zitadel-app ensureOidc project=selftest name=selftest-app 'redirectUris=["http://localhost:8000"]' appType=native authMethod=none >/dev/null 2>&1
acts  "ensureOidc asserts roles into the ID token and names the v2 login UI" updated app-selftest-selftest-app \
  zitadel-app ensureOidc project=selftest name=selftest-app 'redirectUris=["http://localhost:8000"]' appType=native authMethod=none idTokenRoleAssertion=true loginVersion=v2
holds "... and the client reads both back" '[.dataArtifacts[] | select(.name == "app-selftest-selftest-app") | .attributes] | last | .idTokenRoleAssertion == true and .loginVersion == "v2" and .accessTokenRoleAssertion == false' \
  zitadel-app get project=selftest app=selftest-app
acts  "ensureOidc with the same flags again changes nothing" unchanged app-selftest-selftest-app \
  zitadel-app ensureOidc project=selftest name=selftest-app 'redirectUris=["http://localhost:8000"]' appType=native authMethod=none idTokenRoleAssertion=true loginVersion=v2
acts  "ensureOidc without the flags turns the role assertion back off" updated app-selftest-selftest-app \
  zitadel-app ensureOidc project=selftest name=selftest-app 'redirectUris=["http://localhost:8000"]' appType=native authMethod=none loginVersion=v2
holds "... which the record shows" '[.dataArtifacts[] | select(.name == "app-selftest-selftest-app") | .attributes] | last | .idTokenRoleAssertion == false and .loginVersion == "v2"' \
  zitadel-app get project=selftest app=selftest-app
run zitadel-app ensureOidc project=selftest name=selftest-app 'redirectUris=["http://localhost:8000"]' appType=native authMethod=none idTokenRoleAssertion=true loginVersion=v2 >/dev/null 2>&1

# Redirect changes leave the rest of a client alone. Take the URI away first so
# that adding it is a change this run made.
run zitadel-app redirectSet project=selftest app=selftest-app 'remove=["http://localhost:18000"]' >/dev/null 2>&1
acts  "redirectSet adds a URI" updated oidc-redirect \
  zitadel-app redirectSet project=selftest app=selftest-app 'add=["http://localhost:18000"]'
holds "... and the client is still a native public client" '[.dataArtifacts[] | select(.name == "app-selftest-selftest-app") | .attributes] | last | .appType == "native" and .authMethod == "none"' \
  zitadel-app get project=selftest app=selftest-app
holds "... that still asserts roles into the ID token through the v2 login UI" '[.dataArtifacts[] | select(.name == "app-selftest-selftest-app") | .attributes] | last | .idTokenRoleAssertion == true and .loginVersion == "v2"' \
  zitadel-app get project=selftest app=selftest-app
acts  "redirectSet that removes a URI which was never there is a no-op" unchanged oidc-redirect \
  zitadel-app redirectSet project=selftest app=selftest-app 'remove=["http://localhost:31337"]'

# State changes are idempotent in both directions.
acts  "user setState to the state the user is already in changes nothing" unchanged user-state \
  zitadel-user setState user=svc-selftest state=active
acts  "app setState to inactive deactivates" deactivated app-state \
  zitadel-app setState project=selftest app=selftest-app state=inactive
acts  "app setState to inactive again changes nothing" unchanged app-state \
  zitadel-app setState project=selftest app=selftest-app state=inactive
acts  "app setState back to active reactivates" reactivated app-state \
  zitadel-app setState project=selftest app=selftest-app state=active
summary
