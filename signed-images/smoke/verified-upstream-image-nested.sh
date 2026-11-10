#!/usr/bin/env bash
# @dataverket/verified-upstream-image as a step of another workflow, the way
# the README shows it, and three runs of one reference started together.
# Read-only, as verified-upstream-image.sh. It creates workflows in $REPO,
# named smoke-nested-*, each with one step.
#
#   REPO=<scratch swamp repository> ./verified-upstream-image-nested.sh
source "$(dirname "$0")/harness.sh"
W=@dataverket/verified-upstream-image
REF=ghcr.io/renovatebot/renovate:44.226.2
IDENTITY=https://github.com/renovatebot/renovate/.github/workflows/build.yml@refs/heads/main
SOURCE=https://github.com/renovatebot/renovate
COMMIT=a42552e6c9739a9d577f86dd819e9d41aee7c059
WRONG=0000000000000000000000000000000000000000

echo "=== E. as a nested step ==="
# The README's step, the commit given per case.
readme_step() { # name commit
  nested "$1" "$W" <<YAML
ref: $REF
certificateIdentity: $IDENTITY
attestationType: slsaprovenance1
sourceRepository: $SOURCE
sourceCommit: "$2"
YAML
}
readme_step smoke-nested-upstream "$COMMIT"
(cd "$REPO" && swamp workflow validate smoke-nested-upstream --json) >"$OUT" 2>"$ERR"
[ "$(jq -r '.passed' "$OUT")" = "true" ] && ok "the outer workflow validates" || bad "the outer workflow validates" "$(tr -d '\n' < "$OUT" | tail -c 300)"

run smoke-nested-upstream
passes "the nested run passes with the right commit"

readme_step smoke-nested-wrong "$WRONG"
run smoke-nested-wrong
fails_at "and fails the outer step with the inner assertion's reason for another commit" upstream 'sourceCommit is'

echo "=== I. what the input schema does not catch in a nested step ==="
# swamp does not hold a nested step's inputs to the child's schema; the
# child's first assertion does.
nested smoke-nested-mistyped "$W" <<YAML
ref: $REF
certificateIdentity: $IDENTITY
attestationType: slsaprovenance1
sourcecommit: "$WRONG"
sourcerepository: https://github.com/example/another
YAML
run smoke-nested-mistyped
fails_at "mistyped source inputs are refused, where the run passed with no source asked for" upstream 'Not inputs of this workflow: sourcecommit, sourcerepository'

nested smoke-nested-no-type "$W" <<YAML
ref: $REF
certificateIdentity: $IDENTITY
YAML
run smoke-nested-no-type
fails_at "attestationType left out is refused in words" upstream 'attestationType must be given, as text'

nested smoke-nested-null-type "$W" <<YAML
ref: $REF
certificateIdentity: $IDENTITY
attestationType: null
YAML
run smoke-nested-null-type
fails_at "attestationType null is refused in words, before the signature is read" upstream 'attestationType must be given, as text'

nested smoke-nested-false-type "$W" <<YAML
ref: $REF
certificateIdentity: $IDENTITY
attestationType: false
YAML
run smoke-nested-false-type
fails_at "attestationType false likewise" upstream 'attestationType must be given, as text'

nested smoke-nested-no-ref "$W" <<YAML
certificateIdentity: $IDENTITY
attestationType: ""
YAML
run smoke-nested-no-ref
fails_at "ref left out is refused in words" upstream 'ref must be given, as text'

nested smoke-nested-list-ref "$W" <<YAML
ref:
  - $REF
certificateIdentity: $IDENTITY
attestationType: ""
YAML
run smoke-nested-list-ref
fails_at "ref given as a list is refused in words" upstream 'ref must be given, as text'

nested smoke-nested-null-commit "$W" <<YAML
ref: $REF
certificateIdentity: $IDENTITY
attestationType: slsaprovenance1
sourceCommit: null
YAML
run smoke-nested-null-commit
fails_at "sourceCommit null is refused in words, before anything is read" upstream 'must each be text when given'

nested smoke-nested-false-repository "$W" <<YAML
ref: $REF
certificateIdentity: $IDENTITY
attestationType: slsaprovenance1
sourceRepository: false
YAML
run smoke-nested-false-repository
fails_at "sourceRepository false likewise" upstream 'must each be text when given'

nested smoke-nested-null-issuer "$W" <<YAML
ref: $REF
certificateIdentity: $IDENTITY
attestationType: ""
oidcIssuer: null
YAML
run smoke-nested-null-issuer
fails_at "oidcIssuer null likewise" upstream 'must each be text when given'

nested smoke-nested-release @dataverket/verify-release <<YAML
repository: registry.example.invalid/team/release
publicKey: cosign.pub
tag: v1
anotations:
  - env=prod
YAML
run smoke-nested-release
fails_at "verify-release refuses a mistyped annotations from a nested step too" upstream 'Not inputs of this workflow: anotations'

echo "=== F. three runs of one reference started together ==="
# All three write the same record names. A run whose record another run
# replaced must say so, in words, and a run must never pass by another's record.
for i in 1 2 3; do
  (cd "$REPO" && timeout 150 swamp workflow run $W --input "ref=$REF" --input "certificateIdentity=$IDENTITY" --input attestationType=slsaprovenance1 --input "sourceRepository=$SOURCE" --input "sourceCommit=$COMMIT" --json) >"$REPO/.out.$i.json" 2>"$REPO/.err.$i.txt" &
done
wait
succeeded=0; replaced=0; other=0
for i in 1 2 3; do
  if [ "$(jq -r '.status' "$REPO/.out.$i.json" 2>/dev/null)" = "succeeded" ]; then
    succeeded=$((succeeded+1))
  elif jq -r '.jobs[].steps[] | select(.status == "failed") | .error' "$REPO/.out.$i.json" 2>/dev/null | grep -q 'must not overlap; run again'; then
    replaced=$((replaced+1))
  else
    other=$((other+1))
  fi
done
[ "$other" -eq 0 ] && [ "$succeeded" -ge 1 ] && ok "each run passed or said its record was replaced ($succeeded passed, $replaced replaced)" \
  || bad "each run passed or said its record was replaced" "$succeeded passed, $replaced replaced, $other failed otherwise: $(cat "$REPO"/.out.[123].json | jq -r '.jobs[]?.steps[]? | select(.status == "failed") | .name + ": " + .error' | tr '\n' ' ' | head -c 600)"
if cat "$REPO"/.out.[123].json "$REPO"/.err.[123].txt | grep -q 'Invalid expression\|\${{\|index out of bounds'; then
  bad "no failure shows an expression or an index error" "$(cat "$REPO"/.out.[123].json | grep -o 'Invalid expression[^"]*\|\${{[^"]*' | head -3 | tr '\n' ' ' | head -c 400)"
else
  ok "no failure shows an expression or an index error"
fi
summary
