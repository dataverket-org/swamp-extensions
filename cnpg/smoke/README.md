# Live suite

What the unit tests cannot say: that the fields read are the ones a real
CloudNativePG operator writes, that a failover looks the way the summary assumes
while it happens, that the operator's webhook and RBAC refuse what `create` must
not get past, and that nothing secret reaches a swamp repository. It runs every
method through swamp against a throwaway cluster and spends most of its effort
on what should _not_ happen.

Pinned: CloudNativePG 1.30.1, cert-manager 1.21.3 (the plugin needs it), Barman
Cloud plugin 0.15.1, versitygw 1.8.0 as the S3 target. `setup.sh` checks each
release manifest against its SHA-256.

## Environment

The suite was run on 2026-11-10 on Linux x86_64 with rootless Podman and a kind
cluster made with kind's Podman provider. That is the tested environment.

| Needs                                            | Run with                    |
| ------------------------------------------------ | --------------------------- |
| `podman`                                         | 4.9.3, rootless             |
| `kind`                                           | 0.33.0                      |
| `kubectl`                                        | 1.37                        |
| `swamp`                                          | 20261110                    |
| `jq`                                             | 1.8                         |
| `bash`, `curl`, `openssl`, `sha256sum`, `base64` | what the distribution ships |

- The cluster is made with
  `KIND_EXPERIMENTAL_PROVIDER=podman kind create cluster --name <n> --kubeconfig <file>`.
  kind calls its Podman provider experimental.
- Every script takes that kubeconfig file from `SMOKE_KUBECONFIG` and nothing
  else, and `setup.sh` and every batch refuse to run when the current context of
  that file is not a `kind-*` cluster. No script makes or deletes the cluster,
  and none reads or writes your default kubeconfig.
- Rootless Podman gives a kind cluster no LoadBalancer address and no port
  below 1024. This suite needs neither: the S3 gateway is a ClusterIP Service on
  port 7070 and only pods talk to it, and `kubectl` reaches the API server on
  the port kind publishes on 127.0.0.1. No case is unhealthy because of
  rootless; the Clusters that do not archive or whose backups fail are made so
  on purpose.
- `setup.sh operator` downloads three release manifests, and the cluster pulls
  the operator, plugin, cert-manager, PostgreSQL and gateway images, so the
  first run needs network access.
- Measured on the kind node container while the suite ran, with
  `podman stats --no-stream`, 51 samples: at most 1.5 GB of memory, with five
  Clusters of seven PostgreSQL instances in all, and about 0.3 of one CPU core
  as the average since the container started (that is what a single sample of
  `podman stats` reports; no peak was measured). The `swamp` and `kubectl`
  processes run outside that container and are not in these numbers.
- macOS was not run. Run on Linux x86_64; macOS on Apple silicon is expected to
  work with a Podman machine of at least 2 CPUs and 4 GiB, not yet run there.
  Docker as the kind provider probably works and is not tested.

## Run it

Never against a cluster you care about: `setup.sh` installs an operator and
`failover.sh` deletes a primary pod. Every script takes the cluster from
`SMOKE_KUBECONFIG` alone and never from your current context.

```sh
# 1. a throwaway cluster with its own kubeconfig file
export SMOKE_KUBECONFIG=$(mktemp -d)/kubeconfig
KIND_EXPERIMENTAL_PROVIDER=podman kind create cluster --name cnpg-smoke \
  --kubeconfig "$SMOKE_KUBECONFIG" --wait 90s

# 2. a swamp repository loading this extension from source, and the models
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none && swamp extension source add "$OLDPWD/..")
./models.sh

# 3. before the operator exists: every method names the missing resource type
./nocrd.sh

# 4. the operator, the plugin, the S3 gateway, five Clusters, four accounts
./setup.sh operator && ./setup.sh fixtures && ./setup.sh wait && ./setup.sh readers

# 5. the suite
./read.sh && ./backup.sh && ./failover.sh && ./negative.sh

# 6. states made on purpose; they change three Clusters for good
./setup.sh snapshots && ./states.sh

# 7. last, because of what it can do to the operator (see below)
./limit.sh && ./limit.sh after

# 8. and away
KIND_EXPERIMENTAL_PROVIDER=podman kind delete cluster --name cnpg-smoke \
  --kubeconfig "$SMOKE_KUBECONFIG"
```

`./setup.sh nocrd` takes the operator and its CRDs away again, to run `nocrd.sh`
on a cluster that had them. No step waits longer than 180 seconds;
`setup.sh wait` asks to be run again when the Clusters need longer.

