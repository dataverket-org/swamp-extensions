#!/usr/bin/env bash
source "$(dirname "$0")/harness.sh"
echo "=== C. healthy and not: run after cluster.sh settle ==="
GW=gateway.envoyproxy.io/gatewayclass-controller

# Gateways
holds "list records six Gateways and one inventory" \
  '[.dataArtifacts[].name] | sort == ["gw-smoke--bad-cert","gw-smoke--conflict","gw-smoke--healthy","gw-smoke--renamed","gw-smoke--sections","gw-smoke--unmanaged","inventory_all"]' \
  gw-gateway list
also "the healthy Gateway is healthy, programmed, with an address and attached routes" \
  "$(record gw-smoke--healthy) | .summary | .healthy and .accepted and .programmed and .hasAddress and .allListenersProgrammed and .allListenersRefsResolved and (.attachedRoutes >= 1) and (.unhealthy == [])"
also "its HTTPS listener names the certificate by reference only" \
  "$(record gw-smoke--healthy) | .listeners[] | select(.name == \"https\") | .tls == {mode: \"Terminate\", certificateRefs: [{group: \"\", kind: \"Secret\", name: \"wildcard\", namespace: \"gw-smoke\"}]} and .port == 443 and .hostname == \"*.example.org\""
also "its HTTP listener allows routes by selector and supports HTTPRoute" \
  "$(record gw-smoke--healthy) | .listeners[] | select(.name == \"http\") | .allowedRoutes.namespacesFrom == \"Selector\" and .allowedRoutes.namespaceSelector == \"routes=allowed\" and ([.supportedKinds[].kind] | index(\"HTTPRoute\") != null) and .attachedRoutes >= 1"
also "the class and both address lists are read" \
  "$(record gw-smoke--healthy) | .gatewayClassName == \"smoke\" and (.addresses.status | length == 1) and .apiVersion == \"gateway.networking.k8s.io/v1\""
also "a certificate that does not resolve: ResolvedRefs False on the listener, with the reason" \
  "$(record gw-smoke--bad-cert) | .summary | .healthy == false and .allListenersRefsResolved == false and (.unhealthy | map(select(.listener == \"https\" and .condition == \"ResolvedRefs\" and .status == \"False\" and .reason == \"InvalidCertificateRef\")) | length == 1)"
also "that Gateway is still Programmed True as a whole, which is why listeners are judged" \
  "$(record gw-smoke--bad-cert) | .summary.programmed == true and .summary.allListenersProgrammed == false"
also "two listeners in conflict: both named Conflicted True" \
  "$(record gw-smoke--conflict) | .summary | .anyListenerConflicted and (.unhealthy | map(select(.condition == \"Conflicted\" and .status == \"True\")) | map(.listener) | sort == [\"plain\",\"tls\"])"
also "a Gateway nobody manages: null, not healthy" \
  "$(record gw-smoke--unmanaged) | .summary | .programmed == null and .accepted == null and .healthy == false and .statusCurrent == null"
also "every inventory item carries one reason line, null when healthy" \
  "$(record inventory_all) | ([.items[] | select(.healthy) | .reason] == [null, null, null]) and ([.items[] | select(.healthy | not) | .reason | type] | unique == [\"string\"]) and (.items[] | select(.name == \"bad-cert\") | .dataName == \"gw-smoke--bad-cert\" and (.reason | startswith(\"listener https: \")))"
also "the Gateway whose listener was renamed is healthy; this controller keeps no status entry for the old name" \
  "$(record gw-smoke--renamed) | (.summary | .healthy and .leftoverListenerReports == 0 and .listenerCount == 2) and ([.listeners[].name] | sort == [\"after\",\"other\"])"
also "the inventory names the three that are not healthy, and why" \
  "$(record inventory_all) | .count == 6 and .healthyCount == 3 and .allHealthy == false and ([.unhealthy[].name] | sort == [\"bad-cert\",\"conflict\",\"unmanaged\"]) and (.unhealthy[] | select(.name == \"bad-cert\") | .reasons | index(\"listener https: ResolvedRefs=False (InvalidCertificateRef)\") != null)"
holds "get of an unhealthy Gateway is a record, not an error" \
  "$(record gw-smoke--bad-cert) | .summary.healthy == false" gw-gateway get name=bad-cert namespace=gw-smoke
holds "get takes the namespace from the model" \
  '[.dataArtifacts[].name] == ["gw-smoke--healthy"]' gw-gateway-ns get name=healthy
holds "list of one namespace writes that namespace's inventory" \
  "$(record inventory_ns_gw-smoke) | .namespace == \"gw-smoke\" and .count == 6" gw-gateway-ns list
holds "the namespace argument is read instead of the definition's; a namespace without Gateways is an empty inventory" \
  "$(record inventory_ns_apps) | .count == 0 and .allHealthy" gw-gateway-ns list namespace=apps
holds "an empty namespace argument on list means the definition's namespace" \
  "$(record inventory_ns_gw-smoke) | .namespace == \"gw-smoke\" and .count == 6" gw-gateway-ns list namespace=
