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
| `sops/`      | `@dataverket/sops`      | SOPS + age vault, one encrypted file per secret, writable with public keys only; fork of `@zocc/sops-age` (Apache-2.0) |
| `forgejo/`   | `@dataverket/forgejo`   | Forgejo over its REST API, one type: orgs, repositories, mirrors both ways, pull requests, webhooks, Actions secrets and runners, issues and labels, verify-first deletes; fork of `@thomas/forgejo` (MIT) merged with our former add-ons |
| `github/`    | `@dataverket/github`    | GitHub repositories, releases, pull requests and repository settings, one type; fork of `@goodcraft/github` (MIT) merged with our former add-ons |
| `forgejo-github-mirror/` | `@dataverket/forgejo-github-mirror` | One workflow, `@dataverket/mirror-forgejo-to-github`: every repository of a Forgejo org push-mirrored to a GitHub org, with an audit |
| `flux/`      | `@dataverket/flux`      | Flux HelmReleases, Kustomizations and sources, three types, with a `reset` for a release stuck at `RetriesExceeded`; fork of `@ginger_pappa/flux` (MIT) merged with our former add-on |
| `versitygw/` | `@dataverket/versitygw` | A versitygw S3 gateway, read-only: accounts without their secrets, buckets and owners, every bucket's settings, TLS health, and a `check` of one inventory |
| `zitadel/`   | `@dataverket/zitadel`   | Zitadel over its API: projects, applications, users, grants and orgs, one model type each; fork of `@thomas/zitadel` (MIT) widened to full CRUD |

Develop against a swamp repository by loading every extension from source:

```sh
swamp extension source add ~/kode/swamp-extensions/*
```

Publish one extension from its directory. The adversarial review report that
`swamp extension push` checks lives in the extension's own `.review/`, so it is
committed with the release and survives any machine; the dry run prints the
report's exact path there:

```sh
cd openstack && export SWAMP_EXTENSION_REVIEW_DIR=$PWD/.review
swamp extension push manifest.yaml --dry-run
```

The canonical repository is on the dataverket forge; this GitHub repository is
a push mirror of it.
