# @dataverket/cosign

Container images signed and verified with
[cosign](https://github.com/sigstore/cosign), as swamp data: signed with a key,
with or without a transparency log; verified against that key or keyless,
against the identity in a Sigstore certificate; attestations and signed files
included. One model type, `@dataverket/cosign/signer`, one signing identity; two
workflows that bring their own model; and a skill, `cosign`, that says which to
run for what.

| Method              | Runs                                  | Records                                                                                                                                                                       |
| ------------------- | ------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describe`          | `cosign version`, `cosign public-key` | `signer`: version, how the key was given, the public key in effect and its fingerprint, how it verifies (`verifyMode`), log and config choices                                |
| `generateKeyPair`   | `cosign generate-key-pair`            | `keypair`: both halves; the private one is a sensitive field, which swamp keeps in the vault, an encrypted PEM whose passphrase is `password`, empty or not                   |
| `sign`              | `cosign sign` per image               | One `signature-<repository>-<digest>` per image: reference, digest, annotations                                                                                               |
| `verify`            | `cosign verify` per image             | One `verification-<repository>-<digest>` per image: verified or not, the payloads found, cosign's reason                                                                      |
| `attest`            | `cosign attest` per image             | One `attestation-<repository>-<digest>` per image: type, predicate file and its sha256                                                                                        |
| `verifyAttestation` | `cosign verify-attestation` per image | One `attestationVerification-<repository>-<digest>` per image: verified or not, the predicate types, each attestation's subjects and SLSA provenance, and the source it names |
| `signBlob`          | `cosign sign-blob --bundle`           | `blobSignature-<file>`: the file's sha256 and the Sigstore bundle written beside it                                                                                           |
| `verifyBlob`        | `cosign verify-blob --bundle`         | `blobVerification-<file>`: verified or not, cosign's reason                                                                                                                   |

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

| Argument                    | Default  |                                                                                                                                                           |
| --------------------------- | -------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `key`                       |          | The private key: a PEM, a KMS or HSM reference, or a file. Empty for a signer that only verifies                                                          |
| `password`                  |          | The key's passphrase; empty for an unencrypted key                                                                                                        |
| `publicKey`                 |          | A PEM or a file, for `verify`; derived from `key` when empty                                                                                              |
| `certificateIdentity`       |          | Keyless: the exact identity the signing certificate must name; `verify`, `verifyAttestation` and `verifyBlob` then check the certificate instead of a key |
| `certificateIdentityRegexp` |          | Keyless: a regular expression the identity must match, instead of `certificateIdentity`                                                                   |
| `oidcIssuer`                |          | Keyless: the OIDC issuer that vouched for the identity, such as `https://token.actions.githubusercontent.com`; required with an identity                  |
| `tlog`                      | `false`  | Record signatures in a transparency log and require a log entry when verifying                                                                            |
| `signingConfig`             |          | A Sigstore signing config file, relative to the repository root, for `sign` and `attest`; replaces what `tlog` chooses                                    |
| `trustedRoot`               |          | A Sigstore trusted root file, relative to the repository root, for private infrastructure                                                                 |
| `insecureRegistry`          | `false`  | Allow a registry whose certificate does not verify                                                                                                        |
| `httpRegistry`              | `false`  | Allow a registry served over plain HTTP                                                                                                                   |
| `cosignBinary`              | `cosign` |                                                                                                                                                           |

Every reference is a digest, `<repository>@sha256:<64 hex>`. A tag is refused
before cosign runs: a tag can move, and what a signature vouches for is the
digest. `sign` and `verify` take `annotations` as `key=value`; a signature
carries them, and a verification requires them. `sign` also takes `recursive`
(sign every image of an index too) and `upload` (false signs and discards, a
rehearsal). `attest` takes `predicate`, a file, and `type`: `slsaprovenance1`,
`spdxjson`, `cyclonedx`, `vuln`, `openvex`, `custom` (the default) or a URI;
`verifyAttestation` takes `type`, and `sourceRepository` and `sourceCommit` when
the provenance must name a source (see "What an attestation says"). `signBlob`
and `verifyBlob` take `path`, a file, and `bundle`, the Sigstore bundle beside
it, `<path>.sigstore.json` when not given: a release manifest or a checksum file
signed the same way as the images, with the same key and the same log choice.

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

## Keyless verification

An image signed keyless, by a CI job with a short-lived certificate from
Sigstore's Fulcio, has no public key to check against: what vouches for it is
the identity in the certificate, the issuer that gave it, and the entry in
Rekor. A signer with `certificateIdentity` or `certificateIdentityRegexp` plus
`oidcIssuer` verifies that way: `verify`, `verifyAttestation` and `verifyBlob`
pass `--certificate-identity` or `--certificate-identity-regexp` and
`--certificate-oidc-issuer` instead of `--key`, and cosign checks the
certificate chain, the identity and the log entry against the public Sigstore
trusted root, or `trustedRoot` when given.

```sh
swamp model create @dataverket/cosign/signer upstream \
  --global-arg 'certificateIdentityRegexp=^https://github.com/chainguard-images/images/' \
  --global-arg oidcIssuer=https://token.actions.githubusercontent.com \
  --global-arg tlog=true
swamp model method run upstream verify \
  --input 'refs:json=["cgr.dev/chainguard/static@sha256:<digest>"]'
swamp model method run upstream verifyAttestation \
  --input 'refs:json=["cgr.dev/chainguard/static@sha256:<digest>"]' \
  --input type=https://spdx.dev/Document
```

The `arguments` check refuses, before cosign runs, an identity without
`oidcIssuer`, an issuer without an identity, both identity forms at once, a
`publicKey` beside an identity (a signer verifies one way), and `tlog: false`
with an identity: a keyless signature lives in the log, so the log cannot be
ignored. The signer record says which way a signer verifies in `verifyMode`:
`key`, `keyless` or `none`. `key` may stay set beside an identity, and such a
signer signs with its key and verifies keyless, but `tlog` is one choice for
both sides; a pipeline that verifies upstream images keyless and signs its own
without a log uses two signers. Signing is always with a key here: keyless
signing needs an OIDC token this model does not obtain.

## Verification is a record, not a failure

An image that does not verify is recorded as `verified: false` with cosign's
reason in `error`, such as
`no matching attestations: missing or incorrect
annotation` or
`... accepted signatures do not match threshold`, so a workflow can assert over
the records and name every image that failed. Only cosign failing for another
reason, a registry it cannot reach or a key it cannot load, fails the method.
Nothing is recorded for that image then. With several references the method
works through them in order and records each as it goes, as `sign` and `attest`
do: when cosign fails at a later one, the records of the earlier ones are
written and true, the method fails, and the rest have no record of this run, so
count the records of a run before trusting them all. An attestation cosign
verified that is about another digest, or names another source than the one
asked for, is recorded the same way: `verified: false`, with the reason in
`error` and per attestation in `statements[].reason`.

## What an attestation says

A verified attestation proves that someone signed a statement, not what the
statement is about. `verifyAttestation` reads each statement cosign verified and
records it, bounded, so a workflow can assert on where an image was built from
without reading a predicate itself.

An attestation counts only when one of its subjects is the digest that was
verified: `subject[].digest.sha256` must equal the digest of the reference,
exactly. An attestation about another artifact is recorded with `counted: false`
and does not make the image verified.

| Field of the record                                          |                                                                                                                               |
| ------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------- |
| `verified`                                                   | cosign verified at least one attestation, and at least one of them counts                                                     |
| `attestations`, `matched`                                    | How many cosign verified, and how many of those count                                                                         |
| `predicateTypes`                                             | The predicate type of every attestation cosign verified                                                                       |
| `sourceRepository`, `sourceRef`, `sourceCommit`, `builderId` | What the attestations that count say, each `null` when they do not say it or do not agree                                     |
| `expectedSourceRepository`, `expectedSourceCommit`           | What the call asked for, empty when it asked nothing                                                                          |
| `statements`                                                 | Up to 20 attestations, the ones that count first: `predicateType`, `subjects`, `counted`, `reason`, `provenance`, the summary |
| `error`                                                      | cosign's reason, or why none of the verified attestations counted                                                             |

For SLSA provenance v1 (`https://slsa.dev/provenance/v1`) a statement's
`provenance` holds `buildType`, `resolvedDependencies` (`uri` and `gitCommit` of
the first 20, with `resolvedDependencyCount`), `builderId` and `invocationId`,
which SLSA defines for every build type, and `workflow` (`repository`, `ref`,
`path` from `externalParameters.workflow`), which only a build type defines.

A source is derived only for a build type whose fields are known here, since
what another builder's parameters mean is for that builder to say, and its
caller may choose their values:

| Predicate | Build types understood                                                                                                                                                                                                                              | The source is                                          |
| --------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------------------------------------------ |
| SLSA v1   | `https://actions.github.io/buildtypes/workflow/v1`, GitHub's workflow build type, and `https://slsa-framework.github.io/github-actions-buildtypes/workflow/v1`, the community build type GitHub's attestations used before it, with the same fields | `externalParameters.workflow` and its dependency       |
| SLSA v0.2 | `https://github.com/slsa-framework/slsa-github-generator/container@v1`, `.../generic@v1` and `.../go@v1`, exactly so                                                                                                                                | `invocation.configSource`, when its `uri` is a git URI |

For those, `sourceRepository` and `sourceRef` are the workflow's, or the two
halves of the config source's `git+<repository>@<ref>`, and `sourceCommit` is
the `gitCommit` of the resolved dependency whose `uri` is exactly
`git+<repository>@<ref>`, or the config source's `sha1` or `gitCommit`, which
must be the same when it has both. A commit is a whole SHA-1 or SHA-256 in lower
case, 40 or 64 hex characters; anything shorter, longer or in upper case stays
in the statement's dependency as it was given and leaves the summary `null`. A
second dependency for the same `uri` that is not the same whole commit leaves it
`null` too. For v0.2 the `entryPoint` is the workflow's path, `materials` are
the dependencies, and the build invocation id is the invocation id. Of the v0.2
build types only `container@v1` has been run against a real image.

A predicate of any other build type, such as the one BuildKit writes, keeps its
`buildType`, dependencies, builder and invocation id; its `workflow` and its
source are `null`. Any other predicate type keeps its `predicateType` and
subjects, with `provenance` and the summary `null`.

What is kept is bounded, and the rest of a predicate is not stored: no
environment, no parameters beyond the workflow reference, no byproducts. Every
value kept is text of at most 1024 characters with no control character; one
that is longer, is not text or has a control character is not stored, and is not
altered to fit.

The fields that are URLs are parsed, and stored only when they parse: the
workflow's repository, a dependency's `uri`, the builder id and the build type
must each be an `http`, `https`, `git` or `ssh` URL, with or without `git+`
before it, written with `://` and a host, and with no user, no password, no
query and no fragment; or a `pkg:`, `mailto:` or `urn:` URI, which has no host,
with no query and no fragment. Nothing else is stored in those fields: not a
value with no scheme, with one slash, with a space or a backslash, or of another
scheme, and not the scp form `git@<host>:<path>`, whose user cannot be told from
a credential. An invocation id is stored when it is such a URL or one plain
token of letters, digits, `.`, `_` and `-`.

The fields that are not URLs get no such rule: a subject's `name`, the
workflow's `ref` and `path` are stored as the attestation gives them, within the
bound above. A subject name is whatever the signer wrote, an image repository, a
file name, a package URL with its query.

`withheld` counts what was not stored, per statement. A summary field that could
not be stored is `null`, so it can never equal an expectation. Lists are cut and
their length kept: `statements` at 20 with `attestations` as the count,
`subjects` at 20 with `subjectCount`, `resolvedDependencies` at 20 with
`resolvedDependencyCount`, `predicateTypes` at 100 with `attestations`. `error`,
here and in every other verification record, is cosign's reason as one line of
at most 1024 characters with control characters replaced by spaces: cosign
quotes what it found on the image, such as the predicate types, and whoever can
write to the registry chooses those.

With `sourceRepository` or `sourceCommit` the method makes the check itself: an
attestation then counts only when its derived value equals the argument exactly,
a repository as the provenance writes it and a commit as the full hash, and both
when both are given, in one attestation.

An empty `sourceRepository` or `sourceCommit` asks nothing. A workflow that
passes an input through must therefore not rely on `verified` alone: an input
that turned out empty switches the check off. Assert on what was asked as well,
`expectedSourceRepository` and `expectedSourceCommit`, which the record carries
for that:

```yaml
expr: >-
  data.latest("upstream", "<record name>").attributes.verified == true
  && data.latest("upstream", "<record name>").attributes.expectedSourceCommit == inputs.sourceCommit
  && inputs.sourceCommit != ""
```

The `verification` and `attestationVerification` records also say what they were
checked against: `verifyMode` (`key` or `keyless`), `certificateIdentity`,
`certificateIdentityRegexp` and `oidcIssuer` for a keyless check, and
`publicKeyFingerprint` for a key, the same fingerprint `describe` records, never
the key or a path to it. A workflow that sets a signer's arguments per run, and
shares the signer with other runs, asserts on these to know its own arguments
were the ones in force.

```sh
swamp model method run upstream verifyAttestation \
  --input 'refs:json=["ghcr.io/<owner>/<image>@sha256:<digest>"]' \
  --input type=slsaprovenance1 \
  --input sourceRepository=https://github.com/<owner>/<repository> \
  --input sourceCommit=<40 hex>
```

An image built from another commit is then a record with `verified: false` and
`error` such as
`1 attestation verified by cosign, none counted: sourceCommit is "<found>", not "<expected>"`.

### Changed since 2026.10.28.1

- The `attestationVerification` record has new fields: `matched`, `statements`,
  `sourceRepository`, `sourceRef`, `sourceCommit`, `builderId`,
  `expectedSourceRepository` and `expectedSourceCommit`. The fields it had, and
  its name, are unchanged. A record written by 2026.10.28.1 does not have the
  new fields; run `verifyAttestation` again before asserting on them.
- `verified` is stricter: an attestation whose subjects do not name the digest
  that was verified no longer counts. cosign compares the subject with the image
  too, so an image that verified before is expected to verify still; this check
  does not rely on that. `attestations` still counts what cosign verified;
  `matched` counts what also passed here.
- `verifyAttestation` takes two new arguments, `sourceRepository` and
  `sourceCommit`, both empty by default. A call that does not pass them asks
  nothing new.
- An image that has attestations, but none of the `type` asked for, is a record
  with `verified: false` and cosign's reason,
  `none of the attestations matched the predicate type: ...`. In 2026.10.28.1
  the method failed there and recorded nothing.
- A predicate type that is not text is recorded as `""` in `predicateTypes`, and
  one longer than 1024 characters is cut there. `predicateTypes` holds the first
  100; `attestations` is the whole number. The field is still a list of text.
- A verification that passed before can now fail, by intent: a payload that is
  JSON but not a statement object, such as `[]`, `7` or a text, was counted as
  an attestation in 2026.10.28.1 and gave `verified: true` with
  `predicateTypes: [""]`. It now names no subject, so the record is
  `verified: false`. A payload of `null` made the method fail before, with a
  type error; it is now such a record too.
- The `verification` and `attestationVerification` records have five new fields:
  `verifyMode`, `certificateIdentity`, `certificateIdentityRegexp`, `oidcIssuer`
  and `publicKeyFingerprint`.
- `error` in the `verification`, `attestationVerification` and
  `blobVerification` records is one line of at most 1024 characters, with
  control characters replaced by spaces and a longer reason cut with `…`.
- A reference whose repository does not start with a letter or a digit is
  refused before cosign runs, so one that starts with a dash is never read as a
  flag; every reference and file is passed to cosign after `--`.
- No global argument changed. A definition of 2026.10.28.1 runs unchanged and is
  stamped with the new version.

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
signing config and a generated key pair's files; a keyless verification writes
no key file and passes the identity and issuer as arguments. Registry
credentials are cosign's own: the container config of the user running swamp.

Three pre-flight checks come with the type: `arguments` (the key is a PEM, a
reference, a file or empty; the public key a PEM, a file or empty; a certificate
identity comes with an issuer and `tlog: true` and without a public key; the
config paths hold no newline), `cosign-installed` (`cosignBinary` runs) and
`key-usable` (the private key loads and `password` decrypts it, before `sign`,
`attest` and `signBlob`). They run before every method but `describe`, and by
hand with `swamp model validate <name>`.

## Errors

A cosign failure names the command, its arguments with the key's value replaced,
its exit code and what it printed, with the PEM masked wherever it would appear,
and nothing is recorded. A tag, an annotation without `=`, an empty key for
`sign`, an empty key and public key for `verify`, an identity without an issuer
or with `tlog: false` or beside a public key, a predicate or a file that cannot
be read, a `sourceRepository` or `sourceCommit` with a space or a newline in it
are refused before cosign runs, as is a reference that does not start with a
letter or a digit. Record names carry the image's repository before the digest,
and a file's name with a hash of its path, so the same digest in two
repositories, or two files of one name, give two records.

## Known limits

- The method sets no time limit of its own. cosign's own `--timeout`, three
  minutes by default, bounds each call to the registry and the log, so a service
  that never answers holds a method for about that long per reference. A later
  version is to run cosign with a limit per call.
- A record name carries the first 12 hex characters of the digest. Two digests
  of one repository that share those 12 characters would share a record name,
  the later replacing the earlier; the record's own `digest` field is always the
  whole digest, so assert on that. The repository part of the name has every run
  of other characters replaced by `-`, so `a/b` and `a-b` give the same name;
  the record's `repository` field tells them apart.
- Two runs that verify the same image with the same signer write the same record
  name. A workflow that reads its own run's record by run id finds none when
  another run wrote later; such runs must not overlap.

## Development

```sh
deno test --allow-env --allow-read --allow-write
COSIGN_E2E=1 COSIGN_E2E_REF=127.0.0.1:5000/alpine@sha256:<digest> \
  deno test --allow-env --allow-read --allow-write --allow-run
COSIGN_KEYLESS_E2E=1 \
  COSIGN_KEYLESS_E2E_REF=cgr.dev/chainguard/static@sha256:<digest> \
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

With `COSIGN_KEYLESS_E2E=1` another test verifies, through the public Sigstore
instance, an image Chainguard's release workflow signed keyless, verifies its
SPDX attestation, and sees another identity fail; it needs the network, for the
registry, Rekor and the Sigstore TUF root, and ran from this machine against
cosign 3.1.4 on 2026-10-29. `crane digest cgr.dev/chainguard/static:latest`
gives a current digest; `COSIGN_KEYLESS_E2E_IDENTITY_REGEXP` and
`COSIGN_KEYLESS_E2E_ISSUER` point it at another image's workflow.

`smoke/` holds the live suite that runs through swamp, from a scratch repository
that loads this extension from source: `verifyAttestation` against two public
images, one with SLSA v1 provenance and one with v0.2, with the right and a
wrong source. `smoke/README.md` says how to run it and what it ran on.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
