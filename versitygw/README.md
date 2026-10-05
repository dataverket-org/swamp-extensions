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
with the root key pair. There are three sources, and a definition names exactly
one:

- `rootKeyFile`: a file of `NAME=value` lines, read at each call. Suits a file
  an operator's session writes before a run and removes after, or a file a
  process that owns the gateway already keeps.
- `rootKeyEnv: true`: swamp's own environment. Suits a key held only while an
  operator works, supplied by a secret manager's `run -- swamp ...`.
- `rootAccessKey` and `rootSecretKey`, always together: the pair as values,
  written as vault expressions so the definition stores only the reference.
  Suits a key a process owns and runs with unattended, such as a test gateway's.

The first two need a person or a process to put the key where the definition
looks; the third lets any run that can open the vault sign as root, so it is the
choice when that is what is wanted. `accessKeyName` and `secretKeyName` (default
`ROOT_ACCESS_KEY` and `ROOT_SECRET_KEY`, the names versitygw itself reads) say
which variables to take from a file or the environment, so one environment can
serve several gateways.

```yaml
globalArguments:
  adminUrl: http://localhost:7071
  s3Url: https://s3.example.org:443
  rootAccessKey: ${{ vault.get("test", "gateway-root-access") }}
  rootSecretKey: ${{ vault.get("test", "gateway-root-secret") }}
```

What never leaves the method: `list-users` returns every account's secret key
and session token in clear, and the parser copies named fields into a record
type that has no field for either. The root access key is not recorded either: a
bucket root owns says `ownerIsRoot: true`, and an ACL or policy naming root
names `<root>`. Both halves of the root pair are masked in every error.

Two pre-flight checks come with the type: `root-key-named` (exactly one source,
the values whole, not empty, no whitespace) and `admin-reachable` (the admin API
accepts the pair's signature). Every method here only reads, and swamp runs
checks by itself only before methods that change something, so run them with
`swamp model validate <name>`.

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

`caFile` and `rootKeyFile` may be relative, and are then taken from the
repository root, so a definition can name a file checked in beside it and work
from any directory. `adminUrl` is a base URL and may carry a path prefix.
`region` (default `us-east-1`) must be the one the gateway was started with: it
rejects any other, which this model reports as `IncorrectRegion` with both
regions named. `caFile` is for a gateway whose certificate a private CA signed;
without it the system store is used.

## Other backends

The bucket settings and the rules over them are plain S3, so the same model type
reads a Ceph radosgw, or any S3 endpoint, through `backend`:

| `backend`   | Accounts and buckets                                                                                                                                         | Key pair                                                                                                                                        |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------ | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `versitygw` | The admin API, as above; the default                                                                                                                         | The root account                                                                                                                                |
| `rgw`       | radosgw's admin ops API at `adminUrl`, `http://host:8000/admin`: users with their caps, buckets with their owners; the user holding the key pair is left out | An admin user with `users=read` and `buckets=read` caps, and the `system` flag, which is what lets it read other users' bucket settings over S3 |
| `s3`        | No admin API and no accounts; `GET /` lists the key's own buckets, each marked root-owned                                                                    | Any key pair                                                                                                                                    |

```sh
swamp model create @dataverket/versitygw/gateway ceph \
  --global-arg backend=rgw \
  --global-arg adminUrl=http://ceph.example.org:8000/admin \
  --global-arg s3Url=http://ceph.example.org:8000 \
  --global-arg healthPath=/ \
  --global-arg rootKeyFile=~/.config/ceph/admin.env \
  --global-arg accessKeyName=AWS_ACCESS_KEY_ID \
  --global-arg secretKeyName=AWS_SECRET_ACCESS_KEY
```

Neither backend has versitygw's health path: give `healthPath=/`, and the
endpoint counts as reachable when it answers any status below 500. A user's role
is `user`, or `admin` when it carries the `system` or `admin` flag or caps over
users or buckets. radosgw answers a subresource it does not implement,
`ownershipControls` among them, with the bucket's object listing; the model
reads that as the setting being absent. On the `s3` backend `check` skips the
account and owner rules, since there is nothing to read for them. Every
inventory record names the backend and the region its records came from.
Verified against the radosgw of an Incus and Ceph testbed on 2026-10-05.

## Checking an inventory

`check` reads only the records its inventory wrote, found by the tag every one
of them carries, so a bucket deleted since, or a record another run left, cannot
enter the result. Without `inventoryId` it checks the latest inventory. The
rules, and the parameters they take, are arguments:

| Rule                          | Finds                                                                                                                           |
| ----------------------------- | ------------------------------------------------------------------------------------------------------------------------------- |
| `bucket-owner-missing`        | A bucket whose owner is no longer an account                                                                                    |
| `bucket-owner-not-same-named` | A bucket owned by root, or by an account of another name                                                                        |
| `account-owns-nothing`        | An account that owns no bucket                                                                                                  |
| `account-role`                | A role outside `allowedRoles` (default `["user"]`)                                                                              |
| `versioning-without-lock`     | Versioning enabled or suspended on a bucket without object lock: every non-current version stays until deleted by id            |
| `lock-without-versioning`     | Object lock on an unversioned bucket, which S3 never allows and versitygw permits: a locked object cannot be overwritten at all |
| `lock-mode`                   | A default retention mode outside `allowedLockModes` (default `["GOVERNANCE"]`)                                                  |
| `versioning-enabled`          | Versioning enabled for any reason, object lock included; not on by default                                                      |
| `bucket-public`               | A policy allowing an anonymous principal, or a public ACL                                                                       |

Versioning and object lock are two settings that S3 ties together one way: a
bucket with lock is versioned, because lock protects versions. The three lock
rules judge each combination: versioning without lock is a bucket that keeps
every old version for no stated reason; lock without versioning is a gateway
quirk; and the default retention mode is the commitment to judge, since
`COMPLIANCE` can be shortened by nobody, the root account included, until it
expires. A gateway where compliance retention is wanted names it in
`allowedLockModes`. `versioning-enabled` is the older, blunter rule, for a
gateway meant to hold no versioned bucket at all; it is not in the defaults.

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
bucket of the same name, versioning only where object lock requires it,
`GOVERNANCE` as the only default retention, and nothing public. A gateway laid
out otherwise names its own rules: a radosgw where one user owns several buckets
drops `bucket-owner-not-same-named`.

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
