# @dataverket/talosctl

Talos Linux machines for [swamp](https://github.com/swamp-club/swamp), through
`talosctl`, with or without Omni.

Forked from [`@magistr/talos-node`](https://github.com/umag/swamp-workspace)
(MIT, copyright magistr) and typed. The upstream methods are kept; `volumes` is
added, and `reset` learned to wipe only named partitions.

## Model type

`@dataverket/talosctl/node` targets one or many machines.

| Method        | What it does                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------- |
| `version`     | Talos version of every node (`version` resource per node)                                             |
| `services`    | Every service on every node (`service` resource per node and service)                                 |
| `etcdMembers` | The etcd members (`etcdMember` resource each)                                                         |
| `kubeconfig`  | The admin kubeconfig (`kubeconfig`, sensitive)                                                        |
| `volumes`     | Disks, partitions by label, unallocated space and EPHEMERAL usage of every node (`volumeLayout` each) |
| `applyConfig` | `talosctl apply-config` with a mode; `insecure` for maintenance mode                                  |
| `patchConfig` | `talosctl patch machineconfig` with a patch file                                                      |
| `bootstrap`   | `talosctl bootstrap`, once, against the first control plane                                           |
| `reboot`      | Reboot, optionally by power cycle                                                                     |
| `shutdown`    | Shut down, optionally forced                                                                          |
| `reset`       | Wipe the system disk, or only the partitions named in `systemLabelsToWipe` (for example `EPHEMERAL`)  |
| `upgrade`     | `talosctl upgrade` to an installer image                                                              |
| `health`      | The cluster health check with a wait timeout                                                          |

### Targets

| Global argument | Default      | Meaning                                                                                       |
| --------------- | ------------ | --------------------------------------------------------------------------------------------- |
| `endpoint`      | unset        | `--endpoints`; also the only node when `nodes` is unset. Leave unset with an Omni talosconfig |
| `nodes`         | `[endpoint]` | `--nodes`: the machines every method addresses                                                |
| `talosconfig`   | unset        | Path to a talosconfig; unset means talosctl's own lookup                                      |
| `insecure`      | `false`      | `--insecure`, for machines in maintenance mode                                                |
| `talosctlPath`  | `talosctl`   | Binary path when not on `PATH`                                                                |

A plain cluster: set `endpoint` (or `nodes`) and `talosconfig`:

```sh
swamp model create @dataverket/talosctl/node lab
#   endpoint: 10.5.0.2
#   nodes: [10.5.0.2, 10.5.0.3]
#   talosconfig: ~/.talos/lab
swamp model method run lab volumes
```

An Omni-managed cluster: `omnictl talosconfig -c <cluster>` writes a config
whose endpoints are Omni's proxy; set `talosconfig` to it, `nodes` to the
machines' addresses, leave `endpoint` unset, and export
`OMNI_SERVICE_ACCOUNT_KEY` so talosctl authenticates without a browser. For Omni
fleets `@dataverket/omni` does all of that from the vault.

## `volumes`

Three reads per run, all nodes at once: `get disks`, `get discoveredvolumes` and
`usage -d 1 /var`. Each node's `volumeLayout` carries its disks (loop devices
and CD-ROMs dropped), every GPT partition with label, filesystem and size, which
disk holds STATE, the bytes on that disk no partition covers, EPHEMERAL's size
and how much of it `/var` uses, and the names of `u-<name>` user volumes. Query
it:

```sh
swamp model method run lab volumes
swamp data query 'modelName == "lab" && specName == "volumeLayout" && isLatest' --json
```

## License

MIT, see [LICENSE.md](./LICENSE.md); the original work is copyright magistr.
