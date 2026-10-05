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

| Spec            | Lifetime | Holds                                                    |
| --------------- | -------- | -------------------------------------------------------- |
| `repos`         | infinite | The owner's repositories, from `sync`                    |
| `repoEnsure`    | infinite | The outcome of an `ensureRepo`: exists, created, planned |
| `release`       | infinite | The outcome of an `ensureRelease`                        |
| `pull`          | infinite | The outcome of an `openPr`                               |
| `branches`      | infinite | A repository's branches and its default branch           |
| `defaultBranch` | infinite | Which branch is now default, and whether it changed      |
| `repoDelete`    | infinite | A repository deletion under the model's owner            |

No secret is recorded. The token lives in the vault the definition names, and a
response that echoes it back is masked before it becomes data.

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

MIT, see [LICENSE.md](./LICENSE.md). The original work is copyright 2026
GoodCraft; this package is copyright 2026 Jan Ivar Beddari.
