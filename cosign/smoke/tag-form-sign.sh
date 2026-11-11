#!/usr/bin/env bash
# Writes a key-based signature in cosign's older form, a `sha256-<hex>.sig`
# tag, for one image in a throwaway registry on this machine, over plain
# HTTP. cosign 3 no longer writes this form, so it is made by hand: a
# simple-signing payload signed with an EC key by openssl, pushed over the
# registry API with curl. For identify.sh; refuses any other host.
#
#   tag-form-sign.sh <127.0.0.1:port> <repository> <sha256:hex> <EC private key, PEM>
set -euo pipefail
reg=$1 repo=$2 digest=$3 key=$4
case $reg in
  127.0.0.1:*|localhost:*) ;;
  *) echo "refusing $reg: only a registry on 127.0.0.1 or localhost" >&2; exit 2 ;;
esac
tmp=$(mktemp -d); trap 'rm -rf "$tmp"' EXIT
printf '{"critical":{"identity":{"docker-reference":"%s/%s"},"image":{"docker-manifest-digest":"%s"},"type":"cosign container image signature"},"optional":null}' "$reg" "$repo" "$digest" > "$tmp/payload"
sig=$(openssl dgst -sha256 -sign "$key" "$tmp/payload" | base64 -w0)
pd=sha256:$(sha256sum "$tmp/payload" | cut -d' ' -f1); ps=$(stat -c %s "$tmp/payload")
printf '{"architecture":"","created":"0001-01-01T00:00:00Z","history":[{"created":"0001-01-01T00:00:00Z"}],"os":"","rootfs":{"type":"layers","diff_ids":["%s"]},"config":{}}' "$pd" > "$tmp/config"
cfg=sha256:$(sha256sum "$tmp/config" | cut -d' ' -f1); cs=$(stat -c %s "$tmp/config")
put() { # file digest
  loc=$(curl -fsS -X POST -D - -o /dev/null "http://$reg/v2/$repo/blobs/uploads/" | tr -d '\r' | awk 'tolower($1)=="location:"{print $2}')
  # A registry may give the upload's address without its host.
  case $loc in /*) loc="http://$reg$loc";; esac
  case $loc in *\?*) sep='&';; *) sep='?';; esac
  curl -fsS -X PUT -H 'Content-Type: application/octet-stream' --data-binary "@$1" "$loc${sep}digest=$2" -o /dev/null
}
put "$tmp/payload" "$pd"; put "$tmp/config" "$cfg"
printf '{"schemaVersion":2,"mediaType":"application/vnd.oci.image.manifest.v1+json","config":{"mediaType":"application/vnd.oci.image.config.v1+json","size":%s,"digest":"%s"},"layers":[{"mediaType":"application/vnd.dev.cosign.simplesigning.v1+json","size":%s,"digest":"%s","annotations":{"dev.cosignproject.cosign/signature":"%s"}}]}' "$cs" "$cfg" "$ps" "$pd" "$sig" > "$tmp/manifest"
curl -fsS -X PUT -H 'Content-Type: application/vnd.oci.image.manifest.v1+json' --data-binary "@$tmp/manifest" "http://$reg/v2/$repo/manifests/${digest/:/-}.sig" -o /dev/null
