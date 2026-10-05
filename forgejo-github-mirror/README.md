# @dataverket/forgejo-github-mirror

One [swamp](https://github.com/swamp-club/swamp) workflow,
`@dataverket/mirror-forgejo-to-github`, that mirrors every repository of a
Forgejo org to a GitHub org and keeps it that way. Run it by hand when a
repository was added on the forge, or on a schedule as a check that every
repository with commits has a healthy mirror. A run changes nothing that is
already right.

## What a run does

| Job        | Does                                                                                            |
| ---------- | ----------------------------------------------------------------------------------------------- |
| `discover` | Lists every repository of the Forgejo org                                                       |
| `github`   | Creates each missing repository on GitHub, empty, with the same name and visibility             |
| `mirrors`  | Gives each a Forgejo push mirror to GitHub, pushing on every commit and on an interval          |
| `defaults` | Points GitHub's default branch at the forge's (a failure here is allowed; the next run retries) |
| `audit`    | Fails the run when a mirror reports a push error, or a private repository has a public twin     |

What it will not do:

- **Delete anything on GitHub.** A repository removed from the forge keeps its
  GitHub copy and its mirror is simply no longer there.
- **Act on an old record.** Only repositories this run listed take part, so a
  repository deleted or renamed on the forge is not recreated on GitHub.
- **Mirror an empty repository.** A push mirror of a repository with no commits
  pushes nothing and deletes every branch on GitHub. Archived repositories,
  forks and pull mirrors are skipped too.
- **Push private code into a public repository.** A private forge repository is
  mirrored only when its GitHub copy is private. If the copy already existed as
  public, or the forge repository turned private after its mirror was made, the
  audit fails the run and names it.
- **Change an existing mirror.** Forgejo has no update call, so a mirror keeps
  the token and interval it was made with. After rotating the GitHub token,
  delete the mirrors (`push_mirror_delete` in `@dataverket/forgejo`) and run
  again.

## Inputs

| Input               | Required | Default                  | Meaning                                                 |
| ------------------- | -------- | ------------------------ | ------------------------------------------------------- |
| `forgejoUrl`        | yes      |                          | Forge base URL, no trailing slash and no `/api/v1`      |
| `forgejoOwner`      | yes      |                          | Forgejo org whose repositories are mirrored             |
| `forgejoTokenVault` | yes      |                          | Vault holding the Forgejo API token                     |
| `forgejoTokenKey`   | yes      |                          | Key of that token in the vault                          |
| `githubOwner`       | yes      |                          | GitHub org the repositories are created under           |
| `githubTokenVault`  | yes      |                          | Vault holding the GitHub token                          |
| `githubTokenKey`    | yes      |                          | Key of that token in the vault                          |
| `githubApiUrl`      | no       | `https://api.github.com` | REST API; `https://<host>/api/v3` on Enterprise Server  |
| `githubUrl`         | no       | `https://github.com`     | Where the mirrors push; `https://<host>` on Enterprise  |
| `githubUsername`    | no       | `x-access-token`         | Username Forgejo sends with the token                   |
| `interval`          | no       | `8h0m0s`                 | Periodic push, as a Go duration, on top of every commit |

Tokens are named by vault and key, never passed as values: swamp records
workflow inputs in cleartext in the run history, and resolves a `vault.get` only
inside the step that uses it.

The Forgejo token needs to read the org's repositories and manage their push
mirrors. The GitHub token creates repositories in the org, sets their default
branch and, handed to Forgejo, pushes to them. It is stored by Forgejo for as
long as the mirror exists, so a fine-grained token limited to the org is the
better choice.

## Use

```sh
swamp extension pull @dataverket/forgejo-github-mirror

swamp workflow run @dataverket/mirror-forgejo-to-github \
  --input forgejoUrl=https://forge.example.org --input forgejoOwner=example \
  --input forgejoTokenVault=ops --input forgejoTokenKey=forgejo/api_token \
  --input githubOwner=example-org \
  --input githubTokenVault=ops --input githubTokenKey=github/mirror_token
```

The required inputs have no defaults on purpose, since any default would be
wrong for every other caller. Keep your own values in your repository instead,
as a small workflow that calls this one:

```yaml
jobs:
  - name: mirror
    steps:
      - name: example-to-github
        task:
          type: workflow
          workflowIdOrName: "@dataverket/mirror-forgejo-to-github"
          inputs:
            forgejoUrl: https://forge.example.org
            forgejoOwner: example
            forgejoTokenVault: ops
            forgejoTokenKey: forgejo/api_token
            githubOwner: example-org
            githubTokenVault: ops
            githubTokenKey: github/mirror_token
```

Under `swamp serve` the same values can go in a trigger override instead:
`swamp workflow trigger set @dataverket/mirror-forgejo-to-github --schedule
"0 */6 * * *" --input forgejoOwner=example ...`.

## What gets recorded

The workflow creates two models on first use, named for it so they do not
collide with your own: `mirror-forgejo-to-github-forgejo` (`@dataverket/forgejo`)
and `mirror-forgejo-to-github-github` (`@dataverket/github`). Their definitions
hold the last run's URLs and orgs and a `vault.get` over the workflow's inputs,
never a token, so they belong to the workflow: run their methods through it
rather than by hand. Runs for different org pairs share them and wait on the
same model lock, so run one pair at a time.

```sh
swamp data query 'modelName == "mirror-forgejo-to-github-forgejo" && specName == "pushMirror"' --json
swamp data query 'modelName == "mirror-forgejo-to-github-github" && specName == "repoEnsure"' --json
```

## License

MIT, see [LICENSE.md](./LICENSE.md).
