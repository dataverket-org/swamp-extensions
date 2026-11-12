# @dataverket/kind

One named [kind](https://kind.sigs.k8s.io) cluster, created on demand for
end-to-end tests. One model type, `@dataverket/kind/cluster`.

- `ensure` creates the cluster from `configPath` when `kind get clusters` does
  not list it, checks that its API server answers, applies `manifests` with
  `kubectl apply -f`, and records the cluster.
- `get` records whether the cluster exists, without creating it. When the
  cluster exists but its address cannot be read from the kubeconfig, the record
  says `exists: true` with an empty `apiServer` and the reason in `error`.
- `delete` deletes the cluster, and succeeds when it is already gone. swamp then
  marks the `cluster` record deleted, and refuses `get` until `ensure` has run
  again.

| Argument        | Default   |                                                               |
| --------------- | --------- | ------------------------------------------------------------- |
| `clusterName`   |           | kind cluster name                                             |
| `configPath`    |           | kind config, absolute or relative to the repo                 |
| `manifests`     | `[]`      | applied after the cluster is up, in order                     |
| `waitTimeout`   | `120s`    | how long kind waits for the control plane; forms below        |
| `kubeconfig`    |           | kubeconfig file to write and read, instead of the default one |
| `kindBinary`    | `kind`    |                                                               |
| `kubectlBinary` | `kubectl` |                                                               |

The `cluster` record carries `context` (`kind-<clusterName>`) and `apiServer`,
and `kubeconfig` (an absolute path) when the argument is set, for other models
to reference:

```yaml
context: ${{ data.latest("e2e", "cluster").attributes.context }}
kubeconfig: ${{ data.latest("e2e", "cluster").attributes.kubeconfig }}
```

`waitTimeout` is `0`, or one or more parts of digits, an optional `.` and more
digits, and a unit of `ns`, `us`, `µs`, `ms`, `s`, `m` or `h`: `90s`, `2m`,
`1m30s`, `1.5m`. That is less than Go reads: a sign (`+5s`), a number that
starts with a dot (`.5s`) and the Greek letter mu are refused. The longest wait
is 596 hours.

## When an apply fails

`ensure` applies the manifests in order and stops at the first that fails. The
cluster stays, and so does everything applied before. Before the run fails it
writes a record that says so: `exists: true`, `created` as it was in this run,
`manifestsApplied` with only the manifests before the failed one,
`manifestFailed` with the one that failed and `error` with kubectl's sentence.
`apiServer` is empty in that record when the address could not be read either.
So a workflow that reads the record must test `manifestFailed` or `error`, and
not only `exists`.

A later successful `ensure` writes a record without those two fields. A run that
fails earlier, at `kind create cluster` or at the readiness check, writes no
record, and neither does a run that is cancelled, also during an apply.

## Use

One behavior per cluster, named after it, with the kind config and the manifests
as paths in the repository:

```yaml
# e2e
globalArguments:
  clusterName: e2e
  configPath: test/kind.yaml
  kubeconfig: tmp/e2e.kubeconfig
  manifests:
    - test/namespace.yaml
    - test/fixtures.yaml
```

```sh
swamp behavior run e2e ensure   # creates the cluster when missing, applies the manifests
swamp behavior run e2e get      # records whether it exists
swamp behavior run e2e delete   # succeeds when it is already gone
```

### A kubeconfig of its own

Without `kubeconfig`, kind adds the context `kind-<clusterName>` to the default
kubeconfig (`KUBECONFIG` or `~/.kube/config`) and makes it the current context,
and `delete` removes it there. With `kubeconfig`, kind is given
`--kubeconfig <file>` on create and delete, every kubectl call reads that file,
and the default kubeconfig is not touched. The directory of the file must exist:
kind would make it, and a mistyped path would only be noticed after the cluster
is up, so `ensure` refuses it before anything is created or written.

The file named in `kubeconfig` is this type's own, so `ensure` repairs it. When
the cluster exists but the file is gone, does not hold the context, holds the
certificate of an earlier cluster of the same name, or holds credentials the
cluster does not accept, `ensure` runs
`kind export kubeconfig --name <clusterName> --kubeconfig <file>` once and
carries on. kind reads the entry out of the node container, so the export fails
when that container is stopped; the error then names the command that starts it,
followed by kind's own error. Without the argument nothing is exported into the
default kubeconfig: the run fails and the error names the command to run. `get`
never writes a kubeconfig.

`delete` runs `kind delete cluster` when kind lists the cluster. What it does
for a cluster kind does not list depends on the argument:

- With `kubeconfig`, `kind delete cluster` is run all the same. kind then
  removes what is left of the cluster in that file (the cluster, context and
  user named `kind-<clusterName>`) and leaves a file with no such entry as it
  is. The directory of the file must exist, as for `ensure`, and is checked
  before kind is run at all.
- Without it, nothing is run and the default kubeconfig is not touched, as in
  2026.10.29.1. kind only lists the clusters of the provider it is using, so a
  `delete` run under another provider would otherwise take the entry of a live
  cluster out of the default kubeconfig.

kind locks a kubeconfig with a file `<file>.lock` beside it while it writes. A
kind that was killed can leave that file behind. `delete` then fails with
`failed to lock config file: ... file exists`, and so will any other kind
command that writes the file. When no kind is running, remove `<file>.lock` and
run the method again.

### Docker, Podman or nerdctl

kind chooses its node provider itself: the environment variable
`KIND_EXPERIMENTAL_PROVIDER` (`docker`, `podman`, `nerdctl`, or `finch` or
`nerdctl.lima` for nerdctl under that name) when it is set, else the first of
Docker, nerdctl and Podman it finds. This type has no argument for it. Every
command it runs inherits the environment swamp was started with, unchanged, so
the provider is chosen there:

```sh
KIND_EXPERIMENTAL_PROVIDER=podman swamp behavior run e2e ensure
```

Set it the same way for `get` and `delete`, or export it once in the shell: kind
only lists the clusters of the provider it is using. kind calls its Podman and
nerdctl providers experimental.

When the cluster exists but its API server does not answer, `ensure` fails, and
its hint names the command for the provider in use, for example
`podman start e2e-control-plane`. The provider is found as kind finds it: the
variable, else `docker -v`, `nerdctl -v` and `podman -v` are asked in that
order, and a tool that cannot be run counts as not there.

## Commands

The model runs `kind get clusters`, `kind create cluster`,
`kind delete cluster`, `kind export kubeconfig`, `kubectl config view`,
`kubectl get --raw /readyz` and `kubectl apply -f` as subprocesses in the
repository root, with arguments as argv arrays, never through a shell. Only for
the hint about a stopped node container, and only when
`KIND_EXPERIMENTAL_PROVIDER` names no provider, it also runs `docker -v`,
`nerdctl -v` and `podman -v`.

Two pre-flight checks run a binary of the definition from the repository root,
as the methods do. swamp runs checks before `ensure` and `delete`, and none
before `get`, which is a read:

| Check                   | Runs                       | Before             |
| ----------------------- | -------------------------- | ------------------ |
| `kind-cli-available`    | `kind version`             | `ensure`, `delete` |
| `kubectl-cli-available` | `kubectl version --client` | `ensure`           |

`delete` never runs kubectl and works without it. `get` needs kind, and kubectl
only to read the address of a cluster that exists.

Every command has a time limit, and is stopped at it or when the run is
cancelled:

| Command                          | Limit                                            |
| -------------------------------- | ------------------------------------------------ |
| `kind create cluster`            | `waitTimeout` plus 300 seconds                   |
| `kind delete cluster`            | 120 seconds                                      |
| `kind get clusters`              | 60 seconds                                       |
| `kind export kubeconfig`         | 60 seconds                                       |
| `kubectl apply -f`, per manifest | `--request-timeout=300s`, stopped at 305 seconds |
| each other `kubectl` call        | `--request-timeout=30s`, stopped at 35 seconds   |
| each `-v` of a container tool    | 10 seconds                                       |

An apply gets 300 seconds because a manifest with many objects or large CRDs can
take longer than a read, and an apply cut off part-way leaves a half-applied
set.

The 300 seconds of `kind create cluster` are for what kind does before it starts
counting `--wait`: the pull of the node image on a machine that has not got it,
the start of the node container and `kubeadm init`. A `kind create cluster` that
is stopped at its limit can leave part of a cluster; the error says to run
`delete` first.

A kubectl time limit covers everything that kubectl process does, also a
credential plugin that the kubeconfig tells it to run (`exec`): a plugin that
waits for a person is stopped with kubectl.

What reaches an error from kind or kubectl is one bounded line, with anything
shaped like a credential blanked and kind's progress lines dropped.

## Changes in 2026.11.10.1

Definitions made with 2026.10.29.1 work unchanged, and the data name `cluster`
and every record field are as before. What a user can notice:

- New: the `kubeconfig` argument and the `kubeconfig` record field, both absent
  unless set. With the argument, `ensure` writes a missing or stale entry of
  that file itself with `kind export kubeconfig`. `ensure` and `delete` refuse a
  `kubeconfig` whose directory does not exist.
- New: the hint for a stopped node container names `docker`, `podman` or
  `nerdctl` as kind would choose; before it always said `docker`. To choose,
  `docker -v`, `nerdctl -v` and `podman -v` may now be run, when
  `KIND_EXPERIMENTAL_PROVIDER` names no provider.
- A `clusterName` that is not a lowercase DNS name (letters, digits, `-` and
  `.`, starting and ending with a letter or digit) is refused before kind runs.
  kind itself accepts a name that starts or ends with `-` or `.`; this type no
  longer does.
- A `configPath`, `kubeconfig` or manifest that is empty, starts with `-` or
  holds a line break is refused; write `./-file` for a file whose name starts
  with `-`. A `waitTimeout` that is not in the form described above, or longer
  than 596 hours, is refused before kind runs.
- Every command has the time limit in the table above; before there was none.
  One `kubectl apply -f` of a manifest must now finish within 305 seconds.
- `ensure` whose apply fails now writes a record before it fails, with the new
  fields `manifestFailed` and `error`; before, the record of the run before
  stayed the latest.
- `get` of a cluster that exists but whose address cannot be read (no context in
  the kubeconfig, no kubectl) now records `exists: true` with `error`; before,
  it failed and recorded nothing.
- `delete` with the new `kubeconfig` argument runs `kind delete cluster` also
  for a cluster that kind does not list, so a stale entry leaves that file.
  Without the argument `delete` is as before: `kind delete cluster` only runs
  when kind lists the cluster, and the default kubeconfig is not touched for a
  cluster that is gone.
- Error texts changed form. `kind <args> exited N: <stderr>` is now
  `kind <args> failed (exit N): <stderr>`, and a kubectl failure reads
  `kubectl <args> failed: <stderr>` without the `--context` flag. The message
  for an API server that does not answer keeps its first part and ends with the
  kubectl failure. A cluster whose API server answers the readiness check with a
  refusal, whose certificate the kubeconfig does not trust, or whose context is
  missing from the kubeconfig, now gets a message of its own that names
  `kind export kubeconfig`, and not the stopped container hint.
- New pre-flight checks: before `ensure`, `kind version` and
  `kubectl version --client` must run; before `delete`, `kind version`. `delete`
  needs no kubectl, and `get` none for a cluster that does not exist, as before.
- A missing `kind` binary is reported as
  `<kindBinary> was not found; install kind, or set the kindBinary argument to where it is`.
- Each method logs one line before its first command and one when it is done.

## Testing

`deno task test` runs the unit tests. Each method, `ensure`, `get` and `delete`,
runs its `execute` through `createModelTestContext` from
`@swamp-club/swamp-testing` with a stub of the `kind` and `kubectl` commands,
and is tested for a success and a failure: the record it writes (created or
found, the context and API server address, the manifests applied, the manifest
that failed and why), its last log line, the commands it runs and the ones it
must not, and the refusal of a kubeconfig whose directory is missing. The
duration reader, the progress filter and the shell quoting are tested on their
own. The stub answers only the commands a test names; it is not a model of kind
or of a cluster. The live suite in `smoke/` was run with rootless Podman and
kind with the Podman provider: it creates a cluster through `ensure`, runs
`ensure` again, reads it, loses its kubeconfig, stops and starts its node
container, deletes it twice, and runs the refusals.
[smoke/README.md](./smoke/README.md) in the source repository says what it needs
and how to run it. Docker and nerdctl were not run, and the mode without the
`kubeconfig` argument is not covered by any test, because a live run of it
writes to the default kubeconfig.

## As a workload issuer for Salmon

To exchange this cluster's ServiceAccount tokens at a Salmon from
`@dataverket/salmon`, which runs in a container, name the issuer after the
control-plane container in the kind config, as that package's README shows.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Linus Johansen.
