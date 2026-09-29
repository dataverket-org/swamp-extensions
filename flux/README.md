# @dataverket/flux

A reconcile with `--reset` for Flux HelmReleases, as an extension to
[`@ginger_pappa/flux/helmrelease`](https://swamp-club.com). Install both.

## The method

| Method  | Adds                                                                                                               |
| ------- | ------------------------------------------------------------------------------------------------------------------ |
| `reset` | Reconcile a HelmRelease with `--reset`, clearing its failure counters, then record what the object says afterwards |

## Use

```sh
swamp extension pull @ginger_pappa/flux
swamp extension pull @dataverket/flux
swamp model create @ginger_pappa/flux/helmrelease releases

# clear the counters on a release stuck at RetriesExceeded
swamp model method run releases reset \
  --arg name=my-release --arg namespace=my-namespace

# and with the chart source reconciled first
swamp model method run releases reset \
  --arg name=my-release --arg withSource=true

swamp data query 'modelName == "releases" && specName == "resetResult" && isLatest' --json
```

## Pre-flight checks

| Check                   | Label  | Proves                                                                 |
| ----------------------- | ------ | ---------------------------------------------------------------------- |
| `flux-cli-available`    | `live` | `flux --version` runs                                                  |
| `kubectl-cli-available` | `live` | `kubectl version --client` runs; `reset` reads the object back with it |

A binary missing from PATH otherwise surfaces as a spawn error part-way through
the method, whose message names neither the binary nor what to do. These name
it. Skip them with `--skip-check-label live`.

## Why it is needed

helm-controller counts install and upgrade failures. Past the limit a
HelmRelease reaches `RetriesExceeded` and is never retried again, even when
every workload it created is healthy — a release whose first install merely
timed out stays failed for good. Reconciling does not help, because the counters
survive it. Clearing them is a separate flag, and upstream has no method that
passes it.

`reset` runs that reconcile, waits for the attempt, reads the object back with
kubectl and records readiness with its reason and message, the newest Helm
history status, and both failure counters. A failed attempt is recorded rather
than hidden: the error is kept and the object is still read, so what is stored
is what the cluster says and not what was hoped for.

`withSource` reconciles the upstream source first, for the case where the chart
itself was the problem.

## Shape

Deliberately the same as the base type: `flux` and `kubectl` are run by name
from PATH exactly as `@ginger_pappa/flux` runs them, so one pinned toolchain
serves both, and the model's namespace, kubeconfig and context are honoured.

## What gets recorded

| Spec          | Lifetime | Holds                                                                                                                          |
| ------------- | -------- | ------------------------------------------------------------------------------------------------------------------------------ |
| `resetResult` | infinite | Readiness with its reason and message, the newest Helm history status, and both failure counters, as of just after the attempt |

```sh
swamp data query 'specName == "resetResult" && isLatest' --json
```

Because the counters are recorded after the attempt, a release that reset
cleanly and one that failed again are told apart by the stored record rather
than by reading the cluster a second time.

## Scope

One method, one purpose. This extension does not install, upgrade or delete a
HelmRelease — `@ginger_pappa/flux` owns the lifecycle, and this adds only the
recovery action it lacks.

## License

MIT, see [LICENSE.md](./LICENSE.md).
