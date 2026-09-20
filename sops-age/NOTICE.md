# Notice

`@dataverket/sops-age` is a modified version of `@zocc/sops-age`
(https://github.com/CCAgentOrg/swamp-zocc-extensions, `vault/sops-age`),
licensed under the Apache License, Version 2.0, reproduced in `LICENSE.md`.

Modifications, 2026-09-20, Jan Ivar Beddari (dataverket):

- The single-file provider now changes one value with `sops set`, reads one with
  `sops decrypt --extract`, lists keys from the file without decrypting, and
  deletes with `sops unset`. Upstream decrypted the whole file to plaintext on
  every write and re-encrypted every value.
- `sops` is invoked with an argument vector, never through a shell; secret
  values reach it on stdin or through a private temporary directory, never as an
  argument. `ageKeyFile` is optional and, when empty, leaves the caller's
  `SOPS_AGE_KEY_FILE` alone.
