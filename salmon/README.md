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

| Argument              | Default                                       |                                                                                                      |
| --------------------- | --------------------------------------------- | ---------------------------------------------------------------------------------------------------- |
| `project`             | `salmon-e2e`                                  | compose project; one stack per name                                                                  |
| `image`               | `registry.dataverket.org/tools/salmon:latest` | pin `sha-<short>` for reproducible runs                                                              |
| `pullPolicy`          | `missing`                                     | when docker pulls the image: `always` (every `ensure`, so `latest` is current), `missing` or `never` |
| `issuerUrl`           | `http://localhost:8080/issuer/`               | the issuer as Salmon's clients reach it; must end `/issuer/`                                         |
| `port`                | `8080`                                        | host port Salmon is published on                                                                     |
| `networks`            | `[]`                                          | existing docker networks Salmon also joins, e.g. `kind`                                              |
| `upTimeoutSeconds`    | `300`                                         | how long `docker compose up` may take, the image pull included, before it is stopped                 |
| `startTimeoutSeconds` | `120`                                         | how long Salmon may take to answer discovery once its container runs                                 |
| `name`                | `e2e`                                         | fixture name; ids are derived from the project, it and each app's key                                |
| `owners`              | `[users/Salmon-Registry-Administrator]`       | groups that own the seeded apps and trust                                                            |
| `apps`                | `[]`                                          | `{key, name}`; grants refer to an app by `key`                                                       |
| `trust`               | none                                          | `{issuer, subject, audience?, insecure?}` of the workload's token                                    |
| `grants`              | `[]`                                          | `{app, role}`, role `users/Registry-Push` by default                                                 |

The `stack` record carries `apps` (ids by key), `trustId` and `grants` (with
`revoked`), for CEL. The ids are the same on every run.

When `ensure`, `revoke` or `stop` fails, the method still fails, and first
writes the record with `error` (why, one line of at most 400 characters) and
`running` as `docker ps` showed it afterwards, so an older record cannot go on
saying that all is well. `error` is empty after a method that succeeded. In a
record with an `error`, `grants[].revoked` is what was asked for, not what is
known to hold. Nothing is torn down on a failure: a Salmon that started and did
not answer keeps running so its log can be read, and a `compose up` that was
stopped half way can leave a created container and the project's network. `stop`
removes all of it. A cancelled run writes no record.

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

The `result` record is the outcome of the last exchange Salmon answered. A
passed one has `passed: true`, the token's `tokenSubject` and `roles`,
`httpStatus` and an empty `error`. When Salmon refuses, or answers with
something that is not a token, the method fails as before and first writes
`passed: false` with `httpStatus` and the reason in `error`, so
`data.latest(...).attributes.passed` is never left true by an older run. A test
that could not be made at all (no Salmon, no discovery document, kubectl failed,
the request could not be sent) only fails and writes nothing: it says nothing
about the grant.

The ServiceAccount is created when the cluster does not hold it, and it is kept:
`test` never deletes it, so later runs reuse it. Remove it yourself, or with the
cluster, when the tests are done.

The token endpoint is read from Salmon's discovery document and must be an http
or https URL without a user or password; anything else is refused before a token
is minted. It does not have to share the issuer's origin: RFC 8414 does not ask
for that, and Salmon names the host of its configured issuer (`localhost`) also
when it is asked on `127.0.0.1`.

| Argument          | Default                        |                                                                             |
| ----------------- | ------------------------------ | --------------------------------------------------------------------------- |
| `issuerUrl`       | `http://localhost:8080/issuer` | Salmon's issuer; the token endpoint is read from its discovery document     |
| `kubeContext`     | required                       | kubeconfig context of the cluster that mints the token                      |
| `kubeconfig`      | none                           | kubeconfig file; `KUBECONFIG` or `~/.kube/config` when left out             |
| `namespace`       | `default`                      | namespace of the ServiceAccount                                             |
| `serviceAccount`  | `salmon-token-exchange-test`   | the ServiceAccount whose token is exchanged                                 |
| `trustId`         | required                       | the Salmon trust, sent as `client_id`                                       |
| `requestAudience` | none                           | app id sent as the RFC 8693 `audience`                                      |
| `audience`        | `issuerUrl` with a final `/`   | `aud` of the minted ServiceAccount token                                    |
| `scope`           | `openid`                       |                                                                             |
| `tokenDuration`   | `10m`                          | lifetime of the minted token, as `kubectl create token --duration` takes it |
| `kubectlBinary`   | `kubectl`                      | the kubectl to run                                                          |

