---
name: cosign
description: >
  Sign and verify container images with cosign through the @dataverket/cosign
  extension: key-based signatures by digest, with or without a transparency
  log, attestations with a predicate file, files signed with a Sigstore
  bundle, and a key pair kept in a swamp vault. Use when asked to "sign
  images", "cosign sign", "verify a signature before deploy", "attach an SBOM
  or provenance attestation", "sign a release file", "sign-blob", "generate a
  cosign key", or to gate a rollout on signed images.
---

# cosign

`@dataverket/cosign` wraps cosign as one model type,
`@dataverket/cosign/signer`, and two workflows. Prefer the workflows; each
creates its own model on first use and ends with an assertion.

## Pick the workflow

| Intent                                                  | Run                                                                                                                                                           |
| ------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Sign images by digest with a key from the vault, verify | `swamp workflow run @dataverket/cosign-sign --input 'refs:json=["<repo>@sha256:<digest>"]' --input keyVault=<v> --input keyKey=<k> --input passphraseKey=<p>` |
| Gate on signatures, read-only, before a deploy          | `swamp workflow run @dataverket/cosign-verify --input 'refs:json=["<repo>@sha256:<digest>"]' --input publicKey=cosign.pub`                                    |

For a build that is signed as part of the build, use
`@dataverket/ko-signed-images` from `@dataverket/signed-images`: ko builds,
cosign signs exactly what was built, then verifies.

References are digests, `<repository>@sha256:<64 hex>`; a tag is refused. A
file, such as a release manifest, is signed with `signBlob` (a Sigstore bundle
lands beside it) and checked with `verifyBlob`, same key, same log choice.
Annotations (`-a` in cosign) go in `annotations: ["commit=<sha>"]` and are
required again at verify.

## The key

Put the private key in a vault once, and name it by vault and key in every run.
Inputs are recorded in cleartext in the run history, so a PEM is never an input:

```sh
COSIGN_PASSWORD=... cosign generate-key-pair      # cosign.key, cosign.pub
swamp vault put signing cosign-key < cosign.key
swamp vault put signing cosign-password            # the passphrase, prompted
rm cosign.key
```

The passphrase always comes from a vault, because swamp resolves every
`vault.get` at run start: a key without a passphrase gets an empty one stored
beside it, `swamp vault put signing cosign-password ""`, and is named all the
same. `passphraseVault` defaults to the key's vault.

The model reads the PEM from the vault and hands it to cosign through its
environment (`--key env://COSIGN_KEY`): no file, no argument, nothing in a
record or a log. A KMS or HSM reference (`awskms://`, `gcpkms://`,
`azurekms://`, `hashivault://`, `pkcs11:`) or a key file path works in the same
`key` argument. `generateKeyPair` makes a pair through the model and records the
private half as a sensitive field, which swamp stores in the vault.

## Transparency log

cosign 3 records every signature in Rekor unless told not to. `tlog: false`, the
default here, signs through a signing config with no log service, so signatures
live in the registry only, and verifies with the log ignored. For a public
image, `tlog: true`. For a private Rekor or TSA, give `signingConfig` and
`trustedRoot` files.

## What gets recorded

| Record                                            | Holds                                                                               |
| ------------------------------------------------- | ----------------------------------------------------------------------------------- |
| `signer`                                          | cosign version, how the key was given, the public key in effect and its fingerprint |
| `signature-<repository>-<digest>`                 | One image signed: ref, repository, digest, annotations                              |
| `verification-<repository>-<digest>`              | `verified`, the signatures' payloads, cosign's `error` when none counted            |
| `attestation-<repository>-<digest>`               | One attestation: type, predicate path and its sha256                                |
| `attestationVerification-<repository>-<digest>`   | `verified`, the predicate types found                                               |
| `blobSignature-<file>`, `blobVerification-<file>` | A file's sha256, its bundle, and whether it verifies                                |
| `keypair`                                         | A generated pair; `privateKey` is sensitive                                         |

An image that does not verify is a record with `verified: false`, not a failed
method; the workflows assert on it. Read the latest verdicts with:

```sh
swamp data query 'modelName == "cosign-verify" && specName == "verification"' --json
```

## Do not

- Sign a tag, or pass a key or passphrase as an input.
- Expect `.sig` tags: cosign 3 stores signatures as OCI referrers, so the
  registry must support the referrers API or its tag fallback (most do).
- Run `cosign-sign` for several key pairs at once; the workflow's model is
  shared, so one at a time.
