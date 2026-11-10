# dataverket swamp extensions

[swamp](https://github.com/swamp-club/swamp) extensions published under the
`@dataverket` collective. Each extension lives in its own directory with its own
manifest, README, license and swamp repository marker, and is published
independently. Every extension is licensed AGPL-3.0-only; the forks keep the
notice of the upstream work's license, MIT or Apache-2.0, in their `LICENSE.md`:

| Directory                | Extension                           | What it covers                                                                                                                                                                                                                                                                                                                                                                                                  |
| ------------------------ | ----------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `openstack/`             | `@dataverket/openstack`             | Nova, Cinder, Neutron, Glance and Keystone through the `openstack` CLI                                                                                                                                                                                                                                                                                                                                          |
| `talosctl/`              | `@dataverket/talosctl`              | Talos machines through `talosctl`, with or without Omni; fork of `@magistr/talos-node` (MIT) plus `volumes`                                                                                                                                                                                                                                                                                                     |
| `omnictl/`               | `@dataverket/omnictl`               | Omni through `omnictl`: fleet inventory and join tokens (Reader), config patches and machine-set membership (Operator); fork of `@mccormick/omni` (MIT)                                                                                                                                                                                                                                                         |
| `sops/`                  | `@dataverket/sops`                  | SOPS + age vault, one encrypted file per secret, writable with public keys only; fork of `@zocc/sops-age` (Apache-2.0)                                                                                                                                                                                                                                                                                          |
| `forgejo/`               | `@dataverket/forgejo`               | Forgejo over its REST API, one type: orgs, repositories, mirrors both ways, pull requests, webhooks, Actions secrets and runners, issues and labels, verify-first deletes; fork of `@thomas/forgejo` (MIT) merged with our former add-ons                                                                                                                                                                       |
| `github/`                | `@dataverket/github`                | GitHub repositories, releases, pull requests and repository settings, one type; fork of `@goodcraft/github` (MIT) merged with our former add-ons                                                                                                                                                                                                                                                                |
| `forgejo-github-mirror/` | `@dataverket/forgejo-github-mirror` | One workflow, `@dataverket/mirror-forgejo-to-github`: every repository of a Forgejo org push-mirrored to a GitHub org, with an audit                                                                                                                                                                                                                                                                            |
| `platform-health/`       | `@dataverket/platform-health`       | One workflow, `@dataverket/platform-health`: the health of every forge, S3 gateway and HTTP endpoint a repository names, by model name, asserted; read-only, a few seconds                                                                                                                                                                                                                                      |
| `flux/`                  | `@dataverket/flux`                  | Flux HelmReleases, Kustomizations and sources, three types: list, a helmrelease `get` with the Helm history, last action and hook Jobs, reconcile, suspend, resume, a `reset` for a release stuck at `RetriesExceeded`, `push_artifact`; every call time-limited; fork of `@ginger_pappa/flux` (MIT) merged with our former add-ons                                                                             |
| `versitygw/`             | `@dataverket/versitygw`             | A versitygw S3 gateway, read-only: accounts without their secrets, buckets and owners, every bucket's settings, TLS health, and a `check` of one inventory                                                                                                                                                                                                                                                      |
| `zitadel/`               | `@dataverket/zitadel`               | Zitadel over its API: projects, applications, users, grants and orgs, one model type each; fork of `@thomas/zitadel` (MIT) widened to full CRUD                                                                                                                                                                                                                                                                 |
| `salmon/`                | `@dataverket/salmon`                | A throwaway Salmon for end-to-end tests: one container on in-memory SQLite with userdb people, seeded apps, trust and grants, and a token-exchange check; every docker and kubectl call time-limited, tokens kept out of errors                                                                                                                                                                                 |
| `kind/`                  | `@dataverket/kind`                  | One named kind cluster created on demand for end-to-end tests, on Docker, Podman or nerdctl: ensure from a config with manifests applied and an optional kubeconfig file of its own, get, delete                                                                                                                                                                                                                |
| `docker-compose/`        | `@dataverket/docker-compose`        | `ensure` (start only what is not up and healthy) and `teardown` for `@smith/docker-compose`, which write only its `state` resource                                                                                                                                                                                                                                                                              |
| `cosign/`                | `@dataverket/cosign`                | Container images and files signed and verified with cosign, one type: `sign`, `verify`, `attest`, `verifyAttestation`, `signBlob`, `verifyBlob`, `describe`, `generateKeyPair`; the key a PEM from a vault, a KMS reference or a file; key-based or keyless verification against a certificate identity; with or without a transparency log; two workflows, `cosign-sign` and `cosign-verify`; a `cosign` skill |
| `signed-images/`         | `@dataverket/signed-images`         | Eight workflows composing ko, cosign, flux and crane: a signed build, signed and verified manifests, a signed OCI release artifact, the release gate, promotion by retag, a release mirrored with its signatures, and a quarantined, keyless-verified, pinned base image; a `signed-images` skill                                                                                                               |
| `ko/`                    | `@dataverket/ko`                    | Go programs built into container images by ko, one type: `describe`, `build` (one image per main package, pushed, local or tarball, digests recorded) and `resolve` (manifests rendered with every image pinned by digest); three workflows, `ko-verify`, `ko-images`, `ko-manifests`; a `ko` skill                                                                                                             |
| `http/`                  | `@dataverket/http`                  | One HTTP or HTTPS endpoint asked whether it answers, one type: `health` records status, TLS, latency, redirects, body text and exact JSON fields (`bodyJson`), never throws for a down endpoint; what `platform-health` asserts over                                                                                                                                                                            |
| `crane/`                 | `@dataverket/crane`                 | An OCI registry through crane, one type: `digest` (a tag pinned, first-seen carried across runs), `describe`, `copy` by digest, `tag` with the previous digest recorded, `blob` (a file out of an artifact layer); two workflows, `mirror-image` and `base-image-watch`; a `crane` skill                                                                                                                        |
| `gateway-api/`           | `@dataverket/gateway-api`           | Gateways, HTTPRoutes and GatewayClasses of the Kubernetes Gateway API read through kubectl, with per-listener and per-parent conditions, a health summary to assert on and an inventory per list; read-only                                                                                                                                                                                                     |
| `cert-manager/`          | `@dataverket/cert-manager`          | cert-manager Certificates, CertificateRequests, ACME Orders, Challenges and issuers read through kubectl; `trace` walks one issuance chain and names where it stands; `renew` forces a renewal as cmctl does                                                                                                                                                                                                    |
| `cnpg/`                  | `@dataverket/cnpg`                  | CloudNativePG Clusters, ScheduledBackups and Backups read through kubectl: phase, primary, instances, WAL archiving and recovery window (in-tree or Barman Cloud plugin), the newest Backup of a schedule, an inventory per list, and an on-demand Backup with a bounded wait                                                                                                                                   |

## Shared code

`lib/` holds the code every extension that runs a command shares, once:
`lib/cli.ts` runs a process safely (a time limit that ends in a kill, secrets
kept out of error text, arguments that cannot be read as flags, one strict fake
for tests) and `lib/kubectl.ts` builds on it (cluster arguments, failure kinds,
name checks, conditions, data names, the inventory record). An extension imports
them relatively, `import { runCli } from "../lib/cli.ts"`, and never spawns a
process itself. `swamp extension push` packages the imported modules into that
extension's own archive, so each extension is still published and pulled alone.
Push, quality and fmt need the repository root for that:
`--extensions-dir <repository root>`. A change in `lib/` moves the content hash
of every extension that imports it, so each needs a new version and review
before its next release; versions already published keep the code they shipped.

## Testing environment

The live suites in `smoke/` are run on rootless Podman, and where a cluster is
needed, on [kind](https://kind.sigs.k8s.io) with its Podman provider:

```sh
KIND_EXPERIMENTAL_PROVIDER=podman kind create cluster --name <name> \
  --kubeconfig <file> --wait 90s
```

Every smoke script takes that kubeconfig file as input, never the default
kubeconfig, and refuses a context that is not named `kind-*`. Each
`smoke/README.md` has an "Environment" section with the tool versions the suite
ran with and the memory it used; the largest suite needs about 1.5 GB for the
kind node. This was run on Linux x86_64 with Podman 4.9.3, kind 0.33.0 and
kubectl 1.37. macOS on Apple silicon is expected to work with a Podman machine
of 2 CPUs and 2 to 4 GiB, as each suite's `smoke/README.md` says for itself, and
has not been run. kind calls its Podman provider experimental. Docker probably
works and is not tested. Rootless means no LoadBalancer address and no port
below 1024. `@dataverket/kind` makes such a cluster from a swamp model, with a
`kubeconfig` argument of its own.

## Develop and publish

Develop against a swamp repository by loading every extension from source:

```sh
for manifest in ~/kode/swamp-extensions/*/manifest.yaml; do
  swamp extension source add "${manifest%/manifest.yaml}"
done
```

Publish one extension from its directory. The adversarial review report that
`swamp extension push` checks lives in the extension's own `.review/`, so it is
committed with the release and survives any machine; the dry run prints the
report's exact path there:

```sh
cd openstack && export SWAMP_EXTENSION_REVIEW_DIR=$PWD/.review
swamp extension push manifest.yaml --dry-run
# an extension that imports lib/:
cd cnpg && export SWAMP_EXTENSION_REVIEW_DIR=$PWD/.review
swamp extension push manifest.yaml --extensions-dir .. --dry-run
```

`task push` (`bin/push`) does that for every extension whose manifest version is
not yet in the registry, with the repository root for the ones that import
`lib/`, refusing a directory, or a `lib/`, with uncommitted changes:

```sh
task push -- --dry-run  # what would be published, through push --dry-run
task push               # publish them
task push:salmon        # only this one
```

The canonical repository is on the dataverket forge; this GitHub repository is a
push mirror of it.
