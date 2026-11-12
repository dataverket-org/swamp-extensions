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

| Type                             | Methods                                                  |
| -------------------------------- | -------------------------------------------------------- |
| `@dataverket/flux/helmrelease`   | `list`, `get`, `reconcile`, `suspend`, `resume`, `reset` |
| `@dataverket/flux/kustomization` | `list`, `reconcile`, `suspend`, `resume`                 |
| `@dataverket/flux/source`        | `list`, `push_artifact`                                  |

### helmrelease

| Method      | Does                                                                                                                                          |
| ----------- | --------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`      | Record every HelmRelease, one record per release, with chart name, requested and applied versions, readiness, source and conditions           |
| `get`       | Read one HelmRelease in full: what `list` stores, every Helm history entry, the last action and how it ended, the failure counters, hook Jobs |
| `reconcile` | `flux reconcile helmrelease`, with `withSource` to reconcile the chart source first; records the release afterwards                           |
| `suspend`   | `flux suspend helmrelease`; records the release afterwards                                                                                    |
| `resume`    | `flux resume helmrelease`; records the release afterwards                                                                                     |
| `reset`     | `flux reconcile helmrelease --reset`: clears the failure counters so a release stuck at `RetriesExceeded` is tried again; records the outcome |

#### get

`list` answers "is it ready, and at which chart version". `get` answers what a
caller otherwise digs out of the Ready message: was the last action an install
or an upgrade, did it succeed, which revision is applied and which was only
attempted, and what did the hooks do. It reads one release with `kubectl get`
and the Jobs Flux labelled for it, changes nothing, and stores one `detail`
record:

| Field                                                       | Holds                                                                                                                        |
| ----------------------------------------------------------- | ---------------------------------------------------------------------------------------------------------------------------- |
| every field of `list`                                       | Unchanged, so a caller can move from one record to the other                                                                 |
| `history[]`                                                 | Each entry of `status.history`, newest first: `version` (Helm's revision number), `status`, `action`, chart and app version  |
| `history[].firstDeployed`, `lastDeployed`, `deleted`        | The times Helm recorded for the revision                                                                                     |
| `history[].digest`, `configDigest`, `ociDigest`             | Digests of the release object, of the values, and of the chart artifact when it came from an OCI source                      |
| `history[].tested`, `testHooks[]`                           | Whether Helm tests ran for the revision, and each test hook with `phase`, `lastStarted` and `lastCompleted`                  |
| `lastAction`, `lastActionSource`                            | `install`, `upgrade` or `unknown`, and which part of status said so                                                          |
| `lastActionOutcome`, `releasedReason`                       | `succeeded`, `failed` or `unknown` from the Released condition, and its reason such as `UpgradeFailed`                       |
| `failures`, `installFailures`, `upgradeFailures`, `stalled` | The counters helm-controller keeps, 0 when status has none, and whether the Stalled condition is True                        |
| `lastAttemptedRevision`, `lastAppliedRevision`              | The chart version last tried, and the chart version of the newest history entry with status `deployed`                       |
| `lastAppliedReleaseVersion`                                 | Helm's revision number of that deployed entry                                                                                |
| `lastAttemptedReleaseAction`, its duration, digests         | As helm-controller wrote them                                                                                                |
| `releaseName`, `releaseNamespace`, `storageNamespace`       | Where Helm installed the release; they differ from the object's own with `releaseName` or `targetNamespace`                  |
| `jobs[]`                                                    | Each Job labelled for the release: `hooks` from `helm.sh/hook`, delete policies, `state`, `reason`, counts, start and finish |
| `jobsRead`, `jobsNote`                                      | Whether the Jobs could be read, and why not                                                                                  |
| `generation`                                                | `metadata.generation`; ahead of `observedGeneration` means helm-controller has not acted on the newest spec yet              |
| `readAt`                                                    | When the record was read                                                                                                     |

`lastAction` never comes from a message. It is read from
`status.lastAttemptedReleaseAction`; when an older helm-controller did not write
that, from the `action` of the newest history entry, then from the reason of the
Released or Ready condition (`InstallFailed`, `UpgradeSucceeded` and so on),
then from the newest entry's revision number (1 is an install), then from the
failure counters. `lastActionSource` names the one that was used.

After a failed upgrade, `lastAttemptedRevision` is the new chart version and
`lastAppliedRevision` is still the old one: the newest history entry is `failed`
and the one below it is `deployed`. The `appliedVersion` of `list` is the newest
entry's chart version whatever its status, as before.

A release that failed, is stalled, or never installed is recorded, not thrown: a
release with no history has `history: []` and `lastAction: unknown`. Only a
broken call is an error: a release or namespace that does not exist, an expired
login, a server that does not answer (see [Time limits](#time-limits)), output
that is not the HelmRelease that was asked for, or a Job list that is not a list
of Jobs.

Hook Jobs are found by the two labels helm-controller puts on everything a
release renders, hooks included: `helm.toolkit.fluxcd.io/name` and
`helm.toolkit.fluxcd.io/namespace`. Helm itself sets no owner on a hook. Most
charts delete a hook Job when it succeeds or before the next run, so an empty
`jobs` with `jobsRead: true` means "none is left", not "none ran"; a Job that is
not a hook has an empty `hooks`. When the reader may not list Jobs in that
namespace, or the release is installed on another cluster through
`spec.kubeConfig`, the release and its history are still recorded, with
`jobsRead: false` and the reason in `jobsNote`.

`history` is what Flux keeps in the object's status, which is the last few
revisions and not everything `helm history` would print.

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

A digest in `target`, a tag that is not one, an annotation without `=`, a `path`
that is not a directory, and a target whose record name would be longer than 255
bytes are refused before flux runs. With `metadata`, the directory is copied to
a temporary directory, `release.json` is written there (replacing one of that
name), the copy is pushed and removed; without it, the directory is pushed as it
is. The copy holds the regular files and directories only; a symbolic link,
FIFO, socket or device is left out and named in the log, which changes nothing
in the artifact, because flux leaves those out too. `source` is given to flux as
written and stored in the record without a user or password. Registry
credentials are flux's own: the container config of the user running swamp, or
`flux`'s provider login. The model's `namespace`, `kubeconfig` and `context` are
not used: a push needs no cluster.

## Global arguments

All three types share them.

| Argument     | Default                 | Meaning                                                |
| ------------ | ----------------------- | ------------------------------------------------------ |
| `namespace`  | `""` (all namespaces)   | Scope for `list`; the default namespace for the others |
| `kubeconfig` | `KUBECONFIG` or default | Path to a kubeconfig file                              |
| `context`    | current context         | Kubernetes context name                                |

A method acting on one object needs a namespace, from the model or from
`--arg namespace=<ns>`; without one it refuses by name rather than guessing. The
object name and the namespace must be valid Kubernetes names. Anything else is
refused before `flux` or `kubectl` runs, because a name such as `--all` would be
read there as a flag: `flux suspend helmrelease --all` suspends every release of
the namespace. `push_artifact` reads none of them.

## Time limits

Every `flux` and `kubectl` process this extension starts is stopped when it
still runs after its limit: SIGTERM, SIGKILL two seconds later. A cancelled
method run stops the running process the same way. Before 2026.11.10.1 nothing
stopped a process that hung.

| Call                                                                 | Limit | Why                                                                                                                                                                          |
| -------------------------------------------------------------------- | ----- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| every `kubectl` call (`list`, `get`, each read-back)                 | 35 s  | It carries `--request-timeout=30s`; the process limit is a little behind kubectl's own                                                                                       |
| `flux suspend`                                                       | 60 s  | One patch, no wait                                                                                                                                                           |
| `flux resume`                                                        | 330 s | flux waits for the apply, five minutes at most by its own `--timeout`                                                                                                        |
| `flux reconcile`, also with `--reset` (`reset`)                      | 330 s | flux waits for the reconciliation, five minutes at most                                                                                                                      |
| `flux reconcile --with-source` on a Kustomization                    | 630 s | flux waits for the source and then for the Kustomization, five minutes at most each                                                                                          |
| `flux reconcile --with-source` on a HelmRelease, also in `reset`     | 930 s | flux waits for the chart's repository, for the HelmChart and then for the release, five minutes at most each; a release on an OCIRepository has two waits and the same limit |
| `flux push artifact` (`push_artifact`)                               | 330 s | flux gives the upload five minutes at most                                                                                                                                   |
| the pre-flight checks (`flux --version`, `kubectl version --client`) | 20 s  | They only start the binary                                                                                                                                                   |

A limit covers everything the process does, a credential plugin of the
kubeconfig included: a login that opens a browser must finish within the limit
of the command that started it, 35 seconds for kubectl. Log in first.

flux gives up by itself after five minutes and says why, and each limit is a
little longer than that, so the message an operator reads is flux's own; the
limit is for a flux that hangs outside that wait. This extension passes no
`--timeout` to flux. A method runs flux and then reads the object back, so its
whole run can take the flux limit plus 35 seconds; `reset` reads the object
first too, and after a flux that ran out of time it reads again for up to 30
seconds more (see [Why reset exists](#why-reset-exists)). When a limit is hit
the error says so:
`flux reconcile failed: no answer within 330 seconds; the
process was stopped`,
or
`kubectl get <resource> ... failed: no answer within
35 seconds; kubectl was stopped`.
The limits are constants in `_helpers.ts` (`FLUX_TIMEOUTS`) and in the shared
kubectl layer; there is no argument for them.

Each `flux` and `kubectl` call may write at most 64 MiB to standard output and
standard error together. A call that writes more is stopped, and the method
fails with an error that says so. The bound is in the shared layer,
`../lib/cli.ts`, and has no argument.

## Prerequisites

`flux` (v2) and `kubectl` on PATH, configured to reach the cluster. Both are run
by name, so one pinned toolchain serves every method. Live pre-flight checks on
every type prove they can be run before a method that changes something starts,
and under `swamp model validate`. swamp runs no checks before `list` and `get`;
there a missing binary is the method's own error,
`kubectl is not on
PATH; install it or put it on the PATH this repository runs with`.
On `source` the kubectl check is scoped to `list`, so it runs only under
`swamp model validate`, and the flux check is scoped to `push_artifact`: a push
needs no kubectl.

| Check                   | Label  | Proves                                                                      |
| ----------------------- | ------ | --------------------------------------------------------------------------- |
| `flux-cli-available`    | `live` | `flux --version` runs                                                       |
| `kubectl-cli-available` | `live` | `kubectl version --client` runs; every method reads the object back with it |

Skip them with `--skip-check-label live`. Written and tested against flux
2.10.0, whose helm-controller is v1.7.1; `get` reads the HelmRelease `v2` API.

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

# one release with its Helm history, last action, counters and hook Jobs
swamp model method run prod-helm get \
  --arg name=my-release --arg namespace=my-namespace

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
kind; the record of `get` has `detail.` in front:

```sh
swamp data query 'modelName == "prod-helm" && specName == "helmrelease" && isLatest' --json
swamp data query 'modelName == "prod-helm" && name == "detail.my-namespace--my-release"' --select content
swamp data query 'modelName == "prod-helm" && name == "reset.my-namespace--my-release"' --select content
```

```yaml
# in a workflow
chart: ${{ data.latest("prod-helm", "monitoring--kube-prometheus-stack").attributes.appliedVersion }}
upgraded: ${{ data.latest("prod-helm", "detail.my-namespace--my-release").attributes.lastAction == "upgrade" && data.latest("prod-helm", "detail.my-namespace--my-release").attributes.lastActionOutcome == "succeeded" }}
helmRevision: ${{ data.latest("prod-helm", "detail.my-namespace--my-release").attributes.lastAppliedReleaseVersion }}
revision: ${{ data.latest("prod-kustomizations", "flux-system--flux-system").attributes.lastAppliedRevision }}
artifact: ${{ data.latest("prod-sources", "GitRepository--flux-system--flux-system").attributes.artifact.revision }}
pushed: ${{ data.latest("prod-sources", "registry.example.org_2fteam_2fconfig_3aabc123").attributes.ref }}
```

## What gets recorded

| Spec            | Written by                                             | Instance name                 | Holds                                                                                                                                       |
| --------------- | ------------------------------------------------------ | ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------- |
| `helmrelease`   | helmrelease `list`, `reconcile`, `suspend`, `resume`   | `<namespace>--<name>`         | Chart, versions, readiness with reason and message, source, conditions, revisions                                                           |
| `detail`        | helmrelease `get`                                      | `detail.<namespace>--<name>`  | Everything `helmrelease` holds, the Helm history, last action and outcome, counters, applied and attempted revisions, labelled Jobs         |
| `resetResult`   | helmrelease `reset`                                    | `reset.<namespace>--<name>`   | Readiness, the newest Helm history status and both failure counters, just after the attempt                                                 |
| `kustomization` | kustomization `list`, `reconcile`, `suspend`, `resume` | `<namespace>--<name>`         | Path, prune, source, applied and attempted revisions, readiness, conditions                                                                 |
| `source`        | source `list`                                          | `<kind>--<namespace>--<name>` | URL, interval, reference, artifact revision and digest, readiness, conditions                                                               |
| `artifact`      | source `push_artifact`                                 | `<repository>:<tag>`, escaped | `ref` by digest, `url` as flux printed it, repository, tag, digest, path, whether `release.json` was written, source, revision, annotations |

Every spec has an infinite lifetime and keeps the last ten records per instance,
twenty for `resetResult`.

swamp finds a record by its name alone, whatever its spec, so the names of one
model never overlap. A namespace holds no dot, so a `detail.` or `reset.` name
can never be the name of a `list` record. An artifact's name is
`<repository>:<tag>` with every character that is not a letter, a digit, `.` or
`-` written as `_` and two hex digits: `/` is `_2f`, `:` is `_3a`, `_` is `_5f`.
`registry.example.org/team/config:abc123` is stored as
`registry.example.org_2fteam_2fconfig_3aabc123`. A name longer than 255 bytes
cannot be stored (swamp keeps each record in a directory of that name), so
`push_artifact` refuses such a target before it pushes. Two different targets
never share a name, and no source record has an underscore in its name. Two tags
that differ only in the case of a letter, `V1` and `v1`, have two names that are
one directory on a case-insensitive file system, the default on macOS: there the
newer record takes the place of the other. Keep tags apart by more than case if
the data store may live on such a file system.

Text that a controller or a user wrote is stored with credentials blanked: a
condition's `message`, `readyMessage`, a source's `url` and an artifact's
`source` lose the user and password before a host (what is written before the
`@` of an `https://` address is dropped, the rest is kept), and a token or
password elsewhere in a message reads `[redacted]`.

