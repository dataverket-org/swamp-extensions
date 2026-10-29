# Plan: signed releases as OCI artifacts

Status board for the work that follows `@dataverket/ko`, `@dataverket/cosign`
and `@dataverket/signed-images`. An agent working from this file ticks a box
only when the item is verified as the Definition of done says, and writes a
one-line note under the item when it finds something the plan did not foresee.

## Goal

A release is one OCI artifact per environment in the registry: rendered
manifests plus a `release.json` listing every image by digest. Every image is
built by ko from a mirrored, digest-pinned base image, signed by digest with
cosign, and verified before anything moves. The artifact is signed, promotion is
a retag, and nothing after the build is ever rebuilt. Every extension stays
generic for its own tool; compounds live in `signed-images` and depend on the
generic ones.

## Design decisions, settled

- The registry primitive is crane, as `@dataverket/crane`, lifted from
  fabrikk-infra's private `registry-mirror` model and fabrikk's
  `release-artifact` reading. Flux gets only `push_artifact`.
- Digests signed, attested, promoted or mirrored come from a record of the same
  run or from the artifact itself, never from an input. Inputs carry names:
  module, registry path, environment, vault and key.
- Base images are quarantined like actions in fabrikk-infra decision 023: a
  digest is mirrored only after it has been seen unchanged for N days.
- Upstream signatures are verified keyless before mirroring; the mirror is then
  signed with our key, so builds and clusters verify against our key only.
- A `vault.get` in a workflow step's `globalArgs` is resolved at run start, even
  on a guarded step and inside a ternary; vault-named inputs are therefore
  required, never optional. One workflow per key source if needed.
- YAML plain scalars cannot hold `:` or `?`; such descriptions and expressions
  go in `>-` block scalars.
- ko: a tarball holds one image; an OCI layout path must be lowercase; cosign 3
  stores signatures as referrers with the `sha256-<hex>` fallback tag.

## Definition of done, per item

- Unit tests with a fake tool, and one `*_E2E=1` live test against the real
  tool: a throwaway `registry:2` in podman on `127.0.0.1:5000`. Tools come from
  Homebrew: use the installed formula when `brew list --formula` has it,
  otherwise `brew install` it (`ko`, `crane`, `cosign`, `fluxcd/tap/flux`);
  build a tool with `go install` only when Homebrew has no formula for it. The
  README's "Written against" line names the version actually used.
- `deno fmt --check`, `deno lint`, `deno check` clean; workflows created with
  `swamp workflow create` and `swamp workflow validate` passing; every new
  workflow run once through swamp against a fixture.
- README, manifest description, skill (where the extension has one), LICENSE and
  `deno.json` in the house layout; AGPL-3.0-only; copyright line.
- Adversarial review written to `.review/` for the exact content hash;
  `swamp extension push manifest.yaml --dry-run` with no unresolved warning;
  `swamp extension quality` at the provisional B that is A on verification.
- Top-level `README.md` row added by the integrator, last.
- Nothing published, nothing pushed. Work is committed unsigned
  (`git commit --no-gpg-sign`) on the lane's `wip/` branch, one commit per
  finished item; the user signs the final result onto `main`.

## Working rules for agents

- Each lane works in its own git worktree on its own branch, created from `main`
  by the lane itself:
  `git worktree add .claude/worktrees/lane-a -b
  wip/lane-a` (and `lane-b`,
  `lane-c`, `phase-2`). Prerequisite: `main` must already hold `ko/`, `cosign/`,
  `signed-images/` and this file, so the user signs that commit before the goal
  starts. A lane commits on its branch with `--no-gpg-sign`, never pushes, never
  touches `main`.
- At the end an integrator creates `wip/signed-releases` from `main`, merges
  every lane branch into it, resolves the only expected conflicts (`PLAN.md`
  boxes and the top-level `README.md` rows), reruns every extension's tests,
  live tests and dry runs on the merged tree, commits unsigned, and reports the
  branch name. The lane worktrees are then removed; the branches stay.
- Every tool command runs through the `zmx` skill in a session named for the
  lane: `plan-lane-a`, `plan-lane-b`, `plan-lane-c`, and `plan-phase-2` for the
  later items, so a person can attach to any lane and see what it is doing. One
  session per lane, kept for the lane's whole life.
- No wait longer than 30 seconds: a poll loop sleeps at most 30 seconds per
  turn, a command gets at most 30 seconds before its output is inspected, and a
  command with no new output after two such checks is killed and the item marked
  blocked with the last output, never waited on further.
