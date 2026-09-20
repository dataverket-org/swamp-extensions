# @dataverket/sops-age

SOPS + age vaults for [swamp](https://github.com/swamp-club/swamp): secrets
encrypted at rest with [Mozilla SOPS](https://github.com/getsops/sops) and
[age](https://age-encryption.org), committed to git, no service in the path.

Forked from [`@zocc/sops-age`](https://github.com/CCAgentOrg/swamp-zocc-extensions)
(Apache-2.0); the changes are listed in [NOTICE.md](./NOTICE.md). The file is
what upstream writes, so an existing vault switches by editing `type` in
`vaults/@zocc/sops-age/<id>.yaml`; no secret moves.

## How the file is touched


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
```

## Tests

`deno task test` runs the export and behavioural conformance suites from
`@swamp-club/swamp-testing` and integration tests against real `sops` and
`age-keygen`, generating a throwaway identity in a temporary directory; the
integration tests are skipped when the tools are absent.

## License

Apache License 2.0, see [LICENSE.md](./LICENSE.md); the original work is
`@zocc/sops-age`, and [NOTICE.md](./NOTICE.md) records the modifications.
