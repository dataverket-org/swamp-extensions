# Smoke suite

What the unit tests cannot say: that `verifyAttestation` and `identify` read
what a real cosign prints for real images, that the records pass swamp's schema
check, that an argument given on the command line reaches the comparison, that
`swamp model validate` says what the README says it does, and that a definition
of the version before still runs. It reads public images on ghcr.io and quay.io
and the public Sigstore instance, needs no credential, and writes records in a
scratch repository. One optional part writes to a throwaway registry on the
machine it runs on, and nowhere else.

## Run it

```sh
# 1. a scratch swamp repository loading this extension from source
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none && swamp extension source add "$OLDPWD/..")

# 2. the suite
./provenance.sh
./identify.sh
./survey.sh
```

`survey.sh` runs `identify` over 33 public images on six registries, each named
by a digest, and checks the state recorded for each and, where there is one, the
identity. It needs the network and no login, and takes about four minutes. Its
digests and states are what was there on 2026-11-11: a failure may be the world
changing, a registry that removed a digest, a publisher that signed again, a
rate limit, and not a fault here. Read the line that failed before anything
else.

`hostile.sh` is the third script. It needs the throwaway registry described
below and is not read-only there.

`identify.sh` has a part that needs signatures made with a key, which no public
image is sure to keep. It runs when `REGISTRY` names a throwaway registry on
`127.0.0.1` or `localhost`, served over plain HTTP with no login, and is skipped
with a `SKIP` line otherwise. It makes two images of a few bytes there with
`crane`, signs one through the model with a key it generates and keeps in the
scratch repository's vault, and signs the other in the older tag form with
`tag-form-sign.sh`, since cosign 3 no longer writes that form:

```sh
podman run -d --name identify-smoke -p 127.0.0.1:5077:5000 docker.io/library/registry:2
REGISTRY=127.0.0.1:5077 ./identify.sh
REGISTRY=127.0.0.1:5077 ./hostile.sh
podman rm -f identify-smoke
```

`hostile.sh` runs `identify` against a registry that lies or fails, which no
public registry will do on request. It copies one signed public image into the
throwaway registry and rewrites its `.sig` manifest with `forge-tag-form.py`, so
that forged certificates stand beside the real signature. It adds an attestation
to a second copy, so that a tag-form signature stands beside a bundle. Then it
starts `fault-proxy.py` on `127.0.0.1:5079` (`PROXY_PORT` names another port) in
front of the registry, has it answer chosen lookups with a rate limit, a refused
login or a server error, and at last reads from the proxy's log every request
`identify` makes for an image and fails each one in turn. It needs `crane`,
`python3`, `openssl` and `curl`. With both registries it takes about seven and a
half minutes as one script, and no single call in it waits longer than 150 s, so
run it in the background and read its last line.

`REGISTRY2` names a second throwaway registry for the last batch. cosign finds
bundles through a registry's referrers API when it has one and through a
fallback tag when it has none, so one registry of each kind covers both:

```sh
podman run -d --name identify-smoke-2 -p 127.0.0.1:5076:5000 ghcr.io/project-zot/zot-minimal-linux-amd64:v2.1.2
REGISTRY=127.0.0.1:5077 REGISTRY2=127.0.0.1:5076 ./hostile.sh
podman rm -f identify-smoke-2
```

## What each batch is for

