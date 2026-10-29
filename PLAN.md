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

- [ ] Repo init (`swamp repo init --tool claude --no-vault`), deno.json,
      LICENSE.md from a sibling, manifest, README skeleton
- [ ] Type `@dataverket/crane/registry`: global args `registry`, `namespace`,
      optional `username` and `password` (sensitive, vault expressions, logged
      in to a temporary docker config for one run), `insecure`, `craneBinary`
- [ ] `digest` (read): tag to digest, records tag, digest, seen-at
- [ ] `describe` (read): manifest and config, platforms, media type, created,
      labels, size; an index and an image both handled
- [ ] `copy`: `source@digest` into `<registry>/<namespace>/<name>:<tag>`,
      unchanged when the digest is already there, digest checked after
- [ ] `tag`: a digest given a tag, the digest the tag held before recorded
- [ ] `blob`: one file out of an artifact layer as a record (Flux artifacts are
      a tar+gzip layer: `release.json`, `manifests.yaml`)
- [ ] Checks: `arguments`, `crane-installed`, `registry-reachable` (live)
- [ ] Unit tests with a fake crane; `CRANE_E2E=1` against the registry with an
      image pushed by ko
- [ ] Workflow `@dataverket/mirror-image`: a list of upstream references, tags
      resolved to digests, copied under the namespace, asserted
- [ ] Workflow `@dataverket/base-image-watch`: read-only, the digest of every
      watched upstream tag recorded; made to run daily
- [ ] Skill `crane`; README; review; quality; dry run

### Lane B: cosign keyless mode and flux `push_artifact`

- [ ] cosign: `certificateIdentity`, `certificateIdentityRegexp` and
      `oidcIssuer` on the signer; `verify`, `verifyAttestation` and `verifyBlob`
      pass them instead of `--key`; `tlog: false` with them is refused;
      `arguments` refuses a public key together with an identity; the `signer`
      record gains `verifyMode: key | keyless`
- [ ] cosign: unit tests for the keyless argv and refusals; live test against a
      public keyless-signed image only if the network allows, else skipped and
      said so; README, skill, review re-keyed, dry run
- [ ] flux: read `flux/` first and follow its style; `push_artifact`: a
      directory, optional `metadata` object written as `release.json` into it,
      pushed as `oci://<repo>:<tag>` with `--reproducible`, `--source`,
      `--revision`, annotations; records ref and digest
- [ ] flux: unit test with a fake flux; live test against the registry if the
      flux CLI is installed; README, review re-keyed, dry run

### Lane C: ko additions and the first two compounds

- [x] ko `resolve`: every pinned image in the rendered manifests recorded in
      `resolution.images`, ko-built or not, each with `builtHere: bool`
- [x] ko `build`: the build record also written as a file, `buildRecord` (JSON),
      so `attest` can take it as a predicate
- [x] ko: tests, README, review re-keyed, dry run
- [ ] `signed-images` workflow `@dataverket/ko-signed-manifests`: `resolve`,
      `cosign-sign` of the images, `attest` of the rendered manifests onto each
      image, asserted
- [ ] `signed-images` workflow `@dataverket/verified-manifests`: every image in
      a rendered manifest file verified with cosign, read-only, asserted
- [ ] `signed-images`: README, dry run

## Phase 2, after Lane A and Lane B

- [ ] `signed-images` workflow `@dataverket/pinned-base-image`: upstream tag
      resolved, quarantine by `minimumAgeDays` against `base-image-watch`
      records, keyless verification of the upstream, copy, sign with our key,
      verify, `mirror` record with the pinned reference
- [ ] `ko-signed-images`: `baseImage` readable from the latest
      `pinned-base-image` record, documented with the CEL line
- [ ] `signed-images` workflow `@dataverket/signed-release`: rendered directory
      in, `release.json` from the resolution record, `push_artifact` tagged with
      the commit, artifact digest signed, `release.json` attested onto it,
      asserted
- [ ] `signed-images` workflow `@dataverket/verify-release`: artifact signature
      verified, `release.json` read through `crane.blob`, every image in it
      verified, asserted; read-only
- [ ] `signed-images` workflow `@dataverket/promote-release`: `verify-release`
      then `crane.tag` of the channel tag, old digest recorded
- [ ] `signed-images` workflow `@dataverket/mirror-release-images`: every image
      a release lists copied to another registry with its signatures
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
