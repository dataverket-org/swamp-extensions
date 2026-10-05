# @dataverket/flux

Flux for [swamp](https://github.com/swamp-club/swamp): HelmReleases,
Kustomizations and sources as three model types, read with `kubectl` and driven
with the `flux` CLI.

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
| `@dataverket/flux/source`        | `list`                                            |

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

| Method | Does                                                                                                                                                                                          |
| ------ | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `list` | Record every GitRepository, HelmRepository and OCIRepository, or one kind with `kind`, with URL, reference, artifact revision and readiness; a kind whose CRD is absent is skipped and logged |

## Global arguments

All three types share them.

| Argument     | Default                 | Meaning                                                |
| ------------ | ----------------------- | ------------------------------------------------------ |
| `namespace`  | `""` (all namespaces)   | Scope for `list`; the default namespace for the others |
| `kubeconfig` | `KUBECONFIG` or default | Path to a kubeconfig file                              |
| `context`    | current context         | Kubernetes context name                                |

A method acting on one object needs a namespace, from the model or from
`--arg namespace=<ns>`; without one it refuses by name rather than guessing.

## Prerequisites

`flux` (v2) and `kubectl` on PATH, configured to reach the cluster. Both are run
by name, so one pinned toolchain serves every method. Live pre-flight checks on
every type prove they can be run before any method starts; `source` only reads
with kubectl, so it carries only that check:

| Check                   | Label  | Proves                                                                      |
| ----------------------- | ------ | --------------------------------------------------------------------------- |
| `flux-cli-available`    | `live` | `flux --version` runs                                                       |
| `kubectl-cli-available` | `live` | `kubectl version --client` runs; every method reads the object back with it |

Skip them with `--skip-check-label live`.

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
```

## What gets recorded

| Spec            | Written by                                             | Instance name                 | Holds                                                                                       |
| --------------- | ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------- |
| `helmrelease`   | helmrelease `list`, `reconcile`, `suspend`, `resume`   | `<namespace>--<name>`         | Chart, versions, readiness with reason and message, source, conditions, revisions           |
| `resetResult`   | helmrelease `reset`                                    | `<namespace>--<name>`         | Readiness, the newest Helm history status and both failure counters, just after the attempt |
| `kustomization` | kustomization `list`, `reconcile`, `suspend`, `resume` | `<namespace>--<name>`         | Path, prune, source, applied and attempted revisions, readiness, conditions                 |
| `source`        | source `list`                                          | `<kind>--<namespace>--<name>` | URL, interval, reference, artifact revision and digest, readiness, conditions               |

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

## Scope

Read and drive what Flux already manages. This extension does not install Flux
and does not create, edit or delete HelmReleases, Kustomizations or sources;
those live in the git repository Flux reconciles from.

## License

MIT, see [LICENSE.md](./LICENSE.md). The original work is copyright
ginger_pappa; the fork and `reset` are copyright Jan Ivar Beddari.
