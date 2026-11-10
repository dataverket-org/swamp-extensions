# Smoke and negative suite

What the unit tests cannot say: that the status fields, the labels on hook Jobs
and the errors are the ones a real helm-controller and a real kubectl produce,
and that swamp stores the record under the name the README promises. It runs
against a throwaway kind cluster and spends about half its effort on what should
_not_ happen.

## Environment

The suite was run on Linux x86_64 with rootless Podman, and kind with its Podman
provider. That is the tested environment; nothing else was run.

| Needs     | Run with on 2026-11-10 | For                                                  |
| --------- | ---------------------- | ---------------------------------------------------- |
| `podman`  | 4.9.3, rootless        | The kind node, one container                         |
| `kind`    | 0.33.0                 | The cluster, Kubernetes v1.37                        |
| `kubectl` | 1.37                   | The cluster setup, and the extension itself          |
| `flux`    | 2.10.0                 | Installing the controllers, and the extension itself |
| `helm`    | 4.3                    | Packaging the test chart                             |
| `jq`      |                        | The checks                                           |
| `swamp`   | 20261110               | Running the methods                                  |
| `python3` |                        | Optional: the server that never answers, in batch b  |

- The cluster is made with
  `KIND_EXPERIMENTAL_PROVIDER=podman kind create cluster --name <name> --kubeconfig <file>`,
  which `cluster.sh up` runs. kind calls its Podman provider experimental. Set
  `KIND_EXPERIMENTAL_PROVIDER=docker` to try Docker; it probably works and was
  not tested.
- Every script takes the kubeconfig file as input (`SMOKE_KUBECONFIG`) and names
  the context `kind-<CLUSTER>` on every command, so it cannot reach a cluster
  that kind did not make, and your own kubeconfig is never read or written.
  Nothing creates or deletes a cluster except `cluster.sh up` and
  `cluster.sh down`, with that file.
- Rootless matters little here: the suite needs no LoadBalancer address and no
  port below 1024. It reaches the cluster only through the API server port kind
  publishes on localhost, and the chart server is inside the cluster. The one
  listener it opens itself is on `127.0.0.1:16443` (`SMOKE_SLOW_PORT`). The
  releases that are unhealthy are unhealthy by design, not because of Podman.
- The cluster needs the network: it pulls the Flux controller images, the
  podinfo chart and image from `ghcr.io`, one busybox image from Docker Hub, and
  clones `github.com/stefanprodan/podinfo` for the Kustomization.
- Measured with `podman stats` while the four batches ran: the kind node used
  between 0.25 and 0.45 of one CPU and between 0.8 and 0.9 GiB of memory. It was
  run on Linux x86_64; macOS on Apple silicon is expected to work with a Podman
  machine of at least 2 CPUs and 4 GiB, and was not yet run there.

## Run it

```sh
# 1. where the cluster's kubeconfig goes; your own kubeconfig is never touched
export SMOKE_KUBECONFIG=$(mktemp -d)/kubeconfig

# 2. a kind cluster with Flux, then the releases, then their second revisions
./cluster.sh up
./cluster.sh seed
./cluster.sh upgrade
./cluster.sh reader

# 3. a swamp repository loading this extension from source, and the models
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none && swamp extension source add "$OLDPWD/..")
./models.sh

# 4. the suite; d runs last, it changes what a to c read
for b in a b c d; do ./neg-$b.sh; done

# 5. and away
./cluster.sh down
```

`CLUSTER` names the kind cluster (default `flux-smoke`), `SMOKE_WORK` the
directory for the packaged charts and the three extra kubeconfig files (default
`.work` here, ignored by git). Each step of `cluster.sh` polls once a second and
gives up by name; on 2026-11-10 `up` took about a minute and the others under
half a minute each. No batch waits longer than two minutes: the longest wait in
them is kubectl's 35 seconds against the server that never answers, twice.

## What the cluster holds

Flux's source, helm and kustomize controllers. `chart/hooked` is a chart made
for this: a ConfigMap, a `pre-install` hook Job that is kept, a `post-install`
hook Job deleted by `hook-succeeded`, a `pre-upgrade` hook Job with no label of
its own that fails when `failUpgradeHook` is set, and a test Pod. It is packaged
twice and served by a busybox `httpd` inside the cluster, so nothing is pushed
anywhere.

