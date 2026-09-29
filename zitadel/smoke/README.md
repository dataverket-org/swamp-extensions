# Smoke and negative suite

What the unit tests cannot say: that the paths, bodies and lifecycle rules are
the ones a real Zitadel and a real swamp repository agree to. It runs against a
throwaway instance in podman, and it spends most of its effort on what should
_not_ happen.

## Run it

```sh
# 1. a Zitadel of your own, with a service-user key written out at startup
mkdir -p machinekey && chmod 777 machinekey     # rootless podman writes as another uid
podman compose -p zit-test up -d
until curl -sf http://localhost:8899/debug/healthz; do sleep 3; done

# 2. a swamp repository with the five models pointing at it
swamp repo init
swamp extension source add ../../zitadel
swamp vault create local_encryption testvault   # the minted secrets need somewhere to go
for t in org project app user grant; do
  swamp model create @dataverket/zitadel/$t zitadel-$t \
    --global-arg apiUrl=http://localhost:8899 \
    --global-arg keyJsonFile="$PWD/machinekey/swamp-admin.json"
done

# 3. batch J grants the project to a second organization, which the org type
#    deliberately cannot create, so the scaffolding makes one
export ORG=$(deno run --allow-read --allow-net --allow-env mkorg.ts \
  "$PWD/machinekey/swamp-admin.json" http://localhost:8899 "Annen organisasjon")

# 4. the suite; batch E also wants the cred-* models (see neg-e.sh)
# batch m wants more than a page of things, and n wants the workflow
deno run --allow-read --allow-net --allow-env bulk.ts "$PWD/machinekey/swamp-admin.json" \
  http://localhost:8899 users 120
deno run --allow-read --allow-net --allow-env bulk.ts "$PWD/machinekey/swamp-admin.json" \
  http://localhost:8899 projects 120
swamp workflow create zitadel-selftest        # then copy this directory's
                                              # workflow-zitadel-selftest.yaml
                                              # over the scaffold, keeping its id

REPO=$PWD ./fixtures.sh && for b in a b c d e f g h i j k l m n o; do REPO=$PWD ./neg-$b.sh; done

# 5. and away
podman compose -p zit-test down --volumes
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

`fixtures.sh` makes the least it can that the negatives need, and is the only
batch that walks a golden path.
