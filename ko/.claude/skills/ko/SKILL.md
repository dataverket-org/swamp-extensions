---
name: ko
description: >
  Build Go programs into container images with ko through the @dataverket/ko
  extension: no Dockerfile, no daemon, one image per main package, pushed to a
  registry, loaded into the local daemon, or written to a tarball; and render
  Kubernetes manifests with every ko:// image pinned by digest. Use when asked
  to "build images with ko", "ko build", "ko resolve", "containerize a Go
  service", "push Go images without a Dockerfile", "pin images by digest in
  manifests", or to check that a Go module builds as an image before merge.
---

# ko

`@dataverket/ko` wraps [ko](https://ko.build) as one model type,
`@dataverket/ko/module`, and three workflows. Prefer the workflows: each creates
its own model on first use and ends with an assertion.

## Pick the workflow

| Intent                                                                     | Run                                                                                                                                                     |
| -------------------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Does this module build as images at all? No registry, a check before merge | `swamp workflow run @dataverket/ko-verify --input dir=<module>`                                                                                         |
| Build and push every command, or load them into the local daemon           | `swamp workflow run @dataverket/ko-images --input dir=<module> --input repo=<registry path>`                                                            |
| Render manifests with the images built and pinned by digest                | `swamp workflow run @dataverket/ko-manifests --input dir=<module> --input repo=<registry path> --input 'files:json=["deploy/"]' --input recursive=true` |

`repo` is ko's `KO_DOCKER_REPO`: `registry.example.org/team` pushes there,
`ko.local` loads into docker or podman instead. Images are named
`<repo>/<command>` (`naming: base-import-paths`); `bare` names the image
`<repo>` itself and needs exactly one command. ko builds `linux/amd64` by
default, on every host: pass `platforms` (`["linux/amd64","linux/arm64"]` or
`["all"]`) for anything else. A tarball holds one image, one command on one
platform; for several, use `ociLayout` on the model, or no tarball.

Tags are an array: `--input 'tags:json=["<commit>","latest"]'`. Commands are
import paths relative to the module or patterns:
`--input 'importPaths:json=["./cmd/..."]'`. Every package named must be a `main`
package; the model lists them with `go list` and refuses a library.

## What gets recorded

| Record               | Holds                                                                                                                                             |
| -------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------- |
| `module`             | Module path, Go and ko versions, config file and base image in effect, commands                                                                   |
| `image-<command>`    | One image: `ref`, `repository`, `tag`, `digest`, where it went                                                                                    |
| `build`              | One build: every ref and digest, counts                                                                                                           |
| `buildRecord` (file) | The build record as JSON; `data.latest("ko-images", "buildRecord").path`, a predicate for `cosign attest`                                         |
| `resolution`         | One resolve: every pinned image in the rendered manifests as `images`, each with `builtHere`; `imageCount`, `builtCount`, `unpinned`, `allPinned` |
| `manifests` (file)   | The rendered manifests; `data.latest("ko-manifests", "manifests").path`                                                                           |

The workflows' models are `ko-verify`, `ko-images` and `ko-manifests`. Read the
latest build with:

```sh
swamp data query 'modelName == "ko-images" && name == "build"' --select content
```

The next step of a release reads the rendered manifests through CEL, never by
guessing a path:

```yaml
inputs:
  path: ${{ data.latest("ko-manifests", "manifests").path }}
```

The images a resolve built, pinned by digest, for signing or verifying:

```yaml
refs: ${{ data.latest("ko-manifests", "resolution").attributes.images.filter(i, i.builtHere).map(i, i.repository + "@" + i.digest) }}
```

Drop the filter for every pinned image in the manifests, third-party ones
included. A resolve over manifests already rendered builds nothing and lists
them all with `builtHere: false`.

## Hermetic builds

ko fetches the base image on every build. Pin it by digest and give ko a cache,
and only the first run needs the network (and a push, when there is one):

```yaml
# <module>/.ko.yaml
defaultBaseImage: cgr.dev/chainguard/static@sha256:<digest>
```

```sh
swamp workflow run @dataverket/ko-verify --input dir=services/api --input cache=.cache/ko
```

`baseImage` as an input overrides `.ko.yaml` for one run. A tag as base
(`:latest`) is re-resolved every run even with a cache.

## Do not

- Pass a registry credential as an input: inputs are recorded in cleartext in
  the run history. ko reads the container config of the user running swamp;
  `ko login <registry>` or `podman login` sets it up.
- Use `naming: bare` with more than one command; the images overwrite each
  other, and the model refuses it.
- Build several modules through one workflow at the same time: each workflow's
  model is shared, so one module at a time.
- Put commas in an `ldflags` entry; ko splits on them. Complex ldflags belong in
  `.ko.yaml`.
