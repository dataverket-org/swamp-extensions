# dataverket swamp extensions

[swamp](https://github.com/swamp-club/swamp) extensions published under the
`@dataverket` collective. Each extension lives in its own directory with its
own manifest, README, license and swamp repository marker, and is published
independently:

| Directory    | Extension               | What it covers                                                           |
| ------------ | ----------------------- | ------------------------------------------------------------------------ |
| `openstack/` | `@dataverket/openstack` | Nova, Cinder, Neutron, Glance and Keystone through the `openstack` CLI   |
| `talosctl/`  | `@dataverket/talosctl`  | Talos machines through `talosctl`, with or without Omni; fork of `@magistr/talos-node` (MIT) plus `volumes` |
| `omni/`      | `@dataverket/omni`      | Talos fleet inventory via Omni; fork of `@mccormick/omni` (MIT) plus `volumes` through Omni's proxy |

Develop against a swamp repository by loading every extension from source:

```sh
swamp extension source add ~/kode/swamp-extensions/*
```

Publish one extension from its directory:

```sh
cd openstack && swamp extension push manifest.yaml --dry-run
```

The canonical repository is on the dataverket forge; this GitHub repository is
a push mirror of it.
