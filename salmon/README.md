# @dataverket/salmon

A throwaway [Salmon](https://git.dataverket.org/dataverket/salmon) for
end-to-end tests of anything that takes Salmon's tokens: database validators,
message brokers, services. Three model types.

## `@dataverket/salmon/stack`

The published Salmon image with a Postgres and an OpenLDAP seeded with Salmon's
reference directory, as one docker compose project generated in code.

- `ensure` starts the project, or leaves it running, and waits until Salmon's
  discovery document answers. Only Salmon's port is published.
- `stop` removes the containers, the network and the volumes.

| Argument    | Default                                       |                                                              |
| ----------- | --------------------------------------------- | ------------------------------------------------------------ |
| `project`   | `salmon-e2e`                                  | compose project; one stack per name                          |
| `image`     | `registry.dataverket.org/tools/salmon:latest` | pin `sha-<short>` for reproducible runs                      |
| `issuerUrl` | `http://localhost:8080/issuer/`               | the issuer as Salmon's clients reach it; must end `/issuer/` |
| `port`      | `8080`                                        | host port Salmon is published on                             |
| `networks`  | `[]`                                          | existing docker networks Salmon also joins, e.g. `kind`      |

The directory: alice is in `Salmon-Administrator` (Salmon's admins), bob in
`Salmon-Registry-Administrator`, carol in `Salmon-Registry-Viewer`, dave in no
group, and `Registry-Push` is a role `Salmon-Registry-Administrator` manages, so
a team of that group may grant it to a trust. Every password is `password`.

## `@dataverket/salmon/fixture`

The team, apps, trust and grants one test needs, written into the stack's
database with SQL (Salmon has no API for them yet). Ids are derived from the
project, the fixture's `name` and each entry's key, so `seed` replaces the
previous run's rows. `revoke` deletes the trust's grants at one app, to test a
refusal. Salmon still checks with LDAP on every exchange that the team's group
manages each granted role.

## `@dataverket/salmon/token-exchange`

`test` mints a ServiceAccount token from a cluster, exchanges it at Salmon (RFC
8693, `client_id` = the trust, `audience` = an app) and records the token's
`sub` and `roles`, never the token. It fails with Salmon's error when the
exchange is refused.

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
---
# fixture
globalArguments:
  project: ${{ data.latest("stack", "stack").attributes.project }}
  name: orders
  team: { name: orders e2e }
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
  trustId: ${{ data.latest("fixture", "fixture").attributes.trustId }}
  requestAudience: ${{ data.latest("fixture", "fixture").attributes.apps.db }}
```

`ensure`, `seed` and `test` then exchange a token for one carrying
`roles: [ldap/Registry-Push]`; after `revoke --input app=db` the exchange fails
with `invalid_target`.
