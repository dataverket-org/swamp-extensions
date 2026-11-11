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

# merge settings: read them, then offer merge commits only
swamp model method run forge repo_merge_settings_ensure \
  --arg owner=example-org --arg name=tool
swamp model method run forge repo_merge_settings_ensure \
  --arg owner=example-org --arg name=tool \
  --arg allowMergeCommits=true --arg defaultMergeStyle=merge \
  --arg allowRebase=false --arg allowRebaseExplicit=false \
  --arg allowSquashMerge=false --arg allowRebaseUpdate=false

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

| Method                       | Does                                                                                                                 |
| ---------------------------- | -------------------------------------------------------------------------------------------------------------------- |
| `org_ensure`                 | Find-or-create an organization and converge visibility and description                                               |
| `repo_ensure`                | Find-or-create a repository and converge its settings                                                                |
| `collaborator_ensure`        | Give a user access to a repository; never removes one, refuses the owner                                             |
| `branch_protection_ensure`   | Find-or-create a branch protection rule and converge what it enforces                                                |
| `mirror_ensure`              | Find-or-create a GitHub pull mirror; on an existing one converges interval, visibility and description               |
| `mirror_sync_now`            | Queue an immediate pull sync                                                                                         |
| `pull_mirror_ensure`         | A pull mirror from anywhere that sends only the settings it is given, so the forge's own defaults decide the rest    |
| `push_mirror_ensure`         | Make Forgejo push a repository to a remote on every commit and on an interval; find-or-create on the remote address  |
| `push_mirror_sync_now`       | Queue an immediate push of every push mirror of a repository                                                         |
| `repo_topics_ensure`         | Give a repository topics; additive unless `exact`                                                                    |
| `repo_units_ensure`          | Switch a repository's Actions, packages or projects unit; sends only what is given                                   |
| `repo_merge_settings_ensure` | Read or converge a repository's pull-request merge settings; sends only what is given                                |
| `repo_rename`                | Rename a repository, verify-first                                                                                    |
| `actions_secret_put`         | Create or update an Actions secret, repo- or org-scoped; the name and scope are recorded, never the value            |
| `runner_registration_token`  | A registration token for `forgejo-runner register`, vaulted; its endpoint is deprecated since Forgejo 15, see below  |
| `pr_ensure`                  | Open a pull request, find-or-create on the head and base pair, converging title and body                             |
| `pr_assign`                  | Assign a pull request, every login checked against the forge first                                                   |
| `issue_ensure`               | File several issues in one call, each unless one of the same exact title exists, open or closed, with labels by name |
| `issue_labels_ensure`        | The labels of an issue or a pull request by name; additive unless `exact`                                            |
| `label_ensure`               | The labels of an organization or of one repository: create, patch in place, keep; delete only with `prune`           |
| `webhook_retarget`           | Repoint one hook that drifted, `config.url` alone; never creates a hook, refuses an ambiguous match                  |
| `pr_feedback`                | Read a pull request's comments, reviews with their state, and each review's inline comments                          |
| `pr_comment`                 | Post a comment on a pull request; every call posts a new one                                                         |
| `pr_merge_state`             | A pull request's head and, once merged, its merge commit, time and merger                                            |
| `work_item_sync`             | Mirror a `@swamp/software-factory` work item into one issue, one way; see "Work items as issues"                     |

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

## Merge settings

`repo_merge_settings_ensure` reads and converges the settings that decide how a
pull request is merged: which merge styles the merge button offers
(`allowMergeCommits`, `allowRebase`, `allowRebaseExplicit`, `allowSquashMerge`,
`allowFastForwardOnlyMerge`), the style it uses by default
(`defaultMergeStyle`), whether a pull request's branch may be updated by rebase
(`allowRebaseUpdate`) and the update style used by default
(`defaultUpdateStyle`), and the defaults a new pull request starts with
(`defaultDeleteBranchAfterMerge`, `defaultAllowMaintainerEdit`,
`ignoreWhitespaceConflicts`). It holds no opinion on their values: it sends only
the settings given, writes only when one differs, and with none given only
reads. Every call records all eleven settings as the forge reports them, `null`
for one it does not report.

