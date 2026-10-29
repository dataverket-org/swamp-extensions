# @dataverket/salmon

A throwaway [Salmon](https://git.dataverket.org/dataverket/salmon) for
end-to-end tests of anything that takes Salmon's tokens: database validators,
message brokers, services. Two model types.

## `@dataverket/salmon/stack`

One container of the published Salmon image: an in-memory SQLite database, a
`userdb` identity provider with Salmon's reference people, and the apps, trust
and grants a test needs, loaded with Salmon's `--seed` before it serves. The
image must be one with `--seed` (Salmon #60 or later).

- `ensure` starts Salmon with the seed, or leaves it running, and waits until
  its discovery document answers. Salmon refuses a bad seed and exits; `ensure`
  then fails with Salmon's log.
- `revoke --input app=<key>` restarts Salmon without the trust's grants at that
  app, to test a refusal. The next `ensure` restores them.
- `stop` removes the container and the network.

Everything lives in Salmon's memory, signing keys included: a restart starts
from the seed again with new keys.

| Argument     | Default                                       |                                                                                                      |
| ------------ | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `project`    | `salmon-e2e`                                  | compose project; one stack per name                                                                  |
| `image`      | `registry.dataverket.org/tools/salmon:latest` | pin `sha-<short>` for reproducible runs                                                              |
| `pullPolicy` | `missing`                                     | when docker pulls the image: `always` (every `ensure`, so `latest` is current), `missing` or `never` |
| `issuerUrl`  | `http://localhost:8080/issuer/`               | the issuer as Salmon's clients reach it; must end `/issuer/`                                         |
| `port`       | `8080`                                        | host port Salmon is published on                                                                     |
| `networks`   | `[]`                                          | existing docker networks Salmon also joins, e.g. `kind`                                              |
| `name`       | `e2e`                                         | fixture name; ids are derived from the project, it and each app's key                                |
| `owners`     | `[users/Salmon-Registry-Administrator]`       | groups that own the seeded apps and trust                                                            |
| `apps`       | `[]`                                          | `{key, name}`; grants refer to an app by `key`                                                       |
| `trust`      | none                                          | `{issuer, subject, audience?, insecure?}` of the workload's token                                    |
| `grants`     | `[]`                                          | `{app, role}`, role `users/Registry-Push` by default                                                 |

The `stack` record carries `apps` (ids by key), `trustId` and `grants` (with
`revoked`), for CEL. The ids are the same on every run.

The people, in the `userdb` provider `users`: alice is in `Salmon-Administrator`
(Salmon's admins), bob in `Salmon-Registry-Administrator` and `Registry-Push`,
carol in `Salmon-Registry-Viewer` and `frank-viewer`, dave in no group. Every
email is `<name>@salmon.local` and every password is `password`. `Registry-Push`
is managed by `Salmon-Registry-Administrator`, so it can be granted; Salmon
checks that on every exchange too.

## `@dataverket/salmon/token-exchange`

`test` mints a ServiceAccount token from a cluster, exchanges it at Salmon (RFC
8693, `client_id` = the trust, `audience` = an app) and records the token's
`sub` and `roles`, never the token. It fails with Salmon's error when the
exchange is refused.

## Commands

The types drive docker and kubectl as subprocesses, with arguments as argv
arrays, never through a shell:

- `stack`: `docker compose -f - up` with the generated project on stdin,
  `docker compose -p <project> logs|down` and `docker ps` to see whether Salmon
  still runs. `project` is restricted to `[a-z0-9][a-z0-9_-]*`. The seed and
  `salmon.yaml` travel inside the project as compose configs.
- `token-exchange`: `kubectl --context <ctx> -n <ns> get|create serviceaccount`
  and `create token`.

## A kind cluster as the workload's issuer

Salmon runs in a container, so it cannot reach a kind API server at `127.0.0.1`.
Give the cluster an issuer named after its control-plane container and let
Salmon join the `kind` network:

```yaml
# kind cluster config
kubeadmConfigPatches:
  - |
      kind: ClusterConfiguration
      apiServer:
        extraArgs:
          service-account-issuer: https://<cluster>-control-plane:6443
          service-account-jwks-uri: https://<cluster>-control-plane:6443/openid/v1/jwks
```

The keys must be readable without credentials:
`kubectl create clusterrolebinding oidc-anon --clusterrole=system:service-account-issuer-discovery --group=system:unauthenticated`.

```yaml
# stack
globalArguments:
  issuerUrl: http://localhost:8080/issuer/
  networks: [kind]
  name: orders
  apps: [{ key: db, name: orders database }]
  trust:
    issuer: https://<cluster>-control-plane:6443
    subject: system:serviceaccount:default:salmon-token-exchange-test
    insecure: true # kind's self-signed certificate
  grants: [{ app: db }]
---
# token-exchange
globalArguments:
  issuerUrl: ${{ data.latest("stack", "stack").attributes.localIssuerUrl }}
  audience: ${{ data.latest("stack", "stack").attributes.issuerUrl }}
  kubeContext: kind-<cluster>
  trustId: ${{ data.latest("stack", "stack").attributes.trustId }}
  requestAudience: ${{ data.latest("stack", "stack").attributes.apps.db }}
```

`ensure` and `test` then exchange a token for one carrying
`roles: [users/Registry-Push]`; after `revoke --input app=db` the exchange fails
with `invalid_target`.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Linus Johansen.
