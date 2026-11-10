# TODO

What is open in this repository, checked against the code on 2026-11-10.

1. **The other extensions that run a command, onto `lib/cli.ts`.** Each has its
   own spawn helper today; of them only crane stops a process that hangs.
   - cosign, crane, ko, sops, docker-compose: testable without credentials of
     any estate. sops first: its failure text is `stderr || stdout`, and sops's
     stdout is the decrypted plaintext. A copy, a build and a YubiKey wait each
     need a time limit of their own; the default is 60 s.
   - openstack, talosctl, omnictl: last and most carefully. Set a time limit per
     call before switching the runner, since a volume or node operation stopped
     half way is worse than one that hangs.
2. **New `@dataverket/dns`.** Nordhost DirectAdmin zone records (list, verify,
   delete a retired name), deSEC token mint and rotate, and a plain resolver
   assertion (record type, server, TTL) instead of `dig` by hand.
3. **Ask `@swamp/kubernetes` for a generic custom-resource `list` and `get`.**
   It reads one custom resource today, ExternalSecret, written by hand. With a
   generic read, gateway-api, cert-manager and cnpg could drop their plain reads
   and keep the summaries, `trace`, `renew` and the Backup `create`.
4. **CloudNativePG 1.30.1: one Backup that never finishes seems to hold up the
   others.** Seen three times on kind (`cnpg/smoke/README.md`): a Backup of a
   Cluster whose archive never worked stays `running`, and after it a Backup of
   another, healthy Cluster gets no phase for minutes; the operator does not
   restart and reports every Cluster healthy. Not investigated. Reproduce on its
   own, then report it upstream.
5. **Two skills for agents working here:** a new extension from the pattern, and
   the publish sequence. `AGENTS.md` has the rules they build on.
6. **`lib/`, for its next change** (each moves the hash of every extension that
   imports it):
   - `lib/cli.ts` has `encodedName` and `assertDataName` since 2026-11-10, and
     renovate uses them. The kubectl extensions do not yet:
     `<namespace>--<name>` reaches 318 bytes for an object name above about 185
     characters, and the method acts and then fails to store its record. Check
     in `assertDistinctDataNames`, which gateway-api, cert-manager and cnpg call
     before their first write, so one long name does not fail a whole list; flux
     needs the call added.
   - flux's `instanceName` for an artifact is not injective for characters
     outside the basic plane (its expression has no `u` flag), and keeps a
     leading dot and `..`. Moving it to `encodedName` changes published names.
   - A time limit stops the process that was started, not its children. Seen on
     rootless Podman: `podman compose` stopped, its `docker-compose` child ran
     four seconds more (`salmon/README.md`).
   - An x509 error from kubectl is classified `unreachable`; kind tells them
     apart from the text itself.
7. **`http`: `bodyContains` reads the body with no size limit.** `bodyJson`
   stops at 1 MiB.

8. **File a swamp issue: a nested workflow step's inputs are not checked against
   the called workflow's input schema.** `additionalProperties: false` holds
   from the command line only, so a mistyped input of a nested call was ignored.
   The nine signed-images workflows check their own input names in a first step
   because of it. A two-workflow reproduction with built-in steps exists.
9. **renovate: a GitHub token.** Without one Renovate skips every lookup on
   GitHub tags and releases, so a GitHub Action pin is never checked. It would
   come from a vault reference and reach the container through its environment.
10. **cosign: the build type of early `actions/attest-build-provenance`
    releases** is on the allowlist from its document; which releases wrote it is
    not confirmed.

## Later

An OIDC client-check type (discovery, authorize redirect, no credential); Incus
`oidc.issuer` read, possibly on top of `@whitemars/incus`; the login-time
passkey migration as a Zitadel Action.
