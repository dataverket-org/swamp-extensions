# @dataverket/signed-images

Four [swamp](https://github.com/swamp-club/swamp) workflows that compose
[`@dataverket/ko`](../ko), [`@dataverket/cosign`](../cosign) and
[`@dataverket/flux`](../flux): Go images built by [ko](https://ko.build), signed
by digest with [cosign](https://github.com/sigstore/cosign) using a key held in
a vault, verified, and released as one OCI artifact pushed by
[flux](https://fluxcd.io), each in one run that fails unless all of it happened
for all of them.

| Workflow                          | Does                                                                                                                                                                                                                              | Models                                                              |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------- |
| `@dataverket/ko-signed-images`    | A signed build: every command of one Go module built and pushed, every image signed, every signature verified                                                                                                                     | `ko-signed-images-ko`, `ko-signed-images-cosign`                    |
| `@dataverket/ko-signed-manifests` | Signed manifests: `ko resolve` renders them with every `ko://` image built, pushed and pinned; each image is signed, the rendered manifests attested onto it, both verified                                                       | `ko-signed-manifests-ko`, `ko-signed-manifests-cosign`              |
| `@dataverket/verified-manifests`  | Every image a rendered manifest file names verified against a public key; read-only, a gate before a deploy                                                                                                                       | `verified-manifests-ko`, `verified-manifests-cosign`                |
| `@dataverket/signed-release`      | A signed release: a directory of rendered manifests pushed as one OCI artifact tagged with the commit, `release.json` listing every image by digest inside it; the artifact signed, the manifests attested onto it, both verified | `signed-release-ko`, `signed-release-flux`, `signed-release-cosign` |
Three [swamp](https://github.com/swamp-club/swamp) workflows that compose
[`@dataverket/ko`](../ko) and [`@dataverket/cosign`](../cosign): Go images built
by [ko](https://ko.build), signed by digest with
[cosign](https://github.com/sigstore/cosign) using a key held in a vault, and
verified, each in one run that fails unless all of it happened for all of them.

| Workflow                          | Does                                                                                                                                                                        | Models                                                 |
| --------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| `@dataverket/ko-signed-images`    | A signed build: every command of one Go module built and pushed, every image signed, every signature verified                                                               | `ko-signed-images-ko`, `ko-signed-images-cosign`       |
| `@dataverket/ko-signed-manifests` | Signed manifests: `ko resolve` renders them with every `ko://` image built, pushed and pinned; each image is signed, the rendered manifests attested onto it, both verified | `ko-signed-manifests-ko`, `ko-signed-manifests-cosign` |
| `@dataverket/verified-manifests`  | Every image a rendered manifest file names verified against a public key; read-only, a gate before a deploy                                                                 | `verified-manifests-ko`, `verified-manifests-cosign`   |
| `@dataverket/pinned-base-image`   | A base image mirrored by digest after a quarantine: the upstream tag watched, verified keyless, copied into our registry, signed with our key, verified                     | `base-image-watch`, `pinned-base-image`, two signers   |
Seven [swamp](https://github.com/swamp-club/swamp) workflows that compose
[`@dataverket/ko`](../ko), [`@dataverket/cosign`](../cosign),
[`@dataverket/flux`](../flux) and [`@dataverket/crane`](../crane): Go images
built by [ko](https://ko.build), signed by digest with
[cosign](https://github.com/sigstore/cosign) using a key held in a vault,
verified, released as one OCI artifact pushed by [flux](https://fluxcd.io), and
that release verified, promoted by retag and mirrored with
[crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md),
each in one run that fails unless all of it happened for all of them.

| Workflow                            | Does                                                                                                                                                                                                                              | Models                                                                                |
| ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------------------------------------- |
| `@dataverket/ko-signed-images`      | A signed build: every command of one Go module built and pushed, every image signed, every signature verified                                                                                                                     | `ko-signed-images-ko`, `ko-signed-images-cosign`                                      |
| `@dataverket/ko-signed-manifests`   | Signed manifests: `ko resolve` renders them with every `ko://` image built, pushed and pinned; each image is signed, the rendered manifests attested onto it, both verified                                                       | `ko-signed-manifests-ko`, `ko-signed-manifests-cosign`                                |
| `@dataverket/verified-manifests`    | Every image a rendered manifest file names verified against a public key; read-only, a gate before a deploy                                                                                                                       | `verified-manifests-ko`, `verified-manifests-cosign`                                  |
| `@dataverket/signed-release`        | A signed release: a directory of rendered manifests pushed as one OCI artifact tagged with the commit, `release.json` listing every image by digest inside it; the artifact signed, the manifests attested onto it, both verified | `signed-release-ko`, `signed-release-flux`, `signed-release-cosign`                   |
| `@dataverket/verify-release`        | The gate: the artifact's tag pinned to its digest, its signature and attestation verified, `release.json` read out of it, every image it lists verified; read-only                                                                | `verify-release-crane`, `verify-release-cosign`                                       |
| `@dataverket/promote-release`       | `verify-release`, then the channel tag such as `current` pointed at the verified digest and read back; the digest it held before recorded, for a rollback                                                                         | `promote-release-crane`, and `verify-release`'s                                       |
| `@dataverket/mirror-release-images` | `verify-release`, then every image it lists copied by digest into another registry with its signature tag, and verified there                                                                                                     | `mirror-release-images-crane`, `mirror-release-images-cosign`, and `verify-release`'s |

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

| Job        | Does                                                                                                             |
| ---------- | ---------------------------------------------------------------------------------------------------------------- |
| `describe` | `describe` on `@dataverket/ko/module`: module path, Go and ko versions, base image in effect. Read-only          |
| `build`    | `build`: one ko build per command, pushed to `repo`, each recorded as an image record with its digest            |
| `sign`     | `sign` on `@dataverket/cosign/signer`: every image this run built, by `repository@digest` from its image records |
| `verify`   | `verify` of the same images against the key's public half, then one assertion over the three counts              |

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
alone names it. One that mirrored several needs `baseImageRecord`, the record's
name, `mirror-<repository>-<tag>` with every `/` and `:` written as `-`:
`mirror-registry.example.org-mirror-static-latest`. A model or record that does
not exist fails the run before anything is built.

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

| Job       | Does                                                                                                                                    |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve` | `resolve` on `@dataverket/ko/module`: every `ko://` reference in `files` built, pushed and pinned; the rendered manifests become a file |
| `sign`    | `sign` of every image the resolution marks `builtHere`, by `repository@digest`                                                          |
| `attest`  | `attest` of the rendered manifests file onto each of them, predicate type `custom`                                                      |
| `verify`  | `verify` and `verifyAttestation` of the same images, then one assertion over the five counts                                            |

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

| Job       | Does                                                                                                                                              |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `resolve` | `resolve` on `@dataverket/ko/module` over `files`, pushing nothing: every image pinned by digest in them becomes the resolution record            |
| `verify`  | `verify` of every one of them, built here or not, against `publicKey`, then an assertion: every image pinned, one verification each, all verified |

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
| `resolve`         | `digest` on `@dataverket/crane/registry`, model `base-image-watch`: the upstream tag's digest, with `firstSeenAt` carried forward while the digest is unchanged. Read-only                          |
| `quarantine`      | An assertion: the digest has been the tag's for at least `minimumAgeDays`, from `firstSeenAt` to this run's start; it fails naming when the digest was first seen and when it may be mirrored       |
| `verify-upstream` | `verify` on `@dataverket/cosign/signer`, model `pinned-base-image-upstream`: keyless, the certificate identity and OIDC issuer of the upstream's release workflow, through the public log; asserted |
| `copy`            | `copy`, model `pinned-base-image`: the digest into `<registry>/<namespace>/<name>:<tag>`, `name` the upstream's last path segment; unchanged when already there                                     |
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
baseImage: ${{ data.latest("pinned-base-image", "mirror-registry.example.org-mirror-static-latest").attributes.target }}@${{ data.latest("pinned-base-image", "mirror-registry.example.org-mirror-static-latest").attributes.digest }}
```

`ko-signed-images` does that for you with `baseImageFrom=pinned-base-image`. The
mirror lands under the upstream's last path segment, `static` for
`cgr.dev/chainguard/static`, since crane's `copy` names the repository that way;
two upstreams with the same last segment need two namespaces.

## `verify-release`: the gate

| Job        | Does                                                                                                                                                                                                    |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
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

| Job             | Does                                                                                                                                                                                                                                                     |
| --------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verify`        | `@dataverket/verify-release` as a nested workflow, with the inputs passed through                                                                                                                                                                        |
| `copy`          | `copy` on `@dataverket/crane/registry`: every image `release.json` lists, by digest, into `<registry>/<namespace>/<name>:<tag>`; then, with `signatureTags`, `digest` of each image's `sha256-<hex>` tag at the source and `copy` of it beside the image |
| `verify-mirror` | `verify` of every mirrored image at its new location, from this run's mirror records, then one assertion over the counts: every listed image mirrored by its digest, every signature tag too when asked, every mirrored image verified                   |

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

The name an image lands under is the last path element of its source repository,
`registry.example.org/team/hello` into `registry.other.org/mirror/hello`, as
crane's `copy` names it; two images with the same last element collide, so give
them a namespace each. An image already at the target with that digest is
recorded `unchanged`. The credential logs in to the target only, so the source
registry is read anonymously, as for `@dataverket/mirror-image`.

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
the one it would have built.
image unpinned on purpose and fails the assertion by name. `pinned-base-image`
ran against the real `cgr.dev/chainguard/static:latest`, which Chainguard signs
keyless, into the throwaway registry: with `minimumAgeDays: 0` the whole chain
passed, with the default the quarantine failed as it should for a digest first
seen that day; `ko-signed-images` with `baseImageFrom=pinned-base-image` then
built `fixtures/hello` on the mirror, the mirror's layer being the built image's
first.
the one it would have built. `verify-release` was run on that release, by tag
and by digest, with and without its annotation, and on an artifact pushed
without a signature, which fails at the first assertion; `promote-release` moved
`current` to it, then to a second release with the first's digest in
`previousDigest`, then found it already there; `mirror-release-images` copied
both images and their signature tags into a second `registry:2` and verified
them there, found them unchanged on a second run, and with
`signatureTags: false` into another namespace failed the assertion naming both
images.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
