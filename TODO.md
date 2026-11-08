# TODO

What swamp could not do while planning the Zitadel rename and the site names
(notes of 2026-11-01 to 2026-11-08), checked against the code on 2026-11-08.
Seven items, roughly in the order the plans need them.

1. **flux/helmrelease: `get` with Helm history.** Revision, hook job results,
   install vs upgrade, instead of parsing `readyMessage` text.
2. **http/endpoint: `bodyJson`.** An exact JSON field assertion
   (`{issuer: "..."}`) beside `bodyContains`.
3. **New `@dataverket/gateway-api`.** `gateway` (listeners, Programmed and
   ResolvedRefs per listener, attached routes, addresses) and `httproute`
   (per-parent Accepted and ResolvedRefs, hostnames, backendRefs), read-only.
4. **New `@dataverket/cert-manager`.** Certificate, CertificateRequest, Order
   and Challenge read (Ready, notAfter, dnsNames, DNS-01 state) and a forced
   renewal.
5. **New `@dataverket/cnpg`.** Cluster status (primary, instances, WAL), the
   last ScheduledBackup result, on-demand Backup create and status.
6. **New `@dataverket/dns`.** Nordhost DirectAdmin zone records (list, verify,
   delete a retired name), deSEC token mint and rotate, and a plain resolver
   assertion (record type, server, TTL) instead of `dig` by hand.
7. **File a swamp issue on `@swamp/s3-datastore`.** After a tombstone its
   cleanup deletes `<name>/<version>/metadata.yaml` twice, fails with
   `NoSuchKey`, then "Failed to release locks during cleanup". Seen 2026-11-07
   17:22 UTC on datastore 2026.10.24.2, swamp 20261030.003603.0; no data lost.

## Checked and not on the list

- Done: `zitadel/user passkeyRegistrationLinkCreate` (2026.11.02.1),
  `zitadel/system` domain methods (2026.11.02.1), `settings secretGeneratorSet`
  (2026.11.06.1), `flux/source` lists HelmRepository and OCIRepository
  (2026.10.29.1), a `@swamp/kubernetes/job` behavior for the zitadel namespace.
  On branch `zitadel-instance` as 2026.11.08.1, awaiting merge and publish:
  `system instanceList` and `instanceCreate`; the `instance` type (read,
  memberList, trusted domains); `settings read` with email providers and
  notification settings; `authFactorList` over every human with an
  `auth-summary` per person.
- fabrikk-infra, not here: a `@swamp/kubernetes/configmap` behavior for
  zitadel (the type exists); `apiUrl` repeated in eleven zitadel definitions;
  after 2026.11.08.1 is pulled, a `@dataverket/zitadel/instance` definition
  with the reader key, and the site instance of the site-names plan R4.
- Later: an OIDC client-check type (discovery, authorize redirect, no
  credential); Incus `oidc.issuer` read, possibly on top of `@whitemars/incus`;
  the login-time passkey migration as a Zitadel Action.
