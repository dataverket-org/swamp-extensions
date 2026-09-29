# @dataverket/github

Repository settings for [swamp](https://github.com/swamp-club/swamp) that
[`@goodcraft/github`](https://swamp-club.com)'s `ensureRepo` does not cover, as
an extension to it. Install both.

## Methods

| Method                  | Adds                                                                          |
| ----------------------- | ----------------------------------------------------------------------------- |
| `branches_list`         | The branches a repository has, and which one is default                       |
| `default_branch_ensure` | Converge the default branch                                                   |
| `repo_delete`           | Delete a repository under the model's owner, verify-first (no-op when absent) |

## Use

```sh
swamp extension pull @goodcraft/github
swamp extension pull @dataverket/github
swamp model create @goodcraft/github gh

# what branches are there, and which is default?
swamp model method run gh branches_list --arg repo=example-repo
swamp data query 'modelName == "gh" && specName == "branches" && isLatest' --json

# converge the default before the first mirror push
swamp model method run gh default_branch_ensure \
  --arg repo=example-repo --arg branch=main
```

## Why the default branch matters

GitHub refuses a mirror push from a repository whose default branch is not one
the mirror carries — "refusing to delete the current branch". A forge mirroring
to GitHub therefore has to converge GitHub's default branch before the first
push, not after.

`default_branch_ensure` reports unchanged when the default already matches, and
refuses to point at a branch the repository does not have, so a typo fails with
its cause named instead of leaving the repository pointed at nothing. An empty
repository reports no branches rather than erroring.

## Verify-first delete

`repo_delete` is a no-op for a repository that is already absent, and
`expectMirrorOf` refuses to delete one whose description does not mention the
given text — a guard for deleting mirrors by pattern. GitHub keeps deleted
organisation repositories restorable for 90 days.

Talks to the GitHub REST API with the model's token; the token is never
recorded.

## What gets recorded

| Spec            | Lifetime | Holds                                               |
| --------------- | -------- | --------------------------------------------------- |
| `branches`      | infinite | A repository's branches and its default branch      |
| `defaultBranch` | infinite | Which branch is now default, and whether it changed |
| `repoDelete`    | infinite | A repository deletion under the model's owner       |

Query them like any other stored resource:

```sh
swamp data query 'specName == "branches" && isLatest' --json
swamp data query 'specName == "defaultBranch" && isLatest' --json
```

## Together with a Forgejo mirror

The ordering that works, when a Forgejo repository is mirrored to GitHub: create
the GitHub repository, push the mirror once so the branch exists,
`default_branch_ensure` to point GitHub's default at it, and only then let the
mirror run on its interval. Converging the default first fails, because the
branch is not there yet to point at.

## License

MIT, see [LICENSE.md](./LICENSE.md).
