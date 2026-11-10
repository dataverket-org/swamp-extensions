# Smoke and negative suite

What the unit tests cannot say: that the container engine takes the arguments
this type gives it, that the Renovate image reads a read-only mount and prints
the report and the configuration line the type reads, that real registries
answer the way the type sorts, what is really in a running container's
environment, that a container whose client had to be killed is removed, that the
engine stops one when swamp itself is killed, and that swamp stores the records
under the names the type gives them. The suite runs `lookup` through swamp from
a scratch repository that loads the extension from source.

## Environment

The suite was run on 2026-11-10 on Linux x86_64 with:

| Tool     | Version  |                                         |
| -------- | -------- | --------------------------------------- |
| podman   | 4.9.3    | rootless                                |
| Renovate | 44.226.2 | `ghcr.io/renovatebot/renovate:44.226.2` |
| swamp    | 20261110 |                                         |
| git      | 2.56.0   | makes the fixture repositories          |
| jq       | 1.8.2    | reads the output of swamp               |

- The Renovate image must be held by the engine before the suite starts: every
  model of the suite sets `pull: never`, so the suite never downloads it. The
  pull itself was not run live; it is covered by the unit tests, and by one live
  case of a pull that fails.
- `live.sh` and `config.sh` need network access to Docker Hub and the npm
  registry. Their assertions say that an old pin has a newer version, never
  which one, so a new upstream release does not break it. It depends on four
  facts about the world: `alpine` has a release after 3.18.0, `nginx` after
  1.25.0, `lodash` after 4.17.20 and `redis` a major release after 6; and on
  `left-pad` 1.3.0 staying the last release of that retired package. `neg.sh`
  and `engine.sh` need no network.
- Size, measured with `podman stats --no-stream` twice a second while `live.sh`
  ran: one Renovate container used at most 504 MB of memory and up to 1.3 CPUs.
  Containers run one after another, so that is the most at any time. One
  repository took 3.6 to 7.5 seconds, a refused configuration 2.5 seconds; a
  path that is not looked up takes a millisecond. swamp itself was not measured.
  The memory was measured before Renovate was switched to always run at debug
  and was not measured again. The time each batch took is under "Last run".
- `fixtures.sh` builds three images on top of the Renovate image, each one layer
  of metadata, to stand in for a Renovate that hangs, prints something else, or
  exits non-zero: `localhost/renovate-smoke-hang:1`, `-garbage:1` and
  `-exit3:1`. The suite needs them and leaves them; remove them with
  `podman rmi` when done. Nothing is pushed.
- `fixtures.sh` also makes a symbolic link to `/dev/zero` and two FIFOs (with
  `mkfifo`) under `$REPO/fix`, where a configuration file would be. Do not `cat`
  the fixture tree.
- `engine.sh` sets `HTTPS_PROXY`, `http_proxy` and `NO_PROXY` for the swamp
  process it starts, with a planted password, and reads the running container's
  environment with `podman inspect`. No proxy listens; the stand-in image only
  sleeps. Its last case kills swamp with SIGKILL and waits up to a minute for
  Podman's `--timeout` to stop the container; that run leaves the lock of the
  model `rn-killed` behind in the scratch repository.
- Not run: Docker, Podman as root, macOS, and a host with SELinux enforcing.
  With Docker or Podman as root the type gives no `--userns`, so the image's
  user must be able to read the directory; the fixture that only its owner can
  enter is expected to fail there. On Docker the type gives no `--timeout` and
  no `--http-proxy`, so the three checks of `engine.sh` about them are expected
  to fail there. macOS on Apple silicon is expected to work with a Podman
  machine of at least 2 CPUs and 2 GiB, for directories the machine shares with
  the host; not run. On an SELinux host the read-only bind mount may be refused
  without a label, which the type does not set; not run.
- Not run live: a proxy that works (`passProxy` was only checked for what
  reaches the container and what is kept), a named network with restricted
  egress (`network` was run with `none` only), more than six repositories in one
  run, a repository large enough to pass the default time limit, and an output
  large enough to be cut or to pass the 32 MiB bound.

## Run it

```sh
# 1. the Renovate image, already pulled, and the engine
export RENOVATE_IMAGE=ghcr.io/renovatebot/renovate:<version> RUNTIME=podman

# 2. a swamp repository loading this extension from source
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none && swamp extension source add "$OLDPWD/..")

# 3. the fixture repositories under $REPO/fix, the stand-in images, the models
./fixtures.sh
./models.sh

# 4. the suite; engine.sh last
./neg.sh
./live.sh
./config.sh
./engine.sh
```

