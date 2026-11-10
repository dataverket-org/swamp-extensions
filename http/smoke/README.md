# Smoke and negative suite

What the unit tests cannot say: that a definition as swamp stores it, an object
argument given on the command line or written by hand, reaches `bodyJson` with
its types, that the record passes swamp's schema check, and that a definition of
the version before still runs. It needs no credential and writes nothing but
health records in a scratch repository.

## Run it

```sh
# 1. a local server with one path per answer, on 127.0.0.1:18080
deno run --allow-net=127.0.0.1 server.ts 18080 &

# 2. a scratch swamp repository loading this extension from source
export REPO=$(mktemp -d)
(cd "$REPO" && swamp repo init --tool none && swamp extension source add "$OLDPWD/..")

# 3. the suite against the local server
./local.sh

# 4. two plain GETs of a real OIDC discovery document
URL=https://id.example.org/.well-known/openid-configuration \
ISSUER=https://id.example.org ./public.sh

# 5. and away
kill %1
```

`BASE` moves `local.sh` to another port. `public.sh` takes the document and the
issuer it must name; its defaults are placeholders and reach nothing.

## What each batch is for

| Batch        | What it refuses to let pass                                                                                                                                                    |
| ------------ | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| `local.sh` A | Nothing: an exact issuer, a nested subset, both assertions together, a redirect, nothing asked                                                                                 |
| `local.sh` B | A longer issuer a substring accepts, a text for a number, a missing field, an array in another order, inherited names, a body value in the record without `bodyJsonShowValues` |
| `local.sh` C | A body that is HTML, JSON as text/plain, not JSON, an array, a text, a key twice, 100 levels deep, 2 MiB, endless, not UTF-8, slower than the timeout, cut short               |
| `local.sh` D | A `bodyJson` that is a text, or names a field `__proto__`                                                                                                                      |
| `local.sh` E | A definition of 2026.10.29.1 that stops working, or is not stamped with the new version                                                                                        |
| `public.sh`  | A right issuer that fails over a verified chain, a wrong one or a trailing slash that passes                                                                                   |
