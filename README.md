# @dataverket/openstack

OpenStack for [swamp](https://github.com/swamp-club/swamp), through the official
`openstack` CLI.

The extension wraps python-openstackclient rather than the REST APIs. The CLI
already handles Keystone auth types, the service catalog, API microversion
negotiation and pagination; these models only shape its `-f json` output into
typed swamp resources and drive the mutating commands.

## Model types

| Type                                          | Resource                                     | Methods                                                                                              |
| --------------------------------------------- | -------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `@dataverket/openstack/server`                | `server`                                     | list, get, create, update, delete, start, stop, reboot, attachInterface, detachInterface             |
| `@dataverket/openstack/image`                 | `image`                                      | list, get, find (newest match), create (upload), update, delete                                      |
| `@dataverket/openstack/keypair`               | `keypair`, `privateKey`                      | list, get, create (import or generate), delete                                                       |
| `@dataverket/openstack/server-group`          | `serverGroup`                                | list, get, create, delete                                                                            |
| `@dataverket/openstack/flavor`                | `flavor`                                     | list, get (read-only lookup)                                                                         |
| `@dataverket/openstack/availability-zone`     | `zone`                                       | list per service (read-only lookup)                                                                  |
| `@dataverket/openstack/volume`                | `volume`                                     | list, get, create, update, delete, attach, detach                                                    |
| `@dataverket/openstack/volume-snapshot`       | `snapshot`                                   | list, get, create, delete                                                                            |
| `@dataverket/openstack/volume-type`           | `volumeType`                                 | list, get (read-only lookup)                                                                         |
| `@dataverket/openstack/security-group`        | `securityGroup`                              | list, get, create, update, delete, addRule, removeRule                                               |
| `@dataverket/openstack/network`               | `network`                                    | list, get, create, update, delete                                                                    |
| `@dataverket/openstack/subnet`                | `subnet`                                     | list, get, create, update, delete                                                                    |
| `@dataverket/openstack/router`                | `router`                                     | list, get, create, update, addSubnet, removeSubnet, addRoute, removeRoute, delete                    |
| `@dataverket/openstack/port`                  | `port`                                       | list, get, create, update, delete                                                                    |
| `@dataverket/openstack/floating-ip`           | `floatingIp`                                 | list, get, allocate, bind (server or port), unbind, release                                          |
| `@dataverket/openstack/application-credential`| `applicationCredential`, `secret`            | list, get, create (one-time secret), delete                                                          |

Design rules shared by all of them:

- **`list` and `get` produce the same shape.** A `list` runs
  `openstack <kind> list -c ID` and then fans out `openstack <kind> show` with
  bounded concurrency, so a stored resource is always the full object.
- **Mutations re-read.** Every create/update/start/stop/attach/bind method
  finishes with a `show` and stores the live state. `delete` and `release` drop
  the stored resource.
- **Idempotent.** A `create` whose name already exists reuses that resource and
  makes no change. A `delete` of something already gone succeeds. `addRule`
  tolerates an identical existing rule.
- **Waits where the API is async.** Server create/delete/reboot use the CLI's
  `--wait`; volume create/delete/attach/detach poll `volume show` until Cinder
  settles (`timeoutSeconds`, default 600).
- **Instance names** are `<prefix>-<sanitized name>`: `server-web-01`,
  `volume-web-01-state`, `floatingip-203-0-113-20`, `securitygroup-ssh`,
  `network-private-net`, `port-web-01-eth0`, `zone-compute-zone-a`,
  `appcred-ci`. An unnamed port is stored under its id. Duplicate names in
  one batch get an id suffix instead of overwriting.
- **Structured flags are built, never interpolated.** NICs, block devices,
  fixed IPs, allocation pools and routes are serialised as the CLI's
  `key=value,key=value` form with each value checked; names for `--nic` are
  resolved to ids first.

## Prerequisites

### openstack CLI

python-openstackclient must be on `PATH` (or set `openstackPath`). The models
are written and tested against 10.3.0, the latest stable release as of August
2026, on an OpenStack 2026.1 cloud.

```sh
brew install openstackclient      # or: pip install python-openstackclient
openstack --version
```

### Authentication

Either a `clouds.yaml` entry or an application credential. Environment variables
override `clouds.yaml`, so both can be combined: the cloud supplies auth URL and
region, the credential replaces its auth section.

```yaml
# ~/.config/openstack/clouds.yaml
clouds:
  example:
    auth:
      auth_url: https://keystone.example.net:5000/v3
      application_credential_id: "REPLACE"
      application_credential_secret: "REPLACE"
    auth_type: "v3applicationcredential"
    region_name: "RegionOne"
    interface: "public"
    identity_api_version: 3
```

The CLI searches the current directory, `~/.config/openstack` and
`/etc/openstack` for `clouds.yaml`. Point at a file elsewhere with the
`cloudsFile` global argument (or an inherited `OS_CLIENT_CONFIG_FILE`, which
survives the `OS_*` strip described below, as does `OS_CLIENT_SECURE_FILE`).

Or keep the secret in a swamp vault and let the model export it:

```sh
swamp vault create local_encryption openstack
swamp vault put openstack APPLICATION_CREDENTIAL_SECRET
```

## Quick start

```sh
swamp extension pull @dataverket/openstack

swamp model create @dataverket/openstack/server servers
#   cloud: example
#   # or, without clouds.yaml:
#   authUrl: https://keystone.example.net:5000/v3
#   applicationCredentialId: REPLACE
#   applicationCredentialSecret: ${{ vault.get("openstack", "APPLICATION_CREDENTIAL_SECRET") }}

swamp model method run servers list
swamp model method run servers get --arg server=web-01
```

Create a server with a floating IP:

```sh
swamp model create @dataverket/openstack/floating-ip public-ips   # same globalArguments

swamp model method run servers create \
  --arg name=web-01 --arg flavor=m5.medium --arg image="Debian GNU/Linux 13 (Trixie)" \
  --arg 'networks=["private-net"]' --arg keyName=ops-key \
  --arg 'securityGroups=["ssh"]'

swamp model method run public-ips allocate --arg network=ext-net --arg description="web-01 public"
swamp model method run public-ips bind --arg floatingIp=203.0.113.20 --arg server=web-01
```

A project from scratch, the way the OpenTofu provider would lay it out:

```sh
for t in network subnet router port floating-ip; do
  swamp model create @dataverket/openstack/$t os-$t --global-arg cloud=example
done
swamp model method run os-network list --input external=true          # find ext-net
swamp model method run os-network create --input name=lan
swamp model method run os-subnet create --input name=lan-v4 --input network=lan \
  --input cidr=192.0.2.0/24 --input 'dnsNameservers=["198.51.100.53"]'
swamp model method run os-router create --input name=lan-gw --input externalGateway=ext-net
swamp model method run os-router addSubnet --input router=lan-gw --input subnet=lan-v4
swamp model method run os-port create --input name=web-01-eth0 --input network=lan \
  --input 'fixedIps=[{"subnet":"lan-v4","ipAddress":"192.0.2.10"}]' --input 'securityGroups=["ssh"]'
swamp model method run servers create --input name=web-01 --input flavor=m5.medium \
  --input image="Debian GNU/Linux 13 (Trixie)" --input 'ports=["web-01-eth0"]' --input configDrive=true
swamp model method run os-floating-ip allocate --input network=ext-net --input description="web-01 public"
swamp model method run os-floating-ip bind --input floatingIp=203.0.113.20 --input port=web-01-eth0
```

Find the newest Talos image the way a data source would:

```sh
swamp model method run images find --input 'nameRegex=^talos-' --input visibility=private
```

## Configuration

| Global argument               | Required | Default     | Description                                          |
| ----------------------------- | -------- | ----------- | ---------------------------------------------------- |
| `cloud`                       | one of   | —           | `clouds.yaml` entry, exported as `OS_CLOUD`          |
| `authUrl`                     | one of   | —           | Keystone v3 endpoint when no cloud is named          |
| `applicationCredentialId`     | no       | —           | Application credential id                            |
| `applicationCredentialSecret` | no       | —           | Its secret; sensitive, supply via a vault expression |
| `region`                      | no       | —           | `OS_REGION_NAME`                                     |
| `interface`                   | no       | —           | `public`, `internal` or `admin`                      |
| `openstackPath`               | no       | `openstack` | Path to the CLI binary                               |
| `concurrency`                 | no       | `4`         | Parallel `show` calls during `list`                  |

When the model names a cloud or credential, inherited `OS_*` variables are
dropped from the subprocess environment so nothing ambient leaks in. With
neither set, the ambient environment (for example an exported `OS_CLOUD`) is
used as-is.

Two pre-flight checks run before every mutating method: `auth-configured`
(policy, offline) and `openstack-cli` (live, runs `openstack --version`). Skip
the live one offline with `--skip-check-label live`.

## Consuming the data

```yaml
# The public address of web-01
ip: ${{ data.latest("public-ips", "floatingip-203-0-113-20").attributes.address }}
# Every server currently ACTIVE
active: ${{ data.findBySpec("servers", "server").filter(s, s.attributes.status == "ACTIVE") }}
# The device a volume landed on
device: ${{ data.latest("volumes", "volume-web-01-state").attributes.attachments[0].device }}
```

## Known limitations

- **One project per model instance.** The credential's project scope decides
  what is visible; there is no `--all-projects` support.
- **Latency.** Each CLI call is a fresh process and Keystone round-trip (about
  two seconds). `list` on a project with many images takes a while; raise
  `concurrency` or filter.
- **No load balancers, DNS, object storage or quotas yet.** Extend with
  `export const extension` or open an issue.
- **Application credentials** can only be created and deleted by a
  password-authenticated user or an *unrestricted* credential; Keystone
  refuses the request from a restricted one (HTTP 403). List and get work for
  everyone.
- **Keypair private keys** are only available at generation time. They are
  stored once in the sensitive `privateKey` spec and never re-read.

## Development

```sh
~/.swamp/deno/deno task test      # unit tests against a scripted fake CLI
~/.swamp/deno/deno task check
~/.swamp/deno/deno task lint
swamp extension source add ~/kode/swamp-openstack   # load from source in a repo
```

Test fixtures in `fixtures.ts` mirror python-openstackclient 10.3.0 output with
anonymised identifiers; keep them in step with the CLI version named above when
upgrading.

## License

MIT — see [LICENSE.md](./LICENSE.md).
