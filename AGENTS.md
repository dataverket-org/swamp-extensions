# Working in this repository

swamp extensions published under `@dataverket`. One directory per extension,
each with its own manifest, README, license, tests and review, each published
alone. `lib/` is the only shared code. The root `README.md` says what each
extension covers and how the shared code and the test environment work; read it
first. Load the `swamp` skill before any swamp work, and follow its extension
and extension-publish guides.

## Rules

1. **One directory, one extension.** Touch only the extension you were asked to
   work on. Nothing imports from another extension's directory.
2. **A process is started in `lib/cli.ts` and nowhere else.** An extension that
   runs a command imports `../lib/cli.ts`, and `../lib/kubectl.ts` for kubectl.
   No second spawn helper, no private name check, no private redaction. When
   `lib/` lacks something, change `lib/`, with a unit test, and say which
   extensions' content hashes that moves.
3. **Search before you build.** `swamp extension search` and
   `swamp behavior type search` first. A community extension that covers the
   domain but lacks methods is forked here, with its license notice kept, not
   wrapped.
4. **Name it after what it drives.** `@dataverket/talosctl`, not
   `@dataverket/talos`.
5. **A published extension is for anyone.** No hostname, policy word or habit of
   ours in a schema, a description or a README. Offer each credential form on
   its merits and say how to choose.
6. **A credential never reaches an argument, a record, a log line or an error.**
   Pass a value that could appear to `secrets`. The live suite plants a marker
   and looks for it afterwards.
7. **No command that waits longer than 180 s** in a test or a session. Poll. A
   method gives each long call a time limit that fits it; the 60 s default must
   never cut real work.

## Conventions

- Cluster arguments are `namespace`, `kubeconfig`, `context`, as
  `@swamp/kubernetes` names them. An empty `namespace` argument means the
  definition's namespace.
- Data names: `<namespace>--<name>`, a cluster-scoped object `<name>`, the
  record of a whole list `inventory_all` or `inventory_ns_<namespace>`. Names
  are predictable from the object, so a workflow can build them.
- A read never throws for an object that is unhealthy: it records the state and
  a reason. Only a call that could not be made throws.
- A method that changes something reads first, refuses what it cannot verify,
  and reads again after. Its kind is `action`. Kind `delete` marks every record
  of the model deleted, so it is only for a model's one resource, removed.
- A pre-flight check names the methods it applies to (`appliesTo`): the ones
  that run that binary. swamp runs no check before a read, so a `list` or a
  `get` must report a missing binary well by itself.
- Every time limit also covers what a kubeconfig starts to log in, so each
  README says that an interactive login must finish within the limit.
- Version is CalVer, `YYYY.MM.DD.N`. A published type gets an `upgrades` entry
  with each new version. Every `npm:` and `jsr:` specifier is pinned exactly,
  the same version as `lib/` where both import it.
- Plain English for readers who are not native speakers. No em dashes.

## Tests

- Testing follows the swamp skill's extension guidance,
  `references/model/testing.md` and `references/model/smoke_testing.md`, and
  only that.
- Every model file has a sibling `_test.ts`, as swamp's publish gate asks, with
  a success and a failure path for each method. A method's test runs its
  `execute` through `createModelTestContext` from `@swamp-club/swamp-testing`
  with a stub client injected, or calls the extracted function with one, as
  `testing.md` shows. A stub answers what its test needs and nothing more: it is
  not a model of the service, and no shared fake service is kept.
- The live suite is the proof. Behaviour, refusals, negative cases and the
  planted secret are tested live, in
  the extension's `smoke/` suite, against throwaway environments in rootless
  Podman or kind, as `versitygw/smoke/` and `forgejo/smoke/` do. A fault that no
  real service produces on demand is injected at the client seam over the real
  service, never by a fake service.
- The live suite runs through swamp from a scratch repository that loads the
  extension from source. Scripts take a kubeconfig file as input and refuse a
  context that is not `kind-*`. `smoke/README.md` has an "Environment" section;
  claim nothing there that was not run.
- No command in a test or a smoke script waits longer than 180 s (rule 7).
- The tested environment is rootless Podman and kind (README "Testing
  environment").

## Clusters and credentials

- A default kube context may be a production admin. Every kubectl, flux, helm
  and swamp call names its kubeconfig or its context. Writes happen only on a
  kind cluster you created, with a kubeconfig file of its own.
- A read against a real estate is one attempt with a reader's context. A refusal
  or an expired login is noted, not retried.
- Delete the clusters and containers you made. Scratch files stay out of the
  repository.

## Before a release

In the extension's directory, with `--extensions-dir ..` when it imports `lib/`:

1. `deno fmt --check`, `deno lint`, `deno check`, `deno test` through the
   `deno.json` tasks (deno is at `~/.swamp/deno/deno`), with the permissions the
   tests need, so none is silently ignored.
2. The live suite, on the final code.
3. `swamp extension quality`. The README needs 500 characters and two fenced
   code blocks; "verified public repository" stays provisional until published.
4. `SWAMP_EXTENSION_REVIEW_DIR=$PWD/.review swamp extension push manifest.yaml --dry-run --json`
   prints the path of the adversarial review, bound to the content hash. Do the
   review against the final sources, all 15 dimensions with a verdict, an honest
   `issue` where one is due, and write it at that path. Any edit after it, in
   the extension or in a `lib/` file it imports, moves the hash.
5. The dry run again: the review warning is gone.

Committing and publishing are the maintainer's: commits are signed with a
hardware key. `task push` publishes what is committed and not yet in the
registry.

## Several agents at once

One agent per directory. No `git add`, commit, stash, checkout or branch change
in a shared working tree. `lib/` and the root files (`README.md`, `TODO.md`,
`Taskfile.yml`, `bin/`, this file) belong to whoever coordinates; ask for a
change there with the exact patch.