## Upgrading to 2026.11.12.1

Definitions and records are as in 2026.11.10.1; no argument, data name or record
field changed. The unit tests follow the swamp skill's pattern, and the bundled
shared layer adds the 64 MiB output bound per command described above: a command
that writes more is stopped, and the method fails with an error that says so.

## Upgrading to 2026.11.10.1

A definition moves by changing its `typeVersion`. No global argument changed and
no field of an existing record changed. Two data names changed, and anything
that reads them by name must follow:

| Record        | Name in 2026.10.29.1                                  | Name now                                                           |
| ------------- | ----------------------------------------------------- | ------------------------------------------------------------------ |
| `resetResult` | `<namespace>--<name>`                                 | `reset.<namespace>--<name>`                                        |
| `artifact`    | `<repository>--<tag>` with `/` and `:` written as `-` | `<repository>:<tag>` with `/` as `_2f`, `:` as `_3a`, `_` as `_5f` |

- `resetResult` had the name of the `helmrelease` record of the same release.
  swamp finds data by name, so after a `reset` the newest record under
  `<namespace>--<name>` was the reset result, and
  `data.latest(model, "<namespace>--<name>").attributes.appliedVersion` was
  absent until the next `list`. Read the reset result as
  `data.latest(model, "reset.<namespace>--<name>")`. A reset result written by
  an older version stays under the old name until the next `list`, `reconcile`,
  `suspend` or `resume` writes the release's own record over it; do not delete
  that name, it is the release's.