holds "an empty namespace argument on get means the definition's namespace" \
  '[.dataArtifacts[].name] == ["gw-smoke--healthy"]' gw-gateway-ns get name=healthy namespace=

# HTTPRoutes
holds "list records twelve HTTPRoutes and one inventory" \
  '[.dataArtifacts[].name] | sort == ["apps--all-refuse","apps--ghost-parent","apps--missing-backend","apps--ok","apps--other-form","apps--partially-invalid","apps--renamed","apps--section-added","apps--section-removed","apps--two-controllers","apps--wrong-host","inventory_all","outside--not-allowed"]' \
  gw-httproute list
also "the attached route is healthy, with its parent, controller and both conditions" \
  "$(record apps--ok) | .summary.healthy and .summary.allParentsAccepted and .summary.allRefsResolved and (.parents[0] | .controllerName == \"$GW\" and .requested and .accepted and .refsResolved and .parentRef.name == \"healthy\" and .parentRef.namespace == \"gw-smoke\" and .parentRef.sectionName == \"http\")"
also "its hostnames, match and backend are read" \
  "$(record apps--ok) | .hostnames == [\"app.example.org\"] and .rules[0].matches[0].summary == \"GET PathPrefix /api\" and (.rules[0].backendRefs[0] | .name == \"echo\" and .namespace == \"apps\" and .port == 80 and .kind == \"Service\" and .weight == 1)"
also "a backend that does not exist: ResolvedRefs False, still accepted" \
  "$(record apps--missing-backend) | .summary | .allParentsAccepted and .allRefsResolved == false and .healthy == false and .unhealthy[0].condition == \"ResolvedRefs\" and .unhealthy[0].reason == \"BackendNotFound\""
also "a parent that does not exist: nobody reported, named as such" \
  "$(record apps--ghost-parent) | .parents == [] and (.summary | .reportedParentCount == 0 and .allParentsAccepted == false and .healthy == false and .unhealthy[0].parent == \"gw-smoke/no-such-gateway\" and .unhealthy[0].reason == \"NotReported\")"
also "a hostname the listener does not serve: Accepted False" \
  "$(record apps--wrong-host) | .summary | .allParentsAccepted == false and .unhealthy[0].reason == \"NoMatchingListenerHostname\""
also "a namespace the listener does not allow: Accepted False" \
  "$(record outside--not-allowed) | .summary | .allParentsAccepted == false and (.unhealthy | map(.reason) | index(\"NotAllowedByListeners\") != null)"
also "the route inventory gives the reason of each in one line" \
  "$(record inventory_all) | (.items[] | select(.name == \"missing-backend\") | .reason == \"parent gw-smoke/healthy/http ($GW): ResolvedRefs=False (BackendNotFound)\") and (.items[] | select(.name == \"ok\") | .reason == null)"
also "the inventory names the seven that are not healthy" \
  "$(record inventory_all) | .count == 12 and .unhealthyCount == 7 and ([.items[] | select(.healthy) | .dataName] | sort == [\"apps--ok\",\"apps--other-form\",\"apps--renamed\",\"apps--section-added\",\"apps--section-removed\"])"

# What a controller leaves behind, made by the controller under test:
# cluster.sh rename renamed a listener and the route followed.
also "a renamed listener: the controller's report for the old name is leftover, and the route is healthy" \
  "$(record apps--renamed) | (.summary | .healthy and .leftoverParentReports == 1 and .parentCount == 2 and .reportedParentCount == 2 and .statusCurrent == true and .unhealthy == []) and ([.parents[] | select(.requested | not) | [.parentRef.sectionName, .controllerName, .accepted, .current, .judged, .notJudgedBecause]] == [[\"before\", \"$GW\", false, false, false, \"not-requested\"]])"
also "the leftover report holds the controller's refusal, and the two listeners asked for are judged" \
  "$(record apps--renamed) | ([.parents[] | select(.requested | not) | .conditions[] | select(.type == \"Accepted\") | .reason] == [\"NoMatchingParent\"]) and ([.parents[] | select(.requested) | .parentRef.sectionName] | sort == [\"after\",\"other\"])"
also "the inventory lists that route as healthy, with no reason" \
  "$(record inventory_all) | .items[] | select(.name == \"renamed\") | .healthy and .reason == null"

# The route's own parent reference was edited (cluster.sh resection) and the
# controller kept its report in the old form beside the new one.
also "a listener name added to the parent: the kept report for the whole Gateway is superseded, and the route is healthy" \
  "$(record apps--section-added) | (.parentRefs[0].sectionName == \"a\") and (.summary | .healthy and .leftoverParentReports == 1 and .reportedParentCount == 1 and .statusCurrent == true and .unhealthy == []) and ([.parents[] | [.parentRef.sectionName, .controllerName, .requested, .current, .judged, .notJudgedBecause]] | sort_by(.[0] // \"\") == [[null, \"$GW\", true, false, false, \"superseded\"], [\"a\", \"$GW\", true, true, true, null]])"
