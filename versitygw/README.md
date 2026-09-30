# @dataverket/versitygw

Everything a [versitygw](https://github.com/versity/versitygw) S3 gateway holds,
read as swamp data: its accounts, its buckets and their owners, every bucket's
settings, and whether the endpoint answers over a verified chain. Read-only. One
model type, `@dataverket/versitygw/gateway`.

| Method           | Reads                                | Records                                                                            |
| ---------------- | ------------------------------------ | ---------------------------------------------------------------------------------- |
| `health`         | `GET <healthPath>` on the S3 port    | Reachable, status, TLS verified or not, latency                                    |
| `accounts`       | admin `list-users`                   | One record per account: access key, role, user, group and project ids. No secret   |
| `buckets`        | admin `list-buckets`                 | One record per bucket: name, owner                                                 |
| `bucketSettings` | S3 API as root, per bucket           | Versioning, policy, ACL, object lock, ownership controls, CORS, tags               |
| `inventory`      | all of the above, in one execution   | All those records, each tagged with this inventory's id, and an `inventory` record |
| `check`          | the records of one inventory, no API | One `check` record: the rules applied and what they found                          |

Written and tested against versitygw v1.8.0.

## Credentials

versitygw has no read-only admin role: every admin call, reads included, signs
with the root key pair. A definition names where the pair is and never holds it.
There are two sources, and a definition names exactly one:

- `rootKeyFile`: a file of `NAME=value` lines, read at each call. Suits a file
  an operator's session writes before a run and removes after, or a file a
  process that owns the gateway already keeps.
- `rootKeyEnv: true`: swamp's own environment. Suits a key held only while an
  operator works, supplied by a secret manager's `run -- swamp ...`.

`accessKeyName` and `secretKeyName` (default `ROOT_ACCESS_KEY` and
`ROOT_SECRET_KEY`, the names versitygw itself reads) say which variables to
take, so one environment can serve several gateways.

What never leaves the method: `list-users` returns every account's secret key
and session token in clear, and the parser copies named fields into a record
type that has no field for either. The root access key is not recorded either: a
bucket root owns says `ownerIsRoot: true`, and an ACL or policy naming root
names `<root>`. Both halves of the root pair are masked in every error.

## A gateway

```sh
swamp model create @dataverket/versitygw/gateway s3-site \
  --global-arg adminUrl=http://localhost:7071 \
  --global-arg s3Url=https://s3.example.org:443 \
  --global-arg caFile=/etc/site/ca.crt \
  --global-arg rootKeyEnv=true

pass-cli run -- swamp model method run s3-site inventory
swamp model method run s3-site check
```

`adminUrl` is a base URL and may carry a path prefix. `region` (default
`us-east-1`) must be the one the gateway was started with: it rejects any other,
which this model reports as `IncorrectRegion` with both regions named. `caFile`
is for a gateway whose certificate a private CA signed; without it the system
store is used.

## Checking an inventory

`check` reads only the records its inventory wrote, found by the tag every one
of them carries, so a bucket deleted since, or a record another run left, cannot
enter the result. Without `inventoryId` it checks the latest inventory. The
rules, and the one parameter they take, are arguments:

| Rule                          | Finds                                                     |
| ----------------------------- | --------------------------------------------------------- |
| `bucket-owner-missing`        | A bucket whose owner is no longer an account              |
| `bucket-owner-not-same-named` | A bucket owned by root, or by an account of another name  |
| `account-owns-nothing`        | An account that owns no bucket                            |
| `account-role`                | A role outside `allowedRoles` (default `["user"]`)        |
| `versioning-enabled`          | Versioning enabled, saying when object lock requires it   |
| `bucket-public`               | A policy allowing an anonymous principal, or a public ACL |

```yaml
# a workflow step: fail the run when anything is found
- name: check
  task:
    type: model_method
    modelIdOrName: s3-site
    methodName: check
    inputs:
      rules: ["bucket-owner-missing", "account-role", "bucket-public"]
      allowedRoles: ["user", "userplus"]
      failOnFindings: true
```

The defaults describe one layout: one `user` account per writer, owning the
bucket of the same name, with versioning off and nothing public. A gateway laid
out otherwise names its own rules.

## Errors

A refusal is the gateway's S3 error code and message, e.g.
`PATCH /list-users: HTTP 403 SignatureDoesNotMatch: ...`, or
`XAdminAccessDenied` for a key that is not an admin's. A body the gateway
answers with that is not the document asked for (an empty body, a proxy's page,
truncated XML) is an error, never an empty list. `health` records an unreachable
endpoint or a chain that does not verify instead of failing, so a workflow can
decide.

## Development

```sh
deno test --allow-env --allow-read --allow-write
```

The unit tests replay answers recorded from a throwaway gateway (`fixtures/`),
and include a negative suite (`negative_test.ts`). `smoke/` runs the model
through swamp against two throwaway gateways in podman, one of them behind its
own CA; see `smoke/README.md`.