- `artifact`: `registry.example.org/team/config:abc123` was
  `registry.example.org-team-config--abc123` and is now
  `registry.example.org_2fteam_2fconfig_3aabc123`. The old form gave
  `reg/team/config` and `reg/team-config` the same name.

  The record under the old name stays where it is and is never written again. A
  workflow that still reads the old name gets no error: for a tag that is pushed
  again and again, such as `latest` or `prod`, it gets the last digest that
  2026.10.29.1 pushed, and would sign, promote or deploy an old artifact. Change
  every reference to the new name, then delete the old record so that a
  reference you missed fails instead of answering:

  ```sh
  swamp data delete <model> registry.example.org-team-config--prod
  ```

  A step that reads the artifact of its own run by spec, not by name, is not
  affected and is the form that survives a rename.

The names of the `helmrelease`, `kustomization` and `source` records are the
same as before.

New:

- `get` on the helmrelease type and its `detail` record.

Stored values that change:

- A condition's `message` and `readyMessage`, in every record, are stored with
  credentials blanked: the user and password of a URL are removed, and a token,
  password or Authorization value reads `[redacted]`. The blanking goes by
  shape, so it also takes the word that follows `password`, `token`, `secret`,
  `api-key` or `private-key` and a `:` or `=`, credential or not: a message that
  ends in `secret: secrets "x" not found` is stored as
  `secret: [redacted] "x" not found`. Any other message is stored as before.
