# ADR-013 — Local object store: replace MinIO, which no longer publishes images

Status: accepted (Eyad delegated the choice, 2026-11-13) · Date: 2026-11-13

## Context
Architecture §1.1 says local development uses `docker-compose.yml` with MinIO, and the build plan names MinIO for task 0.4 and for the integration test level. Production only needs "an S3-compatible object store" (managed S3 or equivalent), and nothing in this ADR changes that.

When task 0.4 was built (2026-11-13):

- `minio/minio` on Docker Hub returns 404 and `docker pull` is denied: the repository is gone.
- `quay.io/minio/minio` answers its tag API with "Requires authentication".
- MinIO stopped distributing community-edition binaries and images in 2025 and now ships source only (recalled, not re-verified against MinIO's announcements; the two observations above are what blocks us).

So the documented setup cannot be followed. Task 0.4 shipped Postgres and Redis only. Nothing reads or writes objects before Phase 8 (`files`, KB uploads) and Phase 10 (trace payloads over 8 KB), so this decision blocks no current work, but it must be settled before task 8.1.

What we need from the local store: the plain S3 API through the AWS SDK (put, get, delete, list, multipart upload), SigV4 presigned URLs (task 8.1 uploads), a bucket created on start, and a container image that is maintained, pinnable by digest, under a licence our policy allows, and starts in seconds for Testcontainers.

## Options

| Option | Licence | Maintained | Notes |
|---|---|---|---|
| **RustFS** (`rustfs/rustfs`) | Apache-2.0 | Yes: 1.0.5, released 2026-11-10; ~23 M pulls | Built as a MinIO replacement: same API surface and console shape, single container. Younger project; S3 coverage not yet tested by us. |
| **Versity S3 Gateway** (`versity/versitygw`) | Apache-2.0 | Yes: v1.11.0, 2026-11-10 | S3 front end over a local directory. Small and simple, the closest to "files on disk". Fewer features than a full store (we need few). |
| **SeaweedFS** (`chrislusf/seaweedfs`) | Apache-2.0 | Yes | Mature, but several components (master, volume, filer, S3); `server -s3` runs them in one container. More to configure and slower to start. |
| `bitnamilegacy/minio` | AGPL-3.0 server | No: frozen 2025-08-19 | Works today and needs no code change, but receives no security fixes. A dead end. |
| Build MinIO from source ourselves | AGPL-3.0 | Upstream community edition is in maintenance | We would own a Go build and image for a dev dependency. |
| LocalStack | Mixed; recent releases tie features to an account | Yes | A whole AWS emulator for one service; licence terms have moved recently. |
| Garage | AGPL-3.0 | Yes | Good software; not needed, and AGPL adds review overhead. |

## Recommendation
Use **RustFS**, pinned by tag and digest, for `docker-compose.yml` and the Testcontainers integration level, with a one-shot step that creates the dev bucket. Keep application code on the plain S3 API through the AWS SDK only, so the local store stays swappable.

Adopt it only after a check passes against the pinned image: create bucket, put and get an object with an Arabic key and body, multipart upload, list, delete, and a SigV4 presigned PUT and GET. If RustFS fails any of it, use **versitygw** instead.

## Compatibility check (2026-11-13)
`rustfs/rustfs:1.0.5@sha256:b81d16a9…2dc1d74`, exercised with the AWS SDK for JavaScript v3 (`@aws-sdk/client-s3` 3.1168.0, path-style addressing). All eleven checks passed in 2.8 s; the container used 48 MB of memory.

| Check | Result |
|---|---|
| Create bucket | pass |
| Put object with an Arabic key (`مستندات/سياسة الشحن 2026.txt`) and Arabic body | pass |
| Get object: bytes and `Content-Type` round-trip | pass |
| Head object | pass |
| List with an Arabic prefix | pass |
| Multipart upload, 12 MB in three parts | pass |
| Presigned PUT, then presigned GET, Arabic key | pass (200, 200) |
| Expired presigned URL | refused (403) |
| Tampered presigned signature | refused (400) |
| Wrong secret key | refused (`SignatureDoesNotMatch`) |
| Delete, then head | pass (`NotFound`) |

Decision: RustFS, pinned by digest. `/health` answers 200 and the image ships `curl`, so the healthcheck and the one-shot bucket creation reuse the same image.

## Consequences
- Wording changes once accepted: architecture §1.1 ("Local development uses `docker-compose.yml` with RustFS"), the diagram label `(S3 / MinIO)`, build plan task 0.4 and the integration test level, and the command list in `CLAUDE.md`.
- `docker-compose.yml` gains the object store service and bucket setup in a follow-up to task 0.4.
- No production change: deployments still use any S3-compatible store.
- If the recommendation is rejected for `bitnamilegacy/minio`, record a revisit date, because that image receives no security fixes.

## Revisit when
RustFS stops releasing, its S3 behaviour diverges from AWS S3 in a way our tests catch, or production moves to a store whose semantics the local stand-in does not match.
