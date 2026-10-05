# Smoke and negative suite

What the unit tests cannot say: that the signing, the paths, the TLS handling
and `check`'s data query are the ones a real versitygw v1.8.0 and a real swamp
repository agree to. It runs against two throwaway gateways in podman and spends
most of its effort on what should _not_ happen.

## Run it

```sh
# 1. two gateways, plain and TLS, seeded with accounts, buckets and settings
./gateway.sh up

# 2. a swamp repository loading this extension from source, and the models
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none && swamp extension source add "$OLDPWD/..")
./models.sh

# 3. the suite
for b in a b c d e; do ./neg-$b.sh; done

# 4. and away
./gateway.sh down
```

`record.sh` re-records the unit tests' fixtures from the plain gateway, right
after `gateway.sh up`; nothing else writes to `../fixtures`.

## What each batch is for

| Batch | What it refuses to let pass                                                                 |
| ----- | ------------------------------------------------------------------------------------------- |
| `a`   | A root key source missing, doubled, absent or empty; the environment source, and forgetting |
| `b`   | A wrong secret, a wrong region, a writer's key, a closed port, a wrong prefix, no bucket    |
| `c`   | A certificate chain the site's CA does not sign, recorded by `health` and fatal elsewhere   |
| `d`   | `check` reading anything but its own inventory; ids shaped as injection; unknown rules      |
| `e`   | Records that differ between two inventories; a secret or the root key anywhere in `.swamp`  |

Every refusal is also checked for secrets: no run's output or error may carry an
account secret or the root secret.

## Against a Ceph radosgw

The `rgw` and `s3` backends were verified on 2026-10-05 against the radosgw of
the Incus and Ceph testbed (`../../incusdev-vm`): `task up`, then
`task s3-credentials admin` and `task s3-credentials` into two key files, the
admin user given the `system` flag
(`radosgw-admin user modify --uid
incusdev-admin --system`), five buckets made
as the user, plain, versioned, locked with `GOVERNANCE` and with `COMPLIANCE`
default retention, and one with a public-read policy. A scratch swamp repository
loading this extension from source, one model per backend, ran `inventory` and
`check`: the governance bucket passes, the compliance one is a `lock-mode`
finding, the versioned one `versioning-without-lock`, the public one
`bucket-public`, and no secret reaches `.swamp/`. The run is by hand so far; a
script is the follow-up.
