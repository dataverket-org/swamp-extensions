# Smoke and negative suite

What the unit tests cannot say: that a real `docker compose` starts Salmon from
the generated project, that a real kubectl mints the token, that Salmon accepts
it and issues one with the granted role, and that neither token shows up in what
swamp keeps. It runs against a throwaway kind cluster and one Salmon container,
and spends most of its checks on what should _not_ happen.

## Run it

```sh
# 1. where the cluster's kubeconfig goes; your own kubeconfig is never touched
export SMOKE_KUBECONFIG=$(mktemp -d)/kubeconfig

# 2. a kind cluster whose ServiceAccount issuer Salmon can reach, and a
#    kubeconfig that points at a closed port
./cluster.sh up
./cluster.sh dead

# 3. a swamp repository loading this extension from source, and the models
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none && swamp extension source add "$OLDPWD/..")
./models.sh

# 4. the suite
for b in a b c; do ./neg-$b.sh; done

# 5. and away
./cluster.sh down
```

`CLUSTER` names the kind cluster (default `salmon-smoke`), `SMOKE_WORK` the
directory for the extra kubeconfig file and the stand-in's note (default `.work`
here), `SMOKE_PORT` the host port Salmon is published on (default 18090; the
four ports after it are used too), and `SALMON_IMAGE` the Salmon image when it
is not the type's default. No step waits longer than three minutes.

## What each batch is for

| Batch | Needs the Salmon image | What it holds the extension to                                                                                                                                                                                                                                                                                                                                                                                                                                                     |
| ----- | ---------------------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a`   | yes                    | The path the README describes: `ensure` seeds Salmon and records ids that stay the same, `test` exchanges a ServiceAccount token of the cluster for one with the granted role, `revoke` makes the exchange fail with `invalid_target` and that refusal becomes the latest `result` with `passed: false`, `ensure` restores it, `stop` removes the container; a test that could not be made leaves the last result standing                                                         |
| `b`   | no                     | What is refused: an image that is not there (recorded as not running, with the reason), `revoke` without a grant; definitions that cannot be created at all: a namespace or ServiceAccount shaped like a flag or shell text, an issuer URL with a password (and the password nowhere in the repository), a wait of more than an hour; a namespace that does not exist, a cluster that does not answer, a missing kubeconfig, context or kubectl binary, a Salmon that is not there |
| `c`   | no                     | A discovery document that is a login page or names an endpoint that is not http, with no token minted for it; an issuer that repeats the token it was sent, in a refusal, in an error page and under another key, and one that issues a token that is not a JWT: the error and the recorded result say so and hold no token; a ServiceAccount that is not there is made on demand                                                                                                  |

Batches `b` and `c` use `standin.py`, a small stand-in for Salmon's issuer on
`SMOKE_PORT` + 1, so they need no image and no registry. It writes the last
subject token it was sent to `$SMOKE_WORK/subject-token` (mode 600); the harness
searches for that exact token, and for anything shaped like a JWT, in every
output and, at the end of each batch, in everything under the swamp repository:
records, logs, outputs and reports.

## Environment

The suite was run on 2026-11-10 on Linux x86_64 with rootless Podman and kind's
Podman provider, and that is the only environment it is known to work in.

| Needs          | Run with                    | For                                                            |
| -------------- | --------------------------- | -------------------------------------------------------------- |
| podman         | 4.9.3 rootless              | the kind node and the Salmon container                         |
| docker         | podman's `docker` command   | what the `stack` type runs; it reached Podman through it       |
| docker compose | v5.5.1 (the compose plugin) | `docker compose up`, `logs` and `down`, as the type calls them |
| kind           | 0.33.0                      | the cluster (Kubernetes v1.37.0)                               |
| kubectl        | 1.37.2                      | the scripts, and the `token-exchange` type itself              |
| python3        | 3.15.2                      | `standin.py`, standard library only                            |
| curl           | 8.23.0                      | waiting for the stand-in to listen                             |
| jq             | 1.8.2                       | the assertions                                                 |
| swamp          | 20261110                    | the model methods                                              |

- The cluster is made by `cluster.sh up` with
  `KIND_EXPERIMENTAL_PROVIDER=podman kind create cluster --name <name> --kubeconfig <file>`
  and a config that names the ServiceAccount issuer after the control-plane
  container. kind calls its Podman provider experimental.
- The kubeconfig is always that explicit file. Every script takes it as
  `SMOKE_KUBECONFIG`, passes it and the context to every command, and refuses a
  context that is not `kind-*`. The models get the same file through the
  `kubeconfig` argument. Nothing reads or writes the default kubeconfig.
- The `stack` type runs `docker`. Here that was Podman's `docker` command with
  the compose plugin talking to the rootless Podman socket. Salmon joins the
  `kind` network that kind's Podman provider made, and reaches the API server by
  the name of the control-plane container.
- What rootless means here: Salmon is published on a host port, which must be
  1024 or above (the default is 18090), and nothing needs a LoadBalancer
  address. No case fails because of Podman: every refusal is made on purpose.
- Size, as measured with `podman stats` every two seconds while the suite ran on
  a new cluster: the kind node grew to about 530 MB of memory and used a third
  of a CPU core on average, half a core at most; the Salmon container stayed
  under 11 MB and a sixth of a core. swamp, kubectl and compose run on the host.
  The three batches took about 130 seconds, the cluster another 40.
- The Salmon image, `registry.dataverket.org/tools/salmon:latest` (56 MB), was
  pulled without a login.
- macOS: run on Linux x86_64; macOS on Apple silicon is expected to work with a
  Podman machine of at least 2 CPUs and 2 GiB, not yet run there.
- Docker (kind's default provider, without the environment variable, and the
  real `docker compose`) probably works, and is not tested.

## Last run

2026-11-10, kind 0.33.0 on rootless podman 4.9.3, Kubernetes v1.37.0, compose
v5.5.1, swamp 20261110, on the final shared layer in `lib/`: 17, 22 and 16
checks, all passed. No log of a run is kept: the scripts print one line per
check, and what swamp wrote lives in the throwaway repository `$REPO` until you
delete it.