| Release     | Brought to                                                                                     |
| ----------- | ---------------------------------------------------------------------------------------------- |
| `podinfo`   | Installed at 6.9.1 from an OCIRepository, upgraded to 6.9.2: two good history entries, no Jobs |
| `hooked`    | Installed at 0.1.0 and tested, then an upgrade to 0.2.0 that fails in its `pre-upgrade` hook   |
| `noversion` | Asks for a chart version that does not exist: never installed, no history                      |

One Kustomization, `podinfo` in `apps`, applies podinfo's own `kustomize`
directory from a GitRepository into the namespace `ks-apps`. With the
HelmRepository of the chart server and the OCIRepository of the podinfo chart,
that gives the source type one object of each kind.

`cluster.sh reader` writes a kubeconfig for a ServiceAccount that may get and
list HelmReleases in `apps` and nothing else, one that points at a closed port,
and one that points at the port where batch b starts a server that accepts a
connection and never answers. `cluster.sh heal` is run by batch d: it stops the
`pre-upgrade` hook of `hooked` from failing.

## What each batch is for

| Batch | What it holds the extension to                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a`   | The three releases as `get` records them: history, last action and outcome, counters, test hooks, hook Jobs; `list` unchanged                                                                                                                                                                                                                                                                                                                                                          |
| `b`   | What `get` and `list` refuse: a missing release or namespace, names and namespaces shaped as flags, selectors or shell text, from the argument and from the definition, a closed port, a missing kubeconfig or context; and a server that never answers, stopped at the limit                                                                                                                                                                                                          |
| `c`   | A reader who may not list Jobs (recorded), get the release or list every namespace (refused); `--all` refused by every method that changes something, and nothing suspended; the reader's token nowhere in the repository's data                                                                                                                                                                                                                                                       |
| `d`   | The working paths: `suspend`, `resume`, `reconcile` and `reconcile` with its source on a HelmRelease and on a Kustomization; the three lists; `reset` three ways: by a reader who may not change the release (flux fails, no reset was handled, nothing recorded, though the release is ready), on a release that fails again (recorded as `reset.<namespace>--<name>`, then reported), and after `heal` on one that then upgrades; the `list` record keeps its name through all of it |

A refusal must also write no record and carry no token.

Not in the suite: `push_artifact`, which needs a registry and no cluster. Its
opt-in test is in `../push_artifact_test.ts` (`FLUX_E2E=1`, see the README one
level up). The limits of 60, 330, 630 and 930 seconds on `flux` are not waited
for here; a `flux` that hangs is covered by the unit tests, and the stopping of
a real process by the tests of `../../lib/`.

## Recording the fixtures

`../fixtures/` holds the objects the unit tests read, taken from this cluster
after `cluster.sh upgrade`, with `managedFields` removed:

```sh
k() { kubectl --kubeconfig "$SMOKE_KUBECONFIG" --context "kind-${CLUSTER:-flux-smoke}" -n apps "$@"; }
for n in podinfo hooked noversion; do
  k get helmreleases.helm.toolkit.fluxcd.io $n -o json |
    jq 'del(.metadata.managedFields)' > ../fixtures/hr-$n.json
  k get jobs.batch -l helm.toolkit.fluxcd.io/name=$n,helm.toolkit.fluxcd.io/namespace=apps -o json |
    jq 'del(.items[].metadata.managedFields)' > ../fixtures/jobs-$n.json
done
```

## Logs

No log of a run is kept. Each batch prints one `PASS` or `FAIL` line per check
and a count; a `FAIL` line carries the end of what swamp printed.
`$REPO/.out.json` and `$REPO/.err.txt` hold the output of the last method run
only, and go with `$REPO`. To keep a run, redirect it: `./neg-a.sh | tee a.log`.

## Last run

2026-11-10, kind 0.33.0 on rootless podman 4.9.3, Kubernetes v1.37.0, flux
2.10.0 (helm-controller v1.7.1), swamp 20261110: 17, 37, 13 and 20 checks, all
passed. The server that never answers was stopped by the 35 second process limit
both times, not by kubectl's own request timeout. The opt-in `push_artifact`
test passed against a `registry:2` container on `127.0.0.1:5002`. One read-only
`list` of each type and one `get` against a production cluster through a reader
context agreed with it: an upgraded release at Helm revision 5, and the two
`pre-install,pre-upgrade` hook Jobs of its chart, both succeeded.