| Batch             | What it refuses to let pass                                                                                                                                                                                                                                                                                                                                                                                  |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `provenance.sh` A | SLSA v1 provenance read wrong or stored whole; a wrong commit, a short commit or a repository with `.git` that passes; an expectation with a space that reaches cosign; a missing attestation type that fails the run; another identity whose statements are still read; a record that does not say which identity and issuer it was checked against; a reference that starts with a dash and reaches cosign |
| `provenance.sh` B | SLSA v0.2 provenance from another publisher read wrong; its invocation environment in the output; another repository that passes                                                                                                                                                                                                                                                                             |
| `provenance.sh` C | A definition of 2026.10.28.1 that stops working, or is not stamped with the new version                                                                                                                                                                                                                                                                                                                      |
| `identify.sh` A   | A signature kept as a Sigstore bundle whose identity, issuer or claims are read wrong; a definition with no key and no identity that cannot ask; a record that looks like a pass (a `verified` field, `identityChecked` not `false`); the provenance stored beside the signature counted as one; an identity and issuer that `verify` does not accept as they are recorded                                   |
| `identify.sh` B   | A signature kept under a `.sig` tag that is not read, or one for which more is recorded than the identity, the issuer and the five claims cosign prints                                                                                                                                                                                                                                                      |
| `identify.sh` C   | An unsigned image, or a digest the registry does not have, that fails the run or names someone; two references that do not give two records; a tag or a reference shaped like a flag that reaches cosign; a missing cosign reported badly                                                                                                                                                                    |
| `identify.sh` D   | A definition of 2026.11.10.1 that fails validate, stops verifying, or is not stamped with the new version                                                                                                                                                                                                                                                                                                    |
| `identify.sh` E   | `swamp model validate` failing on a signer with no key; `key-usable` passing for `--method sign`, `attest` or `signBlob`; a run of one of those methods with an empty key that is not stopped by the check itself, or, with the checks skipped, not refused by the method                                                                                                                                    |
| `identify.sh` F   | A key's signature, in either storage form, that fails the run or is given an identity; a key fingerprint that differs from the one `describe` records, or is recorded under a name that reads as proven; a refused `sign` that left a signature behind; an image with both forms read as anything but its bundles                                                                                            |
| `hostile.sh` A    | A forged certificate in the tag form that is marked genuine or whose claims are recorded, with 20 of them before 20 real signatures; forged certificates alone that name anyone                                                                                                                                                                                                                              |
| `hostile.sh` B    | An image signed under a `.sig` tag and attested later as a bundle that is recorded as `unsigned`, or whose claims are not the ones cosign confirmed; a key's signature under a tag beside an attestation, or beside a bundle signature, that the record is silent about                                                                                                                                      |
| `hostile.sh` C    | A rate limit, a refused login or a server error on the lookup of the bundles (the referrers API, then the fallback tag) that is recorded as `unsigned`, or that makes an image be read from its tag; the same on the lookup of the `.sig` tag, also beside bundles; a rate limit, a refused login or "not found" on the one signature bundle's own manifest that is recorded as `unsigned`                   |
| `hostile.sh` D    | Any single request `identify` makes for an image, of seven kinds of image, that fails with a refused login and is recorded as something other than what is recorded with no fault; a manifest or a blob named by digest that is "not found" and does not fail the run. With `REGISTRY2`, the same on a second registry                                                                                       |
| `hostile.sh` E    | An artifact of another kind beside an unsigned image, also one of a type nobody registered, that fails the run; an attestation whose label says it is a signature, as some published images have, that fails the run or is taken for a signature; a signature labelled as something else that is not found. Needs a registry with a referrers API, so it runs on `REGISTRY2`                                 |
| `survey.sh`       | A healthy public image, of the kinds people really publish, that fails the run or is recorded in another state than before                                                                                                                                                                                                                                                                                   |

The images are named by digest in the scripts. `ghcr.io/renovatebot/renovate`
44.226.2 is attested by GitHub's `attest-build-provenance` and signed as a
Sigstore bundle; `ghcr.io/fluxcd/source-controller` v1.6.0 is attested by the
`slsa-github-generator` and signed under a `.sig` tag; `quay.io/coreos/etcd`
v3.5.0 has no signature. All are public and immutable; if one is removed, the
batch that names it fails at its first line. Batch E signs nothing: its
references name `registry.invalid`, a host that cannot exist.

## Environment

Run on 2026-11-11 on Linux x86_64 with swamp 20261110.035534.0, cosign 3.1.4 and
jq 1.8, with network access to the registries named, Rekor and the Sigstore TUF
root, and with an empty container config, so no registry login was in play:

- `provenance.sh`: 21 passed, 0 failed, in about 50 seconds.
- `identify.sh` without `REGISTRY`: 34 passed, 0 failed, batch F skipped, in
  about 60 seconds.
- `identify.sh` with `REGISTRY`: 42 passed, 0 failed, in about 80 seconds.
- `survey.sh`: 33 passed, 0 failed, in about 220 seconds: 23 images identified,
  one signed with a key, 9 unsigned, on ghcr.io, quay.io, docker.io, gcr.io,
  cgr.dev and registry.k8s.io.
- `hostile.sh` with `REGISTRY` and `REGISTRY2`: 52 passed, 0 failed, in about 7
  minutes. Batch D failed 115 single requests in turn, 70 on the first registry
  and 45 on the second; most of the time is cosign trying again after a rate
  limit or a server error in batch C.

`REGISTRY` was `docker.io/library/registry:2` on `127.0.0.1:5077`, which has no
referrers API, so cosign used its fallback tag for bundles. `REGISTRY2` was
`ghcr.io/project-zot/zot-minimal-linux-amd64:v2.1.2` on `127.0.0.1:5076`, which
has one. Both were new, one container each on rootless Podman 4.9.3; the proxies
ran on Python 3 on ports 5079 and 5075. The images were made with crane 0.22.1
and the tag form with OpenSSL 4.1 and curl.

No cluster is needed. macOS has not been run; `tag-form-sign.sh` uses GNU
`stat`, `base64 -w0` and `sha256sum`, so the parts that need a registry are
expected to need changes there. No call waits longer than 150 s. Not covered by
any test: an image signed by several identities; a bundle with a certificate
that is not genuine; a tag-form signature whose signer wrote `githubWorkflow`
values or an issuer into its payload under a certificate that has none, which
needs a certificate authority of one's own; more than five identities in the tag
form; a tag-form payload spelled in capitals beside a forged certificate; a
transparency log that cannot be reached; a private Sigstore with `trustedRoot`;
and a registry that needs `insecureRegistry`. In batch D a rate limit and a
server error are tried on the signature bundle's manifest only, since cosign
waits and tries again on each; every other request is failed with a refused
login.
