# @dataverket/zitadel

[Zitadel](https://zitadel.com) for [swamp](https://github.com/swamp-club/swamp),
over its API: eight model types, one per resource, each with the whole life
cycle of that resource.

Forked from
[`@thomas/zitadel`](https://github.com/thomas-elliott/swamp-extensions) (MIT,
copyright Thomas Elliott), which is one model type, machine identities only, and
deliberately without hard deletes. The transport, the JWT service-account
authentication and the read and provisioning methods come from that work. This
fork splits it into a type per resource, the way `@dataverket/openstack` is
arranged, and fills in the rest of the CRUD: reading, renaming and deleting
projects and applications, human users, application and user keys, token and
metadata listing, and a password reset that mints a link rather than taking a
password.

## Model types

One instance per Zitadel organization, all five sharing the same global
arguments and the same service-user key.

### `@dataverket/zitadel/project`

| Method       | What it does                                                                                   |
| ------------ | ---------------------------------------------------------------------------------------------- |
| `list`       | Every project in the organization, one resource each                                           |
| `get`        | One project by id or name                                                                      |
| `ensure`     | Find or create by name, converging the authorization flags given                               |
| `update`     | Rename, or change `roleAssertion` / `roleCheck` / `hasProjectCheck`, leaving the rest as it is |
| `setState`   | `active` or `inactive` — reversible, and a no-op when it is already there                      |
| `delete`     | Guarded delete: `confirm` repeats the live name, `dryRun` only reports                         |
| `roleList`   | The project's roles, one resource each                                                         |
| `roleEnsure` | Find or create a role by key, converging its display name and group                            |
| `roleRemove` | Verify-first removal; a role has no deactivated state, so this one is a delete                 |

### `@dataverket/zitadel/app`

| Method         | What it does                                                                                                                                    |
| -------------- | ----------------------------------------------------------------------------------------------------------------------------------------------- |
| `list`, `get`  | A project's applications and their configuration, never a secret                                                                                |
| `ensureOidc`   | Find or create an OIDC client and converge it, role assertions and login UI included; the secret comes back once, on create                     |
| `ensureApi`    | Find or create an API application (a resource server for machine-to-machine calls)                                                              |
| `redirectSet`  | Add and remove redirect URIs by read-modify-write, so nothing else about a shared client changes, the role assertions and the login UI included |
| `update`       | Rename                                                                                                                                          |
| `setState`     | `active` or `inactive`                                                                                                                          |
| `secretRotate` | A new client secret, returned once                                                                                                              |
| `delete`       | Guarded delete, `confirm` + `dryRun`                                                                                                            |
| `keyCreate`    | A JSON key for private-key authentication, returned once                                                                                        |
| `keyList`      | The application's keys by id and expiry                                                                                                         |
| `keyDelete`    | Verify-first, `dryRun`-able                                                                                                                     |

### `@dataverket/zitadel/user`

Human and machine users, over the v2 user service.

| Method                                          | What it does                                                                                                                            |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------- |
| `list`, `get`                                   | Users, optionally only the humans or only the machines                                                                                  |
| `ensureMachine`                                 | Find or create a service user, converging name, description, token type                                                                 |
| `ensureHuman`                                   | Find or create a person, converging their name and email                                                                                |
| `update`                                        | Login name, a human's profile and email, a machine's name and token type                                                                |
| `setState`                                      | `active`, `inactive` or `locked`; `active` unlocks a locked user                                                                        |
| `delete`                                        | Guarded delete, `confirm` is the username, `dryRun` only reports                                                                        |
| `patCreate`, `patList`, `patRevoke`             | Personal access tokens: minted once, listed by id, revoked verify-first                                                                 |
| `keyCreate`, `keyList`, `keyDelete`             | Private keys, the same way                                                                                                              |
| `secretGenerate`, `secretRemove`                | A machine user's client secret                                                                                                          |
| `metadataSet`, `metadataList`, `metadataDelete` | Metadata, base64 on the wire and plain text in the stored resource                                                                      |
| `passwordResetLinkCreate`                       | A reset code returned once, or a link Zitadel mails                                                                                     |
| `passkeyRegistrationLinkCreate`                 | A passkey registration code returned once, or a link Zitadel mails; the person registers on the host the link names, without logging in |

### `@dataverket/zitadel/action`

Zitadel's v2 actions. A **target** is an endpoint of yours with a timeout and a
delivery style — `webhook` ignores the response, `call` lets it change the
outcome, `async` does not wait. An **execution** binds a condition to an ordered
list of targets.

| Method            | What it does                                                                                                      |
| ----------------- | ----------------------------------------------------------------------------------------------------------------- |
| `list`, `get`     | The targets, without their signing keys                                                                           |
| `ensure`          | Find or create a target and converge it; the signing key comes back once, and again on `rotateSigningKey`         |
| `delete`          | Guarded, `confirm` + `dryRun`                                                                                     |
| `executionList`   | Every condition and the targets it calls                                                                          |
| `executionSet`    | Bind one condition — a request, a response, an event or a named function — to targets in order                    |
| `executionRemove` | Clear a condition, which Zitadel does by setting it to no targets                                                 |
| `catalog`         | The services, methods and functions a condition may name **on this instance**; read it before writing a condition |
| `key*`            | A target's public keys: list, add, activate or deactivate, remove                                                 |

Zitadel resolves a target's host before accepting it and refuses one it cannot
resolve, as well as anything on the instance's `Actions.HTTP.DenyList`. It
reports that as `Errors.Target.DeniedURL` and nothing else, so `ensure` says
which endpoint and why instead.

### `@dataverket/zitadel/settings`

Read-only, with two exceptions. `read` fetches every settings kind in force for
one organization or for the instance — login, lockout, password complexity and
expiry, branding, domain, legal and support, security, the general instance
settings and the active identity providers — and stores one resource per kind,
each carrying the `scope` it came from: the organization's own, or inherited
from the instance. That is what an audit is actually asking, and it is one run
and one lock rather than ten.

The same run stores `oidc-tokens-instance`: how long access, ID and refresh
tokens live, read from the v1 Admin API, as Zitadel's durations and in seconds;
and one `secret-generator-<kind>` per kind of one-time code the instance makes
(`passwordlessInitCode` is the passkey registration code, `initCode` the
first-login code, and so on): its length, how long it stays valid, and its
character set — the shape of the codes, never a code. These are instance-wide,
so they come with an organization's read as well. A key that may read the
organization but not the instance gets a warning in the log and no such records,
and the rest of the run stands.

`securitySet` (iframe embedding and impersonation) and `loginTranslationSet` are
the only writes v2 exposes. `secretGeneratorSet` is one v1 Admin write, kept
because an operator mailing a passkey registration link has to decide how long
the code in it lives: it sets a kind's `expirySeconds`, its `length`, or both,
reads the generator first so the character set stays as it is (Zitadel's update
replaces every field, and a flag left out is a flag turned off), and reports a
value already in force as `unchanged`. It needs `iam.write`, the IAM_OWNER role.
Writing a login policy, lockout, password complexity, branding or legal links is
still v1 Management for an organization and v1 Admin instance-wide, and neither
is here: a key that can read every policy is a much smaller thing to hold than
one that can weaken them.

### `@dataverket/zitadel/grant`

`list`, `ensure` (converges the role set), `setState`, `delete` — which roles a
user holds on a project, and therefore what a token's role claim says.

### `@dataverket/zitadel/org`

`get`, `list`, `managerList` — read-only. Creating and deleting organizations
decides who exists on an instance, and stays a deliberate act in the console.

### `@dataverket/zitadel/system`

The instance's domain list, which is written by nobody but a System API user:
adding a custom domain, removing one and choosing the primary all need
`system.domain.write`, which only the system role `SYSTEM_OWNER` carries. A
System API user is a key named in Zitadel's configuration (`SystemAPIUsers`),
not a user in its database, so this type takes `systemKeyFile` and `systemUser`
instead of a service-user key, and nothing else: the signed assertion is the
bearer. The scope is four methods although the role could do more.

| Method             | What                                                                                                                         |
| ------------------ | ---------------------------------------------------------------------------------------------------------------------------- |
| `domainList`       | Every domain of the instance, with `primary` and `generated` flags, one resource each                                        |
| `domainAdd`        | A custom domain added, so requests with that Host are served and tokens issued with it as issuer; idempotent                 |
| `domainRemove`     | A custom domain removed, verify-first: `confirm` repeats it, a generated or primary domain is refused, `dryRun` only reports |
| `domainSetPrimary` | The domain Zitadel links to in a mail no request triggered; idempotent                                                       |

The instance is the one the System API lists, or `instanceId` when there are
several. A generated domain, `<random>.<ExternalDomain>`, is made by setup and
cannot be removed by anyone; the method says so before Zitadel does.

## How it authenticates

Three ways, one per definition. The usual one is a JWT private-key service
account: the definition names the key; the model signs a short-lived RS256
assertion per run and exchanges it at `/oauth/v2/token` for an access token,
cached in memory until shortly before it expires. No long-lived bearer token is
stored anywhere.

```yaml
# models/@dataverket/zitadel/project/zitadel-project.yaml
type: "@dataverket/zitadel/project"
globalArguments:
  apiUrl: https://zitadel.example.org
  keyJson: "${{ vault.get('infra', 'zitadel/key_json') }}"
```

Or keep the value out of the repository entirely and name a file instead, which
is read at call time:

```yaml
globalArguments:
  apiUrl: https://zitadel.example.org
  keyJsonFile: ~/.config/zitadel/admin.json
```

A leading `~/` is expanded from `HOME`, so one definition serves every operator
who keeps the file in the same place under their own home directory.

Quote the arguments to `vault.get`: `swamp model validate` only recognizes a
quoted vault expression, and warns that an unquoted one is "passed to the method
unchanged" — swamp's resolver does take a bare token verbatim, so the unquoted
form works, but the warning is noise you do not want in a repository.

The second way is a bearer token the definition names as a file, sent as it is
with no exchange, so the run is whoever the token belongs to. An operator's own
login can write such a file, and a workflow then acts as that person, in
Zitadel's audit log and in swamp's run record alike, while whoever runs the
workflow never reads the token:

```yaml
globalArguments:
  apiUrl: https://zitadel.example.org
  accessTokenFile: ~/.config/zitadel/me.token
```

The third is the System API user of `@dataverket/zitadel/system`, which takes
`systemKeyFile` and `systemUser` and no other credential; the signed assertion
is the bearer, verified against the public key the instance was configured with,
so the audience must be exactly what `ExternalDomain`, `ExternalPort` and
`ExternalSecure` build on the server.

Give one credential, never two; the `credential-named` check says so before a
method runs, and `reachable` proves it authenticates. `orgId` sets the
`x-zitadel-orgid` header when the service user administers more than one
organization.

The service user needs the manager roles for what you ask of it: `ORG_OWNER`
covers everything here, and `ORG_PROJECT_CREATOR` plus `ORG_USER_MANAGER` is the
narrower pair for a key that only provisions.

## What it will not do quietly

- **A hard delete is guarded.** `delete` re-reads the resource, refuses unless
  `confirm` repeats its live name, and takes `dryRun`, which reports what it
  would remove and calls nothing. Deactivating is reversible and is the first
  thing to reach for; every type that can be deactivated says so.
- **A delete of something already gone is not an error.** It stores the same
  `deletion` resource with `deleted: false` and an action of `unchanged`, so a
  workflow that runs twice stays green and the record still says what happened.
- **A credential is emitted once.** Client secrets, personal access tokens, key
  JSON and reset codes land in a spec marked sensitive, which swamp vaults and
  keeps out of logs. `patList` and `keyList` can say afterwards that a
  credential exists and when it expires, never what it is.
- **A password is never an argument.** A human sets their own password from the
  link `passwordResetLinkCreate` mints, and registers a passkey from the link
  `passkeyRegistrationLinkCreate` mints. A passkey binds to the host of the page
  it is made on, so that link's `urlTemplate` is how an account gets a passkey
  for a new name of the instance.
- **An ensure converges, it does not accumulate.** `grant ensure` sets the role
  set to exactly what was asked for; `redirectSet` changes only the allowlist.

- **A truncated list is refused.** Every search pages to the end; a result set
  larger than the paging guard raises rather than quietly storing a prefix. A
  429 or a 503 is retried twice, honouring `retry-after`.

## Data names a workflow can write

Every stored instance is keyed by the names a person types, never by an id
Zitadel assigned: `project-kubernetes`, `role-kubernetes-kube-admins`,
`app-kubernetes-kubelogin`, `user-svc-kubernetes`,
`grant-svc-kubernetes-kubernetes`. A workflow step can therefore assert on what
an earlier step made:

```yaml
- name: assert-app
  task:
    type: assert
    expr: >-
      data.latest("zitadel-app", "app-kubernetes-kubelogin").attributes.appType == "native" &&
      data.latest("zitadel-app", "app-kubernetes-kubelogin").attributes.authMethod == "none"
    message: the kubelogin client is not the public native client kubelogin needs
    severity: high
```

`smoke/workflow-zitadel-selftest.yaml` is that workflow in full, and the suite
runs it twice: the second run reports `unchanged` for every resource.

## What swamp does around a delete

Swamp reads a method's lifecycle kind from its name, and a method called
`delete`, `destroy` or `remove` means "the resource this model stands for is
gone" — after such a run it tombstones _every_ declared resource of the model.
These types hold a collection (every project of an organization, every user), so
their destructive methods declare `kind: "action"` and tombstone only the
instance that actually went away. A `dryRun` therefore leaves the stored data
exactly as it was, and deleting one project does not forget the others.

One rule still shows through: when the last stored resource of a model has been
deleted, swamp refuses a `read` or `update` until a create runs. `ensure`
declares `kind: "create"`, so it is the way back.

## Which API

Users speak the v2 user service (`/v2/users/…`), which is the supported surface
on Zitadel v4 and the only one that reaches keys, tokens, metadata and password
reset. Projects, applications, roles and grants speak the v1 Management API
(`/management/v1/…`), because their v2 services are still beta at v4. The
organization `list` is v2, `get` and `managerList` are v1. The system type
speaks the System API (`/system/v1/…`), which lists instances and keeps their
domains and is the only surface that may.

Three things the v2 service wants that v1 did not, and that the models handle
for you: the organization id in the body of a create (taken from `orgId`, or
looked up once from the service user's own organization); an explicit
`expirationDate` on every personal access token and user key, which is why it is
a required argument rather than an optional one; and a machine description that
is either absent or non-empty, so omitting it leaves any existing one alone.

## Development

```sh
~/.swamp/deno/deno check *.ts
~/.swamp/deno/deno test --allow-env --allow-read
swamp extension quality manifest.yaml --json
swamp extension push manifest.yaml --dry-run
```

The unit tests install a fake API caller through the `__setCaller` seam, so
nothing reaches an instance: a method that calls an endpoint the test did not
expect fails rather than passing quietly.

`smoke/` runs the models against a throwaway Zitadel in podman, and spends most
of its effort on what should not happen — a `confirm` that does not match, a
delete of something already gone, a credential that is missing or doubled, a
converge that must not clobber the rest of a client. See
[smoke/README.md](smoke/README.md).

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari;
the original work, `@thomas/zitadel`, is copyright 2026 Thomas Elliott under the
MIT License, whose notice LICENSE.md keeps.