## Commands

The types drive docker and kubectl as subprocesses, with arguments as argv
arrays, never through a shell. Every process has a time limit; at the limit, or
when the run is cancelled, the process that was started gets SIGTERM, then
SIGKILL two seconds later, and two seconds after that its output is no longer
waited for. Only that one process is signalled, not its children; see "What a
time limit leaves behind" below.

| Type             | Command                                                                              | Time limit                    |
| ---------------- | ------------------------------------------------------------------------------------ | ----------------------------- |
| `stack`          | `docker compose -f - up -d --wait --remove-orphans`, the generated project on stdin  | `upTimeoutSeconds`, 300 s     |
| `stack`          | `docker ps -q --filter label=...`, to see whether Salmon still runs                  | 30 s                          |
| `stack`          | `docker compose -p <project> logs --tail 20 salmon`, for the error of a failed start | 30 s                          |
| `stack`          | `docker compose -p <project> down --volumes --remove-orphans`                        | 120 s                         |
| `token-exchange` | `kubectl get serviceaccount <name> -n <ns> -o json`                                  | 30 s request, stopped at 35 s |
| `token-exchange` | `kubectl create serviceaccount <name> -n <ns>`                                       | the same                      |
| `token-exchange` | `kubectl create token <name> -n <ns> --duration=<d> --audience=<aud>`                | the same                      |

Before a method runs, a pre-flight check runs `docker compose version` for
`stack` and `<kubectlBinary> version --client` for `token-exchange` (20 s each),
so a missing binary is said in one sentence before anything is started.

kubectl is given `--context`, `--kubeconfig` when set, and
`--request-timeout=30s`. `project` is restricted to `[a-z0-9][a-z0-9_-]*`;
`namespace` and `serviceAccount` must be Kubernetes names and are refused before
anything runs when they are not. The seed and `salmon.yaml` travel inside the
project as compose configs. No long-lived process is kept: nothing is
port-forwarded, Salmon is reached on its published port.

The three HTTP requests have limits too, the body of the answer included: 5 s
for one probe of discovery while the stack starts, 15 s for the discovery
document and 30 s for the exchange. A Salmon that accepts a connection and never
answers therefore cannot hold a method, and `startTimeoutSeconds` holds.

A kubectl limit also covers whatever the kubeconfig makes kubectl run: with an
exec credential plugin, an interactive login must finish within the 35 s of one
kubectl call, or the call is stopped. Log in before running `test`.

### What a time limit leaves behind

Seen on 2026-11-10 with rootless Podman 4.9.3, where `docker` is Podman's
command and `docker compose` starts the compose plugin as a child process:
`ensure` with `upTimeoutSeconds: 1` against an image that had to be pulled. At
one second `podman compose` ended on SIGTERM. Its child, `docker-compose`, was
not signalled and ran on for about four seconds, until its output was no longer
read: it finished the pull and created the container, and then ended without
starting it. The method failed about five seconds after it began to wait, with
the error that names `upTimeoutSeconds`. Left behind: the pulled image, the
container in state `Created`, and the project's network; no process. The record
said `running: false` with the error, and `stop` removed the container and the
network. With the real Docker CLI the plugin runs inside the `docker` process
tree in another way; that was not tried.

No token is an argument of a command. The ServiceAccount token is read from
kubectl's standard output, which is never copied into an error; what kubectl or
compose write to standard error, Salmon's log lines in a failed start, and
Salmon's answer to a refused exchange are redacted (the token that was sent word
for word, and anything shaped like a JWT, a bearer token or a `token=` pair),
shortened, and only then put in an error or a record. The redaction does not
know what a word means: in a description such as `token: expired` the word after
the colon is blanked too. That is left as it is; a blanked harmless word costs
less than a token in a log.

