# @dataverket/forgejo

Forgejo operations for [swamp](https://github.com/swamp-club/swamp) that reach
past a single repository, as extensions to
[`@thomas/forgejo`](https://swamp-club.com). Install both: these methods land on
upstream's model types and read its `apiUrl` and token.

## Methods

| Method                      | Adds                                                                                                                                             |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------ |
| `actions_secret_put`        | Create or update an Actions secret, repo- or org-scoped. Write-only: the name and scope are recorded, never the value                            |
| `runner_registration_token` | A registration token for `forgejo-runner register`. Marked sensitive, so swamp vaults it and records a reference                                 |
| `runner_list`               | The runners an org or repository has, with their status                                                                                          |
| `runner_prune`              | Remove offline runners of a given name. A runner that registers and dies before it can save `.runner` leaves a record behind on every restart    |
| `repo_rename`               | Rename a repository, verify-first                                                                                                                |
| `pull_mirror_ensure`        | Make Forgejo pull a repository from elsewhere, sending only the settings given, so the forge's defaults decide visibility and the rest           |
| `repo_topics_ensure`        | Give a repository topics, Forgejo's repository labels; additive unless `exact` is set                                                            |
| `repo_units_ensure`         | Switch a repository's Actions, packages or projects unit, the units upstream's `repo_ensure` does not reach; sends only what is given            |
| `push_mirror_ensure`        | Make Forgejo push a repository to a remote on every commit and on an interval                                                                    |
| `push_mirror_list`          | The push mirrors an org or repository has; the audit a mirroring workflow asserts on                                                             |
| `push_mirror_delete`        | Remove a push mirror                                                                                                                             |
| `push_mirror_sync_now`      | Queue an immediate push of every push mirror of a repository. Additive; changes no settings                                                      |
| `user_search`               | Search forge users by login or name fragment, without admin scope — the way to find a login for `pr_assign`. Read-only; Forgejo's top 50 matches |
| `pr_assign`                 | Assign a pull request                                                                                                                            |
| `repo_delete`               | Delete a repository, verify-first                                                                                                                |
| `org_delete`                | Delete an organization, verify-first; refused while it still holds repositories                                                                  |

## Use

Pull both packages, then run the methods against a `@thomas/forgejo` model:

```sh
swamp extension pull @thomas/forgejo
swamp extension pull @dataverket/forgejo
swamp model create @thomas/forgejo forge

# an org-scoped Actions secret, value from a vault
swamp model method run forge actions_secret_put \
  --arg owner=example-org \
  --arg name=REGISTRY_PASSWORD \
  --arg 'value=${{ vault.get("infra", "registry-password") }}'

# mirror a repository to GitHub on every commit
swamp model method run forge push_mirror_ensure \
  --arg owner=example-org --arg repo=example-repo \
  --arg remoteAddress=https://github.com/example-org/example-repo.git \
  --arg remoteUsername=example-org \
  --arg 'remotePassword=${{ vault.get("infra", "github-token") }}'

# a public pull mirror of an upstream project, labelled as one
swamp model method run forge pull_mirror_ensure \
  --arg owner=example-org --arg name=tool \
  --arg cloneAddr=https://github.com/upstream/tool.git --arg private=false
swamp model method run forge repo_topics_ensure \
  --arg owner=example-org --arg name=tool --arg 'topics=["upstream-mirror"]'

# let the repository's .forgejo/workflows run
swamp model method run forge repo_units_ensure \
  --arg owner=example-org --arg name=tool --arg hasActions=true

# what the mirroring audit asserts on
swamp model method run forge push_mirror_list --arg owner=example-org
swamp data query 'modelName == "forge" && specName == "pushMirror" && isLatest' --json
```

Argument names are the schemas' own;
`swamp model type describe @thomas/forgejo --json` lists them once both packages
are pulled.

## Pre-flight checks

| Check                    | Label    | Proves                                                                                                                                                                                                   |
| ------------------------ | -------- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `forgejo-api-url-shape`  | `policy` | `apiUrl` is set, is http(s), and is the forge's base URL without a trailing `/api/v1` — every path here already starts with it, so a doubled one gives `/api/v1/api/v1/...` and a 404 that names nothing |
| `forgejo-token-accepted` | `live`   | The forge answers and the token is still accepted, reported as the login it belongs to                                                                                                                   |

These run before any mutating method, which matters here because several delete.
Skip them with `--skip-check-label live` offline, or by name.

The shape check runs first and the live one stands down when it fails, so a
mistyped URL is reported once as what it is rather than a second time as a 404.
Note that `@thomas/forgejo` has a `reachable` check of its own covering the same
ground as `forgejo-token-accepted`; both are kept because they fail
independently.

**A token is never echoed.** Forgejo answers a rejected credential with
`access token does not exist [sha: <the token>]`, putting the value in the
response body. The transport masks it as it parses, so neither a check nor a
method can carry it into an error, a record or a log.

## Push mirrors are not pull mirrors

Upstream's `mirror_ensure` sets up a _pull_ mirror: Forgejo fetching from
somewhere else. `push_mirror_ensure` is the other direction — Forgejo pushes to
a remote, which is how a forge-of-record mirrors to GitHub.

It is find-or-create on the remote address. An existing mirror to the same
address is left alone, because Forgejo has no update endpoint: changing the
interval or the filter means delete and recreate, which this extension never
does on its own. The remote credential is sent to Forgejo once and never
recorded; Forgejo reports back only the address, the timing and the last error.

## Pull mirrors send only what they are given

Upstream's `mirror_ensure` defaults `private` to true, and `lfs`, `service` and
the interval to its own values, and converges an existing mirror to them on
every run: running it without `private` turns a public mirror private.
`pull_mirror_ensure` sends a setting only when it is given. A new mirror gets
Forgejo's own defaults for the rest: public, unless the instance forces new
repositories private; an existing mirror is changed only in the settings named,
and `changed` in the record says which. A repository that is not a mirror is
refused, an empty one is named as a migration still running or the leftover of a
failed one, and a mirror of another source is an error, since Forgejo cannot
change a mirror's source. A source token is sent once on create, masked in any
error, and never recorded. Forgejo migrates synchronously, so a large source can
outlast the model's `httpTimeoutMs`; the migration carries on, and the next run
finds it.

`repo_topics_ensure` sets topics, the labels Forgejo shows on a repository and
searches by. It adds the given topics and keeps the others unless `exact` makes
the list the whole set, checks each against Forgejo's rules first so a bad one
is named, and writes only when something changes.

## Units upstream does not reach

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

## Lists are followed to the end

`push_mirror_list`, `runner_list` and the find-or-create behind
`push_mirror_ensure` follow Forgejo's pagination rather than reading one page. A
repository past one page of mirrors would otherwise have had a second mirror
created to a remote it already had, and a runner past the first page would have
survived every `runner_prune`. `user_search` is the one deliberate cap: it is a
search, and it returns Forgejo's top 50 matches.

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

MIT, see [LICENSE.md](./LICENSE.md).
