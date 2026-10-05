# @dataverket/forgejo

Administration of a self-hosted [Forgejo](https://forgejo.org) (or Gitea) server
for [swamp](https://github.com/swamp-club/swamp), over its `/api/v1` REST API
with a scoped access token. One model type, `@dataverket/forgejo`.

This is a fork of
[`@thomas/forgejo`](https://github.com/thomas-elliott/swamp-extensions)
2026.09.04.2 (MIT, copyright 2026 Thomas Elliott) merged with the methods
dataverket had published as add-ons to it, so one package owns the type and
nothing depends on code outside it. The upstream base is kept as written apart
from what [Changes from upstream](#changes-from-upstream) lists; the upstream
work is credited in [LICENSE.md](./LICENSE.md).

## Scope

This extension can hold an admin-scoped token, so what it does is deliberate:

- **Find-or-create provisioning.** Every `*_ensure` probes by name first
  (absent, create; present, converge the given settings via PATCH) and reports
  `action: created | updated | unchanged`, so a rerun in a pipeline is a no-op
  when nothing changed.
- **Reversible lifecycle.** `repo_archive` and `repo_unarchive` are idempotent
  and undo each other.
- **Verify-first deletes.** `repo_delete`, `org_delete`, `push_mirror_delete`
  and `runner_prune` read before they remove. A repository already gone is a
  no-op, one with commits is refused unless `allowContent` says otherwise, and
  an organization that still holds repositories is refused and names them,
  because Forgejo has no undelete. A failed migration's empty shell repository
  is detected and reported by `mirror_ensure`, never deleted on its own.
- **One irreversible merge.** `pr_merge` writes to the base branch. It refuses a
  pull request that is closed, merged, draft or not reported mergeable, and
  refuses a head whose CI state is not `success` unless `force=true`. `force`
  overrides the CI gate only, never a conflict.
- **Drift is refused, not ignored.** A mirror's source is fixed at migration;
  asking for another source on an existing mirror is an error, as is a name
  collision with a repository that is not a mirror.
- **Webhooks are read and repointed, never created.** `webhook_audit` reports
  where every hook posts; `webhook_retarget` writes `config.url` alone and never
  sends a `secret` key, which would overwrite the one the CI server relies on. A
  hook URL's query string is treated as a credential: reported URLs have their
  query values redacted, matching compares scheme, host and path only, and a
  retarget carries the existing query over verbatim.
- **No secret is recorded or logged.** A pull mirror's source token and a push
  mirror's remote credential are sent to Forgejo once and never read back. An
  Actions secret's value goes to Forgejo and only its name and scope are
  recorded. The runner registration token is marked sensitive, so swamp vaults
  it and records a reference. A token the forge echoes back in an error is
  masked before it becomes data.

## Authentication

A Forgejo access token (your avatar, Settings, Applications), sent as
`Authorization: token <t>`. Scopes for the full surface:

```
write:repository, write:organization, write:issue, read:admin, read:misc, read:user
```

`read:admin` is only exercised by `user_list`; `read:misc` only by `health`;
`write:issue` by the issue and label methods. The token's user must be a site
admin for `user_list` and for the listing methods to see private repositories
across all owners. Token CRUD (`/users/{u}/tokens`) is basic-auth only, so this
model never mints or revokes tokens. `migrations.ALLOW_LOCALNETWORKS=false`
makes private-address mirror sources fail with HTTP 422; GitHub sources are
unaffected.

## Use

```sh
swamp extension pull @dataverket/forgejo
swamp model create @dataverket/forgejo forge \
  --global-arg apiUrl=https://git.example.com \
  --global-arg 'token=${{ vault.get("infra", "forgejo/api_token") }}'
```

Optional global argument: `httpTimeoutMs` (default 30000).

```sh
# find-or-create an org, then a repo in it with its settings converged
swamp model method run forge org_ensure --arg name=mirrors --arg visibility=private
swamp model method run forge repo_ensure \
  --arg owner=apps --arg name=damson --arg private=true --arg hasWiki=false

# a GitHub pull mirror, then an immediate sync, then the fleet audit
swamp model method run forge mirror_ensure \
  --arg owner=mirrors --arg name=scrappy \
  --arg cloneAddr=https://github.com/example/scrappy.git \
  --arg 'authToken=${{ vault.get("infra", "github/mirror_pat") }}'
swamp model method run forge mirror_sync_now --arg owner=mirrors --arg name=scrappy
swamp model method run forge mirror_status --arg staleFactor=3

# mirror a repository to GitHub on every commit
swamp model method run forge push_mirror_ensure \
  --arg owner=example-org --arg repo=example-repo \
  --arg remoteAddress=https://github.com/example-org/example-repo.git \
  --arg remoteUsername=example-org \
  --arg 'remotePassword=${{ vault.get("infra", "github-token") }}'

# an org-scoped Actions secret, value from a vault
swamp model method run forge actions_secret_put \
  --arg owner=example-org --arg name=REGISTRY_PASSWORD \
  --arg 'value=${{ vault.get("infra", "registry-password") }}'

# a public pull mirror of an upstream project, labelled as one, with Actions on
swamp model method run forge pull_mirror_ensure \
  --arg owner=example-org --arg name=tool \
  --arg cloneAddr=https://github.com/upstream/tool.git --arg private=false
swamp model method run forge repo_topics_ensure \
  --arg owner=example-org --arg name=tool --arg 'topics=["upstream-mirror"]'
swamp model method run forge repo_units_ensure \
  --arg owner=example-org --arg name=tool --arg hasActions=true

# pull requests: open (find-or-create on head and base), inspect, merge
swamp model method run forge pr_ensure \
  --arg owner=apps --arg name=damson --arg head=feat/thing --arg base=main \
  --arg title='Add the thing'
swamp model method run forge pr_get --arg owner=apps --arg name=damson --arg index=4
swamp model method run forge pr_merge \
  --arg owner=apps --arg name=damson --arg index=4 --arg deleteBranch=true
```

Argument names are the schemas' own;
`swamp model type describe @dataverket/forgejo --json` lists them.

## Methods

Read and audit:

| Method                   | Does                                                                                                                             |
| ------------------------ | -------------------------------------------------------------------------------------------------------------------------------- |
| `health`                 | Server version and `/api/healthz`                                                                                                |
| `org_list`               | Every organization                                                                                                               |
| `repo_list`              | Every repository, or one owner's                                                                                                 |
| `user_list`              | Users, admin view; never any credential                                                                                          |
| `user_search`            | Search users by login or name fragment without admin scope, the way to find a login for `pr_assign`; Forgejo's top 50 matches    |
| `mirror_status`          | Every pull mirror's last sync, interval and a `stale` flag (older than `staleFactor` times the interval)                         |
| `branch_protection_list` | What each protected branch enforces                                                                                              |
| `webhook_audit`          | Where every hook of an owner's repositories posts, and whether that is the `expectedUrl`                                         |
| `pr_list`                | Pull requests in a state                                                                                                         |
| `pr_get`                 | One pull request with the mergeable verdict and the head commit's CI state                                                       |
| `push_mirror_list`       | The push mirrors an org or repository has, and stored records the forge no longer has; the audit a mirroring workflow asserts on |
| `runner_list`            | The Actions runners an org or repository has, with their status                                                                  |
| `issue_list`             | The issues of a repository in a state, every page, pull requests excluded                                                        |
| `label_list`             | The labels of an organization or a repository, every page                                                                        |

Idempotent provisioning:

| Method                      | Does                                                                                                                 |
| --------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `org_ensure`                | Find-or-create an organization and converge visibility and description                                               |
| `repo_ensure`               | Find-or-create a repository and converge its settings                                                                |
| `collaborator_ensure`       | Give a user access to a repository; never removes one, refuses the owner                                             |
| `branch_protection_ensure`  | Find-or-create a branch protection rule and converge what it enforces                                                |
| `mirror_ensure`             | Find-or-create a GitHub pull mirror; on an existing one converges interval, visibility and description               |
| `mirror_sync_now`           | Queue an immediate pull sync                                                                                         |
| `pull_mirror_ensure`        | A pull mirror from anywhere that sends only the settings it is given, so the forge's own defaults decide the rest    |
| `push_mirror_ensure`        | Make Forgejo push a repository to a remote on every commit and on an interval; find-or-create on the remote address  |
| `push_mirror_sync_now`      | Queue an immediate push of every push mirror of a repository                                                         |
| `repo_topics_ensure`        | Give a repository topics; additive unless `exact`                                                                    |
| `repo_units_ensure`         | Switch a repository's Actions, packages or projects unit; sends only what is given                                   |
| `repo_rename`               | Rename a repository, verify-first                                                                                    |
| `actions_secret_put`        | Create or update an Actions secret, repo- or org-scoped; the name and scope are recorded, never the value            |
| `runner_registration_token` | A registration token for `forgejo-runner register`, vaulted                                                          |
| `pr_ensure`                 | Open a pull request, find-or-create on the head and base pair, converging title and body                             |
| `pr_assign`                 | Assign a pull request, every login checked against the forge first                                                   |
| `issue_ensure`              | File several issues in one call, each unless one of the same exact title exists, open or closed, with labels by name |
| `issue_labels_ensure`       | The labels of an issue or a pull request by name; additive unless `exact`                                            |
| `label_ensure`              | The labels of an organization or of one repository: create, patch in place, keep; delete only with `prune`           |
| `webhook_retarget`          | Repoint one hook that drifted, `config.url` alone; never creates a hook, refuses an ambiguous match                  |

Lifecycle and deletes:

| Method               | Does                                                                                                                       |
| -------------------- | -------------------------------------------------------------------------------------------------------------------------- |
| `repo_archive`       | Archive a repository; a no-op when already archived                                                                        |
| `repo_unarchive`     | The reverse                                                                                                                |
| `pr_merge`           | Merge a pull request (squash, merge, rebase or rebase-merge) behind the guard described above. Irreversible                |
| `push_mirror_delete` | Remove a push mirror, verify-first                                                                                         |
| `runner_prune`       | Remove offline runners of a given name; a runner that dies before saving `.runner` leaves a record behind on every restart |
| `repo_delete`        | Delete a repository, verify-first; refused with commits unless `allowContent`                                              |
| `org_delete`         | Delete an organization, verify-first; refused while it still holds repositories                                            |

## Pre-flight checks

| Check                    | Label    | Proves                                                                                                                                                                                                  |
| ------------------------ | -------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forgejo-api-url-shape`  | `policy` | `apiUrl` is set, is http(s), and is the forge's base URL without a trailing `/api/v1`; every path here already starts with it, so a doubled one gives `/api/v1/api/v1/...` and a 404 that names nothing |
| `forgejo-token-accepted` | `live`   | The forge answers and the token is still accepted, reported as the login it belongs to                                                                                                                  |

These run before any mutating method, which matters here because several delete.
Skip them with `--skip-check-label live` offline, or by name. The shape check
runs first and the live one stands down when it fails, so a mistyped URL is
reported once as what it is rather than a second time as a 404.

**A token is never echoed.** Forgejo answers a rejected credential with
`access token does not exist [sha: <the token>]`, putting the value in the
response body. The transport masks it as it parses, so neither a check nor a
method can carry it into an error, a record or a log.

## Changes from upstream

The base model is `@thomas/forgejo` 2026.09.04.2 with these changes, and no
other:

- **Type and version.** `@thomas/forgejo` became `@dataverket/forgejo`; a no-op
  upgrade entry moves an instance's `typeVersion` to this version, since the
  global arguments did not change. A definition is migrated by changing its
  `type` line.
- **A check no longer aborts its own request.** A pre-flight check receives the
  definition's global arguments as written, without the schema's defaults, so
  `httpTimeoutMs` arrives undefined. Upstream handed that straight to
  `setTimeout`, which fires at once and aborted every request made from a check
  ([thomas-elliott/swamp-extensions#3](https://github.com/thomas-elliott/swamp-extensions/issues/3));
  definitions had to repeat the default to work around it. The transport now
  falls back to the schema's default itself, and the workaround can be dropped.
- **An echoed token is masked in the base too.** Forgejo puts a rejected token
  in its own error body. The former add-ons masked it in their transport; the
  base transport now does the same, so no method of either origin can carry the
  value into an error, a record or a log.
- **The `reachable` check is dropped.** This package's `forgejo-token-accepted`
  makes the same `GET /api/v1/user` with better reporting, and
  `forgejo-api-url-shape` catches the URL mistake first. Two checks against the
  same endpoint would otherwise fail twice for one cause.
- **A token without `read:user` passes the token check.** Forgejo checks the
  token before it checks scopes, so a 403 that names a required scope can only
  come back for a token it has accepted; `forgejo-token-accepted` passes it and
  fails on a 401, the real refusal. Narrow tokens are the design: `repo_list`
  explains how to list without `read:organization` or `read:user`.
- **The former add-ons are methods of the same type.** They were published as
  `export const extension` on `@thomas/forgejo` and are now part of
  `@dataverket/forgejo`; their behaviour is unchanged. The scope statement
  changed with them: upstream had no delete methods, this package has
  verify-first ones.

## Push mirrors are not pull mirrors

The base model's `mirror_ensure` sets up a _pull_ mirror: Forgejo fetching from
somewhere else. `push_mirror_ensure` is the other direction — Forgejo pushes to
a remote, which is how a forge-of-record mirrors to GitHub.

It is find-or-create on the remote address. An existing mirror to the same
address is left alone, because Forgejo has no update endpoint: changing the
interval or the filter means delete and recreate, which this extension never
does on its own. The remote credential is sent to Forgejo once and never
recorded; Forgejo reports back only the address, the timing and the last error.

## Pull mirrors send only what they are given

The base model's `mirror_ensure` defaults `private` to true, and `lfs`,
`service` and the interval to its own values, and converges an existing mirror
to them on every run: running it without `private` turns a public mirror
private. `pull_mirror_ensure` sends a setting only when it is given. A new
mirror gets Forgejo's own defaults for the rest: public, unless the instance
forces new repositories private; an existing mirror is changed only in the
settings named, and `changed` in the record says which. A repository that is not
a mirror is refused, an empty one is named as a migration still running or the
leftover of a failed one, and a mirror of another source is an error, since
Forgejo cannot change a mirror's source. A source token is sent once on create,
masked in any error, and never recorded. Forgejo migrates synchronously, so a
large source can outlast the model's `httpTimeoutMs`; the migration carries on,
and the next run finds it.

`repo_topics_ensure` sets topics, the labels Forgejo shows on a repository and
searches by. It adds the given topics and keeps the others unless `exact` makes
the list the whole set, checks each against Forgejo's rules first so a bad one
is named, and writes only when something changes.

## Units `repo_ensure` does not reach

`repo_units_ensure` switches the Actions, packages and projects units of a
repository, the three `repo_ensure` has no argument for. It sends only the units
named, so the rest of the repository is untouched, and writes only when a named
unit differs. It reads the forge's answer after the write: an instance with
Actions disabled accepts `has_actions: true` and leaves it off, and that is
reported as an error rather than as `updated`.

## Verify-first deletes

`repo_delete` reads the repository before anything else. One that is already
gone is a no-op, and one with commits is refused unless `allowContent` says
otherwise, because Forgejo has no undelete. What is recorded is what was seen
before the delete and what happened.

`org_delete` does the same for an organization. One that is already gone is a
no-op, and one that still holds repositories is refused and names them, because
`repo_delete` is where the decision about each repository belongs; Forgejo would
refuse the delete anyway. Members and teams go with the organization.

`pr_assign` checks every login against the forge first, so a typo is an error
and not a silently empty assignee list, and the pull request must exist and be
open. Forgejo's `assignees` replaces the whole list; what is recorded is what
Forgejo reports back, not what was asked for.

## Issues by title

`issue_ensure` takes a list of issues and files each one unless the repository
already has an issue of that exact title, open or closed; a rerun files nothing
twice, and a closed one is reported as found rather than reopened. The search is
Forgejo's `q` on the title, followed to the end, and the match is the exact
title, so an issue whose title merely contains the new one does not count. Two
equal titles in one call are refused before anything is sent. `issue_list` reads
a repository's issues in one state, every page.

An issue is filed with labels by name. Every name must exist on the repository
or on its organization, or the call is refused before any issue is filed; a
found issue keeps the labels it has.

## Labels of an organization or a repository

`label_ensure` without a repository name works on an organization's labels,
which every repository in it shares; with one, on that repository's own. The
name is the identity: a missing label is created, one whose color, description
or exclusivity differ is patched in place, keeping its id and the issues it is
on, and the rest are kept. `prune` deletes the labels of that scope not in the
list, and nothing else. Colors compare without `#` and without case.

## Lists are followed to the end

`push_mirror_list`, `runner_list`, `issue_list`, the search behind
`issue_ensure` and the find-or-create behind `push_mirror_ensure` follow
Forgejo's pagination rather than reading one page. A repository past one page of
mirrors would otherwise have had a second mirror created to a remote it already
had, and a runner past the first page would have survived every `runner_prune`.
`user_search` is the one deliberate cap: it is a search, and it returns
Forgejo's top 50 matches.

## Secrets

No secret value is written to a resource or a log. Two carry a credential and
both are one-way: an Actions secret's value goes to Forgejo and only its name
and scope are recorded, and a push mirror's remote credential goes to Forgejo
and is never read back. Supply either from a vault.

## What gets recorded

Every method writes a resource, so an outcome is queryable state and not a log
line:

```sh
swamp data query 'specName == "pushMirror" && isLatest' --json
swamp data query 'specName == "runner" && isLatest' --json
```

| Spec                 | Lifetime | Holds                                                                  |
| -------------------- | -------- | ---------------------------------------------------------------------- |
| `actionsSecret`      | infinite | An Actions secret's name and scope. Never the value                    |
| `runnerRegistration` | infinite | A registration token, vaulted; the record holds a reference            |
| `runner`             | infinite | A registered runner: name, online/offline status, labels               |
| `runnerPrune`        | infinite | Offline runners of one name deleted at a scope, and the live ones kept |
| `repoRename`         | infinite | Old and new name, and the URLs that changed                            |
| `pushMirror`         | infinite | Remote address, timing, last push and last error                       |
| `pullMirror`         | infinite | A pull mirror: source, visibility, interval, last sync, what changed   |
| `repoTopics`         | infinite | A repository's topics, and which were added or removed                 |
| `pushMirrorDelete`   | infinite | Which remote was removed from which repository                         |
| `prAssignment`       | infinite | A pull request's assignees, as Forgejo reports them                    |
| `userMatch`          | 7d       | A user matched by `user_search`: login and full name                   |
| `repoDelete`         | infinite | What the repository was, and what happened                             |

`push_mirror_list` is the audit a mirroring workflow asserts on, and it also
reports stored `pushMirror` records the forge no longer has — a mirror deleted
out of band shows up as drift rather than going quiet.

## License

MIT, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari; the
original work, `@thomas/forgejo`, is copyright 2026 Thomas Elliott.
