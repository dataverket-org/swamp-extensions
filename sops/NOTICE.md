# Notice

`@dataverket/sops` is a modified version of `@zocc/sops-age`
(https://github.com/CCAgentOrg/swamp-zocc-extensions, `vault/sops-age`),
licensed under the Apache License, Version 2.0, reproduced in `LICENSE.md`.

Modifications, 2026-09-20, Jan Ivar Beddari (dataverket):

- One SOPS-encrypted file per secret under a directory instead of one file for
  all. `put` encrypts a new file to the recipients and needs no identity; `get`
  decrypts one file; `list` walks the directory without decrypting; `delete`
  removes the file. Upstream decrypted the whole file to plaintext on every
  write, re-encrypted every value, and could not delete.
- `sops` is invoked with an argument vector, never through a shell; secret
  values reach it through a private temporary directory, never as an argument.
  `ageKeyFile` is optional and, when empty, leaves the caller's
  `SOPS_AGE_KEY_FILE` alone. Encryption runs from the temporary directory with
  an absolute target, so a `.sops.yaml` in the repository is never consulted;
  the configured recipients are the only ones.

Modifications, 2026-10-19, Jan Ivar Beddari (dataverket):

- `ageKeyName`: an identity named by file name, found in the directory where
  sops keeps `keys.txt`, used when it exists and the caller exports no
  `SOPS_AGE_KEY_FILE`. A vault config can name a process key without a path into
  anyone's home. The test task now grants `--allow-run`, so the integration
  tests run instead of being skipped.

Modifications, 2026-10-27, Jan Ivar Beddari (dataverket):

- Checked against sops 3.13.3, which applies a matching `.sops.yaml` rule's
  `encrypted_regex` even when `--age` is given: the test of the temporary
  working directory now uses a rule that matches and asserts the stored value is
  encrypted. The key-directory unit test no longer depends on the host OS, and
  the tool probe skips sops's online update check.
