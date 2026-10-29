---
name: signed-images
description: >
  Pick and run the @dataverket/signed-images workflows: a signed build with
  ko and cosign, signed and verified manifests, a signed OCI release artifact
  pushed with flux, the release gate, promotion by retag, mirroring a release
  with its signatures, and a quarantined, verified base image mirror. Use when
  asked to "build a signed container", "release to the registry", "promote a
  release", "verify a release before deploy", "mirror a release", "pin the
  base image", or to wire ko, cosign, flux and crane together.
---

# signed-images

`@dataverket/signed-images` holds only workflows. Each creates its own models on
first use, named after itself, reads every digest from a record of the same run
or from the artifact, and ends with an assertion. The generic pieces are
`@dataverket/ko`, `@dataverket/cosign`, `@dataverket/flux` and
`@dataverket/crane`; use those directly for anything these workflows do not
compose.

## Pick the workflow

| Intent                                                       | Workflow                            | Needs                    |
| ------------------------------------------------------------ | ----------------------------------- | ------------------------ |
| Build every command of a Go module, push, sign, verify       | `@dataverket/ko-signed-images`      | key in a vault           |
| Render manifests with images built, signed, attested         | `@dataverket/ko-signed-manifests`   | key in a vault           |
| Gate: every image a rendered file names is signed            | `@dataverket/verified-manifests`    | a public key, read-only  |
| Release: rendered directory as one signed OCI artifact       | `@dataverket/signed-release`        | key in a vault, flux     |
| Gate: a release artifact and every image it lists are signed | `@dataverket/verify-release`        | a public key, read-only  |
| Promote: move a channel tag to a verified release            | `@dataverket/promote-release`       | registry credential      |
| Mirror a release's images with their signatures elsewhere    | `@dataverket/mirror-release-images` | registry credential      |
| Pin a base image: quarantine, verify upstream, mirror, sign  | `@dataverket/pinned-base-image`     | credential, key, keyless |

The release flow, in order: `ko-signed-manifests` or `ko-manifests` renders,
`signed-release` pushes and signs the artifact tagged with the commit,
`verify-release` gates, `promote-release` moves `current`, and rollback is
`promote-release` again with the previous digest the `tagging` record kept.

## Rules every workflow follows

- A secret is never an input value: keys, passphrases and registry credentials
  are named by vault and key, and such inputs are required, since a `vault.get`
  is resolved when the run starts.
- A digest is never an input to a signing step: it comes from this run's ko,
  flux or crane record, or from the artifact's `release.json`.
- A verification that fails is a record with cosign's reason; the workflow's
  assertion fails the run and names every image that did not verify.
- Runs for different modules or keys share a workflow's models, so run one at a
  time.

## Read what a run did

```sh
swamp data query 'modelName == "signed-release-flux" && specName == "artifact"' --json
swamp data query 'modelName == "verify-release-cosign" && specName == "verification"' --json
swamp data query 'modelName == "promote-release-crane" && specName == "tagging"' --json
swamp data query 'modelName == "pinned-base-image" && specName == "mirror"' --json
```

A build takes its base from the mirror with one line:

```yaml
baseImageFrom: pinned-base-image
```

## Do not

- Pass `tlog: false` to `pinned-base-image`'s upstream check: keyless signatures
  live in the transparency log, so that signer always requires it; only our own
  signature on the mirror follows `tlog`.
- Expect `cosign copy` to carry signatures to another registry: cosign 3.1.4
  copies the image instead of the bundle index against a registry without the
  referrers API. `mirror-release-images` copies the `sha256-<hex>` tag with
  crane; with a referrers-capable registry, set `signatureTags: false` and carry
  referrers with `oras` first.
- Run `swamp behavior type search` or `swamp vault list` without `--json` inside
  a scripted session: both open an interactive picker.