also "a listener name taken away from the parent: the kept report for the listener is superseded, and the route is healthy" \
  "$(record apps--section-removed) | (.parentRefs[0].sectionName == null) and (.summary | .healthy and .leftoverParentReports == 1 and .refusedListenerReports == 0 and .statusCurrent == true and .unhealthy == []) and ([.parents[] | [.parentRef.sectionName, .requested, .current, .judged, .notJudgedBecause]] | sort_by(.[0] // \"\") == [[null, true, true, true, null], [\"a\", true, false, false, \"superseded\"]])"

# Status no controller here produces, written by cluster.sh written-status
# through the status subresource; the API server checked its shape.
also "a parent named without a listener, one listener accepts and one refuses: attached, the refusal counted and no finding" \
  "$(record apps--other-form) | (.summary | .parentCount == 1 and .reportedParentCount == 1 and .leftoverParentReports == 0 and .refusedListenerReports == 1 and .allParentsAccepted and .healthy and .unhealthy == []) and ([.parents[] | [.parentRef.sectionName, .accepted, .judged, .notJudgedBecause]] == [[\"http\", false, false, \"another-listener-accepted\"], [\"https\", true, true, null]])"
also "a parent named without a listener and every listener refuses: not accepted, each refusal a finding with its reason" \
  "$(record apps--all-refuse) | (.summary | .refusedListenerReports == 0 and .allParentsAccepted == false and .healthy == false) and ([.summary.unhealthy[] | [.parent, .controllerName, .condition, .reason]] == [[\"gw-smoke/unmanaged/http\", \"example.org/suite\", \"Accepted\", \"NotAllowedByListeners\"], [\"gw-smoke/unmanaged/https\", \"example.org/suite\", \"Accepted\", \"NoMatchingListenerHostname\"]])"
also "a report that left out the listener of the spec's parent is that parent's; PartiallyInvalid True is a finding" \
  "$(record apps--partially-invalid) | (.parents[0] | .requested and .parentRef.sectionName == null and .partiallyInvalid) and (.summary | .partiallyInvalid and .allParentsAccepted and .healthy == false) and ([.summary.unhealthy[] | [.parent, .controllerName, .condition, .status, .reason]] == [[\"gw-smoke/unmanaged\", \"example.org/suite\", \"PartiallyInvalid\", \"True\", \"UnsupportedValue\"]])"
also "two controllers on one parent, one stopped at an old generation: the finding names that controller and the parent" \
  "$(record apps--two-controllers) | ([.parents[] | [.controllerName, .current]] == [[\"example.org/suite\", true], [\"example.org/replaced-controller\", false]]) and (.summary.statusCurrent == false) and ([.summary.unhealthy[] | [.parent, .controllerName, .condition, .reason]] == [[\"gw-smoke/unmanaged/http\", \"example.org/replaced-controller\", null, \"StaleStatus\"]])"
also "the stale finding says which generation the report is for, and does not guess why" \
  "$(record apps--two-controllers) | .summary.unhealthy[0].message == \"this controller's report is for generation 1 of the route, which is now at generation 2\""
also "an inventory line names the controller" \
  "$(record inventory_all) | .items[] | select(.name == \"two-controllers\") | .reason == \"parent gw-smoke/unmanaged/http (example.org/replaced-controller): StaleStatus\""
holds "get of a rejected route is a record, not an error" \
  "$(record apps--wrong-host) | .summary.healthy == false" gw-httproute-ns get name=wrong-host

# GatewayClasses
holds "list records four classes: accepted, refused, unmanaged, and accepted on an unsupported version" \
  "($(record smoke) | .summary.accepted == true and .summary.healthy and .controllerName == \"$GW\" and .parametersRef.kind == \"EnvoyProxy\") and ($(record bad-parameters) | .summary.accepted == false and .summary.acceptedReason == \"InvalidParameters\") and ($(record nobody) | .summary.accepted == null and .summary.healthy == false) and ($(record unsupported-version) | .summary | .accepted == true and .supportedVersion == false and .healthy == false and ([.unhealthy[] | [.condition, .status, .reason]] == [[\"SupportedVersion\", \"False\", \"UnsupportedVersion\"]])) and ($(record inventory_all) | .count == 4 and .unhealthyCount == 3 and (.items[] | select(.name == \"unsupported-version\") | .reason == \"class: SupportedVersion=False (UnsupportedVersion)\"))" \
  gw-gatewayclass list
holds "get records one class" '[.dataArtifacts[].name] == ["smoke"]' gw-gatewayclass get name=smoke

# The pre-flight check: swamp does not run it before list and get, so it is
# run by hand.
(cd "$REPO" && swamp model validate gw-gateway --json) >"$OUT" 2>"$ERR"
also "swamp model validate runs the kubectl check, and it passes" \
  '[.validations[] | select(.name == "Check: kubectl-cli-available") | .passed] == [true]'

# The least an identity needs
for type in gateway httproute gatewayclass; do
  holds "$type list works with get and list on the three resources and nothing else" \
    "$(record inventory_all) | .count >= 3" "gw-$type-reader" list
done
no_secrets_stored
summary
