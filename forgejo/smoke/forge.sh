#!/usr/bin/env bash
# One throwaway Forgejo 15.0.11 (rootless image, SQLite) in podman on
# 127.0.0.1:13000, seeded with what the negative suite needs: an admin with an
# all-scopes token, a plain user with a narrow token, a second plain user, an
# organization, repositories with commits and branches, webhooks, and a branch
# the pull requests conflict on. Every token is a throwaway; they go to
# .work/tokens, mode 0600, and are never printed.
#   usage: forge.sh up | down
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=code.forgejo.org/forgejo/forgejo:15.0.11-rootless
NAME=forgejo-smoke
URL=http://127.0.0.1:13000
INI=/var/lib/gitea/custom/conf/app.ini
W=${WORK:-$PWD/.work}
T=$W/tokens

down() {
  podman rm -f "$NAME" >/dev/null 2>&1 || true
  rm -rf "$W"
}

start() {
  # No volume: the forge's data lives and dies with the container.
  podman run -d --name "$NAME" -p 127.0.0.1:13000:3000 \
    -e FORGEJO__security__INSTALL_LOCK=true \
    -e FORGEJO__server__ROOT_URL=$URL/ \
    -e FORGEJO__server__DISABLE_SSH=true \
    -e FORGEJO__server__START_SSH_SERVER=false \
    -e FORGEJO__database__DB_TYPE=sqlite3 \
    -e FORGEJO__service__DISABLE_REGISTRATION=true \
    -e FORGEJO__service__DEFAULT_ENABLE_DEPENDENCIES=true \
    -e FORGEJO__migrations__ALLOW_LOCALNETWORKS=true \
    -e FORGEJO__mirror__ENABLED=true \
    -e FORGEJO__mirror__MIN_INTERVAL=10m \
    -e FORGEJO__actions__ENABLED=true \
    -e FORGEJO__webhook__ALLOWED_HOST_LIST=loopback \
    -e FORGEJO__mailer__ENABLED=false \
    -e FORGEJO__log__LEVEL=Warn \
    "$IMAGE" >/dev/null
}

cli() { podman exec "$NAME" forgejo --config "$INI" "$@"; }

token() { # file user scopes
  local v
  v=$(cli admin user generate-access-token -u "$2" -t "smoke-$1" --scopes "$3" --raw)
  (umask 077; printf %s "$v" > "$T/$1")
}

api() { # method path [json]: as the admin, failing on any HTTP error
  local m=$1 p=$2; shift 2
  curl -sSf -o /dev/null -X "$m" -H "Authorization: token $(cat "$T/admin")" \
    -H 'Content-Type: application/json' "$URL/api/v1$p" ${1:+--data-binary "$1"}
}

b64() { printf %s "$1" | base64 -w0; }

file() { # repo path content message [branch-from new-branch]
  local body
  body=$(jq -nc --arg c "$(b64 "$3")" --arg m "$4" --arg from "${5:-}" --arg nb "${6:-}" \
    '{content: $c, message: $m} + (if $nb != "" then {branch: $from, new_branch: $nb} else {} end)')
  api POST "/repos/$1/contents/$2" "$body"
}

seed() {
  mkdir -p "$T"
  cli admin user create --admin --username fxadmin --password fx-admin-pass-1 \
    --email fxadmin@example.invalid --must-change-password=false >/dev/null
  cli admin user create --username fxplain --password fx-plain-pass-1 \
    --email fxplain@example.invalid --must-change-password=false >/dev/null
  cli admin user create --username fxother --password fx-other-pass-1 \
    --email fxother@example.invalid --must-change-password=false >/dev/null
  token admin fxadmin all
  token narrow fxplain read:repository
  # A token the forge never issued, of the same shape; the wrong-token model holds it.
  (umask 077; printf %s "$(openssl rand -hex 20)" > "$T/wrong")
  # The password of a push mirror, and an Actions secret's value: planted markers.
  (umask 077; printf 'FIXTURE-SECRET-actions-%s' "$(openssl rand -hex 8)" > "$T/actions")
  (umask 077; printf 'FIXTURE-SECRET-hookquery-%s' "$(openssl rand -hex 8)" > "$T/hookquery")

  api POST /orgs '{"username":"fxorg","visibility":"public"}'
  api POST /orgs '{"username":"fxempty","visibility":"public"}'
  # app: commits on main, branches for a clean pull request, one merged with
  # force, one that conflicts with main.
  api POST /orgs/fxorg/repos '{"name":"app","auto_init":true,"default_branch":"main","private":false}'
  file fxorg/app one.txt "one" "feat: one" main feat/one
  file fxorg/app two.txt "two" "feat: two" main feat/two
  file fxorg/app conflict.txt "from the branch" "feat: conflict" main feat/conflict
  file fxorg/app conflict.txt "from main" "chore: conflict on main"
  # tool: content, for settings, labels and topics
  api POST /orgs/fxorg/repos '{"name":"tool","auto_init":true,"default_branch":"main","private":false}'
  # tickets: the stagecraft tracker's repository, and one extra label
  api POST /orgs/fxorg/repos '{"name":"tickets","auto_init":true,"default_branch":"main","private":false}'
  api POST /repos/fxorg/tickets/labels '{"name":"keep-me","color":"#123456","description":"not the tracker'"'"'s"}'
  # empty: no commits; nopr: pull requests off
  api POST /orgs/fxorg/repos '{"name":"empty","private":false}'
  api POST /orgs/fxorg/repos '{"name":"nopr","auto_init":true,"default_branch":"main","private":false}'
  api PATCH /repos/fxorg/nopr '{"has_pull_requests":false}'
  # hooks: two webhooks on app (a CI one with a credential in its query, and
  # another), none on tool. Delivery is never attempted to anything but loopback.
  local q; q=$(cat "$T/hookquery")
  api POST /repos/fxorg/app/hooks "{\"type\":\"forgejo\",\"active\":true,\"events\":[\"push\"],\"config\":{\"url\":\"http://127.0.0.1:1/ci/hook?access_token=$q\",\"content_type\":\"json\"}}"
  api POST /repos/fxorg/app/hooks '{"type":"forgejo","active":true,"events":["push"],"config":{"url":"http://127.0.0.1:2/other/hook","content_type":"json"}}'
  # Actions runners that never connected, so offline: two of one name for
  # runner_prune, one of another it must keep, all of the org; and one of the
  # repository fxorg/tool with the org one's name, which the forge lists for
  # the repository beside the org's.
  local r
  for r in stale-runner stale-runner other-runner; do
    cli forgejo-cli actions register --secret "$(openssl rand -hex 20)" --name "$r" \
      --scope fxorg --labels smoke >/dev/null
  done
  cli forgejo-cli actions register --secret "$(openssl rand -hex 20)" --name other-runner \
    --scope fxorg/tool --labels smoke >/dev/null
}

case ${1:-} in
up)
  down
  start
  # Poll; a cold start takes a few seconds.
  for _ in $(seq 1 90); do
    curl -sf "$URL/api/v1/version" >/dev/null && break
    sleep 1
  done
  curl -sf "$URL/api/v1/version" >/dev/null || { echo "forge did not answer" >&2; exit 1; }
  seed
  echo "forge up at $URL; tokens in $T"
  ;;
down) down ;;
*) echo "usage: $0 up | down" >&2; exit 2 ;;
esac
