# @dataverket/github

GitHub repositories, releases, pull requests and repository settings for
[swamp](https://github.com/swamp-club/swamp), over the GitHub REST API. One
model type, `@dataverket/github`.

This is a fork of [`@goodcraft/github`](https://swamp-club.com) 2026.06.14.1
(MIT, copyright 2026 GoodCraft), merged with what used to be the
`@dataverket/github` add-on to it. One package now owns the type, so there is
nothing else to install. The upstream methods keep their names, and a model
definition or workflow written for `@goodcraft/github` works once its `type`
line says `@dataverket/github`.

## Methods

| Method                  | Does                                                                                                                          |
| ----------------------- | ----------------------------------------------------------------------------------------------------------------------------- |
| `sync`                  | List the repositories owned by `owner`. Read-only; proves the token                                                           |
| `ensureRepo`            | Create a repository if it does not exist: name, description, visibility, auto-init, license and gitignore templates, topics   |
| `ensureRelease`         | Create a release and tag if no release with that tag is present                                                               |
| `openPr`                | Open a pull request if no open one exists for the same head and base                                                          |
| `branches_list`         | The branches a repository has, every page, and which one is default. Empty for a repository with no commits                   |
| `default_branch_ensure` | Converge the default branch. Unchanged when it already matches; refuses a branch the repository does not have                 |
| `repo_delete`           | Delete a repository under the model's owner, verify-first. A no-op when absent; `expectMirrorOf` refuses an unexpected target |

The three mutations from upstream, `ensureRepo`, `ensureRelease` and `openPr`,
default to `dryRun: true`. A run reports `would-create` and writes nothing until
`dryRun=false` is passed. `default_branch_ensure` and `repo_delete` have no dry
run; they are verify-first instead, and refuse rather than guess.

## Global arguments

| Argument  | Meaning                                                                              |
| --------- | ------------------------------------------------------------------------------------ |
| `token`   | A GitHub token, from a vault expression, never inline. Marked sensitive              |
| `owner`   | The user or organization login that owns the repositories                            |
| `isOrg`   | `true` when `owner` is an organization; changes the create endpoint. Default `false` |
| `baseUrl` | The API base URL, for GitHub Enterprise or testing. Default `https://api.github.com` |

### The token

A fine-grained personal access token with access to all repositories of the
owner (a repository that does not exist yet cannot be named) and these
repository permissions: Administration read and write for `ensureRepo`,
`default_branch_ensure` and `repo_delete`; Contents read and write for
`ensureRelease`; Pull requests read and write for `openPr`; Metadata read for
`sync` and every existence check. A classic token with the `repo` scope covers
the same.

## Use

```sh
swamp extension pull @dataverket/github
swamp model create @dataverket/github github \
  --global-arg owner=example-org --global-arg isOrg=true \
  --global-arg 'token=${{ vault.get("infra", "github/token") }}'

# read-only: the owner's repositories, and proof the token works
swamp model method run github sync

# plan a repository, then create it
swamp model method run github ensureRepo --arg name=example-tool --arg private=false
swamp model method run github ensureRepo --arg name=example-tool --arg private=false --arg dryRun=false

# a release on a tag, idempotent on the tag name
swamp model method run github ensureRelease \
  --arg repo=example-tool --arg tagName=2026.10.05.1 --arg dryRun=false
```

The repository settings a push mirror needs:

```sh
# what branches are there, and which is default?
swamp model method run github branches_list --arg name=example-tool
swamp data query 'modelName == "github" && specName == "branches" && isLatest' --json

# converge the default before the first mirror push
swamp model method run github default_branch_ensure \
  --arg name=example-tool --arg defaultBranch=main

# remove a stale twin, only if it says what it mirrors
swamp model method run github repo_delete \
  --arg name=example-tool --arg expectMirrorOf=forge.example.net
```

## Pre-flight check

| Check                   | Label  | Proves                                                                           |
| ----------------------- | ------ | -------------------------------------------------------------------------------- |
| `github-token-accepted` | `live` | The API answers, the token is still accepted, and it can see the model's `owner` |

It runs before every method, so a stale token is a refusal rather than a failure
part-way through. Skip it offline with `--skip-check-label live`.

The check reads `baseUrl` the way the methods do: a check receives the
definition as written, with none of the schema's defaults applied, so `baseUrl`
is undefined there even though the schema gives it `https://api.github.com`. The
transport supplies that fallback itself, in one place, so a check and a method
cannot disagree about where they are pointed.

## Why the default branch matters

GitHub refuses a mirror push from a repository whose default branch is not one
the mirror carries, with "refusing to delete the current branch". A forge
mirroring to GitHub therefore has to converge GitHub's default branch before the
first push, not after.

`default_branch_ensure` reports unchanged when the default already matches, and
refuses to point at a branch the repository does not have, so a typo fails with
its cause named instead of leaving the repository pointed at nothing. An empty
repository reports no branches rather than erroring.

The ordering that works, when a Forgejo repository is mirrored to GitHub:
`ensureRepo`, push the mirror once so the branch exists, `default_branch_ensure`
to point GitHub's default at it, and only then let the mirror run on its
interval.

## Verify-first delete

`repo_delete` is a no-op for a repository that is already absent, and
`expectMirrorOf` refuses to delete one whose description or homepage does not
mention the given text, a guard for deleting mirrors by pattern. GitHub keeps
deleted organization repositories restorable for 90 days.

## What gets recorded

| Spec            | Name                        | Holds                                                    |
| --------------- | --------------------------- | -------------------------------------------------------- |
| `repos`         | `repos`                     | The owner's repositories, from `sync`                    |
| `repoEnsure`    | `repo-<repo>`               | The outcome of an `ensureRepo`: exists, created, planned |
| `release`       | `release-<repo>-<tag>`      | The outcome of an `ensureRelease`                        |
| `pull`          | `pull-<repo>-<head>-<base>` | The outcome of an `openPr`                               |
| `branches`      | `branches-<repo>`           | A repository's branches and its default branch           |
| `defaultBranch` | `default-branch-<repo>`     | Which branch is now default, and whether it changed      |
| `repoDelete`    | `delete-<repo>`             | A repository deletion under the model's owner            |

Every spec has an infinite lifetime and keeps ten versions. No secret is
recorded. The token lives in the vault the definition names, and a response that
echoes it back is masked before it becomes data.

## Data names

A data name becomes a directory name in a filesystem datastore, so it has to
hold on Windows too, which refuses `:` and `< > " | ? *` in a file name and a
trailing dot or space. Each name above is a spec word and the repository joined
with `-`, the repository reduced to letters, digits, `.`, `_` and `-`:
`branches-tool`, `default-branch-tool`, `delete-tool`. The owner is the model's,
so it is not repeated in the name, the same shape as upstream's `repo-<repo>`.

Before 2026.11.08.1 the three repository-settings records were named
`acme:tool:branches`, `acme:tool:default-branch` and `acme:tool:delete`, and
every method writing one failed on Windows after its API call had succeeded
([issue 1](https://github.com/dataverket-org/swamp-extensions/issues/1),
[swamp-club/swamp#3205](https://swamp-club.com/lab/3568)).

### Upgrading from a version before 2026.11.08.1

Nothing is required and nothing stored is touched. The next run writes under the
new name; an item under an old name stays where it is, is no longer updated, and
still counts as a latest record under its own name, so a spec query without a
run filter returns it beside the new one. The run says so once per repository,
the first time it writes a new name while the old one holds data. An expression
that reads an old name by name keeps returning the last value stored there and
should be pointed at the new name.

Every old name starts with the owner and `:`, and no new name contains `:`, so
one prefix delete removes them. Preview first; the delete is permanent:

```sh
swamp data delete github --prefix 'acme:' --dry-run
swamp data delete github --prefix 'acme:' --yes
```

## Development

```sh
deno task check
deno task test
```

The unit tests run every method of `github.ts` and `repo_settings.ts` through
swamp's `createModelTestContext`, with a stub standing in for `fetch`, the one
call both Octokit and the `repo_settings.ts` caller make (`test_support.ts`).
Each test lists the few answers it needs, and a request it did not list fails
it. Each method has a success and a failure path, and the tests assert on the
records written and the requests that change something: a dry run posts nothing,
a missing branch or an unmatched `expectMirrorOf` is refused before any change.
A planted token is sent only as the credential and reaches no record, log or
error, and a token the API echoes back is masked. The pure parts are tested as
well: the request shapes, the matching and the data names.

## Changes from upstream

- The type is `@dataverket/github` and the version follows this package. A
  definition at an upstream version is stamped by a no-op upgrade; the global
  arguments are unchanged.
- The `repos` resource schema no longer uses `.passthrough()`. The data written
  has exactly the six declared fields, and a passthrough schema stops swamp from
  validating CEL expressions against it.
- The former add-on's methods, resources and check are part of the package
  instead of being attached to another collective's type.

Nothing else in the upstream code was changed; its behaviour, method names and
argument names are kept so that definitions and workflows migrate by changing
the `type` line.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari;
the original work, `@goodcraft/github`, is copyright 2026 GoodCraft under the
MIT License, whose notice LICENSE.md keeps.
