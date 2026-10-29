# @dataverket/cosign

Container images signed and verified with
[cosign](https://github.com/sigstore/cosign), as swamp data: key-based, with or
without a transparency log, attestations and signed files included. One model
type, `@dataverket/cosign/signer`, one signing identity; two workflows that
bring their own model; and a skill, `cosign`, that says which to run for what.

| Method              | Runs                                  | Records                                                                                                                                                     |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describe`          | `cosign version`, `cosign public-key` | `signer`: version, how the key was given, the public key in effect and its fingerprint, log and config choices                                              |
| `generateKeyPair`   | `cosign generate-key-pair`            | `keypair`: both halves; the private one is a sensitive field, which swamp keeps in the vault, an encrypted PEM whose passphrase is `password`, empty or not |
| `sign`              | `cosign sign` per image               | One `signature-<repository>-<digest>` per image: reference, digest, annotations                                                                             |
| `verify`            | `cosign verify` per image             | One `verification-<repository>-<digest>` per image: verified or not, the payloads found, cosign's reason                                                    |
| `attest`            | `cosign attest` per image             | One `attestation-<repository>-<digest>` per image: type, predicate file and its sha256                                                                      |
| `verifyAttestation` | `cosign verify-attestation` per image | One `attestationVerification-<repository>-<digest>` per image: verified or not, the predicate types                                                         |
| `signBlob`          | `cosign sign-blob --bundle`           | `blobSignature-<file>`: the file's sha256 and the Sigstore bundle written beside it                                                                         |
| `verifyBlob`        | `cosign verify-blob --bundle`         | `blobVerification-<file>`: verified or not, cosign's reason                                                                                                 |

Written and tested against cosign 3.1.4.

## The key

A signer names its private key in one argument, `key`, in one of three forms,
and the model tells them apart:

- **A PEM**, written as a vault expression. It reaches cosign through its
  environment, `--key env://COSIGN_KEY`: never a file, never an argument, and
  never in a record, a log or an error message.
- **A KMS or HSM reference**: `awskms://`, `gcpkms://`, `azurekms://`,
  `hashivault://`, `k8s://` or `pkcs11:`, passed to cosign as it is, which
  authenticates to that service its own way.
- **A key file**, absolute or relative to the repository root.

`password` is the key's passphrase, a vault expression too, empty for an
unencrypted key; it reaches cosign as `COSIGN_PASSWORD`. `publicKey`, for
`verify`, is a PEM or a file; when empty it is derived from `key`, so a signer
that signs can verify its own signatures with nothing more.

```sh
COSIGN_PASSWORD=... cosign generate-key-pair       # cosign.key, cosign.pub
swamp vault put signing cosign-key < cosign.key
swamp vault put signing cosign-password
rm cosign.key

swamp model create @dataverket/cosign/signer release \
  --global-arg 'key=${{ vault.get("signing", "cosign-key") }}' \
  --global-arg 'password=${{ vault.get("signing", "cosign-password") }}'

swamp model method run release sign \
  --input 'refs:json=["registry.example.org/team/api@sha256:<digest>"]' \
  --input 'annotations:json=["commit=abc123"]'
swamp model method run release verify \
  --input 'refs:json=["registry.example.org/team/api@sha256:<digest>"]' \
  --input 'annotations:json=["commit=abc123"]'
```

`generateKeyPair` does the first step through the model: the private half lands
in the `keypair` record as a sensitive field, which swamp stores in the vault
and shows as a reference, so a signer can name it as
`${{ data.latest("release", "keypair").attributes.privateKey }}`.

| Argument           | Default  |                                                                                                                        |
| ------------------ | -------- | ---------------------------------------------------------------------------------------------------------------------- |
| `key`              |          | The private key: a PEM, a KMS or HSM reference, or a file. Empty for a signer that only verifies                       |
| `password`         |          | The key's passphrase; empty for an unencrypted key                                                                     |
| `publicKey`        |          | A PEM or a file, for `verify`; derived from `key` when empty                                                           |
| `tlog`             | `false`  | Record signatures in a transparency log and require a log entry when verifying                                         |
| `signingConfig`    |          | A Sigstore signing config file, relative to the repository root, for `sign` and `attest`; replaces what `tlog` chooses |
| `trustedRoot`      |          | A Sigstore trusted root file, relative to the repository root, for private infrastructure                              |
| `insecureRegistry` | `false`  | Allow a registry whose certificate does not verify                                                                     |
| `httpRegistry`     | `false`  | Allow a registry served over plain HTTP                                                                                |
| `cosignBinary`     | `cosign` |                                                                                                                        |

Every reference is a digest, `<repository>@sha256:<64 hex>`. A tag is refused
before cosign runs: a tag can move, and what a signature vouches for is the
digest. `sign` and `verify` take `annotations` as `key=value`; a signature
carries them, and a verification requires them. `sign` also takes `recursive`
(sign every image of an index too) and `upload` (false signs and discards, a
rehearsal). `attest` takes `predicate`, a file, and `type`: `slsaprovenance1`,
`spdxjson`, `cyclonedx`, `vuln`, `openvex`, `custom` (the default) or a URI;
`verifyAttestation` takes `type`. `signBlob` and `verifyBlob` take `path`, a
file, and `bundle`, the Sigstore bundle beside it, `<path>.sigstore.json` when
not given: a release manifest or a checksum file signed the same way as the
images, with the same key and the same log choice.

## The transparency log

cosign 3 records every signature in a transparency log, Rekor, unless its
signing config names no log service, and requires a log entry when verifying
unless told to ignore the log. `tlog` chooses both sides at once:

- `false`, the default: `sign` and `attest` run with a signing config the model
  generates per run with `cosign signing-config create`, which has no Rekor and
  no timestamp authority, so the signature goes to the registry only; `verify`
  and `verifyAttestation` run with `--insecure-ignore-tlog`. This is what a
  private registry with a key of its own wants.
- `true`: cosign's defaults, which means the public Sigstore instance: the
  signature is uploaded to Rekor, and verification requires the entry.

For a private Rekor or timestamp authority, `signingConfig` names your own
signing config and `trustedRoot` your own trusted root; both are passed to
cosign as files.

cosign 3 stores signatures and attestations as OCI referrers of the image, with
a `sha256-<hex>` tag as the fallback for registries without the referrers API;
`cosign tree <ref>` shows them. Against the registry the live test uses, that
tag was the only one written, so do not look for the older `.sig` tag.

## Verification is a record, not a failure

An image that does not verify is recorded as `verified: false` with cosign's
reason in `error`, such as
`no matching attestations: missing or incorrect
annotation` or
`... accepted signatures do not match threshold`, so a workflow can assert over
the records and name every image that failed. Only cosign failing for another
reason, a registry it cannot reach or a key it cannot load, fails the method.
Nothing is recorded then.

## Workflows

Each creates its model on first use, named after itself, and ends with an
assertion. The key and its passphrase are named by vault and key, never passed
as values: workflow inputs are recorded in cleartext in the run history.

| Workflow                    | Does                                                                                                                         | Model           |
| --------------------------- | ---------------------------------------------------------------------------------------------------------------------------- | --------------- |
| `@dataverket/cosign-sign`   | `sign` every ref with the vault's key, then `verify` each against its public half; fails unless all verify                   | `cosign-sign`   |
| `@dataverket/cosign-verify` | `verify` every ref against a public key given as a PEM or a file; fails unless all verify. Read-only, a gate before a deploy | `cosign-verify` |

```sh
swamp extension pull @dataverket/cosign

swamp workflow run @dataverket/cosign-sign \
  --input 'refs:json=["registry.example.org/team/api@sha256:<digest>"]' \
  --input keyVault=signing --input keyKey=cosign-key \
  --input passphraseKey=cosign-password \
  --input 'annotations:json=["commit=abc123"]'

swamp workflow run @dataverket/cosign-verify \
  --input 'refs:json=["registry.example.org/team/api@sha256:<digest>"]' \
  --input publicKey=keys/cosign.pub \
  --input 'annotations:json=["commit=abc123"]'
```

Inputs common to both: `refs` (required), `annotations`, `tlog`, `trustedRoot`,
`insecureRegistry`, `httpRegistry`. `cosign-sign` takes `keyVault`, `keyKey` and
`passphraseKey` (required), `passphraseVault` (the key's vault when empty),
`recursive` and `signingConfig`; `cosign-verify` takes `publicKey` (required).
The passphrase always comes from a vault, since swamp resolves every `vault.get`
at run start and an unset one fails the run: for a key without a passphrase,
store an empty one beside it, `swamp vault put signing cosign-password ""`, and
name it all the same. A signed build, ko then cosign in one run, is
`@dataverket/ko-signed-images` in `@dataverket/signed-images`.

## Commands

The model runs `cosign version`, `cosign public-key`,
`cosign signing-config create`, `cosign generate-key-pair`, `cosign sign`,
`cosign verify`, `cosign attest`, `cosign verify-attestation`,
`cosign sign-blob` and `cosign verify-blob` as subprocesses in the repository
root, with arguments as argv arrays, never through a shell, with stdin closed so
cosign can never prompt, and with `COSIGN_PASSWORD` and, for a PEM, `COSIGN_KEY`
in their environment. A public key given as a PEM, or derived, is written to a
temporary file for the length of one method and removed, as is a generated
signing config and a generated key pair's files. Registry credentials are
cosign's own: the container config of the user running swamp.

Three pre-flight checks come with the type: `arguments` (the key is a PEM, a
reference, a file or empty; the public key a PEM, a file or empty; the config
paths hold no newline), `cosign-installed` (`cosignBinary` runs) and
`key-usable` (the private key loads and `password` decrypts it, before `sign`,
`attest` and `signBlob`). They run before every method but `describe`, and by
hand with `swamp model validate <name>`.

## Errors

A cosign failure names the command, its arguments with the key's value replaced,
its exit code and what it printed, with the PEM masked wherever it would appear,
and nothing is recorded. A tag, an annotation without `=`, an empty key for
`sign`, an empty key and public key for `verify`, a predicate or a file that
cannot be read are refused before cosign runs. Record names carry the image's
repository before the digest, and a file's name with a hash of its path, so the
same digest in two repositories, or two files of one name, give two records.

## Development

```sh
deno test --allow-env --allow-read --allow-write
COSIGN_E2E=1 COSIGN_E2E_REF=127.0.0.1:5000/alpine@sha256:<digest> \
  deno test --allow-env --allow-read --allow-write --allow-run
```

The unit tests drive the model with a fake cosign. With `COSIGN_E2E=1` one test
runs the real one against the image `COSIGN_E2E_REF` names, in a registry that
needs no credentials: it generates a key pair through the model, signs,
verifies, verifies with another key and sees it fail, attests, verifies the
attestation, then signs a file, verifies it, and sees a tampered copy fail. A
throwaway registry does:

```sh
podman run -d --name registry -p 127.0.0.1:5000:5000 docker.io/library/registry:2
podman push --tls-verify=false docker.io/library/alpine:3.22 localhost:5000/alpine:3.22
```

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
