# Smoke suite

What the unit tests cannot say: that `verifyAttestation` reads what a real
cosign prints for real provenance, that the record passes swamp's schema check,
that an argument given on the command line reaches the comparison, and that a
definition of the version before still runs. It is read-only: it reads two
public images on ghcr.io and the public Sigstore instance, needs no credential,
and writes nothing but records in a scratch repository.

## Run it

```sh
# 1. a scratch swamp repository loading this extension from source
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none && swamp extension source add "$OLDPWD/..")

# 2. the suite
./provenance.sh
```

## What each batch is for

| Batch             | What it refuses to let pass                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provenance.sh` A | SLSA v1 provenance read wrong or stored whole; a wrong commit, a short commit or a repository with `.git` that passes; an expectation with a space that reaches cosign; a missing attestation type that fails the run; another identity whose statements are still read; a record that does not say which identity and issuer it was checked against; a reference that starts with a dash and reaches cosign |
| `provenance.sh` B | SLSA v0.2 provenance from another publisher read wrong; its invocation environment in the output; another repository that passes                                                                                                                                                                                                                                                                             |
| `provenance.sh` C | A definition of 2026.10.28.1 that stops working, or is not stamped with the new version                                                                                                                                                                                                                                                                                                                      |

The two images are named by digest in the script, with the repository and commit
their provenance names: `ghcr.io/renovatebot/renovate` 44.226.2, attested by
GitHub's `attest-build-provenance`, and `ghcr.io/fluxcd/source-controller`
v1.6.0, attested by the `slsa-github-generator`. Both are public and immutable;
if one is removed, the batch that names it fails at its first line.

## Environment

Run on 2026-11-10 on Linux x86_64 with swamp 20261110.035534.0, cosign 3.1.4 and
jq, with network access to ghcr.io, Rekor and the Sigstore TUF root: 21 passed,
0 failed, in about one minute. No container runtime and no cluster is needed.
macOS has not been run. No call waits longer than 150 s.