Every fixture lives under `$REPO/fix`, and the suite looks up nothing else. Each
batch takes a checksum of every fixture file, its mode and its `git status`
before and after, and fails when anything changed. It also fails when a
container named `renovate-local-*` is left.

## What each batch is for

| Batch       | What it holds the extension to                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |
| ----------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `neg.sh`    | Refused before anything starts: `repo` and `repos` together, neither, an empty list, one value given as `repos`, a list given as `repo`, the same directory twice, under two spellings and through a symbolic link, paths shaped like flags, an empty path, a directory with a comma or a double quote, a data name that would be too long, a container binary that is not there (named by the pre-flight check), a definition with no argument at all, an image that is not held with `pull: never`, an image no registry serves; nine definitions swamp must not accept, three of them a `network` that would widen what the container reaches; a path that is not well-formed Unicode, given as JSON. Recorded, not thrown: a missing path, a file, a directory without configuration, one with only `.forgejo/renovate.json`, a path of shell text, paths that climb with `..` (stored under names swamp takes), a path named like one of swamp's own reports (stored beside the report, not under it), a symbolic link to `/dev/zero` and a FIFO where a configuration would be; a Renovate that hangs (stopped at 10 seconds, its container removed), one that prints something else, one that exits 3 and prints a token; four states in one run |
| `live.sh`   | Old pins in a Dockerfile, a Kubernetes manifest and a `package.json` each have a newer version, with manager, file and datasource; the configuration Renovate read and the dependencies it looked up are counted; a major update is counted; the counts agree with the list; a GitHub Action is skipped without a token and the lookup is then not complete; a retired package is up to date; an image no registry serves is unresolved while the one beside it is looked up; a refused configuration is `failed` although Renovate exits zero, and a value planted in it is nowhere in swamp's data; an uncommitted change is read and an untracked file is not; a plain directory is read whole; a directory only its owner can enter; a path with a space and a colon; an absolute path; names with `..`; `logLevel: debug`; six repositories in one run with one inventory, in order, the failed one not stopping the next; a workflow whose CEL assertion holds for one repository and fails for another                                                                                                                                                                                                                                           |
| `config.sh` | Every form of configuration that was run is recorded as read, with the form in `configRead`: a `renovate` key in `package.json` (and one that switches Renovate off is obeyed and ends `disabled-by-config`), a JSON5 file with a comment under `.github/`, a `.renovaterc`. Three repositories where nothing is looked up (another manager only, every package disabled, no package file) are `nothing-looked-up` and not up to date; a configuration Git does not track is `config-not-read`, with what Renovate proposed on its defaults still listed                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                |
| `engine.sh` | While a container runs: the host's proxy variables, set with a password, are not in its environment; Podman holds a time limit of its own, 30 seconds past the client's; the method's log names the container. An interrupted run: cancelled, no record, no container left. With `passProxy`: the variables are in the container, and the password is nowhere in swamp's data or output. `network: none`: Renovate exits zero and the record is `failed` with `external-host-error`. swamp killed with SIGKILL: the container outlives it and Podman stops it at its own limit                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                                          |

## Run logs

The scripts print one `PASS` or `FAIL` line per check and a count, and keep no
log. `$REPO/.out.json` and `$REPO/.err.txt` hold the output of the last swamp
run only and are overwritten by the next. To keep a run, redirect it:
`./live.sh | tee live.log`.

## Last run

2026-11-10, Renovate 44.226.2 on rootless podman 4.9.3, swamp 20261110, Linux
x86_64, from a fresh scratch repository: `neg.sh` 48 checks in 1 minute 13
seconds, `live.sh` 32 checks in 1 minute 55 seconds, `config.sh` 12 checks in 45
seconds and `engine.sh` 18 checks in 1 minute 32 seconds, all passed. The run
started at 20:15:19 local time, after the last write to any source file of the
extension at 20:14:44 (a unit test; `local.ts` was last written at 20:12), and
ended at 20:21:07. Only this file was written afterwards: this section, and the
lines above that name the fourth batch.

The configuration forms that were not run live (`renovate.jsonc`,
`renovate.json5` at the root, the `.gitlab/` location, `.renovaterc.json` and
its two variants) were each run once by hand at debug with Renovate 44.226.2 to
capture what it logs; the unit tests read those captured lines from
`testdata/config_lines.json`.