- Lanes own their directories and nothing else. The top-level `README.md`,
  `PLAN.md` outside the lane's own boxes and notes, and other lanes' files are
  read-only to a lane.
- An item blocked by something only the user can resolve (a credential, a tool
  that cannot be installed, a design question) is marked
  `- [ ] BLOCKED: <reason>` and the lane moves on to its next item.

## Phase 1, three lanes in parallel

Lanes touch disjoint directories. The top-level README is touched by no lane.

### Lane A: `@dataverket/crane` (new directory `crane/`)

- [x] Repo init (`swamp repo init --tool claude --no-vault`), deno.json,
      LICENSE.md from a sibling, manifest, README skeleton
- [x] Type `@dataverket/crane/registry`: global args `registry`, `namespace`,
      optional `username` and `password` (sensitive, vault expressions, logged
      in to a temporary docker config for one run), `insecure`, `craneBinary`
- [x] `digest` (read): tag to digest, records tag, digest, seen-at
- [x] `describe` (read): manifest and config, platforms, media type, created,
      labels, size; an index and an image both handled
- [x] `copy`: `source@digest` into `<registry>/<namespace>/<name>:<tag>`,
      unchanged when the digest is already there, digest checked after
- [x] `tag`: a digest given a tag, the digest the tag held before recorded
- [x] `blob`: one file out of an artifact layer as a record (Flux artifacts are
      a tar+gzip layer: `release.json`, `manifests.yaml`)
- [x] Checks: `arguments`, `crane-installed`, `registry-reachable` (live)
- [x] Unit tests with a fake crane; `CRANE_E2E=1` against the registry with an
      image pushed by ko
- [x] Workflow `@dataverket/mirror-image`: a list of upstream references, tags
      resolved to digests, copied under the namespace, asserted
- [x] Workflow `@dataverket/base-image-watch`: read-only, the digest of every
      watched upstream tag recorded; made to run daily
- [x] Skill `crane`; README; review; quality; dry run

### Lane B: cosign keyless mode and flux `push_artifact`

- [x] cosign: `certificateIdentity`, `certificateIdentityRegexp` and
      `oidcIssuer` on the signer; `verify`, `verifyAttestation` and `verifyBlob`
      pass them instead of `--key`; `tlog: false` with them is refused;
      `arguments` refuses a public key together with an identity; the `signer`
      record gains `verifyMode: key | keyless`
- [x] cosign: unit tests for the keyless argv and refusals; live test against a
      public keyless-signed image only if the network allows, else skipped and
      said so; README, skill, review re-keyed, dry run
      (the network allowed it: `cgr.dev/chainguard/static` verified keyless
      from this machine, signature and SPDX attestation, wrong identity seen
      to fail)
- [x] flux: read `flux/` first and follow its style; `push_artifact`: a
      directory, optional `metadata` object written as `release.json` into it,
      pushed as `oci://<repo>:<tag>` with `--reproducible`, `--source`,
      `--revision`, annotations; records ref and digest
- [x] flux: unit test with a fake flux; live test against the registry if the
      flux CLI is installed; README, review re-keyed, dry run
      (flux 2.10.0 from Homebrew; live against `registry:2` on
      `127.0.0.1:5002`, and once through swamp in a scratch repository)

### Lane C: ko additions and the first two compounds

- [x] ko `resolve`: every pinned image in the rendered manifests recorded in
      `resolution.images`, ko-built or not, each with `builtHere: bool`
- [x] ko `build`: the build record also written as a file, `buildRecord` (JSON),
      so `attest` can take it as a predicate
- [x] ko: tests, README, review re-keyed, dry run
- [x] `signed-images` workflow `@dataverket/ko-signed-manifests`: `resolve`,
      `cosign-sign` of the images, `attest` of the rendered manifests onto each
      image, asserted
- [x] `signed-images` workflow `@dataverket/verified-manifests`: every image in
      a rendered manifest file verified with cosign, read-only, asserted
- [x] `signed-images`: README, dry run

## Phase 2, after Lane A and Lane B

- [x] `signed-images` workflow `@dataverket/pinned-base-image`: upstream tag
      resolved, quarantine by `minimumAgeDays` against `base-image-watch`
      records, keyless verification of the upstream, copy, sign with our key,
      verify, `mirror` record with the pinned reference
- [x] `ko-signed-images`: `baseImage` readable from the latest
      `pinned-base-image` record, documented with the CEL line
- [x] `signed-images` workflow `@dataverket/signed-release`: rendered directory
      in, `release.json` from the resolution record, `push_artifact` tagged with
      the commit, artifact digest signed, `release.json` attested onto it,
      asserted (the attestation's predicate is the rendered manifests, see the
      Phase 2 notes: flux keeps no file for `release.json`)
