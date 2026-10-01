# Smoke and negative suite

What the unit tests cannot say: that the paths, bodies and lifecycle rules are
the ones a real Zitadel and a real swamp repository agree to. It runs against a
throwaway instance in podman, and it spends most of its effort on what should
_not_ happen.

## Run it

```sh
# 1. a Zitadel of your own, with a service-user key written out at startup.
#    ZITADEL_VERSION picks the release; run the suite on the one you deploy.
mkdir -p machinekey && chmod 777 machinekey     # rootless podman writes as another uid
ZITADEL_VERSION=v4.15.3 podman compose -p zit-test up -d
until curl -sf http://localhost:8899/debug/healthz; do sleep 3; done

# 2. a swamp repository with every model the batches name, in a directory of
#    its own. setup.sh loads the extension from this checkout, makes the
#    models, the second organization, more than a page of users and projects,
#    the workflow, and two keys that may do less than the first one.
mkdir /tmp/zit-smoke && cd /tmp/zit-smoke
<this directory>/setup.sh <this directory>/machinekey

# 3. the suite
export REPO=$PWD ORG=$(cat org-id.txt)
./fixtures.sh && for b in a b c d e f g h i j k l m n o p; do ./neg-$b.sh; done

# 4. and away. setup.sh also left a copy of the throwaway key under
#    ~/.cache/zitadel-smoke/, which batch E reads through a ~/ path.
podman compose -p zit-test down --volumes
rm -rf /tmp/zit-smoke ~/.cache/zitadel-smoke
```

## What each batch is for

| Batch | What it refuses to let pass                                                          |
| ----- | ------------------------------------------------------------------------------------ |
| `a`   | A delete without the right `confirm`, and `dryRun` that only reports                 |
| `b`   | Deleting what is already gone, and never deleting a neighbour by mistake             |
| `c`   | The wrong kind of thing: a human where a machine was meant, a name that is not there |
| `d`   | Arguments the schema should catch before Zitadel is asked                            |
| `e`   | Credentials missing, doubled, unreadable, malformed — and never echoed in an error   |
| `f`   | Converging rather than accumulating, and not clobbering what was not mentioned       |
| `g`   | Names with spaces, slashes and non-ASCII letters; a delete that cascades             |
| `h`   | Secrets at rest, and swamp's own lifecycle rules for a model whose resources went    |
| `i`   | Actions: targets, executions, and a delete an execution still depends on             |
| `j`   | A project granted to another organization, and taken back only by its name           |
| `k`   | Settings: the scope each came from, and writes refused before the API sees them      |
| `l`   | Authentication factors and identity-provider links nobody has                        |
| `m`   | More than a page of users and projects, listed to the end                            |
| `n`   | A swamp workflow, run twice, with every resource unchanged the second time           |
| `o`   | Every minted secret stored as a vault reference, and a report after a failure        |
| `p`   | Keys that may do less: a reader that changes nothing, an owner of one project that   |
|       | touches no other; one name for a grant from `list` and `ensure`; a default auth      |
|       | method read back; a definition from an older type version migrated on its first run  |

`fixtures.sh` makes the least it can that the negatives need, and is the only
batch that walks a golden path.
