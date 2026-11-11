# @dataverket/cosign

Container images signed and verified with
[cosign](https://github.com/sigstore/cosign), as swamp data: signed with a key,
with or without a transparency log; verified against that key or keyless,
against the identity in a Sigstore certificate, which `identify` reads from an
image when you do not know it yet; attestations and signed files included. One
model type, `@dataverket/cosign/signer`, one signing identity; two workflows
that bring their own model; and a skill, `cosign`, that says which to run for
what.

| Method              | Runs                                                                                                           | Records                                                                                                                                                                       |
| ------------------- | -------------------------------------------------------------------------------------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `describe`          | `cosign version`, `cosign public-key`                                                                          | `signer`: version, how the key was given, the public key in effect and its fingerprint, how it verifies (`verifyMode`), log and config choices                                |
| `generateKeyPair`   | `cosign generate-key-pair`                                                                                     | `keypair`: both halves; the private one is a sensitive field, which swamp keeps in the vault, an encrypted PEM whose passphrase is `password`, empty or not                   |
| `sign`              | `cosign sign` per image                                                                                        | One `signature-<repository>-<digest>` per image: reference, digest, annotations                                                                                               |
| `verify`            | `cosign verify` per image                                                                                      | One `verification-<repository>-<digest>` per image: verified or not, the payloads found, cosign's reason                                                                      |
| `identify`          | `cosign download signature` and `cosign tree` per image, then a check of each signature that has a certificate | One `identification-<repository>-<digest>` per image: who signed it, as the certificates say, with no identity expected. Not a verification                                   |
| `attest`            | `cosign attest` per image                                                                                      | One `attestation-<repository>-<digest>` per image: type, predicate file and its sha256                                                                                        |
| `verifyAttestation` | `cosign verify-attestation` per image                                                                          | One `attestationVerification-<repository>-<digest>` per image: verified or not, the predicate types, each attestation's subjects and SLSA provenance, and the source it names |
| `signBlob`          | `cosign sign-blob --bundle`                                                                                    | `blobSignature-<file>`: the file's sha256 and the Sigstore bundle written beside it                                                                                           |
| `verifyBlob`        | `cosign verify-blob --bundle`                                                                                  | `blobVerification-<file>`: verified or not, cosign's reason                                                                                                                   |

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
| `tlog`                      | `false`  | Record signatures in a transparency log and require a log entry when verifying; `identify` requires the entry either way                                  |
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
trusted root, or `trustedRoot` when given. When you do not know the identity and
the issuer of an image yet, `identify` reads them from it; see "Who signed this
image".

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

## Who signed this image

Keyless verification needs two facts you may not have: the identity in the
signing certificate and the OIDC issuer that vouched for it. `identify` reads
them from the image. It needs no key and no identity, so a definition with no
argument at all can ask:

```sh
swamp model create @dataverket/cosign/signer who
swamp model method run who identify \
  --input 'refs:json=["ghcr.io/<owner>/<image>@sha256:<digest>"]'
swamp data query 'modelName == "who" && specName == "identification"' \
  --select '{"state": attributes.state, "certificateIdentity": attributes.certificateIdentity, "oidcIssuer": attributes.oidcIssuer}'
```

When the record's `state` is `identified`, its `certificateIdentity` and
`oidcIssuer` are the two arguments a keyless signer takes. Look at them, decide
whether that is who should sign this image, and only then verify against them:

```sh
swamp model create @dataverket/cosign/signer upstream \
  --global-arg 'certificateIdentity=<certificateIdentity from the record>' \
  --global-arg 'oidcIssuer=<oidcIssuer from the record>' \
  --global-arg tlog=true
swamp model method run upstream verify \
  --input 'refs:json=["ghcr.io/<owner>/<image>@sha256:<digest>"]'
```

### What an identification proves, and what it does not

`identify` first downloads the signatures, which proves nothing, and then has
cosign check each one that carries a certificate, with patterns for the identity
and the issuer that match anything. A certificate counts as genuine
(`certificateGenuine: true`) only when cosign accepts all of this: the signature
is over this digest, the certificate chains to the Sigstore trusted root (or to
`trustedRoot`), and the signature has an entry in the transparency log made
while the certificate was valid. Only then are the identity, the issuer and the
claims of that certificate recorded.

So an `identified` record establishes this much: a valid signature over this
digest exists, and the certificate behind it was issued to this identity by this
issuer.

It does not establish that this identity is the one that should sign the image.
Anyone can get a certificate for their own identity and sign any image they can
write a signature for. `identify` expects no identity and refuses none, so its
record is never a pass, and it has no `verified` field. `identityChecked` is
always `false` to say so in the record itself. The judgement is yours; `verify`
is the check, and a gate asserts on a `verification` record, never on an
`identification`.

Nor does it establish that the record lists every signer, or the one you are
looking for. A record lists whoever signed, wanted or not: anyone who can write
to the registry can add signatures of their own. In the tag form only the first
five identities cosign prints are confirmed, so five signatures put first by
someone else leave a real signer listed with no identity; the `reason` then says
that there are more identities than were confirmed. The answer to "did the one I
expect sign this" is `verify` with that identity, which does not depend on what
else is stored.

| Field of the record                                              |                                                                                                                                                                                                                            |
| ---------------------------------------------------------------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `state`                                                          | `identified`, `several-identities`, `key-signed`, `unproven`, `unsigned` or `not-found`, see below                                                                                                                         |
| `certificateIdentity`, `oidcIssuer`                              | The one identity and issuer of the genuine certificates, when there is exactly one; empty in every other state                                                                                                             |
| `identities`                                                     | Every distinct identity and issuer among the genuine certificates, with the number of signatures of each                                                                                                                   |
| `identityChecked`                                                | Always `false`: no identity was expected                                                                                                                                                                                   |
| `signaturesFound`, `certificatesGenuine`, `keySigned`            | How many signatures cosign found, how many have a genuine certificate, how many were made with a key                                                                                                                       |
| `otherStatements`                                                | Attestations stored the same way as the signatures; `identify` does not read them                                                                                                                                          |
| `tagSignaturesUnlisted`                                          | `true` when the image has signatures under a `.sig` tag beside bundles. Those cosign verified with a certificate are in the record; any other cannot be listed there, and they are counted as one                          |
| `forms`                                                          | How the signatures read are stored: `bundle`, `tag`                                                                                                                                                                        |
| `signatures`                                                     | Up to 20 signatures, the ones that name an identity first, each with the fields below                                                                                                                                      |
| `signatures[].certificateGenuine`                                | cosign accepted the signature, the certificate's chain and its log entry                                                                                                                                                   |
| `signatures[].certificateIdentity`, `.oidcIssuer`, `.claims`     | What a genuine certificate says; empty for any other. In the tag form only what cosign prints: the identity, the issuer and the five `githubWorkflow` claims                                                               |
| `signatures[].unprovenIdentity`, `.unprovenIssuer`               | What a certificate in a bundle that is not genuine says about itself. Anyone who can write to the registry can put any text here; it is kept apart so it is never copied. Empty in the tag form                            |
| `signatures[].signedWith`, `.form`, `.subjectMatches`, `.reason` | `certificate`, `key` or `unknown`; `bundle` or `tag`; whether the signature is about this digest; why it names no identity                                                                                                 |
| `signatures[].unprovenKeyFingerprint`                            | For a key's signature kept as a bundle: the fingerprint the bundle itself gives for its key, written as `describe` writes one. The signature is not checked, so anyone who can write to the registry can name any key here |
| `reason`                                                         | Why there is not exactly one identity, as one line                                                                                                                                                                         |

| `state`              | Means                                                                                                                                                                                                                                                                             |
| -------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `identified`         | Every genuine certificate names the same identity and issuer. Other signatures on the image, a key's or ones that did not check out, are in `reason`                                                                                                                              |
| `several-identities` | Genuine certificates name more than one identity or issuer. `identities` lists them, and the top-level fields stay empty: none is chosen for you                                                                                                                                  |
| `key-signed`         | Only signatures made with a key are stored with the image. There is no certificate, so no identity to read. Nothing of such a signature is checked, so this state proves nothing: not that the signature is valid, and not which key made it. Verify with the signer's public key |
| `unproven`           | Signatures were found and none names an identity that could be established: not genuine, about another digest, a certificate that cannot be read, or an identity that cannot be stored                                                                                            |
| `unsigned`           | The registry answered every lookup and holds no signature for the image                                                                                                                                                                                                           |
| `not-found`          | The registry says it has no such image                                                                                                                                                                                                                                            |

None of these fails the method. It fails only when a call could not be made or
its answer could not be read: cosign is not installed, the registry does not
answer, limits the rate or refuses the login, the transparency log cannot be
reached, the trusted root cannot be loaded, or cosign printed something that is
not a list of signatures. Nothing is recorded for that image then. A failure of
cosign counts as a verdict on a signature only when its message starts with one
of the few verdicts known here and holds no word of a network or registry fault;
anything else fails the method, so a new wording in a later cosign fails loudly
instead of being recorded.

`unsigned` means the registry answered every lookup and there was nothing. It is
reached only through a positive answer, never through the absence of an error.
That holds for signatures stored the way cosign stores them; "Known limits" has
the one case where it does not. `cosign download signature` alone does not give
one: cosign 3.1.4 prints `no signatures associated` also when the list of
bundles was refused, rate limited or failed, and when the manifest or the
content of one bundle could not be fetched; it then reads the tag form in their
place when there is one. So `identify` always runs `cosign tree` as well, and
holds the two against each other:

- `cosign tree` must exit 0 and print nothing as an error. For a bundle whose
  own manifest cannot be fetched it exits 0 and prints
  `Error fetching artifact ...`; that fails the method.
- Every line it prints must be one `identify` knows, and it must either say
  there is nothing or list something. A line that is not understood fails the
  method, so a new way for cosign to carry on after a fault is not read as
  "nothing there".
- Every bundle it lists, of a signature or of an attestation, must have come
  back from the download, and signatures it lists under a tag must have been
  found. `cosign tree` names a bundle by a label on its manifest, a predicate
  type written as a URI, or by the bundle's media type. That label is set by
  whoever wrote the bundle and is not always right: some published images carry
  an attestation labelled as a signature. So the label only says that a bundle
  should come back. Whether a bundle is a signature is read from the bundle's
  own statement, never from the label.

When any of this does not hold, nothing is recorded. That includes a registry
that lists a bundle and answers "not found" for it: a list that names what the
registry does not hold is an inconsistency of the registry, not an unsigned
image. An artifact of another kind stored beside the image, named by any other
type, registered or not, such as a signature of another tool or a document, is
not expected to come back and is left alone. cosign itself does not go by the
name: it tries to read everything stored beside the image and keeps what reads
as a bundle, so a signature stored under another name is still found and
recorded when nothing fails. A "not found" for a lookup by name, the `.sig` tag
or the list of bundles, cannot be told from there being none, and means none.

The claims are the extensions Fulcio writes into a certificate, each under a
name: `githubWorkflowTrigger`, `githubWorkflowSha`, `githubWorkflowName`,
`githubWorkflowRepository`, `githubWorkflowRef`, `buildSignerUri`,
`buildSignerDigest`, `runnerEnvironment`, `sourceRepositoryUri`,
`sourceRepositoryDigest`, `sourceRepositoryRef`, `sourceRepositoryIdentifier`,
`sourceRepositoryOwnerUri`, `sourceRepositoryOwnerIdentifier`, `buildConfigUri`,
`buildConfigDigest`, `buildTrigger`, `runInvocationUri` and
`sourceRepositoryVisibilityAtSigning`. A certificate holds the ones its issuer
knows: GitHub and GitLab fill most, an email login none. An extension this
version has no name for is kept under its object identifier, such as
`1.3.6.1.4.1.57264.1.24`. Up to 40 claims are kept. One rule decides what is
stored of an identity, an issuer and a claim, before anything reaches a record
or a log line: text of at most 1024 characters, with no character that changes
how a line reads without showing, and, when it is written as a URL, with no user
and no password. Those characters are the control characters of every block, the
format characters such as the bidirectional and zero-width ones, the line and
paragraph separators, and code points that are private or unassigned. This
withholds an identity that holds, for example, a zero-width joiner or non-joiner
(which some scripts and some emoji use), a soft hyphen, a byte order mark or a
right-to-left mark; letters of any script, accents, digits, punctuation, a space
and a no-break space are kept. A value that breaks the rule is not altered to
fit: it is not stored, and is counted in `withheld`, since an identity that was
changed could not be given to `verify`. An identity or issuer that is not stored
names no one, and the state is then `unproven`. In a `reason`, which is cosign's
own words and is copied nowhere, such characters become spaces. The identity is
the certificate's first subject alternative name: a URI, an email address, a DNS
name, an IPv4 address or Fulcio's user name.

Both ways cosign stores a signature are read, and they are not equally rich.

A Sigstore bundle, which cosign 3 writes, is checked alone with
`cosign verify-blob-attestation`. cosign is handed a bundle built from exactly
the fields `identify` read, so the certificate recorded is the certificate
checked, and every claim in it is recorded.

A signature under a `sha256-<hex>.sig` tag, which older versions wrote, cannot
be checked alone: `cosign verify` checks all of them at once and does not say
which certificate a verdict belongs to. So for the tag form nothing is read from
a downloaded certificate, and `identify` works in two steps.

First `cosign verify` runs with patterns that match anyone, and prints the
identity, the issuer and five `githubWorkflow` claims for each signature it
verified. That print is not proof of those values: cosign 3.1.4 starts from what
the signer wrote in the signed payload and overwrites a field only when the
certificate has it, so for a certificate with no such extension the signer's own
`githubWorkflowRepository` is printed, and with a trusted root whose
certificates name no issuer, the signer's own `Issuer`.

Then `identify` gives what was printed back to `cosign verify` as exact
requirements, `--certificate-identity`, `--certificate-oidc-issuer` and the
`--certificate-github-workflow-*` options, which cosign holds against the
certificate itself and refuses when the certificate lacks the extension. What
that call accepts is recorded. When it refuses, the identity and the issuer are
tried alone and recorded without claims; when that is refused too, the signature
is recorded with `certificateGenuine: true` and no identity, and the state is
`unproven` unless another signature names one. The claims a certificate has
beyond those five, such as `sourceRepositoryUri`, are not recorded in the tag
form. The first five distinct identities are confirmed; a signature with a
certificate that cosign did not verify is counted and recorded with no identity.

Once an image has a bundle, of a signature or of an attestation, cosign 3 reads
bundles only: `cosign download signature` returns no tag-form signature and
`cosign verify` does not look at the tag. An image signed under a tag by an
older cosign and attested later would look unsigned. So beside bundles
`identify` always asks for the tag form too, with
`cosign verify --new-bundle-format=false`. Signatures there that cosign verifies
with a certificate are identified as above. Any other, such as a key's, cannot
be listed: they are recorded as one signature of an unknown kind,
`tagSignaturesUnlisted` is `true`, and the state is not `unsigned`. `verify`
itself still reads only the bundles of such an image.

One `identify` run makes at most 33 cosign calls per image: the download, the
`cosign tree`, one check per bundle for the first 20, one `cosign verify` of the
tag form, and at most two confirming calls for each of the first five identities
it printed. The checks of bundles work from the bundle and the cached trusted
root; the other calls reach the registry, and for the tag form the log. The
method sets no time limit of its own (see "Known limits"): each call is bounded
by cosign's own timeout of three minutes, so an image whose every call hangs can
hold a run for more than an hour and a half, where a normal one takes a few
seconds.

`identify` honours `trustedRoot`, `insecureRegistry`, `httpRegistry` and
`cosignBinary` as `verify` does. It differs on `tlog`: the log entry is always
required, also when `tlog` is `false`. A certificate is valid for minutes, and
only the entry shows it was used in time; cosign 3.1.4 refuses every certificate
when told to ignore the log. The key and its passphrase are not used and reach
no cosign call of this method.

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
`cosign sign-blob`, `cosign verify-blob`, `cosign download signature`,
`cosign tree` and `cosign verify-blob-attestation` as subprocesses in the
repository root, with arguments as argv arrays, never through a shell, with
stdin closed so cosign can never prompt, and with `COSIGN_PASSWORD` and, for a
PEM, `COSIGN_KEY` in their environment. A public key given as a PEM, or derived,
is written to a temporary file for the length of one method and removed, as is a
generated signing config and a generated key pair's files; a keyless
verification writes no key file and passes the identity and issuer as arguments.
`identify` writes each bundle it checks to a temporary file, removed with the
rest, and runs cosign without `COSIGN_PASSWORD` and `COSIGN_KEY`. Registry
credentials are cosign's own: the container config of the user running swamp.

Three pre-flight checks come with the type: `arguments` (the key is a PEM, a
reference, a file or empty; the public key a PEM, a file or empty; a certificate
identity comes with an issuer and `tlog: true` and without a public key; the
config paths hold no newline), `cosign-installed` (`cosignBinary` runs) and
`key-usable` (the private key loads and `password` decrypts it, before `sign`,
`attest` and `signBlob`). swamp runs them before every method that is not a
read, so not before `describe` and `identify`, and by hand with
`swamp model validate <name>`. `identify` therefore says by itself when cosign
is not installed.

`swamp model validate <name>` runs every check, also `key-usable`, whatever
method it belongs to. For a signer with no `key`, which only verifies,
`key-usable` passes there, and the result is `PASSED` when the other checks
pass: an empty key is a correct definition, not a broken one. Nothing is lost
for signing. `swamp model validate <name> --method sign` (or `attest`, or
`signBlob`) fails `key-usable` with `key is empty: nothing to sign with`, the
same check stops a run of those methods before anything is signed, and each of
the three methods also refuses an empty key itself, so skipping the checks does
not get past it.

### Changed since 2026.11.10.1

- A new method, `identify`, and a new record, `identification`. No existing
  record changed.
- `swamp model validate` on a signer with an empty `key` now passes the
  `key-usable` check; it failed before with
  `key is empty: nothing to sign with`. Before `sign`, `attest` and `signBlob`
  the check fails as it did.
- The error of `sign`, `attest` and `signBlob` for an empty key, seen only when
  the checks are skipped, now reads
  `key is empty: nothing to sign with; this signer can only verify`.
- No global argument changed. A definition of 2026.11.10.1 runs unchanged and is
  stamped with the new version.

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
- `identify` checks the first 20 signatures that carry a certificate, and its
  record keeps 20; `signaturesFound` is the whole number. It reads signatures,
  not attestations: an attestation may be signed by another identity than the
  image, and `otherStatements` only counts them.
- `identify` needs the transparency log entry of a certificate. A private
  Sigstore that proves the time of signing with a timestamp authority alone is
  not supported; its signatures are recorded as `unproven` with cosign's reason.
- In the tag form `identify` records fewer claims than for a bundle, at most the
  five cosign can be asked to confirm, and gives no `unprovenIdentity`: cosign
  does not tie a verdict to one certificate there.
- Tag-form signatures beside bundles are read with
  `cosign verify --new-bundle-format=false`, an option cosign 3.1.4 accepts and
  no longer documents. A cosign that drops it fails `identify` for such images
  with cosign's own error; nothing is recorded wrongly.
- `identify` reads `cosign tree`'s printed list line by line. A later cosign
  that words a line differently fails the method until this is updated.
- The check that every bundle came back goes by how `cosign tree` names a
  bundle. A bundle it does not list (its entry in the registry's list has no
  artifact type), or lists under a name that is neither a URI nor the bundle's
  media type, is not expected. Such a bundle is read and recorded as usual when
  nothing fails; but when the registry fails on that one bundle, the fault is
  not noticed, and an image whose only signature it is can be recorded as
  `unsigned`. cosign 3.1.4 does not store a signature this way, and none of the
  images in `smoke/survey.sh` has one; a signer's tool that does would be
  affected.
- The other way round, an artifact of another tool that is named by a URI is
  expected as a bundle and does not come back, so `identify` fails for that
  image and records nothing.
- A `key-signed` record proves nothing about the key: `identify` has no key to
  check a signature with, and `unprovenKeyFingerprint` is the bundle's own word.
- Two runs that verify the same image with the same signer write the same record
  name. The same holds for `identify` and its `identification` record. A
  workflow that reads its own run's record by run id finds none when another run
  wrote later; such runs must not overlap.

## Development

```sh
deno test --allow-env --allow-read --allow-write
COSIGN_E2E=1 COSIGN_E2E_REF=127.0.0.1:5000/alpine@sha256:<digest> \
  deno test --allow-env --allow-read --allow-write --allow-run
COSIGN_KEYLESS_E2E=1 \
  COSIGN_KEYLESS_E2E_REF=cgr.dev/chainguard/static@sha256:<digest> \
  deno test --allow-env --allow-read --allow-write --allow-run
```

The unit tests drive the model with a fake cosign. Every temporary file of a
test, and of the model under test, is made in one directory that the run removes
when it ends, also after a failed test. With `COSIGN_E2E=1` one test runs the
real one against the image `COSIGN_E2E_REF` names, in a registry that needs no
credentials: it generates a key pair through the model, signs, verifies,
verifies with another key and sees it fail, attests, verifies the attestation,
then signs a file, verifies it, and sees a tampered copy fail. A throwaway
registry does:

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
wrong source; and `identify` against public images in both storage forms, an
unsigned one, a missing one and, in a throwaway registry, images signed with a
key, with what `swamp model validate` says for a signer with no key; and
`identify` against a registry that lies or fails: forged certificates in the tag
form, signatures under a tag beside bundles, and a rate limit, a refused login,
a server error and a missing object injected by a small proxy on every request
cosign makes, on a registry with a referrers API and on one without. `survey.sh`
runs `identify` over about thirty public images by digest and checks the state
of each, so that a change in cosign or in a registry shows. `smoke/README.md`
says how to run it and what it ran on.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