- A source's `url` and an artifact's `source` are stored without the user and
  password before the host. `ssh://git@host/path` is stored as
  `ssh://host/path`; `git@host:path` has no scheme and is stored as it is. flux
  itself is still given `source` as you wrote it. A workflow that compares a
  stored `url` or `source` with an address, or uses it to reach the repository,
  must expect the form without user and password.

Refused now, accepted before:

- A name that is not a Kubernetes object name is refused by `reconcile`,
  `suspend`, `resume` and `reset` before anything runs. It was passed to `flux`
  as it was, where `--all` is a flag.
- A namespace that is not a Kubernetes namespace name is refused by every
  method, `list` included, from the argument and from the definition. `list`
  passed it to `kubectl` unchecked.
- A `list` whose answer is not a Kubernetes List of the kind that was asked for
  is an error. An answer without `items` used to read as an empty list.
- A `list` that holds two objects whose records would get the same data name
  (`b--c` in namespace `a`, and `c` in namespace `a--b`) is refused before
  anything is written. One record used to replace the other silently.

Behaves differently:

- An empty `namespace` argument now counts as not given and falls back to the
  definition's namespace. `--arg namespace=` on a definition with a namespace
  used to list every namespace; create a definition without a namespace for
  that.
- `reset` reads the release before it runs flux, so a release that does not
  exist is refused by kubectl's `not found` and flux does not run. When flux
  fails and `status.lastHandledResetAt` did not change, nothing was reset: the
  method throws flux's error and writes no record. It used to read the object
  and, when that said Ready, succeed and record a result. When flux fails after
  the reset was handled, the result is recorded; the error is thrown when the
  release is not ready, and logged when it is. A cancelled run or a missing
  `flux` ends the method at once. After a flux that ran out of time, the field
  is read again for up to 30 seconds; when it still has not changed, the error
  says "not yet, or not at all" and no record is written, where 2026.10.29.1
  wrote one.
