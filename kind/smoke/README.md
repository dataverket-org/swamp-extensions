# Smoke and negative suite

What the unit tests cannot say: that kind and kubectl take the arguments this
type gives them, that kind's and kubectl's real error texts are sorted the way
the type assumes, that a stopped node container is noticed and named for the
provider in use, and that swamp stores the record. The suite creates one kind
cluster through `ensure` and deletes it through `delete`, and spends most of its
checks on what must be refused.

## Environment

The suite was run on 2026-11-10 on Linux x86_64 with:

| Tool    | Version  |                                                    |
| ------- | -------- | -------------------------------------------------- |
| podman  | 4.9.3    | rootless                                           |
| kind    | 0.33.0   | Podman provider, node image `kindest/node:v1.37.0` |
| kubectl | 1.37.2   |                                                    |
| swamp   | 20261110 |                                                    |
| jq      | 1.8.2    | reads the output of swamp                          |

- The cluster is made by the type itself, which runs
  `kind create cluster --name <n> --config kind.yaml --wait 90s --kubeconfig <file>`.
  The provider is chosen in the environment the scripts run in:
  `export KIND_EXPERIMENTAL_PROVIDER=podman`. kind calls its Podman provider
  experimental.
- Every script takes the kubeconfig file as input (`SMOKE_KUBECONFIG`) and the
  cluster name (`CLUSTER`). It only ever uses the context `kind-<CLUSTER>` of
  that file and of `other.kubeconfig` beside it. It refuses to run when the file
  is your default kubeconfig, and checks at its end that the default kubeconfig
  did not change; when `KUBECONFIG` is a list of files, both hold for each file
  of the list. Nothing creates or deletes a cluster through the default
  kubeconfig.
- Every model of the suite sets the `kubeconfig` argument. The mode without it,
  where kind writes to the default kubeconfig, is not run live by this suite and
  was not run live at all: a live run of it would write to the operator's own
  kubeconfig. It is not covered by any test.
- `life.sh` refuses to start when a kind cluster named `CLUSTER` already exists,
  so it never deletes a cluster it did not make. It lists the other kind
  clusters before and checks afterwards that each is still there.
- Rootless Podman changes nothing for this suite: it needs no LoadBalancer
  address and no port below 1024, and no case is unhealthy because of it. A node
  container that was stopped and started again came back with the same node and
  the same API server port. Stopping it takes about 10 seconds: Podman waits
  that long for the node to stop by itself and then kills it.
- Size: the suite runs one single-node cluster and no workload. Measured with
  `podman stats --no-stream` every 3 to 5 seconds while `life.sh` ran, the node
  container used at most 515 MB of memory, and its CPU use peaked between 1.1
  and 1.4 CPUs while a cluster started, with one sample of 2.1 CPUs, over four
  runs. swamp, kind and kubectl on the host were not measured. `life.sh` took
  about two and a half minutes and `neg.sh` under one. macOS was not run: the
  suite ran on Linux x86_64; macOS on Apple silicon is expected to work with a
  Podman machine of at least 2 CPUs and 2 GiB, not yet run there.
- Docker and nerdctl probably work: without `KIND_EXPERIMENTAL_PROVIDER` the
  scripts stop and start the node container with `docker`. Neither was run.

## Run it

```sh
# 1. the provider, and where the cluster's kubeconfig goes; its directory must exist
export KIND_EXPERIMENTAL_PROVIDER=podman
export SMOKE_KUBECONFIG=$(mktemp -d)/kubeconfig

# 2. the cluster the suite makes and deletes, and a name that is never made
export CLUSTER=kind-smoke CLUSTER2=kind-smoke-absent

# 3. a swamp repository loading this extension from source, and the models
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none && swamp extension source add "$OLDPWD/..")
./models.sh

# 4. the suite
./neg.sh
./life.sh
```

`life.sh` leaves no cluster behind when it runs to its end. When it is
interrupted, `(cd "$REPO" && swamp behavior run c delete)` removes the cluster.

## What each batch is for

| Batch     | What it holds the extension to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| --------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `neg.sh`  | `get` and `delete` of a cluster that was never made; every line of `names.txt` (flags, spaces, shell text, paths, capitals) refused as a cluster name by all three methods; a kind config that is not there; a kubeconfig in a directory that is not there, refused by `ensure` and by `delete`, and the directory not made; `kindBinary` not on PATH; a `waitTimeout`, config path or kubeconfig path that is a flag; a `waitTimeout` of 600 hours; which method needs kubectl: `get` and `delete` run with `kubectlBinary` not on PATH, `ensure` is stopped by the check. No cluster is made                                                                                                                                                                                                                |
| `life.sh` | `ensure` on a missing cluster: created, three manifests applied (one path holds a space), record correct; `ensure` again: no second create, same node; `get`; a manifest that is not there: refused, and the record says which one failed and what was applied; `kubectlBinary` not on PATH: `ensure` stopped, `get` records the cluster with the reason; a kubeconfig file that is not there: `get` records the cluster and writes no file, `ensure` writes the file with `kind export kubeconfig` and passes; the node container stopped: `ensure` refused with `<provider> start <node>`, `get` still records it; started again: `ensure` passes; `delete`; `delete` again; `delete` through the other kubeconfig takes the stale entry out of it; `get` refused by swamp; `ensure` and `delete` once more |

A refusal must also write no record and carry no client key. After `delete`,
swamp marks the record deleted and refuses `get` until `ensure` has run again;
`life.sh` holds it to that, and then creates and deletes the cluster once more.
`life.sh` also checks that the client key of the cluster's kubeconfig is nowhere
in the swamp repository's data.

## Run logs

The scripts print one `PASS` or `FAIL` line per check and a count, and keep no
log. `$REPO/.out.json` and `$REPO/.err.txt` hold the output of the last swamp
run only and are overwritten by the next. To keep a run, redirect it:
`./life.sh | tee life.log`.

## Last run

2026-11-10, kind 0.33.0 on rootless podman 4.9.3, Kubernetes v1.37.0, kubectl
1.37.2, swamp 20261110, Linux x86_64: `neg.sh` 62 checks and `life.sh` 38
checks, all passed. The run started at 13:10:07 local time, after the last write
to any file of the extension at 13:09:49; only this section and, later, the
published `README.md` (text only, no code) were written afterwards.