## The Clusters

| Cluster    | Instances | Backups                                             | What it is for                                                 |
| ---------- | --------- | --------------------------------------------------- | -------------------------------------------------------------- |
| `one`      | 1         | in-tree `barmanObjectStore`                         | On-demand Backups, the recovery window in the Cluster status   |
| `three`    | 3         | Barman Cloud plugin and an `ObjectStore`            | The failover, plugin Backups, the window on the ObjectStore    |
| `nobackup` | 1         | none                                                | `create` refused; `ContinuousArchiving` True yet not archiving |
| `bad`      | 1         | a bucket that does not exist, a key nobody knows    | A healthy Cluster that does not archive, with the reason       |
| `failing`  | 1         | a good store, a backup command with an unknown flag | A Backup that fails at once                                    |

The S3 keys are made by `setup.sh` into `.work/`, mode 0600, and reach the
cluster as Secrets. Nothing prints them, and `negative.sh` ends by searching the
swamp repository for every key and token the suite made.

`read.sh` adds four ScheduledBackups: `nightly` (plugin, owns its Backups),
`plain` (in-tree, label only), `paused` (suspended) and `doomed` (of `failing`,
so its first Backup fails). `setup.sh readers` makes four kubeconfig files: an
account that may read, one that may do nothing, one with a token the cluster
does not know, and one that points at a port nothing listens on.

`setup.sh snapshots` adds the three VolumeSnapshot CRDs of external-snapshotter
8.2.0, checked against their SHA-256, and restarts the operator, which looks for
them when it starts. Nothing that takes snapshots is installed, and `states.sh`
gives `nobackup` a snapshot class that does not exist.

## What was sent to a real API server

| Argument of `create`             | Sent | What happened                                                                                                                        |
| -------------------------------- | ---- | ------------------------------------------------------------------------------------------------------------------------------------ |
| method `barmanObjectStore`       | yes  | Backups completed, and one failed on purpose                                                                                         |
| method `plugin`                  | yes  | Backups completed                                                                                                                    |
| `target`                         | yes  | `primary`, with the plugin: the Backup ran on the primary                                                                            |
| `pluginConfiguration.parameters` | yes  | One parameter the plugin does not know: accepted, stored in the Backup, the Backup completed                                         |
| method `volumeSnapshot`          | yes  | Accepted once the VolumeSnapshot CRDs exist, refused by the operator's webhook before; stayed `started`                              |
| `online`, `onlineConfiguration`  | yes  | With `volumeSnapshot`: accepted, `waitForArchive: true` stored beside what was sent. With the in-tree method: refused by the webhook |
| `online: false` (a cold backup)  | no   | Only as a request that is refused before anything is sent, because the name is taken                                                 |

No `volumeSnapshot` Backup was completed anywhere: `snapshots` in a Backup
record and `backup.volumeSnapshot` in a Cluster record are covered by unit tests
only.

## Run logs

No run log is kept in the repository. Each batch prints one line per check and a
count, and keeps only its last command's output in `.work/`. The counts of the
last full run of 2026-11-10: `nocrd.sh` 5, `read.sh` 16, `backup.sh` 25,
`failover.sh` 6, `negative.sh` 76, `states.sh` 13, `limit.sh` 4 and one more in
`limit.sh after`, 146 in all, none failed. After a later change to how plugin
parameters and a hibernation are judged, `backup.sh` (now 27) and `states.sh`
(now 14) were run again on a fresh cluster, none failed; the other batches were
not run again.

## What each batch is for