- [x] `signed-images` workflow `@dataverket/verify-release`: artifact signature
      verified, `release.json` read through `crane.blob`, every image in it
      verified, asserted; read-only
- [x] `signed-images` workflow `@dataverket/promote-release`: `verify-release`
      then `crane.tag` of the channel tag, old digest recorded
- [x] `signed-images` workflow `@dataverket/mirror-release-images`: every image
      a release lists copied to another registry with its signatures (through
      cosign's `sha256-<hex>` fallback tag, copied with crane; see the Phase 2
      notes on `cosign copy`)
- [ ] `signed-images`: README, skill `signed-images` (which workflow for what),
      dry run; top-level README rows for crane and the new workflows

## Phase 3, outside this repository, for the user

- [ ] fabrikk-infra replaces `registry-mirror` with `@dataverket/crane`
- [ ] fabrikk's `release-artifact` reads through `@dataverket/crane` and
      `@dataverket/cosign`; `make release` becomes `signed-release`
- [ ] Publish, in dependency order: crane, cosign, flux, ko, signed-images

## Notes from the work

(agents append here: what surprised, what was decided on the spot)

- Lane C: `swamp extension source add .` inside a worktree resolves `.` against
  the main checkout's git toplevel, so every extension in every worktree is
  loaded and the alphabetically first copy of a type wins (lane-a's old `ko/`
  over lane-c's). Add sources by absolute path; `.swamp-sources.yaml` is
  gitignored, so nothing leaks.
- Lane C: ko's `--image-refs` file is never opened when a resolve publishes
  nothing (manifests already rendered), so `resolve` reads a missing file as
  empty. `resolution.imageCount` now counts every pinned image, so
  `ko-manifests` asserts on the new `builtCount` instead.
- Lane C: `verified-manifests` lists images through `ko resolve` with
  `push: false`, so `dir` must be a Go module even for a rendered file, and a
  `ko://` reference still in the file is rebuilt here; it gained a `repo` input
  so that rebuild is named where the signed image lives (with no repo ko names
  it bare, `hello@sha256:...`, and cosign cannot even fetch it). The rebuilt
  digest matched the pushed one in the live run: ko's builds are reproducible
  when the base image and tree are unchanged. A generic "images in a file"
  method would remove the Go-module requirement.
- Lane C: cosign's `--type custom` embeds a non-JSON predicate (the rendered
  YAML) verbatim as the `Data` string of a `cosign.sigstore.dev/attestation/v1`
  predicate, so the manifests file attests as it is. A workflow-only extension
  needs no `.review/` report: the signed-images dry run has no warning.

- Lane B: `verifyMode` has three values, `key`, `keyless` and `none`, not two:
  a signer with neither key nor identity exists (it can `describe`) and the
  record should say so rather than claim a key.
- Lane B: an identity wins over a key in `verifyMode`, and `key` beside an
  identity is accepted, so one signer can sign with its key and verify another
  party keyless; but `tlog` is one choice for both sides, so the Phase 2 mirror
  flow (keyless upstream verify, our key without a log) needs two signers.
- Lane B: cosign stays at 2026.10.28.1, unpublished (`currentPublished` is
  null), so no version bump and no `upgrades` entry; the three new arguments
  default to empty and an existing signer definition parses unchanged.
