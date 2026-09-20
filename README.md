# dataverket swamp extensions

[swamp](https://github.com/swamp-club/swamp) extensions published under the
`@dataverket` collective. Each extension lives in its own directory with its
own manifest, README, license and swamp repository marker, and is published
independently:

| Directory    | Extension               | What it covers                                                           |
| ------------ | ----------------------- | ------------------------------------------------------------------------ |
| `openstack/` | `@dataverket/openstack` | Nova, Cinder, Neutron, Glance and Keystone through the `openstack` CLI   |
| `talosctl/`  | `@dataverket/talosctl`  | Talos machines through `talosctl`, with or without Omni; fork of `@magistr/talos-node` (MIT) plus `volumes` |
| `omnictl/`   | `@dataverket/omnictl`   | Omni through `omnictl`: fleet inventory and join tokens (Reader), config patches and machine-set membership (Operator); fork of `@mccormick/omni` (MIT) |
| `sops-age/`  | `@dataverket/sops-age`  | SOPS + age vault: one file, changed one value at a time with `sops set`, listed without a key, deleted with `sops unset`; fork of `@zocc/sops-age` (Apache-2.0) |

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