- `push_artifact` refuses a target whose record name would be longer than 255
  bytes, before it pushes. Such a push used to upload and then fail to store its
  record.
- The source `list` skips a kind when kubectl reports its failure as a missing
  CRD. That now includes
  `(NotFound): the server could not find the requested resource`, which was an
  error before.
- `push_artifact` with `metadata` copies only regular files and directories, and
  logs the paths it left out. It used to copy symbolic links as links;
  `flux push artifact` leaves links and other special files out of the artifact
  either way, so the artifact is the same. A FIFO in the directory used to block
  the copy forever. A copy that fails or is cancelled leaves no partial copy in
  the temporary directory.
- `suspend` and `resume` log one line when they are done, as `reconcile` did.

Time limits (see [Time limits](#time-limits)):

- Every `kubectl` call carries `--request-timeout=30s` and is stopped after 35
  seconds; every `flux` call is stopped after 60, 330, 630 or 930 seconds, by
  command. Nothing had a limit.
- The limit also covers a credential plugin that the kubeconfig runs. An
  interactive login that kubectl or flux starts must finish within the limit of
  that command, 35 seconds for kubectl; it could take any time before. Log in
  before running a method.
- A cancelled method run now stops the running `flux` or `kubectl`. Only `reset`
  passed the signal on before.

Error texts:

| Before                                                                                   | Now                                                                                                                               |
| ---------------------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------- |
| a bad name reached flux, which answered in its own words                                 | `name "--all" is not a Kubernetes object name: lowercase letters, digits, '-' and '.', ...`                                       |
| a bad namespace reached flux or kubectl                                                  | `namespace "-A" is not a Kubernetes namespace name: lowercase letters, digits and '-', ...`                                       |
| `namespace is required for X: set it on the model or pass --arg namespace=<ns>`          | `namespace is required for X: set it in the definition's global arguments or pass the namespace argument`                         |
| `namespace is required: set it on the model or pass --input namespace=<ns>` from `reset` | `namespace is required for reset: set it in the definition's global arguments or pass the namespace argument`                     |
| `kubectl get <args> did not print JSON: <first 120 characters>`, `(empty)`               | `kubectl get <args> did not print JSON (<n> characters of output)`, `(no output)`; the output is never repeated                   |
| a bare `SyntaxError` from `reset` when its read was not JSON                             | the same `did not print JSON` error                                                                                               |
| `kubectl get <args> failed: <all of stderr>`                                             | The same start, then kubectl's own sentence on one line: client-go log lines dropped, credentials blanked, at most 400 characters |
| the same, for an expired login, a missing CRD, an unreachable or silent server           | `kubectl get <args> failed: <what it means> (<kubectl's sentence>)`, such as `the cluster could not be reached (...)`             |
| `flux <subcommand> failed: <all of stderr>`                                              | `flux <subcommand> failed: <the lines that are not progress lines>`, on one line, credentials blanked, at most 400 characters     |
| `kubectl get failed: ...` from `reset`                                                   | `kubectl get helmreleases.helm.toolkit.fluxcd.io <name> -n <ns> failed: ...`; `reset` reads by the full resource name             |
| a failed `reset` that did nothing: no error when the release read Ready                  | `flux reconcile failed: ...; the reset was not handled (status.lastHandledResetAt did not change), so nothing was recorded`       |
| `kubectl version --client failed: <text>` from a pre-flight check                        | `kubectl version --client failed (exit 1): <text>`; the same form for `flux --version`                                            |
| a missing binary during a method: the runtime's own spawn error (`Failed to spawn ...`)  | `flux is not on PATH; install it or put it on the PATH this repository runs with`; the same for `kubectl`                         |
| `flux push artifact did not print JSON: <first 120 characters>`                          | the same, with credentials blanked                                                                                                |
| a hung process: nothing                                                                  | `... failed: no answer within <n> seconds; ...`                                                                                   |
| a cancelled run: whatever the killed process left                                        | `flux <subcommand> was cancelled`, `kubectl <args> was cancelled`                                                                 |

The error of a failed kubectl call is a `KubectlError` with a `kind`
(`not-found`, `forbidden`, `unauthorized`, `missing-crd`, `timeout`,
`unreachable`, `not-json`, `cancelled`, `not-installed`, `other`).

Smaller:

- The global arguments have descriptions; names, types and defaults are the
  same.
- The pre-flight check `kubectl-cli-available` has one description on all three
  types.

## Why reset exists

helm-controller counts install and upgrade failures. Past the limit a
HelmRelease reaches `RetriesExceeded` and is never retried again, even when
every workload it created is healthy. A release whose first install merely timed
out stays failed for good. Reconciling does not help, because the counters
survive it. Clearing them is a separate flag, and `reset` passes it and waits
for the attempt.

`flux reconcile --reset` writes a timestamp in the annotation
`reconcile.fluxcd.io/resetAt`, and helm-controller copies it to
`status.lastHandledResetAt` when it clears the counters. `reset` reads that
field before and after flux runs, so it knows whether a reset happened, whatever
flux's exit status says:

| flux                 | `lastHandledResetAt`                  | Release   | `reset` does                                                          |
| -------------------- | ------------------------------------- | --------- | --------------------------------------------------------------------- |
| succeeds             | either                                | ready     | Records the result                                                    |
| fails                | changed                               | not ready | Records the result, then throws flux's error: it failed again         |
| fails                | changed                               | ready     | Records the result and logs what flux said                            |
| fails with an answer | unchanged                             | either    | Throws flux's error and records nothing: no reset happened            |
| runs out of time     | unchanged, also after 30 more seconds | either    | Throws flux's error with "not yet, or not at all" and records nothing |

"Fails with an answer" is a refused patch, an expired login, a release that does
not exist: nothing was asked of helm-controller, and the method ends at once.
"Runs out of time" is a flux that was stopped at its time limit, or gave up by
itself after its five minutes (`context deadline exceeded`,
`timed out waiting`). That says nothing about helm-controller, which may still
be working, so `reset` reads the field again every 5 seconds for at most 30
seconds before it decides.

helm-controller v1.7.1 sets the field and clears the counters after it has
loaded the chart, and writes both to the object just before it starts the Helm
action. So during a long install or upgrade the field has already changed, and
`reset` records the state it finds and throws flux's error if the release is not
ready yet. The field stays unchanged while the release waits in
helm-controller's queue or its chart cannot be loaded. After the 30 seconds
`reset` cannot tell "later" from "never", says so in the error, and records
nothing; 2026.10.29.1 recorded whatever the object said. Run `get` to see the
release, and `reset` again if the counters are still there.

A record is therefore always the state after a reset that helm-controller
handled, never the state of a release nothing was done to.

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
- Processes are run by a shared layer with a replaceable spawn, a time limit on
  every call and redacted, bounded error text; the pure parts are exported and
  unit-tested, and each method is unit-tested through a stub spawn.
- Each type carries an `upgrades` entry, so a model created on the upstream
  version is stamped when it first runs here.
- `reset` and the two CLI pre-flight checks, formerly a separate extension.
- `push_artifact` on the source type, in its own file like `reset`, and the
  source type's kubectl check scoped to `list`, so a push needs no kubectl.
- `get` on the helmrelease type, in its own file too, with the `detail` record.
- A name or namespace that is not a Kubernetes name is refused by every method,
  `list` included. Upstream passed it to `flux` and `kubectl` as it was.

## Scope

Read and drive what Flux already manages, and push what an OCIRepository pulls.
This extension does not install Flux and does not create, edit or delete
HelmReleases, Kustomizations or sources; those live in the git repository Flux
reconciles from.

## Development

```sh
deno task check && deno task lint && deno task fmt:check
deno task test
FLUX_E2E=1 deno test --allow-env --allow-read --allow-write --allow-run
```

The process and kubectl layers are shared with the other extensions of this
repository and live in `../lib/`; their own tests run there. Because the types
import `../lib/`, the swamp commands that package the extension need the
repository root: `swamp extension quality manifest.yaml --extensions-dir ..`,
and the same flag on `fmt` and `push`.

The unit tests cover the pure parts, the parsers, the arguments of each call and
the blanking of credentials, and every method once on success and once on
failure: each runs its `execute` through `createModelTestContext` of
`@swamp-club/swamp-testing`, with kubectl and flux answered by a stub spawn
(`stub_test.ts`) that knows only the commands the test lists, and the test
checks the records written and the log lines. The tests of `get` read
HelmRelease objects recorded from a kind cluster with Flux 2.10.0, in
`fixtures/`. What the types do against a real cluster, refusals included, is
tested by the live suite in `smoke/`. With `FLUX_E2E=1` one test runs the real
flux: it pushes a directory with `release.json` to
`localhost:5002/team/config:test`, or `FLUX_E2E_REPOSITORY`, pushes it again and
sees the same digest, and pulls the artifact back with `flux pull artifact` to
compare. A throwaway registry does:

```sh
podman run -d --name registry -p 127.0.0.1:5002:5000 docker.io/library/registry:2
```

## Testing

The live suite in `smoke/` runs every method except `push_artifact` through
swamp against a throwaway [kind](https://kind.sigs.k8s.io) cluster on rootless
Podman, which is the environment it was run in; see
[smoke/README.md](./smoke/README.md) for what it needs and what it holds the
extension to. It reads three HelmReleases (one upgraded, one whose upgrade
failed in a hook, one that never installed), runs `reconcile`, `suspend`,
`resume` and `reset` on their working paths, and spends about half its checks on
what must be refused.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari;
the original work, `@ginger_pappa/flux`, is copyright 2026 ginger_pappa under
the MIT License, whose notice LICENSE.md keeps.
