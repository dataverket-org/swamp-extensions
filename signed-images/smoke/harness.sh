#!/usr/bin/env bash
# Harness for the smoke suite of @dataverket/signed-images: a batch sources
# this, runs a workflow in $REPO, and counts what held of the run it printed.
set -u
: "${REPO:?set REPO to the scratch swamp repository}"
PASS=0; FAIL=0
OUT=$REPO/.out.json
ERR=$REPO/.err.txt

# workflow, then inputs as key=value. No run waits longer than 150 s.
run() {
  local name=$1; shift
  local args=()
  for kv in "$@"; do args+=(--input "$kv"); done
  (cd "$REPO" && timeout 150 swamp workflow run "$name" "${args[@]}" --json) >"$OUT" 2>"$ERR"
}

ok()  { PASS=$((PASS+1)); printf 'PASS  %s\n' "$1"; }
bad() { FAIL=$((FAIL+1)); printf 'FAIL  %s\n      %s\n' "$1" "$2"; }

# The steps of the last run as "job/step=status", one line.
steps() { jq -r '[.jobs[] | .name as $j | .steps[] | "\($j)/\(.name)=\(.status)"] | join(" ")' "$OUT" 2>/dev/null; }

# The last run must have succeeded, with the steps named skipped and every
# other step succeeded.
passes() { # name [skipped step...]
  local name=$1; shift
  local skipped; skipped=$(printf '%s\n' "$@" | jq -R . | jq -sc 'map(select(. != ""))')
  if [ "$(jq -r '.status' "$OUT" 2>/dev/null)" != "succeeded" ]; then
    bad "$name" "the run did not succeed: $(steps) $(tr -d '\n' < "$ERR" | tail -c 300)"
  elif [ "$(jq --argjson skipped "$skipped" '[.jobs[].steps[] | select(.status != (if (.name | IN($skipped[])) then "skipped" else "succeeded" end))] | length' "$OUT")" = "0" ]; then
    ok "$name"
  else
    bad "$name" "steps: $(steps)"
  fi
}

# The last run must have failed at that step and at no other, with a message
# that matches the pattern. SHOW=1 prints the message.
fails_at() { # name step pattern
  local name=$1 step=$2 pattern=$3
  local failed; failed=$(jq -r '[.jobs[].steps[] | select(.status == "failed") | .name] | join(",")' "$OUT" 2>/dev/null)
  if [ "$(jq -r '.status' "$OUT" 2>/dev/null)" != "failed" ]; then
    bad "$name" "the run did not fail: $(steps)"
  elif [ "$failed" != "$step" ]; then
    bad "$name" "failed at [$failed], not at $step: $(steps)"
  elif jq -r --arg s "$step" '.jobs[].steps[] | select(.name == $s) | .error' "$OUT" | tr '\n' ' ' | grep -qE "$pattern"; then
    ok "$name"
    [ -z "${SHOW:-}" ] || printf '      %s\n' "$(jq -r --arg s "$step" '.jobs[].steps[] | select(.name == $s) | .error' "$OUT" | tr '\n' ' ')"
  else
    bad "$name" "message did not match /$pattern/: $(jq -r --arg s "$step" '.jobs[].steps[] | select(.name == $s) | .error' "$OUT" | tr '\n' ' ' | head -c 500)"
  fi
}

# The last run must have been refused before it started: no step ran, and what
# swamp said matches the pattern. SHOW=1 prints it.
not_started() { # name pattern
  if [ "$(jq -r '.status' "$OUT" 2>/dev/null)" = "succeeded" ]; then
    bad "$1" "the run succeeded: $(steps)"
  elif jq -e '.jobs' "$OUT" >/dev/null 2>&1; then
    bad "$1" "the run started: $(steps)"
  elif cat "$OUT" "$ERR" | grep -qE "$2"; then
    ok "$1"
    [ -z "${SHOW:-}" ] || printf '      %s\n' "$(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  else
    bad "$1" "message did not match /$2/: $(cat "$OUT" "$ERR" | tr -d '\n' | tail -c 300)"
  fi
}

# The last run must have run none of the steps named: each is skipped.
never_ran() { # name step...
  local name=$1; shift
  local wanted; wanted=$(printf '%s\n' "$@" | jq -R . | jq -sc .)
  if [ "$(jq --argjson w "$wanted" '[.jobs[].steps[] | select((.name | IN($w[])) and .status != "skipped")] | length' "$OUT")" = "0" ]; then
    ok "$name"
  else
    bad "$name" "steps: $(steps)"
  fi
}

# One field of the record a step of the last run wrote.
output() { jq -r --arg s "$1" --arg f "$2" '.jobs[].steps[] | select(.name == $s) | .outputs[$f]' "$OUT"; }

# The names in a workflow's known-inputs assertion must be exactly its declared
# inputs, so the two cannot drift apart.
inputs_match() { # workflow
  local got; got=$(cd "$REPO" && swamp workflow get "$1" --json 2>/dev/null | jq -c '
    (.inputs.properties | keys | sort) as $declared
    | ([.jobs[].steps[] | select(.name == "known-inputs")] | first) as $step
    | ($step.task.expr | capture("k in (?<list>\\[[^\\]]*\\])").list | fromjson | sort) as $asserted
    | {first: (.jobs[0].steps[0].name), same: ($declared == $asserted), closed: (.inputs.additionalProperties == false), $declared, $asserted}')
  if [ "$(printf '%s' "$got" | jq -r '.same and .closed and .first == "known-inputs"')" = "true" ]; then
    ok "$1: the assertion's names are the declared inputs, it is the first step, and the schema is closed"
  else
    bad "$1: the assertion's names are the declared inputs, it is the first step, and the schema is closed" "$got"
  fi
}

# A workflow in $REPO with one step that runs another workflow; the step's
# inputs are read from stdin as YAML. swamp assigns the id.
nested() { # name child
  local name=$1 child=$2 file id
  if ! file=$(cd "$REPO" && swamp workflow get "$name" --json 2>/dev/null | jq -er '.path'); then
    file=$(cd "$REPO" && swamp workflow create "$name" --json | jq -r '.path')
  fi
  id=$(sed -n 's/^id: //p' "$file")
  { printf 'id: %s\nname: %s\nversion: 1\njobs:\n  - name: gate\n    steps:\n      - name: upstream\n        task:\n          type: workflow\n          workflowIdOrName: "%s"\n          inputs:\n' "$id" "$name" "$child"
    sed 's/^/            /'; } > "$file"
}

summary() { printf '\n%d passed, %d failed\n' "$PASS" "$FAIL"; [ "$FAIL" -eq 0 ]; }
