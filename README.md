# dataverket swamp extensions

[swamp](https://github.com/swamp-club/swamp) extensions published under the
`@dataverket` collective. Each extension lives in its own directory with its own
manifest, README, license and swamp repository marker, and is published
independently. Every extension is licensed AGPL-3.0-only; the forks keep the
notice of the upstream work's license, MIT or Apache-2.0, in their `LICENSE.md`:

| Directory                | Extension                           | What it covers                                                                                                                                                                                                                            |
| ------------------------ | ----------------------------------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openstack/`             | `@dataverket/openstack`             | Nova, Cinder, Neutron, Glance and Keystone through the `openstack` CLI                                                                                                                                                                    |
| `talosctl/`              | `@dataverket/talosctl`              | Talos machines through `talosctl`, with or without Omni; fork of `@magistr/talos-node` (MIT) plus `volumes`                                                                                                                               |
| `omnictl/`               | `@dataverket/omnictl`               | Omni through `omnictl`: fleet inventory and join tokens (Reader), config patches and machine-set membership (Operator); fork of `@mccormick/omni` (MIT)                                                                                   |
| `sops/`                  | `@dataverket/sops`                  | SOPS + age vault, one encrypted file per secret, writable with public keys only; fork of `@zocc/sops-age` (Apache-2.0)                                                                                                                    |
| `forgejo/`               | `@dataverket/forgejo`               | Forgejo over its REST API, one type: orgs, repositories, mirrors both ways, pull requests, webhooks, Actions secrets and runners, issues and labels, verify-first deletes; fork of `@thomas/forgejo` (MIT) merged with our former add-ons |
| `github/`                | `@dataverket/github`                | GitHub repositories, releases, pull requests and repository settings, one type; fork of `@goodcraft/github` (MIT) merged with our former add-ons                                                                                          |
| `forgejo-github-mirror/` | `@dataverket/forgejo-github-mirror` | One workflow, `@dataverket/mirror-forgejo-to-github`: every repository of a Forgejo org push-mirrored to a GitHub org, with an audit                                                                                                      |
| `platform-health/`       | `@dataverket/platform-health`       | One workflow, `@dataverket/platform-health`: the health of every forge, S3 gateway and HTTP endpoint a repository names, by model name, asserted; read-only, a few seconds |
| `flux/`                  | `@dataverket/flux`                  | Flux HelmReleases, Kustomizations and sources, three types, with a `reset` for a release stuck at `RetriesExceeded`; fork of `@ginger_pappa/flux` (MIT) merged with our former add-on; `push_artifact`, a directory pushed as the OCI artifact an `OCIRepository` pulls, reproducibly, with a `release.json` of metadata |
| `versitygw/`             | `@dataverket/versitygw`             | A versitygw S3 gateway, read-only: accounts without their secrets, buckets and owners, every bucket's settings, TLS health, and a `check` of one inventory                                                                                |
| `zitadel/`               | `@dataverket/zitadel`               | Zitadel over its API: projects, applications, users, grants and orgs, one model type each; fork of `@thomas/zitadel` (MIT) widened to full CRUD                                                                                           |
| `salmon/`                | `@dataverket/salmon`                | A throwaway Salmon for end-to-end tests: the published image with Postgres and a seeded OpenLDAP, a fixture of teams, apps, trusts and grants, and a token-exchange check                                                                 |
| `kind/`                  | `@dataverket/kind`                  | One named kind cluster created on demand for end-to-end tests: ensure from a config with manifests applied, get, delete                                                                                                                   |
| `docker-compose/`        | `@dataverket/docker-compose`        | `ensure` (start only what is not up and healthy) and `teardown` for `@smith/docker-compose`, which write only its `state` resource                                                                                                        |
| `cosign/`                | `@dataverket/cosign`                | Container images and files signed and verified with cosign, one type: `sign`, `verify`, `attest`, `verifyAttestation`, `signBlob`, `verifyBlob`, `describe`, `generateKeyPair`; the key a PEM from a vault, a KMS reference or a file; key-based or keyless verification against a certificate identity; with or without a transparency log; two workflows, `cosign-sign` and `cosign-verify`; a `cosign` skill |
| `signed-images/`         | `@dataverket/signed-images`         | Eight workflows composing ko, cosign, flux and crane: a signed build, signed and verified manifests, a signed OCI release artifact, the release gate, promotion by retag, a release mirrored with its signatures, and a quarantined, keyless-verified, pinned base image; a `signed-images` skill |
| `ko/`                    | `@dataverket/ko`                    | Go programs built into container images by ko, one type: `describe`, `build` (one image per main package, pushed, local or tarball, digests recorded) and `resolve` (manifests rendered with every image pinned by digest); three workflows, `ko-verify`, `ko-images`, `ko-manifests`; a `ko` skill |
| `http/`                  | `@dataverket/http`                  | One HTTP or HTTPS endpoint asked whether it answers, one type: `health` records status, TLS, latency, redirects and body match, never throws for a down endpoint; what `platform-health` checks beside forges and gateways |
| `crane/`                 | `@dataverket/crane`                 | An OCI registry through crane, one type: `digest` (a tag pinned, first-seen carried across runs), `describe`, `copy` by digest, `tag` with the previous digest recorded, `blob` (a file out of an artifact layer); two workflows, `mirror-image` and `base-image-watch`; a `crane` skill |

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

`task push` (`bin/push`) does that for every extension whose manifest version is
not yet in the registry, refusing a directory with uncommitted changes:

```sh
task push -- --dry-run  # what would be published, through push --dry-run
task push               # publish them
task push:salmon        # only this one
```

The canonical repository is on the dataverket forge; this GitHub repository is a
push mirror of it.
