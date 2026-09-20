# @dataverket/sops-age

SOPS + age vaults for [swamp](https://github.com/swamp-club/swamp): secrets
encrypted at rest with [Mozilla SOPS](https://github.com/getsops/sops) and
[age](https://age-encryption.org), committed to git, no service in the path.

Forked from [`@zocc/sops-age`](https://github.com/CCAgentOrg/swamp-zocc-extensions)
(Apache-2.0); the changes are listed in [NOTICE.md](./NOTICE.md). Two vault
types share one `sops` runner:

| Type                         | Layout                                    | Who can write                       | Use it for                                                    |
| ---------------------------- | ----------------------------------------- | ----------------------------------- | ------------------------------------------------------------- |
| `@dataverket/sops-age`       | One JSON file, every secret a key in it   | A recipient (needs the data key)    | Credentials humans author and models read                     |
| `@dataverket/sops-age-files` | One JSON file per secret, in a directory | Anyone with the recipients' public keys | Values a model or workflow produces for readers it is not one of |

The variant is chosen per vault instance, once, with `swamp vault create`.
Nothing selects it at run time: a definition names a vault
(`${{ vault.get("infra", "…") }}`), and a sensitive field or spec names one
with `vaultName`. Because they are distinct types, `swamp vault migrate`
moves a vault from one to the other and keeps its name.

## `@dataverket/sops-age`, one file

The file is what `@zocc/sops-age` writes, so an existing vault switches by
editing `type` in `vaults/@zocc/sops-age/<id>.yaml`. What changes is how the
file is touched:

| Method   | sops                                          | Needs an identity |
| -------- | --------------------------------------------- | ----------------- |
| `put`    | `sops set --value-stdin`, one key; the first put encrypts a new file | yes (no, for the first) |
| `get`    | `sops decrypt --extract`, one key             | yes               |
| `list`   | reads the plaintext key names, no sops call   | no                |
| `delete` | `sops unset`, one key                         | yes               |

Every other value stays byte-identical on `put`, so `git diff` names the key
that changed. Upstream decrypted everything and re-encrypted every value on
each write.

```yaml
# vaults/@dataverket/sops-age/<id>.yaml
type: "@dataverket/sops-age"
config:
  secretsFile: vaults/infra.enc.json
  agePublicKey: age1yubikey1…,age1…        # every recipient, comma separated
  ageKeyFile: ""                           # empty: the caller's SOPS_AGE_KEY_FILE
```

## `@dataverket/sops-age-files`, one file per secret

`put` writes `<secretsDir>/<key>.enc.json`, `{"value": …}` encrypted to the
recipients, and needs nothing but their public keys. A key with `/` becomes
a directory path; `..`, absolute paths and empty segments are refused.

| Method   | What happens                                   | Needs an identity |
| -------- | ---------------------------------------------- | ----------------- |
| `put`    | `sops encrypt` into the key's file              | no                |
| `get`    | `sops decrypt --extract` of that file           | yes               |
| `list`   | walks the directory                             | no                |
| `delete` | removes the file                                | no                |

Changing recipients is `sops updatekeys` per file, by someone who can read
it; a value written for readers you are not among can only be replaced, not
re-keyed. That is the pattern's cost, not the tooling's.

```yaml
type: "@dataverket/sops-age-files"
config:
  secretsDir: vaults/produced
  agePublicKey: age1…                      # the cluster key, say
```

## Prerequisites

`sops` on `PATH` (or `sopsPath`), 3.9 or newer for `sops set --value-stdin`
and `sops unset`; `age` identities wherever sops finds them
(`SOPS_AGE_KEY_FILE`, the default key file, or an age plugin such as
`age-plugin-yubikey`). `ageKeyFile` overrides that only when set.

## Quick start

```sh
swamp extension pull @dataverket/sops-age
swamp vault create @dataverket/sops-age infra \
  --config '{"secretsFile":"vaults/infra.enc.json","agePublicKey":"age1…"}'
echo -n "$TOKEN" | swamp vault put infra forgejo/api_token
swamp vault list-keys infra
swamp vault delete infra forgejo/api_token

swamp vault create @dataverket/sops-age-files produced \
  --config '{"secretsDir":"vaults/produced","agePublicKey":"<cluster recipient>"}'
```

## Tests

`deno task test` runs the export and behavioural conformance suites from
`@swamp-club/swamp-testing` and integration tests against real `sops` and
`age-keygen`, generating a throwaway identity in a temporary directory; the
integration tests are skipped when the tools are absent.

## License

Apache License 2.0, see [LICENSE.md](./LICENSE.md); the original work is
`@zocc/sops-age`, and [NOTICE.md](./NOTICE.md) records the modifications.
