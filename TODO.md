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
   - A data name longer than 255 bytes cannot be stored, and only flux's
     artifact name is checked today. `<namespace>--<name>` reaches 318 bytes for
     an object name above about 185 characters; the method acts and then fails
     to store its record. Check in `dataName`, before anything runs.
   - A time limit stops the process that was started, not its children. Seen on
     rootless Podman: `podman compose` stopped, its `docker-compose` child ran
     four seconds more (`salmon/README.md`).
   - An x509 error from kubectl is classified `unreachable`; kind tells them
     apart from the text itself.
7. **`http`: `bodyContains` reads the body with no size limit.** `bodyJson`
   stops at 1 MiB.

## Later

An OIDC client-check type (discovery, authorize redirect, no credential); Incus
`oidc.issuer` read, possibly on top of `@whitemars/incus`; the login-time
passkey migration as a Zitadel Action.
