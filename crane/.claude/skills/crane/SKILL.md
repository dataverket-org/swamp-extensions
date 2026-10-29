---
name: crane
description: >
  Work with a container registry through crane and the @dataverket/crane
  extension: resolve tags to digests, describe an image or index, mirror
  upstream images into your own registry by digest, promote a release by
  retagging a digest, watch base images for changes, and read release.json out
  of a Flux OCI artifact. Use when asked to "mirror an image", "pin a base
  image", "what digest is this tag", "promote to stable", "retag", "watch
  upstream images", "read a Flux artifact", or "crane copy".
---

# crane

`@dataverket/crane` wraps crane as one model type, `@dataverket/crane/registry`,
and two workflows. Prefer the workflows: each creates its own model on first use
and ends with an assertion.

## Pick the workflow

| Intent                                              | Run                                                                                                                                                                                         |
| --------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Mirror upstream images into our registry, by digest | `swamp workflow run @dataverket/mirror-image --input 'refs:json=["docker.io/library/nats:2.10"]' --input registry=<host> --input vault=<v> --input usernameKey=<k> --input passwordKey=<k>` |
| Watch base images: record each tag's digest, daily  | `swamp workflow run @dataverket/base-image-watch --input 'refs:json=["cgr.dev/chainguard/static:latest"]'`                                                                                  |

For one-off reads and for promotion, create a model and run its methods:

```sh
swamp model create @dataverket/crane/registry registry \
  --global-arg registry=<host> --global-arg namespace=<path> \
  --global-arg 'username=${{ vault.get("<vault>", "<key>") }}' \
  --global-arg 'password=${{ vault.get("<vault>", "<key>") }}'
swamp model method run registry describe --input 'refs:json=["<repository>:<tag>"]'
swamp model method run registry tag --input name=<name> --input digest=sha256:<hex> --input tag=stable
swamp model method run registry blob --input ref=<repository>:<tag> --input path=release.json
```

A reference is `<repository>:<tag>` or `<repository>@sha256:<digest>` with its
registry; one without a slash is taken under the model's own registry and
namespace. `copy` sources carry both tag and digest,
`<repository>:<tag>@sha256:<digest>`: the digest is copied and the tag names the
mirror. The `pinned` field of a `digest` record is a source in exactly that
form. An image lands at `<registry>/<namespace>/<source registry>/<path>`,
`mirror/docker.io/library/nats`, where a registry mirror asks for it; read it
back by that full reference.

## What gets recorded

| Record                              | Holds                                                                                   |
| ----------------------------------- | --------------------------------------------------------------------------------------- |
| `digest-<repository>-<tag>`         | `digest`, `previousDigest`, `changed`, `firstSeenAt` (kept while unchanged), `pinned`   |
| `image-<repository>-<digest>`       | `kind` (image or index), `platforms`, `children`, `created`, `labels`, `layers`, `size` |
| `mirror-<repository>-<tag>`         | `target`, `digest`, `action` (`copied` or `unchanged`)                                  |
| `tagging-<repository>-<tag>`        | `digest`, `previousDigest`, `changed`                                                   |
| `blob-<repository>-<digest>-<file>` | `text`, `json` (when it parses), `sha256`, `size`, `layerMediaType`                     |

Read a release's image map out of a Flux artifact, then verify each image:

```yaml
inputs:
  ref: ${{ inputs.registry }}/shop/config-prod:candidate
  path: release.json
# next step
refs: ${{ data.latest("registry", "blob-…-release.json").attributes.json.images }}
```

Quarantine a base image: mirror only once `firstSeenAt` is old enough.

```yaml
expr: >-
  timestamp(run.startedAt) - timestamp(data.latest("base-image-watch", "digest-cgr.dev-chainguard-static-latest").attributes.firstSeenAt) >= duration("168h")
```

## The credential

Put the registry credential in a vault once and name it by vault and key. Inputs
are recorded in cleartext in the run history, so a token is never an input; the
model logs crane in with the password on stdin into a docker config that exists
for one run only. With no credential, crane uses the container config of the
user running swamp (`crane auth login`, `podman login`).

## Do not

- Copy a tag: `copy` refuses a source without a digest. Resolve first with
  `digest`, then copy `pinned`.
- Pass a token as an input or a global argument value; name it through
  `vault.get`.
- Expect `tag` to copy: the digest must already be in the repository under the
  namespace. Mirror first, then tag.
- Run `mirror-image` for two registries at once; the workflow's model is shared,
  so one registry at a time.