The forge keeps these settings with the pull requests unit: turning pull
requests off and on again resets every one of them to the forge's defaults.
While they are off the forge reports every setting as false and both default
styles as `merge`, which a wish could match by chance. So the method refuses any
setting on a repository whose pull requests are off, matching or not, rather
than turning them on; a call with no setting still reads it; `repo_ensure` does
that, and this method runs after it. Every write also carries
`has_pull_requests: true`, which changes nothing where pull requests are on:
Gitea's API reads the merge fields only inside that flag, and Forgejo applies
them either way. After the write it compares the forge's answer with what was
asked: a setting that did not apply, a setting not asked for that moved, or pull
requests turned off is an error.

`allow_manual_merge` and `autodetect_manual_merge` are not offered. Forgejo
accepts them but does not return them when a repository is read, so a write
could not be checked.

A rebase, a rebase with a merge commit and a squash each make new commits on the
forge, which the author did not sign. A repository whose commits must reach the
default branch as they were pushed (signed, or tagged by hash) offers merge
commits or fast-forward only, and turns `allowRebaseUpdate` off, because an
update by rebase rewrites the pull request's head before the merge.

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

## Work items as issues

`work_item_sync --input factory=<model> --input workItem=<ref>` mirrors one work
item of a `@swamp/software-factory` model into one issue of the given
repository. The first run creates the issue, titled with the work item and the
first sentence of its outcome, or adopts `issue` when it is given. Every run
rewrites the section of the body between `<!-- swamp-factory:start -->` and
`<!-- swamp-factory:end -->` from the factory's records (stage, outcome,
decisions, blocking review findings, pull request, merge) and keeps the rest of
the body; comments only when the stage changed or a new critical or high finding
is unresolved; and closes the issue when the work item is done or aborted.
Nothing in the issue flows back into the factory.

`pr_merge_state` reports the head branch's commit as Forgejo has it now, which
is not necessarily the commit that was merged: compare the merge commit's tree
when that matters.

## Checked against Forgejo 17.0.1

Every endpoint, method, request body field and query parameter this type uses
exists in the API of Forgejo 17.0.1. One of them is deprecated:
`runner_registration_token` reads `GET .../actions/runners/registration-token`,
deprecated since Forgejo 15 and still served by 17.0.1. Its replacement,
`POST .../actions/runners`, registers the runner itself and answers with the
runner's own token, which `forgejo-runner create-runner-file` takes, so moving
to it is a new method rather than a change to this one.

`repo_merge_settings_ensure` was run against Forgejo 17.0.1: each of its eleven
settings written and read back, a second run with the same settings writing
nothing, settings not named left as they were, a repository with pull requests
off read as false and `merge` everywhere, and any setting asked of it refused
with nothing sent, a missing repository and a wrong token refused.

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

| Spec                 | Name                                         | Holds                                                                  |
| -------------------- | -------------------------------------------- | ---------------------------------------------------------------------- |
| `server`             | `status`                                     | Version and health, from `health`                                      |
| `org`                | `<org>`                                      | An organization, from `org_list` and `org_ensure`                      |
| `repo`               | `repo-<owner>-<repo>`                        | A repository and its settings                                          |
| `user`               | `<login>`                                    | A user, admin view, never a credential                                 |
| `mirror`             | `mirror-<owner>-<repo>`                      | A pull mirror's sync health                                            |
| `webhook`            | `webhook-<owner>-<repo>-<id>`                | A webhook, audited or repointed, never its secret                      |
| `collaborator`       | `collaborator-<owner>-<repo>-<login>`        | A user's access level on a repository                                  |
| `branch_protection`  | `branch-protection-<owner>-<repo>-<rule>`    | A branch-protection rule                                               |
| `pull_request`       | `pull-<owner>-<repo>-<index>`                | A pull request: state, mergeability, head CI                           |
| `actionsSecret`      | `actions-secret-<target>-<name>`             | An Actions secret's name and scope. Never the value                    |
| `runnerRegistration` | `runner-registration-<target>`               | A registration token, vaulted; the record holds a reference            |
| `runner`             | `runner-<target>-<name or id>`               | A registered runner: name, online/offline status, labels               |
| `runnerPrune`        | `runner-prune-<target>-<name>`               | Offline runners of one name deleted at a scope, and the live ones kept |
| `repoRename`         | `repo-rename-<owner>-<new name>`             | Old and new name, and the URLs that changed                            |
| `pushMirror`         | `push-mirror-<owner>-<repo>-<remote>`        | Remote address, timing, last push and last error                       |
| `pushMirrorDelete`   | `push-mirror-delete-<owner>-<repo>-<remote>` | Which remote was removed from which repository                         |
| `pullMirror`         | `pull-mirror-<owner>-<repo>`                 | A pull mirror: source, visibility, interval, last sync, what changed   |
| `repoTopics`         | `repo-topics-<owner>-<repo>`                 | A repository's topics, and which were added or removed                 |
| `repoUnits`          | `repo-units-<owner>-<repo>`                  | A repository's units, and which changed                                |
| `repoMergeSettings`  | `repo-merge-settings-<owner>-<repo>`         | A repository's merge settings, and which changed                       |
| `prAssignment`       | `pr-assignment-<owner>-<repo>-<index>`       | A pull request's assignees, as Forgejo reports them                    |
| `userMatch`          | `user-match-<login>`                         | A user matched by `user_search`: login and full name. Lifetime 7d      |
| `repoDelete`         | `repo-delete-<owner>-<repo>`                 | What the repository was, and what happened                             |
| `orgDelete`          | `org-delete-<org>`                           | What the organization was, and what happened                           |
| `issue`              | `issue-<owner>-<repo>-<number>`              | An issue filed or found by title                                       |
| `issueLabels`        | `issue-labels-<owner>-<repo>-<number>`       | The labels set on an issue                                             |
| `label`              | `label-<owner>-<repo or org>-<name>`         | A label of a repository or an organization                             |
| `prFeedback`         | `pr-feedback-<owner>-<repo>-<index>`         | A pull request's discussion read back                                  |
| `prComment`          | `pr-comment-<owner>-<repo>-<index>-<id>`     | A comment posted on a pull request                                     |
| `prMergeState`       | `pr-merge-state-<owner>-<repo>-<index>`      | A pull request's merge commit, time and merger                         |
| `workItemIssue`      | `work-item-<owner>-<repo>-<work item>`       | The link from a factory work item to its issue                         |

