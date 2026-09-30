#!/usr/bin/env bash
source "$(dirname "$0")/negative.sh"
echo "=== B. the gateway refuses, or is not there ==="

refuses "a wrong secret is SignatureDoesNotMatch" "SignatureDoesNotMatch" vgw-wrong-secret accounts
refuses "a wrong region is IncorrectRegion, naming both" "expects region us-east-1.*eu-north-1" vgw-wrong-region accounts
refuses "a writer's key is not an admin" "XAdminAccessDenied" vgw-writer accounts
refuses "... and bucketSettings with it fails on the admin list too" "XAdminAccessDenied" vgw-writer bucketSettings
refuses "a closed port fails the inventory" "127.0.0.1:1" vgw-closed inventory
holds   "... while health records it as unreachable instead of failing" \
  '.dataArtifacts[] | select(.name == "health") | .attributes.reachable == false and .attributes.status == null' \
  vgw-closed health
refuses "an admin prefix that is not there fails (v1.8.0 answers 500), not records nothing" "HTTP 500 InternalError" vgw-prefix accounts
refuses "a bucket that does not exist is NoSuchBucket" "NoSuchBucket" vgw bucketSettings 'buckets=["no-such-bucket"]'
summary
