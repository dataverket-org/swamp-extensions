# @dataverket/signed-images

Nine [swamp](https://github.com/swamp-club/swamp) workflows that compose
[`@dataverket/ko`](../ko), [`@dataverket/cosign`](../cosign),
[`@dataverket/flux`](../flux) and [`@dataverket/crane`](../crane): Go images
built by [ko](https://ko.build), signed by digest with
[cosign](https://github.com/sigstore/cosign) using a key held in a vault,
verified, released as one OCI artifact pushed by [flux](https://fluxcd.io), that
release verified, promoted by retag and mirrored with
[crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md),
the base image they build on quarantined, verified and mirrored, and any
upstream image's signature verified keyless, with its provenance when asked;
each in one run that fails unless all of what it was asked happened for all of
them. A skill, `signed-images`, says which to run for what.

| Workflow                              | Does                                                                                                                                                                                                                                                                                | Models                                                                                            |
| ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------- |
| `@dataverket/ko-signed-images`        | A signed build: every command of one Go module built and pushed, every image signed, every signature verified; the base image from a `pinned-base-image` record when asked                                                                                                          | `ko-signed-images-ko`, `ko-signed-images-cosign`                                                  |
| `@dataverket/ko-signed-manifests`     | Signed manifests: `ko resolve` renders them with every `ko://` image built, pushed and pinned; each image is signed, the rendered manifests attested onto it, both verified                                                                                                         | `ko-signed-manifests-ko`, `ko-signed-manifests-cosign`                                            |
| `@dataverket/verified-manifests`      | Every image a rendered manifest file names verified against a public key; read-only, a gate before a deploy                                                                                                                                                                         | `verified-manifests-ko`, `verified-manifests-cosign`                                              |
| `@dataverket/signed-release`          | A signed release: a directory of rendered manifests pushed as one OCI artifact tagged with the commit, `release.json` listing every image by digest inside it; the artifact signed, the manifests attested onto it, both verified                                                   | `signed-release-ko`, `signed-release-flux`, `signed-release-cosign`                               |
| `@dataverket/verify-release`          | The gate: the artifact's tag pinned to its digest, its signature and attestation verified, `release.json` read out of it, every image it lists verified; read-only                                                                                                                  | `verify-release-crane`, `verify-release-cosign`                                                   |
| `@dataverket/promote-release`         | `verify-release`, then the channel tag such as `current` pointed at the verified digest and read back; the digest it held before recorded, for a rollback                                                                                                                           | `promote-release-crane`, and `verify-release`'s                                                   |
| `@dataverket/mirror-release-images`   | `verify-release`, then every image it lists copied by digest into another registry with its signature tag, and verified there                                                                                                                                                       | `mirror-release-images-crane`, `mirror-release-images-cosign`, and `verify-release`'s             |
| `@dataverket/pinned-base-image`       | A base image resolved to its digest, held in quarantine until that digest has been the tag's for `minimumAgeDays`, verified keyless against the publisher's identity, copied into our registry by digest, signed with our key and verified                                          | `base-image-watch`, `pinned-base-image-upstream`, `pinned-base-image`, `pinned-base-image-cosign` |
| `@dataverket/verified-upstream-image` | An upstream image resolved to its digest and its signature verified keyless against the publisher's identity; when asked, also its attestation of a type, and the source repository and commit of its provenance held to what was given; read-only, a gate before the image is used | `verified-upstream-image-crane`, `verified-upstream-image-cosign`                                 |

What makes them signed builds rather than steps in a row:

- **What is signed is what was built.** The signing steps take their references
  from this run's records, by run id, never from an input: the image records of
  the build, the `builtHere` images of the resolution, or the artifact flux
  pushed. The assertion at the end requires one signature and one verified
  verification per image the record counts.
- **The key never travels as a value.** It is named by vault and key, read into
  the signer's arguments by `vault.get` at step time, and handed to cosign
  through its environment. Workflow inputs are recorded in cleartext in the run
  history, so a secret must never be one.
- **Nothing is signed by tag.** ko records digests; cosign refuses anything
  else.

Each workflow creates its models on first use and shares them between runs, so
run one module at a time.

## `ko-signed-images`: a signed build

| Job        | Does                                                                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputs`   | One assertion, `known-inputs`: every input given is one this workflow has; it is what holds a step of another workflow to the inputs. Nothing runs when it fails |
| `describe` | `describe` on `@dataverket/ko/module`: module path, Go and ko versions, base image in effect. Read-only                                                          |
| `build`    | `build`: one ko build per command, pushed to `repo`, each recorded as an image record with its digest                                                            |
| `sign`     | `sign` on `@dataverket/cosign/signer`: every image this run built, by `repository@digest` from its image records                                                 |
| `verify`   | `verify` of the same images against the key's public half, then one assertion over the three counts                                                              |

Inputs: ko's, as in `@dataverket/ko-images`: `dir`, `repo` (required), `tags`,
`importPaths`, `naming`, `platforms`, `sbom`, `baseImage`, `cache`,
`insecureRegistry`. cosign's, as in `@dataverket/cosign-sign`: `keyVault`,
`keyKey` and `passphraseKey` (required), `passphraseVault` (the key's vault when
empty), `annotations`, `recursive`, `tlog`, `signingConfig`, `trustedRoot`. And
two of its own, `baseImageFrom` and `baseImageRecord`, which read the base image
from a `pinned-base-image` mirror record instead of `baseImage`; see below.

```sh
swamp extension pull @dataverket/signed-images

swamp workflow run @dataverket/ko-signed-images \
  --input dir=services/api \
  --input repo=registry.example.org/team \
  --input 'importPaths:json=["./cmd/..."]' \
  --input 'tags:json=["abc123","latest"]' \
  --input keyVault=signing --input keyKey=cosign-key \
  --input passphraseKey=cosign-password \
  --input 'annotations:json=["commit=abc123"]'
```

A multi-platform build pushes an index per command; the index digest is what is
signed, and `recursive: true` signs every image in it too.

### The base image from a mirror record

With `baseImageFrom` set to the name of a crane model, `pinned-base-image` for
the one `@dataverket/pinned-base-image` creates, the ko steps take their
`baseImage` argument from that model's latest `mirror` record, `target` and
`digest` composed into `<target>@<digest>`, so every command is built on the
base that workflow quarantined, verified keyless, mirrored and signed, and never
on a tag ko would resolve on its own. `baseImage` is then ignored. The
expression both ko steps evaluate, at run start, is

```yaml
baseImage: >-
  ${{ inputs.baseImageFrom == "" ? inputs.baseImage : data.findBySpec(inputs.baseImageFrom, "mirror").filter(m, inputs.baseImageRecord == "" || m.name == inputs.baseImageRecord).map(m, m.attributes.target + "@" + m.attributes.digest)[0] }}
```

A model that mirrored one base image has one mirror record, and `baseImageFrom`
alone names it. One that holds several, records an older crane left under other
names among them, needs `baseImageRecord`, the record's name,
`mirror-<repository>-<tag>` with every `/` and `:` written as `-`:
`mirror-registry.example.org-mirror-cgr.dev-chainguard-static-latest`. The run
never guesses: unless exactly one record matches, it fails before anything is
built.

```sh
swamp workflow run @dataverket/ko-signed-images \
  --input dir=services/api \
  --input repo=registry.example.org/team \
  --input baseImageFrom=pinned-base-image \
  --input keyVault=signing --input keyKey=cosign-key \
  --input passphraseKey=cosign-password
```

The `module` record of `ko-signed-images-ko` says which base was in effect:
`baseImage` holds the pinned reference and `baseImageSource` is `argument`.

## `ko-signed-manifests`: signed manifests

| Job       | Does                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputs`  | One assertion, `known-inputs`: every input given is one this workflow has; it is what holds a step of another workflow to the inputs. Nothing runs when it fails |
| `resolve` | `resolve` on `@dataverket/ko/module`: every `ko://` reference in `files` built, pushed and pinned; the rendered manifests become a file                          |
| `sign`    | `sign` of every image the resolution marks `builtHere`, by `repository@digest`                                                                                   |
| `attest`  | `attest` of the rendered manifests file onto each of them, predicate type `custom`                                                                               |
| `verify`  | `verify` and `verifyAttestation` of the same images, then one assertion over the five counts                                                                     |

Inputs: ko's, as in `@dataverket/ko-manifests`: `dir`, `repo` and `files`
(required), `recursive`, `selector`, `tags`, `naming`, `platforms`, `sbom`,
`baseImage`, `cache`, `insecureRegistry`; cosign's: `keyVault`, `keyKey` and
`passphraseKey` (required), `passphraseVault`, `annotations`, `tlog`.

```sh
swamp workflow run @dataverket/ko-signed-manifests \
  --input dir=services/api \
  --input repo=registry.example.org/team \
  --input 'files:json=["services/api/deploy"]' --input recursive=true \
  --input 'tags:json=["abc123"]' \
  --input keyVault=signing --input keyKey=cosign-key \
  --input passphraseKey=cosign-password \
  --input 'annotations:json=["commit=abc123"]'
```

Every image carries, as a `custom` attestation, the exact manifests it was
rendered into, so a verifier can read back from the registry what a digest was
meant to run as. Third-party images pinned in the manifests are listed in the
resolution record with `builtHere: false` but neither signed nor verified here;
`verified-manifests` checks them all. An image not pinned at all is listed in
the resolution's `unpinned`; this workflow does not refuse it, since the
manifests may pin it later, but `verified-manifests` does.

## `verified-manifests`: a gate

| Job       | Does                                                                                                                                                             |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputs`  | One assertion, `known-inputs`: every input given is one this workflow has; it is what holds a step of another workflow to the inputs. Nothing runs when it fails |
| `resolve` | `resolve` on `@dataverket/ko/module` over `files`, pushing nothing: every image pinned by digest in them becomes the resolution record                           |
| `verify`  | `verify` of every one of them, built here or not, against `publicKey`, then an assertion: every image pinned, one verification each, all verified                |

Inputs: `files` and `publicKey` (required; a PEM or a file, nothing secret),
`dir` (a Go module for ko to run in, default `.`), `repo`, `annotations`,
`tlog`, `insecureRegistry`.

```sh
swamp workflow run @dataverket/verified-manifests \
  --input dir=services/api \
  --input 'files:json=["rendered/app.yaml"]' \
  --input publicKey=keys/cosign.pub \
  --input 'annotations:json=["commit=abc123"]'
```

The image lister is `ko resolve`, since no generic model extracts images from a
file yet, so `dir` must be a Go module. Manifests already rendered hold no
`ko://` reference and pass through unchanged; every image in them is verified as
it is. A file that still holds a `ko://` reference has it re-resolved: built
here, not pushed, named under `repo`, and the resulting digest is what gets
verified, which only holds when the build is reproducible, the base image pinned
by digest and the tree unchanged. Run it on rendered files. An image not pinned
by digest cannot be verified and fails the assertion by name.

Verifying the rendered manifests of a `ko-signed-manifests` run, read through
CEL:

```yaml
inputs:
  files:
    - ${{ data.latest("ko-signed-manifests-ko", "manifests").path }}
```

## `signed-release`: one artifact per environment

| Job       | Does                                                                                                                                                                                                                                                 |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputs`  | One assertion, `known-inputs`: every input given is one this workflow has; it is what holds a step of another workflow to the inputs. Nothing runs when it fails                                                                                     |
| `resolve` | `resolve` on `@dataverket/ko/module` over the directory, pushing nothing: every image pinned by digest in it becomes the resolution record; then an assertion, before anything is pushed: every image pinned, at least one, none built here          |
| `push`    | `push_artifact` on `@dataverket/flux/source`: the directory pushed as `oci://<repository>:<tag>`, reproducibly, with `release.json` built from the resolution record written into the pushed copy; the artifact record holds the digest flux printed |
| `sign`    | `sign` of the artifact by `repository@digest` from that record, then `attest` of the rendered manifests this run's resolve wrote onto it, as a `custom` predicate                                                                                    |
| `verify`  | `verify` and `verifyAttestation` of the artifact, then one assertion over the counts: one artifact, one signature, one attestation, both verified                                                                                                    |

Inputs: `path` (the rendered directory, relative to the repository root),
`environment`, `repository` (`<registry>/<path>`, one per environment), `source`
and `revision` (what Flux shows on the OCIRepository; `revision` is the tag
unless `tag` is given), the key's `keyVault`, `keyKey` and `passphraseKey`, all
required; `dir` (a Go module for ko to run in, default `.`), `tag`,
`passphraseVault`, `annotations` (on the artifact and on its signature), `tlog`,
`insecureRegistry`.

```sh
swamp workflow run @dataverket/signed-release \
  --input path=rendered/prod --input environment=prod \
  --input repository=registry.example.org/team/release/prod \
  --input source=https://git.example.org/team/config \
  --input revision=abc123 \
  --input keyVault=signing --input keyKey=cosign-key \
  --input passphraseKey=cosign-password \
  --input 'annotations:json=["commit=abc123"]'
```

`release.json` is what a later step reads to know what the release contains
without parsing manifests:

```json
{
  "environment": "prod",
  "revision": "abc123",
  "source": "https://git.example.org/team/config",
  "resolution": "cf7d18db-a761-4a8a-98a3-854954dccc58",
  "imageCount": 2,
  "images": [
    {
      "repository": "registry.example.org/team/hello",
      "digest": "sha256:d69d…",
      "builtHere": false
    },
    {
      "repository": "registry.example.org/team/other",
      "digest": "sha256:90a5…",
      "builtHere": false
    }
  ]
}
```

Every value in it comes from this run's resolution record or from the inputs
that name the release; no digest is an input. `builtHere` is false throughout a
release, since the directory is already rendered and ko built nothing here: the
`ko-signed-manifests` run that produced it is the record of what was built. It
holds no timestamp, but the resolution id is new on every run, so two runs over
the same directory push two digests, each the record of its own run; the push
itself is reproducible (`flux push artifact --reproducible`).

The directory is a release only when every image in it is pinned by digest and
none has to be built: a `ko://` reference still in it would be built here and
pushed nowhere, so the run fails before the push, naming the unpinned and the
built. The image lister is `ko resolve`, so `dir` must be a Go module, as for
`verified-manifests`. A `ko-manifests` or `ko-signed-manifests` run records its
rendered output as a file, not a directory; copy it into the directory to
release
(`swamp data query 'modelName == "ko-manifests" && name == "manifests"'
--select content`),
beside whatever else the OCIRepository should carry.

What the artifact carries in the registry: the signature of its digest and a
`custom` attestation whose predicate is the rendered manifests as this run's
resolve wrote them, the same content the artifact holds. `release.json` itself
is bound by the signature, since the artifact digest covers it, but it is not
the attestation's predicate: flux writes it into a copy that is removed after
the push and records only that it did, and no workflow step writes a file of its
own. A tag can move; the records, the signature and the attestation name the
digest. `revision` in flux's `<branch>@sha1:<commit>` form is not a valid tag,
so give `tag` beside it.

Reading it back without swamp:

```sh
cosign tree registry.example.org/team/release/prod@sha256:…
cosign verify --key cosign.pub -a commit=abc123 registry.example.org/team/release/prod@sha256:…
flux pull artifact oci://registry.example.org/team/release/prod:abc123 --output ./pulled
```

## `pinned-base-image`: a quarantined, verified and signed base image

| Job               | Does                                                                                                                                                                                                |
| ----------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputs`          | One assertion, `known-inputs`: every input given is one this workflow has; it is what holds a step of another workflow to the inputs. Nothing runs when it fails                                    |
| `resolve`         | `digest` on `@dataverket/crane/registry`, model `base-image-watch`: the upstream tag's digest, with `firstSeenAt` carried forward while the digest is unchanged. Read-only                          |
| `quarantine`      | An assertion: the digest has been the tag's for at least `minimumAgeDays`, from `firstSeenAt` to this run's start; it fails naming when the digest was first seen and when it may be mirrored       |
| `verify-upstream` | `verify` on `@dataverket/cosign/signer`, model `pinned-base-image-upstream`: keyless, the certificate identity and OIDC issuer of the upstream's release workflow, through the public log; asserted |
| `copy`            | `copy`, model `pinned-base-image`: the digest into `<registry>/<namespace>/<source registry>/<path>:<tag>`; unchanged when already there                                                            |
| `sign`            | `sign`, model `pinned-base-image-cosign`: the mirror, by `repository@digest` from this run's mirror record, with our key                                                                            |
| `verify`          | `verify` of the mirror against our key's public half, then one assertion over the five records                                                                                                      |

Inputs: `ref` (required), the upstream tag with its registry; `registry`
(required) and `namespace` (default `mirror`); the registry credential as in
`@dataverket/mirror-image`, `vault`, `usernameKey` and `passwordKey` (required);
`certificateIdentityRegexp` and `oidcIssuer` for the keyless check (defaults:
Chainguard's release workflow, `^https://github.com/chainguard-images/images/`,
and GitHub's issuer); our key as in `ko-signed-images`, `keyVault`, `keyKey` and
`passphraseKey` (required), `passphraseVault`; `minimumAgeDays` (default `7`,
`0` mirrors whatever the tag resolves to now); `tlog` for our signature (default
`false`; the upstream is always verified through the log); `insecureRegistry`
for the mirror registry.

```sh
swamp workflow run @dataverket/pinned-base-image \
  --input ref=cgr.dev/chainguard/static:latest \
  --input registry=registry.example.org \
  --input vault=registry --input usernameKey=username --input passwordKey=password \
  --input keyVault=signing --input keyKey=cosign-key \
  --input passphraseKey=cosign-password
```

The watch is shared. The `resolve` step records on the model
`@dataverket/base-image-watch` creates, `base-image-watch`, so a tag watched
daily has its `firstSeenAt` ready when the mirror is asked for, and a tag never
watched starts its quarantine at the first mirror attempt: the run fails with
`<ref> is <digest>, first seen <time>, which is less than 7 days before this run
started; it may be mirrored from <time>`,
and passes once that time has come. The quarantine is the CEL line

```yaml
expr: >-
  inputs.minimumAgeDays == 0
  || timestamp(run.startedAt) - timestamp(data.findBySpec("base-image-watch", "digest").filter(d, d.tags.?workflowRunId.orValue("") == run.id)[0].attributes.firstSeenAt) >= duration(string(inputs.minimumAgeDays * 24) + "h")
```

Every digest comes from this run's records: the keyless verification, the copy
and our signature all read the digest record, never an input, and the final
assertion requires the mirror, the signature and our verification to carry
exactly that digest. The upstream is verified with one signer and the mirror
signed with another, since a signer's `tlog` is one choice for both sides and
the upstream signature lives in the log while ours, by default, does not.

What a build reads is the `mirror` record of the model `pinned-base-image`,
named `mirror-<repository>-<tag>` with `/` and `:` as `-`:

```yaml
baseImage: ${{ data.latest("pinned-base-image", "mirror-registry.example.org-mirror-cgr.dev-chainguard-static-latest").attributes.target }}@${{ data.latest("pinned-base-image", "mirror-registry.example.org-mirror-cgr.dev-chainguard-static-latest").attributes.digest }}
```

`ko-signed-images` does that for you with `baseImageFrom=pinned-base-image`. The
mirror lands at the upstream's registry and whole path under the namespace,
`mirror/cgr.dev/chainguard/static` for `cgr.dev/chainguard/static`, as crane's
`copy` puts it, so two upstreams never share a repository.

## `verify-release`: the gate

| Job        | Does                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputs`   | One assertion, `known-inputs`: every input given is one this workflow has; it is what holds a step of another workflow to the inputs. Nothing runs when it fails                                        |
| `pin`      | `digest` on `@dataverket/crane/registry`: the artifact's tag resolved to its digest; every step after names that digest. Read-only                                                                      |
| `artifact` | `verify` and `verifyAttestation` (type `custom`) of the artifact against `publicKey`, an assertion that both verified, then `blob` reads `release.json` out of the artifact's layer as a record         |
| `images`   | `verify` of every image `release.json` lists, `repository@digest`, against the same key, then one assertion: one artifact, verified, attested, read, at least one image, every image verified, none not |

Inputs: `repository` and `publicKey` (required; a PEM or a file, nothing
secret), `tag` or `digest` (one of the two, checked first), `annotations` (what
the artifact's signature must carry), `tlog`, `insecureRegistry`. No credential:
it reads, and crane and cosign read with the container config of the user
running swamp.

```sh
swamp workflow run @dataverket/verify-release \
  --input repository=registry.example.org/team/release/prod --input tag=abc123 \
  --input publicKey=keys/cosign.pub \
  --input 'annotations:json=["commit=abc123"]'
```

A tag is pinned once, by crane, and the digest record is what cosign verifies
and what `blob` reads, so the artifact that was verified is the artifact whose
`release.json` is read, even if the tag moves during the run. The images are
verified by the `repository` and `digest` the release lists, never by tag, and
without annotations: the release's images may have been signed by several
builds. An artifact nobody signed fails at the first assertion, by its
signature, before anything is read out of it; a release with an image whose
signature is missing or wrong fails at the last, naming the image and cosign's
reason.

## `promote-release`: a retag

| Job       | Does                                                                                                                                                                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputs`  | One assertion, `known-inputs`: every input given is one this workflow has; it is what holds a step of another workflow to the inputs. Nothing runs when it fails                              |
| `verify`  | `@dataverket/verify-release` as a nested workflow, with the inputs passed through                                                                                                             |
| `promote` | `tag` on `@dataverket/crane/registry`: the channel tag pointed at the digest the nested run verified; `digest` reads the channel back; an assertion that it holds exactly the verified digest |

Inputs: `verify-release`'s, plus `channel` (required, the tag to move, such as
`current`), and the registry credential crane tags with, `vault`, `usernameKey`
and `passwordKey` (required: swamp resolves every `vault.get` at run start).

```sh
swamp workflow run @dataverket/promote-release \
  --input repository=registry.example.org/team/release/prod --input tag=abc123 \
  --input channel=current \
  --input publicKey=keys/cosign.pub \
  --input vault=registry --input usernameKey=username --input passwordKey=password
```

The digest the channel is pointed at is the nested run's `digest` record, read
as the output of the step that ran it (`steps.release.outputs.digest.digest`),
never an input; the channel is read back after the retag and must hold it. The
`tagging` record of `promote-release-crane` keeps `previousDigest`, the digest
the channel held before, empty when the channel is new: that is the rollback
value, and a rollback is a promotion of it, `--input digest=<previousDigest>` in
place of `tag`. A channel already at the digest is recorded `changed: false` and
crane is not run. The registry is the first path element of `repository`, the
repository under it the rest; the credential must be allowed to write there.

```sh
swamp data query 'modelName == "promote-release-crane" && specName == "tagging"' --select content
```

## `mirror-release-images`: a mirror with signatures

| Job             | Does                                                                                                                                                                                                                                                                       |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputs`        | One assertion, `known-inputs`: every input given is one this workflow has; it is what holds a step of another workflow to the inputs. Nothing runs when it fails                                                                                                           |
| `verify`        | `@dataverket/verify-release` as a nested workflow, with the inputs passed through                                                                                                                                                                                          |
| `copy`          | `copy` on `@dataverket/crane/registry`: every image `release.json` lists, by digest, into `<registry>/<namespace>/<source registry>/<path>:<tag>`; then, with `signatureTags`, `digest` of each image's `sha256-<hex>` tag at the source and `copy` of it beside the image |
| `verify-mirror` | `verify` of every mirrored image at its new location, from this run's mirror records, then one assertion over the counts: every listed image mirrored by its digest, every signature tag too when asked, every mirrored image verified                                     |

Inputs: `verify-release`'s, plus the target `registry` (required), `namespace`
(default empty, the registry's root), `imageTag` (the tag every mirrored image
gets; the release's `revision` when empty, which must then be an image tag),
`signatureTags` (default `true`), and `vault`, `usernameKey` and `passwordKey`
(required) for the registry mirrored into.

```sh
swamp workflow run @dataverket/mirror-release-images \
  --input repository=registry.example.org/team/release/prod --input tag=abc123 \
  --input publicKey=keys/cosign.pub \
  --input registry=registry.other.org --input namespace=mirror \
  --input vault=registry --input usernameKey=username --input passwordKey=password
```

An image lands at its source registry and whole path under the namespace,
`registry.example.org/team/hello` into
`registry.other.org/mirror/registry.example.org/team/hello`, as crane's `copy`
puts it, so two images never share a repository. An image already at the target
with that digest is recorded `unchanged`. The credential logs in to the target
only, so the source registry is read anonymously, as for
`@dataverket/mirror-image`.

Signatures do not travel with `crane copy`: it copies the manifest the digest
names and nothing that refers to it. cosign 3 stores signatures and attestations
as OCI referrers, and on a registry without the referrers API, `registry:2`
among them, under the fallback tag `sha256-<hex of the image digest>`, an index
of Sigstore bundles. With `signatureTags`, the default, that tag is resolved at
the source and copied with the same `copy`, the whole index with every bundle,
so the verification at the target finds them; seen to carry a release's
signatures and attestations between two `registry:2`. On a registry that serves
the referrers API cosign writes no such tag, the `digest` step fails because it
is not there, and the referrers have to be carried another way before the run,
with `signatureTags: false`: `oras copy -r`, as cosign's own `copy` help
suggests; `cosign copy` 3.1.4 was tried and copied the image to the fallback tag
in place of the bundles, so the target did not verify. The run then reports what
it finds: an image whose signatures did not arrive fails the assertion by name
with `no signatures found`.

## `verified-upstream-image`: a gate for an image someone else built

None of the other workflows verifies an upstream image keyless without also
mirroring or signing it. This one only reads. What it checks is what its inputs
ask for, and with `attestationType` empty that is the signature alone:

| Given                                          | A pass proves                                                                                                                                                                 |
| ---------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `attestationType` empty                        | The digest the reference names now was signed by that identity, vouched for by that issuer (`oidcIssuer`, GitHub's unless you say otherwise), and the signature is in the log |
| an `attestationType`                           | Also: that identity signed an attestation of that type whose subject is this digest. Nothing yet about what the attestation says                                              |
| and `sourceRepository`, `sourceCommit` or both | Also: that attestation is provenance of a known build type, and it names exactly that repository and commit as the source                                                     |

`attestationType` has no default and must be given, as a type or as empty, so
that a run says which of these it is; many images carry no provenance, so the
workflow cannot ask for it on its own. No pass says that the source is good, or
that anything runs this digest: a workload that pulls by tag can get another
one. Run it when a pinned upstream tag changes, before the image is used.

| Job       | Does                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| --------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `inputs`  | Six assertions over the inputs alone. First `known-inputs`: every input given is one this workflow has, `ref` and `attestationType` are given, and every input is text. Then, once it holds: exactly one of `certificateIdentity` and `certificateIdentityRegexp`; an expression that starts with `^` and ends with `$`; no source without an `attestationType`; an `attestationType` that is not the one cosign stores the signature under; a `sourceRepository` with an expression and SLSA provenance. Nothing is read when one fails |
| `resolve` | `digest` on `@dataverket/crane/registry`, model `verified-upstream-image-crane`: the reference resolved to its digest, then an assertion that this run recorded exactly one, of that reference. A tag that does not exist fails here                                                                                                                                                                                                                                                                                                     |
| `verify`  | `verify` on `@dataverket/cosign/signer`, model `verified-upstream-image-cosign`, keyless, of `repository@digest` from this run's record; an assertion that the cosign extension is new enough; an assertion that it verified. Then, unless `attestationType` is empty, `verifyAttestation`; asserted                                                                                                                                                                                                                                     |

Inputs: `ref` (required), the image with its registry, as `<repository>:<tag>`,
`<repository>@sha256:<digest>` or both, `<repository>:<tag>@sha256:<digest>`,
the form a pin is written in; with both, the digest is what is read and
verified, and the tag is not compared with it: the digest record of the run
repeats the input's tag in `tag` and `pinned`, which says what was asked, not
that the registry has that tag at that digest. `certificateIdentity` or
`certificateIdentityRegexp`, exactly one, the identity in the signing
certificate. `oidcIssuer` (default GitHub's issuer,
`https://token.actions.githubusercontent.com`). `attestationType` (required;
empty skips the attestation steps), such as `slsaprovenance1`,
`slsaprovenance02` or `spdxjson`. `sourceRepository` and `sourceCommit` (default
empty), which the provenance must then name exactly. An input the workflow does
not have is refused, so a mistyped name cannot switch a check off: from the
command line by the input schema, before the run starts, and from a step of
another workflow by the first assertion, `known-inputs`, since swamp does not
hold a nested step's inputs to the child's schema. That assertion also refuses a
nested step that leaves out `ref` or `attestationType`, or gives any of the
seven inputs as something that is not text, such as `null`, `false` or a list.
One `attestationType` is refused by name: `https://sigstore.dev/cosign/sign/v1`,
the type cosign 3 stores the signature itself under. Every signed image has one,
so it would pass with nothing attested and read as more than the signature.

An expression must start with `^` and end with `$`. An unanchored one matches
any identity that contains it: `.*` with GitHub's issuer accepts a signature
from any workflow in any repository on GitHub. The assertion catches a forgotten
anchor and nothing more: `^.*$` and `^a$|.*$` start and end as asked and match
everything. What the expression matches is yours to see to: write the whole
identity, escape the dots, and put alternatives in one group between the
anchors.

No vault and no credential of its own: crane and cosign read the registry with
the container config of the user running swamp. A public image needs no login. A
login stored for that registry is used when there is one, and a stale one can
make the read of a public image fail.

```sh
swamp workflow run @dataverket/verified-upstream-image \
  --input ref=ghcr.io/<owner>/<image>:<tag> \
  --input certificateIdentity=https://github.com/<owner>/<repository>/.github/workflows/<workflow>.yml@refs/heads/main \
  --input attestationType=slsaprovenance1 \
  --input sourceRepository=https://github.com/<owner>/<repository> \
  --input sourceCommit=<40 hex>
```

`@dataverket/cosign` must be at 2026.11.10.1 or later in the repository that
runs this workflow; `swamp extension pull @dataverket/cosign` brings it once
that version is published. That version's `verifyAttestation` counts only an
attestation whose subject is the digest verified, records the source its
provenance names, takes `sourceRepository` and `sourceCommit`, and writes into
every verification record the identity and issuer it was checked against. With
an older cosign extension the run fails at `cosign-version`, after the signature
step and before anything is asserted from its record, with
`This workflow needs @dataverket/cosign 2026.11.10.1 or later: ...`.

Every step after `resolve` names the digest this run resolved, never the tag
again and never an older record. The assertions hold each record to what this
run gave: the verification must carry this run's identity and issuer, and the
attestation verification also this run's type, `sourceRepository` and
`sourceCommit` as what it was asked (`expectedSourceRepository`,
`expectedSourceCommit`), so a source that was asked for is checked by the method
and again by the workflow, and a run cannot pass on a record made with another
run's arguments.

A run that fails says where and why: at `digest` for a tag that is not in the
registry; at `signed-by-identity` with
`<ref> is <digest>, and that digest has no signature from <identity> vouched for
by <issuer>. Do not use this image. cosign said: ...`;
at `attested-by-identity` with the record's reason, such as
`1 attestation verified by cosign, none counted: sourceCommit is "<found>", not "<expected>"`.

### Runs for one reference must not overlap

The models are shared by every run in a repository, and a record is named after
the image, so two runs of the same reference write the same records. A run whose
record another run replaced finds none of its own and fails with
`This run's record of <ref> is not there: another run of the same reference in
this repository replaced it. Runs for one reference in one repository must not
overlap; run again.`
It never passes on the other run's record. Runs that give different identities
also share the signer's arguments; a run whose verification was made with
another run's identity fails saying so. Run them one after the other, or in
separate repositories.

### Provenance signed by another identity

One identity serves both checks. Some publishers do not sign their provenance
with the workflow that signs the image: with the `slsa-github-generator`, the
repository's release workflow signs the image and the generator's reusable
workflow signs the provenance. Such an image fails at `attested-by-identity`
against the image's identity, and the message says so.

The generator signs provenance for any repository on GitHub that calls it. Its
identity therefore says nothing about whose build it was; only the provenance
does. To verify such an image, give an expression for exactly the two
identities, and you must give `sourceRepository`: without it, provenance of any
repository's build would count. The workflow refuses an expression with a SLSA
provenance type and no `sourceRepository` for that reason, also when the
expression names one identity, since it cannot tell. A SLSA provenance type is
an `attestationType` that starts with `slsaprovenance` (`slsaprovenance`,
`slsaprovenance02`, `slsaprovenance1`) or with `https://slsa.dev/provenance/`.
The consequence: with an expression, SLSA provenance from a builder for which
`@dataverket/cosign` derives no source cannot pass, since the `sourceRepository`
the workflow requires can never be met; name one identity with
`certificateIdentity` there. The alternatives go in one group between the
anchors, with the dots escaped:

```sh
--input 'certificateIdentityRegexp=^https://github\.com/(<owner>/<repository>/\.github/workflows/release\.yml|slsa-framework/slsa-github-generator/\.github/workflows/generator_container_slsa3\.yml)@refs/tags/v[0-9]+\.[0-9]+\.[0-9]+$' \
--input attestationType=slsaprovenance \
--input sourceRepository=https://github.com/<owner>/<repository>
```

With such an expression the image's signature may come from either identity too,
so the generator's identity would also pass as the image's signer; the
`sourceRepository` is what ties the result to the publisher. A source is derived
for SLSA v1 of GitHub's workflow build type and for v0.2 of the generator's
build types (`@dataverket/cosign`'s README lists them); for any other predicate
the summary is empty, and a `sourceRepository` or `sourceCommit` then fails the
run.

### As a step of another workflow

```yaml
- name: upstream
  task:
    type: workflow
    workflowIdOrName: "@dataverket/verified-upstream-image"
    inputs:
      ref: ${{ inputs.ref }}
      certificateIdentity: https://github.com/<owner>/<repository>/.github/workflows/<workflow>.yml@refs/heads/main
      attestationType: slsaprovenance1
      sourceRepository: https://github.com/<owner>/<repository>
      sourceCommit: ${{ inputs.sourceCommit }}
```

The outer step fails with the inner assertion's message.

## Changed since 2026.10.29.2

- A ninth workflow, `@dataverket/verified-upstream-image`.
- Every workflow now refuses an input it does not have. A caller that passes an
  input name the workflow never declared, which was ignored before, gets
  `Input validation failed: <name> is not a valid input property` from the
  command line, where the input schema is closed. A step of another workflow is
  not held to that schema by swamp, so each workflow has a new first job,
  `inputs`, with one assertion, `known-inputs`, that fails with
  `Not inputs of this workflow: <names>`; the workflow's other jobs wait for it.
- A run of one of the other eight that failed under 2026.10.29.2 cannot be
  resumed after the upgrade: swamp refuses to resume a run of a workflow that
  has gained a job. Start a new run. The reason: a mistyped `annotations`,
  `tlog`, `digest` or `certificateIdentityRegexp` silently ran with the default,
  which verifies less than was asked. No input was added to, removed from or
  renamed in the other eight.

## The key

The passphrase always comes from a vault; a key without one has an empty
passphrase stored beside it. Swamp resolves every `vault.get` in a step's
arguments at run start, so `keyVault`, `keyKey` and `passphraseKey` are required
and `passphraseVault` falls back to `keyVault`. With `tlog` false, the default,
signatures and attestations go to the registry only, through a signing config
with no transparency log; with `tlog` true they are recorded in Rekor and a log
entry is required to verify. `insecureRegistry` serves both tools: plain HTTP
for ko, an unverified certificate or plain HTTP for cosign.

```sh
COSIGN_PASSWORD=... cosign generate-key-pair       # cosign.key, cosign.pub
swamp vault put signing cosign-key < cosign.key
swamp vault put signing cosign-password
rm cosign.key
```

## What gets recorded

```sh
swamp data query 'modelName == "ko-signed-images-ko" && name == "build"' --select content
swamp data query 'modelName == "ko-signed-manifests-ko" && name == "resolution"' --select content
swamp data query 'modelName == "ko-signed-manifests-cosign" && specName == "attestation"' --json
swamp data query 'modelName == "verified-manifests-cosign" && specName == "verification"' --json
swamp data query 'modelName == "signed-release-flux" && specName == "artifact"' --json
swamp data query 'modelName == "pinned-base-image" && specName == "mirror"' --json
swamp data query 'modelName == "base-image-watch" && specName == "digest"' --json
swamp data query 'modelName == "verify-release-crane" && specName == "blob"' --select content
swamp data query 'modelName == "promote-release-crane" && specName == "tagging"' --json
swamp data query 'modelName == "mirror-release-images-crane" && specName == "mirror"' --json
swamp data query 'modelName == "verified-upstream-image-cosign" && specName == "attestationVerification"' --json
```

The next step of a release reads them through CEL, for instance the build record
as a predicate, `data.latest("ko-signed-images-ko", "buildRecord").path`, for an
`attest` of the build onto its images, or the artifact record's `ref` for a
promotion by retag.

## Development

The workflows were run against `ko/fixtures/hello`, a throwaway `registry:2` in
podman and a key pair in a temporary vault: `ko-signed-manifests` over a
manifest naming both commands, `verified-manifests` over the rendered result,
and `verified-manifests` over the fixture's own deployment, which keeps one
image unpinned on purpose and fails the assertion by name. `signed-release` was
run over the rendered result of a `ko-manifests` run copied into a directory,
pushed to the same registry, and the artifact's signature and attestation were
read back with `cosign tree`, `cosign verify` and `flux pull artifact`; over the
fixture's own deployment it fails before the push, naming the unpinned image and
the one it would have built. image unpinned on purpose and fails the assertion
by name. `pinned-base-image` ran against the real
`cgr.dev/chainguard/static:latest`, which Chainguard signs keyless, into the
throwaway registry: with `minimumAgeDays: 0` the whole chain passed, with the
default the quarantine failed as it should for a digest first seen that day;
`ko-signed-images` with `baseImageFrom=pinned-base-image` then built
`fixtures/hello` on the mirror, the mirror's layer being the built image's
first. the one it would have built. `verify-release` was run on that release, by
tag and by digest, with and without its annotation, and on an artifact pushed
without a signature, which fails at the first assertion; `promote-release` moved
`current` to it, then to a second release with the first's digest in
`previousDigest`, then found it already there; `mirror-release-images` copied
both images and their signature tags into a second `registry:2` and verified
them there, found them unchanged on a second run, and with
`signatureTags: false` into another namespace failed the assertion naming both
images.

`verified-upstream-image` has a live suite, run through swamp from a scratch
repository against two public images: what passes, what fails and at which step,
what is refused before the registry is read, a publisher whose provenance is
signed by another identity than its image, the workflow as a nested step, three
runs started together, and an older cosign extension. It is not part of the
published extension; it is in the repository, under
[`signed-images/smoke`](https://github.com/dataverket-org/swamp-extensions/tree/main/signed-images/smoke),
with a README that says how to run it and what it ran on. For this version the
other eight workflows were validated, and one refusal of a mistyped input was
run, here. An independent review ran each of the eight once to a successful end
against local throwaway registries with a throwaway key on 2026-11-10:
`ko-signed-images`, `ko-signed-manifests`, `verified-manifests`,
`signed-release`, `verify-release`, `promote-release`, `mirror-release-images`,
and `pinned-base-image` with `minimumAgeDays=0`. Not run then: multi-platform
builds, `tlog: true`, `signatureTags: false`, and a registry that needs a login.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
