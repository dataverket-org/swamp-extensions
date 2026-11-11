#!/usr/bin/env bash
# identify over a spread of real public images, read-only and without a
# login: signatures kept as bundles and under a tag, certificates from
# GitHub and from Google, a key's signature, attestations beside and
# without signatures, and images with nothing. Each is named by a digest
# that was current on 2026-11-11, with the state identify recorded then
# and, where there is one, the identity. Reads ghcr.io, quay.io, docker.io,
# gcr.io, cgr.dev, registry.k8s.io and the public Sigstore instance; writes
# records in $REPO.
#
#   REPO=<scratch swamp repository> ./survey.sh
#
# A failure here may be the world changing and not this extension: a
# registry that removed a digest, a publisher that signed again, a rate
# limit. The line says which image and what was recorded.
source "$(dirname "$0")/harness.sh"

model sm-survey
# name, reference by digest, state, identity
while IFS='|' read -r -u 3 name ref state identity; do
  [ -n "$name" ] || continue
  run sm-survey identify "refs:json=[\"$ref\"]"
  holds "$name: $state${identity:+, $identity}" \
    ".state == \"$state\" and .certificateIdentity == \"$identity\" and .identityChecked == false"
done 3<<'IMAGES'
cgr.dev/chainguard/nginx:latest|cgr.dev/chainguard/nginx@sha256:1fae1bff8072a00f3de3dc5aa95af8b5587dde2297b08c72893dacf423ccbe6e|identified|https://github.com/chainguard-images/images/.github/workflows/release.yaml@refs/heads/main
cgr.dev/chainguard/static:latest|cgr.dev/chainguard/static@sha256:fc42af33e643f20d08baf03cddcc1c02ba57052dfb02edb0d79f3fc47bcea8d9|identified|https://github.com/chainguard-images/images/.github/workflows/release.yaml@refs/heads/main
docker.io/aquasec/trivy:0.57.1|docker.io/aquasec/trivy@sha256:5c59e08f980b5d4d503329773480fcea2c9bdad7e381d846fbf9f2ecb8050f6b|identified|https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v0.57.1
docker.io/fluxcd/source-controller:v1.7.0|docker.io/fluxcd/source-controller@sha256:233e0a1e842cab6ad7d2ed876d39c03d80ba727f78a8b6f159f8b471eb31c1a4|identified|https://github.com/fluxcd/source-controller/.github/workflows/release.yml@refs/tags/v1.7.0
docker.io/library/alpine:3.20|docker.io/library/alpine@sha256:d9e853e87e55526f6b2917df91a2115c36dd7c696a35be12163d44e6e2a4b6bc|unsigned|
docker.io/library/nginx:1.27|docker.io/library/nginx@sha256:6784fb0834aa7dbbe12e3d7471e69c290df3e6ba810dc38b34ae33d3c1c05f7d|unsigned|
ghcr.io/actions/actions-runner:latest|ghcr.io/actions/actions-runner@sha256:759a1d94a15b05941aba5196974ff43fe15b4cbba29b694b35cbc32a1166b232|unsigned|
ghcr.io/aquasecurity/trivy:0.57.1|ghcr.io/aquasecurity/trivy@sha256:5c59e08f980b5d4d503329773480fcea2c9bdad7e381d846fbf9f2ecb8050f6b|identified|https://github.com/aquasecurity/trivy/.github/workflows/reusable-release.yaml@refs/tags/v0.57.1
ghcr.io/astral-sh/uv:0.5.11|ghcr.io/astral-sh/uv@sha256:0ac957607303916420297a4c9c213bb33fbd3c888f9cd7f4f7273596ebf42b85|unsigned|
ghcr.io/cloudnative-pg/cloudnative-pg:1.25.0|ghcr.io/cloudnative-pg/cloudnative-pg@sha256:a27779ed10853ed607659ff9c7c51ae30b6b6c3ce204f58a2bf54c5d25e0e188|unsigned|
ghcr.io/dexidp/dex:v2.44.0|ghcr.io/dexidp/dex@sha256:5d0656fce7d453c0e3b2706abf40c0d0ce5b371fb0b73b3cf714d05f35fa5f86|identified|https://github.com/dexidp/dex/.github/workflows/artifacts.yaml@refs/tags/v2.44.0
ghcr.io/external-secrets/external-secrets:v1.0.0|ghcr.io/external-secrets/external-secrets@sha256:900fd543940efb2c3219a84c86daf855156c1dce108552c21b6f3bebc07b2f10|identified|https://github.com/external-secrets/external-secrets/.github/workflows/release.yml@refs/heads/main
ghcr.io/fluxcd/source-controller:v1.7.0|ghcr.io/fluxcd/source-controller@sha256:233e0a1e842cab6ad7d2ed876d39c03d80ba727f78a8b6f159f8b471eb31c1a4|identified|https://github.com/fluxcd/source-controller/.github/workflows/release.yml@refs/tags/v1.7.0
ghcr.io/github/github-mcp-server:latest|ghcr.io/github/github-mcp-server@sha256:f6056fc10bfffcc8c81a6417a2e9ca12808647e8dd6049642a4feaadee0e0f8a|identified|https://github.com/github/github-mcp-server/.github/workflows/docker-publish.yml@refs/tags/v2.1.0
ghcr.io/goreleaser/goreleaser:latest|ghcr.io/goreleaser/goreleaser@sha256:19ca96ff782e521af4002ca42dd42021d360a04a8d2a06bb79f720a284c3fee1|identified|https://github.com/goreleaser/goreleaser/.github/workflows/release.yml@refs/tags/v2.20.0
ghcr.io/kedacore/keda:2.18.0|ghcr.io/kedacore/keda@sha256:fe551cf11fbf720af72ad37da041dd7bc73f7eed81ca55cc0d2507d52e1d24a2|identified|https://github.com/kedacore/keda/.github/workflows/release-build.yml@refs/tags/v2.18.0
ghcr.io/kyverno/kyverno:v1.13.2|ghcr.io/kyverno/kyverno@sha256:aee05eb36f1f0059009758172bd44469c468e17c28b8ebeb3e1c6513193cd152|unsigned|
ghcr.io/renovatebot/renovate:latest|ghcr.io/renovatebot/renovate@sha256:fe058db9710840a4821f20190b3769e3ce709a049b8640aa2bf5f044969fe702|identified|https://github.com/renovatebot/renovate/.github/workflows/build.yml@refs/heads/main
ghcr.io/sigstore/cosign/cosign:latest|ghcr.io/sigstore/cosign/cosign@sha256:0f06154836d2de34f887a5c273506d52ca43edaa1d9e53e6510fa78a48f69c2d|identified|keyless@projectsigstore.iam.gserviceaccount.com
ghcr.io/sigstore/cosign/cosign:v3.0.2|ghcr.io/sigstore/cosign/cosign@sha256:b29487e48205d875c324c79583e2806d9d269c0fa299e0861bbec023d8430c8b|identified|keyless@projectsigstore.iam.gserviceaccount.com
ghcr.io/stefanprodan/podinfo:6.7.1|ghcr.io/stefanprodan/podinfo@sha256:862ca45e61b32392f7941a1bdfdbe5ff8b6899070135f1bdca1c287d0057fc94|identified|https://github.com/stefanprodan/podinfo/.github/workflows/release.yml@refs/tags/6.7.1
ghcr.io/zitadel/zitadel:v4.6.0|ghcr.io/zitadel/zitadel@sha256:9156e5d4f113206013e5e94839f4f16a868f943731798f62a7781e0d11630480|unsigned|
quay.io/argoproj/argocd:v2.13.2|quay.io/argoproj/argocd@sha256:1322e91b758b9d44db3af44f457c298831c57a8e1d635118910d35e71f822646|identified|https://github.com/argoproj/argo-cd/.github/workflows/image-reuse.yaml@refs/tags/v2.13.2
quay.io/cilium/cilium:v1.17.5|quay.io/cilium/cilium@sha256:baf8541723ee0b72d6c489c741c81a6fdc5228940d66cb76ef5ea2ce3c639ea6|identified|https://github.com/cilium/cilium/.github/workflows/build-images-releases.yaml@refs/tags/v1.17.5
quay.io/cilium/cilium:v1.18.3|quay.io/cilium/cilium@sha256:5649db451c88d928ea585514746d50d91e6210801b300c897283ea319d68de15|identified|https://github.com/cilium/cilium/.github/workflows/build-images-releases.yaml@refs/tags/v1.18.3
quay.io/cilium/operator-generic:v1.18.3|quay.io/cilium/operator-generic@sha256:b5a0138e1a38e4437c5215257ff4e35373619501f4877dbaf92c89ecfad81797|identified|https://github.com/cilium/cilium/.github/workflows/build-images-releases.yaml@refs/tags/v1.18.3
quay.io/jetstack/cert-manager-controller:v1.16.2|quay.io/jetstack/cert-manager-controller@sha256:0eec9c89554011c9aa16eea88ab89a91b32dc8d6eb96307b7fc2dcd6bbbc7fcf|key-signed|
registry.k8s.io/kube-apiserver:v1.31.0|registry.k8s.io/kube-apiserver@sha256:470179274deb9dc3a81df55cfc24823ce153147d4ebf2ed649a4f271f51eaddf|unsigned|
registry.k8s.io/pause:3.10|registry.k8s.io/pause@sha256:ee6521f290b2168b6e0935a181d4cff9be1ac3f505666ef0e3c98fae8199917a|identified|krel-trust@k8s-releng-prod.iam.gserviceaccount.com
gcr.io/distroless/static-debian12:nonroot|gcr.io/distroless/static-debian12@sha256:afa5c872c891853ca7fcf1f12c3edb23f7eeef36189728842dd51042ff57f7ab|identified|keyless@distroless.iam.gserviceaccount.com
ghcr.io/renovatebot/renovate:44.226.2|ghcr.io/renovatebot/renovate@sha256:c30c21d917b25cee1103fe8585bbc67bdb0a8792067237eae8d6734e83b4d485|identified|https://github.com/renovatebot/renovate/.github/workflows/build.yml@refs/heads/main
ghcr.io/fluxcd/source-controller:v1.6.0|ghcr.io/fluxcd/source-controller@sha256:44ea51a40e4da2c0f19427df3219f29b86c8fce38539d227f6ffc2bdc944036f|identified|https://github.com/fluxcd/source-controller/.github/workflows/release.yml@refs/tags/v1.6.0
quay.io/coreos/etcd:v3.5.0|quay.io/coreos/etcd@sha256:28759af54acd6924b2191dc1a1d096e2fa2e219717a21b9d8edf89717db3631b|unsigned|
IMAGES
summary