- Lane B: cosign's keyless wrong-identity verdict is exit 12 with `no matching
  signatures: none of the expected identities matched ...`; the latter phrase
  was added to the not-verified pattern so `verify-blob`, which lacks the
  prefix, is a record too.
- Lane B: `push_artifact` lives in its own file, `flux/push_artifact.ts`, as
  `export const extension` on `@dataverket/flux/source`, not in `source.ts`:
  that file is upstream's and `reset.ts` is the precedent for this package's
  own methods. It is listed in the manifest after `reset.ts`.
- Lane B: checks never run before a method named `list`, so the source type's
  kubectl check was dormant and would have started running before
  `push_artifact`, which needs no kubectl; it is now `appliesTo: ["list"]`,
  which keeps it for `swamp model validate` only, and the flux check on the
  extension is `appliesTo: ["push_artifact"]`, which the extension-check
  merge honours (seen in `swamp model validate --method push_artifact`).
- Lane B: `flux push artifact --output json` prints `url`, `repository`, `tag`
  and `digest`; the record keeps `url` as printed and `ref` as
  `<repository>@<digest>`, the form cosign signs. The digest depends on
  `--source` and `--revision` too, not only on the content.
- Lane B: `flux pull artifact --output <dir>` needs the directory to exist.
- Lane B: the flux dry run on `main` already had five unresolved warnings
  besides the stale review: two unaccepted `Deno.Command` spawns and three
  `uncatalogued-model` findings, because the types wrote `version:
  FORK_VERSION` instead of a string literal. Fixed in this lane: acceptance
  comments on the two spawns, literal `"2026.10.05.1"` in each model with the
  constant still ending the upgrade chain and a test pinning them equal. The
  model type versions were not bumped (no schema change), so no new
  `upgrades` entry; the manifest is 2026.10.29.1. Push now prints an
  informational `versionBumpUpgrade` notice per type, "no upgrades array",
  because its static check only sees a literal array and ours is
  `upgrades: forkUpgrades` from `_helpers.ts`; the chain exists at runtime and
  a test asserts it ends at the version. Not an unresolved warning; left as
  is rather than copying the array into three files.
- Lane B: a scratch repository created with `--no-vault` cannot run a cosign
  signer's `verify`, since the type's `keypair` spec has a sensitive field;
  `swamp vault create local_encryption <name> --config '{"auto_generate":
  true}'` unblocks it. `swamp model validate` without `--method` runs every
  check, so a verify-only signer always fails `key-usable` there; with
  `--method verify` it does not.

- Lane A: `zmx run <session> podman run -d ...` hands `-d` to zmx, not podman:
  the registry ran attached in the session until interrupted. Flags that zmx
  also knows go through stdin (`printf '...' | zmx run <session>`).
- Lane A: `digest` reads its own last record per tag through `readResource`
  and carries `firstSeenAt` forward while the digest is unchanged, so the
  Phase 2 quarantine compares one field against `run.startedAt`:
  `timestamp(run.startedAt) - timestamp(...firstSeenAt) >= duration("168h")`.
  CEL `now()` evaluates in `swamp data query` but compared as if it were the
  epoch, so the docs use `run.startedAt`, which the workflow reference lists.
- Lane A: `copy` takes sources as `<repository>:<tag>@sha256:<digest>`; the
  `digest` record's `pinned` field is exactly that, so the workflow maps
  records to sources with one CEL expression and no map literal.
- Lane A: the secret-docs analyzer flags any `--input <name>=<value>` whose
  name holds password, token, secret or credential, placeholders included;
  `passphrase` (cosign) passes. `passwordKey=password` in the README is
  accepted in `crane/quality.yaml`, which is part of the content hash.
- Lane A: `swamp extension quality` warns "Skipping broken extension
  workflow" for every file under `crane/.swamp/workflows-evaluated/`, since
  the extension source is the repo directory itself; harmless, the score is
  unaffected.
- Lane A: `crane config` on an index silently picks linux/amd64; `describe`
  reads the first platform child's config instead, and `configDigest` is that
  child's config blob (a first version recorded the child manifest digest,
  caught in the live run).
- Lane A: `flux push artifact` into the registry worked and `blob` read its
  `release.json` through swamp; the e2e test builds an equivalent artifact
  with `crane append --oci-empty-base` so it needs crane only.
  true}'`
  unblocks it. `swamp model validate` without `--method` runs every check, so a
  verify-only signer always fails `key-usable` there; with `--method verify` it
  does not.

- Phase 2: flux's `push_artifact` writes `release.json` into a scratch copy
  that is removed after the push and records only `releaseJson: true`, no
  path; and a workflow has no task that writes a file (`model_method`,
  `behavior`, `workflow`, `manual_approval`, `assert`, `wait_for_signal`). So
  `signed-release` attests the rendered `manifests` file this run's
  `ko resolve` wrote, as a `custom` predicate; `release.json` is bound by the
  signature, since the artifact digest covers it. Defect to fix in flux when
  it is next touched: keep `release.json` as a file record through
  `createFileWriter`, so its path can be a predicate.
- Phase 2: the flux artifact instance is named `<repository>--<tag>`, so a
  workflow reads it with `data.findBySpec(model, "artifact")` filtered by
  `workflowRunId == run.id`, never `data.latest`.
- Phase 2: a revision in flux's `<branch>@sha1:<commit>` form is not an OCI
  tag; `signed-release` takes `revision` as the tag unless `tag` is given, and
  flux's `parseTarget` refuses the bad tag by name before flux runs.
- Phase 2: `ko-manifests` records its rendered output as a file, not a
  directory, and `swamp data query --select path` returns `""` for it;
  `--select content` gives the text. The release directory is assembled by the
  caller. A directory output on `resolve` would spare that copy.