Every spec has an infinite lifetime except `userMatch`. `<target>` is an owner
or `<owner>-<repo>`, the scope of an Actions method.

### Data names

A data name becomes a directory name in a filesystem datastore, so it has to
hold on Windows too, which refuses `:` and `< > " | ? *` in a file name and a
trailing dot or space. Each name above is a spec word and then its parts joined
with `-`, every part reduced to letters, digits, `.`, `_` and `-`: the shape
`@dataverket/github` kept from upstream, `repo-<repo>` and
`release-<repo>-<tag>`. The owner stays in the name, unlike in
`@dataverket/github`, because one forgejo model spans every organization of the
forge. Parts carry `-` themselves, so two names can coincide, `acme/corp-x` and
`acme-corp/x` say, as `release-a-b-c` can upstream; the record's `owner` and
`repo` attributes say which it is, and the push-mirror audit reconciles by those
attributes, never by name.

Before 2026.11.09.1 a repository's records were named from its full name with
the slash turned into a colon, `acme:tool`, `acme:tool#12`,
`acme:tool:push-mirror:github`, and every method writing one failed on Windows
after its API call had succeeded
([issue 1](https://github.com/dataverket-org/swamp-extensions/issues/1),
[swamp-club/swamp#3205](https://swamp-club.com/lab/3568)). `org` and `user`
records were named by the login alone and are unchanged.

### Upgrading from a version before 2026.11.09.1

Nothing is required and nothing stored is touched. The next run writes under the
new name; an item under an old name stays where it is, is no longer updated, and
still counts as a latest record under its own name, so a spec query without a
run filter returns it beside the new one. The run says so once per record, the
first time it writes a new name while the old one holds data. An expression that
reads an old name by name keeps returning the last value stored there and should
be pointed at the new name. `work_item_sync` still finds a link it wrote under
the old name, so a mirrored work item is updated rather than filed again.

Every old name of a repository record starts with the owner and `:`, and no new
name contains `:`, so one prefix delete per owner removes them; the `userMatch`
records had the prefix `user:`. Preview first; the delete is permanent:

```sh
swamp data delete forgejo --prefix 'acme:' --dry-run
swamp data delete forgejo --prefix 'acme:' --yes
swamp data delete forgejo --prefix 'user:' --yes
```

`push_mirror_list` is the audit a mirroring workflow asserts on, and it also
reports stored `pushMirror` records the forge no longer has, found by their
`owner` and `repo` attributes, and drops them; a mirror deleted out of band
shows up as drift rather than going quiet. A record under a pre-2026.11.09.1
name is left alone like every other old record.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari;
the original work, `@thomas/forgejo`, is copyright 2026 Thomas Elliott under the
MIT License, whose notice LICENSE.md keeps.
