# @dataverket/flux

Flux for [swamp](https://github.com/swamp-club/swamp): HelmReleases,
Kustomizations and sources as three model types, read with `kubectl` and driven
with the `flux` CLI; and a directory pushed as an OCI artifact, for an
OCIRepository to pull.

This is a fork of [`@ginger_pappa/flux`](https://swamp-club.com) 2026.06.09.1
(MIT, copyright ginger_pappa), merged with the `reset` method this package used
to add to it as an extension. One package now owns the types, so nothing is
pulled from another collective, and the upstream code stays here to learn from.
Method names and the stored shapes are upstream's; a model created against the
upstream type moves by changing its `type` and `typeVersion`.

## Model types

| Type                             | Methods                                           |
| -------------------------------- | ------------------------------------------------- |
| `@dataverket/flux/helmrelease`   | `list`, `reconcile`, `suspend`, `resume`, `reset` |
| `@dataverket/flux/kustomization` | `list`, `reconcile`, `suspend`, `resume`          |
| `@dataverket/flux/source`        | `list`, `push_artifact`                           |

### helmrelease

| Method      | Does                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`      | Record every HelmRelease, one record per release, with chart name, requested and applied versions, readiness, source and conditions           |
| `reconcile` | `flux reconcile helmrelease`, with `withSource` to reconcile the chart source first; records the release afterwards                           |
| `suspend`   | `flux suspend helmrelease`; records the release afterwards                                                                                    |
| `resume`    | `flux resume helmrelease`; records the release afterwards                                                                                     |
| `reset`     | `flux reconcile helmrelease --reset`: clears the failure counters so a release stuck at `RetriesExceeded` is tried again; records the outcome |

### kustomization

| Method      | Does                                                                                                                  |
| ----------- | --------------------------------------------------------------------------------------------------------------------- |
| `list`      | Record every Kustomization with path, prune, source, applied and attempted revisions, readiness and conditions        |
| `reconcile` | `flux reconcile kustomization`, with `withSource` to reconcile the source first; records the Kustomization afterwards |
| `suspend`   | `flux suspend kustomization`; records it afterwards                                                                   |
| `resume`    | `flux resume kustomization`; records it afterwards                                                                    |

### source

| Method          | Does                                                                                                                                                                                          |
| --------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`          | Record every GitRepository, HelmRepository and OCIRepository, or one kind with `kind`, with URL, reference, artifact revision and readiness; a kind whose CRD is absent is skipped and logged |
| `push_artifact` | `flux push artifact --reproducible`: a directory pushed as an OCI artifact, with `release.json` from `metadata` written into a copy first; records the reference and digest                   |

#### push_artifact

The producer side of an OCIRepository: what `flux push artifact` uploads is what
a cluster's OCIRepository pulls. The method takes the directory, where to push,
and the source and revision Flux shows on the object; runs flux with
`--reproducible`, so the same content gives the same digest; and records the
digest flux printed, which is what gets signed, promoted or verified afterwards.
A tag can move, so the record carries the artifact by digest as `ref`.

| Argument           | Default |                                                                                                                     |
| ------------------ | ------- | ------------------------------------------------------------------------------------------------------------------- |
| `path`             |         | The directory to push, absolute or relative to the repository root                                                  |
| `target`           |         | `oci://<repository>:<tag>`; or give `repository` and `tag` instead                                                  |
| `repository`       |         | `<registry>/<path>`, when `target` is not given                                                                     |
| `tag`              |         | The tag, when `target` is not given                                                                                 |
| `source`           |         | The source address Flux shows for the artifact, such as the Git URL; `--source`                                     |
| `revision`         |         | `<branch                                                                                                            |
| `metadata`         |         | An object written as `release.json` into a copy of the directory before the push; the directory itself is untouched |
| `annotations`      | `[]`    | OCI annotations on the artifact, `key=value`                                                                        |
| `insecureRegistry` | `false` | Push to a registry served over plain HTTP, `--insecure-registry`                                                    |

A digest in `target`, a tag that is not one, an annotation without `=`, and a
`path` that is not a directory are refused before flux runs. With `metadata`,
the directory is copied to a temporary directory, `release.json` is written
there (replacing one of that name), the copy is pushed and removed; without it,
the directory is pushed as it is. Registry credentials are flux's own: the
container config of the user running swamp, or `flux`'s provider login. The
model's `namespace`, `kubeconfig` and `context` are not used: a push needs no
cluster.

## Global arguments

All three types share them.

| Argument     | Default                 | Meaning                                                |
| ------------ | ----------------------- | ------------------------------------------------------ |
| `namespace`  | `""` (all namespaces)   | Scope for `list`; the default namespace for the others |
| `kubeconfig` | `KUBECONFIG` or default | Path to a kubeconfig file                              |
| `context`    | current context         | Kubernetes context name                                |

A method acting on one object needs a namespace, from the model or from
`--arg namespace=<ns>`; without one it refuses by name rather than guessing.
`push_artifact` reads none of them.

## Prerequisites

`flux` (v2) and `kubectl` on PATH, configured to reach the cluster. Both are run
by name, so one pinned toolchain serves every method. Live pre-flight checks on
every type prove they can be run before any method starts. On `source`, whose
`list` never runs checks, the kubectl check is scoped to `list` and so runs only
under `swamp model validate`, and the flux check is scoped to `push_artifact`: a
push needs no kubectl.

| Check                   | Label  | Proves                                                                      |
| ----------------------- | ------ | --------------------------------------------------------------------------- |
| `flux-cli-available`    | `live` | `flux --version` runs                                                       |
| `kubectl-cli-available` | `live` | `kubectl version --client` runs; every method reads the object back with it |

Skip them with `--skip-check-label live`. Written and tested against flux
2.10.0.

## Use

```sh
swamp extension pull @dataverket/flux

swamp model create @dataverket/flux/helmrelease prod-helm \
  --global-arg context=prod-admin
swamp model create @dataverket/flux/kustomization prod-kustomizations \
  --global-arg context=prod-admin --global-arg namespace=flux-system
swamp model create @dataverket/flux/source prod-sources \
  --global-arg context=prod-admin

swamp model method run prod-helm list
swamp model method run prod-kustomizations list
swamp model method run prod-sources list --arg kind=GitRepository

# reconcile one release with its chart source first
swamp model method run prod-helm reconcile \
  --arg name=my-release --arg namespace=my-namespace --arg withSource=true

# clear the counters on a release stuck at RetriesExceeded
swamp model method run prod-helm reset \
  --arg name=my-release --arg namespace=my-namespace

# push rendered manifests as the artifact an OCIRepository pulls
swamp model method run prod-sources push_artifact \
  --arg path=out/prod --arg target=oci://registry.example.org/team/config:abc123 \
  --arg source=https://git.example.com/team/config \
  --arg revision=main@sha1:0123456789abcdef0123456789abcdef01234567 \
  --arg 'metadata:json={"images":[{"name":"api","digest":"sha256:<digest>"}]}' \
  --arg 'annotations:json=["org.opencontainers.image.revision=abc123"]'
```

After a `list`, the records are addressed by namespace and name, sources also by
kind:

```sh
swamp data query 'modelName == "prod-helm" && specName == "helmrelease" && isLatest' --json
swamp data query 'modelName == "prod-helm" && specName == "resetResult" && isLatest' --json
```

```yaml
# in a workflow
chart: ${{ data.latest("prod-helm", "monitoring--kube-prometheus-stack").attributes.appliedVersion }}
revision: ${{ data.latest("prod-kustomizations", "flux-system--flux-system").attributes.lastAppliedRevision }}
artifact: ${{ data.latest("prod-sources", "GitRepository--flux-system--flux-system").attributes.artifact.revision }}
pushed: ${{ data.latest("prod-sources", "registry.example.org-team-config--abc123").attributes.ref }}
```

## What gets recorded

| Spec            | Written by                                             | Instance name                 | Holds                                                                                                                                       |
| --------------- | ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `helmrelease`   | helmrelease `list`, `reconcile`, `suspend`, `resume`   | `<namespace>--<name>`         | Chart, versions, readiness with reason and message, source, conditions, revisions                                                           |
| `resetResult`   | helmrelease `reset`                                    | `<namespace>--<name>`         | Readiness, the newest Helm history status and both failure counters, just after the attempt                                                 |
| `kustomization` | kustomization `list`, `reconcile`, `suspend`, `resume` | `<namespace>--<name>`         | Path, prune, source, applied and attempted revisions, readiness, conditions                                                                 |
| `source`        | source `list`                                          | `<kind>--<namespace>--<name>` | URL, interval, reference, artifact revision and digest, readiness, conditions                                                               |
| `artifact`      | source `push_artifact`                                 | `<repository>--<tag>`         | `ref` by digest, `url` as flux printed it, repository, tag, digest, path, whether `release.json` was written, source, revision, annotations |

Every spec has an infinite lifetime and keeps the last ten records per instance,
twenty for `resetResult`.

## Why reset exists

helm-controller counts install and upgrade failures. Past the limit a
HelmRelease reaches `RetriesExceeded` and is never retried again, even when
every workload it created is healthy. A release whose first install merely timed
out stays failed for good. Reconciling does not help, because the counters
survive it. Clearing them is a separate flag, and `reset` passes it, waits for
the attempt, reads the object back and records what the cluster says. A failed
attempt is recorded rather than hidden: the error is kept and the object is
still read, so what is stored is what happened and not what was hoped for.

## Changes from upstream

- kubectl output that is not JSON is an error naming the command, instead of a
  bare `SyntaxError`.
- A HelmRelease declared through `spec.chartRef` (an OCIRepository or HelmChart)
  reports that reference as its `sourceRef`; upstream recorded an empty one.
- The spec and metadata of an object are read defensively, so an object with no
  `spec` no longer crashes the parser.
- Every kubectl resource is named by its full group,
  `helmreleases.helm.toolkit.fluxcd.io` and so on, so a cluster with another
  `helmreleases` type cannot be matched by mistake.
- The spawn is a replaceable seam and the pure parts are exported, so the
  methods are unit-tested against a strict fake.
- Each type carries an `upgrades` entry, so a model created on the upstream
  version is stamped when it first runs here.
- `reset` and the two CLI pre-flight checks, formerly a separate extension.
- `push_artifact` on the source type, in its own file like `reset`, and the
  source type's kubectl check scoped to `list`, so a push needs no kubectl.

## Scope

Read and drive what Flux already manages, and push what an OCIRepository pulls.
This extension does not install Flux and does not create, edit or delete
HelmReleases, Kustomizations or sources; those live in the git repository Flux
reconciles from.

## Development

```sh
deno test --allow-env --allow-read --allow-write
FLUX_E2E=1 deno test --allow-env --allow-read --allow-write --allow-run
```

The unit tests drive the types with a strict scripted spawn. With `FLUX_E2E=1`
one test runs the real flux: it pushes a directory with `release.json` to
`localhost:5002/team/config:test`, or `FLUX_E2E_REPOSITORY`, pushes it again and
sees the same digest, and pulls the artifact back with `flux pull artifact` to
compare. A throwaway registry does:

```sh
podman run -d --name registry -p 127.0.0.1:5002:5000 docker.io/library/registry:2
```

The cluster-bound methods are not run live here; they are upstream's, in use
since 2026-09-18.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari;
the original work, `@ginger_pappa/flux`, is copyright 2026 ginger_pappa under
the MIT License, whose notice LICENSE.md keeps.
