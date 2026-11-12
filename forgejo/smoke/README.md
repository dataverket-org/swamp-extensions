# Smoke and negative suite

What the unit tests cannot say: that the paths, the request bodies, the
pagination, the token masking and the pre-flight checks are the ones a real
Forgejo 15.0.11 (the version production runs) and a real swamp repository agree
to. It runs against one throwaway forge in podman and spends most of its effort
on what should _not_ happen: every refusal is checked for its message, and every
run, refused or not, for a token.

## Run it

```sh
# 1. one forge on 127.0.0.1:13000, seeded with users, tokens, an organization,
#    repositories with commits and branches, webhooks and offline runners
./forge.sh up

# 2. a swamp repository loading this extension from source, a vault holding
#    the tokens, and the models
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none && swamp extension source add "$OLDPWD/..")
./models.sh

# 3. the suite, in order: each batch builds on what the one before left
for b in a b c d e f g h; do ./neg-$b.sh; done

# 4. the faults the forge does not make on demand, injected over it
(cd .. && deno task test:live)

# 5. and away
./forge.sh down
```

`forge.sh` keeps the forge's data in the container only, and the tokens in
`.work/tokens`, mode 0600, never printed. `models.sh` puts them into a
`local_encryption` vault on stdin; every definition names a vault key, never a
value. It also pulls `@swamp/stagecraft` for the tracker batch. Before it makes
anything, it clears this extension's cached bundles in `$REPO`, so an earlier
run's build cannot answer for the source: in each directory under
`$REPO/.swamp/bundles/` that holds `forgejo.js` and `stagecraft_tracker.js`, it
removes the bundle of each module `../manifest.yaml` lists, and nothing else;
other extensions' bundles, stagecraft's among them, stay.

## What each batch is for

| Batch | What it refuses to let pass                                                                                                                                                                                                                                                                                                                                                                                                                              |
| ----- | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `a`   | An organization, repository or grant made twice, or changed where nothing differs; a public repository's default read taken for a grant; an owner that is nobody; a narrow token resolving an owner; a grant on the owner; an archive not undone                                                                                                                                                                                                         |
| `b`   | A unit, merge setting, topic, label, branch rule or tag protection rule written when it already matches, or moving one not named; merge settings sent to a repository whose pull requests are off; a bad topic, colour or merge style reaching the forge; a prune past its own scope; a tag whitelist that is not an exact set, or a login the forge does not count reported as an update                                                                |
| `c`   | An issue filed twice by title, even straight after, or found by a title it only contains; a label that is nowhere; a merge of a head with no or failed CI, of a conflict, a draft, a closed or merged pull request; an assignee who does not exist; a branch left behind after `deleteBranch`; an issue closed or reopened twice, commented when already in state, or a pull request touched by the issue state and text methods                         |
| `d`   | An Actions secret's value, a registration token, a mirror's source token or a push mirror's password in any record; a mirror over another source or over a repository that is not one; a prune that deletes another name or another scope's runner; a failed migration's leftover left unnamed; a webhook created, guessed at, or stripped of its query                                                                                                  |
| `e`   | Anything done to a renamed repository through its old name; a rename onto a repository that exists; a repository with commits deleted without `allowContent`; an organization deleted while it holds repositories; a second delete that is not a no-op                                                                                                                                                                                                   |
| `f`   | A wrong token, a closed port, an `apiUrl` ending in `/api/v1`, a token without the scope, and missing repositories, pull requests, owners and users, each reported as what it is and stopped before a write                                                                                                                                                                                                                                              |
| `g`   | The stagecraft tracker's labels made twice or another label touched; an answer made twice; a forge refusal that throws instead of being answered; a pull request taken for a ticket; a status move made twice or a second status label kept; another repository's dependency, or one past the first page, read wrong; a one-sided relation; a repository without the labels, without dependencies, or renamed; stagecraft's conformance workflow failing |
| `h`   | A list cut at its first page (issues, the issue search, labels, push mirrors); an organization's label, a pull request's labels; a repository without issues; topics cleared or too many; a write without the scope, a refused read or delete, each carrying the forge's message; a pull mirror's settings or source compared wrong; a user's push mirrors missed; any token anywhere in `$REPO/.swamp`                                                  |

Every refusal is also checked for secrets: no run's output or error may carry a
token, a password or a planted marker (`FIXTURE-SECRET-...`), and the last check
greps the whole `.swamp` directory for all of them.

## Faults injected over the real forge

