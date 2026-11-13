#!/bin/sh
# Creates the local development bucket in RustFS (ADR-013). Run by the object-store-init service.
# Dev credentials only; they match docker-compose.yml and .env.example.
set -eu

code=$(curl -s -o /dev/null -w '%{http_code}' \
  --aws-sigv4 'aws:amz:us-east-1:s3' \
  --user 'wakeel_dev:wakeel_dev_only_secret' \
  -X PUT 'http://object-store:9000/wakeel-dev')

echo "create bucket wakeel-dev: HTTP $code"
# 200: created. 409: already exists (BucketAlreadyOwnedByYou).
[ "$code" = 200 ] || [ "$code" = 409 ]
