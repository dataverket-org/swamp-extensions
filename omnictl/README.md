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
  serviceAccountKeyFile: ~/.talos/omni/reader.key
```

### `@dataverket/omnictl/cluster`

One instance per Omni endpoint, with an Operator service account on its own
vault key, so the reads above never carry it. The four writes of a machine swap,
in the order a swap uses them:

| Method          | What it does                                                                                                                                                                    |
| --------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `applyPatch`    | Create or update a `ConfigPatch` (`--input id=… data=…`) scoped to a `machine`, a `machineSet` with its `cluster`, or a `cluster`; stores it                                    |
| `addMachine`    | Put a machine into a machine set by creating its `MachineSetNode` with the set's role label, as the UI's "add machine" does; Omni installs Talos                                |
| `removeMachine` | `omnictl cluster machine delete`: drain, wipe, wait up to `timeout` (15m); refuses a machine in no machine set; never forces                                                    |
| `deleteMachine` | The dashboard's Delete Machine: delete the machine's own config patches and its `Machine`; Omni removes the Link. Refuses while it is in a machine set; delete the server first |
| `setExtensions` | Set the system extensions (`--input extensions='["siderolabs/kata-containers"]'`) for a `machine`, a `machineSet` or the `cluster`; the list replaces what was there            |

`applyPatch` and `addMachine` take `dryRun=true`, which runs
`omnictl apply --dry-run`: Omni validates the resource and nothing changes. Use
it once with a new Operator key to see the resources before applying them.

`addMachine` reads the machine set first and copies its role label
(`omni.sidero.dev/role-worker` or `omni.sidero.dev/role-controlplane`) onto the
node, as Omni's UI does. Omni accepts a `MachineSetNode` without one, even in a
dry run; one made that way on 2026-10-01 was counted as requested and not
allocated. The method refuses a machine set that is missing, belongs to another
cluster or has no single role. A node that exists is updated, so rerunning
`addMachine` adds the label to a node made by 2026.09.29.1 or earlier.

```sh
swamp model create @dataverket/omnictl/cluster omni-cluster
#   endpoint: https://omni.example.net
#   serviceAccountKeyFile: ~/.talos/omni/operator.key
swamp model method run omni-cluster applyPatch \
  --input id=500-wrkr-4-storage --input machine=<uuid> --input data="$(cat patch.yaml)" --input dryRun=true
swamp model method run omni-cluster addMachine \
  --input machine=<uuid> --input cluster=prod --input machineSet=prod-workers
swamp model method run omni-cluster removeMachine --input machine=<uuid>
swamp model method run omni-cluster deleteMachine --input machine=<uuid>
```

### When a machine is gone before its removal finishes

`removeMachine` asks Omni to wipe the machine. If its server is deleted first,
or it never finished booting, Omni cannot reach it and the removal waits for
ever. `deleteMachine` clears it all the same, as the dashboard's Delete Machine
does: its own config patches and its `Machine` are deleted, and Omni removes the
rest (seen in Omni's audit log, 2026-10-01).

```sh
swamp model method run omni-cluster removeMachine --input machine=<uuid> --input timeout=1m
swamp model method run omni-cluster deleteMachine --input machine=<uuid>
```

### Extensions follow the most specific scope

Omni installs the most specific `ExtensionsConfiguration` a machine has: its
own, then its machine set's, then its cluster's. They do not merge. Machines
added in the dashboard get one of their own, named `schematic-<uuid>`; setting
the machine set's once makes every new machine in it start with the same
extensions.

## Credential-safe

Every call authenticates with the service account through the environment
(`OMNI_ENDPOINT`, `OMNI_SERVICE_ACCOUNT_KEY`); nothing touches an on-disk
omniconfig or opens a browser. The minted talosconfig and every applied resource
pass through a private temporary file that is removed at once. The key is
supplied through a vault, marked sensitive, and redacted from logs and error
text. `inventory` needs the Reader role; `cluster` needs Operator.

## Pre-flight checks

Both models run two checks before a method reaches Omni:

| Check                 | Label    | What it checks                                                                                   |
| --------------------- | -------- | ------------------------------------------------------------------------------------------------ |
| `service-account-key` | `policy` | The endpoint is https and the key is set once: the file exists, is readable and is not empty     |
| `omni-authenticates`  | `live`   | Omni accepts the key: one `omnictl get Clusters.omni.sidero.dev`, which every Omni role can read |

Service account keys expire. Without the checks an expired key shows up as
`failed to sign message: ... no valid signing keys` from inside `omnictl`. With
them, the run stops before any write and says which key expired and that a new
one must be minted. The live check costs one read per method run; skip it where
that matters:

```sh
swamp model method run omni-cluster addMachine --skip-check-label live \
  --input machine=<uuid> --input cluster=prod --input machineSet=prod-workers
```

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
#   serviceAccountKeyFile: ~/.talos/omni/reader.key
swamp model method run omni discover
swamp model method run omni talosconfig --input cluster=prod
```

## Configuration

The service-account key is given one of two ways, never both.
`serviceAccountKeyFile` names a file the key is read from at call time, which is
how a definition points at a short-lived key an operator's session wrote without
holding the value itself; a leading `~/` expands from `HOME`, a missing or empty
file is an error, and the content is trimmed. `serviceAccountKey` takes the
value directly, from a vault expression, for a key a process owns with no
operator session behind it:

```yaml
serviceAccountKey: ${{ vault.get("infra", "omni/service_account_key") }}
```

| Global argument         | Required       | Default   | Description                                                                                              |
| ----------------------- | -------------- | --------- | -------------------------------------------------------------------------------------------------------- |
| `endpoint`              | yes            | —         | Omni API endpoint, e.g. `https://omni.example.net`                                                       |
| `serviceAccountKeyFile` | one of the two | —         | Path to a file holding the key, read at call time, `~/` expanded; for a key an operator's session writes |
| `serviceAccountKey`     | one of the two | —         | `OMNI_SERVICE_ACCOUNT_KEY` as a value, for a key the process owns; supply via a vault expression         |
| `insecureSkipTlsVerify` | no             | `false`   | Skip TLS verification (self-signed certs only)                                                           |
| `omnictlPath`           | no             | `omnictl` | Path to the `omnictl` binary                                                                             |

## Consuming the data

```yaml
allNodes: ${{ data.findBySpec("omni", "node") }}
totalNodes: ${{ data.latest("omni", "summary").attributes.totalNodes }}
```

## License

MIT, see [LICENSE.md](./LICENSE.md); the original work is copyright Tommy
McCormick.