`issuerUrl` of both types must not hold a user or password, the part before an
`@` in the host, and is refused when it does: the URL is logged, recorded,
written into Salmon's configuration and, for `token-exchange`, becomes the
audience of the minted token.

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
  kubeconfig: /path/to/kind.kubeconfig # optional
  trustId: ${{ data.latest("stack", "stack").attributes.trustId }}
  requestAudience: ${{ data.latest("stack", "stack").attributes.apps.db }}
```

`ensure` and `test` then exchange a token for one carrying
`roles: [users/Registry-Push]`; after `revoke --input app=db` the exchange fails
with `invalid_target`.

## Changes in 2026.11.10.1

No data name changed (`stack`, `result`) and no record field was removed or
changed in meaning. What a user of 2026.10.29.2 will see:

- Time limits where there were none, as in the table under Commands, and on the
  HTTP requests. A `docker compose up` that pulls a large image over a slow link
  may need a higher `upTimeoutSeconds`; it and `startTimeoutSeconds` are at
  most 3600.
- Refused arguments, already when a definition is created: an `issuerUrl` with a
  user or password, on both types; on `token-exchange`, a `namespace` or
  `serviceAccount` that is not a Kubernetes name. At run time, an `audience` or
  `tokenDuration` that holds a line break.
- A discovery document that is not a JSON object, or whose `token_endpoint` is
  missing, not an http or https URL, or holds a user or password, is refused.
  Before, a missing `token_endpoint` fell back to `<issuer>/token`.
- Error texts. For docker: `<command> failed (exit N): <stderr>`, one redacted
  line of at most 400 characters of the tool's own words, compose's progress
  lines left out. A failed `docker compose up` is followed, on further lines, by
  Salmon's last 20 log lines, redacted and at most 4000 characters. For kubectl:
  `kubectl <command> failed: <kubectl's sentence>`, one line.
- A missing binary, a time limit and a cancelled run each have their own
  sentence. A `docker compose up` that hits its limit names `upTimeoutSeconds`,
  and it or a cancelled one fails without Salmon's log.
- Salmon's refusal of an exchange is now one line, redacted and cut at 500
  characters. New errors: `kubectl create token ... printed no token`, an
  `access_token` that is not a JWT, a discovery document that is not one, an
  exchange that could not be sent (with the endpoint).
- New record fields: `error` on `stack`; `httpStatus` and `error` on `result`.
  Records written by earlier versions do not have them. A failed `ensure`,
  `revoke` or `stop` and a refused exchange now write a record before they fail,
  as described above; before, a failure wrote nothing and the last good record
  stayed the latest.
- kubectl is called with `--context <ctx> --request-timeout=30s` before the
  command and `-n <ns>` after it; before, `-n` came first and there was no
  request timeout. The audience is passed as `--audience=<value>`.
- A pre-flight check on each type that its binary runs, as described under
  Commands. Every method declares `kind: action`; swamp treated them as changing
  something before as well.
- New optional arguments: `upTimeoutSeconds` on `stack`, `kubeconfig` on
  `token-exchange`.
- A ServiceAccount that another run created between the read and the create is
  no longer an error.

## Testing

`deno task test` runs the unit tests: the compose file, the configuration and
the seed that Salmon is started with, and each method of both types run through
swamp's `createModelTestContext` with a stub `docker`/`kubectl` and a stub
`fetch` that answer only what the test lists. They pin what a method writes and
logs on success, and what it records and refuses on failure: a refused
`compose up` or `down`, an app the fixture grants nothing at, a refused
exchange, an issuer that does not answer. The stubs are no model of Salmon or a
cluster; the live suite in `smoke/` was run with rootless Podman and kind (the
Podman provider): a kind cluster as the issuer of the workload's token, the
Salmon container, the exchange, the revoke and the refusals. `smoke/README.md`
in the source repository says what it needs and how to run it.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Linus Johansen.
