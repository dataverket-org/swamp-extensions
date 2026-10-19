# @dataverket/sops

A [swamp](https://github.com/swamp-club/swamp) vault with one
[SOPS](https://github.com/getsops/sops)-encrypted file per secret, keyed to
[age](https://age-encryption.org) recipients, committed to git, no service in
the path.

Forked from
[`@zocc/sops-age`](https://github.com/CCAgentOrg/swamp-zocc-extensions)
(Apache-2.0), which keeps every secret in one file and must decrypt it all to
write; the changes are in [NOTICE.md](./NOTICE.md).

## Layout

`put` writes `<secretsDir>/<key>.enc.json`, the object `{"value": …}` encrypted
to the configured recipients. A key with `/` becomes a directory path; `..`,
absolute paths and empty segments are refused.

| Method   | What happens                                         | Needs an identity |
| -------- | ---------------------------------------------------- | ----------------- |
| `put`    | `sops encrypt` into the key's file, public keys only | no                |
| `get`    | `sops decrypt --extract` of that file                | yes               |
| `list`   | walks the directory                                  | no                |
| `delete` | removes the file                                     | no                |

So a writer can store a value for readers it is not among: a human without the
cluster key, or a workflow that mints a credential and hands it on. No write
touches another secret, and `git log` on a file is that secret's history. The
cost is the pattern's own: changing recipients is `sops updatekeys` per file, by
someone who can read it, and a value written for readers you are not among can
only be replaced, not re-keyed.

```yaml
# vaults/@dataverket/sops/<id>.yaml
type: "@dataverket/sops"
config:
  secretsDir: vaults/infra
  agePublicKey: age1yubikey1…,age1… # every recipient, comma separated
  ageKeyName: swamp-infra # <sops key dir>/swamp-infra.txt, when it exists
  ageKeyFile: "" # a path instead; empty: the caller's SOPS_AGE_KEY_FILE
```

## Prerequisites

`sops` on `PATH` (or `sopsPath`); `age` identities wherever sops finds them
(`SOPS_AGE_KEY_FILE`, the default key file, or an age plugin such as
`age-plugin-yubikey`). A `.sops.yaml` rule matching `vaults/.*\.enc\.json` with
the same recipients lets `sops` edit the files from a terminal too.

Two settings name an identity for the vault alone, so that `sops` from a
terminal keeps its own:

- `ageKeyName` is a file name, never a path: `<name>.txt` in the directory where
  sops keeps `keys.txt` (`$XDG_CONFIG_HOME/sops/age`, else `~/.config/sops/age`,
  or `~/Library/Application Support/sops/age` on macOS). It is used when that
  file exists and the caller has not exported `SOPS_AGE_KEY_FILE`; otherwise
  sops decrypts as it would anyway. A vault config with a name in it commits no
  operator's home path, and a host without the file, say a laptop with a
  YubiKey, falls through to `keys.txt`.
- `ageKeyFile` is a path, passed verbatim as `SOPS_AGE_KEY_FILE`, for an
  identity that lives somewhere else. Set one of the two, not both.

## Quick start

```sh
swamp extension pull @dataverket/sops
swamp vault create @dataverket/sops infra \
  --config '{"secretsDir":"vaults/infra","agePublicKey":"age1…"}'
echo -n "$TOKEN" | swamp vault put infra forgejo/api_token
swamp vault list-keys infra
swamp vault delete infra forgejo/api_token
```

An existing single-file vault splits into this layout with
`swamp vault migrate <vault> --to-type @dataverket/sops --config '…'`, which
copies every key and keeps the vault's name, so no `vault.get` reference
changes.

## Tests

`deno task test` runs the export and behavioural conformance suites from
`@swamp-club/swamp-testing`, unit tests of the key lookup against a fake file
system that refuses any path it was not told about, and integration tests
against real `sops` and `age-keygen` with a throwaway identity, both the
decrypting and the refused case; the integration tests are skipped when the
tools are absent.

## License

Apache License 2.0, see [LICENSE.md](./LICENSE.md); the original work is
`@zocc/sops-age`, and [NOTICE.md](./NOTICE.md) records the modifications.
