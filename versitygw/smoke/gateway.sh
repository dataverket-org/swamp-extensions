#!/usr/bin/env bash
# Two throwaway versitygw v1.8.0 gateways in podman, seeded with what the
# negative suite and the fixtures need: one plain HTTP (17070, admin 17071) and
# one behind a CA made here (17443, admin 17444). Every key is a throwaway.
#   usage: gateway.sh up | down
set -euo pipefail
cd "$(dirname "$0")"
IMAGE=docker.io/versity/versitygw:v1.8.0
ROOT_ACCESS=fixtureroot
ROOT_SECRET=fixturerootsecret0000
W=${WORK:-$PWD/.work}

down() {
  podman rm -f vgw-fixture vgw-fixture-tls >/dev/null 2>&1 || true
  podman unshare rm -rf "$W"
}

start() { # name s3-port admin-port extra-args...
  local name=$1 s3=$2 admin=$3; shift 3
  mkdir -p "$W/$name/data" "$W/$name/versions" "$W/$name/iam"
  podman run -d --name "$name" \
    -p "127.0.0.1:$s3:7070" -p "127.0.0.1:$admin:7071" \
    -e ROOT_ACCESS_KEY=$ROOT_ACCESS -e ROOT_SECRET_KEY=$ROOT_SECRET \
    -v "$W/$name/data:/data:Z" -v "$W/$name/versions:/versions:Z" \
    -v "$W/$name/iam:/iam:Z" -v "$W/certs:/certs:ro,Z" \
    "$IMAGE" --port=:7070 "$@" --iam-dir=/iam --region=us-east-1 \
    --health=/health --admin-port=:7071 posix --versioning-dir=/versions /data \
    >/dev/null
}

certs() {
  mkdir -p "$W/certs" && cd "$W/certs"
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout ca.key -out ca.crt -days 2 -subj /CN=vgw-fixture-ca 2>/dev/null
  openssl req -x509 -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout other-ca.key -out other-ca.crt -days 2 -subj /CN=other-ca 2>/dev/null
  openssl req -newkey ec -pkeyopt ec_paramgen_curve:P-256 -nodes \
    -keyout tls.key -out tls.csr -subj /CN=127.0.0.1 2>/dev/null
  openssl x509 -req -in tls.csr -CA ca.crt -CAkey ca.key -CAcreateserial \
    -days 2 -out tls.crt -extfile <(printf 'subjectAltName=IP:127.0.0.1\n') 2>/dev/null
  chmod 644 ./*.key
  cd - >/dev/null
}

adm() { # container args...
  local c=$1; shift
  podman exec "$c" versitygw admin -a $ROOT_ACCESS -s $ROOT_SECRET -r us-east-1 \
    -er http://localhost:7071 "$@" >/dev/null
}

s3() { # method path curl-args...
  local m=$1 p=$2; shift 2
  curl -sSf -o /dev/null -X "$m" --aws-sigv4 aws:amz:us-east-1:s3 \
    --user $ROOT_ACCESS:$ROOT_SECRET "http://127.0.0.1:17070$p" "$@"
}

md5() { printf %s "$1" | openssl md5 -binary | base64; }

seed() {
  local c=vgw-fixture
  adm $c create-user -a cnpg-forgejo -s FIXTURE-SECRET-cnpg-forgejo-000000 -r user
  adm $c create-user -a restic-zitadel -s FIXTURE-SECRET-restic-zitadel-00000 -r user \
    --user-id 1001 --group-id 1001 --project-id 7
  adm $c create-user -a idle -s FIXTURE-SECRET-idle-0000000000000 -r userplus
  adm $c create-user -a ops -s FIXTURE-SECRET-ops-00000000000000 -r admin
  adm $c create-user -a gone -s FIXTURE-SECRET-gone-0000000000000 -r user
  adm $c create-bucket --bucket cnpg-forgejo -o cnpg-forgejo
  adm $c create-bucket --bucket restic-zitadel -o restic-zitadel
  adm $c create-bucket --bucket shared-scratch -o cnpg-forgejo
  adm $c create-bucket --bucket ops -o ops
  adm $c create-bucket --bucket orphaned -o gone
  adm $c delete-user -a gone
  local tags='<Tagging><TagSet><Tag><Key>site</Key><Value>hov1</Value></Tag><Tag><Key>writer</Key><Value>cnpg</Value></Tag></TagSet></Tagging>'
  local cors='<CORSConfiguration><CORSRule><AllowedOrigin>https://example.org</AllowedOrigin><AllowedMethod>GET</AllowedMethod></CORSRule></CORSConfiguration>'
  s3 PUT '/shared-scratch?versioning' --data-binary \
    '<VersioningConfiguration xmlns="http://s3.amazonaws.com/doc/2006-03-01/"><Status>Enabled</Status></VersioningConfiguration>'
  s3 PUT '/shared-scratch?policy' --data-binary \
    '{"Version":"2012-10-17","Statement":[{"Effect":"Allow","Principal":"*","Action":"s3:GetObject","Resource":"arn:aws:s3:::shared-scratch/*"}]}'
  s3 PUT '/cnpg-forgejo?tagging' -H "content-md5: $(md5 "$tags")" --data-binary "$tags"
  s3 PUT '/ops?cors' -H "content-md5: $(md5 "$cors")" --data-binary "$cors"
  s3 PUT '/locked' -H 'x-amz-bucket-object-lock-enabled: true'
  s3 PUT '/restic-zitadel?ownershipControls' --data-binary \
    '<OwnershipControls><Rule><ObjectOwnership>BucketOwnerPreferred</ObjectOwnership></Rule></OwnershipControls>'
  # The TLS gateway needs only one writer; it exists for the certificate.
  adm vgw-fixture-tls create-user -a cnpg-forgejo -s FIXTURE-SECRET-tls-000000000000 -r user
  adm vgw-fixture-tls create-bucket --bucket cnpg-forgejo -o cnpg-forgejo
}

case ${1:-} in
up)
  down
  certs
  start vgw-fixture 17070 17071
  start vgw-fixture-tls 17443 17444 --cert=/certs/tls.crt --key=/certs/tls.key
  until curl -sf http://127.0.0.1:17070/health >/dev/null &&
    curl -sf --cacert "$W/certs/ca.crt" https://127.0.0.1:17443/health >/dev/null; do
    sleep 1
  done
  seed
  echo "gateways up; CA in $W/certs"
  ;;
down) down ;;
*) echo "usage: $0 up | down" >&2; exit 2 ;;
esac
