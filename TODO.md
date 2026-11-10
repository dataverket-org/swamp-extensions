# TODO

What is open in this repository, checked against the code on 2026-11-10.

## Written on 2026-11-10, to commit and publish

Each is at 2026.11.10.1 with its tests, live suite and review; none is in the
registry yet.

- `@dataverket/http`: `bodyJson`, exact JSON fields beside `bodyContains`.
- `@dataverket/flux`: helmrelease `get` with the Helm history, last action and
  hook Jobs; names checked in every method.
- New `@dataverket/gateway-api`, `@dataverket/cert-manager`, `@dataverket/cnpg`.
- `@dataverket/kind` and `@dataverket/salmon`, moved onto `lib/`.
- `lib/`, the shared process and kubectl layer (README "Shared code"). Flux,
  gateway-api, cert-manager, cnpg, kind and salmon import it.

After the first extension that imports `lib/` is published, pull it into an
empty swamp repository and run one method before publishing the others: a push
dry run and a load from source both work, and a pulled copy has not been tried.
gateway-api is the one to start with, new and read-only.

## Open

1. **The other extensions that run a command, onto `lib/cli.ts`.** Each has its
   own spawn helper today; of them only crane stops a process that hangs.
   - cosign, crane, ko, sops, docker-compose: testable here without the estate's
     credentials. sops first: its failure text is `stderr || stdout`, and sops's
     stdout is the decrypted plaintext. A copy, a build and a YubiKey wait each
     need a time limit of their own; the default is 60 s.
   - openstack, talosctl, omnictl: last and most carefully. Set a time limit per
     call before switching the runner, since a volume or node operation stopped
     half way is worse than one that hangs.
2. **New `@dataverket/dns`.** Nordhost DirectAdmin zone records (list, verify,
   delete a retired name), deSEC token mint and rotate, and a plain resolver
   assertion (record type, server, TTL) instead of `dig` by hand.
3. **File a swamp issue on `@swamp/s3-datastore`.** After a tombstone its
   cleanup deletes `<name>/<version>/metadata.yaml` twice, fails with
   `NoSuchKey`, then "Failed to release locks during cleanup". Seen 2026-11-07
   17:22 UTC on datastore 2026.10.24.2, swamp 20261030.003603.0; no data lost.
   Check first whether 2026.11.09.1 still does it.
4. **Ask `@swamp/kubernetes` for a generic custom-resource `list` and `get`.**
   It reads one custom resource today, ExternalSecret, written by hand. With a
   generic read, gateway-api, cert-manager and cnpg could drop their plain reads
   and keep the summaries, `trace`, `renew` and the Backup `create`.
5. **CloudNativePG 1.30.1: one Backup that never finishes seems to hold up the
   others.** Seen twice on kind (`cnpg/smoke/README.md`): a Backup of a Cluster
   whose archive never worked stays `running`, and after it a Backup of another,
   healthy Cluster gets no phase for minutes; the operator does not restart and
   reports every Cluster healthy. Not investigated. Reproduce on its own, then
   report it upstream.
6. **AGENTS.md for this repository,** and after it two skills for agents working
   here: a new extension from the pattern, and the publish sequence.
7. **`lib/`, for its next change** (each moves the hash of every extension that
   imports it):
   - A data name longer than 255 bytes cannot be stored, and only flux's
     artifact name is checked today. `<namespace>--<name>` reaches 318 bytes for
     an object name above about 185 characters; the method acts and then fails
     to store its record. Check in `dataName`, before anything runs.
   - A time limit stops the process that was started, not its children. Seen on
     rootless Podman: `podman compose` stopped, its `docker-compose` child ran
     four seconds more (`salmon/README.md`).
   - An x509 error from kubectl is classified `unreachable`; kind tells them
     apart from the text itself.
8. **`http`: `bodyContains` reads the body with no size limit.** `bodyJson`
   stops at 1 MiB.

## fabrikk-infra, not here

- Pull the 2026.11.10.1 versions once published. `bodyJson` with the issuer on
  `zitadel-oidc-id` and `zitadel-oidc-id-osl1`, with `bodyJsonShowValues: true`
  since the document is public.
- Definitions for gateway-api and cert-manager with the readers context; for
  cnpg after the readers group may read CloudNativePG objects.
- `dataverket-prod-helm` and `dataverket-prod-kustomizations` read with the
  admin context; a second definition with the readers context would keep the
  lists off it.
- A `@swamp/kubernetes/configmap` behavior for zitadel (the type exists);
  `apiUrl` repeated in twelve zitadel definitions; the site instance of the
  site-names plan R4, steps 2 to 4.

## Later

An OIDC client-check type (discovery, authorize redirect, no credential); Incus
`oidc.issuer` read, possibly on top of `@whitemars/incus`; the login-time
passkey migration as a Zitadel Action.