`faults_live.ts`, run by `deno task test:live` from the extension's directory,
covers what the forge does not do on demand. Every call goes to the container
through the package's own transport, except the one call a test picks, which a
wrapper at the client seam fails or answers differently (a wrapper of the
transport's caller, or of `fetch` for the transport itself). Nothing stands in
for the forge. Without the forge it fails at once and says to run `forge.sh up`;
it needs `.work/tokens/admin` and makes and deletes its own repositories and
organization. It takes about five seconds and checks:

- a request the forge never answers is aborted at `httpTimeoutMs`, in both
  transports, and the tracker answers it as `upstream` instead of throwing;
- a redirect to another place is named, with a token in its Location masked; the
  token check fails a 403 that names no scope;
- the tracker answers a 429 as `rate_limited`; a `relate` whose second body
  write fails with a 500 is completed by the retry; `create` answers from the
  forge's reply when every read after it fails, and files one issue;
- `repo_merge_settings_ensure` refuses a change the forge accepts and does not
  apply, another setting moved by the write, pull requests turned off by it, and
  records a setting the forge does not report as `null`; `repo_units_ensure`
  refuses a change not applied;
- `pr_merge_state` refuses a merged pull request without a merge commit;
  `org_delete` leaves the organization when its listing fails and when the
  delete is refused;
- `push_mirror_ensure` records a mirror as created when queueing its first push
  fails with a 500; a pull mirror's migration error that quotes the source token
  is masked; `listIssues` reads an answer that is not a list as no issues.

The unit tests in `..` follow swamp's testing guide: each method runs through
`createModelTestContext` with a minimal stub client per test (`stub_test.ts`),
one success and one failure path at least, asserting on the records written;
pure functions are tested as they are. They pin what a method sends, writes and
refuses; this suite is the proof against a real forge.

## What the suite proved wrong, and now checks

A first run of this suite, on 2026-11-11 against version 2026.11.11.2, found six
places where the extension did the wrong thing on Forgejo 15.0.11. 2026.11.12.1
fixes them, and each is now a check that passes:

- **A renamed repository's old name.** Forgejo answers it with a 301 to the new
  name, and the transport followed it: `repo_delete` of the old name with
  `allowContent=true` deleted the renamed repository, and `repo_ensure` patched
  it. Batch `e` renames a repository with commits and checks that `repo_delete`,
  `repo_ensure` and `repo_units_ensure` of the old name are refused with
  `fxorg/old-name was renamed; it now redirects to
  /api/v1/repos/fxorg/new-name`,
  and that the renamed repository is untouched.
- **An issue filed twice.** `issue_ensure` searched through the forge's issue
  indexer, which lags, and a rerun within a second filed the issue again. Batch
  `c` reruns at once and finds both issues.
- **A failed pull-mirror migration.** Forgejo 15 leaves an empty repository
  marked mirror; `pull_mirror_ensure` called it `unchanged` and `mirror_ensure`
  got an HTTP 500 patching it. Batch `d` checks that the forge leaves it, that
  both methods refuse it and ask for `repo_delete`, that `mirror_status` records
  it stale, and that `repo_delete` removes it.
- **A collaborator grant on a public repository.** The forge answers the
  permission probe with `read` for anyone, so a new grant was `updated` and a
  read grant added nothing. Batch `a` grants read on the public `fxorg/tool` and
  checks it is `created` and the user is a collaborator.
- **The registration token's vault.** The resource named a vault `infra`;
  without one the method failed. `models.sh` makes no such vault, and batch `d`
  checks the record holds a vault reference and no token.
- **A repository's `runner_prune` and the organization's runners.** It failed
  with HTTP 404 on an organization runner of the same name. Batch `d` registers
  one of each, and checks the repository's is deleted and the organization's
  kept, with the reason.

Folding in `tag_protection_ensure` found one more on its first live run: Forgejo
stores a whitelisted login that cannot write to the repository but leaves it out
of the rule's answer and of its effect, silently, so the method as fabrikk had
it reported `updated` on every run and changed nothing. It now checks the
forge's answer and refuses, naming the login; batch `b` sees the refusal, grants
write access, and sees the rule as asked.

Smaller ones, also checked: a refused connection names the URL it tried (batch
`f`); `.../own` and `.../own.git/` are one push-mirror remote (batch `d`).
`push_mirror_sync_now` still passes on the forge's HTTP 500 while a mirror
cannot push, as the package README says, and the tracker answers an unreachable
forge as `upstream`.

## Not exercised

- `work_item_sync` needs a `@swamp/software-factory` model with a work item;
  only its refusal of a factory without one is checked, and that no issue was
  filed. What it does with a work item (the issue filed from the outcome, the
  section rewritten in place, a comment on a stage change or a new blocking
  finding, the issue closed at the end) was checked by unit tests on a fake
  forge and a fake factory, now deleted; its two pure functions are still
  tested, and the rest is not tested until a factory can be run here.
- A pull mirror from GitHub, a push mirror to GitHub, and anything else that
  needs a host other than 127.0.0.1: every mirror here pulls from or pushes to
  the forge itself.
- A runner that is online: the runners are registered with
  `forgejo-cli actions register` and never connect, so `runner_prune` keeping a
  live runner is not seen.
- An instance with Actions disabled: the unit the forge does not apply is
  injected in `faults_live.ts` instead.
- `set_status` removing the issue's own status label when the organization has a
  label of the same name, and that `fetch_issue` reads every comment in one
  call: both were unit tests on a fake forge, now deleted. The first needs an
  organization label that every other check's repository would share; the second
  is a request count the live suite cannot see.
- Owner and repository names that need URL encoding: the forge accepts none.

## Environment

Run on 2026-11-12 against `@dataverket/forgejo` 2026.11.12.1 loaded from source,
on Linux 7.0.0 x86_64 with rootless podman 6.2.0, image
`code.forgejo.org/forgejo/forgejo:15.0.11-rootless`
(`sha256:ab0b8fd8bfc55b6e0721347c0173c128c6431b3543ff2ab7a863929f1c5d2629`,
reporting `15.0.11+gitea-1.22.0`), SQLite, swamp
`20261111.064818.0-sha.3509d253` with `@swamp/stagecraft` pulled from the
registry, and deno 2.9.8. All eight batches passed, 346 checks: `a` 34, `b` 47,
`c` 62, `d` 64, `e` 23, `f` 30, `g` 58, `h` 28; then `deno task test:live`, 14
tests, passed. `forge.sh up` took 6 s, `models.sh` 14 s, the batches 266 s and
`test:live` 6 s, under five minutes in all.
