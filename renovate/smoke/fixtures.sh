#!/usr/bin/env bash
# The repository directories the suite looks up, made under $REPO/fix, and
# three small images that stand in for a Renovate that hangs, prints
# something else, or exits non-zero. Nothing here is ever pushed.
set -euo pipefail
: "${REPO:?set REPO to a swamp repository that loads this extension from source}"
RUNTIME=${RUNTIME:-podman}
IMAGE=${RENOVATE_IMAGE:?set RENOVATE_IMAGE to the Renovate image to test with, tag included}
FIX=$REPO/fix
rm -rf "$FIX"; mkdir -p "$FIX"

commit() { # dir
  git -C "$1" init -q -b main
  git -C "$1" add -A
  git -C "$1" -c user.name=smoke -c user.email=smoke@example.invalid \
    -c commit.gpgsign=false commit -q -m fixture
}
config() { printf '{ "extends": ["config:recommended"]%s }\n' "${2:-}" > "$1/renovate.json"; }

# Old pins of four kinds: a Dockerfile, a Kubernetes manifest, an npm package
# and a GitHub Action. redis 6 has had two major releases since.
d=$FIX/mixed; mkdir -p "$d/.github/workflows" "$d/kube"
config "$d" ', "kubernetes": { "managerFilePatterns": ["/^kube/.+\\.yaml$/"] }'
printf 'FROM alpine:3.18.0\nFROM redis:6.0.0\n' > "$d/Dockerfile"
printf 'on: push\njobs:\n  build:\n    runs-on: ubuntu-latest\n    steps:\n      - uses: actions/checkout@v3.0.0\n' > "$d/.github/workflows/ci.yml"
printf 'apiVersion: apps/v1\nkind: Deployment\nmetadata: { name: web }\nspec:\n  selector: { matchLabels: { app: web } }\n  template:\n    metadata: { labels: { app: web } }\n    spec:\n      containers:\n        - name: web\n          image: nginx:1.25.0\n' > "$d/kube/deploy.yaml"
printf '{ "name": "fixture", "version": "1.0.0", "private": true, "dependencies": { "lodash": "4.17.20" } }\n' > "$d/package.json"
commit "$d"

# Up to date for good: left-pad 1.3.0 is the last release of a retired package.
d=$FIX/uptodate; mkdir -p "$d"; config "$d"
printf '{ "name": "fixture2", "version": "1.0.0", "private": true, "dependencies": { "left-pad": "1.3.0" } }\n' > "$d/package.json"
commit "$d"

# No Renovate configuration, and one only where local mode does not read it.
d=$FIX/noconfig; mkdir -p "$d"; printf 'FROM alpine:3.18.0\n' > "$d/Dockerfile"; commit "$d"
d=$FIX/forgejo-only; mkdir -p "$d/.forgejo"; printf '{}\n' > "$d/.forgejo/renovate.json"; printf 'FROM alpine:3.18.0\n' > "$d/Dockerfile"; commit "$d"

# A configuration Renovate refuses, with a planted value in it.
d=$FIX/badconfig; mkdir -p "$d"
printf '{ "extends": ["config:recommended"], "noSuchOption": "token=%s" }\n' hunter2-planted-secret > "$d/renovate.json"
printf 'FROM alpine:3.18.0\n' > "$d/Dockerfile"; commit "$d"

# One image no registry can serve beside one that exists.
d=$FIX/unresolved; mkdir -p "$d"; config "$d"
printf 'FROM registry.invalid/none/such:1.0.0\nFROM alpine:3.18.0\n' > "$d/Dockerfile"; commit "$d"

# A Git repository with a change that is not committed and a file Git does
# not track, and the same files in a directory that is no Git repository.
d=$FIX/dirty; mkdir -p "$d"; config "$d"; printf 'FROM alpine:3.18.0\n' > "$d/Dockerfile"; commit "$d"
printf 'FROM alpine:3.17.0\n' > "$d/Dockerfile"; printf 'FROM redis:6.0.0\n' > "$d/Dockerfile.untracked"
d=$FIX/plain; mkdir -p "$d"; config "$d"; printf 'FROM alpine:3.17.0\n' > "$d/Dockerfile"; printf 'FROM redis:6.0.0\n' > "$d/Dockerfile.untracked"

