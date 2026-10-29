# @dataverket/signed-images

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

What makes them signed builds rather than steps in a row:

- **What is signed is what was built.** The signing steps take their references
  from this run's records, by run id, never from an input: the image records of
  the build, or the `builtHere` images of the resolution. The assertion at the
  end requires one signature and one verified verification per image the record
  counts.
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
empty), `annotations`, `recursive`, `tlog`, `signingConfig`, `trustedRoot`.

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
```

The next step of a release reads them through CEL, for instance the build record
as a predicate, `data.latest("ko-signed-images-ko", "buildRecord").path`, for an
`attest` of the build onto its images, or the rendered manifests for a
`flux push artifact`.

## Development

The workflows were run against `ko/fixtures/hello`, a throwaway `registry:2` in
podman and a key pair in a temporary vault: `ko-signed-manifests` over a
manifest naming both commands, `verified-manifests` over the rendered result,
and `verified-manifests` over the fixture's own deployment, which keeps one
image unpinned on purpose and fails the assertion by name.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
