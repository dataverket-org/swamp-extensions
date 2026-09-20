# Notice

`@dataverket/sops` is a modified version of `@zocc/sops-age`
(https://github.com/CCAgentOrg/swamp-zocc-extensions, `vault/sops-age`),
licensed under the Apache License, Version 2.0, reproduced in `LICENSE.md`.

Modifications, 2026-09-20, Jan Ivar Beddari (dataverket):

- One SOPS-encrypted file per secret under a directory instead of one file
  for all. `put` encrypts a new file to the recipients and needs no identity;
  `get` decrypts one file; `list` walks the directory without decrypting;
  `delete` removes the file. Upstream decrypted the whole file to plaintext
  on every write, re-encrypted every value, and could not delete.
- `sops` is invoked with an argument vector, never through a shell; secret
  values reach it through a private temporary directory, never as an
  argument. `ageKeyFile` is optional and, when empty, leaves the caller's
  `SOPS_AGE_KEY_FILE` alone.