| Batch         | What it checks                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                   |
| ------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `nocrd.sh`    | A cluster without the CRDs: five named refusals that say what to look at                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                         |
| `read.sh`     | Five Clusters healthy or not archiving, each for the right reason; the inventory of every namespace and of one, with the one Cluster whose archive is failing; four schedules with their newest Backup, by owner and by label; the inventory that names the suspended schedule and the one whose Backup failed; the inventory of Backups                                                                                                                                                                                                                                                         |
| `backup.sh`   | A Backup completed with the in-tree method and with the plugin (no `volumeSnapshot` Backup completes in this suite), created twice, refused under a taken name, failed and recorded, refused for four Clusters that cannot take it; plugin parameters sent, stored in the Backup, the identical create again accepted (and recorded as found, not made), and no parameters, one more, or another value refused; online settings with the in-tree method refused by the operator; no inventory for the Backups of one Cluster; the failed Backup named in the inventory with the operator's error |
| `failover.sh` | The primary pod deleted and the Clusters listed every second: not healthy, not ready, primary changing, each time named in the inventory with a reason, then healthy on a new primary and timeline                                                                                                                                                                                                                                                                                                                                                                                               |
| `negative.sh` | Missing objects and namespaces, an empty inventory for a namespace that does not exist, ten names shaped as injection in five places each, an account that may read but not create, one that may do nothing, a token the cluster does not accept, a port nothing listens on (one line, no client log lines), a context and a kubeconfig that do not exist, and no secret in the repository                                                                                                                                                                                                       |
| `states.sh`   | A `volumeSnapshot` Backup with `online` and `onlineConfiguration`, accepted by the API server, which stores a default beside what was sent; the identical create again accepted, a different one refused. The only instance of a Cluster fenced: fenced, not healthy, not archiving, named in the inventory; healthy again with the annotation gone. A Cluster hibernated: hibernated, not healthy, not archiving, counted as healthy in the inventory; on the way there the inventory says hibernated only once the operator's condition is True                                                |
| `limit.sh`    | `create` with the longest wait on a Backup that does not end: recorded as it stands, after the whole wait, in less than 180 seconds; healthy in the inventory with the default hour, named with its age by a definition that allows a minute. `limit.sh after` notes what the operator does with the next Backup, and checks that an unfinished one is named after a minute                                                                                                                                                                                                                      |

## Seen while writing it

- A Backup of a Cluster whose WAL archive has never worked (`bad`) does not
  fail. It stays `running` while the instance waits for the archive, so `create`
  records it with `finished: false`. Seen once on CloudNativePG 1.30.1 and not
  looked into further: while that Backup waited, and after it was deleted, new
  Backups of two other Clusters got no phase for three minutes, until the
  operator was restarted. The suite therefore takes no Backup of `bad` until its
  last batch, `limit.sh`.
- Seen again on 2026-11-10 with CloudNativePG 1.30.1, in `limit.sh`, and again
  not looked into. The Backup `smoke-long` of `bad` was created at 11:17:40 UTC
  (the operator logged "Starting backup") and stayed `running` for the whole
  wait of 120 seconds. At 11:19:50 it was deleted and a Backup of `one`,
  `smoke-after`, was created. The operator logged its two webhook lines for
  `smoke-after` ("Defaulting for Backup", "Validation for Backup upon creation")
  and nothing after them. `smoke-after` had no phase after 92 seconds and still
  none at 11:22:14, 2 minutes 24 seconds after it was created, when the cluster
  was deleted. In that time the operator pod had not restarted and all five
  Clusters were reported healthy. Before `smoke-long`, in the same run, seven
  Backups of `one`, `three` and `failing` had each got a phase within seconds.
- Seen a third time on 2026-11-10, in the next run of the suite, in the same
  shape: `smoke-long` was created at 12:01:31 UTC and stayed `running`; deleted
  at 12:03:41, when `smoke-after` was created; the operator logged the two
  webhook lines for `smoke-after` and nothing more, and it had no phase 92
  seconds later. A `volumeSnapshot` Backup that sat in `started` since four
  minutes before had not kept `smoke-long` from starting. The inventory of the
  definition with `unfinishedAfterSeconds=60` named `smoke-after` as "without a
  phase", which is what that limit is for.
- Right after `cnpg.io/hibernation=on` the condition `cnpg.io/hibernation` was
  False with the reason `WaitingPodsDeletion`; with the pods gone it was True
  with `Hibernated`.
- Hibernated, a Cluster keeps the phase `Cluster in healthy state` and `Ready`
  and `ContinuousArchiving` at True; `readyInstances` leaves its status. Just
  fenced, a one-instance Cluster still shows the healthy phase, one ready
  instance and `ContinuousArchiving` True. Only the annotations say it.
- `online` and `onlineConfiguration` are refused by the operator's webhook for
  any method but `volumeSnapshot`, and `volumeSnapshot` is refused while the
  cluster has no VolumeSnapshot CRD.
- With a kubeconfig that names no user, kubectl asks for a user name instead of
  connecting. The runner gives kubectl no standard input, so it ends at once
  with `error: EOF`. A kubeconfig for a negative case needs a user.
- The operator reads a changed Secret only when the Secret has the label
  `cnpg.io/reload`. Swapping a key under a running Cluster is not a way to make
  a Backup fail; an unknown option to the backup command is.
- With `backupOwnerReference: none` a Backup has no owner reference at all. The
  label `cnpg.io/scheduled-backup` is what ties it to its schedule.
