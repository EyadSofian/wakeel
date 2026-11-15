# Deploying to Railway (internal testing)

Status: **internal testing only, test data only.** This deployment runs the top of the PR stack
(`p6-5-autonomy-engine`), which includes 🔒 tasks still waiting for review. No real customer data goes
in until those PRs are approved and the gaps below are closed.

## Layout

One Railway project, `wakeel-production`, one environment, eight services. Only the Studio has a
public address; everything else talks over Railway's private network (`<service>.railway.internal`).

| Service | Source | Port | Public |
|---|---|---|---|
| `studio` | `apps/studio/Dockerfile` (Vite build + Caddy) | `$PORT` | yes; serves the Studio and forwards `/v1/*` to the api |
| `api` | `apps/api/Dockerfile` | 3000 (`PORT=3000` set on the service) | no, only through the Studio's `/v1` |
| `worker` | `apps/worker/Dockerfile` | none | no |
| `egress` | `apps/egress/Dockerfile` | 4400 | no |
| `sandbox` | `apps/sandbox/Dockerfile` | 4300 | no |
| `migrate` | `packages/db/Dockerfile` | none; runs `db:bootstrap` then `db:migrate`, then exits | no |
| `postgres` | `pgvector/pgvector:0.8.7-pg17-bookworm` (pinned digest, as in `docker-compose.yml`) with a volume | 5432 | no |
| `Redis` | Railway's Redis template | 6379 | no |

The Studio and the api share one origin, so the session cookie is first-party and the Origin header
is the Studio's (task 1.2). `STUDIO_ORIGIN` and `API_PUBLIC_URL` are both the Studio's URL.

Railway's managed Postgres has no pgvector, so Postgres runs from the same image as local development,
with `PGDATA` in a subdirectory of the volume.

## Variables

Every service sets `RAILWAY_DOCKERFILE_PATH` to its Dockerfile. Secrets are generated with
`openssl rand` and set straight into Railway; they are never committed, printed or put in a PR.

| Service | Variables |
|---|---|
| `migrate` | `SUPERUSER_DATABASE_URL`, `APP_MIGRATOR_PASSWORD`, `APP_RW_PASSWORD`, `APP_ADMIN_RO_PASSWORD`, `MIGRATOR_DATABASE_URL`. The only service that holds the superuser URL. |
| `api` | `DATABASE_URL` (app_rw), `REDIS_URL=${{Redis.REDIS_URL}}`, `AUTH_SECRET`, `STUDIO_ORIGIN`, `API_PUBLIC_URL`, `EGRESS_URL`, `EGRESS_TOKEN`, `MASTER_KEY`, `PORT=3000` |
| `worker` | `DATABASE_URL` (app_rw), `REDIS_URL`, `EGRESS_URL`, `EGRESS_TOKEN`, `EGRESS_CAPABILITY_KEY`, `SANDBOX_URL`, `MASTER_KEY` |
| `egress` | `EGRESS_TOKEN`, `EGRESS_CAPABILITY_KEY` |
| `sandbox` | `EGRESS_URL`, `SANDBOX_HOST=::`, `NODE_ENV=development` (see below) |
| `studio` | `API_UPSTREAM=api.railway.internal:3000` |

Model provider keys are not platform variables. No service calls a model yet (the Autonomous Node is
wired into the worker in 6.6+); when it is, a workspace adds its own key in Settings → Models (BYOK).

## Deploying

```bash
railway up -s migrate --ci     # roles and migrations; safe to run again
railway up -s egress --ci
railway up -s sandbox --ci
railway up -s api --ci
railway up -s worker --ci
railway up -s studio --ci
```

Upload one service at a time; parallel uploads time out.

## Known gaps before real customers

1. **The sandbox runs without gVisor.** Railway does not offer the `runsc` runtime, `--read-only` or
   `--cap-drop ALL`, so layer 3 of the sandbox (docs/security/sandbox-review.md §5) is missing. The
   service refuses to start in production on an unverified runtime; here it runs with
   `NODE_ENV=development` so that guard does not apply. `SANDBOX_RUNTIME_VERIFIED` is **not** set,
   because it would be false. Layers 1 and 2 (QuickJS WASM, the guest API) still apply. Real customer
   code needs a host with gVisor (task 15.5/15.6).
2. **Egress network policy.** The egress service's address policy blocks private ranges, but Railway
   has no per-service network policy, so the first guard of ADR-020 (only egress may reach the
   internet) is not enforced; the bearer token is the only guard between services.
3. **Backups.** The Postgres volume has no scheduled backup yet.
4. **Domain.** The Studio uses the generated `*.up.railway.app` address.