- Phase 2: the pinned-and-nothing-built check runs right after `resolve`, so
  a directory with a `ko://` reference or an unpinned image never reaches the
  registry; seen on the fixture's own deployment.
- Phase 2: `swamp behavior type search` without `--json` opens an interactive
  picker on a PTY; in a zmx session it hangs and must be killed by pid.
  `release.json` through swamp; the e2e test builds an equivalent artifact with
  `crane append --oci-empty-base` so it needs crane only.

- Phase 2: an auto-definition stores the evaluated global arguments, not the
  expression text, and is rewritten by every step that names it, so
  `pinned-base-image`'s `digest` step records on the `base-image-watch` model
  (`insecure: false`, the watch reads public images) and one `firstSeenAt`
  serves the daily watch and the quarantine; in the live run the watch's
  `firstSeenAt` carried into the mirror run, and the watch ran unchanged after.
- Phase 2: crane's `copy` names the target repository after the source's last
  path segment, with no override, so `pinned-base-image` takes no `name` input;
  the mirror record is `mirror-<registry>-<namespace>-<name>-<tag>` with `/` and
  `:` as `-`, `mirror-127.0.0.1-5005-mirror-static-latest` in the live run.
- Phase 2: a CEL ternary over `data.findBySpec(inputs.baseImageFrom, "mirror")`
  in a ko step's `globalArgs` validates with no warning and runs; with
  `baseImageFrom` empty the data branch is not evaluated (a run without it built
  on `.ko.yaml` as before), so no guarded second pair of ko steps was needed.
  Records from `findBySpec` carry `name`, which picks `baseImageRecord`.
- Phase 2: `duration(string(inputs.minimumAgeDays * 24) + "h")` evaluates, so
  the quarantine takes days as an integer input instead of a fixed `168h`; a
  timestamp plus a duration interpolates in the assertion message as RFC 3339.
- Phase 2: `swamp vault list` without `--json` opens an interactive picker in a
  zmx session and hangs until Escape; every listing command takes `--json`.
- Phase 2: `swamp workflow create` now writes `workflows/workflow-<name>.yaml`;
  the three earlier signed-images workflows are UUID-named, both are listed in
  the manifest. `@dataverket/crane` was added to the manifest's dependencies,
  since `pinned-base-image` needs its type; the description still says three
  workflows, for the integrator to reword with the other Phase 2 workflows.
- Phase 2: a workflow file in `signed-images/` validates fully only from a repo
  that has the extension sources added (`@dataverket/crane/registry` could not
  be resolved from `signed-images/` itself); the scratch repo passed both with
  zero warnings.
- Phase 2: a nested workflow's records carry the child's `workflowRunId` and no
  tag of the parent's, so a parent cannot filter them by `run.id`; but the step
  that ran the child holds every child step's output under the child step's
  name, `steps.release.outputs.digest.digest` and
  `steps.release.outputs.release.json.images`, and that is what
  `promote-release` and `mirror-release-images` read, a record of this run.
- Phase 2: `crane copy` of `<repository>@<digest>` carries nothing that refers
  to the image, and `cosign copy` 3.1.4 against `registry:2` copied the image
  itself to the `sha256-<hex>` tag in place of the bundle index, so the target
  did not verify (its help names `oras copy -r` for referrers). The fallback tag
  at the source is an OCI index of the Sigstore bundles, and a plain
  `crane copy` of `<repository>:sha256-<hex>` carries the index with every
  bundle, verified at the target; `mirror-release-images` resolves and copies it
  with crane's own `digest` and `copy`, behind `signatureTags`.
- Phase 2: `swamp workflow validate --json` prints `valid: null`; the plain
  output's `Result: PASSED` is the signal. A `guard` that is true skips the step
  `(guarded)` and its dependants `(dependency)`, which is what a boolean input
  that turns two steps off needs. `deno fmt` reformats a `- >-` list item of a
  block scalar with extra indentation; swamp parses it unchanged.
- Phase 2: cosign's `verify` at a target counts every bundle under the fallback
  tag, so an image signed by two builds reports `4 signatures verified`; a
  release's images are verified without annotations for that reason, several
  builds may have signed them, while the artifact's signature must carry the
  release's.
- Phase 2: the secret-docs analyzer flags `--input passwordKey=password` in the
  two new README examples, as it did for crane; `signed-images/quality.yaml`
  accepts them by README line (274, 310, the `swamp workflow run` line of each
  example). A README edit above them moves the lines: the integrator's dry run
  on the merged tree says which, and the file is updated then.
