# @dataverket/omni

Talos fleet discovery for [swamp](https://github.com/swamp-club/swamp), via
[Sidero Omni](https://omni.siderolabs.com), plus the disk layout of every
machine in a cluster.

Forked from [`@mccormick/omni`](https://github.com/mccormickt/swamp-extensions)
(MIT, copyright Tommy McCormick). The `discover` method and its `node`,
`cluster` and `summary` resources are unchanged; `volumes` is added.

## Model type

`@dataverket/omni/inventory`, one instance per Omni endpoint.

| Method     | What it does                                                                                                                               |
| ---------- | ------------------------------------------------------------------------------------------------------------------------------------------ |
| `discover` | Every machine and cluster Omni manages: one `node` per machine, one `cluster` per cluster, one `summary`                                   |
| `volumes`  | For one cluster (`--input cluster=<name>`): disks, partitions by label, unallocated space and EPHEMERAL usage, one `volumeLayout` per node |

`volumes` fetches the cluster's machine identities from Omni for their node
addresses, mints the cluster's admin talosconfig for the service account into a
temporary file (`omnictl talosconfig`, never merged into `~/.talos/config`,
removed afterwards), and runs `talosctl get disks`, `get discoveredvolumes` and
`usage -d 1 /var` against all nodes at once through Omni's Talos proxy. The
`volumeLayout` shape is shared with `@dataverket/talosctl/node`, so a lab
cluster on plain talosctl and an Omni-managed one are queried the same way.

## Read-only and credential-safe

Only `omnictl get`, `omnictl talosconfig`, `talosctl get` and `talosctl usage`
are ever run. Both CLIs authenticate with the service account through the
environment (`OMNI_ENDPOINT`, `OMNI_SERVICE_ACCOUNT_KEY`); nothing touches an
on-disk omniconfig or opens a browser. The key is supplied through a vault,
marked sensitive, and redacted from logs and error text. A read-only Omni role
is sufficient.

## Prerequisites

`omnictl` and, for `volumes`, `talosctl` on `PATH` (or `omnictlPath` /
`talosctlPath`). A service account:

```sh
omnictl serviceaccount create swamp-omni-inventory
swamp vault put infra omni/service_account_key
```

## Quick start

```sh
swamp extension pull @dataverket/omni
swamp model create @dataverket/omni/inventory omni
#   endpoint: https://omni.example.net
#   serviceAccountKey: ${{ vault.get("infra", "omni/service_account_key") }}
swamp model method run omni discover
swamp model method run omni volumes --input cluster=prod
swamp data query 'modelName == "omni" && specName == "volumeLayout" && isLatest' --json
```

## Configuration

| Global argument         | Required | Default    | Description                                               |
| ----------------------- | -------- | ---------- | --------------------------------------------------------- |
| `endpoint`              | yes      | —          | Omni API endpoint, e.g. `https://omni.example.net`        |
| `serviceAccountKey`     | yes      | —          | `OMNI_SERVICE_ACCOUNT_KEY`; supply via a vault expression |
| `insecureSkipTlsVerify` | no       | `false`    | Skip TLS verification (self-signed certs only)            |
| `omnictlPath`           | no       | `omnictl`  | Path to the `omnictl` binary                              |
| `talosctlPath`          | no       | `talosctl` | Path to the `talosctl` binary (`volumes` only)            |

## Consuming the data

```yaml
allNodes: ${{ data.findBySpec("omni", "node") }}
totalNodes: ${{ data.latest("omni", "summary").attributes.totalNodes }}
workerEphemeral: ${{ data.latest("omni", "volume-wrkr-1").attributes.ephemeralUsedPercent }}
```

## License

MIT, see [LICENSE.md](./LICENSE.md); the original work is copyright Tommy
McCormick.
