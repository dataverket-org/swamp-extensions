# @dataverket/renovate

What is out of date in the repositories on your disk, as swamp data.
[Renovate](https://docs.renovatebot.com) is run in its local mode over one
directory or a list, and the updates it would propose are recorded. One model
type, `@dataverket/renovate/local`, one method, `lookup`.

- **It is** a read of your repositories: Renovate looks at the files as they are
  on disk, asks the registries what is newer, and prints a report. A workflow
  can then assert "no major update pending", and a report can sum over
  repositories.
- **It is not** Renovate as a service. It opens no pull request, contacts no
  forge, takes no token, discovers no repositories on a server, and writes
  nothing into a repository. It does not check the signature of the Renovate
  image either.

Renovate itself stays in its container. The machine needs Podman or Docker and
network access to the registries your dependencies come from. Read
[What a repository can make this do](#what-a-repository-can-make-this-do) before
you run it on a repository you do not trust.

## Arguments

Of the definition:

| Argument             | Default   |                                                                                                                             |
| -------------------- | --------- | --------------------------------------------------------------------------------------------------------------------------- |
| `image`              |           | the Renovate image, required. It is the Renovate version: name a version tag or a digest                                    |
| `containerBinary`    | `podman`  | `podman` or `docker`, by name from `PATH` or as a path                                                                      |
| `timeoutSeconds`     | `300`     | how long Renovate may run on one repository, 10 to 3600                                                                     |
| `pull`               | `missing` | `missing` pulls the image once when the engine does not hold it; `never` fails instead                                      |
| `pullTimeoutSeconds` | `600`     | how long that pull may take, 10 to 3600; the image is about 1.4 GB                                                          |
| `logLevel`           | `info`    | how much of Renovate's log reaches the method's log: `info` its warnings and errors, `debug` the rest too                   |
| `passProxy`          | `false`   | Podman only: pass the host's proxy variables into the container; see "Proxies and engine settings"                          |
| `network`            |           | given to the engine as `--network`: `none`, or the plain name of a network you made. Left out, the engine's default network |

`image` has no default on purpose. A default with a version would go stale with
every Renovate release, several a day, and a default that moves would change
your results without any change of yours. A tag such as `latest` is accepted;
each record says which Renovate version really ran.

Of `lookup`, exactly one of:

| Argument | Type   |                                                   |
| -------- | ------ | ------------------------------------------------- |
| `repo`   | string | one repository directory                          |
| `repos`  | list   | several, at most 200, looked up one after another |

A path is absolute, or relative to the root of the swamp repository. Giving both
arguments, neither, an empty list, the same directory twice, a path that starts
with `-`, or a directory with a comma or a double quote in its name (the
engine's `--mount` cannot take either) is refused before anything is started.
"The same directory" is decided by where the paths lead on disk, so another
spelling of a path and a symbolic link to it both count.

## Use

```yaml
# renovate
globalArguments:
  image: ghcr.io/renovatebot/renovate:<version>
```

```sh
swamp behavior create @dataverket/renovate/local renovate \
  --global-arg image=ghcr.io/renovatebot/renovate:<version>

swamp behavior run renovate lookup --input repo=<path>
swamp behavior run renovate lookup --input 'repos=["<path>","<other path>"]'
```

There is no method that searches a folder for repositories. Build the list in
the shell instead, for example from every directory under `<folder>` that has a
`renovate.json`:

```sh
repos=$(for d in <folder>/*/; do
  [ -f "$d/renovate.json" ] && printf '%s\n' "${d%/}"
done | jq -R . | jq -sc .)
swamp behavior run renovate lookup --input "repos=$repos"
```

In a workflow, one step looks the list up and the next asserts on the records. A
list is one method run, not one step per repository: runs of one behavior wait
for each other.

```yaml
jobs:
  - name: lookup
    steps:
      - name: renovate
        task:
          type: model_method
          modelIdOrName: renovate
          methodName: lookup
          inputs:
            repos:
              - <path>
              - <other path>
  - name: verify
    dependsOn:
      - job: lookup
        condition:
          type: succeeded
    steps:
      - name: no-major-update-pending
        task:
          type: assert
          expr: >-
            data.latest("renovate", "inventory_all").attributes.okCount == data.latest("renovate", "inventory_all").attributes.count
            && data.latest("renovate", "inventory_all").attributes.updateCounts.major == 0
          message: A major update is pending, or a repository could not be looked up
```

For one repository, with the data name of its path (next section):

```yaml
expr: >-
  data.latest("renovate", "repo-apps_2fweb").attributes.status == "ok"
  && data.latest("renovate", "repo-apps_2fweb").attributes.updateCounts.major == 0
```

## What to assert on

- **"Everything was looked up"**: `okCount == count` on the inventory, or
  `status == "ok"` on a repository. `failedCount == 0` alone is not enough: a
  repository where nothing was looked up, or whose configuration Renovate did
  not read, is neither `failed` nor `ok`.
- **"Nothing is out of date"**: `upToDate`. It is true only when Renovate read
  the repository's configuration, looked up at least one dependency, every
  lookup it tried got an answer, and no update came back. It means "Renovate
  proposes nothing under this repository's own configuration", not "nothing
  newer exists": a configuration that holds versions back (`allowedVersions`, a
  disabled update type, a schedule) gives `upToDate: true` beside an old pin.
- **"No update of this kind"**: `updateCounts.major == 0` and the like, together
  with `status == "ok"`. A count of zero says nothing by itself: it is also zero
  when nothing was looked up.
- **"The lookup covered what I think it covers"**: `lookedUpCount` and
  `packageFileCount`. A configuration can switch managers off, ignore paths or
  disable packages, and Renovate then looks up less than is in the repository,
  without a warning.

## Data names

Each repository's record is stored under `repo-` and the path as you gave it,
less trailing slashes, encoded: letters, digits and `-` stay, and every other
character becomes `_` and the two hex digits of each of its bytes. A `.` stays
too, unless it starts the path or comes right after another `.`; there it
becomes `_2e`, because swamp stores no name that holds `..`.

| Path           | Data name                 |
| -------------- | ------------------------- |
| `web`          | `repo-web`                |
| `apps/web`     | `repo-apps_2fweb`         |
| `my_app`       | `repo-my_5fapp`           |
| `/srv/git/web` | `repo-_2fsrv_2fgit_2fweb` |
| `.`            | `repo-_2e`                |
| `../web`       | `repo-_2e._2fweb`         |
| `my..repo`     | `repo-my._2erepo`         |

Two different paths never share a name. The name comes from the path as given,
not from the directory it leads to: `../web` and `/srv/git/web` are two names
for one directory, each with its own history. Name a directory the same way
every time; within one run a second name for it is refused. A name longer than
255 bytes cannot be stored, so such a path is refused before anything starts; a
path relative to the swamp repository is shorter than an absolute one. A path
that is not well-formed Unicode is refused too.

The prefix keeps repository records apart from everything else stored for the
definition: the record of a whole run, `inventory_all`, and the records swamp
writes itself on every run, whose names start with `report-`. No path can be
stored under either.

swamp keeps the arguments of every method run, so the paths you pass are in its
run history as given, and each record holds the absolute directory in
`directory`. Do not put anything secret in a path.

## The repository record

| Field                                           |                                                                                                                                                           |
| ----------------------------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `path`, `directory`, `dataName`                 | the path as given, the absolute path that was mounted, the record's name                                                                                  |
| `status`                                        | `ok`, `failed`, `nothing-looked-up`, `config-not-read`, `no-config` or `not-a-directory`; see below                                                       |
| `ok`                                            | `status` is `ok`                                                                                                                                          |
| `failure`, `reason`                             | for `failed`, which way (`timeout`, `exit`, `too-large`, `no-report`, `report-shape`, `result`); one line that says why `status` is not `ok`              |
| `lookupComplete`                                | `ok`, and no dependency unresolved, none skipped for want of a GitHub token, no entry of the report unreadable                                            |
| `upToDate`                                      | `lookupComplete` and no update proposed                                                                                                                   |
| `image`, `renovateVersion`                      | the image argument, and the version Renovate reported                                                                                                     |
| `configFile`, `configRead`, `git`               | the first configuration file found on disk, the one Renovate says it read, and whether the directory holds `.git`                                         |
| `ranAt`, `durationMs`                           | when the lookup of this repository started and how long it took                                                                                           |
| `packageFileCount`, `dependencyCount`           | package files Renovate found dependencies in, and the dependencies in them                                                                                |
| `lookedUpCount`, `outdatedCount`                | dependencies that were looked up and answered (not skipped, not unresolved), and how many have an update                                                  |
| `updateCount`, `updateCounts`                   | proposed updates, and by type: `major`, `minor`, `patch`, `digest`, `pin`, `pinDigest`, `bump`, `rollback`, `replacement`, `lockFileMaintenance`, `other` |
| `unresolvedCount`, `unresolved`                 | dependencies whose lookup failed, each with Renovate's sentence                                                                                           |
| `skippedCount`, `tokenRequiredCount`, `skipped` | dependencies Renovate did not look up, with its reason; and how many of them for want of a GitHub token                                                   |
| `unreadableCount`                               | entries of the report that did not have the shape of a dependency                                                                                         |
| `updates`                                       | the proposed updates, below                                                                                                                               |
| `warningCount`, `warnings`                      | the problems Renovate reports for the repository: `level`, `message`, `detail`                                                                            |
| `truncated`                                     | a list was cut at its bound: 500 updates, 100 unresolved, 100 skipped, 50 warnings. The counts are never cut                                              |

`status` is the first of these that applies:

| `status`            | Renovate ran | What it means                                                                                                                      |
| ------------------- | ------------ | ---------------------------------------------------------------------------------------------------------------------------------- |
| `not-a-directory`   | no           | the path is missing or is no directory                                                                                             |
| `no-config`         | no           | no Renovate configuration file in the directory                                                                                    |
| `failed`            | yes          | it passed its limit, exited non-zero, printed too much, no report or one of another shape, or ended the repository with an error   |
| `config-not-read`   | yes          | a configuration file is there and Renovate did not read it, so it ran on its defaults; what it proposed is listed and means little |
| `nothing-looked-up` | yes          | it read the configuration and looked up no dependency: none found, all skipped, or every lookup failed                             |
| `ok`                | yes          | it read the configuration, looked up at least one dependency, and its report was read                                              |

One entry of `updates`: `depName`, `packageName`, `datasource`, `manager`,
`packageFile`, `depType`, `currentValue` (as written in the file),
`currentVersion`, `currentDigest`, `newValue`, `newVersion`, `newDigest`,
`updateType`, `isBreaking`, `releaseTimestamp`, `newVersionAgeInDays`. A field
Renovate did not report is `null`.

A repository where half the lookups failed has `ok: true`,
`lookupComplete: false` and `upToDate: false`. A dependency that Renovate skips
for another reason than the token, such as a version it cannot read, does not
hold `lookupComplete` back: Renovate skips those on any platform.

The `inventory_all` record has one line per repository of the run in `items`
(`path`, `dataName`, `status`, `ok`, `lookupComplete`, `upToDate`,
`lookedUpCount`, `updateCount`, `majorCount`, `reason`) and the totals: `count`,
`okCount`, `failedCount`, `nothingLookedUpCount`, `configNotReadCount`,
`noConfigCount`, `notADirectoryCount`, `upToDateCount`, `outdatedCount`,
`incompleteCount`, `updateCount`, `updateCounts`, with `image`, `engine`,
`renovateVersion`, `observedAt` and `durationMs`. The update totals are summed
over every record that has updates, also one that is not `ok`.

## What fails the method and what is recorded

The method succeeds when every repository has a record, whatever the records
say. Assert on the records to fail a workflow.

Recorded for the repository, and the next one is looked up:

- the path is missing or no directory (`not-a-directory`);
- the directory has no Renovate configuration (`no-config`); Renovate is not
  started, because without one it would propose updates from its defaults. Only
  a regular file counts: a symbolic link, a FIFO or a directory with a
  configuration's name is never opened, and `package.json` is read to 1 MiB;
- Renovate ran past `timeoutSeconds`, exited non-zero, printed more than 32 MiB,
  no report or one of another shape, or ended the repository with an error
  (`failed`). Renovate exits zero for a configuration it refuses
  (`config-validation`), one that switches it off (`disabled-by-config`) and a
  registry host it cannot reach (`external-host-error`); all are `failed` here;
- Renovate did not read the configuration file that is there
  (`config-not-read`), or looked nothing up (`nothing-looked-up`).

Thrown: an argument that is refused, a container binary that is not there, an
image that is not held and cannot be pulled, a cancelled run, and a record that
cannot be stored. The first three happen before any repository is looked up.
When a run ends in the middle of a list, the records of the repositories that
were finished stay and **no inventory is written**: an inventory always
describes a whole list, and one for part of it would read as all of it. The
error says how many repositories were done.

## What Renovate reads and writes

- **Files.** In a directory with `.git`, Renovate reads the files Git tracks, as
  they are on disk: a change that is not committed is read, a file Git does not
  track is not. In a directory without `.git` it reads every file. `git` in the
  record says which.
- **Configuration.** In local mode Renovate reads `renovate.json`,
  `renovate.jsonc`, `renovate.json5`, the same three under `.github/` and
  `.gitlab/`, `.renovaterc`, `.renovaterc.json`, `.renovaterc.jsonc`,
  `.renovaterc.json5`, and a `renovate` key in `package.json`. It does not read
  `.forgejo/renovate.json` or `.gitea/renovate.json` in this mode. The rule for
  files holds here too: in a directory with `.git`, a configuration file Git
  does not track is not read, and Renovate runs on its defaults without saying
  so. The type asks Renovate which file it read (`configRead`) and records
  `config-not-read` when it read none. For that, Renovate always runs with
  `LOG_LEVEL=debug`: only there does it say what it read. The answer is taken
  from Renovate's log lines (`Found <file> config file`, `Repository config`
  with its `fileName`, and `package.json>renovate config` for the key in
  `package.json`), as Renovate 44.226.2 writes them for every form in this list.
  Any one of the lines is enough. A later Renovate that words all of them
  differently would make every repository `config-not-read`, which is wrong and
  hard to miss; `renovateVersion` in the record says which version ran.
- **Writes.** Nothing. The directory is the container's only mount and it is
  read-only. Renovate's cache lives in the container, which is removed after
  each run, so nothing is kept between runs either.
- **Network.** Renovate asks the registries of your dependencies, and any other
  host the repository's configuration names. With no network at all
  (`network: none`) it ends the repository with `external-host-error` and the
  record is `failed`; a single registry that does not answer is an unresolved
  dependency.
- **Memory and time.** One run used about 0.5 GB of memory and 4 to 8 seconds
  for a repository with a handful of dependencies. Repositories are looked up
  one after another, so a list needs no more memory than one.

## What a repository can make this do

Renovate does what the repository's configuration says, and the configuration is
a file in the repository. Running `lookup` on a repository runs that file's
instructions on your machine, inside the container:

- **It chooses the hosts.** `extends` with a URL, a custom datasource, a
  `registryUrls` entry or a `hostRules` entry makes the container send requests
  to the host it names. That can be a host on your own network that only your
  machine can reach.
- **It sends its own credentials where it says.** A token in the file's
  `hostRules` goes out as a header to the host the rule names. The type passes
  no credential of yours, and it does not stop the file from sending its own.
- **Its own text can end up in the record.** When Renovate refuses a
  configuration, its message repeats the value it did not like
  (`automerge: "<text>"` comes back as `Found: "<text>"`), and that message is
  kept in `reason` and in the method's log, cut and with credential shapes
  blanked.
- **What a host answers can end up in the record.** A custom datasource's answer
  becomes a proposed update, with the version the host chose. What is kept is
  cut to a bounded length and has credential shapes blanked; it is not checked
  for being true.
- **It reads the directory.** The mount is the whole directory, read-only, so
  anything in it can be read by Renovate and sent where the configuration says.

So run it on repositories you trust, as you would run their build. For others,
give the container a network that cannot reach what it should not: `network` is
passed to the engine as `--network` and takes `none`, or the plain name of a
network you made, for example one with restricted egress. `network: none` cuts
everything, and then every lookup fails. The type makes no network and filters
no hosts itself.

`network` can only narrow. The engine also reads modes there, and some of them
widen what the container reaches: `host` gives it the host's own network, with
the host's loopback, `container:<name>` and `ns:<path>` put it in another
network, and options of `slirp4netns` and `pasta` can open the host's loopback.
A repository's configuration could then read a service that listens only on your
machine. So `host`, `container`, `ns`, `private`, `bridge`, `default`,
`slirp4netns`, `pasta` and any value with `:` options are refused.

## Without a token

No token is taken. Renovate then does not look up dependencies of the
datasources `github-tags`, `github-releases` and `github-release-attachments`,
which is where GitHub Actions and many tools pinned by release come from. It
marks each one skipped with `github-token-required` and warns once. Here that
shows as `tokenRequiredCount` above zero, the dependencies in `skipped`, the
warning in `warnings`, and `lookupComplete: false`. Docker images, npm packages
and the other registries are looked up as usual.

## Proxies and engine settings

The type gives the container two variables, `LOG_LEVEL` and `LOG_FORMAT`, and
nothing from the environment swamp runs in. The engine can add more, and not all
of it is the type's to control:

- **Podman and the host's proxy variables.** Left to itself, Podman copies
  `http_proxy`, `https_proxy`, `ftp_proxy` and `no_proxy`, and their upper-case
  forms, from the host into every container, with the user and password of a
  proxy URL. The type passes `--http-proxy=false`, so they stay out. Behind a
  proxy, set `passProxy: true`: Podman then passes them in, and the type blanks
  each password found in those variables, as written and percent-decoded, in
  every record, log line and error it keeps. The proxy's host and port are not
  blanked and can appear in a `reason`.
- **Docker.** The Docker client has no such flag. It adds the proxy variables
  that `proxies` in `~/.docker/config.json` names to every container, as that
  file's owner asked. The type does not override that and does not read the
  file, so a password there is blanked only by its shape (the user and password
  of a URL always are). `passProxy` does nothing on Docker, and the method's log
  says so when it is set. Not run on Docker.
- **The engine's own configuration.** Environment variables, volumes, mounts and
  DNS settings that `containers.conf` or the Docker daemon adds to every
  container reach this one too. The type cannot see them or switch them off.

## Commands and time limits

The type runs these as subprocesses, with arguments as an argv array, never
through a shell, each with a time limit after which the process is stopped:

| Command                                                       | Limit                                  |
| ------------------------------------------------------------- | -------------------------------------- |
| `<binary> --version`                                          | 30 seconds                             |
| `<binary> info --format {{.Host.Security.Rootless}}` (Podman) | 30 seconds                             |
| `<binary> image inspect --format {{.Config.User}} <image>`    | 30 seconds                             |
| `<binary> pull <image>`, only when the image is not held      | `pullTimeoutSeconds`                   |
| `<binary> run ...`, once per repository                       | `timeoutSeconds`, and 32 MiB of output |
| `<binary> rm --force <name>`, after a stopped run             | 30 seconds                             |

One run on Podman is:

```sh
podman run --rm --pull=never --name renovate-local-<random> \
  --timeout <timeoutSeconds + 30> --http-proxy=false \
  --network <name> --userns keep-id:uid=<image user> \
  --mount type=bind,source=<directory>,target=/repo,readonly --workdir /repo \
  --env LOG_LEVEL=debug --env LOG_FORMAT=json \
  <image> --platform=local --dry-run=lookup --report-type=logging
```

`--network` is only given when the argument is set. `--userns` is only given to
rootless Podman, and only when the image names a numeric user: it maps that user
to you, so Renovate can read a directory that only you can read. With Docker, or
Podman as root, the image's user must be able to read the directory itself.
Docker gets neither `--timeout` nor `--http-proxy`: it has no such flags.

A run that passes its limit, prints too much or is cancelled has its container
removed by name: stopping the engine's client does not always stop the
container. When swamp itself is killed, nothing is left to do that. On Podman
the engine then stops the container by itself, `--timeout` seconds after it
started; on Docker it runs until Renovate ends. The method's log names each
container as it starts, so a person can find and remove one:
`<binary> rm --force renovate-local-<random>`.

The pull has a limit of its own so that it never eats the first repository's.

The pre-flight check `container-binary-available` runs `<binary> --version`
before `lookup`. `lookup` is declared an action, not a read, although it changes
nothing in a repository: swamp runs no check before a read, and this method
starts containers, may pull a large image and can take minutes.

Everything kept from Renovate's output is cut to a bounded length with anything
shaped like a credential blanked. Renovate's own log lines reach the method's
log: its warnings and errors always, at most 100 per repository, and with
`logLevel: debug` its other lines too, at most another 100.

## Testing

`deno task test` runs the unit tests on a strict fake of the container engine:
an unexpected command, flag or time limit fails the test. The negative tests
cover a run that hangs, a missing binary, an image that cannot be pulled, exits
and outputs of every wrong shape, a huge report, planted secrets, hostile paths,
files that are not files, a failing repository among others, and cancelled runs.

The live suite in `smoke/` ran on rootless Podman 4.9.3 on Linux x86_64 with
Renovate 44.226.2 against the real registries, through swamp, from a scratch
repository that loads the extension from source. It also inspects the
environment of a running container, with and without `passProxy`.
[smoke/README.md](./smoke/README.md) in the source repository says what it needs
and how to run it. Docker, Podman as root, macOS and an SELinux host were not
run; on an SELinux host the read-only mount may need a label the type does not
set.

## License

AGPL-3.0-only, see [LICENSE.md](./LICENSE.md). Copyright 2026 Jan Ivar Beddari.
