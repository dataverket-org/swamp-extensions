# @dataverket/talosctl

Talos Linux machines for [swamp](https://github.com/swamp-club/swamp), through
`talosctl`, with or without Omni.

Forked from [`@magistr/talos-node`](https://github.com/umag/swamp-workspace)
(MIT, copyright magistr) and typed. The upstream methods are kept; `volumes`,
`etcdStatus`, `serviceLogs` and `processes` are added, `reset` learned to wipe
only named partitions, and every method takes `nodes` to address fewer machines
than the definition names.

## Model type

`@dataverket/talosctl/node` targets one or many machines.

| Method        | What it does                                                                                                   |
| ------------- | -------------------------------------------------------------------------------------------------------------- |
| `version`     | Talos version of every node (`version` resource per node)                                                      |
| `services`    | Every service on every node (`service` resource per node and service)                                          |
| `etcdMembers` | The etcd members, as the first control plane among the targets that answers sees them (`etcdMember` each)      |
| `etcdStatus`  | Every control plane's etcd: member, leader, raft index and term, database size, errors (`etcdStatus` each)     |
| `serviceLogs` | A service's newest log lines on every node, counted in a time window and against a pattern (`serviceLog` each) |
| `processes`   | The top processes of every node by CPU time or memory, executables only (`processes` each)                     |
| `kubeconfig`  | The admin kubeconfig (`kubeconfig`, sensitive)                                                                 |
| `volumes`     | Disks, partitions by label, unallocated space and EPHEMERAL usage of every node (`volume-<host>` each)         |
| `applyConfig` | `talosctl apply-config` with a mode; `insecure` for maintenance mode                                           |
| `patchConfig` | `talosctl patch machineconfig` with a patch file                                                               |
| `bootstrap`   | `talosctl bootstrap`, once, against the first control plane                                                    |
| `reboot`      | Reboot, optionally by power cycle                                                                              |
| `shutdown`    | Shut down, optionally forced                                                                                   |
| `reset`       | Wipe the system disk, or only the partitions named in `systemLabelsToWipe` (for example `EPHEMERAL`)           |
| `upgrade`     | `talosctl upgrade` to an installer image                                                                       |
| `health`      | The cluster health check with a wait timeout, from one control plane                                           |

### Targets

| Global argument         | Default      | Meaning                                                                                                                           |
| ----------------------- | ------------ | --------------------------------------------------------------------------------------------------------------------------------- |
| `endpoint`              | unset        | `--endpoints`; also the only node when `nodes` is unset. Leave unset with an Omni talosconfig                                     |
| `nodes`                 | `[endpoint]` | `--nodes`: the machines every method addresses                                                                                    |
| `talosconfig`           | unset        | Path to a talosconfig; unset means talosctl's own lookup                                                                          |
| `talosconfigContent`    | unset        | A talosconfig's content (sensitive); used via a private temp file, wins over `talosconfig`                                        |
| `talosContext`          | unset        | `--context`: the context in the talosconfig to use; unset means whichever context is current, which a definition does not control |
| `insecure`              | `false`      | `--insecure`, for machines in maintenance mode                                                                                    |
| `talosctlPath`          | `talosctl`   | Binary path when not on `PATH`                                                                                                    |
| `serviceAccountKeyFile` | unset        | Path to a file holding the Omni service-account key, read at call time, `~/` expanded; for a key an operator's session writes     |
| `serviceAccountKey`     | unset        | Omni service-account key as a value, for a key the process owns; supply via a vault expression. Mutually exclusive with the file  |
| `retryDelayMs`          | `15000`      | Pause between retries of transient API errors                                                                                     |

### Checks

| Check                  | Label    | What it proves                                                                                                                      |
| ---------------------- | -------- | ----------------------------------------------------------------------------------------------------------------------------------- |
| `talosctl-available`   | `live`   | The binary at `talosctlPath` runs and reports its client version                                                                    |
| `talosconfig-exists`   | `policy` | The file named by `talosconfig` exists, when one is named and no `talosconfigContent` overrides it                                  |
| `omni-key-readable`    | `policy` | The Omni key resolves as a method would: the file exists, is readable and is not empty, and the file and the value are not both set |
| `talos-context-exists` | `live`   | `talosContext` is one of the talosconfig's contexts; the failure names the contexts there are instead                               |

The last two answer the two ways a definition passes its binary check and still
cannot reach a machine: an operator's sitting expired without rewriting the key
file, and a context that is not in the config. Neither reads a node, and neither
puts a key's value in its output.

A plain cluster: set `endpoint` (or `nodes`) and `talosconfig`:

```sh
swamp model create @dataverket/talosctl/node lab
#   endpoint: 10.5.0.2
#   nodes: [10.5.0.2, 10.5.0.3]
#   talosconfig: ~/.talos/lab
swamp model method run lab volumes
```

An Omni-managed cluster: let `@dataverket/omni` mint the talosconfig and
discover the nodes, and wire both in through CEL; leave `endpoint` unset (with
an explicit `nodes` list no `--endpoints` is passed, so Omni's proxy is used)
and give the Omni key, as a file an operator's session wrote
(`serviceAccountKeyFile`) or as a vaulted value (`serviceAccountKey`), so
talosctl authenticates without a browser:

```yaml
globalArguments:
  nodes: ${{ data.latest("omni", "talosconfig-prod").attributes.nodes }}
  talosconfigContent: ${{ data.latest("omni", "talosconfig-prod").attributes.content }}
  serviceAccountKeyFile: ~/.talos/omni/reader.key
```

## Fewer nodes than the definition names

A definition names a whole cluster, and a method addresses all of it unless a
call says otherwise. Every method takes `nodes`, which must be a subset of the
definition's targets: an argument can shrink what a definition reaches, never
widen it. This is what makes lifecycle methods safe to use on a fleet
definition: `reboot` without `nodes` reboots every machine.

```sh
swamp model method run lab reboot --input 'nodes=["10.5.0.3"]'
swamp model method run lab etcdStatus
```

`etcdMembers`, `etcdStatus` and `health` only mean something on a control plane,
so they read each target's `machinetype` first and go only where it says
`controlplane`. Each node is asked on its own, so a worker in the list, or a
control plane that is rebooting, leaves the others' answers intact: an
`etcdStatus` for an unreachable control plane is written with
`reachable: false`. `health` runs from the first control plane, or from `node`.
Through Omni's proxy its etcd check needs more than a Reader identity; Omni
reports cluster health on its own.

## `serviceLogs`

`talosctl logs <service> --tail <n>` on every target, one call each; a node
where the service does not exist (etcd on a worker) is skipped. Lines are
counted inside `sinceSeconds`, by each line's own `ts` (RFC 3339 or epoch
milliseconds; a line without one is counted), and matched against `match`, a
regular expression. The record keeps the counts, the window's oldest and newest
times, and the newest `keep` matching lines. After a restart, a node that kept
running still holds its old lines, so ask for a window rather than a tail count
when the question is "has this stopped":

```sh
swamp model method run lab serviceLogs --input service=etcd \
  --input tail=2000 --input 'match=ID mismatch' --input sinceSeconds=300
```

## `processes`

`talosctl processes --sort cpu|rss` on every target; the newest `top` rows per
node, with CPU seconds, virtual and resident bytes and the SELinux label. Only a
command's first word is kept: arguments can carry secrets.

## `volumes`

Four reads per run, all nodes at once: `get disks`, `get discoveredvolumes`,
`get hostname` and `usage -d 1 /var`. A node that answers none of them is
skipped with a warning rather than written as an empty disk. Each node's
`volumeLayout` carries its disks (loop devices and CD-ROMs dropped), every GPT
partition with label, filesystem and size, which disk holds STATE, the bytes on
that disk no partition covers, EPHEMERAL's size and how much of it `/var` uses,
and the names of `u-<name>` user volumes. Query it:

```sh
swamp model method run lab volumes
swamp data query 'modelName == "lab" && specName == "volumeLayout" && isLatest' --json
```

## License

MIT, see [LICENSE.md](./LICENSE.md); the original work is copyright magistr.
