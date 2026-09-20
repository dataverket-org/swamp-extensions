# @dataverket/omnictl

[Sidero Omni](https://omni.siderolabs.com) for
[swamp](https://github.com/swamp-club/swamp), through `omnictl`: fleet discovery
with a Reader service account, and the machine and patch writes an Operator
makes, on a second model type with its own key.

Forked from [`@mccormick/omni`](https://github.com/mccormickt/swamp-extensions)
(MIT, copyright Tommy McCormick) as `@dataverket/omni`, and renamed to
`@dataverket/omnictl` on 2026-09-20 after the CLI it wraps, as
`@dataverket/talosctl` and `@dataverket/openstack` are. The `discover` method
and its `node`, `cluster` and `summary` resources are unchanged from the fork;
`talosconfig` and `joinTokens` are added. Version 2026.09.19.1 briefly carried a
`volumes` method; it moved to `@dataverket/talosctl/node` in 2026.09.19.2,
because everything spoken to the Talos API belongs on that model.

## Model types

### `@dataverket/omnictl/inventory`

One instance per Omni endpoint, with a Reader service account.

| Method        | What it does                                                                                                                                          |
| ------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------- |
| `discover`    | Every machine and cluster Omni manages: one `node` per machine, one `cluster` per cluster, one `summary`                                              |
| `talosconfig` | For one cluster (`--input cluster=<name>`): its machines' node IPs and the admin talosconfig for the service account, one resource                    |
| `joinTokens`  | Every join token as a `joinToken`: name, active/revoked/expired, default flag, machines joined, expiry; a SHA-256 fingerprint stands in for the token |

The Talos API itself is not spoken to here. Give the stored node IPs and
talosconfig to a `@dataverket/talosctl/node` model through `data.latest` (the
one data accessor swamp accepts in a model definition that a workflow runs;
swamp-club Lab 2295) and run its `volumes`, `reset`, `upgrade` and the rest
there:

```yaml
# models/@dataverket/talosctl/node/prod.yaml
globalArguments:
  nodes: ${{ data.latest("omni", "talosconfig-prod").attributes.nodes }}
  talosconfigContent: ${{ data.latest("omni", "talosconfig-prod").attributes.content }}
  serviceAccountKey: ${{ vault.get("infra", "omni/service_account_key") }}
```

### `@dataverket/omnictl/cluster`

One instance per Omni endpoint, with an Operator service account on its own
vault key, so the reads above never carry it. The four writes of a machine swap,
in the order a swap uses them:

| Method          | What it does                                                                                                                                            |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyPatch`    | Create or update a `ConfigPatch` (`--input id=… data=…`) scoped to a `machine`, a `machineSet` with its `cluster`, or a `cluster`; stores it            |
| `addMachine`    | Put a machine into a machine set by creating its `MachineSetNode`, what the UI's "add machine" does; Omni installs Talos with every patch in scope      |
| `removeMachine` | `omnictl cluster machine delete`: drain, wipe, wait up to `timeout` (15m); refuses a machine in no machine set; never forces                            |
| `forgetMachine` | Delete the machine's SideroLink `Link`; refuses while it is in a cluster, no-op when already gone. After the machine itself is gone, or it re-registers |

`applyPatch` and `addMachine` take `dryRun=true`, which runs
`omnictl apply --dry-run`: Omni validates the resource and nothing changes. Use
it once with a new Operator key to see the resources before applying them.

```sh
swamp model create @dataverket/omnictl/cluster omni-cluster
#   endpoint: https://omni.example.net
#   serviceAccountKey: ${{ vault.get("infra", "omni/operator_service_account_key") }}
swamp model method run omni-cluster applyPatch \
  --input id=500-wrkr-4-storage --input machine=<uuid> --input data="$(cat patch.yaml)" --input dryRun=true
swamp model method run omni-cluster addMachine \
  --input machine=<uuid> --input cluster=prod --input machineSet=prod-workers
swamp model method run omni-cluster removeMachine --input machine=<uuid>
swamp model method run omni-cluster forgetMachine --input machine=<uuid>
```

## Credential-safe

Every call authenticates with the service account through the environment
(`OMNI_ENDPOINT`, `OMNI_SERVICE_ACCOUNT_KEY`); nothing touches an on-disk
omniconfig or opens a browser. The minted talosconfig and every applied resource
pass through a private temporary file that is removed at once. The key is
supplied through a vault, marked sensitive, and redacted from logs and error
text. `inventory` needs the Reader role; `cluster` needs Operator.

## Prerequisites

`omnictl` on `PATH` (or `omnictlPath`). The stored talosconfig is not a secret:
it names Omni's proxy and the service account's identity, and is inert without
`OMNI_SERVICE_ACCOUNT_KEY`, which stays in the vault. It is therefore an
ordinary resource, and running `talosconfig` touches no vault. Two service
accounts, one per role; name them after whatever owns the key, since Omni lists
the role but not the owner. Each key is piped straight into the vault:

```sh
omnictl serviceaccount create --use-user-role=false --role Reader omni-reader \
  | sed -n 's/^OMNI_SERVICE_ACCOUNT_KEY=//p' | swamp vault put infra omni/service_account_key
omnictl serviceaccount create --use-user-role=false --role Operator omni-operator \
  | sed -n 's/^OMNI_SERVICE_ACCOUNT_KEY=//p' | swamp vault put infra omni/operator_service_account_key
```

## Quick start

```sh
swamp extension pull @dataverket/omnictl
swamp model create @dataverket/omnictl/inventory omni
#   endpoint: https://omni.example.net
#   serviceAccountKey: ${{ vault.get("infra", "omni/service_account_key") }}
swamp model method run omni discover
swamp model method run omni talosconfig --input cluster=prod
```

## Configuration

| Global argument         | Required | Default   | Description                                               |
| ----------------------- | -------- | --------- | --------------------------------------------------------- |
| `endpoint`              | yes      | —         | Omni API endpoint, e.g. `https://omni.example.net`        |
| `serviceAccountKey`     | yes      | —         | `OMNI_SERVICE_ACCOUNT_KEY`; supply via a vault expression |
| `insecureSkipTlsVerify` | no       | `false`   | Skip TLS verification (self-signed certs only)            |
| `omnictlPath`           | no       | `omnictl` | Path to the `omnictl` binary                              |

## Consuming the data

```yaml
allNodes: ${{ data.findBySpec("omni", "node") }}
totalNodes: ${{ data.latest("omni", "summary").attributes.totalNodes }}
```

## License

MIT, see [LICENSE.md](./LICENSE.md); the original work is copyright Tommy
McCormick.
