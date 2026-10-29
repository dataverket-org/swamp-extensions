# @dataverket/ko

Go programs built into container images by [ko](https://ko.build), as swamp
data: no Dockerfile, no container daemon, one image per `main` package, pushed
to a registry, loaded into the local daemon, or written to a tarball. One model
type, `@dataverket/ko/module`, three workflows that bring their own model, and a
skill, `ko`, that says which to run for what.

| Method     | Runs                                                        | Records                                                                                                 |
| ---------- | ----------------------------------------------------------- | ------------------------------------------------------------------------------------------------------- |
| `describe` | `go list`, `go version`, `ko version`; reads `.ko.yaml`     | `module`: module path, Go and ko versions, the config file and base image in effect, every main package |
| `build`    | `go list` to find the commands, then `ko build` per command | One `image-<command>` per command: reference, repository, tag, digest, where it went; and one `build`   |
| `resolve`  | `ko resolve` over a set of manifests                        | `manifests`, a file: the rendered manifests; `resolution`: the images built, and every image not pinned |

Written and tested against ko 0.19.1.

## A module

```sh
swamp model create @dataverket/ko/module api \
  --global-arg dir=services/api \
  --global-arg repo=registry.example.org/team \
  --global-arg 'platforms:json=["linux/amd64","linux/arm64"]'

swamp model method run api describe
swamp model method run api build --input 'importPaths:json=["./cmd/..."]' --input 'tags:json=["abc123","latest"]'
```

| Argument           | Default             |                                                                                                                                                                             |
| ------------------ | ------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `dir`              | `.`                 | The Go module's directory, absolute or relative to the repository root                                                                                                      |
| `repo`             |                     | Where images go, ko's `KO_DOCKER_REPO`: `registry.example.org/team`, or `ko.local` for the local daemon. Needed to push; may stay empty for a build that pushes nowhere     |
| `naming`           | `base-import-paths` | `<repo>/<command>`; `preserve-import-paths` is `<repo>/<full import path>`, `bare` is `<repo>` itself and needs one command, `default` is ko's own `<repo>/<command>-<md5>` |
| `platforms`        | `[]`                | `os/arch[/variant]` each, or `all`; empty is ko's default, `linux/amd64`, on every host                                                                                     |
| `sbom`             | `spdx`              | The SBOM pushed beside each image, or `none`                                                                                                                                |
| `baseImage`        |                     | Base image for every command, overriding `.ko.yaml`                                                                                                                         |
| `configPath`       |                     | A `.ko.yaml` to use instead of the module's own, relative to the repository root                                                                                            |
| `cache`            |                     | Where ko caches base images (`KOCACHE`), relative to the repository root                                                                                                    |
| `insecureRegistry` | `false`             | Allow a registry served over plain HTTP                                                                                                                                     |
| `koBinary`         | `ko`                |                                                                                                                                                                             |
| `goBinary`         | `go`                |                                                                                                                                                                             |

`build` takes `importPaths` (default `["."]`): packages relative to the module,
`./cmd/api`, or patterns, `./cmd/...`. The model expands them with `go list`,
builds only `main` packages and refuses a set that holds none. `tags` (default
none, which ko tags `latest`), `push` (default `true`), `local` (load into the
daemon; `repo: ko.local` does the same), `tarball` and `ociLayout` (also write
the images there, relative to the repository root), `ldflags` and `labels`
complete it. `resolve` takes `files` (manifests or directories, relative to the
repository root), `recursive` and `selector`, and the same publishing arguments.

Every image record carries `ref`, `repository`, `tag` and `digest`, and the
build record every ref and digest, so the next step pins by digest without
parsing anything. For a multi-platform build the image is the index, and
`children` holds the per-platform images ko published under it. A tarball holds
one image: `tarball` with more than one platform, or more than one command, is
refused before ko runs, while `ociLayout` takes both, appended to on every run.
ko names a layout as if it were a repository, so its path may hold only
lowercase letters, digits, `_`, `-`, `.` and `/`, the checkout's own path
included; any other is refused before ko runs. Neither is written when ko loads
into the daemon, so either with `local` is refused too:

```yaml
image: ${{ data.latest("api", "image-cmd-api").attributes.repository }}@${{ data.latest("api", "image-cmd-api").attributes.digest }}
```

## Workflows

Each creates its model on first use, named after itself, and ends with an
assertion; runs for different modules share that model, so run one module at a
time. No input carries a secret: ko authenticates to the registry from the
container config of the user running swamp (`ko login`, `podman login`,
`docker login`), and workflow inputs are recorded in cleartext in the run
history, so a credential must never be one.

| Workflow                   | Does                                                                                                                                                  | Model          |
| -------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- | -------------- |
| `@dataverket/ko-verify`    | `describe`, then builds every command pushing nowhere, to a tarball when asked; fails unless each was recorded with a digest. A check before merge    | `ko-verify`    |
| `@dataverket/ko-images`    | `describe`, then builds and pushes every command, or loads it into the daemon when `repo` is `ko.local`; fails unless each was recorded with a digest | `ko-images`    |
| `@dataverket/ko-manifests` | `resolve` over `files`, images pushed; fails unless at least one was built and, with `requirePinned`, every image in the rendered manifests is pinned | `ko-manifests` |

```sh
swamp extension pull @dataverket/ko

# Before merge: does it build, for both platforms, with no registry in reach?
swamp workflow run @dataverket/ko-verify \
  --input dir=services/api \
  --input 'importPaths:json=["./cmd/..."]' \
  --input 'platforms:json=["linux/amd64","linux/arm64"]'

# A release: every command pushed, tagged with the commit
swamp workflow run @dataverket/ko-images \
  --input dir=services/api \
  --input repo=registry.example.org/team \
  --input 'tags:json=["abc123","latest"]'

# Manifests for Flux or kubectl, every image pinned by digest
swamp workflow run @dataverket/ko-manifests \
  --input dir=services/api \
  --input repo=registry.example.org/team \
  --input 'files:json=["services/api/deploy"]' --input recursive=true \
  --input 'tags:json=["abc123"]'
```

Inputs common to the three: `dir`, `platforms`, `baseImage`, `cache`; to the two
that publish: `repo` (required), `tags` (default `["latest"]`), `naming`,
`sbom`, `push`, `insecureRegistry`. `ko-verify` and `ko-images` take
`importPaths` (default `["."]`), and `ko-verify` a `tarball`. `ko-manifests`
takes `files` (required), `recursive`, `selector` and `requirePinned` (default
`true`). Each workflow's description lists them all; `swamp workflow get` prints
it.

The rendered manifests are the next step's input through CEL:

```yaml
- name: push-artifact
  task:
    type: model_method
    modelIdOrName: flux
    methodName: push_artifact
    inputs:
      path: ${{ data.latest("ko-manifests", "manifests").path }}
```

## Hermetic builds

ko fetches the base image on every build, and resolves a tag such as `:latest`
every time even with a cache. Pin it by digest in the module's `.ko.yaml` and
give ko a cache, and only the first run needs the network, plus the push when
there is one:

```yaml
# .ko.yaml
defaultBaseImage: cgr.dev/chainguard/static@sha256:<digest>
```

```sh
swamp workflow run @dataverket/ko-verify --input dir=services/api --input cache=.cache/ko
```

`baseImage` overrides the file for one definition or run, and `configPath` names
another file. ko's own default base image, when neither names one, is
`cgr.dev/chainguard/static:latest`; `describe` records which of the three is in
effect as `baseImageSource`.

## Commands

The model runs `go list`, `go version`, `ko version`, `ko build` and
`ko resolve` as subprocesses in the module's directory, with arguments as argv
arrays, never through a shell, and with `KO_DOCKER_REPO`, and when set
`KO_DEFAULTBASEIMAGE`, `KO_CONFIG_PATH` and `KOCACHE`, in their environment.
Every tag is checked against the characters an image tag may hold, and an
`ldflags` entry with a comma is refused, since ko splits on it; such flags
belong in `.ko.yaml`.

Three pre-flight checks come with the type: `arguments` (`repo` is a registry
path without scheme or whitespace, every platform is `os/arch[/variant]` or
`all`), `module-found` (`dir` exists and holds a `go.mod`) and `ko-installed`
(`koBinary` runs). They run before `build` and `resolve`, and by hand with
`swamp model validate <name>`.

## Errors

A ko or go failure names the command, its arguments, the directory it ran in and
what it printed, and nothing is recorded. ko itself logs
`git is in a dirty state` when the module sits in a git tree with uncommitted
changes; that is a note about version stamping, not a failure. A set of
`importPaths` without a main package is refused with every package it named and
what each is. `naming: bare` with more than one command is refused, since the
images would overwrite each other. A reference ko records without a digest fails
the method; none of ko's publishers does that, so it would mean a ko that
changed.

## Development

```sh
deno test --allow-env --allow-read --allow-write
KO_E2E=1 deno test --allow-env --allow-read --allow-write --allow-run
```

The unit tests drive the model with a fake `go` and `ko`. With `KO_E2E=1` one
test runs the real ones against `fixtures/hello`, a module of two commands and
one library, pushing nowhere: a build to a tarball and a resolve of its
deployment, which keeps one third-party image unpinned on purpose. It needs ko
on `PATH` (or `KO_BINARY`) and, with no `KOCACHE` holding the base image
already, the network once.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