# A directory only its owner can enter, and names a shell would trip over.
d=$FIX/private; mkdir -p "$d"; config "$d"; printf 'FROM alpine:3.18.0\n' > "$d/Dockerfile"; commit "$d"; chmod 700 "$d"
d="$FIX/with space:colon"; mkdir -p "$d"; config "$d"; printf 'FROM alpine:3.18.0\n' > "$d/Dockerfile"; commit "$d"
d="$FIX/a,b"; mkdir -p "$d"; config "$d"
d="$FIX/a\"b"; mkdir -p "$d"; config "$d"
printf 'not a directory\n' > "$FIX/file"

# Nothing to look up, three ways, the first two beside an old pin: another
# manager only, every package disabled, and no package file at all.
d=$FIX/only-npm; mkdir -p "$d"; config "$d" ', "enabledManagers": ["npm"]'; printf 'FROM alpine:3.18.0\n' > "$d/Dockerfile"
d=$FIX/all-disabled; mkdir -p "$d"; config "$d" ', "packageRules": [{ "matchPackageNames": ["*"], "enabled": false }]'; printf 'FROM alpine:3.18.0\n' > "$d/Dockerfile"
d=$FIX/no-package-file; mkdir -p "$d"; config "$d"

# Other forms of configuration: a renovate key in package.json, one that
# switches Renovate off, a JSON5 file under .github, and a .renovaterc.
d=$FIX/pkg-config; mkdir -p "$d"
printf '{ "name": "fixture4", "version": "1.0.0", "private": true, "dependencies": { "lodash": "4.17.20" }, "renovate": { "extends": ["config:recommended"] } }\n' > "$d/package.json"; commit "$d"
d=$FIX/pkg-disabled; mkdir -p "$d"
printf '{ "name": "fixture5", "version": "1.0.0", "private": true, "dependencies": { "lodash": "4.17.20" }, "renovate": { "enabled": false } }\n' > "$d/package.json"; commit "$d"
d=$FIX/github-json5; mkdir -p "$d/.github"
printf '// a comment, as JSON5 allows\n{ extends: ["config:recommended"] }\n' > "$d/.github/renovate.json5"; printf 'FROM alpine:3.18.0\n' > "$d/Dockerfile"; commit "$d"
d=$FIX/renovaterc; mkdir -p "$d"; printf '{ "extends": ["config:recommended"] }\n' > "$d/.renovaterc"; printf 'FROM alpine:3.18.0\n' > "$d/Dockerfile"; commit "$d"

# A Git repository whose configuration Git does not track. The file says
# that Renovate is off; Renovate does not read it.
d=$FIX/untracked-config; mkdir -p "$d"; printf 'FROM alpine:3.18.0\n' > "$d/Dockerfile"; commit "$d"
printf '{ "enabled": false }\n' > "$d/renovate.json"

# Names with two dots, a directory to climb out of, a second name for one
# directory, and things that are not files where a configuration would be.
d=$FIX/my..repo; mkdir -p "$d" "$FIX/deep/er"; config "$d"
printf '{ "name": "fixture3", "version": "1.0.0", "private": true, "dependencies": { "left-pad": "1.3.0" } }\n' > "$d/package.json"
ln -s uptodate "$FIX/link-to-uptodate"
d=$FIX/devzero; mkdir -p "$d"; ln -s /dev/zero "$d/package.json"; ln -s /dev/zero "$d/renovate.json"
d=$FIX/fifo; mkdir -p "$d"; mkfifo "$d/renovate.json" "$d/package.json"

# Stand-ins built on the Renovate image, so nothing else is pulled.
build() { # name entrypoint-json
  printf 'FROM %s\nENTRYPOINT %s\n' "$IMAGE" "$2" |
    "$RUNTIME" build --pull=never -q -t "localhost/renovate-smoke-$1:1" -f - "$REPO/.empty" >/dev/null
}
mkdir -p "$REPO/.empty"
build hang '["sh","-c","sleep 300"]'
build garbage '["echo","<html>502 Bad Gateway</html>"]'
build exit3 '["sh","-c","echo boom token=hunter2-planted-secret >&2; exit 3"]'
echo "fixtures made in $FIX"
