# @dataverket/omni

Talos fleet discovery for [swamp](https://github.com/swamp-club/swamp), via
[Sidero Omni](https://omni.siderolabs.com).

Forked from [`@mccormick/omni`](https://github.com/mccormickt/swamp-extensions)
(MIT, copyright Tommy McCormick). The `discover` method and its `node`,
`cluster` and `summary` resources are unchanged; `talosconfig` is added. Version
2026.09.19.1 briefly carried a `volumes` method; it moved to
`@dataverket/talosctl/node` in 2026.09.19.2, together with the `talosctlPath`
argument, because everything spoken to the Talos API belongs on that model.

## Model type

`@dataverket/omni/inventory`, one instance per Omni endpoint.

| Method        | What it does                                                                                                                       |
| ------------- | ---------------------------------------------------------------------------------------------------------------------------------- |
| `discover`    | Every machine and cluster Omni manages: one `node` per machine, one `cluster` per cluster, one `summary`                           |
| `talosconfig` | For one cluster (`--input cluster=<name>`): its machines' node IPs and the admin talosconfig for the service account, one resource |

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

## Read-only and credential-safe

Only `omnictl get` and `omnictl talosconfig` are ever run, authenticated with
the service account through the environment (`OMNI_ENDPOINT`,
`OMNI_SERVICE_ACCOUNT_KEY`); nothing touches an on-disk omniconfig or opens a
browser, and the minted talosconfig passes through a private temporary file that
is removed at once. The key is supplied through a vault, marked sensitive, and
redacted from logs and error text. A read-only Omni role is sufficient.

## Prerequisites

`omnictl` on `PATH` (or `omnictlPath`). The stored talosconfig is not a secret:
it names Omni's proxy and the service account's identity, and is inert without
`OMNI_SERVICE_ACCOUNT_KEY`, which stays in the vault. It is therefore an
ordinary resource, and running `talosconfig` touches no vault. A service
account:

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
