# @dataverket/crane

A container registry driven through
[crane](https://github.com/google/go-containerregistry/blob/main/cmd/crane/README.md),
as swamp data: tags resolved to digests, images and indexes described, images
mirrored in by digest, digests given tags, and a file read out of an artifact's
layer. One model type, `@dataverket/crane/registry`, two workflows that bring
their own model, and a skill, `crane`, that says which to run for what.

| Method     | Runs                                                 | Records                                                                                                                                    |
| ---------- | ---------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `digest`   | `crane digest` per reference                         | One `digest-<repository>-<tag>` per reference: the digest now, the digest it held last time, and since when it has been the current one    |
| `describe` | `crane digest`, `crane manifest`, `crane config`     | One `image-<repository>-<digest>` per reference: image or index, media type, platforms, config, created, labels, annotations, layers, size |
| `copy`     | `crane digest`, then `crane copy` and `crane digest` | One `mirror-<repository>-<tag>` per source: where it landed, its digest, `copied` or `unchanged`                                           |
| `tag`      | `crane digest`, then `crane tag` and `crane digest`  | `tagging-<repository>-<tag>`: the digest now and the digest the tag held before                                                            |
| `blob`     | `crane digest`, `crane manifest`, `crane blob`       | `blob-<repository>-<digest>-<file>`: the file's text, as JSON when it parses, its sha256 and size                                          |

Written and tested against crane 0.22.1.

## A registry

```sh
swamp model create @dataverket/crane/registry registry \
  --global-arg registry=registry.example.org \
  --global-arg namespace=mirror \
  --global-arg 'username=${{ vault.get("registry", "username") }}' \
  --global-arg 'password=${{ vault.get("registry", "password") }}'

swamp model method run registry digest --input 'refs:json=["docker.io/library/nats:2.10"]'
swamp model method run registry copy --input 'sources:json=["docker.io/library/nats:2.10@sha256:<digest>"]'
swamp model method run registry tag --input name=nats --input digest=sha256:<digest> --input tag=stable
```

| Argument      | Default |                                                                                                                                           |
| ------------- | ------- | ----------------------------------------------------------------------------------------------------------------------------------------- |
| `registry`    |         | The registry `copy` and `tag` write to and the credential logs in to, `host[:port]`. May stay empty for a definition that only reads      |
| `namespace`   |         | The path `copy` and `tag` work under: `<registry>/<namespace>/<name>`; empty for the registry's root                                      |
| `username`    |         | The credential's user, a vault expression; empty to use the container config of the user running swamp                                    |
| `password`    |         | The credential's password or token, a vault expression                                                                                    |
| `insecure`    | `false` | Allow a registry served over plain HTTP or with a certificate that does not verify; `localhost` is plain HTTP regardless, as crane has it |
| `craneBinary` | `crane` |                                                                                                                                           |

A reference is `<repository>:<tag>` or `<repository>@sha256:<digest>` with its
registry: `docker.io/library/nats:2.10`, `ghcr.io/org/api@sha256:…`. One without
a slash is read under the definition's own registry and namespace: `nats:2.10`
is `<registry>/<namespace>/nats:2.10`.

`digest` and `describe` take `refs`, a list, and write one record each. `copy`
takes `sources`, each `<repository>:<tag>@sha256:<digest>`: the digest is what
is copied, the tag is what the mirror is tagged, and the last path segment is
the repository it lands in, `<registry>/<namespace>/nats:2.10`. A source with no
tag lands at `@<digest>` alone. A source with no digest is refused before crane
runs: a tag can move, and a mirror holds what was resolved. `tag` takes `name`,
`digest` and `tag`, and points `<registry>/<namespace>/<name>:<tag>` at a digest
that is already in that repository. `blob` takes `ref`, `path` and `layer`
(default `0`).

Every record carries `repository`, `digest` and, where there is one, `tag`, so
the next step pins by digest through CEL without parsing anything:

```yaml
sources: ${{ data.findBySpec("mirror-image", "digest").filter(d, d.tags.?workflowRunId.orValue("") == run.id).map(d, d.attributes.pinned) }}
```

## What each method is for

**`digest`** is the watch. A record is kept per tag, and when the same tag is
resolved again the method reads its last record back: `previousDigest` is what
it held, `changed` says whether it moved, and `firstSeenAt` is kept from the
earlier record while the digest stays the same and starts over when it changes.
A quarantine that mirrors a base image only after it has been seen unchanged for
N days reads `firstSeenAt` and nothing else. `pinned` is the reference with both
tag and digest, ready to be a `copy` source.

**`describe`** says what a reference is. An index records every child in
`children` with its platform, `platforms` lists the platform images (an
attestation manifest with platform `unknown/unknown` is a child, not a
platform), `layers` and `size` are summed over the platform images, and
`created`, `labels` and `configDigest` come from the first platform image's
config. An image records its own.

**`copy`** is the mirror, idempotent by digest: the target's digest is read
first, nothing is copied when it is already the source's, and after a copy the
target's digest is read again and must be the source's, or the method fails and
records nothing. crane copies the whole thing, an index with every platform
image and attestation it lists.

**`tag`** is a promotion: a release that passed becomes `stable` by retagging a
digest already in the repository, nothing is rebuilt or copied, and the digest
`stable` held before is in the record, so the step that rolls back knows where
to point it. A tag already at that digest is recorded `changed: false` and crane
is not run.

**`blob`** reads one file out of an artifact. A
[Flux artifact](https://fluxcd.io/flux/cheatsheets/oci-artifacts/) is one
tar+gzip layer holding the files `flux push artifact` was given; `blob` with
`path: release.json` fetches that layer, unpacks it in memory with a tar reader
of its own, and records the file as `text` and, when it parses, as `json`, so
`data.latest("registry", "blob-…-release.json").attributes.json.images` is the
image map a release lists. A layer that is a plain tar is read the same way, and
an empty `path` records the whole layer as the file, for an artifact whose layer
is the file itself. An index is refused: name one of its images.

## Workflows

Each creates its model on first use, named after itself, and ends with an
assertion. Workflow inputs are recorded in cleartext in the run history, so a
credential is never one: `mirror-image` names it by vault and key, and swamp
resolves every `vault.get` at run start, so all three are required.

| Workflow                       | Does                                                                                                                                                  | Model              |
| ------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------------- | ------------------ |
| `@dataverket/mirror-image`     | Every upstream tag resolved to its digest, every image copied under the namespace by that digest, unchanged when already there; fails unless each was | `mirror-image`     |
| `@dataverket/base-image-watch` | Read-only: the digest of every watched upstream tag recorded with its previous digest and first-seen time; scheduled daily; fails unless each was     | `base-image-watch` |

```sh
swamp extension pull @dataverket/crane
swamp vault put registry username robot
swamp vault put registry password            # the token, prompted

# Mirror upstream images, by digest, under registry.example.org/mirror
swamp workflow run @dataverket/mirror-image \
  --input 'refs:json=["docker.io/library/nats:2.10","cgr.dev/chainguard/static:latest"]' \
  --input registry=registry.example.org \
  --input vault=registry --input usernameKey=username --input passwordKey=password

# Watch base images, once by hand, then daily
swamp workflow run @dataverket/base-image-watch \
  --input 'refs:json=["cgr.dev/chainguard/static:latest"]'
swamp workflow trigger set @dataverket/base-image-watch --schedule "0 6 * * *" \
  --input 'refs:json=["cgr.dev/chainguard/static:latest"]'
```

`mirror-image` takes `refs` and `registry` (required), `namespace` (default
`mirror`), `vault`, `usernameKey` and `passwordKey` (required) and `insecure`.
`base-image-watch` takes `refs` (required) and `insecure`, and no credential:
what it watches is public. It ships with `trigger.schedule: "0 6 * * *"`, which
`swamp serve` fires; a scheduled run has no inputs of its own, so give it the
references once with `swamp workflow trigger set`, as above. Each workflow's
description lists its inputs; `swamp workflow get` prints it.

A quarantine reads the watch:

```yaml
# mirror only what has been this digest for seven days
expr: >-
  timestamp(run.startedAt) - timestamp(data.latest("base-image-watch", "digest-cgr.dev-chainguard-static-latest").attributes.firstSeenAt) >= duration("168h")
```

## The credential

With `username` and `password` set, each method logs in once:
`crane auth login <registry> --username <user> --password-stdin`, the password
on stdin, into a docker config directory made for that run and removed when the
method is done, pointed at through `DOCKER_CONFIG`. Only that credential is in
reach for the run, so an upstream read in the same run is anonymous. With both
empty, crane runs with the container config of the user running swamp:
`crane auth login`, `podman login` or `docker login` set it up. Nothing
sensitive is recorded or logged; the password never appears in an argument.

## Commands

The model runs `crane digest`, `crane manifest`, `crane config`, `crane blob`,
`crane copy`, `crane tag` and `crane auth login` as subprocesses in the
repository root, with arguments as argv arrays, never through a shell, and
`--insecure` on every call when `insecure` is set. A missing manifest is told
apart from any other failure by crane's `MANIFEST_UNKNOWN` and `NAME_UNKNOWN`
errors: `copy` and `tag` take it as "not there yet", `digest`, `describe` and
`blob` fail on it.

Three pre-flight checks come with the type: `arguments` (`registry` is a
`host[:port]`, `namespace` a repository path, `username` and `password` come
together and hold no unevaluated expression), `crane-installed` (`craneBinary`
runs) and `registry-reachable` (the registry answers on `/v2/`, any status,
plain HTTP for localhost). They run before `copy` and `tag`; `digest`,
`describe` and `blob` are reads. By hand: `swamp model validate <name>`.

## Errors

A crane failure names the command, its arguments and what it printed, and
nothing is recorded. Refused before crane runs: a reference with a scheme, a
space or a malformed digest; a `copy` source without a digest; a bare name with
no `registry` to complete it; a `tag` that is not an image tag; a `copy` or
`tag` with `registry` empty. A target whose digest after a copy or a tag is not
the one asked for fails the method. `blob` names every file the layer holds when
`path` is not among them, and refuses a layer that is not a tar when `path` is
given.

## Development

```sh
deno test --allow-env --allow-read --allow-write --allow-net
CRANE_E2E=1 deno test --allow-env --allow-read --allow-write --allow-net --allow-run
```

The unit tests drive the model with a fake crane over a fake registry: an index
of two platforms and an attestation, an image, a Flux-like artifact whose layer
the test builds as a tar+gzip. With `CRANE_E2E=1` one test runs the real crane
against a registry at `CRANE_E2E_REGISTRY` (default `localhost:5001`) holding
`CRANE_E2E_IMAGE` (default `team/hello:v1`): digest, describe, copy twice, tag
twice, and blob out of an artifact the test appends with `crane append`. A
throwaway registry and image:

```sh
podman run -d --name registry -p 127.0.0.1:5001:5000 docker.io/library/registry:2
KO_DOCKER_REPO=localhost:5001/team ko build --base-import-paths --sbom=none --tags=v1 ./cmd/hello
```

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
