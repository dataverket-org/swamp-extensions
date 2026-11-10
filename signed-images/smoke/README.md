# Smoke suite

The workflows here have no code of their own to unit-test: what can be wrong is
an expression, a step that reads another run's record, an assertion that passes
when it should not, or a step that runs when it should have been skipped. This
suite runs `@dataverket/verified-upstream-image` through swamp and checks, for
every run, which steps succeeded, which one failed and with what message, and
which never ran. It is read-only: it reads two public images on ghcr.io and the
public Sigstore instance, needs no credential and no vault, and writes nothing
but records, and one workflow of its own, in a scratch repository.

## Run it

```sh
# 1. a scratch swamp repository loading this extension and the four it
#    composes from source
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none &&
  for e in signed-images cosign crane ko flux; do
    swamp extension source add "$OLDPWD/../../$e"
  done &&
  swamp workflow validate @dataverket/verified-upstream-image)

# 2. the suite, three batches of about a minute each, one after the other:
#    they verify the same image, and runs for one reference must not overlap
./verified-upstream-image.sh
./verified-upstream-image-refusals.sh
./verified-upstream-image-nested.sh

# 3. the older cosign extension, in a second scratch repository that has
#    @dataverket/cosign 2026.10.28.1 in place of the source: from the registry
#    with "swamp extension pull @dataverket/cosign@2026.10.28.1", or from this
#    repository's history, as it was run here
OLD=$(mktemp -d) && git -C ../.. archive <commit of 2026.10.28.1> cosign | tar -x -C "$OLD"
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none &&
  swamp extension source add "$OLD/cosign" &&
  for e in signed-images crane ko flux; do
    swamp extension source add "$OLDPWD/../../$e"
  done)
./verified-upstream-image-old-cosign.sh
```

`SHOW=1` prints the message of every run that failed as it should.

## What each batch is for

| Batch                                     | What it refuses to let pass                                                                                                                                                                                                                                                                                                                                            |
| ----------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `verified-upstream-image.sh` A            | Nothing: the right identity with provenance, with the right repository and commit, with `attestationType` empty (the two attestation steps skipped), by digest with the identity as an expression, by tag and digest as a pin is written                                                                                                                               |
| `verified-upstream-image.sh` B            | Another commit, another repository, an attestation type the image does not have, an image signed by another identity (its attestations never asked for), a tag with a digest the registry does not have, the right identity from another issuer, a tag that does not exist (nothing verified after it)                                                                 |
| `verified-upstream-image-refusals.sh` H   | For each of the nine workflows: a `known-inputs` assertion whose names are not exactly the declared inputs, that is not the first step, or a schema that is not closed                                                                                                                                                                                                 |
| `verified-upstream-image-refusals.sh` C   | The type cosign stores the signature under; an input name in the wrong case or mistyped, `attestationType` or `ref` left out, a mistyped input of `verify-release` (none of these starts a run); neither identity input, both, an expression not anchored at both ends, a source with `attestationType` empty, an expression with provenance and no `sourceRepository` |
| `verified-upstream-image-refusals.sh` D   | A publisher whose provenance is signed by another identity than its image: the signature alone passes, the provenance fails against the image's identity and the message names the cause, an expression for both passes with the source held, and fails for another repository                                                                                         |
| `verified-upstream-image-nested.sh` E     | The README's nested step: an outer workflow that does not validate, does not pass with the right commit, or does not fail with the inner reason for another                                                                                                                                                                                                            |
| `verified-upstream-image-nested.sh` I     | What the schema does not catch in a nested step: mistyped source inputs that pass, `attestationType` or `ref` left out, an input given as `null`, `false` or a list that fails without words or after the signature was read, and a mistyped input of `verify-release`                                                                                                 |
| `verified-upstream-image-nested.sh` F     | Three identical runs started together: a run that fails with an expression or index error in place of words, or with anything but "its record was replaced"                                                                                                                                                                                                            |
| `verified-upstream-image-old-cosign.sh` G | `@dataverket/cosign` 2026.10.28.1: a run that passes with no subject check made, or fails with an expression error in place of "needs @dataverket/cosign 2026.11.10.1 or later"                                                                                                                                                                                        |

The images are `ghcr.io/renovatebot/renovate:44.226.2`, signed and attested by
one workflow with SLSA provenance v1, and
`ghcr.io/fluxcd/source-controller:v1.6.0`, signed by its release workflow and
attested by the `slsa-github-generator` with SLSA v0.2. Both are public; if a
tag is removed or moved, batch A fails at its second line, which names the
digest expected. In batch F which of the three runs passes is a matter of
timing; on this machine one passed and two said their record was replaced.

## Environment

Run on 2026-11-10 on Linux x86_64 with swamp 20261110.035534.0, cosign 3.1.4,
crane 0.22.1 and jq, with `@dataverket/cosign` 2026.11.10.1 and
`@dataverket/crane` 2026.10.29.2 loaded from source, and network access to
ghcr.io, Rekor and the Sigstore TUF root: 18, 32, 15 and 6 passed, 0 failed,
each batch in about a minute or less. No container runtime, no cluster and no
registry login is needed. macOS has not been run. No run waits longer than 150
s. The other eight workflows are not run by this suite, but for their drift
check and one refusal of a mistyped input, from the command line and from a
nested step. An independent review ran each of them once to a successful end
against local throwaway registries on 2026-11-10, `pinned-base-image` with
`minimumAgeDays=0`; not with multi-platform builds, `tlog: true`,
`signatureTags: false` or a registry that needs a login.
