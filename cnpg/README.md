# @dataverket/cnpg

[CloudNativePG](https://cloudnative-pg.io/) for swamp: PostgreSQL Clusters,
ScheduledBackups and Backups (`postgresql.cnpg.io/v1`) as swamp data, read with
plain `kubectl`, and an on-demand Backup you can wait for.

| Type                               | Methods                 | Records                                                                                                                             |
| ---------------------------------- | ----------------------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `@dataverket/cnpg/cluster`         | `list`, `get`           | `cluster`: phase, instances, primary, image, storage, conditions, WAL archiving, backup configuration by reference, and a `summary` |
| `@dataverket/cnpg/scheduledbackup` | `list`, `get`           | `scheduledbackup`: schedule, suspension, last and next time, and the newest Backup the schedule made, with its result               |
| `@dataverket/cnpg/backup`          | `list`, `get`, `create` | `backup`: phase, method, times, WAL and LSN range, id, destination, instance, error                                                 |

Every record is named `<namespace>--<name>`, for example `pg--main`. Each `list`
also writes one `inventory` record, named `inventory_all` when it read every
namespace and `inventory_ns_<namespace>` when it read one: what the list saw,
and one line for each object that is not healthy.

A Cluster that is failing over, a schedule whose last Backup failed and a Backup
that failed are all records that say so. A method fails only when the call
itself could not be made: the object does not exist, the account may not read
it, the API server did not answer, or the CloudNativePG CRDs are not installed.
So a workflow can read many objects and then assert on what it found.

Every call to the cluster asks for an answer within 30 seconds, and a `kubectl`
that still runs after 35 seconds is stopped. A failed call is one line that says
which failure it is: the object was not found, the request is forbidden, the
cluster did not accept the credentials, the cluster could not be reached, there
was no answer in time, or the cluster does not serve the resource type because
its CRDs are not installed. A cancelled run stops the `kubectl` it is waiting
for and ends as cancelled.

## Prerequisites

- `kubectl` on the `PATH` of the machine that runs swamp. The `kubectl cnpg`
  plugin is not needed.
- An account that may `get` and `list` `clusters`, `backups` and
  `scheduledbackups` in `postgresql.cnpg.io`, and `create` `backups` for the
  `create` method. To read the recovery window of a Cluster that uses the Barman
  Cloud plugin it also needs `get` and `list` on `objectstores` in
  `barmancloud.cnpg.io`; without it the Cluster is still recorded.
- Tested against CloudNativePG 1.30.1 and the Barman Cloud plugin 0.15.1.

No credential is read or stored. A Cluster record holds where backups go (the
destination path, the endpoint, the ObjectStore's name, the retention policy)
and never the Secret names or keys that open the store. Of a plugin's parameters
on a Cluster, the names are stored and two values, on purpose:
`barmanObjectName` and `serverName`, which say where the backups go. No other
parameter value is stored. A user and password inside a URL are removed before
the URL is stored, and free text the operator or a plugin wrote (`phaseReason`,
a plugin's `status`, a condition's message, a Backup's `error`) is stored on one
bounded line with what is shaped like a credential blanked.

The `pluginConfiguration.parameters` you give to `create` are different: they
are written into the Backup object as they are, and swamp keeps the arguments of
a run. Never put a secret there. On the create call itself, a parameter value of
8 characters or more is blanked word for word in an error message; a shorter one
is only caught when it looks like a credential.

## Definitions

```sh
# every namespace
swamp model create @dataverket/cnpg/cluster pg-clusters \
  --global-arg context=my-cluster

# one namespace
swamp model create @dataverket/cnpg/backup pg-backups \
  --global-arg context=my-cluster --global-arg namespace=pg
swamp model create @dataverket/cnpg/scheduledbackup pg-schedules \
  --global-arg context=my-cluster --global-arg namespace=pg

swamp model method run pg-clusters list
swamp model method run pg-schedules get --input name=nightly
```

| Global argument          | Default             |                                                                                                                                          |
| ------------------------ | ------------------- | ---------------------------------------------------------------------------------------------------------------------------------------- |
| `namespace`              | `""`                | The namespace. Empty means every namespace for `list`; other methods need one                                                            |
| `kubeconfig`             | kubectl's default   | Path to a kubeconfig file                                                                                                                |
| `context`                | the current context | The kubeconfig context                                                                                                                   |
| `unfinishedAfterSeconds` | `3600`              | `backup` and `scheduledbackup` only: after how long a Backup that has neither completed nor failed counts as not healthy in an inventory |

`list` takes `namespace` to read another namespace than the definition's. `get`
and `create` take `name` and, when the definition has no namespace, `namespace`.
A `namespace` argument that is left out or empty means the definition's
namespace, so a definition with a namespace cannot list every namespace: make a
second definition without one. A list in a namespace that does not exist records
an empty inventory and nothing else, as `kubectl get` finds nothing there.

## The inventory of a list

Records of objects that no longer exist stay in the data store. The inventory is
the record that says which objects one `list` saw, and which of them need a
look:

| Field                                     | Meaning                                                          |
| ----------------------------------------- | ---------------------------------------------------------------- |
| `namespace`                               | The namespace listed, `null` for every namespace                 |
| `count`, `healthyCount`, `unhealthyCount` | How many objects the list saw                                    |
| `items`                                   | Per object: `namespace`, `name`, `dataName`, `healthy`, `reason` |
| `observedAt`                              | When the list was read                                           |

`reason` is one line of at most 200 characters, `null` for a healthy object.

| Type              | Not healthy when                                                                                                                                              | Also per item                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------- | -------------------------------------------------------------------------------- |
| `cluster`         | `summary.healthy` is false and it is not hibernated; the reason names a fence, the phase, the instances, the primary and `Ready`                              | `archiveFailing`: something should archive WAL and is not doing so; `hibernated` |
| `scheduledbackup` | It is suspended, the operator reports an error on it, the newest Backup it made failed, or that Backup has not ended for longer than `unfinishedAfterSeconds` |                                                                                  |
| `backup`          | It failed (the reason is the operator's error), or it has not ended for longer than `unfinishedAfterSeconds` (the reason says its phase and its age)          | `phase`                                                                          |

A Backup that runs for ever, or that the operator never gives a phase, says
nothing else about itself: its age is the only sign. The default of an hour is a
guess at what a base backup should not exceed; set `unfinishedAfterSeconds` on
the definition above the time your longest backup takes. The age is in the
records too: `unfinishedSeconds` on a Backup and `lastBackupUnfinishedSeconds`
on a ScheduledBackup, `null` once the Backup has ended. The age is the clock of
the machine that runs swamp minus the `creationTimestamp` the API server wrote,
so a limit of a minute or two is sensitive to a clock that is off; an hour is
not.

A Cluster that is hibernated on purpose counts as healthy in the inventory, with
`hibernated: true` and no reason, once the operator has acted on it and when it
is not fenced as well. So `healthyCount == count` does not mean that every
database serves: test `hibernated` on the items too when that is what you need
to know. A fenced Cluster is not healthy.

A schedule that has made no Backup yet is healthy. `list` of the `backup` type
with `cluster` set writes no inventory, because it did not look at the whole
namespace.

```yaml
- name: nothing-needs-a-look
  task:
    type: assert
    expr: >-
      data.latest("pg-clusters", "inventory_all").attributes.unhealthyCount == 0
      && data.latest("pg-schedules", "inventory_ns_pg").attributes.unhealthyCount == 0
    message: a Cluster or a schedule needs a look; read the items of the inventory
```

When two objects of one list would be stored under the same data name (`b--c` in
namespace `a` and `c` in namespace `a--b`), the list fails and writes nothing.
List one namespace at a time then.

## The Cluster record

| Field                                       | Meaning                                                                                                       |
| ------------------------------------------- | ------------------------------------------------------------------------------------------------------------- |
| `phase`, `phaseReason`                      | The operator's phase text, `Cluster in healthy state` when there is nothing to do                             |
| `fenced`, `fencedInstances`                 | From the annotation `cnpg.io/fencedInstances`: the instances whose PostgreSQL is stopped, `*` for all         |
| `hibernated`                                | The annotation `cnpg.io/hibernation` is `on`: the pods are gone and the volumes kept                          |
| `hibernationReached`                        | The operator has acted on it: the condition `cnpg.io/hibernation` is True                                     |
| `volumeSnapshotTimes`                       | The snapshot times of the Cluster's status, beside `archive`                                                  |
| `instances`, `readyInstances`               | Instances wanted and instances ready                                                                          |
| `currentPrimary`, `targetPrimary`           | They differ during a switchover or failover, and before the first primary is up                               |
| `instanceNames`, `instanceStates`           | Per instance: `status` (the operator's group, such as `healthy` or `failed`), `isPrimary`, `timelineId`       |
| `image`, `postgresMajor`, `postgresVersion` | The image the instances run; the major version of the data directory; the version read from the image tag     |
| `storageSize`, `walStorageSize`             | With `storageClass` and `walStorageClass`; the WAL fields are `null` when WAL shares the data volume          |
| `conditions`                                | Every condition, `Ready`, `ContinuousArchiving` and `LastBackupSucceeded` among them, with reason and message |
| `archive`                                   | `firstRecoverabilityPoint`, `lastSuccessfulBackup`, `lastFailedBackup` and the `source` they were read from   |
| `backup`                                    | `configured`, `methods`, `walArchiver`, `retentionPolicy`, `barmanObjectStore`, `plugins`, `objectStore`      |
| `summary`                                   | Four booleans to assert on, below                                                                             |

| `summary` field   | True when                                                                                                                                                    |
| ----------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `healthy`         | The phase is the healthy one, `Ready` is True, every instance is ready, the primary is not changing, no instance is fenced and the Cluster is not hibernated |
| `archiving`       | Something archives WAL (`backup.walArchiver`), `ContinuousArchiving` is True, the Cluster is not hibernated and its primary is not fenced                    |
| `primaryChanging` | `currentPrimary` is not `targetPrimary`                                                                                                                      |
| `instancesReady`  | At least one instance is wanted and all wanted instances are ready                                                                                           |

`archiving` is not the condition alone: the operator sets `ContinuousArchiving`
to True also on a Cluster that archives nowhere.

Fencing and hibernation are read from the annotations because the rest of the
object does not say them. On CloudNativePG 1.30.1 a hibernated Cluster kept the
phase `Cluster in healthy state` and `Ready` and `ContinuousArchiving` at True
after its pods were gone, and a Cluster whose only instance had just been fenced
still showed the healthy phase and one ready instance. What this type makes of
them:

| State                              | `summary.healthy` | `summary.archiving`                                | In the inventory of `list`                                                                          |
| ---------------------------------- | ----------------- | -------------------------------------------------- | --------------------------------------------------------------------------------------------------- |
| Hibernated, the operator has acted | false             | false: nothing runs that could archive             | healthy, `hibernated: true`, no reason: it is on purpose                                            |
| Hibernation asked for, not reached | false             | false                                              | not healthy; the reason says the hibernation is not reached, and what the operator's condition says |
| Fenced                             | false             | false when the primary is fenced, or all instances | not healthy; the reason names the fenced instances                                                  |

`summary.healthy` means "runs with every instance, as asked", so it is false for
both. A fence is a state someone must end, so the inventory counts it, also on a
hibernated Cluster. "The operator has acted" is `hibernationReached` in the
record: the annotation is `on` and the condition `cnpg.io/hibernation` is True.
On 1.30.1 that condition was False with the reason `WaitingPodsDeletion` right
after the annotation was set, and True with `Hibernated` once the pods were
gone. An annotation `cnpg.io/fencedInstances` that is not a list of names is
taken to fence every instance; a list that holds anything but names is such a
value.

### Where the archive times come from

CloudNativePG 1.30 marks `status.firstRecoverabilityPoint`,
`status.lastSuccessfulBackup`, `status.lastFailedBackup` and the two `ByMethod`
maps as deprecated: they are set for the in-tree methods only and never for a
backup plugin. The in-tree `spec.backup.barmanObjectStore` itself is deprecated:
on 1.30.1 the API server answers a `kubectl apply` of such a Cluster with the
warning "Native support for Barman Cloud backups and recovery is deprecated and
will be completely removed in CloudNativePG 1.31.0."

With the Barman Cloud plugin the same three times are on the `ObjectStore`
object the plugin is pointed at, in `status.serverRecoveryWindow` under the
server name. This type reads both and says which one it used:

| `archive.source` | The times were read from                                                                       |
| ---------------- | ---------------------------------------------------------------------------------------------- |
| `clusterStatus`  | The Cluster's own status (in-tree `barmanObjectStore` or `volumeSnapshot`)                     |
| `objectStore`    | `status.serverRecoveryWindow` of the ObjectStore in `backup.objectStore`                       |
| `none`           | Neither holds a time: no backup yet, no backup configuration, or the ObjectStore is unreadable |

When an enabled plugin is the WAL archiver, only the ObjectStore is used. Times
left in the Cluster's status by an in-tree method it was moved away from are not
shown: the source is `objectStore`, or `none` with three `null` times when the
ObjectStore has no window or cannot be read. The Cluster's status is the source
only when no plugin archives WAL.

Snapshot backups are apart from that. `volumeSnapshotTimes` holds
`firstRecoverabilityPoint` and `lastSuccessfulBackup` for the `volumeSnapshot`
method, from `status.firstRecoverabilityPointByMethod` and
`status.lastSuccessfulBackupByMethod`, whatever `archive.source` is, so a
Cluster whose plugin archives WAL and that also takes snapshots shows both. The
1.30.1 CRD has no failed time per method, so there is none here.

What is not there is `null`. When the ObjectStore cannot be read,
`backup.objectStore.found` is `false` and `error` says why; the Cluster is
recorded all the same.

## The ScheduledBackup record

`schedule`, `suspend`, `immediate`, `backupOwnerReference`, `method`, `target`,
`cluster`, `lastScheduleTime`, `nextScheduleTime`, and:

| Field                         | Meaning                                                                                                     |
| ----------------------------- | ----------------------------------------------------------------------------------------------------------- |
| `lastBackup`                  | The newest Backup this schedule made, as a full Backup record, or `null`                                    |
| `lastBackupPhase`             | Its phase, or `null`                                                                                        |
| `lastBackupCompleted`         | `true` only when it completed; `false` when it failed, runs or is missing                                   |
| `lastBackupUnfinishedSeconds` | How long that Backup had existed without ending when it was read; `null` when it has ended or there is none |
| `backupCount`                 | How many Backups of this schedule still exist                                                               |

A Backup belongs to a schedule by the label `cnpg.io/scheduled-backup`, which
the operator sets on every Backup a schedule makes whatever
`backupOwnerReference` says, and otherwise by an owner reference to the
ScheduledBackup. The newest is the one created last.

## The Backup record and `create`

`phase`, `completed`, `failed`, `finished`, `error`, `method`, `target`,
`cluster`, `scheduledBackup`, `startedAt`, `stoppedAt`, `beginWal`, `endWal`,
`beginLSN`, `endLSN`, `backupId`, `backupName`, `destinationPath`,
`endpointURL`, `serverName`, `instance`, `majorVersion`, `timeline`,
`unfinishedSeconds`, `adopted`. A Backup taken by a plugin has no destination in
its status; read it from the Cluster record's `backup.objectStore`.

`get` of every type fails, and writes nothing, when the answer is not the object
that was asked for: another kind, another name or another namespace.

```sh
swamp model method run pg-backups create \
  --input name=before-upgrade --input cluster=main

# with the Barman Cloud plugin
swamp model method run pg-backups create \
  --input name=before-upgrade --input cluster=main --input method=plugin \
  --input 'pluginConfiguration={"name":"barman-cloud.cloudnative-pg.io"}'

# a long base backup: read the result later
swamp model method run pg-backups get --input name=before-upgrade
```

| Argument              | Default             |                                                                                                                                                 |
| --------------------- | ------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `name`                |                     | Name of the Backup object                                                                                                                       |
| `cluster`             |                     | The Cluster to back up                                                                                                                          |
| `method`              | `barmanObjectStore` | `barmanObjectStore`, `plugin` or `volumeSnapshot`                                                                                               |
| `target`              | the Cluster's       | `primary` or `prefer-standby`                                                                                                                   |
| `online`              | the Cluster's       | Online or cold backup. The operator refuses it for a method other than `volumeSnapshot`                                                         |
| `onlineConfiguration` |                     | `immediateCheckpoint`, `waitForArchive`; `volumeSnapshot` only, as `online`                                                                     |
| `pluginConfiguration` |                     | `name` and `parameters`; required for `plugin`. Never a secret: the parameters are stored in the Backup object and in the arguments swamp keeps |
| `waitSeconds`         | `60`                | How long to wait for the Backup to end, 0 to 120                                                                                                |
| `pollSeconds`         | `5`                 | How long to wait between two reads of it, 1 to 30                                                                                               |

`create` checks first and creates second:

1. The Cluster must exist and be configured for the method:
   `spec.backup.barmanObjectStore`, `spec.backup.volumeSnapshot`, or the named
   plugin listed and enabled in `spec.plugins`. Otherwise nothing is created and
   the method fails with the reason.
2. A Backup of that name that asks for the same thing is this request: nothing
   is created, and the existing Backup is waited for and recorded. So a re-run
   is safe. "The same" means every argument you set equals the existing object,
   field by field at any depth; a field you leave out is not compared, because
   the API server fills in defaults (it stores `waitForArchive: true` beside an
   `onlineConfiguration` that only sets `immediateCheckpoint`). A list must be
   equal as a whole, and so must `pluginConfiguration.parameters`: nothing fills
   in that map, and every entry changes what the plugin does, so a Backup with
   more parameters than you asked for, or with any when you asked for none, is a
   different request. A Backup of that name with a different request is refused.
3. The Backup is created, read every `pollSeconds` for at most `waitSeconds`,
   and recorded as it stands. `finished: false` means it still runs: run `get`
   later.

When the create is not confirmed, the Backup is read back once by name: the
answer could not be read or was not the Backup, `kubectl` was stopped at its
limit, another run made a Backup of that name in the meantime, or the failure
has no name. If the Backup is there with this request, the method carries on as
if it had created it, with a warning.

The record of `create` says whose Backup it is: `adopted` is `false` when this
run created it and saw the create confirmed, and `true` when the Backup was
found under that name with the same request, before the create or by the read
back, so it may be another caller's. `list` and `get` write `null`. If it is not
there, the method fails with the first error. A refusal that has a name
(forbidden, the CRDs are missing, the login was not accepted) fails at once.

The body of `create` never runs longer than 170 seconds. The pre-flight check
that swamp runs before a method (`kubectl version --client`, at most 20 seconds)
is outside that. The time the reads take counts as waited, so a slow cluster
does not stretch the wait. With the longest wait and a cluster that answers at
once, the method takes about 120 seconds. When the calls before the wait were
slow, the wait is cut short so that the limit still holds, and the log line says
how long was waited. A read that fails while waiting is a warning and the Backup
is recorded as last seen; only a cancelled run ends the method there.

A Backup that ends as `failed` is recorded with `failed: true` and the
operator's `error`; the method succeeds. Assert on the record:

```yaml
- name: backup-completed
  task:
    type: assert
    expr: >-
      data.latest("pg-backups", "pg--before-upgrade").attributes.completed
    message: >-
      backup: ${{ data.latest("pg-backups", "pg--before-upgrade").attributes.error }}
- name: database-fit
  task:
    type: assert
    expr: >-
      data.latest("pg-clusters", "pg--main").attributes.summary.healthy
      && data.latest("pg-clusters", "pg--main").attributes.summary.archiving
      && data.latest("pg-schedules", "pg--nightly").attributes.lastBackupCompleted
```

## What it does not do

- It does not change a Cluster: no switchover, restart, hibernation or scale.
- It does not delete Backups or create ScheduledBackups.
- It does not restore, and it does not look into the object store. What it
  records is what the operator and the plugin wrote on the objects.
- It does not enrich a plugin Backup with the ObjectStore's destination.

## Testing

`deno task test` runs the unit tests: the parsers and the request checks, and
every method of the three types, run through swamp's `createModelTestContext`
with a stub kubectl that answers only the commands each test names. They pin
what a method records, what it logs, and what it refuses: a list with its
inventory, a get, a create that sends the Backup on standard input, adopts one
with the same request and refuses a Cluster without the method's configuration,
and a refused or missing object that records nothing. `smoke/` holds the live
suite: the operator, the plugin, an S3 gateway and five Clusters on a throwaway
cluster, and every method run through swamp, with more refusals than successes.
A Backup was completed with the `barmanObjectStore` and the `plugin` method;
`volumeSnapshot` requests were accepted by the API server and never completed,
because nothing on that cluster takes snapshots. The live suite was run on a
kind cluster made with kind's Podman provider on rootless Podman;
[`smoke/README.md`](smoke/README.md) says what it needs and how to run it.
