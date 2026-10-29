# @dataverket/signed-images

One [swamp](https://github.com/swamp-club/swamp) workflow,
`@dataverket/ko-signed-images`: a signed build. Every command of one Go module
is built into an image by [ko](https://ko.build) and pushed, every image is
signed by digest with [cosign](https://github.com/sigstore/cosign) using a key
held in a vault, and every signature is verified, in one run that fails unless
all three happened for all of them.

## What a run does

| Job        | Does                                                                                                            |
| ---------- | --------------------------------------------------------------------------------------------------------------- |
| `describe` | `describe` on `@dataverket/ko/module`: module path, Go and ko versions, base image in effect. Read-only         |
| `build`    | `build`: one ko build per command, pushed to `repo`, each recorded as an image record with its digest           |
| `sign`     | `sign` on `@dataverket/cosign/signer`: every image this run built, by `repository@digest` from its image records |
| `verify`   | `verify` of the same images against the key's public half, then one assertion over the three counts            |

What makes it a signed build rather than three steps in a row:

- **What is signed is what was built.** The `sign` step takes its references
  from this run's image records, by run id, never from an input, and the
  assertion requires one signature and one verified verification per image the
  build record counts.
- **The key never travels as a value.** It is named by vault and key, read into
  the signer's arguments by `vault.get` at step time, and handed to cosign
  through its environment.
- **Nothing is signed by tag.** ko records digests; cosign refuses anything
  else.

## Inputs

ko's, as in `@dataverket/ko-images`: `dir`, `repo` (required), `tags`,
`importPaths`, `naming`, `platforms`, `sbom`, `baseImage`, `cache`,
`insecureRegistry`. cosign's, as in `@dataverket/cosign-sign`: `keyVault`,
`keyKey` and `passphraseKey` (required), `passphraseVault` (the key's vault
when empty), `annotations`, `recursive`, `tlog`, `signingConfig`,
`trustedRoot`. The passphrase always comes from a vault; a key without one has
an empty passphrase stored beside it. `insecureRegistry` serves both: plain
HTTP for ko, an unverified certificate or plain HTTP for cosign.

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

With `tlog` false, the default, signatures go to the registry only, through a
signing config with no transparency log; with `tlog` true they are recorded in
Rekor and a log entry is required to verify. A multi-platform build pushes an
index per command; the index digest is what is signed, and `recursive: true`
signs every image in it too.

## What gets recorded

The models are `ko-signed-images-ko` and `ko-signed-images-cosign`, created on
first use and shared by every run, so run one module at a time. The build's
evidence is theirs:

```sh
swamp data query 'modelName == "ko-signed-images-ko" && name == "build"' --select content
swamp data query 'modelName == "ko-signed-images-cosign" && specName == "verification"' --json
```

The next step of a release reads them through CEL, for instance to attest the
build record onto the images with `attest`, or to gate a deploy with
`@dataverket/cosign-verify` on the same digests.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
